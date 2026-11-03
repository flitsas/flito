// HU #14114 (Feature C2 #14092, Épica #13758, ADR-0030 §6) — adaptador de precio de traslado.
// Solo habla con `tarifaDe`. Destino cliente → `logistica_cliente`; destino FLIT → `logistica_flit`.
// Un precio `0` configurado es válido (B ya exige confirmación del cero). `null` = sin vigencia.
import { tarifaDe } from '../flito-parametrizacion/flito-tarifas.service.js';

export type DestinoTraslado = 'cliente' | 'flit';

export type PrecioTraslado = { valor: number; vigenciaId: string | null };

const CONCEPTO_POR_DESTINO: Record<DestinoTraslado, 'logistica_cliente' | 'logistica_flit'> = {
  cliente: 'logistica_cliente',
  flit: 'logistica_flit',
};

export function conceptoPrecioDe(destino: DestinoTraslado): 'logistica_cliente' | 'logistica_flit' {
  return CONCEPTO_POR_DESTINO[destino];
}

export async function precioTrasladoDe(
  companiaId: number,
  destino: DestinoTraslado,
  enFecha: Date | null,
): Promise<PrecioTraslado | null> {
  const tarifa = await tarifaDe(companiaId, CONCEPTO_POR_DESTINO[destino], null, enFecha);
  if (tarifa.valor == null) return null;
  return { valor: tarifa.valor, vigenciaId: tarifa.vigenciaId };
}
