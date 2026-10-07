// FLITO SOAT — retención: el RECORRIDO de la purga de archivos de las solicitudes por validar
// DESCARTADAS (HU #13409, Feature #13408, Épica #13201). La regla RN-RET1 completa —qué se borra,
// cuándo, qué se conserva y la base legal— está en la cabecera de `flito-soat-retencion.cron.ts` y
// en `docs/privacy/retencion-flito-soat.md`. Aquí vive el CÓMO, por solicitud:
//
//   1. Cada documento adicional (`flito_soportes` con `soat_incompleta_id`, `soat_id` NULL, tipo
//      `documento_adicional_soat`): se borra el OBJETO y, solo si el almacenamiento confirma (o
//      responde que ya no existe), se borra su FILA. Un fallo deja la fila: es la constancia de lo
//      que falta, y lo que la corrida siguiente reintenta (AC5).
//   2. La factura de venta (`factura_storage_key`): se borra el objeto. La columna se conserva —es
//      NOT NULL y queda como dato histórico—, así que lo que dice «ya no está» es la marca del paso 3.
//   3. Solo si no quedó NADA pendiente: `archivos_purgados_en = <instante de la corrida>` y UNA
//      entrada de Bitácora, en la misma transacción. Una solicitud marcada sale de la consulta, y
//      eso es la idempotencia (AC4): la segunda corrida ni la lee.
//
// ── Lo que NUNCA sale de aquí (AC6 + Ley 1581) ──────────────────────────────────────────────────
//
// Las claves de almacenamiento llevan la carpeta del NIT y el nombre del archivo: son PII. Ni al
// log ni a la Bitácora. Para correlacionar un fallo en el log va el id de la solicitud, el del
// soporte (uuid opaco) y una huella sha256 de 16 hex de la clave, como en la HU #13364. Del error
// del almacenamiento va su NOMBRE/código, nunca el mensaje (el SDK puede repetir la clave en él).
//
// ── Los bytes de la Bitácora ────────────────────────────────────────────────────────────────────
//
// Del tamaño GUARDADO, no de un `statObject` (que sería otra llamada al bucket por objeto): el de
// cada adicional sale de `flito_soportes.tamano_bytes` y el de la factura de
// `flito_soat_incompletas.factura_tamano_bytes`. Cuentan solo los objetos que ESTA corrida confirmó
// borrados (incluido «no existía»): si una corrida anterior borró un adicional y falló en otro, el
// ya borrado perdió su fila y no figura en la entrada de la corrida que completa.
//
// «No existe» = `code`/`name` `NoSuchKey`, `NotFound` o `NoSuchObject` (S3Error del cliente MinIO) o
// HTTP 404. Cualquier otro error (`AccessDenied`, red, timeout) es fallo y deja el objeto pendiente.
//
// `removeEntityDocument` y no `deleteEntityDocument`: el segundo se traga el error (y loguea la
// clave), y la purga necesita saber si falló para no dar por borrado lo que sigue en el bucket.

