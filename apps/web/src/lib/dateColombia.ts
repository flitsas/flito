/** Fecha local Colombia en YYYY-MM-DD (para filtros operativos). */
export function fechaHoyColombia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/** Resta días a una fecha YYYY-MM-DD (calendario local, sin DST edge en UI). */
export function restarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dias);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function etiquetaFecha(fecha: string): string {
  try {
    const [y, m, d] = fecha.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return fecha;
  }
}

export function etiquetaRango(desde: string, hasta: string): string {
  if (desde === hasta) {
    const hoy = fechaHoyColombia();
    return desde === hoy ? 'hoy' : etiquetaFecha(desde);
  }
  return `${etiquetaFecha(desde)} – ${etiquetaFecha(hasta)}`;
}

export interface RangoFechas {
  desde: string;
  hasta: string;
}

/** Normaliza rango: si hasta < desde, intercambia. */
export function normalizarRango(desde: string, hasta: string): RangoFechas {
  if (hasta < desde) return { desde: hasta, hasta: desde };
  return { desde, hasta };
}
