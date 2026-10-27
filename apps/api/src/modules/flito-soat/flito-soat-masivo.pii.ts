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
