// Aplica migraciones SQL pendientes con tracking propio.
//
// IMPORTANTE: este sistema reemplaza a drizzle-kit migrate.
// La carpeta src/db/migrations/ contiene SQL plano (no formato drizzle).
// Solo las migraciones 0001-0004 fueron generadas por drizzle-kit; el resto
// son SQL escritos a mano. drizzle-kit migrate aplicaría solo 5 de 64 y dejaría
// la BD en estado inconsistente.
//
// Comandos:
//   npm run db:apply               → aplica las pendientes (idempotente)
//   npm run db:apply -- --dry      → muestra qué se aplicaría sin tocar BD
//   npm run db:apply -- --mark-all → marca como aplicadas las migrations que falten
//                                     SIN ejecutarlas (uso en VPS donde el SQL
//                                     ya corrió manualmente con psql). No reescribe
//                                     el sha de las ya registradas.
//   npm run db:apply -- --check-drift → solo lectura: reporta deriva y huérfanas.
//                                     Salida: 0 limpio, 3 con hallazgos (también un
//                                     archivo ilegible), 1 error.
//   npm run db:apply -- --allow-drift=<motivo> → continúa pese a los hallazgos y
//                                     registra archivo y motivo por cada uno.
//
// ADR-0035: integridad de migraciones. Antes de aplicar nada se compara el sha256
// del ledger contra el disco (deriva) y se buscan registradas sin archivo (huérfanas).
// Las excepciones aprobadas viven en migrations/derivas-aceptadas.json.
//
// ADR-DB-001 (2026-05-12): migraciones ≥ 0071 NO deben contener BEGIN/COMMIT/
// ROLLBACK ni START TRANSACTION. El runner gestiona la transacción con sql.begin().
// Si el archivo declara control de transacción propia, rompe el wrap externo
// (ver postmortem INC-OCR-2026-05-12 referencia y nota del falso dry-run del
// 2026-05-12). Migraciones 0050-0070 quedan grandfathered: ya están aplicadas
// y NO se re-aplican, así que el guard solo dispara sobre archivos pending.
// Ver docs/runbook/adr-db-001-migration-transaction-policy.md

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/db/migrations');
const MANIFIESTO_DERIVAS = path.join(MIGRATIONS_DIR, 'derivas-aceptadas.json');
const TRACKING_TABLE = '_kyverum_applied_migrations';

// ADR-0035 §A. PR 1 despliega el control sin activarlo: con `replicas: 1` y `Recreate`,
// un aborto deja la API sin servicio, y este código entra a develop con merge automático.
// El arranque normal informa `[drift]…` y sigue. PR 2 retira esta constante y
// `decidirArranque`, de modo que el arranque use `decidir` directamente.
export const DRIFT_ABORTA = false;

export const EXIT_DERIVA = 3;

// Detecta si este archivo es el entrypoint (vs. importado por tests/otros módulos).
function isInvokedAsScript(): boolean {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  return invoked === __filename
    || invoked.endsWith('/db-apply.ts')
    || invoked.endsWith('/db-apply.js');
}

// Lazy: el cliente postgres NO se abre al importar el módulo (para que los tests puedan
// reutilizar las utils sin conectar a BD). Solo se inicializa en main().
let sql: ReturnType<typeof postgres>;

async function ensureTrackingTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(TRACKING_TABLE)} (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function listApplied(): Promise<Map<string, string>> {
  const rows = await sql<Array<{ filename: string; sha256: string }>>`
    SELECT filename, sha256 FROM ${sql(TRACKING_TABLE)}
  `;
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

// Único cálculo de hash del runner: siempre sobre los bytes del archivo, para que el
// ledger y la comparación de deriva no puedan discrepar por decodificación.
export function sha256De(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileHash(p: string): string {
  return sha256De(readFileSync(p));
}

// ADR-DB-001: detecta tx-control top-level. Ignora ocurrencias dentro de
// dollar-quoted bodies ($$ ... $$ o $tag$ ... $tag$) y comentarios.
const TX_CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END\s+TRANSACTION)\b\s*;?/i;

export function scanForTxControl(filename: string, content: string): string[] {
  // Reemplazar dollar-quoted strings con espacios (preserva números de línea)
  const stripped = content
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = stripped.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TX_CONTROL_RE.test(lines[i])) {
      hits.push(`  ${filename}:${i + 1} → ${lines[i].trim().slice(0, 80)}`);
    }
  }
  return hits;
}

