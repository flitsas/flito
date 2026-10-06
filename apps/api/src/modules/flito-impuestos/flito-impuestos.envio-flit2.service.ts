// FLITO Impuestos — envío automático del comprobante de pago a FLIT 2 (HU #13268, Feature #13267,
// Épica #12741, ADR-0020). Diseño `docs/diseno/feature-13267-envio-comprobante-flit2.md` §5-§9.
// Outbox `flito_impuesto_envios_flit2` (una fila por impuesto, migración 0219) + cron de 60 s.
// La toma y la pausa global viven en `flito-impuestos.envio-flit2.cola.ts`.
//
// RN-01 Disparo (outbox). Desde la HU #13310 lo hace `programarEnvioComprobante` (envio-comun.ts), que
//   mapea fuente → destino (`flit2` o `flit1`); se re-exporta aquí para sus llamadores.
// RN-02 Sin retroactivo. Solo `programarEnvioComprobante` CREA filas, y solo desde un camino a `pagado`.
//   `completarComprobanteFlit2` (el de `adjuntarAPagado`) solo promueve una fila que ya existe (de
//   cualquier destino: trabaja por fila, sin fuente).
// RN-04 Ritmo. Ciclo bajo el cerrojo del cron; lote ≤ 50; concurrencia 4; plazo del ciclo 50 s; un
//   `espera` (429) o una `pausa` cortan el ciclo y lo no empezado se libera sin tocar intentos.
//   `estacionar` no corta (es del trámite, no de la cola). El JWT es el cacheado del pase.
// RN-05 Habilitación. `FLIT2_ADJUNTOS_ENVIO_HABILITADO` ∧ interruptor `flit2` ∧ sin pausa vigente;
//   si no, el ciclo no toma nada (filas e intentos intactos). `FLIT2_SYNC_CRON` NO gobierna el envío (D-3).
// RN-06 Envío de una fila. Re-valida el soporte (descartado o borrado → re-elige; sin soporte →
//   `sin_comprobante`), pre-valida tamaño (stat, antes de bajar) y MIME por bytes; fuera de límite →
//   `error` sin llamada ni intento. Registra la lectura en la auditoría PII y llama al puerto.
// RN-07 Desenlace. `UPDATE … WHERE id AND version = tomada`: si la fila se reprogramó mientras tanto,
//   el desenlace viejo no la pisa. Toda salida de `en_espera` limpia `sync_version_espera` y
//   `en_espera_desde` (lo exige el CHECK de la 0219). 3 intentos → `error` (AC5).
// RN-08 Bitácora (AC9). `audit_logs` por cada intento que llegó a FLIT 2, cada estacionamiento y cada
//   `error` local. Logs: solo ids, status y códigos. Nunca placa, documento, nombre de archivo ni URL.
// RN-09 Lectura (AC10). `envioFlit2DeImpuesto` → null si el trámite no es de FLIT 2 o no hay fila
//   (resuelve la fuente por join: el ítem del detalle no la trae). El detalle usa `envioDeImpuesto`.
// RN-10 Reemplazo (HU #13269). `reprogramarEnvioFlit2` en la tx del reemplazo: vuelve a `pendiente`
//   con el soporte nuevo y `version + 1`; `ya_cargado_gestor` no se reenvía; sin fila no se envía.
//   Solo filas `destino = 'flit2'` (ADR-0021 D-12): el reemplazo de FLIT 1 es la HU #13311.
// La toma FLIT 2 filtra `destino = 'flit2'` (cola): el ciclo FLIT 1 vive en `envio-flit1.service.ts`.

import { and, eq, sql } from 'drizzle-orm';
import {
  EstadoEnvioFlit2, MAX_INTENTOS_ENVIO_FLIT2, type EnvioComprobanteFlit2, type ReprogramacionEnvioFlit2,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, flitoImpuestoEnviosFlit2 } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import { statEntityDocument } from '../../services/storage.js';
