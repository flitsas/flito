// Estilos compartidos por las dos pestañas de la parametrización de Siigo (HU #11287 y #11288).
//
// Viven aquí y no duplicados en cada componente porque las dos pestañas son la MISMA pantalla para
// quien la usa: un input que se ve distinto según la pestaña se lee como dos productos.

export const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] '
  + 'bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] '
  + 'placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export const CARD = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-border-soft)',
  boxShadow: 'var(--flit-shadow-card)',
} as const;

/** Fecha legible, o guion cuando no hay. Compartida por las dos pestañas. */
export function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}