// Grandfathered: migs 0050-0070 declaraban BEGIN/COMMIT propio. Quedan en disco
// pero ya están en _kyverum_applied_migrations, así que pending=[] para ellas.
// El guard NO debe disparar en archivos cuyo número de prefijo es <= 0070.
export function isGrandfathered(filename: string): boolean {
  const m = filename.match(/^(\d{4})/);
  if (!m) return false;
  const n = Number.parseInt(m[1], 10);
  return n <= 70;
}

async function applyOne(filename: string, dry: boolean): Promise<void> {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const bytes = readFileSync(fullPath);
  const content = bytes.toString('utf8');
  const hash = sha256De(bytes);

  // ADR-DB-001 guard: archivos nuevos (≥0071) NO deben tener control de tx propio.
  if (!isGrandfathered(filename)) {
    const hits = scanForTxControl(filename, content);
    if (hits.length > 0) {
      console.error(`✗ ${filename}: viola ADR-DB-001 (transaction control en migración).`);
      console.error('Statements top-level encontrados:');
      console.error(hits.join('\n'));
      console.error('');
      console.error('El runner ya envuelve cada archivo con sql.begin(). Quita BEGIN/COMMIT/');
      console.error('ROLLBACK del archivo. Si necesitas un savepoint explícito, hazlo dentro');
      console.error('de un DO $$ ... $$ block. Ver docs/runbook/adr-db-001-migration-transaction-policy.md');
      process.exit(2);
    }
  }

  if (dry) {
    console.log(`[DRY] aplicaría: ${filename} (${hash.slice(0, 12)})`);
    return;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(content);
    await tx`
      INSERT INTO ${tx(TRACKING_TABLE)} (filename, sha256)
      VALUES (${filename}, ${hash})
      ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()
    `;
  });
  console.log(`✓ aplicada: ${filename}`);
}

// --- ADR-0035: integridad ---------------------------------------------------------------

export class ArgumentoInvalidoError extends Error {}
export class ManifiestoInvalidoError extends Error {}

export type DerivaAceptada = {
  archivo: string;
  shaLedger: string;
  shaDisco: string | null; // null = huérfana aceptada
  motivo: string;
  wi: string;
};

export type Pista =
  | { caso: 1; tipo: 'sha'; nombres: string[] }
  | { caso: 2; tipo: 'registrada'; nombres: string[] }
  | { caso: 3; tipo: 'nombre'; nombres: string[] }
  | { caso: 4; tipo: 'ninguna'; nombres: [] };

// null = no se pudo leer: existe en disco, pero sin hash que comparar.
export type DiscoHasheado = Map<string, string | null>;

export type Deriva = { archivo: string; shaLedger: string; shaDisco: string };
export type Huerfana = { archivo: string; shaLedger: string; pista: Pista };

export type ReporteDeriva = {
  intactas: string[];
  aceptadas: Array<Deriva | Huerfana>;
  derivas: Deriva[];
  huerfanas: Huerfana[];
  pendientes: string[];
  // Sin hash, registrados o no. Un pendiente figura además en `pendientes`: hay que aplicarlo.
  ilegibles: string[];
  errorManifiesto?: string;
};

export type Decision =
  | { accion: 'abortar'; codigo: number; razones: string[] }
  | { accion: 'continuar'; registros: string[] };

export type Decidir = (reporte: ReporteDeriva, motivoAllowDrift?: string) => Decision;

export type OpcionesCli = {
  dry: boolean;
  markAll: boolean;
  checkDrift: boolean;
  motivoAllowDrift?: string;
};

