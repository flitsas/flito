// TRAM-TRASPASO-P1 — helpers compartidos impuesto vehicular (API + web).
// Reglas de plataforma: aplican a TODO traspaso, no a un trámite/organismo puntual.

/** Claves departamento con consulta directa (Caldas API / Antioquia manual). Otras → fallback caldas. */
const DANE_DEPT_TO_CEA: Record<string, string> = {
  '05': 'antioquia',
  '17': 'caldas',
};

export function departamentoKeyFromOrganismoCodigo(codigo: string | null | undefined): string {
  if (!codigo || codigo.length < 2) return 'caldas';
  return DANE_DEPT_TO_CEA[codigo.slice(0, 2)] ?? 'caldas';
}

export interface ImpuestoConsultaDatosLike {
  estadoPago?: string;
  totalPagar?: number;
}

export function impuestoIndicaPazSalvo(datos: ImpuestoConsultaDatosLike): boolean {
  const ep = String(datos.estadoPago ?? '').toLowerCase();
  if (/pagad|al d[ií]a|paz y salvo|sin deuda|cancelad|al dia/.test(ep)) return true;
  if (typeof datos.totalPagar === 'number' && datos.totalPagar <= 0) return true;
  return false;
}
