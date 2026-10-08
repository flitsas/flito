// FLITO Impuestos — envío automático del comprobante de pago a FLIT 1 (HU #13310, Feature #13309,
// Épica #12741, ADR-0021). Diseño `docs/diseno/feature-13309-envio-comprobante-flit1.md` §5 y §7.2.
// Comparte con FLIT 2 la fila del outbox (`destino = 'flit1'`), el upsert del pago y los helpers del
// soporte (`envio-comun.ts`); el ciclo, la toma y la pausa son propios para que apagar, pausar o cortar
// un destino nunca frene al otro (AC7, AC8).
//
// RN-F1-01 Ciclo. `FLIT1_ADJUNTOS_ENVIO_HABILITADO` ∧ las dos bases válidas → si no, `omitido: 'apagado'`
//   (no llama, no toca filas: AC7). Interruptor `flit1` → `fuente_apagada`. Pausa vigente → `pausa`;
//   vencida → sondeo de una fila. Lote ≤ 20, concurrencia 2, plazo 50 s mirado ANTES de empezar cada
//   fila (nunca aborta una en vuelo). Una `pausa` corta el ciclo; lo no empezado se libera sin intento.
// RN-F1-02 Una fila. Soporte vigente (sin soporte → `sin_comprobante`) → id real (AC2: inválido →
//   `error` sin llamar) → stat/bytes/MIME (AC3: fuera de límite → `error` sin llamar) → lectura PII del
//   sistema (AC9) → si hay `archivo_flit1_id` del MISMO soporte, solo el PUT (AC5); si no, desde el paso 1.
// RN-F1-03 Desenlace (`cambiosPorResultadoFlit1`, §5.1). 3 intentos en total (un intento = una pasada,
//   haga 1, 2 o 3 pasos); backoff 5/30 min. `archivo_flit1_id` se guarda SOLO si el paso 2 terminó bien
//   (AC4/AC5), también tras una `pausa` del paso 3 (sin intento ni cambio de estado): un archivo ya subido
//   al bucket no se vuelve a subir. Definitivo → `error` con status y paso, sin cuerpo (AC6). Escritura con
//   guarda de versión.
// RN-F1-04 Bitácora (AC9). `audit_logs` por intento: resultado, paso y status. Nunca URL, fields, nombre
//   de archivo ni datos del propietario.

import { EstadoEnvioFlit2, MAX_INTENTOS_ENVIO_FLIT1 } from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import { statEntityDocument } from '../../services/storage.js';
import { fuenteHabilitada } from '../flito-sync/flito-sync-interruptor.service.js';
import { EXTENSION_POR_MIME, MAX_BYTES_ADJUNTO, mimeAdjuntoPorBytes } from '../flito-sync/flit2-adjuntos.js';
import { idRealDeIdFlit } from '../flito-sync/flit1-adjuntos.js';
import { configFlit1Adjuntos, crearFlit1AdjuntosHttp } from '../flito-sync/flit1-adjuntos.http.js';
import type { Flit1AdjuntosPort, ResultadoEnvioFlit1 } from '../flito-sync/flit1-adjuntos.port.js';
import { liberarEnvio } from './flito-impuestos.envio-flit2.cola.js';
import {
  LOTE_ENVIO_FLIT1, PAUSA_ENVIO_FLIT1_MS, leerPausaEnvioFlit1, pausarEnvioFlit1, quitarPausaEnvioFlit1,
  tomarLoteEnviosFlit1, type FilaEnvioFlit1Tomada,
} from './flito-impuestos.envio-flit1.cola.js';
import {
  EnvioComprobanteError, auditar, escribir as escribirComun, leerBytes, registrarLecturaPii, soporteVigente, type Cambios,
} from './flito-impuestos.envio-comun.js';

const log = loggerFor('flito-impuestos.envio-flit1');