import { fuenteHabilitada } from '../flito-sync/flito-sync-interruptor.service.js';
import { getFlit2SyncAdapter } from '../flito-sync/flit2-sync.adapter.js';
import { Flit2BloqueadoError, Flit2Error } from '../flito-sync/flit2.errors.js';
import { EXTENSION_POR_MIME, MAX_BYTES_ADJUNTO, mimeAdjuntoPorBytes } from '../flito-sync/flit2-adjuntos.js';
import type { Flit2SyncPort, ResultadoEnvioAdjunto } from '../flito-sync/flit2-sync.port.js';
import {
  LOTE_ENVIO_FLIT2, PAUSA_ENVIO_FLIT2_MS, PAUSA_PASE_ENVIO_FLIT2_MS, leerPausaEnvio, liberarEnvio, pausarEnvio,
  quitarPausaEnvio, tomarLoteEnvios, type FilaEnvioTomada,
} from './flito-impuestos.envio-flit2.cola.js';
import {
  EnvioComprobanteError, SALE_DE_ESPERA, auditar, elegirComprobante, envioDeImpuesto, escribir as escribirComun, fuenteDelImpuesto,
  leerBytes, registrarLecturaPii, soporteVigente, type Cambios, type Escritor,
} from './flito-impuestos.envio-comun.js';

// Re-exportados: sus llamadores (pago, revisiones, detalle) y tests los importan de aquí.
export {
  elegirComprobante, elegirDeSoportes, envioDeImpuesto, envioDesdeFila, envioFlit2DesdeFila, programarEnvioComprobante,
  EnvioComprobanteError as EnvioFlit2Error, type SoporteCandidato,
} from './flito-impuestos.envio-comun.js';

const log = loggerFor('flito-impuestos.envio-flit2');

const T = flitoImpuestoEnviosFlit2;
export const CONCURRENCIA_ENVIO_FLIT2 = 4;
/** Plazo del ciclo: lo no empezado a los 50 s se libera (el ciclo es cada 60 s). */
export const PLAZO_CICLO_ENVIO_FLIT2_MS = 50_000;
/** Espera tras el intento N fallido (índice = intentos previos): 5 min y 30 min; el 3.º es `error`. */
export const BACKOFF_ENVIO_FLIT2_MS: readonly number[] = [5 * 60_000, 30 * 60_000];
/** Sondeo de seguridad de una fila `en_espera` (D-1). */
export const SONDEO_ESPERA_FLIT2_MS = 24 * 60 * 60_000;
/** Tope de `en_espera` antes de `error` (`espera_vencida`, D-1). */
export const ESPERA_MAXIMA_FLIT2_MS = 30 * 24 * 60 * 60_000;

/**
 * RN-02. El recibo cargado DESPUÉS sobre un impuesto ya pagado (`adjuntarAPagado`): promueve una fila
 * `sin_comprobante` existente o refresca el soporte de una `pendiente`/`en_espera`. NUNCA crea fila:
 * un impuesto pagado antes del despliegue no tiene fila y así sigue (AC3).
 */
export async function completarComprobanteFlit2(tx: Escritor, impuestoId: string, ahora: Date = new Date()): Promise<void> {
  const soporteId = await elegirComprobante(tx, impuestoId);
  if (!soporteId) return;
  await tx.update(T).set({
    estado: sql`CASE WHEN ${T.estado} = 'sin_comprobante' THEN 'pendiente' ELSE ${T.estado} END`,
    soporteId,
    proximoIntentoEn: sql`CASE WHEN ${T.estado} = 'sin_comprobante' THEN ${ahora.toISOString()}::timestamptz ELSE ${T.proximoIntentoEn} END`,
    // Soporte distinto: FLIT 1 reempieza desde el paso 1 (ADR-0021 D-4). En filas FLIT 2 ya son null.
    archivoFlit1Id: null,
    ultimoPaso: null,
    updatedAt: sql`now()`,
  }).where(and(
    eq(T.impuestoId, impuestoId),
    sql`(${T.estado} = 'sin_comprobante'
      OR (${T.estado} IN ('pendiente','en_espera') AND ${T.soporteId} IS DISTINCT FROM ${soporteId}))`,
  ));
}

