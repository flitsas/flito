// HU #13891 (Feature #13888, ADR-0028 §9/§14) — purga por retención de las versiones REEMPLAZADAS del
// expediente documental de la compañía. La programación vive en `flito-bolsas-documentos-purga.cron.ts`;
// la política, en `docs/privacy/retencion-flito-bolsas-documentos.md`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-BDP1  Retención de N años (5 por defecto, `BOLSAS_DOCUMENTOS_RETENCION_ANIOS`) desde
//          `reemplazado_en` (Ley 1581 de 2012 art. 4 lit. b; Decreto 1377 de 2013 art. 11). Elegible:
//          `NOT vigente AND purgado_en IS NULL AND reemplazado_en <= ahora − N años` (frontera
//          inclusiva). La VIGENTE nunca se purga, tenga la antigüedad que tenga (AC2); una reemplazada
//          de menos de N años se conserva (AC3).
//
// RN-BDP2  La FILA se conserva como constancia (tipo, versión, fechas, quién cargó) sin archivo: en UNA
//          transacción por compañía se anula `storage_key`, se marca `purgado_en`, se ENCOLA el borrado
//          del objeto en `flito_storage_borrados_pendientes` (origen `bolsas-documentos`) y se deja UNA
//          entrada de Bitácora por compañía (`bolsas.documentos.versiones_purgadas`): id opaco de la
//          compañía, cantidad y bytes; la fecha es la del registro. Sin NIT, nombres, claves ni nombres
//          de archivo (AC1).
//
// RN-BDP3  Después de la transacción se intenta borrar el objeto UNA vez. Si el almacenamiento falla,
//          el pendiente queda abierto con el nombre del error y lo reintenta el barrido horario de
//          `flito-soat-borrados-pendientes` (independiente del `origen`): la fila no se pierde y el
//          objeto no queda huérfano (AC4). «El objeto no existe» cuenta como borrado.
//
// Logs: solo conteos, ids opacos (uuid de la versión), huella de la clave y nombre del error.

import { and, asc, eq, inArray, isNotNull, isNull, lte, not } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { auditLogs, flitoBolsasDocumentos, flitoStorageBorradosPendientes } from '../../db/schema.js';
import { removeEntityDocument } from '../../services/storage.js';
import { esObjetoInexistente, huellaClave, nombreDeError } from '../../services/storage-errores.js';
import { loggerFor } from '../../shared/logger.js';
import {
  cerrarPendienteTrasBorrado, type ResultadoBorradoObjeto,
} from '../flito-soat/flito-soat-borrados-pendientes.service.js';

const log = loggerFor('flito-bolsas-documentos.purga');
const t = flitoBolsasDocumentos;

/** N de RN-BDP1 (ADR-0028 §14). Un solo lugar: `env.ts`. */
export const ANIOS_RETENCION_VERSIONES = env.BOLSAS_DOCUMENTOS_RETENCION_ANIOS;
/** Versiones por corrida: el atraso de un primer encendido se drena en días. */
export const LOTE_PURGA = 200;
/** `origen` del borrado pendiente. */
export const ORIGEN_PURGA_BOLSAS_DOCUMENTOS = 'bolsas-documentos';
/** Acción de Bitácora (una por compañía y corrida). */
export const ACCION_BITACORA_PURGA = 'bolsas.documentos.versiones_purgadas';

/** Instante de corte: `ahora − N años` (calendario UTC; el 29-feb cae al 1-mar). */
export function corteRetencion(ahora: Date, anios: number = ANIOS_RETENCION_VERSIONES): Date {
  const corte = new Date(ahora.getTime());
  corte.setUTCFullYear(corte.getUTCFullYear() - anios);
  return corte;
}

interface Candidata {
  id: string;
  companiaId: number;
  storageKey: string | null;
  tamanoBytes: number;
  vigente: boolean;
  reemplazadoEn: Date | null;
  purgadoEn: Date | null;
}

/** Segunda barrera de RN-BDP1 sobre lo que devolvió la consulta (el WHERE es la primera). */
export function esPurgable(c: Candidata, corte: Date): boolean {
  return !c.vigente && c.purgadoEn === null && c.storageKey !== null
    && c.reemplazadoEn !== null && c.reemplazadoEn.getTime() <= corte.getTime();
}

export interface ResultadoPurga {
  /** Filas que devolvió la consulta. */
  consideradas: number;
  /** Versiones marcadas como purgadas (fila conservada, sin archivo). */
  purgadas: number;
  companias: number;
  bytes: number;
  /** Objetos cuyo borrado quedó confirmado en esta corrida. */
  objetosBorrados: number;
  /** Objetos que quedaron en la cola de borrados pendientes (AC4). */
  objetosPendientes: number;
}

interface Encolado { documentoId: string; storageKey: string; pendienteId: string | null }

