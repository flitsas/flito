// FLITO — resolución de la bolsa de COMPAÑÍA que paga un concepto (HU #13902, Feature #13886, ADR-0029).
//
// Regla 3 del gancho de descuento: `flito_tramites.compania_id` → la bolsa con `alcance='compania'`,
// `activa`, cuyo `_conceptos` contiene el concepto. La bolsa sale BLOQUEADA (`FOR UPDATE`): quien llama
// ya tiene el comprobante y el trámite bloqueados, así que el orden de locks es
// comprobante → trámite → bolsa compañía (→ bolsa tránsito, HU-H). Ver RN-A4 de `flito-bolsas.libro.ts`.
//
// No lanza por negocio: sin bolsa, inactiva o concepto sin marcar devuelve el motivo de omisión (D10, sin alerta).
import { and, eq } from 'drizzle-orm';
import type { MotivoOmisionDescuento } from '@operaciones/shared-types';
import { flitoBolsasUnicasConceptos } from '../../db/schema.js';
import { bolsaCompaniaBloqueada, type BolsaEnLibro, type Tx } from './flito-bolsas.libro.js';

export type ResolucionBolsa =
  | { bolsa: BolsaEnLibro; motivo?: undefined }
  | { bolsa?: undefined; motivo: Extract<MotivoOmisionDescuento, 'sin_bolsa' | 'inactiva' | 'concepto_no_cubierto'> };

/** La bolsa de la compañía que cubre `concepto`, bloqueada; o por qué no hay ninguna. */
export async function bolsaCompaniaPara(tx: Tx, companiaId: number, concepto: string): Promise<ResolucionBolsa> {
  const bolsa = await bolsaCompaniaBloqueada(tx, companiaId);
  if (!bolsa) return { motivo: 'sin_bolsa' };
  if (!bolsa.activa) return { motivo: 'inactiva' };
  const [marcado] = await tx.select({ concepto: flitoBolsasUnicasConceptos.concepto })
    .from(flitoBolsasUnicasConceptos)
    .where(and(eq(flitoBolsasUnicasConceptos.bolsaId, bolsa.id), eq(flitoBolsasUnicasConceptos.concepto, concepto)))
    .limit(1);
  return marcado ? { bolsa } : { motivo: 'concepto_no_cubierto' };
}
