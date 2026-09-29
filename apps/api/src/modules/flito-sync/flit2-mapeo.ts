// FLITO sync — mapeos puros del ítem de FLIT 2 a FLITO (HU #13091, Feature #13059).
// Contrato: `docs/integraciones/flit2-api.md` v3.1 §4. Diseño: `docs/diseno/hu-13091-lectura-incremental-flit2.md` §4-§5.
//
// Estado y familia se comparan EXACTOS: el contrato los entrega en minúscula (estado) y MAYÚSCULA
// (familia). Cualquier otra grafía es un valor desconocido, nunca se adivina.

import { EstadoTramiteFlito, TipoPropiedad } from '@operaciones/shared-types';
import { estadoEnumDesdeFlit } from './flito-sync.service.js';

/**
 * `flit_estado` con la grafía de FLIT 1 (capitalizada, como la guarda el reporte: 'Aprobado',
 * 'Borrador'…). Los cinco comunes pasan después por `estadoEnumDesdeFlit`, la MISMA función de
 * FLIT 1, para que la paridad del estado FLITO no se desalinee.
 */
const TEXTO_FLIT: Record<string, string> = {
  asignado: 'Asignado',
  entregado: 'Entregado',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado',
  anulado: 'Anulado',
  revocado: 'Revocado',
  borrador: 'Borrador',
  preparado: 'Preparado',
  preasignacion: 'Preasignacion',
};

/** Estados que, en un trámite ya guardado, NO mueven su estado FLITO (retroceso, RN-06 del servicio). */
export const ESTADOS_SIN_ESTADO_FLITO = new Set(['borrador', 'preparado', 'preasignacion']);

const MAX_FLIT_ESTADO = 60;

/**
 * Estado de FLIT 2 → `{ estado FLITO, flit_estado }`.
 *
 * - Los cinco comunes: el texto de FLIT 1 y su estado FLITO por `estadoEnumDesdeFlit`.
 * - `revocado` (AC7): estado FLITO `anulado`, `flit_estado = 'Revocado'`.
 * - `borrador` / `preparado` / `preasignacion`: estado FLITO null.
 * - Desconocido (incluida otra grafía): estado FLITO null y `flit_estado` con la primera letra en
 *   mayúscula, recortado a 60. Nunca se descarta el ítem (AC6). `desconocido: true` lo marca.
 */
export function estadoDesdeFlit2(codigo: string | null): {
  estado: EstadoTramiteFlito | null; flitEstado: string; desconocido: boolean;
} {
  const crudo = (codigo ?? '').trim();
  const texto = Object.prototype.hasOwnProperty.call(TEXTO_FLIT, crudo) ? TEXTO_FLIT[crudo] : undefined;
  if (texto) {
    const estado = crudo === 'revocado' ? EstadoTramiteFlito.ANULADO : estadoEnumDesdeFlit(texto);
    return { estado, flitEstado: texto, desconocido: false };
  }
  const flitEstado = crudo ? (crudo.charAt(0).toUpperCase() + crudo.slice(1)).slice(0, MAX_FLIT_ESTADO) : 'Desconocido';
  return { estado: null, flitEstado, desconocido: true };
}

/** Familia del trámite → `tipo_tramite` con la grafía de FLIT 1 (AC9). Otra familia → null. */
export function familiaATipoTramite(familia: string | null): 'Matricula' | 'Traspaso' | 'Otros' | null {
  switch (familia) {
    case 'MATRICULAS': return 'Matricula';
    case 'TRASPASO': return 'Traspaso';
    case 'OTROS': return 'Otros';
    default: return null;
  }
}

/** Tipo de propiedad por el CONTEO de compradores (no es PII). 0 → null: quien llama conserva el existente. */
export function tipoPropiedadPorConteo(n: number): TipoPropiedad | null {
  if (n <= 0) return null;
  return n === 1 ? TipoPropiedad.UNICO_PROPIETARIO : TipoPropiedad.MULTIPLE_PROPIETARIO;
}

/** Claves de un comprador que SÍ se guardan en `flit_raw`. Lista blanca: una clave nueva no entra. */
const COMPRADOR_SIN_PII = ['ordinal', 'porcentajeParticipacion', 'rolActor', 'tipoPersona', 'tipoDocumento'] as const;

/**
 * Copia del ítem para `flit_raw` sin datos personales (AC10): `compradores` se sustituye por la lista
 * blanca de arriba (sin documento, nombre, dirección, ciudad, celular ni correo). El resto del ítem
 * no lleva PII según el contrato (§4, columna PII).
 */
export function rawSinPii(item: Record<string, unknown>): Record<string, unknown> {
  const copia: Record<string, unknown> = { ...item };
  const compradores = Array.isArray(item.compradores) ? item.compradores : [];
  copia.compradores = compradores.map((c) => {
    const origen = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const limpio: Record<string, unknown> = {};
    for (const k of COMPRADOR_SIN_PII) limpio[k] = origen[k] ?? null;
    return limpio;
  });
  return copia;
}