/** RN-BDP2: una compañía, una transacción. Devuelve lo marcado y encolado. */
async function marcarCompania(companiaId: number, filas: Candidata[], ahora: Date): Promise<Encolado[]> {
  const claves = new Map(filas.map((f) => [f.id, f.storageKey as string]));
  const bytesDe = new Map(filas.map((f) => [f.id, f.tamanoBytes]));
  return db.transaction(async (tx) => {
    // Primero se anula la clave y se marca la purga; después se encola el objeto (ADR-0028 §9).
    const marcadas = await tx.update(t)
      .set({ storageKey: null, purgadoEn: ahora })
      .where(and(
        inArray(t.id, [...claves.keys()]),
        eq(t.companiaId, companiaId),
        eq(t.vigente, false),
        isNull(t.purgadoEn),
        isNotNull(t.storageKey),
      ))
      .returning({ id: t.id });
    if (marcadas.length === 0) return [];
    const encolados: Encolado[] = [];
    let bytes = 0;
    for (const { id } of marcadas) {
      const storageKey = claves.get(id);
      if (!storageKey) continue;
      bytes += bytesDe.get(id) ?? 0;
      const [p] = await tx.insert(flitoStorageBorradosPendientes).values({
        storageKey, claveHash: huellaClave(storageKey), origen: ORIGEN_PURGA_BOLSAS_DOCUMENTOS,
      }).returning({ id: flitoStorageBorradosPendientes.id });
      encolados.push({ documentoId: id, storageKey, pendienteId: p?.id ?? null });
    }
    await tx.insert(auditLogs).values({
      userId: null,
      userEmail: 'sistema',
      action: 'delete',
      resource: ACCION_BITACORA_PURGA,
      resourceId: String(companiaId),
      detail: `${ACCION_BITACORA_PURGA}: retención de ${ANIOS_RETENCION_VERSIONES} años tras el reemplazo `
        + `(Ley 1581). Versiones purgadas: ${marcadas.length}. Bytes eliminados: ${bytes}.`,
    });
    return encolados;
  });
}

/** RN-BDP3: un intento; el fallo queda en el pendiente y en el log, sin la clave. Nunca lanza. */
async function borrarObjeto(e: Encolado): Promise<ResultadoBorradoObjeto> {
  try {
    await removeEntityDocument(e.storageKey);
    return { borrado: true, motivo: 'borrado', intentos: 1, error: null };
  } catch (err) {
    if (esObjetoInexistente(err)) return { borrado: true, motivo: 'inexistente', intentos: 1, error: null };
    const error = nombreDeError(err);
    log.warn({
      evento: 'bolsas.documentos.purga_objeto_pendiente', documentoId: e.documentoId,
      claveHash: huellaClave(e.storageKey), err: error,
    }, 'No se pudo borrar de storage una versión purgada; queda en borrados pendientes');
    return { borrado: false, motivo: null, intentos: 1, error };
  }
}

/** Una corrida completa (un lote). La llama el cron dentro de `withLock`. */
export async function ejecutarPurgaVersiones(
  opts: { ahora?: Date; lote?: number } = {},
): Promise<ResultadoPurga> {
  const ahora = opts.ahora ?? new Date();
  const corte = corteRetencion(ahora);
  const r: ResultadoPurga = {
    consideradas: 0, purgadas: 0, companias: 0, bytes: 0, objetosBorrados: 0, objetosPendientes: 0,
  };
  const candidatas: Candidata[] = await db.select({
    id: t.id, companiaId: t.companiaId, storageKey: t.storageKey, tamanoBytes: t.tamanoBytes,
    vigente: t.vigente, reemplazadoEn: t.reemplazadoEn, purgadoEn: t.purgadoEn,
  }).from(t)
    .where(and(not(t.vigente), isNull(t.purgadoEn), isNotNull(t.storageKey), lte(t.reemplazadoEn, corte)))
    .orderBy(asc(t.reemplazadoEn))
    .limit(opts.lote ?? LOTE_PURGA);
  r.consideradas = candidatas.length;

  const porCompania = new Map<number, Candidata[]>();
  for (const c of candidatas) {
    if (!esPurgable(c, corte)) continue;
    const lista = porCompania.get(c.companiaId) ?? [];
    lista.push(c);
    porCompania.set(c.companiaId, lista);
  }

  for (const [companiaId, filas] of porCompania) {
    let encolados: Encolado[];
    try {
      encolados = await marcarCompania(companiaId, filas, ahora);
    } catch (e) {
      // La transacción no se aplicó: nada marcado ni encolado; la corrida siguiente lo reintenta.
      log.error({ evento: 'bolsas.documentos.purga_compania_fallida', err: nombreDeError(e) },
        'Purga de versiones: la transacción de una compañía falló');
      continue;
    }
    if (encolados.length === 0) continue;
    r.companias += 1;
    r.purgadas += encolados.length;
    const ids = new Set(encolados.map((x) => x.documentoId));
    r.bytes += filas.filter((f) => ids.has(f.id)).reduce((s, f) => s + f.tamanoBytes, 0);
    for (const e of encolados) {
      const res = await borrarObjeto(e);
      await cerrarPendienteTrasBorrado(e.pendienteId, res, ahora);
      if (res.borrado) r.objetosBorrados += 1;
      else r.objetosPendientes += 1;
    }
  }
  return r;
}
