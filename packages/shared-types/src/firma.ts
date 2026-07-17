// TRAM-INNOV-B3 — tipos de firma electrónica + check de pre-vuelo (puro/testeable).

export type FirmaEstado = 'pendiente_envio' | 'enviada' | 'firmada' | 'rechazada' | 'cancelada';
export type FirmaRol = 'comprador' | 'vendedor';

export interface FirmaResumen {
  rol: FirmaRol;
  estado: FirmaEstado;
}

/** Subconjunto compatible con el PreflightCheck del API (status idéntico a CheckStatus). */
export interface FirmaPreflightCheck {
  key: 'firma_compraventa';
  label: string;
  status: 'ok' | 'fail' | 'warn' | 'unknown';
  source: string;
  message: string;
}

/**
 * Check de pre-vuelo «firma del contrato de compraventa». Solo aplica a la
 * tipología `traspaso_standard`. Verde si comprador Y vendedor están `firmada`.
 * Devuelve `null` para otras tipologías (el check no aplica → no se muestra).
 */
export function derivaFirmaCompraventaCheck(opts: {
  tipologiaCodigo?: string | null;
  firmas: FirmaResumen[];
}): FirmaPreflightCheck | null {
  if (opts.tipologiaCodigo !== 'traspaso_standard') return null;

  const estadoDe = (rol: FirmaRol): FirmaEstado | null =>
    opts.firmas.find((f) => f.rol === rol)?.estado ?? null;
  const comprador = estadoDe('comprador');
  const vendedor = estadoDe('vendedor');

  const base = {
    key: 'firma_compraventa' as const,
    label: 'Firma del contrato de compraventa',
    source: 'FLIT Firma',
  };

  if (comprador === 'firmada' && vendedor === 'firmada') {
    return { ...base, status: 'ok', message: 'Comprador y vendedor firmaron el contrato de compraventa.' };
  }
  if (comprador === 'rechazada' || vendedor === 'rechazada') {
    return { ...base, status: 'fail', message: 'Una de las partes rechazó la firma del contrato. Reenviar la solicitud.' };
  }
  const faltan: string[] = [];
  if (comprador !== 'firmada') faltan.push('comprador');
  if (vendedor !== 'firmada') faltan.push('vendedor');
  return { ...base, status: 'warn', message: `Falta firma de: ${faltan.join(' y ')}.` };
}