export const CONCURRENCIA_ENVIO_FLIT1 = 2;
/** Plazo del ciclo: lo no empezado a los 50 s se libera (el ciclo es cada 60 s). */
export const PLAZO_CICLO_ENVIO_FLIT1_MS = 50_000;
/** Espera tras el intento N fallido (índice = intentos previos): 5 min y 30 min; el 3.º es `error`. */
export const BACKOFF_ENVIO_FLIT1_MS: readonly number[] = [5 * 60_000, 30 * 60_000];

export type DesenlaceFilaFlit1 =
  | { tipo: 'escrito'; resultado: string }
  | { tipo: 'pausa'; codigo: string; hasta: Date };

const escribir = (fila: FilaEnvioFlit1Tomada, cambios: Cambios, ahora: Date): Promise<boolean> => escribirComun('flit1', fila, cambios, ahora);

const detalle = (n: number, resultado: string, paso: number | null, status: number | null, soporteId: string | null): string =>
  `Envío a FLIT 1 · intento ${n} · ${resultado} · paso ${paso ?? '—'} · HTTP ${status ?? '—'} · soporte ${soporteId ?? '—'}`;

/** `error` local (pre-validación AC2/AC3): sin llamada, sin intento, auditado. */
async function errorLocal(fila: FilaEnvioFlit1Tomada, soporteId: string, motivo: string, ahora: Date): Promise<DesenlaceFilaFlit1> {
  if (await escribir(fila, {
    estado: EstadoEnvioFlit2.ERROR, soporteId, ultimoIntentoEn: ahora, ultimoResultado: motivo, ultimoStatus: null,
    ultimoPaso: null, proximoIntentoEn: null,
  }, ahora)) {
    await auditar(fila.impuestoId, detalle(fila.intentos, `${motivo} (pre-validación local, sin llamada)`, null, null, soporteId));
  }
  return { tipo: 'escrito', resultado: motivo };
}

/** RN-F1-03 (pura, §5.1). null para `pausa`: no se escribe desenlace en la fila (la trata el ciclo). */
export function cambiosPorResultadoFlit1(
  fila: Pick<FilaEnvioFlit1Tomada, 'intentos'>, soporteId: string, r: ResultadoEnvioFlit1, ahora: Date,
): { cambios: Cambios; resultado: string; paso: number; status: number | null } | null {
  const n = fila.intentos + 1;
  const base: Cambios = { soporteId, ultimoIntentoEn: ahora, intentos: n };
  switch (r.tipo) {
    case 'enviado':
      return {
        resultado: 'enviado', paso: 3, status: r.status,
        cambios: {
          ...base, estado: EstadoEnvioFlit2.ENVIADO, ultimoResultado: 'enviado', ultimoStatus: r.status, ultimoPaso: 3,
          archivoFlit1Id: r.archivoId, soporteEnviadoId: soporteId, enviadoEn: ahora, proximoIntentoEn: null,
        },
      };
    case 'reintentable': {
      const agotado = n >= MAX_INTENTOS_ENVIO_FLIT1;
      const espera = BACKOFF_ENVIO_FLIT1_MS[fila.intentos] ?? BACKOFF_ENVIO_FLIT1_MS[BACKOFF_ENVIO_FLIT1_MS.length - 1]!;
      return {
        resultado: r.codigo, paso: r.paso, status: r.status,
        cambios: {
          ...base, ultimoResultado: r.codigo.slice(0, 40), ultimoStatus: r.status,
          // El almacén no es un paso de FLIT 1: `ultimo_paso` null, como en la pre-validación.
          ultimoPaso: r.codigo === 'almacen_no_disponible' ? null : r.paso,
          // Solo un fallo del paso 3 trae el id (el archivo ya subió): el siguiente intento hace solo el PUT.
          archivoFlit1Id: r.archivoId,
          estado: agotado ? EstadoEnvioFlit2.ERROR : EstadoEnvioFlit2.PENDIENTE,
          proximoIntentoEn: agotado ? null : new Date(ahora.getTime() + espera),
        },
      };
    }
    case 'definitivo':
      return {
        resultado: r.codigo, paso: r.paso, status: r.status,
        cambios: {
          ...base, estado: EstadoEnvioFlit2.ERROR, ultimoResultado: r.codigo.slice(0, 40), ultimoStatus: r.status,
          ultimoPaso: r.paso, archivoFlit1Id: r.archivoId, proximoIntentoEn: null,
        },
      };
    default:
      return null;
  }
}