export function parsearArgs(argv: string[]): OpcionesCli {
  const opciones: OpcionesCli = {
    dry: argv.includes('--dry'),
    markAll: argv.includes('--mark-all'),
    checkDrift: argv.includes('--check-drift'),
  };
  for (const arg of argv) {
    if (arg !== '--allow-drift' && !arg.startsWith('--allow-drift=')) continue;
    const motivo = arg.slice('--allow-drift='.length).replace(/\s+/g, ' ').trim();
    if (!motivo) throw new ArgumentoInvalidoError('--allow-drift exige un motivo: --allow-drift=<motivo>');
    opciones.motivoAllowDrift = motivo;
  }
  if (opciones.checkDrift && (opciones.markAll || opciones.motivoAllowDrift)) {
    throw new ArgumentoInvalidoError('--check-drift es solo lectura: no se combina con --mark-all ni --allow-drift');
  }
  if (opciones.markAll && opciones.motivoAllowDrift) {
    throw new ArgumentoInvalidoError('--mark-all no ejecuta el control de deriva: no se combina con --allow-drift');
  }
  return opciones;
}

// `--check-drift` no debe poder escribir: lo impone Postgres, no la disciplina del código.
export function opcionesConexion(checkDrift: boolean) {
  return checkDrift
    ? { max: 1, connection: { default_transaction_read_only: true } }
    : { max: 1 };
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function validarManifiesto(crudo: string): DerivaAceptada[] {
  let datos: unknown;
  try {
    datos = JSON.parse(crudo);
  } catch (e) {
    throw new ManifiestoInvalidoError(`JSON inválido: ${(e as Error).message}`);
  }
  if (!Array.isArray(datos)) throw new ManifiestoInvalidoError('debe ser un arreglo');
  return datos.map((entrada: Partial<DerivaAceptada> | null, i): DerivaAceptada => {
    const { archivo, shaLedger, shaDisco, motivo, wi } = entrada ?? {};
    const valida = typeof archivo === 'string' && archivo.endsWith('.sql')
      && typeof shaLedger === 'string' && SHA256_RE.test(shaLedger)
      && (shaDisco === null || (typeof shaDisco === 'string' && SHA256_RE.test(shaDisco)))
      && typeof motivo === 'string' && motivo.trim() !== ''
      && typeof wi === 'string' && wi.trim() !== '';
    if (!valida) throw new ManifiestoInvalidoError(`entrada ${i}: exige archivo, shaLedger, shaDisco, motivo y wi`);
    return entrada as DerivaAceptada;
  });
}

// `0274_foo.sql` y `0004a_foo.sql` → `foo.sql`.
function nombreSinNumero(archivo: string): string {
  return archivo.replace(/^\d+[a-z]?_/i, '');
}

// Orden por riesgo: 1 y 3 se re-ejecutarían; 2 ya no tiene riesgo futuro. Si coinciden
// el 2 y el 3, debe verse el que todavía puede causar daño.
function clasificarHuerfana(
  archivo: string,
  shaLedger: string,
  ledger: Map<string, string>,
  disco: DiscoHasheado,
  pendientes: string[],
): Pista {
  const mismoSha = pendientes.filter((p) => disco.get(p) === shaLedger);
  if (mismoSha.length > 0) return { caso: 1, tipo: 'sha', nombres: mismoSha };
  const mismoNombre = pendientes.filter((p) => nombreSinNumero(p) === nombreSinNumero(archivo));
  if (mismoNombre.length > 0) return { caso: 3, tipo: 'nombre', nombres: mismoNombre };
  const registrada = [...ledger.entries()]
    .filter(([nombre, sha]) => nombre !== archivo && sha === shaLedger && disco.has(nombre))
    .map(([nombre]) => nombre)
    .sort();
  if (registrada.length > 0) return { caso: 2, tipo: 'registrada', nombres: registrada };
  return { caso: 4, tipo: 'ninguna', nombres: [] };
}

export function detectarDeriva(
  disco: DiscoHasheado,
  ledger: Map<string, string>,
  aceptadas: DerivaAceptada[],
): ReporteDeriva {
  const estaAceptada = (archivo: string, shaLedger: string, shaDisco: string | null): boolean =>
    aceptadas.some((a) => a.archivo === archivo && a.shaLedger === shaLedger && a.shaDisco === shaDisco);
  const pendientes = [...disco.keys()].filter((f) => !ledger.has(f)).sort();
  const ilegibles = [...disco.keys()].filter((f) => disco.get(f) === null).sort();
  const reporte: ReporteDeriva = { intactas: [], aceptadas: [], derivas: [], huerfanas: [], pendientes, ilegibles };

  for (const [archivo, shaLedger] of [...ledger.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const shaDisco = disco.get(archivo);
    if (shaDisco === null) continue; // no es intacta, ni deriva, ni huérfana: está en `ilegibles`
    if (shaDisco === shaLedger) {
      reporte.intactas.push(archivo);
    } else if (shaDisco !== undefined) {
      const deriva = { archivo, shaLedger, shaDisco };
      (estaAceptada(archivo, shaLedger, shaDisco) ? reporte.aceptadas : reporte.derivas).push(deriva);
    } else {
      const pista = clasificarHuerfana(archivo, shaLedger, ledger, disco, pendientes);
      const huerfana = { archivo, shaLedger, pista };
      if (estaAceptada(archivo, shaLedger, null)) reporte.aceptadas.push(huerfana);
      else reporte.huerfanas.push(huerfana);
    }
  }
  return reporte;
}

function pistaEnLog({ tipo, nombres }: Pista): string {
  return nombres.length > 0 ? `${tipo}:${nombres.join(',')}` : tipo;
}

// Formato estable (ADR-0035), sin PII: se consulta con `grep '\[drift\]'`.
export function lineasReporte(reporte: ReporteDeriva): string[] {
  const lineas: string[] = [];
  if (reporte.errorManifiesto) lineas.push(`[drift] manifiesto-invalido ${reporte.errorManifiesto}`);
  for (const archivo of reporte.ilegibles) lineas.push(`[drift] ilegible archivo=${archivo}`);
  for (const d of reporte.derivas) {
    lineas.push(`[drift] deriva archivo=${d.archivo} ledger=${d.shaLedger} disco=${d.shaDisco}`);
  }
  for (const h of reporte.huerfanas) {
    lineas.push(`[drift] huerfana archivo=${h.archivo} ledger=${h.shaLedger} pista=${pistaEnLog(h.pista)}`);
  }
  lineas.push(
    `[drift] resumen intactas=${reporte.intactas.length} aceptadas=${reporte.aceptadas.length}`
      + ` derivas=${reporte.derivas.length} huerfanas=${reporte.huerfanas.length}`
      + ` pendientes=${reporte.pendientes.length}`,
  );
  return lineas;
}

const ACCION_HUERFANA: Record<Pista['caso'], string> = {
  1: 'restaurar el nombre registrado: de lo contrario el pendiente se re-ejecutaría',
  2: 'comprobar que el doble efecto fue inocuo y añadirla a derivas-aceptadas.json con shaDisco null',
  3: 'restaurar el nombre registrado revisando el diff: de lo contrario el pendiente se re-ejecutaría con cambios',
  4: 'investigar la migración retirada y, si procede, añadirla a derivas-aceptadas.json con shaDisco null',
};

export function lineasAccion(reporte: ReporteDeriva): string[] {
  const derivas = reporte.derivas.map(
    (d) => `[drift] accion archivo=${d.archivo} restaurar los bytes aplicados o añadir el par exacto a derivas-aceptadas.json (ADR-0035)`,
  );
  const huerfanas = reporte.huerfanas.map(
    (h) => `[drift] accion archivo=${h.archivo} ${ACCION_HUERFANA[h.pista.caso]} (ADR-0035)`,
  );
  const manifiesto = reporte.errorManifiesto ? ['[drift] accion corregir derivas-aceptadas.json (ADR-0035)'] : [];
  const ilegibles = reporte.ilegibles.map(
    (archivo) => `[drift] accion archivo=${archivo} revisar que el proceso pueda leer el archivo (ADR-0035)`,
  );
  return [...manifiesto, ...ilegibles, ...derivas, ...huerfanas];
}

// Casos 1 y 3: la huérfana no impide que su renombrado corra como pendiente (H2 del ADR).
function avisosReejecucion(huerfanas: Huerfana[], origen: string): string[] {
  return huerfanas
    .filter((h) => h.pista.caso === 1 || h.pista.caso === 3)
    .flatMap((h) => h.pista.nombres.map(
      (p) => `[drift] aviso-reejecucion archivo=${p} huerfana=${h.archivo} origen=${origen}: se ejecutará de nuevo bajo su nuevo nombre`,
    ));
}

function esHuerfana(h: Deriva | Huerfana): h is Huerfana {
  return 'pista' in h;
}

function hayHallazgos(reporte: ReporteDeriva): boolean {
  return reporte.derivas.length > 0
    || reporte.huerfanas.length > 0
    || reporte.ilegibles.length > 0
    || reporte.errorManifiesto !== undefined;
}

// Decisión del control, sin BD y sin la constante: lo que el arranque hará tras PR 2.
export const decidir: Decidir = (reporte, motivoAllowDrift) => {
  const avisosManifiesto = avisosReejecucion(reporte.aceptadas.filter(esHuerfana), 'manifiesto');
  if (!hayHallazgos(reporte)) return { accion: 'continuar', registros: avisosManifiesto };
  if (!motivoAllowDrift) {
    return { accion: 'abortar', codigo: EXIT_DERIVA, razones: lineasAccion(reporte) };
  }
  const archivos = [...reporte.derivas, ...reporte.huerfanas].map((h) => h.archivo).concat(reporte.ilegibles);
  return {
    accion: 'continuar',
    registros: [
      ...archivos.map((a) => `[drift] allow-drift archivo=${a} motivo=${motivoAllowDrift}`),
      ...(reporte.errorManifiesto ? [`[drift] allow-drift manifiesto-invalido motivo=${motivoAllowDrift}`] : []),
      ...avisosManifiesto,
      ...avisosReejecucion(reporte.huerfanas, 'allow-drift'),
    ],
  };
};

// Única puerta del arranque real mientras dure PR 1: nada de lo que `decidir` resuelva
// puede convertirse en un aborto. La renombrada se aplica como pendiente, como hasta hoy.
export const decidirArranque: Decidir = (reporte, motivoAllowDrift) => {
  const decision = decidir(reporte, motivoAllowDrift);
  if (decision.accion !== 'abortar' || DRIFT_ABORTA) return decision;
  return {
    accion: 'continuar',
    registros: [
      `[drift] sin-aborto DRIFT_ABORTA=false: se continúa pese a los hallazgos (ADR-0035 §A)`,
      ...decision.razones,
      ...avisosReejecucion(reporte.aceptadas.filter(esHuerfana), 'manifiesto'),
      ...avisosReejecucion(reporte.huerfanas, 'sin-aborto'),
    ],
  };
};

export type DepsControl = {
  leerDisco: () => DiscoHasheado;
  leerManifiesto: () => DerivaAceptada[];
  log: (linea: string) => void;
  error: (linea: string) => void;
};

export type DepsArranque = DepsControl & {
  leerLedger: () => Promise<Map<string, string>>;
  aplicar: (archivo: string) => Promise<void>;
};

export async function arrancar(
  deps: DepsArranque,
  opciones: { motivoAllowDrift?: string },
  decision: Decidir = decidirArranque,
): Promise<number> {
  const disco = deps.leerDisco();
  const ledger = await deps.leerLedger();
  let aceptadas: DerivaAceptada[] = [];
  let errorManifiesto: string | undefined;
  try {
    aceptadas = deps.leerManifiesto();
  } catch (e) {
    errorManifiesto = (e as Error).message;
  }
  const reporte: ReporteDeriva = { ...detectarDeriva(disco, ledger, aceptadas), errorManifiesto };
  lineasReporte(reporte).forEach((l) => deps.log(l));

  const resultado = decision(reporte, opciones.motivoAllowDrift);
  if (resultado.accion === 'abortar') {
    resultado.razones.forEach((l) => deps.error(l));
    return resultado.codigo;
  }
  resultado.registros.forEach((l) => deps.log(l));

  if (reporte.pendientes.length === 0) {
    deps.log(`sin migraciones pendientes (${disco.size} aplicadas)`);
    return 0;
  }
  deps.log(`pendientes: ${reporte.pendientes.length} de ${disco.size}`);
  for (const f of reporte.pendientes) {
    await deps.aplicar(f);
  }
  return 0;
}

export type DepsCheck = DepsControl & {
  // null = no existe el ledger
  leerLedger: () => Promise<Map<string, string> | null>;
};

// Solo lectura, sin `ensureTrackingTable`. Un error de conexión llega a `main`: salida 1.
export async function comprobarDeriva(deps: DepsCheck): Promise<number> {
  const ledger = await deps.leerLedger();
  if (!ledger) {
    deps.log(`[drift] sin-ledger tabla=${TRACKING_TABLE}: nada que comparar`);
    return 0;
  }
  let aceptadas: DerivaAceptada[];
  try {
    aceptadas = deps.leerManifiesto();
  } catch (e) {
    deps.error(`[drift] manifiesto-invalido ${(e as Error).message}`);
    return 1;
  }
  const reporte = detectarDeriva(deps.leerDisco(), ledger, aceptadas);
  lineasReporte(reporte).forEach((l) => deps.log(l));
  if (!hayHallazgos(reporte)) return 0;
  lineasAccion(reporte).forEach((l) => deps.log(l));
  return EXIT_DERIVA;
}

// El error de lectura no sale de aquí: su mensaje trae rutas y `[drift]` solo nombra el archivo.
// Un pendiente ilegible falla después en `applyOne`, al aplicarlo en su turno, como siempre.
export function hashearDisco(archivos: string[], leer: (archivo: string) => Buffer): DiscoHasheado {
  return new Map(archivos.map((f): [string, string | null] => {
    try {
      return [f, sha256De(leer(f))];
    } catch {
      return [f, null];
    }
  }));
}

function leerDiscoReal(): DiscoHasheado {
  return hashearDisco(listMigrationFiles(), (f) => readFileSync(path.join(MIGRATIONS_DIR, f)));
}

function leerManifiestoReal(): DerivaAceptada[] {
  return validarManifiesto(readFileSync(MANIFIESTO_DERIVAS, 'utf8'));
}

async function leerLedgerSiExiste(): Promise<Map<string, string> | null> {
  const [fila] = await sql<Array<{ tabla: string | null }>>`SELECT to_regclass(${TRACKING_TABLE})::text AS tabla`;
  return fila?.tabla ? listApplied() : null;
}

// `DO NOTHING`: con `DO UPDATE` este modo lavaba la deriva reescribiendo el sha del ledger.
export async function marcarTodas(
  cliente: ReturnType<typeof postgres>,
  archivos: Array<{ filename: string; sha256: string }>,
): Promise<void> {
  for (const { filename, sha256 } of archivos) {
    await cliente`
      INSERT INTO ${cliente(TRACKING_TABLE)} (filename, sha256)
      VALUES (${filename}, ${sha256})
      ON CONFLICT (filename) DO NOTHING
    `;
  }
}

async function main(): Promise<number> {
  let opciones: OpcionesCli;
  try {
    opciones = parsearArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ArgumentoInvalidoError)) throw e;
    console.error(`error: ${e.message}`);
    return 1;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL es requerida');
    return 1;
  }
  sql = postgres(dbUrl, opcionesConexion(opciones.checkDrift));

  const control: DepsControl = {
    leerDisco: leerDiscoReal,
    leerManifiesto: leerManifiestoReal,
    log: (linea) => console.log(linea),
    error: (linea) => console.error(linea),
  };

  if (opciones.checkDrift) {
    return comprobarDeriva({ ...control, leerLedger: leerLedgerSiExiste });
  }

  await ensureTrackingTable();

  if (opciones.markAll) {
    const archivos = listMigrationFiles();
    await marcarTodas(sql, archivos.map((filename) => ({
      filename,
      sha256: fileHash(path.join(MIGRATIONS_DIR, filename)),
    })));
    console.log(`marcadas como aplicadas: ${archivos.length} migrations`);
    return 0;
  }

  const deps: DepsArranque = {
    ...control,
    leerLedger: listApplied,
    aplicar: (archivo) => applyOne(archivo, opciones.dry),
  };
  return arrancar(deps, { motivoAllowDrift: opciones.motivoAllowDrift });
}

if (isInvokedAsScript()) {
  main()
    .then((codigo) => {
      process.exitCode = codigo;
    })
    .catch((e) => {
      console.error('error:', e?.message ?? e);
      process.exit(1);
    })
    .finally(async () => {
      if (sql) await sql.end({ timeout: 5 });
    });
}