// ── RN-10 / HU #13269: reprogramación por reemplazo del comprobante ─────────────────────────────

/** Estados que el reemplazo devuelve a `pendiente` (diseño §12). `ya_cargado_gestor` queda fuera: gana el gestor. */
const REPROGRAMABLES: readonly EstadoEnvioFlit2[] = [
  EstadoEnvioFlit2.ENVIADO, EstadoEnvioFlit2.ERROR, EstadoEnvioFlit2.PENDIENTE,
  EstadoEnvioFlit2.EN_ESPERA, EstadoEnvioFlit2.SIN_COMPROBANTE,
];

/**
 * RN-10 (HU #13269, diseño §12). DENTRO de la transacción del reemplazo, después de descartar el
 * soporte viejo e insertar el nuevo. Nunca crea fila (D-5): sin fila no se envía. Con fila
 * reprogramable: `pendiente` desde cero con el soporte nuevo y `version + 1`, que es lo que impide
 * (guarda de RN-07) que un envío en vuelo del soporte viejo pise la reprogramación. Limpia la toma,
 * el último resultado y la espera (el CHECK de la 0219 exige `en_espera` ⇔ ambas columnas).
 */
export async function reprogramarEnvioFlit2(
  tx: Escritor, impuestoId: string, soporteNuevoId: string, ctx: { userId: number | null; username: string }, ahora: Date = new Date(),
): Promise<ReprogramacionEnvioFlit2> {
  // D-12 (ADR-0021): solo la fila FLIT 2; una fila FLIT 1 no se toca aquí (HU #13311).
  const [fila] = await tx.select({ id: T.id, estado: T.estado }).from(T)
    .where(and(eq(T.impuestoId, impuestoId), eq(T.destino, 'flit2'))).for('update');
  if (!fila) {
    return { reenviado: false, motivo: await fuenteDelImpuesto(tx, impuestoId) === 'flit2' ? 'sin_envio_previo' : 'no_flit2' };
  }
  if (!REPROGRAMABLES.includes(fila.estado)) return { reenviado: false, motivo: 'ya_cargado_gestor' };
  await tx.update(T).set({
    estado: EstadoEnvioFlit2.PENDIENTE, soporteId: soporteNuevoId, intentos: 0, proximoIntentoEn: ahora,
    version: sql`${T.version} + 1`, tomadoPor: null, tomadoEn: null, ultimoResultado: null,
    syncVersionEspera: null, enEsperaDesde: null, updatedAt: ahora,
  }).where(eq(T.id, fila.id));
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId: impuestoId,
    detail: `Envío a FLIT 2 reprogramado por reemplazo (estaba ${fila.estado}). Soporte ${soporteNuevoId}.`,
  });
  return { reenviado: true };
}

// ── RN-09 / AC10: lectura para el detalle ───────────────────────────────────────────────────────

export async function envioFlit2DeImpuesto(impuestoId: string): Promise<EnvioComprobanteFlit2 | null> {
  return (await envioDeImpuesto(impuestoId)).envioFlit2;
}

// ── RN-06: envío de una fila ────────────────────────────────────────────────────────────────────

/** Desenlace que el ciclo necesita conocer (corte, pausa) además de lo escrito en la fila. */
export type DesenlaceFila =
  | { tipo: 'escrito'; resultado: string }
  | { tipo: 'espera' }
  | { tipo: 'pausa'; codigo: string; hasta: Date };

/** RN-07 (guarda de versión), con la etiqueta de FLIT 2 en la auditoría. */
const escribir = (fila: FilaEnvioTomada, cambios: Cambios, ahora: Date): Promise<boolean> => escribirComun('flit2', fila, cambios, ahora);

const detalle = (n: number, resultado: string, estadoFlit2: string | null, adjuntoId: string | null, soporteId: string | null): string =>
  `Envío a FLIT 2 · intento ${n} · ${resultado} · estado FLIT 2 ${estadoFlit2 || '—'} · adjunto ${adjuntoId ?? '—'} · soporte ${soporteId ?? '—'}`;

