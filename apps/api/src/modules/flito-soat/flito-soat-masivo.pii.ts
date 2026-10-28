// HU #14131 (Feature #14013, AC9, ADR-0032 §6) — registro de acceso a datos personales de la carga masiva.
//
// UN solo `logPiiAccess` por lote en el alta, con el conteo de filas. El motivo lleva ids opacos, el tipo
// y los conteos: NUNCA una placa, un documento, un nombre, un correo ni un celular (ni siquiera HMAC por
// fila: son hasta 200 y el registro es por lote, no por fila; decisión aceptada en la revisión de la HU #14131:
// un registro por lote, con el conteo de filas y sin datos de fila). Se anota con `await` como el resto del módulo; el
// propio `logPiiAccess` es best-effort y no tumba la operación.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';

export const RECURSO_LOTE_MASIVO = 'flito_soat_masivo_lote';
export const CAMPOS_PII_LOTE_MASIVO = ['placa', 'numero_documento', 'nombre_completo', 'correo', 'celular'] as const;

export async function registrarAltaLoteMasivo(
  req: Request, lote: { id: string; tipo: string; filas: number },
): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_LOTE_MASIVO,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_LOTE_MASIVO],
    motivo: `alta_masivo lote=${lote.id} tipo=${lote.tipo} filas=${lote.filas}`,
  });
}

/** HU #14133 (AC2): UN registro por descarga de rechazadas, con el conteo de filas y sin datos de fila. */
export async function registrarDescargaRechazadasMasivo(req: Request, lote: { id: string; filas: number }): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_LOTE_MASIVO,
    accion: 'export',
    camposAccedidos: [...CAMPOS_PII_LOTE_MASIVO],
    motivo: `descarga_rechazadas lote=${lote.id} filas=${lote.filas}`,
  });
}

// HU #14134: el avance devuelve filas con placa/VIN (cuasi-PII) y se sondea cada ~2,5 s. UN registro por lote y
// usuario (la primera vez que se devuelven filas con placa), no uno por sondeo. La clave vive en memoria acotada
// (FIFO de 500): lo más simple sin columna nueva; tras un reinicio o en otra réplica se registra una vez más, lo
// que sobre-registra pero nunca omite. El motivo lleva solo ids opacos y el conteo: nunca una placa.
const LECTURAS_REGISTRADAS = new Set<string>();
const MAX_LECTURAS_REGISTRADAS = 500;

export async function registrarLecturaFilasMasivo(
  req: Request, lote: { id: string; filas: number }, userId: number,
): Promise<void> {
  const clave = `${userId}:${lote.id}`;
  if (LECTURAS_REGISTRADAS.has(clave)) return;
  if (LECTURAS_REGISTRADAS.size >= MAX_LECTURAS_REGISTRADAS) {
    LECTURAS_REGISTRADAS.delete(LECTURAS_REGISTRADAS.values().next().value as string);
  }
  LECTURAS_REGISTRADAS.add(clave);
  await logPiiAccess(req, {
    resourceTipo: RECURSO_LOTE_MASIVO,
    accion: 'read',
    camposAccedidos: ['placa', 'vin'],
    motivo: `avance_filas lote=${lote.id} filas=${lote.filas}`,
  });
}

/** Solo para pruebas. */
export function reiniciarLecturasRegistradasMasivo(): void { LECTURAS_REGISTRADAS.clear(); }
