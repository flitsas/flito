// FLITO — panel en línea para cargar documentos adicionales desde el detalle del SOAT (HU #13365).
//
// Spec: docs/ux/flito-soat-documentos-adicionales-detalle-cargar-eliminar.md §3.2–§3.6. No es un
// modal: `DetalleSoat` ya lo es y no se apila otro. Reutiliza el selector del alta (#13363) con el
// contexto `'detalle'`: cupos **por carga** (20 archivos, 15 MB c/u, 250 MB), los mismos que el
// servidor aplica a cada envío; el repetido contra lo ya guardado y la factura lo detecta él.
//
// Nada aquí es primario (§2): el detalle ya tiene la primaria del caso. Error = el panel sigue
// abierto con la elección intacta (AC6). Candado por `ref` contra el doble envío (AC7).
import { useEffect, useId, useRef, useState } from 'react';
import { RotateCw, Upload } from 'lucide-react';
import type { ResultadoDocumentosAdicionales } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import DocumentosAdicionalesSelector from './DocumentosAdicionalesSelector';
import {
  TIMEOUT_ALTA_CON_ADICIONALES_MS, adjuntarAdicionales, errorDeCarga, textoGuardandoAdicionales, validos,
  type ElegidoAdicional,
} from './documentosAdicionales';

const BOTON = `${flitBtnSecondary} w-full justify-center disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:w-auto`;

export default function CargarDocumentosAdicionales({ soatId, onCancelar, onCargado }: {
  soatId: string;
  onCancelar: () => void;
  onCargado: (resultado: ResultadoDocumentosAdicionales) => void;
}) {
  const [eleccion, setEleccion] = useState<ElegidoAdicional[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<{ texto: string; reintentable: boolean } | null>(null);
  const candado = useRef(false);
  const raiz = useRef<HTMLDivElement>(null);
  const idTitulo = useId();
  const n = validos(eleccion).length;

  // Al abrir, el foco va a la caja «Elegir archivos» del selector (§3.2).
  useEffect(() => {
    const id = requestAnimationFrame(() => raiz.current?.querySelector<HTMLElement>('input[type="file"]')?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const cambiar = (lista: ElegidoAdicional[]) => { setError(null); setEleccion(lista); };

  const cargar = async () => {
    if (candado.current || n === 0) return;
    candado.current = true;
    setEnviando(true);
    setError(null);
    try {
      const form = new FormData();
      adjuntarAdicionales(form, eleccion);
      const r = await api.postConTimeout<ResultadoDocumentosAdicionales>(
        `/flito/soat/${encodeURIComponent(soatId)}/documentos-adicionales`, form, TIMEOUT_ALTA_CON_ADICIONALES_MS,
      );
      onCargado({ aceptados: r?.aceptados ?? [], descartados: r?.descartados ?? [] });
    } catch (e) {
      setError(errorDeCarga(e instanceof ApiError ? e.status : 0));
    } finally {
      candado.current = false;
      setEnviando(false);
    }
  };

  const cancelar = () => { if (!candado.current) onCancelar(); };

  return (
    <div
      ref={raiz} role="region" aria-labelledby={idTitulo}
      className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }}
      // Esc cancela el panel y NO cierra el modal del detalle (mismo truco que FilaServicioAdicional).
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelar(); } }}
    >
      <p id={idTitulo} className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Cargar documentos adicionales
      </p>

      <DocumentosAdicionalesSelector
        value={eleccion} onChange={cambiar} idBase="det-adic" contexto="detalle" deshabilitado={enviando}
      />

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-48 break-words text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error.texto}</p>
          {error.reintentable && (
            <button type="button" className={BOTON} style={flitBtnSecondaryStyle} disabled={enviando} onClick={() => { void cargar(); }}>
              <RotateCw size={16} aria-hidden="true" className="shrink-0" />
              Reintentar
            </button>
          )}
        </div>
      )}

      {/* En <sm los botones van a ancho completo, con «Cargar {n}» encima de «Cancelar» (§7). */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <button type="button" className={BOTON} style={flitBtnSecondaryStyle} disabled={enviando} onClick={cancelar}>
          Cancelar
        </button>
        <button
          type="button" className={BOTON} style={flitBtnSecondaryStyle}
          // Ocupado = `aria-disabled` y no `disabled`: el botón conserva el foco, así Esc sigue cayendo
          // en el panel (que lo ignora) y no en <body>, donde cerraría el modal a media carga.
          disabled={!enviando && n === 0} aria-disabled={enviando || undefined} aria-busy={enviando || undefined}
          aria-label={enviando ? undefined : n === 1 ? 'Cargar 1 documento' : `Cargar ${n} documentos`}
          onClick={() => { void cargar(); }}
        >
          <Upload size={16} aria-hidden="true" className="shrink-0" />
          {enviando ? 'Cargando…' : `Cargar ${n}`}
        </button>
      </div>

      {enviando && (
        <p role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          {textoGuardandoAdicionales(n)}
        </p>
      )}
    </div>
  );
}