/** `error` local (pre-validación): sin llamada, sin intento (RN-06), auditado (RN-08). */
async function errorLocal(fila: FilaEnvioTomada, soporteId: string, motivo: string, ahora: Date): Promise<DesenlaceFila> {
  if (await escribir(fila, {
    estado: EstadoEnvioFlit2.ERROR, soporteId, ultimoIntentoEn: ahora, ultimoResultado: motivo, ultimoStatus: null, ...SALE_DE_ESPERA,
  }, ahora)) {
    await auditar(fila.impuestoId, detalle(fila.intentos, `${motivo} (pre-validación local, sin llamada)`, null, null, soporteId));
  }
  return { tipo: 'escrito', resultado: motivo };
}

/** RN-07 para lo que devolvió FLIT 2 (o el adaptador). */
export function cambiosPorResultado(
  fila: FilaEnvioTomada, soporteId: string, r: ResultadoEnvioAdjunto, ahora: Date,
): { cambios: Cambios; resultado: string; consumeIntento: boolean } | null {
  const base: Cambios = { soporteId, ultimoIntentoEn: ahora };
  const n = fila.intentos + 1;
  switch (r.tipo) {
    case 'enviado':
      return {
        consumeIntento: true, resultado: r.nuevo ? 'enviado' : 'enviado_idempotente',
        cambios: {
          ...base, ...SALE_DE_ESPERA, estado: EstadoEnvioFlit2.ENVIADO, intentos: n, ultimoResultado: r.nuevo ? 'enviado' : 'enviado_idempotente',
          ultimoStatus: r.nuevo ? 201 : 200, adjuntoId: r.recibido.adjuntoId, sha256: r.recibido.sha256, reemplazoDe: r.recibido.reemplazoDe,
          enMatriz: r.recibido.enMatriz, pagadoMarcado: r.recibido.pagadoMarcado, soporteEnviadoId: soporteId, enviadoEn: ahora,
        },
      };
    case 'reintentable': {
      const agotado = n >= MAX_INTENTOS_ENVIO_FLIT2;
      return {
        consumeIntento: true, resultado: r.codigo,
        cambios: {
          ...base, ...SALE_DE_ESPERA, intentos: n, ultimoResultado: r.codigo.slice(0, 40), ultimoStatus: r.status,
          estado: agotado ? EstadoEnvioFlit2.ERROR : EstadoEnvioFlit2.PENDIENTE,
          proximoIntentoEn: agotado ? null : new Date(ahora.getTime() + (BACKOFF_ENVIO_FLIT2_MS[fila.intentos] ?? BACKOFF_ENVIO_FLIT2_MS[BACKOFF_ENVIO_FLIT2_MS.length - 1])),
        },
      };
    }
    case 'estacionar': {
      const estadoFlit2 = r.estadoFlit2 ? r.estadoFlit2.slice(0, 30) : null;
      const vencida = fila.enEsperaDesde !== null && fila.enEsperaDesde.getTime() <= ahora.getTime() - ESPERA_MAXIMA_FLIT2_MS;
      if (vencida) {
        return {
          consumeIntento: false, resultado: 'espera_vencida',
          cambios: { ...base, ...SALE_DE_ESPERA, estado: EstadoEnvioFlit2.ERROR, ultimoResultado: 'espera_vencida', ultimoStatus: 409, estadoFlit2, proximoIntentoEn: null },
        };
      }
      return {
        consumeIntento: false, resultado: 'en_espera',
        cambios: {
          ...base, estado: EstadoEnvioFlit2.EN_ESPERA, ultimoResultado: 'not_allowed_in_state', ultimoStatus: 409, estadoFlit2,
          // La versión leída en la toma: el feed la tiene que superar para despertarla.
          syncVersionEspera: fila.syncVersion ?? 0,
          enEsperaDesde: fila.enEsperaDesde ?? ahora,
          proximoIntentoEn: new Date(ahora.getTime() + SONDEO_ESPERA_FLIT2_MS),
        },
      };
    }
    case 'definitivo':
      return {
        consumeIntento: true, resultado: r.motivo,
        cambios: {
          ...base, ...SALE_DE_ESPERA, intentos: n, ultimoResultado: r.motivo, ultimoStatus: r.status, proximoIntentoEn: null,
          estado: r.motivo === 'attachment_exists' ? EstadoEnvioFlit2.YA_CARGADO_GESTOR : EstadoEnvioFlit2.ERROR,
          ...(r.estadoFlit2 ? { estadoFlit2: r.estadoFlit2.slice(0, 30) } : {}),
        },
      };
    default:
      return null; // espera y pausa: no se escribe desenlace en la fila (los trata el ciclo).
  }
}