import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLogs, flitoSoatIncompletas, flitoSoportes } from '../../db/schema.js';
import { removeEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-soat-retencion');

/** Días de retención tras el descarte (RN-RET1). 30 × 24 h exactas, no días de calendario. */
export const DIAS_RETENCION = 30;
const MS_DIA = 24 * 60 * 60 * 1000;

/** Solicitudes por corrida. Lo que no quepa, a la del día siguiente (las más viejas primero). */
export const LOTE_RETENCION = 200;

/** Tipo del soporte que se purga. Otro tipo con `soat_incompleta_id` no es de esta regla. */
export const TIPO_ADICIONAL = 'documento_adicional_soat';

/** Lo que se registra en la Bitácora como «acción» del evento (AC6). Cabe en `resource` (50). */
export const ACCION_BITACORA = 'soat.incompleta.archivos_purgados';

/**
 * El instante de corte: una descartada con `resuelta_en <= corte` ya cumplió los 30 días.
 *
 * Se calcula en el proceso y viaja como PARÁMETRO, no como `now() - interval '30 days'`: el
 * intervalo de Postgres en días es de calendario en la zona de la sesión, y la regla son 30 × 24 h.
 * Además fija el reloj de la corrida: el mismo `ahora` es el que se escribe en `archivos_purgados_en`.
 */
export function corteRetencion(ahora: Date): Date {
  return new Date(ahora.getTime() - DIAS_RETENCION * MS_DIA);
}

/** Predicado puro de la frontera (apoyo de los tests): ¿ya cumplió los 30 días? Inclusivo. */
export function esPurgable(resueltaEn: Date, ahora: Date): boolean {
  return resueltaEn.getTime() <= corteRetencion(ahora).getTime();
}

/** Candidatas: descartadas, sin purgar, con el descarte en o antes del corte (frontera inclusiva). */
export function condicionCandidatas(corte: Date): SQL {
  return and(
    eq(flitoSoatIncompletas.estado, 'descartada'),
    isNull(flitoSoatIncompletas.archivosPurgadosEn),
    lte(flitoSoatIncompletas.resueltaEn, corte),
  )!;
}

/** Los adicionales de UNA solicitud que la purga puede tocar: nunca uno que ya cuelgue de un SOAT. */
export function condicionAdicionales(incompletaId: string): SQL {
  return and(
    eq(flitoSoportes.soatIncompletaId, incompletaId),
    isNull(flitoSoportes.soatId),
    eq(flitoSoportes.tipo, TIPO_ADICIONAL),
  )!;
}

/** Huella corta de una clave para correlacionar en el log sin escribirla (sha256, 16 hex). */
export function huellaClave(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** ¿El almacenamiento dijo «ese objeto no existe»? Para la purga eso es «borrado» (AC4). */
export function esObjetoInexistente(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; name?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const codigos = ['NoSuchKey', 'NotFound', 'NoSuchObject'];
  return codigos.includes(String(o.code)) || codigos.includes(String(o.name))
    || o.statusCode === 404 || o.$metadata?.httpStatusCode === 404;
}

/** Nombre/código del error para el log: nunca el mensaje, que puede repetir la clave. */
function nombreDeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; name?: unknown };
    if (typeof o.code === 'string' && o.code) return o.code;
    if (typeof o.name === 'string' && o.name) return o.name;
  }
  return 'error';
}

/** Borra un objeto. `true` si quedó borrado (incluido «no existía»); `false` si el bucket falló. */
async function borrarObjeto(key: string, ctx: { incompletaId: string; soporteId?: string; que: string }): Promise<boolean> {
  try {
    await removeEntityDocument(key);
    return true;
  } catch (e) {
    if (esObjetoInexistente(e)) return true;
    log.error(
      { ...ctx, clave: huellaClave(key), err: nombreDeError(e) },
      'retención SOAT: el almacenamiento no borró el objeto; se reintenta en la próxima corrida',
    );
    return false;
  }
}

export interface ResultadoPurgaIncompleta {
  /** Quedó marcada `archivos_purgados_en` en esta corrida. */
  purgada: boolean;
  /** Objetos que el almacenamiento confirmó borrados en esta corrida. */
  archivos: number;
  bytes: number;
  /** Objetos que siguen en el bucket por un fallo: los reintenta la corrida siguiente. */
  pendientes: number;
}

interface Candidata { id: string; facturaStorageKey: string; facturaTamanoBytes: number }