async function aplicar(fila: FilaEnvioFlit1Tomada, soporteId: string, r: ResultadoEnvioFlit1, ahora: Date): Promise<DesenlaceFilaFlit1> {
  if (r.tipo === 'pausa') {
    // Pausa del paso 3: el archivo ya está en el bucket y no se vuelve a subir. Se guarda su id con el
    // soporte (AC5) sin consumir intento, sin cambiar estado ni `proximo_intento_en`; el sondeo siguiente
    // hace solo el PUT.
    if (r.archivoId) await escribir(fila, { archivoFlit1Id: r.archivoId, soporteId }, ahora);
    await liberarEnvio(fila);
    return { tipo: 'pausa', codigo: r.codigo, hasta: new Date(ahora.getTime() + PAUSA_ENVIO_FLIT1_MS) };
  }
  const c = cambiosPorResultadoFlit1(fila, soporteId, r, ahora)!;
  if (await escribir(fila, c.cambios, ahora)) {
    await auditar(fila.impuestoId, detalle(fila.intentos + 1, c.resultado, c.paso, c.status, soporteId));
  }
  return { tipo: 'escrito', resultado: c.resultado };
}

/** RN-F1-02. Exportada para el test. */
export async function enviarUnaFlit1(fila: FilaEnvioFlit1Tomada, adapter: Flit1AdjuntosPort, ahora: Date): Promise<DesenlaceFilaFlit1> {
  const soporte = await soporteVigente(fila);
  if (!soporte) {
    await escribir(fila, { estado: EstadoEnvioFlit2.SIN_COMPROBANTE, soporteId: null, proximoIntentoEn: null, archivoFlit1Id: null, ultimoPaso: null }, ahora);
    return { tipo: 'escrito', resultado: 'sin_comprobante' };
  }
  const idReal = idRealDeIdFlit(fila.idFlit);
  if (!idReal) return errorLocal(fila, soporte.id, 'id_flit_invalido', ahora);

  const stat = await statEntityDocument(soporte.storageKey);
  if (!stat) return aplicar(fila, soporte.id, { tipo: 'reintentable', paso: 1, codigo: 'almacen_no_disponible', status: null, archivoId: fila.archivoFlit1Id }, ahora);
  if (stat.size <= 0) return errorLocal(fila, soporte.id, 'missing_file', ahora);
  if (stat.size > MAX_BYTES_ADJUNTO) return errorLocal(fila, soporte.id, 'file_too_large', ahora);
  let bytes: Buffer;
  try {
    bytes = await leerBytes(soporte.storageKey, MAX_BYTES_ADJUNTO);
  } catch (e) {
    if (e instanceof EnvioComprobanteError && e.codigo === 'file_too_large') return errorLocal(fila, soporte.id, 'file_too_large', ahora);
    log.warn({ impuestoId: fila.impuestoId, causa: e instanceof Error ? e.name : typeof e }, 'no se pudo leer el comprobante del almacén');
    return aplicar(fila, soporte.id, { tipo: 'reintentable', paso: 1, codigo: 'almacen_no_disponible', status: null, archivoId: fila.archivoFlit1Id }, ahora);
  }
  if (bytes.length === 0) return errorLocal(fila, soporte.id, 'missing_file', ahora);
  const mime = mimeAdjuntoPorBytes(bytes);
  if (!mime) return errorLocal(fila, soporte.id, 'invalid_mime', ahora);

  await registrarLecturaPii('flit1', fila.impuestoId, fila.intentos + 1);
  // AC5 / D-4: el id del paso 1 solo vale si el soporte vigente es el mismo que se subió.
  const archivoIdSubido = fila.archivoFlit1Id && soporte.id === fila.soporteId ? fila.archivoFlit1Id : null;
  const r = await adapter.enviarComprobante(idReal, {
    bytes, contentType: mime, filename: `impuesto-${fila.impuestoId}.${EXTENSION_POR_MIME[mime]}`,
  }, archivoIdSubido);
  return aplicar(fila, soporte.id, r, ahora);
}