export async function enviarUna(fila: FilaEnvioTomada, adapter: Flit2SyncPort, ahora: Date): Promise<DesenlaceFila> {
  const soporte = await soporteVigente(fila);
  if (!soporte) {
    await escribir(fila, { estado: EstadoEnvioFlit2.SIN_COMPROBANTE, soporteId: null, proximoIntentoEn: null, ...SALE_DE_ESPERA }, ahora);
    return { tipo: 'escrito', resultado: 'sin_comprobante' };
  }
  const n = fila.intentos + 1;
  const stat = await statEntityDocument(soporte.storageKey);
  let r: ResultadoEnvioAdjunto;
  if (!stat) {
    r = { tipo: 'reintentable', codigo: 'almacen_no_disponible', status: null };
  } else {
    if (stat.size <= 0) return errorLocal(fila, soporte.id, 'missing_file', ahora);
    if (stat.size > MAX_BYTES_ADJUNTO) return errorLocal(fila, soporte.id, 'file_too_large', ahora);
    let bytes: Buffer;
    try {
      bytes = await leerBytes(soporte.storageKey, MAX_BYTES_ADJUNTO);
    } catch (e) {
      if (e instanceof EnvioComprobanteError && e.codigo === 'file_too_large') return errorLocal(fila, soporte.id, 'file_too_large', ahora);
      log.warn({ impuestoId: fila.impuestoId, causa: e instanceof Error ? e.name : typeof e }, 'no se pudo leer el comprobante del almacén');
      return aplicar(fila, soporte.id, { tipo: 'reintentable', codigo: 'almacen_no_disponible', status: null }, ahora);
    }
    if (bytes.length === 0) return errorLocal(fila, soporte.id, 'missing_file', ahora);
    const mime = mimeAdjuntoPorBytes(bytes);
    if (!mime) return errorLocal(fila, soporte.id, 'invalid_mime', ahora);
    await registrarLecturaPii('flit2', fila.impuestoId, n);
    try {
      r = await adapter.enviarAdjunto(fila.idFlit2, { bytes, contentType: mime, nombreArchivo: `comprobante-impuesto.${EXTENSION_POR_MIME[mime]}` });
    } catch (e) {
      if (e instanceof Flit2Error) {
        await liberarEnvio(fila);
        const hasta = e instanceof Flit2BloqueadoError ? e.hasta : new Date(ahora.getTime() + PAUSA_PASE_ENVIO_FLIT2_MS);
        return { tipo: 'pausa', codigo: `pase_${e.codigo}`, hasta };
      }
      throw e;
    }
  }
  return aplicar(fila, soporte.id, r, ahora);
}

async function aplicar(fila: FilaEnvioTomada, soporteId: string, r: ResultadoEnvioAdjunto, ahora: Date): Promise<DesenlaceFila> {
  if (r.tipo === 'espera') {
    // AC7: sin consumir intento ni cambiar estado; sale tras el Retry-After.
    await db.update(T).set({ proximoIntentoEn: new Date(ahora.getTime() + r.segundos * 1000), tomadoPor: null, tomadoEn: null, updatedAt: ahora })
      .where(and(eq(T.id, fila.id), eq(T.version, fila.version)));
    return { tipo: 'espera' };
  }
  if (r.tipo === 'pausa') {
    await liberarEnvio(fila);
    return { tipo: 'pausa', codigo: r.codigo, hasta: new Date(ahora.getTime() + PAUSA_ENVIO_FLIT2_MS) };
  }
  const c = cambiosPorResultado(fila, soporteId, r, ahora)!;
  if (await escribir(fila, c.cambios, ahora)) {
    const n = c.consumeIntento ? fila.intentos + 1 : fila.intentos;
    const estadoFlit2 = (c.cambios.estadoFlit2 as string | null | undefined) ?? null;
    const adjuntoId = (c.cambios.adjuntoId as string | null | undefined) ?? null;
    const sufijo = c.consumeIntento ? '' : ' (sin consumir intento)';
    await auditar(fila.impuestoId, detalle(n, `${c.resultado}${sufijo}`, estadoFlit2, adjuntoId, soporteId));
  }
  return { tipo: 'escrito', resultado: c.resultado };
}

