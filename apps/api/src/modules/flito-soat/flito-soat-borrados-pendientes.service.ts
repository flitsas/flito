// FLITO SOAT — borrados PENDIENTES del almacenamiento (HU #13410, Feature #13408, Épica #13201):
// el RECORRIDO de la corrida horaria y el cierre del pendiente tras el borrado inmediato. La
// programación (puerta, candado, cadencia) vive en `flito-soat-borrados-pendientes.cron.ts`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-BP1  Durabilidad. Eliminar un documento adicional borra su fila de `flito_soportes` y, en la
//         MISMA transacción, inserta el pendiente (`flito_storage_borrados_pendientes`) con la clave
//         del objeto. Si el proceso muere antes de borrar el objeto, la base recuerda qué falta.
//         Un pendiente se cierra (`resuelto_en`, `motivo_cierre`) cuando el almacenamiento confirma
//         el borrado (`borrado`) o responde que el objeto no existe (`inexistente`). Un fallo NO lo
//         cierra: suma `intentos`, anota `ultimo_intento_en` y `ultimo_error` (code/name) y la corrida
//         siguiente lo reintenta (como máximo una vez cada `MIN_ENTRE_INTENTOS_MS`).
//
// RN-BP2  Clave aún referenciada. Si la clave sigue nombrada por una fila viva (`flito_soportes.
//         storage_key` o `flito_soat_incompletas.factura_storage_key`), el objeto NO se borra: el
//         pendiente se cierra como `referenciada` y queda un `warn` en el log.
//
// RN-BP3  Alerta. Un pendiente abierto con 72 h o más desde `creado_en` que vuelve a fallar deja
//         `soat.storage.borrado_pendiente_persistente` en el log (error), como mucho una vez cada
//         24 h por pendiente (`ultima_alerta_en`). El gauge `flito_storage_borrados_pendientes_abiertos`
//         refleja los abiertos por origen tras cada corrida.
//
// RN-BP4  Puerta positiva + candado: ver la cabecera del cron.
//
// ── Ley 1581 ─────────────────────────────────────────────────────────────────────────────────────
//
// `storage_key` es PII (NIT de la carpeta + nombre del archivo). Solo vive en la fila mientras el
// pendiente está ABIERTO: todo UPDATE de cierre la pone a NULL (`valoresCierre`), y el CHECK
// `ck_flito_storage_borrados_pendientes_clave` lo exige. Ni la clave ni el mensaje del error van al
// log, a `ultimo_error` ni a la Bitácora: solo el id del pendiente, el origen, conteos y code/name.

import { and, asc, count, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, flitoSoatIncompletas, flitoSoportes, flitoStorageBorradosPendientes,
} from '../../db/schema.js';
import type { MotivoCierreBorrado } from '../../db/schema/flito-storage-borrados-pendientes.js';
import { removeEntityDocument } from '../../services/storage.js';
import { esObjetoInexistente, nombreDeError } from '../../services/storage-errores.js';
import { loggerFor } from '../../shared/logger.js';
import { flitoStorageBorradosPendientesAbiertos } from '../../shared/metrics.js';

const log = loggerFor('flito-soat-borrados-pendientes');
const t = flitoStorageBorradosPendientes;

/** Pendientes por corrida (los más viejos primero). */
export const LOTE_BORRADOS = 100;
/** Horas desde `creado_en` a partir de las cuales un fallo alerta (RN-BP3). */
export const HORAS_ALERTA = 72;
/** Mínimo entre dos alertas del mismo pendiente (RN-BP3). */
export const HORAS_ENTRE_ALERTAS = 24;
/** Un pendiente intentado hace menos de esto no se reintenta en esta corrida (RN-BP1). */
export const MIN_ENTRE_INTENTOS_MS = 55 * 60_000;
/** «Acción» de la Bitácora al cerrar un pendiente desde el cron. Cabe en `resource` (50). */
export const ACCION_BITACORA_BORRADO = 'soat.storage.borrado_pendiente_resuelto';
/** Largo de `ultimo_error`. */
const LARGO_ERROR = 100;
const MS_HORA = 60 * 60_000;

/** Lo que pasó al intentar borrar un objeto (borrado inmediato de la HU #13364/#13410). */
export interface ResultadoBorradoObjeto {
  borrado: boolean;
  motivo: 'borrado' | 'inexistente' | null;
  intentos: number;
  /** code/name del último error; nunca el mensaje. */
  error: string | null;
}

/**
 * Columnas del CIERRE de un pendiente. La clave se borra aquí (Ley 1581): un pendiente cerrado ya no
 * necesita saber qué objeto era, y le queda `clave_hash` para correlacionar con los logs.
 */
