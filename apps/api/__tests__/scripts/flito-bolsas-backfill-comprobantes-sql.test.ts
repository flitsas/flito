// HU #13972 (Feature #13887) — la versión SQL del backfill de la HU #13910
// (`src/db/manual/flito-bolsas-backfill-comprobantes-{simulacion,aplicar}.sql`) da EXACTAMENTE el mismo resultado
// que el script TS (`src/scripts/flito-bolsas-backfill-comprobantes.ts`), contra PostgreSQL de verdad.
//
// AC3 (paridad): con los MISMOS datos se corre el SQL de aplicar, se capturan reporte y movimientos, se deshace lo
// escrito (movimientos de esos comprobantes + saldos de las bolsas), se corre el TS y se compara fila a fila.
// Además: simulación sin escritura (AC1), idempotencia (AC4), sin corte (AC5), usuario inválido (AC6) y que las
// funciones de los dos archivos sean idénticas (la simulación es exactamente lo que aplicar escribiría).
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Aislamiento: comprobantes aplicados en 2001 con corte 2001-02-01. El SQL recorre TODOS los candidatos de la BD
// (no admite filtro), así que antes de cada ejecución se exige que los únicos candidatos sean los de ese caso
// (`soloEstos`) y al terminar cada caso sus comprobantes dejan de ser candidatos (`afterEach`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const DIR = resolve(__dirname, '../../src/db/manual');
const SIMULACION = readFileSync(resolve(DIR, 'flito-bolsas-backfill-comprobantes-simulacion.sql'), 'utf8');
const APLICAR = readFileSync(resolve(DIR, 'flito-bolsas-backfill-comprobantes-aplicar.sql'), 'utf8');
const LITERAL = /SET LOCAL flito\.backfill_usuario = '[^']*';/;

const CORTE = '2001-02-01';
const ANTES = '2001-01-10T15:00:00Z';
const NADA = '00000000-0000-0000-0000-000000000000';
const NOTA = 'Backfill corte comprobantes (ADR-0029)';

/** Una línea del reporte, igual para el TS y para el SQL. */
interface Linea {
  comprobanteId: string; alcance: string; bolsaId: string | null; concepto: string; valor: number;
  resultado: string; motivo: string | null; negativo: boolean;
}

