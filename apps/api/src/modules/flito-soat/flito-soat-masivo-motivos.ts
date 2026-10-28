// HU #14132 (Feature #14013, ADR-0032) — vocabulario de rechazo de la carga masiva y la DECISIÓN pura que
// traduce un desenlace del RUNT en lo que se hace con la fila. Sin base de datos ni red: se prueba solo.
//
// Los textos nombran el motivo y NUNCA devuelven lo tecleado (ni placa, ni documento, ni nombre).

import { MENSAJE_MOTIVO } from './flito-soat-masivo-parse.js';
import type { DesenlaceRunt } from './flito-soat-cliente-runt.js';

export type MotivoRechazoWorker =
  | 'runt_no_cuadra' | 'runt_sin_registro' | 'runt_sin_vin' | 'soat_vigente' | 'sin_soat_anterior'
  | 'solicitud_existente' | 'no_procesada';

/** Intentos con el RUNT caído antes de aparcar en «Por validar» (1 reintento automático = 2 llamadas). */
export const MAX_INTENTOS_RUNT = 2;
/** Espera del reintento automático tras una caída. */
export const REINTENTO_CAIDA_MS = 30_000;
/** Tope de intentos de la fila (CHECK `intentos BETWEEN 0 AND 3`): fallos transitorios que no son el RUNT. */
export const MAX_INTENTOS_FILA = 3;

const TEXTO_REVISE = 'No hay registro en el RUNT para esa placa y documento: revise la placa y el documento';

export const MENSAJE_MOTIVO_MASIVO: Record<string, string> = {
  ...MENSAJE_MOTIVO,
  runt_no_cuadra: TEXTO_REVISE,
  runt_sin_registro: TEXTO_REVISE,
  runt_sin_vin: 'El RUNT no publica el VIN de este vehículo: escríbanos para revisarlo',
  sin_soat_anterior: 'Este vehículo no registra SOAT anterior: use la plantilla de SOAT inicial',
  solicitud_existente: 'Esta placa ya tiene un SOAT en gestión',
  no_procesada: 'No se pudo procesar a tiempo; vuelva a subir el archivo',
};

/** `2026-12-31` → `31/12/2026`. */
const aDiaMesAnio = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Texto del rechazo. `soat_vigente` dice hasta cuándo está vigente el SOAT (AC5). */
export function textoMotivo(motivo: string, vigenteHasta?: string | null): string {
  if (motivo === 'soat_vigente') {
    return vigenteHasta
      ? `Este vehículo tiene un SOAT vigente hasta el ${aDiaMesAnio(vigenteHasta)}: solo se renueva dentro de los 30 días previos al vencimiento`
      : 'Este vehículo tiene un SOAT vigente: solo se renueva dentro de los 30 días previos al vencimiento';
  }
  return MENSAJE_MOTIVO_MASIVO[motivo] ?? 'No se pudo procesar la fila';
}

export type Accion =
  | { tipo: 'crear' }
  | { tipo: 'rechazar'; motivo: MotivoRechazoWorker; vigenteHasta?: string | null }
  /** Caído la 1.ª vez: vuelve a `pendiente` con espera; gasta un intento. */
  | { tipo: 'reintentar'; intentos: number; enMs: number; causa: string }
  /** Caído la 2.ª vez: «Por validar» (`runt_sin_respuesta`). */
  | { tipo: 'aparcar'; intentos: number; causa: string }
  /** 429 de la pasarela: vuelve a `pendiente` SIN gastar intento y el proceso entra en pausa (backoff). */
  | { tipo: 'limite' };

const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Función pura: desenlace del RUNT + intentos ya gastados → qué hacer con la fila. */
export function decidir(d: DesenlaceRunt, intentosPrevios: number): Accion {
  switch (d.clase) {
    case 'ok':
    case 'renovacion_anticipada':
      return { tipo: 'crear' };
    case 'revise':
      return { tipo: 'rechazar', motivo: d.codigo };
    case 'sin_soat_anterior':
      return { tipo: 'rechazar', motivo: 'sin_soat_anterior' };
    case 'vigente':
      return { tipo: 'rechazar', motivo: 'soat_vigente', vigenteHasta: d.fechaVencimiento && ISO_DIA.test(d.fechaVencimiento) ? d.fechaVencimiento : null };
    case 'caido': {
      if (d.httpStatus === 429) return { tipo: 'limite' };
      const intentos = intentosPrevios + 1;
      const causa = d.causa ?? 'otro';
      return intentos >= MAX_INTENTOS_RUNT
        ? { tipo: 'aparcar', intentos, causa }
        : { tipo: 'reintentar', intentos, enMs: REINTENTO_CAIDA_MS, causa };
    }
  }
}

/** Pausa tras un 429: 5 s, duplica hasta 60 s. */
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
export const siguienteBackoff = (actualMs: number): number =>
  actualMs <= 0 ? BACKOFF_MIN_MS : Math.min(actualMs * 2, BACKOFF_MAX_MS);
