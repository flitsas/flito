/**
 * Feature #14097 (HU #14098) — lleva las fotos de `tramites_validaciones` que siguen en BD al formato
 * `encryptPiiText` (`v1:…`, AAD `tabla|columna|id`).
 *
 *   Cifra:     data_uri, base64_plano.
 *   No toca:   nuevo (ya migrado), storage_key (vive en MinIO), desconocido (no se sabe qué es),
 *              viejo (HU #14273: ya no se puede descifrar; se cuenta y se reporta como detector).
 *
 * Reanudable e idempotente por clase: lo ya escrito clasifica como `nuevo` y la siguiente corrida lo
 * salta. Lotes de 50 porque una sola fila puede traer tres fotos de varios MB.
 *
 * Nunca imprime valores, ni parciales: solo conteos por columna y clase, e ids de las filas fallidas.
 *
 * Canario de llave, antes de la primera escritura y en los dos modos. Sin él, una foto en claro se
 * cifraba y se verificaba con la misma llave equivocada: la verificación pasaba y la foto quedaba
 * sobrescrita con algo que la llave correcta no puede leer. Por eso una llave que no descifra nada de
 * lo ya cifrado aborta la corrida. Ver `comprobarCanario`.
 *
 * Uso (Job en QA/PDN: `docs/arquitectura/feature-14097-recifrado-biometria.md`):
 *   npm run tramites:recifrar-biometria -w apps/api -- --dry-run   # no escribe; sí intenta descifrar
 *   npm run tramites:recifrar-biometria -w apps/api -- --commit    # escribe
 *
 * Salida: 0 si no quedan pendientes o es dry-run; 2 si quedan (se puede volver a correr); 1 si aborta
 * (también en dry-run cuando el canario no pasa); 3 si hay algún valor `viejo`, también en dry-run:
 * volver a correr no lo arregla, lo tiene que revisar una persona.
 */