// ── RN-F1-01: ciclo ─────────────────────────────────────────────────────────────────────────────

export interface ResumenCicloEnvioFlit1 {
  omitido?: 'apagado' | 'fuente_apagada' | 'pausa';
  sondeo: boolean;
  tomadas: number;
  escritas: number;
  liberadas: number;
  corte?: 'pausa';
}

export interface DepsCicloEnvioFlit1 {
  tomadoPor: string;
  /** Test: puerto inyectado. Sin él se construye el HTTP con las bases del env. */
  adapter?: Flit1AdjuntosPort;
  reloj?: () => Date;
  /** Reloj monotónico del plazo del ciclo (test). */
  ahoraMs?: () => number;
}

export async function procesarCicloEnvioFlit1(deps: DepsCicloEnvioFlit1): Promise<ResumenCicloEnvioFlit1> {
  const reloj = deps.reloj ?? (() => new Date());
  const ahoraMs = deps.ahoraMs ?? (() => Date.now());
  const resumen: ResumenCicloEnvioFlit1 = { sondeo: false, tomadas: 0, escritas: 0, liberadas: 0 };
  // AC7: la variable y las dos bases se exigen SIEMPRE (también con un puerto inyectado).
  const cfg = configFlit1Adjuntos();
  if (!env.FLIT1_ADJUNTOS_ENVIO_HABILITADO || !cfg) return { ...resumen, omitido: 'apagado' };
  if (!(await fuenteHabilitada('flit1'))) return { ...resumen, omitido: 'fuente_apagada' };
  const inicio = reloj();
  const pausa = await leerPausaEnvioFlit1();
  if (pausa && pausa.hasta.getTime() > inicio.getTime()) return { ...resumen, omitido: 'pausa' };
  resumen.sondeo = pausa !== null;

  const filas = await tomarLoteEnviosFlit1({ limite: resumen.sondeo ? 1 : LOTE_ENVIO_FLIT1, tomadoPor: deps.tomadoPor, ahora: inicio });
  resumen.tomadas = filas.length;
  if (filas.length === 0) return resumen;

  const adapter = deps.adapter ?? crearFlit1AdjuntosHttp(cfg);
  const limite = ahoraMs() + PLAZO_CICLO_ENVIO_FLIT1_MS;
  const ciclo: { corte: Extract<DesenlaceFilaFlit1, { tipo: 'pausa' }> | null } = { corte: null };

  await conConcurrencia(filas, CONCURRENCIA_ENVIO_FLIT1, async (fila) => {
    if (ciclo.corte || ahoraMs() > limite) {
      await liberarEnvio(fila);
      resumen.liberadas += 1;
      return;
    }
    const d = await enviarUnaFlit1(fila, adapter, reloj());
    if (d.tipo === 'escrito') resumen.escritas += 1;
    else if (!ciclo.corte) ciclo.corte = d;
  });

  const c = ciclo.corte;
  if (c) {
    resumen.corte = 'pausa';
    await pausarEnvioFlit1(c.codigo, c.hasta, reloj());
    // Sin la URL ni el host: solo el código de configuración.
    log.error({ codigo: c.codigo, hasta: c.hasta.toISOString() }, 'envío a FLIT 1 en pausa global (configuración)');
  }
  if (resumen.sondeo && !c) await quitarPausaEnvioFlit1();
  return resumen;
}
