// Estilos compartidos por las dos pestañas de la parametrización de Siigo (HU 11287 y 11288).
//
// Viven aquí y no duplicados en cada componente porque las dos pestañas son la MISMA pantalla para
// quien la usa: un input que se ve distinto según la pestaña se lee como dos productos.
//
// Rediseño 2026 (Épica 14560): ya no definen piel propia. `inputCls` ES el `.control` del kit
// (`flitInp`) y `CARD` es la tarjeta del kit (borde de línea, radio 9, superficie elevada, sin
// sombra). Se conservan los nombres porque también los importan `components/finanzas/*`.
import { flitInp } from '../flit/flitPageKit';

export const inputCls = flitInp;

export const CARD = {
  borderRadius: '9px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-elevated)',
} as const;

/** Fecha legible, o guion cuando no hay. Compartida por las dos pestañas. */
export function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}