// ── RN-04 / RN-05: ciclo ────────────────────────────────────────────────────────────────────────

export interface ResumenCicloEnvio {
  omitido?: 'apagado' | 'fuente_apagada' | 'pausa';
  sondeo: boolean;
  tomadas: number;
  escritas: number;
  liberadas: number;
  corte?: 'espera' | 'pausa';
}

export interface DepsCicloEnvio {
  tomadoPor: string;
  adapter?: Flit2SyncPort;
  reloj?: () => Date;
  /** Reloj monotónico del plazo del ciclo (test). */
  ahoraMs?: () => number;
}

export async function procesarCicloEnvioFlit2(deps: DepsCicloEnvio): Promise<ResumenCicloEnvio> {
  const reloj = deps.reloj ?? (() => new Date());
  const ahoraMs = deps.ahoraMs ?? (() => Date.now());
  const resumen: ResumenCicloEnvio = { sondeo: false, tomadas: 0, escritas: 0, liberadas: 0 };
  if (!env.FLIT2_ADJUNTOS_ENVIO_HABILITADO) return { ...resumen, omitido: 'apagado' };
  if (!(await fuenteHabilitada('flit2'))) return { ...resumen, omitido: 'fuente_apagada' };
  const inicio = reloj();
  const pausa = await leerPausaEnvio();
  if (pausa && pausa.hasta.getTime() > inicio.getTime()) return { ...resumen, omitido: 'pausa' };
  resumen.sondeo = pausa !== null;

  const filas = await tomarLoteEnvios({ limite: resumen.sondeo ? 1 : LOTE_ENVIO_FLIT2, tomadoPor: deps.tomadoPor, ahora: inicio });
  resumen.tomadas = filas.length;
  if (filas.length === 0) return resumen;

  const adapter = deps.adapter ?? getFlit2SyncAdapter();
  const limite = ahoraMs() + PLAZO_CICLO_ENVIO_FLIT2_MS;
  // En un objeto: el cierre de `conConcurrencia` lo escribe y TS no estrecha un `let` a `null`.
  const ciclo: { corte: Exclude<DesenlaceFila, { tipo: 'escrito' }> | null } = { corte: null };

  await conConcurrencia(filas, CONCURRENCIA_ENVIO_FLIT2, async (fila) => {
    if (ciclo.corte || ahoraMs() > limite) {
      await liberarEnvio(fila);
      resumen.liberadas += 1;
      return;
    }
    const d = await enviarUna(fila, adapter, reloj());
    if (d.tipo === 'escrito') resumen.escritas += 1;
    else if (!ciclo.corte) ciclo.corte = d;
  });

  const c = ciclo.corte;
  if (c) {
    resumen.corte = c.tipo;
    if (c.tipo === 'pausa') {
      await pausarEnvio(c.codigo, c.hasta, reloj());
      log.error({ codigo: c.codigo, hasta: c.hasta.toISOString() }, 'envío a FLIT 2 en pausa global');
    } else {
      log.info('FLIT 2 pidió esperar (429): se corta el ciclo de envío');
    }
  }
  // Sondeo con un desenlace que no fue pausa → la cola vuelve al lote normal.
  if (resumen.sondeo && c?.tipo !== 'pausa') await quitarPausaEnvio();
  return resumen;
}