/** Purga UNA solicitud descartada. Ver la cabecera para el orden y por qué. */
export async function purgarIncompleta(inc: Candidata, ahora: Date): Promise<ResultadoPurgaIncompleta> {
  let archivos = 0;
  let bytes = 0;
  let pendientes = 0;

  const adicionales = await db.select({
    id: flitoSoportes.id, storageKey: flitoSoportes.storageKey, tamanoBytes: flitoSoportes.tamanoBytes,
  }).from(flitoSoportes).where(condicionAdicionales(inc.id));

  for (const a of adicionales) {
    if (!(await borrarObjeto(a.storageKey, { incompletaId: inc.id, soporteId: a.id, que: 'adicional' }))) {
      pendientes += 1;
      continue;
    }
    // La fila se va SOLO con el objeto ya borrado (AC5). El WHERE repite la pertenencia y el
    // `soat_id IS NULL`: lo que se lee y lo que se borra cumplen la misma regla (AC3).
    await db.delete(flitoSoportes).where(and(eq(flitoSoportes.id, a.id), condicionAdicionales(inc.id)));
    archivos += 1;
    bytes += Number(a.tamanoBytes) || 0;
  }

  if (await borrarObjeto(inc.facturaStorageKey, { incompletaId: inc.id, que: 'factura' })) {
    archivos += 1;
    bytes += Number(inc.facturaTamanoBytes) || 0;
  } else {
    pendientes += 1;
  }

  if (pendientes > 0) return { purgada: false, archivos, bytes, pendientes };

  const purgada = await db.transaction(async (tx) => {
    const marcadas = await tx.update(flitoSoatIncompletas)
      // Solo la marca: estado, motivo, cuándo y quién del descarte quedan como estaban (AC1).
      .set({ archivosPurgadosEn: ahora })
      .where(and(
        eq(flitoSoatIncompletas.id, inc.id),
        eq(flitoSoatIncompletas.estado, 'descartada'),
        isNull(flitoSoatIncompletas.archivosPurgadosEn),
      ))
      .returning({ id: flitoSoatIncompletas.id });
    // Sin fila marcada (otra mano la marcó entre la lectura y aquí) no hay segunda Bitácora (AC4).
    if (marcadas.length === 0) return false;
    // AC6: id opaco, conteo y bytes. Sin VIN, nombres, nombres de archivo ni claves.
    await tx.insert(auditLogs).values({
      userId: null,
      userEmail: 'sistema',
      action: 'delete',
      resource: ACCION_BITACORA,
      resourceId: inc.id,
      detail: `${ACCION_BITACORA}: retención de ${DIAS_RETENCION} días tras el descarte (Ley 1581). `
        + `Archivos eliminados: ${archivos}. Bytes eliminados: ${bytes}.`,
    });
    return true;
  });

  return { purgada, archivos, bytes, pendientes: 0 };
}

export interface ResultadoRetencion {
  consideradas: number;
  purgadas: number;
  /** Solicitudes que quedaron con algo pendiente (fallo del almacenamiento o de la base). */
  conPendientes: number;
  archivos: number;
  bytes: number;
}

/**
 * Una corrida: lee hasta `limite` candidatas (las de descarte más viejo primero) y las purga una a
 * una. Un fallo en una solicitud no detiene las demás. Devuelve conteos: ningún identificador.
 */
export async function ejecutarPurgaRetencion(
  opts: { ahora?: Date; limite?: number } = {},
): Promise<ResultadoRetencion> {
  const ahora = opts.ahora ?? new Date();
  const candidatas = await db.select({
    id: flitoSoatIncompletas.id,
    facturaStorageKey: flitoSoatIncompletas.facturaStorageKey,
    facturaTamanoBytes: flitoSoatIncompletas.facturaTamanoBytes,
  }).from(flitoSoatIncompletas)
    .where(condicionCandidatas(corteRetencion(ahora)))
    .orderBy(asc(flitoSoatIncompletas.resueltaEn))
    .limit(opts.limite ?? LOTE_RETENCION);

  const r: ResultadoRetencion = { consideradas: candidatas.length, purgadas: 0, conPendientes: 0, archivos: 0, bytes: 0 };
  for (const inc of candidatas) {
    try {
      const p = await purgarIncompleta(inc, ahora);
      r.archivos += p.archivos;
      r.bytes += p.bytes;
      if (p.purgada) r.purgadas += 1;
      else if (p.pendientes > 0) r.conPendientes += 1;
    } catch (e) {
      r.conPendientes += 1;
      log.error({ incompletaId: inc.id, err: nombreDeError(e) }, 'retención SOAT: la purga de la solicitud falló');
    }
  }
  return r;
}
