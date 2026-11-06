// FLITO Logística — piezas compartidas de la consola (HU #14353): tipos del detalle, tonos, botón de fila,
// avisos y esqueletos. Salieron de `FlitoLogistica.tsx` para que la página no pase de 800 líneas.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ActaFilaLogistica, EstadoLogisticaSimple, TramiteFilaLogistica } from '@operaciones/shared-types';
import type { ChipTone } from '../../flit/StatusChip';
import { FlitCard, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface EventoDocumento { id: string; tipo: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; lat: string | null; lng: string | null; motivo: string | null; origen: string; creadoEn: string }
export interface TramiteDetalle extends TramiteFilaLogistica { propietarioDocumento?: string | null; combustible: string | null; tieneFoto?: boolean; eventos: EventoDocumento[] }
/** `propietario` no le llega al proveedor en las licencias del acta (H2). */
interface ActaLinea { id: string; placa: string | null; secretaria: string | null; propietario?: string | null; numeroLicencia: string | null; numeroLt: string | null; estado: string; estadoLabel: string; idFlit: string }
interface ActaEvento { id: string; documentoId: string; placa: string | null; tipo: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string }
export interface ActaDetalle { acta: ActaFilaLogistica; tienePdf: boolean; firmaEntrega: boolean; firmaRecibe: boolean; entregaNombre: string | null; documentos: ActaLinea[]; bitacora: ActaEvento[] }

export const TONO_SIMPLE: Record<EstadoLogisticaSimple, ChipTone> = {
  pendiente: 'neutral', registrada: 'active', en_flit: 'active', despachada: 'warning', entregada: 'success', novedad: 'danger',
};
export const TONO_ACTA: Record<string, ChipTone> = { generada: 'neutral', despachada: 'warning', entregada: 'success', devuelta: 'danger' };

export const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const LG = '(min-width: 1024px)';

/** Desde `lg` tabla; por debajo, tarjetas. Se pinta una sola de las dos para no duplicar filas en el DOM. */
export function useDesdeLg(): boolean {
  const [desde, setDesde] = useState(() => typeof window === 'undefined' || window.matchMedia(LG).matches);
  useEffect(() => {
    const m = window.matchMedia(LG);
    const alCambiar = () => setDesde(m.matches);
    alCambiar();
    m.addEventListener('change', alCambiar);
    return () => m.removeEventListener('change', alCambiar);
  }, []);
  return desde;
}

/** Botón de texto de una fila, con el hover y el foco que la tabla no le daba. */
export function BotonFila({ children, peligro, aria, onClick }: { children: ReactNode; peligro?: boolean; aria: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={aria} onClick={onClick}
      className="flit-focus rounded-lg px-2 py-1 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
      style={{ color: peligro ? 'var(--flit-danger-text)' : 'var(--flit-blue-text)' }}>
      {children}
    </button>
  );
}

/** Acción de peligro al pie de una tarjeta móvil: texto, sin borde, 44 px. */
export function BotonTarjetaPeligro({ children, aria, onClick }: { children: ReactNode; aria: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={aria} onClick={onClick}
      className="flit-focus rounded-lg px-3 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
      style={{ color: 'var(--flit-danger-text)', minHeight: 44 }}>
      {children}
    </button>
  );
}

export function TarjetaError({ texto, onReintentar }: { texto: string; onReintentar: () => void }) {
  return (
    <FlitCard>
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>
        <p className="flex-1">{texto}</p>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
      </div>
    </FlitCard>
  );
}

/** Falló un refresco con datos a la vista: lo visible no se borra. */
export function AvisoNoActualizado({ onReintentar }: { onReintentar: () => void }) {
  return (
    <FlitCard>
      <div role="status" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <p className="flex-1">No se pudo actualizar.</p>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
      </div>
    </FlitCard>
  );
}

const BARRA: CSSProperties = { background: 'var(--flit-border-soft)' };

export function BarraEsqueleto({ w }: { w: string }) {
  return <div className={`h-3 rounded ${w}`} style={BARRA} />;
}

/** Tres tarjetas de esqueleto para móvil. */
export function EsqueletoTarjetas() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border p-3" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
          <BarraEsqueleto w="w-1/3" />
          <div className="mt-3"><BarraEsqueleto w="w-2/3" /></div>
          <div className="mt-2"><BarraEsqueleto w="w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}
