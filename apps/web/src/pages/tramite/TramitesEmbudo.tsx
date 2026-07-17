// TRAM-OPS-01/02 — vista embudo kanban (consume GET /api/tramites/embudo).

import { useEffect, useState } from 'react';
import { useEmbudo } from './useEmbudo';
import TramiteEmbudoCard from './TramiteEmbudoCard';
import RechazarOtModal from './RechazarOtModal';
import type { RangoFechas } from '../../lib/dateColombia';
import type { TramiteEmbudoCardData } from './TramiteEmbudoCard';

interface Props {
  onOpen: (t: TramiteEmbudoCardData) => void;
  /** Id de etapa del embudo (mismo que filtro Lista). */
  onVerMasEnLista?: (etapaId?: string) => void;
  /** Incrementar tras cerrar wizard para recargar columnas. */
  refreshToken?: number;
  rango?: RangoFechas | null;
  rangoLabel?: string;
  modalidadEntrada?: '' | 'matricula_inicial' | 'traspaso';
}

export default function TramitesEmbudo({ onOpen, onVerMasEnLista, refreshToken = 0, rango = null, rangoLabel, modalidadEntrada = '' }: Props) {
  const { columnas, loading, error, load } = useEmbudo(50, rango, modalidadEntrada);
  const [rechazar, setRechazar] = useState<TramiteEmbudoCardData | null>(null);

  useEffect(() => { load(); }, [load, refreshToken]);

  if (loading && columnas.length === 0) {
    return <p className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando embudo…</p>;
  }

  if (error) {
    return (
      <div className="rounded-xl border px-4 py-6 text-center text-sm" style={{ borderColor: 'var(--flit-warning)', color: 'var(--flit-text-secondary)' }}>
        {error}
        <button type="button" onClick={() => load()} className="flit-focus ml-2 underline">Reintentar</button>
      </div>
    );
  }

  return (
    <>
      {rangoLabel && (
        <p className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
          Embudo filtrado por ingresos: {rangoLabel}
        </p>
      )}
      <div className="flex gap-4 overflow-x-auto pb-2">
        {columnas.map((col) => (
          <section
            key={col.id}
            className="flex w-[min(280px,85vw)] shrink-0 flex-col gap-3"
            aria-label={col.label}
          >
            <header className="flex items-center justify-between px-1">
              <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{col.label}</h3>
              <span className="rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums" style={{ background: 'var(--flit-blue-soft)', color: 'var(--flit-blue)' }}>{col.count}</span>
            </header>
            <div className="flex max-h-[min(70vh,640px)] min-h-[120px] flex-col gap-2 overflow-y-auto pr-1">
              {col.tramites.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin trámites</p>
              ) : col.tramites.map((t) => (
                <TramiteEmbudoCard
                  key={t.id}
                  tramite={t}
                  compact
                  onOpen={() => onOpen(t)}
                  onRechazar={() => setRechazar(t)}
                />
              ))}
            </div>
            {col.count > col.tramites.length && onVerMasEnLista && (
              <button
                type="button"
                onClick={() => onVerMasEnLista(col.id)}
                className="flit-focus w-full rounded-[10px] border px-2 py-2 text-center text-[11px] font-semibold"
                style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-blue)' }}
              >
                Ver los {col.count.toLocaleString('es-CO')} en lista
                <span className="block font-normal" style={{ color: 'var(--flit-text-muted)' }}>
                  Mostrando {col.tramites.length} recientes
                </span>
              </button>
            )}
          </section>
        ))}
      </div>

      {rechazar && (
        <RechazarOtModal
          tramiteId={rechazar.id}
          vin={rechazar.vin}
          placa={rechazar.placa}
          onClose={() => setRechazar(null)}
          onSuccess={() => load()}
        />
      )}
    </>
  );
}