export function valoresCierre(motivo: MotivoCierreBorrado, ahora: Date) {
  return { resueltoEn: ahora, motivoCierre: motivo, storageKey: null };
}

/** Un pendiente que sigue abierto: todo UPDATE de cierre o de fallo lo exige (idempotencia). */
function abiertoConId(id: string): SQL {
  return and(eq(t.id, id), isNull(t.resueltoEn))!;
}

/**
 * Tras el intento inmediato de `eliminarDocumentoAdicional`: cierra el pendiente o anota el fallo.
 * NUNCA lanza ni cambia la respuesta al usuario (AC2): si el UPDATE falla, el pendiente queda abierto
 * y el cron lo resuelve (como `inexistente` si el objeto ya se había borrado).
 */
export async function cerrarPendienteTrasBorrado(
  pendienteId: string | null, r: ResultadoBorradoObjeto, ahora: Date = new Date(),
): Promise<void> {
  if (!pendienteId) return;
  try {
    const valores = r.borrado && r.motivo
      ? { ...valoresCierre(r.motivo, ahora), intentos: r.intentos, ultimoIntentoEn: ahora }
      : { intentos: r.intentos, ultimoIntentoEn: ahora, ultimoError: (r.error ?? 'error').slice(0, LARGO_ERROR) };
    await db.update(t).set(valores).where(abiertoConId(pendienteId));
  } catch (e) {
    log.warn({ evento: 'soat.storage.borrado_pendiente_no_actualizado', pendienteId, err: nombreDeError(e) },
      'No se pudo actualizar el borrado pendiente tras el intento inmediato; lo resuelve el cron');
  }
}

/** Abiertos que esta corrida puede intentar: sin resolver y no intentados hace menos de 55 min. */
export function condicionAbiertos(ahora: Date): SQL {
  const desde = new Date(ahora.getTime() - MIN_ENTRE_INTENTOS_MS);
  return and(isNull(t.resueltoEn), or(isNull(t.ultimoIntentoEn), lte(t.ultimoIntentoEn, desde)))!;
}

/** ¿Este fallo alerta? 72 h o más desde `creado_en` y sin alerta en las últimas 24 h (inclusivo). */
export function debeAlertar(p: { creadoEn: Date; ultimaAlertaEn: Date | null }, ahora: Date): boolean {
  const ms = ahora.getTime();
  if (p.creadoEn.getTime() > ms - HORAS_ALERTA * MS_HORA) return false;
  return p.ultimaAlertaEn === null || p.ultimaAlertaEn.getTime() <= ms - HORAS_ENTRE_ALERTAS * MS_HORA;
}

/** Claves del lote que aún nombra una fila viva (RN-BP2). Dos consultas parametrizadas por lote. */
export async function clavesReferenciadas(claves: string[]): Promise<Set<string>> {
  if (claves.length === 0) return new Set();
  const [soportes, incompletas] = await Promise.all([
    db.select({ clave: flitoSoportes.storageKey }).from(flitoSoportes)
      .where(inArray(flitoSoportes.storageKey, claves)),
    db.select({ clave: flitoSoatIncompletas.facturaStorageKey }).from(flitoSoatIncompletas)
      .where(inArray(flitoSoatIncompletas.facturaStorageKey, claves)),
  ]);
  return new Set([...soportes, ...incompletas].map((f) => f.clave));
}

export interface ResultadoBorrados {
  leidos: number;
  borrados: number;
  inexistentes: number;
  referenciados: number;
  fallidos: number;
  alertados: number;
  /** Abiertos al final de la corrida (todos los orígenes). */
  abiertos: number;
}

interface Pendiente {
  id: string; storageKey: string | null; origen: string; intentos: number;
  creadoEn: Date; ultimaAlertaEn: Date | null;
}

/** Cierra un pendiente borrado (o inexistente) y deja UNA Bitácora si el UPDATE tomó la fila. */
async function cerrarConBitacora(p: Pendiente, motivo: 'borrado' | 'inexistente', ahora: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const cerradas = await tx.update(t)
      .set({ ...valoresCierre(motivo, ahora), intentos: sql`${t.intentos} + 1`, ultimoIntentoEn: ahora })
      .where(abiertoConId(p.id))
      .returning({ id: t.id });
    // Otra mano lo cerró entre la lectura y aquí: sin segunda Bitácora.
    if (cerradas.length === 0) return false;
    await tx.insert(auditLogs).values({
      userId: null,
      userEmail: 'sistema',
      action: 'delete',
      resource: ACCION_BITACORA_BORRADO,
      resourceId: p.id,
      detail: `${ACCION_BITACORA_BORRADO}: origen ${p.origen}; motivo ${motivo}; intentos ${p.intentos + 1}.`,
    });
    return true;
  });
}