describe.skipIf(!URL)('HU #13972 — backfill de comprobantes vía SQL: paridad con el script TS (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let corte: import('../helpers/corte-bolsas.js').CorteDePrueba;
  let bf: typeof import('../../src/scripts/flito-bolsas-backfill-comprobantes.js');
  let libro: typeof import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
  let USER: number;
  let n = 0;
  let libres: string[] = [];
  const creados = {
    clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[],
    soportes: [] as string[], transito: [] as string[], comprobantes: [] as string[],
  };
  /** Datos personales sembrados: ni el reporte ni los NOTICE pueden contener ninguno. */
  const pii: string[] = [];

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 3, onnotice: () => {} });
    corte = (await import('../helpers/corte-bolsas.js')).corteDePrueba(sql);
    bf = await import('../../src/scripts/flito-bolsas-backfill-comprobantes.js');
    libro = await import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
    const [u] = await sql`SELECT id, username FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
    pii.push(u!.username as string);
    libres = (await sql`SELECT codigo FROM organismos_transito_config o
      WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_cobertura c WHERE c.organismo_codigo = o.codigo)
      ORDER BY codigo DESC LIMIT 60`).map((f) => f.codigo as string);
  });

  afterAll(async () => {
    if (!sql) return;
    await corte.restaurar();
    const ids = creados.clients.length ? creados.clients : [-1];
    const tb = creados.transito.length ? creados.transito : [NADA];
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE revierte_movimiento_id IS NOT NULL AND bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cierres WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cobertura WHERE bolsa_id IN ${sql(tb)}`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`;
    const tr = creados.tramites.length ? creados.tramites : [NADA];
    await sql`DELETE FROM flito_comprobantes WHERE tramite_id IN ${sql(tr)}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`DELETE FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
    if (creados.soats.length) await sql`DELETE FROM flito_soat WHERE id IN ${sql(creados.soats)}`;
    if (creados.vehicles.length) await sql`DELETE FROM vehicles WHERE id IN ${sql(creados.vehicles)}`;
    await sql`DELETE FROM clients WHERE id IN ${sql(ids)}`;
    await sql.end();
  });

  beforeEach(async () => { await corte.fijar(CORTE); });
  // Los comprobantes de un caso dejan de ser candidatos para el siguiente (el SQL recorre toda la BD).
  afterEach(async () => {
    if (creados.comprobantes.length) {
      await sql`UPDATE flito_comprobantes SET aplicado_en = '2001-06-01T15:00:00Z' WHERE id IN ${sql(creados.comprobantes)}`;
    }
  });

  // ─────────────────────────── Fixtures ───────────────────────────

  interface OpcionesCompania {
    bolsa?: 'activa' | 'inactiva' | 'ninguna';
    saldo?: number;
    impuestosAutogestionable?: boolean;
    conceptos?: string[];
  }
  async function compania(o: OpcionesCompania = {}): Promise<{ companiaId: number; bolsaId: string | null }> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const nombre = `HU13972 Compania ${sello}`;
    const nit = `7${sello}`.slice(0, 20);
    pii.push(nombre, nit);
    const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
      VALUES (${nombre}, ${nit}, false, ${o.impuestosAutogestionable ?? false}, false) RETURNING id`;
    const companiaId = c!.id as number;
    creados.clients.push(companiaId);
    if (o.bolsa === 'ninguna') return { companiaId, bolsaId: null };
    const activa = o.bolsa !== 'inactiva';
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa, inactivada_en)
      VALUES ('compania', ${companiaId}, ${String(o.saldo ?? 1_000_000)}, ${activa}, ${activa ? null : sql`now()`}) RETURNING id`;
    for (const concepto of o.conceptos ?? ['soat', 'impuesto', 'derecho']) {
      await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${b!.id}, ${concepto})`;
    }
    return { companiaId, bolsaId: b!.id as string };
  }

  async function bolsaTransito(organismo: string, conceptos: string[], o: { activa?: boolean; saldo?: number } = {}): Promise<string> {
    n += 1;
    const nombre = `Tránsito HU13972 ${n} ${Math.floor(Math.random() * 1e9)}`;
    pii.push(nombre);
    const activa = o.activa ?? true;
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, nombre, saldo, activa, inactivada_en)
      VALUES ('transito', ${nombre}, ${String(o.saldo ?? 5_000_000)}, ${activa}, ${activa ? null : sql`now()`}) RETURNING id`;
    const id = b!.id as string;
    creados.transito.push(id);
    for (const concepto of conceptos) {
      await sql`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto, activa) VALUES (${id}, ${organismo}, ${concepto}, ${activa})`;
    }
    return id;
  }

  function secretaria(): string {
    const s = libres.shift();
    if (!s) throw new Error('No quedan secretarías sin cobertura en la BD de pruebas');
    return s;
  }

  async function tramite(
    companiaId: number | null, o: { impuesto?: string; soat?: string; organismo?: string; companiaRegistro?: number } = {},
  ): Promise<{ tramiteId: string; soatId: string | null }> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const placa = `Q${sello}`.slice(0, 6);
    const vinVehiculo = `W${sello}`.padEnd(17, 'Y').slice(0, 17);
    const dueno = `Propietario HU13972 ${sello}`;
    const cedula = `8${sello}`.slice(0, 12);
    const [v] = await sql`INSERT INTO vehicles (plate, vin, owner_name, owner_document)
      VALUES (${placa}, ${vinVehiculo}, ${dueno}, ${cedula}) RETURNING id`;
    pii.push(placa, vinVehiculo, dueno, cedula);
    creados.vehicles.push(v!.id as number);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id, organismo_codigo)
      VALUES (${`HU13972-${sello}`}, ${v!.id}, now(), ${companiaId}, ${o.organismo ?? null}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    if (o.impuesto) {
      await sql`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, estado)
        VALUES (${tramiteId}, ${o.impuesto}, ${companiaId ?? o.companiaRegistro ?? null}, 'requiere_gestion', 'pagado')`;
    }
    let soatId: string | null = null;
    if (o.soat) {
      const vin = `V${sello}`.padEnd(17, 'X').slice(0, 17);
      pii.push(vin);
      const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen, organismo_codigo)
        VALUES (${vin}, ${v!.id}, ${companiaId}, 'cliente', ${o.soat}) RETURNING id`;
      soatId = s!.id as string;
      creados.soats.push(soatId);
      await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    }
    return { tramiteId, soatId };
  }

  /** Comprobante de pago aplicado ANTES del corte (o en `aplicadoEn`). */
  async function comprobante(tramiteId: string, concepto: string, valor: number, aplicadoEn = ANTES): Promise<string> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13972/${n}.pdf`}, ${`h13972${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    creados.soportes.push(s!.id as string);
    const [c] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
        estado, tramite_id, concepto, es_pago, valor, soporte_aplicado_id, aplicado_en, aplicado_por_id, aplicado_motivo)
      VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, true,
        ${String(valor)}, ${s!.id}, ${aplicadoEn}, ${USER}, 'cruce manual de prueba') RETURNING id`;
    creados.comprobantes.push(c!.id as string);
    return c!.id as string;
  }

  // ─────────────────────────── Ejecutores ───────────────────────────

  /** Corre un archivo SQL tal cual, cambiando SOLO el literal del usuario; devuelve el reporte y los NOTICE. */
  async function correrSql(script: string, usuario: string): Promise<{ lineas: Linea[]; notices: string[] }> {
    expect(script).toMatch(LITERAL);
    const texto = script.replace(LITERAL, `SET LOCAL flito.backfill_usuario = '${usuario}';`);
    const notices: string[] = [];
    const { default: postgres } = await import('postgres');
    // Conexión propia: el script abre y cierra su transacción y, si falla, la sesión queda abortada.
    const con = postgres(URL!, { max: 1, onnotice: (m) => { notices.push(String(m.message)); } });
    try {
      const resultados = (await con.unsafe(texto)) as unknown as Array<Array<Record<string, unknown>> & { columns?: Array<{ name: string }> }>;
      const reporte = resultados.find((r) => Array.isArray(r) && r.columns?.some((c) => c.name === 'resultado'));
      if (!reporte) throw new Error('El script no devolvió el reporte');
      return {
        notices,
        lineas: reporte.map((f) => ({
          comprobanteId: f.comprobante_id as string, alcance: f.alcance as string, bolsaId: (f.bolsa_id as string | null) ?? null,
          concepto: f.concepto as string, valor: Number(f.valor), resultado: f.resultado as string,
          motivo: (f.motivo as string | null) ?? null, negativo: f.saldo_negativo as boolean,
        })),
      };
    } finally {
      await con.end();
    }
  }

  async function correrTs(ids: string[], apply: boolean): Promise<Linea[]> {
    const r = await bf.ejecutarBackfillComprobantes({ apply, usuarioId: USER, comprobanteIds: ids });
    return r.lineas.map((l) => ({
      comprobanteId: l.comprobanteId, alcance: l.alcance, bolsaId: l.bolsaId, concepto: l.concepto, valor: Number(l.valor),
      resultado: l.resultado, motivo: l.motivo, negativo: l.negativo,
    }));
  }

  /** El SQL no filtra: sus únicos candidatos tienen que ser los de este caso, o no se corre. */
  async function soloEstos(ids: string[]): Promise<void> {
    const [f] = await sql`SELECT count(*)::int AS n FROM flito_comprobantes c, flito_bolsas_corte k
      WHERE k.id = 1 AND c.estado = 'aplicado' AND c.es_pago = true AND c.tramite_id IS NOT NULL AND c.concepto IS NOT NULL
        AND c.aplicado_en IS NOT NULL AND c.aplicado_en < k.corte_en AND NOT (c.id = ANY(${ids}::uuid[]))`;
    expect(f!.n, 'hay candidatos ajenos al caso en la BD de pruebas: el SQL los tocaría').toBe(0);
  }

  /** Lo escrito para esos comprobantes, sin lo que por fuerza difiere (id, created_at). */
  const movimientosDe = async (ids: string[]) => (await sql`SELECT m.llave_idempotencia, m.bolsa_id, b.alcance, m.tipo, m.origen,
      m.concepto, m.organismo_codigo, m.tramite_id, m.comprobante_id, m.valor::text AS valor, m.saldo_resultante::text AS saldo_resultante,
      m.periodo, m.fecha::text AS fecha, m.observacion, m.soporte_id, m.registrado_por_id, m.registrado_por_nombre,
      m.corrige_movimiento_id, m.revierte_movimiento_id
    FROM flito_bolsas_unicas_movimientos m JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id
    WHERE m.comprobante_id IN ${sql(ids.length ? ids : [NADA])} ORDER BY m.llave_idempotencia`).map((f) => ({ ...f }));

  const saldos = async (bolsas: string[]) => Object.fromEntries((await sql`SELECT id, saldo::text AS saldo FROM flito_bolsas_unicas
    WHERE id IN ${sql(bolsas)} ORDER BY id`).map((f) => [f.id as string, f.saldo as string]));

  /** Deshace lo que escribió una corrida: los movimientos de esos comprobantes y los saldos de las bolsas. */
  async function deshacer(ids: string[], antes: Record<string, string>): Promise<void> {
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE comprobante_id IN ${sql(ids)}`;
    for (const [id, saldo] of Object.entries(antes)) await sql`UPDATE flito_bolsas_unicas SET saldo = ${saldo} WHERE id = ${id}`;
  }

  /** Todas las bolsas sembradas en este archivo (compañía y tránsito). */
  async function bolsasSembradas(): Promise<string[]> {
    const ids = creados.clients.length ? creados.clients : [-1];
    const tb = creados.transito.length ? creados.transito : [NADA];
    return (await sql`SELECT id FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`)
      .map((f) => f.id as string);
  }

  /** Liquidación (antes del corte) que ya cobró el impuesto del trámite en las dos bolsas. */
  async function liquidacionPrevia(companiaId: number, org: string, tramiteId: string, valor: number): Promise<void> {
    const { db } = await import('../../src/db/client.js');
    const transito = await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
    const ctx = { userId: USER, nombre: 'hu13972@flit.io' };
    const hoy = libro.hoyIso();
    await db.transaction(async (tx) => {
      await libro.asentarSiHayBolsa(tx, companiaId, {
        tipo: 'salida', origen: 'automatico', valor, fecha: hoy, concepto: 'impuesto',
        tramiteId, llaveIdempotencia: `salida:tramite:${tramiteId}:impuesto`, etiqueta: 'salida',
      }, ctx);
      await transito.registrarConsumoTransito(tx, {
        organismoCodigo: org, concepto: 'impuesto', tramiteId, valor, fecha: hoy, llave: `tramite:${tramiteId}:impuesto`,
      }, ctx);
    });
  }

  /** SOAT ya conciliado (mismas llaves `salida:soat:` / `consumo:soat:` que el comprobante). */
  async function conciliacionPrevia(companiaId: number, org: string, soatId: string, valor: number): Promise<void> {
    const { db } = await import('../../src/db/client.js');
    const transito = await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
    const ctx = { userId: USER, nombre: 'hu13972@flit.io' };
    const hoy = libro.hoyIso();
    await db.transaction(async (tx) => {
      await libro.asentarSiHayBolsa(tx, companiaId, {
        tipo: 'salida', origen: 'conciliacion', valor, fecha: hoy, concepto: 'soat',
        organismoCodigo: org, tramiteId: null, llaveIdempotencia: `salida:soat:${soatId}`, etiqueta: 'salida',
      }, ctx);
      await transito.registrarConsumoTransito(tx, {
        organismoCodigo: org, concepto: 'soat', tramiteId: null, valor, fecha: hoy, llave: `soat:${soatId}`, origen: 'conciliacion',
      }, ctx);
    });
  }

  /** El escenario completo de la paridad: un comprobante por regla, con fechas de aplicación escalonadas. */
  async function escenario(): Promise<{ ids: string[]; porCaso: Record<string, string> }> {
    const porCaso: Record<string, string> = {};
    let minuto = 0;
    const k = async (caso: string, tramiteId: string, concepto: string, valor: number) => {
      minuto += 1;
      porCaso[caso] = await comprobante(tramiteId, concepto, valor, `2001-01-10T15:${String(minuto).padStart(2, '0')}:00Z`);
    };
    // Compañía + tránsito con dos comprobantes en las MISMAS bolsas (encadenan saldo_resultante).
    const c1 = await compania();
    const org1 = secretaria();
    await bolsaTransito(org1, ['impuesto', 'derecho']);
    const tImp = await tramite(c1.companiaId, { impuesto: org1 });
    await k('impuesto_ambos', tImp.tramiteId, 'impuesto', 150_000.5);
    // Derecho SIN fila en flito_derechos_tramite (HU #13969): tránsito por flito_tramites.organismo_codigo.
    const tDer = await tramite(c1.companiaId, { organismo: org1 });
    await k('derecho_sin_dueno', tDer.tramiteId, 'derecho', 45_000);
    // Liquidación viva del mismo concepto → cubierto_por_liquidacion en los dos lados.
    const c2 = await compania();
    const org2 = secretaria();
    await bolsaTransito(org2, ['impuesto', 'soat']);
    const tLiq = await tramite(c2.companiaId, { impuesto: org2 });
    await liquidacionPrevia(c2.companiaId, org2, tLiq.tramiteId, 120_000);
    await k('cubierto_por_liquidacion', tLiq.tramiteId, 'impuesto', 120_000);
    // SOAT ya conciliado → cubierto_por_conciliacion en los dos lados.
    const tSoat = await tramite(c2.companiaId, { soat: org2 });
    await conciliacionPrevia(c2.companiaId, org2, tSoat.soatId!, 300_000);
    await k('cubierto_por_conciliacion', tSoat.tramiteId, 'soat', 300_000);
    // Bolsas inactivas (compañía y tránsito).
    const cIn = await compania({ bolsa: 'inactiva' });
    const orgIn = secretaria();
    await bolsaTransito(orgIn, ['impuesto'], { activa: false });
    const tIn = await tramite(cIn.companiaId, { impuesto: orgIn });
    await k('inactiva', tIn.tramiteId, 'impuesto', 50_000);
    // Sin bolsa (compañía sin bolsa; secretaría sin cobertura).
    const cSin = await compania({ bolsa: 'ninguna' });
    const tSin = await tramite(cSin.companiaId, { impuesto: secretaria() });
    await k('sin_bolsa', tSin.tramiteId, 'impuesto', 60_000);
    // Concepto no cubierto: logística (gestionada) sin marcar en la bolsa; tránsito no cubre logística.
    const tLog = await tramite(c1.companiaId);
    await k('concepto_no_cubierto', tLog.tramiteId, 'logistica', 70_000);
    // Autogestionado: la compañía autogestiona el impuesto (tránsito sí descuenta, RN-T3).
    const cAuto = await compania({ impuestosAutogestionable: true });
    const orgAuto = secretaria();
    await bolsaTransito(orgAuto, ['impuesto']);
    const tAuto = await tramite(cAuto.companiaId, { impuesto: orgAuto });
    await k('autogestionado', tAuto.tramiteId, 'impuesto', 80_000);
    // Sin compañía: el trámite no la tiene (tránsito sí descuenta).
    const orgSc = secretaria();
    await bolsaTransito(orgSc, ['impuesto']);
    // (el registro del impuesto exige compañía; el trámite no la tiene, que es lo que mira RN-C3).
    const tSc = await tramite(null, { impuesto: orgSc, companiaRegistro: c1.companiaId });
    await k('sin_compania', tSc.tramiteId, 'impuesto', 90_000);
    // Sin organismo: SOAT sin registro dueño (compañía descuenta con `salida:comprobante:`).
    const tSo = await tramite(c1.companiaId);
    await k('sin_organismo', tSo.tramiteId, 'soat', 33_000);
    // Periodo cerrado + saldo negativo: el periodo de hoy cerrado en las dos bolsas.
    const cCer = await compania({ saldo: 1_000 });
    const orgCer = secretaria();
    const tbCer = await bolsaTransito(orgCer, ['impuesto'], { saldo: 2_000 });
    const periodoHoy = libro.periodoDeFecha(libro.hoyIso());
    for (const b of [cCer.bolsaId!, tbCer]) {
      await sql`INSERT INTO flito_bolsas_unicas_cierres (bolsa_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
        VALUES (${b}, ${periodoHoy}, 0, 0, 0, 0, 0, 'test')`;
    }
    const tCer = await tramite(cCer.companiaId, { impuesto: orgCer });
    await k('periodo_cerrado', tCer.tramiteId, 'impuesto', 25_000);
    // Posterior al corte: no es candidato de ninguno de los dos.
    porCaso.posterior = await comprobante(tImp.tramiteId, 'impuesto', 11_000, '2001-02-01T05:00:00Z');
    return { ids: Object.values(porCaso), porCaso };
  }

  /**
   * El reporte sin lo que el TS en --apply pierde: `procesar` arma `{ concepto, valor, ...await db.transaction(…) }`
   * y lee `concepto`/`valor` ANTES de que la tx los asigne (defecto preexistente de la HU #13910; la simulación no
   * lo tiene). Se quita `concepto` y el `valor` de las omisiones; el resto debe coincidir igual.
   */
  const sinBase = (lineas: Linea[]) => lineas.map(({ concepto: _c, ...l }) => ({ ...l, valor: l.resultado === 'omitido' ? null : l.valor }));

  const resumen = (lineas: Linea[], id: string) =>
    lineas.filter((l) => l.comprobanteId === id).map((l) => `${l.alcance}:${l.resultado}:${l.motivo ?? '-'}`);

  // ─────────────────────────── AC ───────────────────────────

  it('las funciones de -simulacion.sql y -aplicar.sql son idénticas; solo cambian ROLLBACK/COMMIT; sin metacomandos psql', () => {
    const funciones = (s: string) => s.slice(s.indexOf('-- >>> FUNCIONES'), s.indexOf('-- <<< FUNCIONES'));
    expect(funciones(SIMULACION).length).toBeGreaterThan(1000);
    expect(funciones(APLICAR)).toBe(funciones(SIMULACION));
    expect(SIMULACION.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(APLICAR.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const s of [SIMULACION, APLICAR]) {
      expect(s).not.toMatch(/^\s*\\/m); // \set, \i, …
      const codigo = s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
      // :var / :'var' de psql (los casts `::tipo` y las llaves 'salida:soat:' dentro de literales no cuentan).
      expect(codigo).not.toMatch(/(^|[^:]):'[A-Za-z_]/m);
      expect(codigo.replace(/'[^']*'/g, "''")).not.toMatch(/(^|[^:]):[A-Za-z_]/m);
      expect(s.match(LITERAL)).toHaveLength(1);
      expect(s).toContain("SET LOCAL flito.backfill_usuario = '';");
    }
  });

  it('AC3 · paridad: mismo reporte y mismos movimientos (llave, bolsa, tipo, concepto, valor, periodo, fecha, autor, observación, saldo) que el TS', async () => {
    const { ids, porCaso } = await escenario();
    const bolsas = await bolsasSembradas();
    const antes = await saldos(bolsas);
    await soloEstos(ids);
    // El reporte del TS se toma de su simulación (RN-B5: es exactamente lo que --apply escribe). El de --apply trae
    // `concepto` vacío (y `valor` 0 en las omisiones) por un defecto preexistente del script, ver `sinBase`.
    const porTs = await correrTs(ids, false);
    expect(await movimientosDe(ids)).toHaveLength(0);

    const porSql = await correrSql(APLICAR, String(USER));
    const movSql = await movimientosDe(ids);
    const saldosSql = await saldos(bolsas);
    await deshacer(ids, antes);
    expect(await movimientosDe(ids)).toHaveLength(0);

    const porTsApply = await correrTs(ids, true);
    const movTs = await movimientosDe(ids);

    expect(porSql.lineas).toEqual(porTs);
    expect(sinBase(porSql.lineas)).toEqual(sinBase(porTsApply));
    expect(movSql).toEqual(movTs);
    expect(saldosSql).toEqual(await saldos(bolsas));

    // Y lo que se compara no es trivial: cada regla aparece con su motivo.
    expect(resumen(porSql.lineas, porCaso.impuesto_ambos!)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
    expect(resumen(porSql.lineas, porCaso.derecho_sin_dueno!)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
    expect(resumen(porSql.lineas, porCaso.cubierto_por_liquidacion!)).toEqual(['compania:omitido:cubierto_por_liquidacion', 'transito:omitido:cubierto_por_liquidacion']);
    expect(resumen(porSql.lineas, porCaso.cubierto_por_conciliacion!)).toEqual(['compania:omitido:cubierto_por_conciliacion', 'transito:omitido:cubierto_por_conciliacion']);
    expect(resumen(porSql.lineas, porCaso.inactiva!)).toEqual(['compania:omitido:inactiva', 'transito:omitido:inactiva']);
    expect(resumen(porSql.lineas, porCaso.sin_bolsa!)).toEqual(['compania:omitido:sin_bolsa', 'transito:omitido:sin_bolsa']);
    expect(resumen(porSql.lineas, porCaso.concepto_no_cubierto!)).toEqual(['compania:omitido:concepto_no_cubierto', 'transito:omitido:concepto_no_cubierto']);
    expect(resumen(porSql.lineas, porCaso.autogestionado!)).toEqual(['transito:descontado:-', 'compania:omitido:autogestionado']);
    expect(resumen(porSql.lineas, porCaso.sin_compania!)).toEqual(['transito:descontado:-', 'compania:omitido:sin_compania']);
    expect(resumen(porSql.lineas, porCaso.sin_organismo!)).toEqual(['compania:descontado:-', 'transito:omitido:sin_organismo']);
    expect(resumen(porSql.lineas, porCaso.periodo_cerrado!)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
    expect(resumen(porSql.lineas, porCaso.posterior!)).toEqual([]);
    expect(porSql.lineas.filter((l) => l.comprobanteId === porCaso.periodo_cerrado).every((l) => l.negativo)).toBe(true);
    expect(movTs.every((m) => m.observacion === NOTA && m.registrado_por_id === USER && m.fecha === libro.hoyIso())).toBe(true);
    expect(movTs.find((m) => m.comprobante_id === porCaso.derecho_sin_dueno && m.alcance === 'transito')?.llave_idempotencia)
      .toBe(`consumo:comprobante:${porCaso.derecho_sin_dueno}`);
    // Ley 1581: ni el reporte ni los NOTICE llevan datos personales.
    const texto = [JSON.stringify(porSql.lineas), ...porSql.notices].join('\n');
    for (const dato of pii) expect(texto).not.toContain(dato);
  });

  it('AC1 · la simulación no escribe nada y su reporte es el de la simulación del TS', async () => {
    const c = await compania();
    const org = secretaria();
    await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const a = await comprobante(t.tramiteId, 'impuesto', 150_000);
    const cSin = await compania({ bolsa: 'ninguna' });
    const tSin = await tramite(cSin.companiaId, { soat: secretaria() });
    const b = await comprobante(tSin.tramiteId, 'soat', 90_000, '2001-01-11T15:00:00Z');
    const bolsas = await bolsasSembradas();
    const antes = await saldos(bolsas);
    await soloEstos([a, b]);

    const porSql = await correrSql(SIMULACION, String(USER));

    expect(await movimientosDe([a, b])).toHaveLength(0);
    expect(await saldos(bolsas)).toEqual(antes);
    expect(porSql.lineas).toEqual(await correrTs([a, b], false));
    expect(resumen(porSql.lineas, a)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
    expect(porSql.notices.some((m) => m.includes(a) && m.includes('descontado'))).toBe(true);
  });

  it('AC4 · aplicar dos veces (y aplicar tras el TS) no duplica: todo sale ya_descontado', async () => {
    const c = await compania();
    const org = secretaria();
    await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const a = await comprobante(t.tramiteId, 'impuesto', 80_000);
    const t2 = await tramite(c.companiaId, { impuesto: org });
    const b = await comprobante(t2.tramiteId, 'impuesto', 20_000, '2001-01-11T15:00:00Z');
    await soloEstos([a, b]);

    await correrSql(APLICAR, String(USER));
    const tras1 = await movimientosDe([a, b]);
    expect(tras1).toHaveLength(4);
    const segunda = await correrSql(APLICAR, String(USER));

    expect(await movimientosDe([a, b])).toEqual(tras1);
    expect(segunda.lineas.map((l) => l.resultado)).toEqual(['ya_descontado', 'ya_descontado', 'ya_descontado', 'ya_descontado']);
    // Las llaves son las del TS: el script TS después del SQL reporta lo mismo y tampoco duplica.
    expect(await correrTs([a, b], false)).toEqual(segunda.lineas);
    expect(sinBase(await correrTs([a, b], true))).toEqual(sinBase(segunda.lineas));
    expect(await movimientosDe([a, b])).toEqual(tras1);
  });

  it('AC5 · sin fila de corte → RAISE «Falta el corte…» antes de mirar el usuario; no escribe nada', async () => {
    const c = await compania();
    const org = secretaria();
    await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const a = await comprobante(t.tramiteId, 'impuesto', 70_000);
    await corte.quitar();

    for (const usuario of [String(USER), '']) {
      await expect(correrSql(APLICAR, usuario)).rejects.toThrow('Falta el corte: aplique la migración 0260 antes del backfill');
    }
    expect(await movimientosDe([a])).toHaveLength(0);
  });

  it('AC5 · sin tabla de corte (0260 sin aplicar) → mismo RAISE, sin leer ninguna otra tabla', async () => {
    // Sin tocar el esquema compartido: con search_path = pg_catalog ninguna tabla de la app es visible, así que
    // si el script leyera cualquier cosa antes de comprobar el corte fallaría con otro error.
    const sinTabla = APLICAR.replace('BEGIN;', 'BEGIN;\nSET LOCAL search_path = pg_catalog;');
    await expect(correrSql(sinTabla, String(USER))).rejects.toThrow('Falta el corte: aplique la migración 0260 antes del backfill');
  });

  it('AC6 · usuario vacío, no numérico o inexistente → RAISE claro; no escribe nada', async () => {
    const c = await compania();
    const org = secretaria();
    await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const a = await comprobante(t.tramiteId, 'impuesto', 70_000);
    await soloEstos([a]);
    const [m] = await sql`SELECT coalesce(max(id), 0) + 1000 AS id FROM users`;

    await expect(correrSql(APLICAR, '')).rejects.toThrow(/Falta el id del usuario/);
    await expect(correrSql(APLICAR, 'abc')).rejects.toThrow(/Falta el id del usuario/);
    await expect(correrSql(APLICAR, String(m!.id))).rejects.toThrow(new RegExp(`El usuario ${m!.id} no existe`));
    expect(await movimientosDe([a])).toHaveLength(0);
  });
});
