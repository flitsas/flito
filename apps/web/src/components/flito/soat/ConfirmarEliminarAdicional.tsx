// FLITO — botón «Eliminar» y su confirmación en línea para un documento adicional (HU #13365).
//
// Spec: docs/ux/flito-soat-documentos-adicionales-detalle-cargar-eliminar.md §5. La confirmación
// reemplaza la fila (patrón de `components/finanzas/FilaServicioAdicional.tsx`): ni `window.confirm`
// ni modal sobre el modal del detalle. Una sola abierta a la vez: el estado vive en la sección.
//
// No hay borrado optimista: la fila solo se va con el 204 (o el 404 «ya no estaba»). Con error la
// confirmación sigue abierta y la lista no cambia (AC6). Candado por `ref` (AC7).
import { useEffect, useId, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { DocumentoAdicionalSoat } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { errorDeEliminacion } from './documentosAdicionales';

const BOTON_ICONO =
  'flit-focus grid h-10 w-10 shrink-0 place-items-center rounded-[999px] border bg-flit-card transition-colors hover:bg-[var(--flit-bg-hover)]';
// Ocupado = `aria-disabled` (no `disabled`) en el botón que confirma: conserva el foco y Esc no se
// escapa a <body> (cerraría el modal del detalle a media eliminación).
const BOTON = `${flitBtnSecondary} w-full justify-center disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:w-auto`;
const PELIGRO = { ...flitBtnSecondaryStyle, color: 'var(--flit-danger-text)', borderColor: 'var(--flit-danger-text)' } as const;

/** La papelera de la fila (va en `accionesExtra`). Tinta neutra: no alarmar en una lista de consulta. */
export function BotonEliminarAdicional({ documento, onAbrir }: { documento: DocumentoAdicionalSoat; onAbrir: () => void }) {
  return (
    <button type="button" data-eliminar={documento.id}
      aria-label={`Eliminar ${documento.etiqueta}`} title={`Eliminar ${documento.etiqueta}`}
      className={BOTON_ICONO} style={{ color: 'var(--flit-text-secondary)', borderColor: 'var(--flit-border-input)' }}
      onClick={onAbrir}>
      <Trash2 size={16} aria-hidden="true" />
    </button>
  );
}

export default function ConfirmarEliminarAdicional({ soatId, documento, onCancelar, onEliminado }: {
  soatId: string;
  documento: DocumentoAdicionalSoat;
  onCancelar: () => void;
  /** `yaNoEstaba` = el servidor respondió 404: la fila se quita igual, con otro toast. */
  onEliminado: (yaNoEstaba: boolean) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<{ texto: string; reintentable: boolean } | null>(null);
  const candado = useRef(false);
  const cancelarRef = useRef<HTMLButtonElement>(null);
  const idPregunta = useId();

  // El foco entra en «Cancelar», no en lo que no tiene vuelta (regla de confirmaciones destructivas).
  useEffect(() => { cancelarRef.current?.focus(); }, []);

  const eliminar = async () => {
    if (candado.current) return;
    candado.current = true;
    setEnviando(true);
    setError(null);
    let fin: boolean | null = null;
    try {
      await api.delete(`/flito/soat/${encodeURIComponent(soatId)}/documentos-adicionales/${encodeURIComponent(documento.id)}`);
      fin = false;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404) fin = true;
      else setError(errorDeEliminacion(status));
    } finally {
      candado.current = false;
      setEnviando(false);
    }
    if (fin !== null) onEliminado(fin);
  };

  const cancelar = () => { if (!candado.current) onCancelar(); };

  return (
    <div role="group" aria-labelledby={idPregunta}
      className="w-full space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }}
      // Esc cancela la confirmación y NO cierra el modal del detalle.
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelar(); } }}>
      <p id={idPregunta} className="break-words text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
        ¿Eliminar «{documento.etiqueta}»?
      </p>
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Se borra de forma definitiva y no se puede recuperar.
      </p>
      {error && (
        <p role="alert" className="break-words text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error.texto}</p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <button ref={cancelarRef} type="button" className={BOTON} style={flitBtnSecondaryStyle} disabled={enviando} onClick={cancelar}>
          Cancelar
        </button>
        {(!error || error.reintentable) && (
          <button type="button" className={BOTON} style={PELIGRO} aria-disabled={enviando || undefined} aria-busy={enviando || undefined}
            onClick={() => { void eliminar(); }}>
            <Trash2 size={16} aria-hidden="true" className="shrink-0" />
            {enviando ? 'Eliminando…' : error ? 'Reintentar' : 'Eliminar'}
          </button>
        )}
      </div>
    </div>
  );
}
