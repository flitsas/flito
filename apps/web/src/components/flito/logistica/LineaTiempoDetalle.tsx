// Sección «Línea de tiempo» del detalle de un trámite (HU #14126). Reemplaza la bitácora
// del DetalleModal. Contrato de lectura: docs/diseno/hu-14124-linea-tiempo.md.
// Sin ruta ni PageSlug. El padre no la monta sin `logistica.documento.ver`; un 403 la oculta.

import { useEffect, useState } from 'react';
import {
  ESTADO_DOCUMENTO_LOGISTICA_LABEL,
  ESTADO_LOGISTICA_SIMPLE_LABEL,
  simplificarEstadoLogistica,
  type EstadoDocumentoLogistica,
  type HitoLineaTiempoLogistica,
  type LineaTiempoLogistica,
} from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const MUTED = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const FRANJA = { background: 'color-mix(in srgb, var(--flit-blue) 16%, transparent)' } as const;

const VACIO_SIN_DOCUMENTO = 'Aún no hay recorrido de esta licencia. Lo verá usted aquí cuando el mensajero la recoja en el organismo.';
const VACIO_SIN_HITOS = 'Esta licencia no tiene hitos registrados. Lo verá usted aquí cuando se registre un movimiento.';
const ERROR_CARGA = 'No se pudo cargar el recorrido. Inténtelo de nuevo.';

type Fase = 'cargando' | 'lista' | 'error' | 'prohibido';

function esLinea(v: unknown): v is LineaTiempoLogistica {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as { documentoId?: unknown; hitos?: unknown };
  return (o.documentoId === null || typeof o.documentoId === 'string') && Array.isArray(o.hitos);
}

function etiquetaDocumento(estado: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(ESTADO_DOCUMENTO_LOGISTICA_LABEL, estado)) return null;
  return ESTADO_DOCUMENTO_LOGISTICA_LABEL[estado as EstadoDocumentoLogistica];
}

/** Nunca la clave cruda (`en_acta`, `recogida`). Llegada y anulación ganan al estado. */
function rotuloHito(hito: HitoLineaTiempoLogistica): string {
  if (hito.tipo === 'llegada') return 'Llegada a FLIT';
  if (hito.estadoNuevo === 'anulado' || hito.tipo === 'anulacion') return 'Anulado';
  return etiquetaDocumento(hito.estadoNuevo)
    ?? ESTADO_LOGISTICA_SIMPLE_LABEL[simplificarEstadoLogistica(hito.estadoNuevo)];
}

function textoMotivo(motivo: string | null): string | null {
  const texto = motivo?.trim();
  return texto ? texto : null;
}

function Esqueleto() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando la línea de tiempo.">
      {[0, 1, 2].map((i) => (
        <div key={i} className="mb-3 flex items-start gap-3 last:mb-0" aria-hidden="true">
          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--flit-border-soft)' }} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-2/5 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <span className="h-2 w-1/4 rounded" style={{ background: 'var(--flit-border-soft)' }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Riel({ reciente, unirArriba, ultimo }: { reciente: boolean; unirArriba: boolean; ultimo: boolean }) {
  return (
    <div className="flex w-3 shrink-0 flex-col items-center" aria-hidden="true">
      <span
        className="w-px shrink-0"
        style={{ height: '0.45rem', background: unirArriba ? 'var(--flit-border-soft)' : 'transparent' }}
      />
      <span
        className={reciente
          ? 'h-2.5 w-2.5 shrink-0 rounded-full'
          : 'box-border h-2 w-2 shrink-0 rounded-full border bg-transparent'}
        style={reciente ? { background: 'var(--flit-blue)' } : { borderColor: 'var(--flit-text-muted)' }}
      />
      {!ultimo && <span className="mt-1 w-px min-h-3 flex-1" style={{ background: 'var(--flit-border-soft)' }} />}
    </div>
  );
}

function FilaHito({ hito, reciente, unirArriba, ultimo, fecha }: {
  hito: HitoLineaTiempoLogistica;
  reciente: boolean;
  unirArriba: boolean;
  ultimo: boolean;
  fecha: (iso: string | null) => string;
}) {
  const motivo = textoMotivo(hito.motivo);
  return (
    <li className="flex items-stretch gap-3">
      <Riel reciente={reciente} unirArriba={unirArriba} ultimo={ultimo} />
      <div className={`min-w-0 flex-1 ${ultimo ? '' : 'pb-3'}`}>
        <div className={reciente ? 'rounded-lg px-3 py-2' : undefined} style={reciente ? FRANJA : undefined}>
          {reciente ? (
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 text-sm font-bold">{rotuloHito(hito)}</span>
              <time dateTime={hito.fecha} className="shrink-0 text-xs tabular-nums" style={MUTED}>{fecha(hito.fecha)}</time>
            </div>
          ) : (
            <>
              <p className="text-sm">{rotuloHito(hito)}</p>
              <time dateTime={hito.fecha} className="text-xs tabular-nums" style={MUTED}>{fecha(hito.fecha)}</time>
            </>
          )}
          {motivo && <p className="mt-0.5 text-xs" style={MUTED}>{motivo}</p>}
        </div>
      </div>
    </li>
  );
}

export default function LineaTiempoDetalle({ tramiteId, fecha }: {
  tramiteId: string;
  /** El `fecha()` del modal: `toLocaleString` es-CO, dateStyle y timeStyle short. */
  fecha: (iso: string | null) => string;
}) {
  const [datos, setDatos] = useState<LineaTiempoLogistica | null>(null);
  const [fase, setFase] = useState<Fase>('cargando');
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setFase('cargando');
    setDatos(null);
    api.get<unknown>(`/flito/logistica/tramites/${tramiteId}/linea-tiempo`)
      .then((r) => {
        if (!vivo) return;
        if (!esLinea(r)) { setDatos(null); setFase('error'); return; }
        setDatos(r);
        setFase('lista');
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setDatos(null);
        setFase(e instanceof ApiError && e.status === 403 ? 'prohibido' : 'error');
      });
    return () => { vivo = false; };
  }, [tramiteId, recarga]);

  if (fase === 'prohibido') return null;

  const hitos = datos?.hitos ?? [];

  return (
    <section aria-labelledby="linea-tiempo-detalle-titulo" className="mt-4">
      <h3 id="linea-tiempo-detalle-titulo" className="mb-2 text-xs font-bold uppercase tracking-wide" style={SECUNDARIO}>
        Línea de tiempo
      </h3>

      {fase === 'cargando' && <Esqueleto />}

      {fase === 'error' && (
        <div>
          <p role="alert" className="text-sm" style={PELIGRO}>{ERROR_CARGA}</p>
          <button
            type="button"
            className={`${flitBtnSecondary} mt-2`}
            style={flitBtnSecondaryStyle}
            onClick={() => setRecarga((n) => n + 1)}
          >
            Reintentar
          </button>
        </div>
      )}

      {fase === 'lista' && hitos.length === 0 && (
        <p className="text-sm" style={MUTED}>
          {datos?.documentoId === null ? VACIO_SIN_DOCUMENTO : VACIO_SIN_HITOS}
        </p>
      )}

      {fase === 'lista' && hitos.length > 0 && (
        <ol className="m-0 list-none p-0">
          {hitos.map((hito, i) => (
            <FilaHito
              key={hito.id}
              hito={hito}
              reciente={i === 0}
              unirArriba={i > 0}
              ultimo={i === hitos.length - 1}
              fecha={fecha}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