/** Un pendiente: referenciada → cerrar sin borrar; si no, borrar y cerrar, o anotar el fallo. */
async function procesar(p: Pendiente, referenciadas: Set<string>, ahora: Date, r: ResultadoBorrados): Promise<void> {
  const clave = p.storageKey;
  if (clave === null || referenciadas.has(clave)) {
    // `clave === null` no debería existir abierto (CHECK); si apareciera, no hay objeto que borrar.
    await db.update(t).set(valoresCierre('referenciada', ahora)).where(abiertoConId(p.id));
    log.warn({ evento: 'soat.storage.borrado_pendiente_referenciada', pendienteId: p.id, origen: p.origen },
      'Borrado pendiente cerrado sin borrar: la clave sigue referenciada');
    r.referenciados += 1;
    return;
  }

  let motivo: 'borrado' | 'inexistente' = 'borrado';
  try {
    await removeEntityDocument(clave);
  } catch (e) {
    if (!esObjetoInexistente(e)) {
      const alerta = debeAlertar(p, ahora);
      await db.update(t).set({
        intentos: sql`${t.intentos} + 1`,
        ultimoIntentoEn: ahora,
        ultimoError: nombreDeError(e).slice(0, LARGO_ERROR),
        ...(alerta ? { ultimaAlertaEn: ahora } : {}),
      }).where(abiertoConId(p.id));
      r.fallidos += 1;
      if (alerta) {
        r.alertados += 1;
        log.error({
          evento: 'soat.storage.borrado_pendiente_persistente', pendienteId: p.id, origen: p.origen, intentos: p.intentos + 1,
        }, `Borrado pendiente del almacenamiento sin resolver tras ${HORAS_ALERTA} h`);
      }
      return;
    }
    motivo = 'inexistente';
  }
  if (await cerrarConBitacora(p, motivo, ahora)) {
    if (motivo === 'borrado') r.borrados += 1;
    else r.inexistentes += 1;
  }
}

/** Refresca el gauge con los abiertos por origen y devuelve el total. */
async function refrescarGauge(): Promise<number> {
  const filas = await db.select({ origen: t.origen, n: count() }).from(t)
    .where(isNull(t.resueltoEn)).groupBy(t.origen);
  // `reset` primero: un origen que llega a 0 no se queda con su último valor.
  flitoStorageBorradosPendientesAbiertos.reset();
  let total = 0;
  for (const f of filas) {
    const n = Number(f.n) || 0;
    flitoStorageBorradosPendientesAbiertos.set({ origen: f.origen }, n);
    total += n;
  }
  return total;
}

/**
 * Una corrida: lee hasta `limite` pendientes abiertos (los más viejos primero), los resuelve uno a
 * uno y refresca el gauge. Un fallo en un pendiente no detiene los demás. Sin pendientes no toca el
 * almacenamiento ni la Bitácora. Devuelve conteos: ningún identificador.
 */
export async function ejecutarBorradosPendientes(
  opts: { ahora?: Date; limite?: number } = {},
): Promise<ResultadoBorrados> {
  const ahora = opts.ahora ?? new Date();
  const pendientes: Pendiente[] = await db.select({
    id: t.id, storageKey: t.storageKey, origen: t.origen, intentos: t.intentos,
    creadoEn: t.creadoEn, ultimaAlertaEn: t.ultimaAlertaEn,
  }).from(t)
    .where(condicionAbiertos(ahora))
    .orderBy(asc(t.creadoEn))
    .limit(opts.limite ?? LOTE_BORRADOS);

  const r: ResultadoBorrados = {
    leidos: pendientes.length, borrados: 0, inexistentes: 0, referenciados: 0, fallidos: 0, alertados: 0, abiertos: 0,
  };
  if (pendientes.length > 0) {
    const claves = pendientes.map((p) => p.storageKey).filter((k): k is string => k !== null);
    const referenciadas = await clavesReferenciadas(claves);
    for (const p of pendientes) {
      try {
        await procesar(p, referenciadas, ahora, r);
      } catch (e) {
        r.fallidos += 1;
        log.error({ pendienteId: p.id, origen: p.origen, err: nombreDeError(e) },
          'borrados pendientes: el pendiente falló por la base');
      }
    }
  }
  r.abiertos = await refrescarGauge();
  return r;
}