import { and, asc, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { driverProfile, tramitesValidaciones } from '../db/schema.js';
import { clasificarFoto, TABLA_FOTOS, type ClaseFoto, type ColumnaFoto } from '../modules/tramites/identidad.fotos.js';
import {
  decryptPii,
  decryptPiiText,
  encryptPiiText,
  PII_TEXT_PREFIJO,
} from '../shared/utils/crypto.js';

export const LOTE = 50;
export const MAX_CANARIOS = 5;

/** Basta para el prefijo: filtrar sobre esto evita pasar por el regex fotos de varios MB. */
const LARGO_PREFIJO = 100;

const COLUMNAS = [
  { columna: 'foto_rostro', prop: 'fotoRostro', col: tramitesValidaciones.fotoRostro },
  { columna: 'foto_cedula_frontal', prop: 'fotoCedulaFrontal', col: tramitesValidaciones.fotoCedulaFrontal },
  { columna: 'foto_cedula_reverso', prop: 'fotoCedulaReverso', col: tramitesValidaciones.fotoCedulaReverso },
] as const;

type ColumnaProp = (typeof COLUMNAS)[number]['prop'];
type FilaFotos = { id: number } & Record<ColumnaProp, string | null>;

export interface ConteoColumna extends Record<ClaseFoto, number> {
  /** Celdas que el script cifró (commit) o cifraría (dry-run), verificadas de vuelta. */
  recifrable: number;
  /** Escrituras efectivas. Siempre 0 en dry-run. */
  escrito: number;
  /** La fila cambió entre la lectura y la escritura (p. ej. el cron de retención la anonimizó). */
  omitido_concurrente: number;
  /** No pasó la verificación de vuelta: no se escribió. */
  fallo_verificacion: number;
}

export type EstadoCanario = 'ok' | 'fallo' | 'sin_canario';

export interface Resultado {
  modo: 'dry-run' | 'commit';
  canario: EstadoCanario;
  /** De dónde salió el canario, nunca qué contiene. */
  canarioFuente: string | null;
  /** La corrida paró antes de recorrer la tabla: cero escrituras. */
  abortado: boolean;
  filas: number;
  columnas: Record<ColumnaFoto, ConteoColumna>;
  /** Ids de las filas con alguna celda fallida. */
  idsFallidos: number[];
  /** Celdas que una corrida real tendría que volver a intentar. */
  pendientes: number;
  /** Celdas con forma del formato viejo. No se tocan y no son pendientes: reintentar no las arregla. */
  viejos: number;
  /** Ids de las filas con alguna de esas celdas. */
  idsViejos: number[];
}

function conteoVacio(): ConteoColumna {
  return {
    vacio: 0, storage_key: 0, nuevo: 0, viejo: 0, data_uri: 0, base64_plano: 0, desconocido: 0,
    recifrable: 0, escrito: 0, omitido_concurrente: 0, fallo_verificacion: 0,
  };
}

function leerLote(despuesDeId: number): Promise<FilaFotos[]> {
  return db.select({
    id: tramitesValidaciones.id,
    fotoRostro: tramitesValidaciones.fotoRostro,
    fotoCedulaFrontal: tramitesValidaciones.fotoCedulaFrontal,
    fotoCedulaReverso: tramitesValidaciones.fotoCedulaReverso,
  }).from(tramitesValidaciones)
    .where(and(
      gt(tramitesValidaciones.id, despuesDeId),
      or(
        isNotNull(tramitesValidaciones.fotoRostro),
        isNotNull(tramitesValidaciones.fotoCedulaFrontal),
        isNotNull(tramitesValidaciones.fotoCedulaReverso),
      ),
    ))
    .orderBy(asc(tramitesValidaciones.id))
    .limit(LOTE);
}

function esRecifrable(clase: ClaseFoto): boolean {
  return clase === 'data_uri' || clase === 'base64_plano';
}

/**
 * Hasta `MAX_CANARIOS` celdas en formato vigente, en cualquiera de las tres columnas. Un valor viejo no
 * cuenta: ninguna llave lo descifra, así que no dice nada de la llave.
 */
async function canariosDeLaTabla(): Promise<{ id: number; columna: ColumnaFoto; valor: string }[]> {
  const candidatos: { id: number; columna: ColumnaFoto; valor: string }[] = [];
  for (const { columna, col } of COLUMNAS) {
    const faltan = MAX_CANARIOS - candidatos.length;
    if (faltan === 0) break;
    const filas = await db.select({ id: tramitesValidaciones.id, valor: col })
      .from(tramitesValidaciones)
      .where(sql`left(${col}, ${LARGO_PREFIJO}) ~ ${PII_TEXT_PREFIJO.source}`)
      .orderBy(asc(tramitesValidaciones.id))
      .limit(faltan);
    for (const { id, valor } of filas) if (valor) candidatos.push({ id, columna, valor });
  }
  return candidatos;
}

function descifraCeldaDeFoto({ id, columna, valor }: { id: number; columna: ColumnaFoto; valor: string }): boolean {
  const ctx = { table: TABLA_FOTOS, column: columna, id };
  try {
    decryptPiiText(valor, ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canario de respaldo: `driver_profile.cedula`, cifrada con `encryptPii` y la misma `PII_ENC_KEY`.
 * Se elige por ser la columna de ese helper más antigua y de uso general (migración 0051, núcleo de
 * conductores), así que existe en todos los ambientes y es la que con más probabilidad tiene filas.
 */
async function canariosDeConductores(): Promise<boolean[]> {
  const filas = await db.select({
    userId: driverProfile.userId,
    cipher: driverProfile.cedulaCipher,
    iv: driverProfile.cedulaIv,
    authTag: driverProfile.cedulaAuthTag,
    aadNonce: driverProfile.cedulaAadNonce,
    keyVersion: driverProfile.cedulaKeyVersion,
  }).from(driverProfile)
    .where(and(
      isNotNull(driverProfile.cedulaCipher),
      isNotNull(driverProfile.cedulaIv),
      isNotNull(driverProfile.cedulaAuthTag),
      isNotNull(driverProfile.cedulaAadNonce),
    ))
    .limit(MAX_CANARIOS);

  return filas.map((f) => {
    try {
      decryptPii(
        { cipher: f.cipher as Buffer, iv: f.iv as Buffer, authTag: f.authTag as Buffer, keyVersion: f.keyVersion ?? 1 },
        { table: 'driver_profile', column: 'cedula', empresaNit: String(f.userId), aadNonce: f.aadNonce as string },
      );
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Pasa si al menos un canario descifra: una fila corrupta suelta no frena la corrida. Si la tabla tiene candidatos no se mira otra: lo que importa es la
 * llave con la que se cifró esta tabla. Lo descifrado se descarta aquí mismo.
 */
async function comprobarCanario(): Promise<{ estado: EstadoCanario; fuente: string | null }> {
  const locales = await canariosDeLaTabla();
  if (locales.length > 0) {
    return { estado: locales.some(descifraCeldaDeFoto) ? 'ok' : 'fallo', fuente: TABLA_FOTOS };
  }
  const externos = await canariosDeConductores();
  if (externos.length > 0) {
    return { estado: externos.some(Boolean) ? 'ok' : 'fallo', fuente: 'driver_profile.cedula' };
  }
  return { estado: 'sin_canario', fuente: null };
}

/** Se apoya en el clasificador para no tener una segunda definición de cada clase en SQL. */
async function hayCeldasPorCifrar(): Promise<boolean> {
  let ultimoId = 0;
  for (;;) {
    const lote = await leerLote(ultimoId);
    if (lote.length === 0) return false;
    for (const fila of lote) {
      if (COLUMNAS.some((def) => esRecifrable(clasificarFoto(fila[def.prop])))) return true;
    }
    ultimoId = lote[lote.length - 1].id;
  }
}

/** Cifrado comprobado de vuelta. Lanza si algo no cuadra; el texto en claro no sale de aquí. */
function recifrar(plano: string, columna: ColumnaFoto, id: number): string {
  const ctx = { table: TABLA_FOTOS, column: columna, id } as const;
  const cifrado = encryptPiiText(plano, ctx);
  if (decryptPiiText(cifrado, ctx) !== plano) throw new Error('verificación fallida');
  return cifrado;
}

/** La condición sobre el valor leído evita pisar lo que otro proceso haya cambiado mientras tanto. */
async function escribir(
  id: number,
  { prop, col }: (typeof COLUMNAS)[number],
  leido: string,
  cifrado: string,
): Promise<boolean> {
  const filas = await db.update(tramitesValidaciones)
    .set({ [prop]: cifrado })
    .where(and(eq(tramitesValidaciones.id, id), eq(col, leido)))
    .returning({ id: tramitesValidaciones.id });
  return filas.length > 0;
}

export async function run({ commit }: { commit: boolean }): Promise<Resultado> {
  const res: Resultado = {
    modo: commit ? 'commit' : 'dry-run',
    canario: 'sin_canario',
    canarioFuente: null,
    abortado: false,
    filas: 0,
    columnas: {
      foto_rostro: conteoVacio(),
      foto_cedula_frontal: conteoVacio(),
      foto_cedula_reverso: conteoVacio(),
    },
    idsFallidos: [],
    pendientes: 0,
    viejos: 0,
    idsViejos: [],
  };
  const fallidos = new Set<number>();
  const conViejo = new Set<number>();

  const canario = await comprobarCanario();
  res.canario = canario.estado;
  res.canarioFuente = canario.fuente;
  if (canario.estado === 'fallo' || (canario.estado === 'sin_canario' && await hayCeldasPorCifrar())) {
    res.abortado = true;
    return res;
  }

  let ultimoId = 0;
  for (;;) {
    const lote = await leerLote(ultimoId);
    if (lote.length === 0) break;

    for (const fila of lote) {
      res.filas++;
      for (const def of COLUMNAS) {
        const valor = fila[def.prop];
        const clase = clasificarFoto(valor);
        const conteo = res.columnas[def.columna];
        conteo[clase]++;
        if (clase === 'viejo') {
          res.viejos++;
          conViejo.add(fila.id);
          continue;
        }
        if (!esRecifrable(clase)) continue;

        let cifrado: string;
        try {
          cifrado = recifrar(valor as string, def.columna, fila.id);
        } catch {
          // Sin el error en el reporte: la causa no aporta y así nada del dato puede colarse.
          conteo.fallo_verificacion++;
          fallidos.add(fila.id);
          res.pendientes++;
          continue;
        }
        conteo.recifrable++;
        if (!commit) continue;
        // Llegó en plena corrida sin canario: sin llave comprobada no se escribe; la próxima corrida lo ve.
        if (res.canario !== 'ok') {
          res.pendientes++;
          continue;
        }

        if (await escribir(fila.id, def, valor as string, cifrado)) {
          conteo.escrito++;
        } else {
          conteo.omitido_concurrente++;
          res.pendientes++;
        }
      }
    }
    ultimoId = lote[lote.length - 1].id;
  }

  res.idsFallidos = [...fallidos].sort((a, b) => a - b);
  res.idsViejos = [...conViejo].sort((a, b) => a - b);
  return res;
}

/** Exige la bandera: un script que reescribe biometría no decide solo si corre en serio. */
export function modoDesdeArgs(args: string[]): { commit: boolean } | null {
  const dry = args.includes('--dry-run');
  const commit = args.includes('--commit');
  if (dry === commit) return null;
  return { commit };
}

export function codigoSalida(r: Resultado): number {
  if (r.abortado) return 1;
  if (r.viejos > 0) return 3;
  return r.modo === 'dry-run' || r.pendientes === 0 ? 0 : 2;
}

const argv1 = process.argv[1] ?? '';
const isDirectRun = (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (argv1.endsWith('flito-recifrar-biometria.ts') || argv1.endsWith('flito-recifrar-biometria.js'))
);

if (isDirectRun) {
  const modo = modoDesdeArgs(process.argv.slice(2));
  if (!modo) {
    console.error('[abort] indica exactamente una bandera: --dry-run o --commit');
    process.exit(1);
  }
  run(modo).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (r.abortado) console.error(`[abort] canario: ${r.canario}; no se escribió nada`);
    if (r.viejos > 0) console.error(`[alerta] ${r.viejos} celdas en formato viejo: no se tocaron; ver idsViejos`);
    process.exit(codigoSalida(r));
  }).catch((e) => {
    console.error('[error]', e instanceof Error ? e.name : 'fallo');
    process.exit(1);
  });
}
