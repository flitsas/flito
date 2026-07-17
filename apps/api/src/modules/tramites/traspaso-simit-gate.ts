// TRAM-F3-UX: gate SIMIT comprador en traspaso (server-side, complementa H1 frontend).

export interface SimitCompradorSnapshot {
  documento?: string;
  consultado?: boolean;
  total?: number;
  totalMonto?: number;
  consultadoAt?: string;
}

export function validateTraspasoSimitComprador(
  vehiculo: unknown,
  comprador: unknown,
): { ok: true } | { ok: false; message: string } {
  const veh = (vehiculo || {}) as { _simitComprador?: SimitCompradorSnapshot };
  const comp = (comprador || {}) as { documento?: string };
  const doc = String(comp.documento || '').trim();
  if (!doc) return { ok: false, message: 'Documento del comprador requerido' };

  const simit = veh._simitComprador;
  if (!simit?.consultado) {
    return { ok: false, message: 'Consulta SIMIT del comprador obligatoria antes de continuar' };
  }
  if (String(simit.documento || '').trim() !== doc) {
    return { ok: false, message: 'La consulta SIMIT no corresponde al documento del comprador' };
  }
  if ((simit.total ?? 0) > 0) {
    return { ok: false, message: 'El comprador tiene comparendos SIMIT pendientes' };
  }
  return { ok: true };
}
