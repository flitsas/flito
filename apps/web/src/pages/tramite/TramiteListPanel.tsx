// TRAM-OPS-02 — listado de trámites con rechazo OT (lista legacy hasta embudo Claude).

import { useState } from 'react';
import { STEPS } from '../../constants/tramite';
import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';
import MotivoRechazoChip from './MotivoRechazoChip';
import RechazarOtModal from './RechazarOtModal';
import { canRechazarOt } from './rechazoOt';
import { etiquetaEtapa } from './tramiteEtapas';
import type { TramiteEmbudoCardData } from './TramiteEmbudoCard';

const ESTADO_CHIP: Record<string, ChipTone> = {
  borrador: 'draft', en_validacion: 'active', aprobado: 'success', rechazado: 'danger',
  enviado_transito: 'active', recibido_transito: 'active', placa_preasignada: 'success',
  placa_asignada: 'success', solicitud_soat: 'success', completado: 'success',
};

interface Props {
  tramites: TramiteEmbudoCardData[];
  loading?: boolean;
  error?: string | null;
  page: number;
  hasMore: boolean;
  total?: number;
  search?: string;
  etapaFiltro?: string;
  rangoLabel?: string;
  onPageChange: (page: number) => void;
  onOpen: (t: TramiteEmbudoCardData) => void;
  onRefresh: () => void;
  onLimpiarFiltros?: () => void;
}

export default function TramiteListPanel({
  tramites, loading, error, page, hasMore, total, search, etapaFiltro, rangoLabel,
  onPageChange, onOpen, onRefresh, onLimpiarFiltros,
}: Props) {
  const [rechazarId, setRechazarId] = useState<TramiteEmbudoCardData | null>(null);

  if (loading && tramites.length === 0) {
    return <p className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando trámites…</p>;
  }

  const hayFiltros = Boolean(search?.trim() || etapaFiltro || rangoLabel);

  if (!loading && tramites.length === 0) {
    return (
      <div className="p-12 text-center" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)' }}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{error ? 'Error al cargar' : 'Sin resultados'}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {error ?? (hayFiltros ? 'Prueba otro VIN, placa o estado' : 'Crea un trámite nuevo para empezar')}
        </p>
        {hayFiltros && onLimpiarFiltros && (
          <button type="button" onClick={onLimpiarFiltros} className="flit-focus mt-3 rounded-[999px] border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>
            Limpiar filtros
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
        {typeof total === 'number' && total > 0
          ? `${total.toLocaleString('es-CO')} trámite${total === 1 ? '' : 's'}${etapaFiltro ? ` en ${etiquetaEtapa(etapaFiltro)}` : ''}${rangoLabel ? ` · ingresos ${rangoLabel}` : ''} · `
          : rangoLabel ? `Ingresos ${rangoLabel} · ` : ''}
        {tramites.length} en esta página · página {page}
        {etapaFiltro || rangoLabel ? ' · orden: última actualización (como embudo)' : ''}
        {search?.trim() ? ' · búsqueda activa' : ''}
      </p>
      <div className="space-y-2">
        {tramites.map((t) => {
          const v = t.vehiculo || {};
          const c = t.comprador || {};
          return (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer bg-white p-4 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
              style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
              onClick={() => onOpen(t)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t); } }}
            >
              <div className="flex items-center gap-4">
                <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 lg:grid-cols-6">
                  <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Placa</p><p className="text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>{t.placa || '—'}</p></div>
                  <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Comprador</p><p className="truncate text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.nombre || '—'}</p></div>
                  <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>VIN</p><p className="font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{t.vin}</p></div>
                  <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Vehiculo</p><p className="truncate text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{[v.marca, v.linea].filter(Boolean).join(' ') || '—'}</p></div>
                  <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Paso</p><p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{t.paso}/5 — {STEPS[t.paso - 1]}</p></div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div>
                      <p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Estado</p>
                      <StatusChip tone={ESTADO_CHIP[t.estado] ?? 'neutral'}>
                        {t.estado === 'enviado_transito' ? 'Enviado a Tránsito' : t.estado === 'en_validacion' ? 'En Validación' : t.estado.charAt(0).toUpperCase() + t.estado.slice(1)}
                      </StatusChip>
                    </div>
                    <MotivoRechazoChip codigo={t.motivoRechazoCodigo} />
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {canRechazarOt(t.estado) && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRechazarId(t); }}
                      className="flit-focus rounded-[999px] border px-3 py-1.5 text-xs font-medium"
                      style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger)' }}
                    >
                      Rechazo OT
                    </button>
                  )}
                  <svg className="h-5 w-5" style={{ color: 'var(--flit-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Paginación de trámites">
        <button
          type="button"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(page - 1)}
          className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
        >
          Anterior
        </button>
        <p className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
          Página {page}
        </p>
        <button
          type="button"
          disabled={!hasMore || loading}
          onClick={() => onPageChange(page + 1)}
          className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
        >
          Siguiente
        </button>
      </nav>

      {rechazarId && (
        <RechazarOtModal
          tramiteId={rechazarId.id}
          vin={rechazarId.vin}
          placa={rechazarId.placa}
          onClose={() => setRechazarId(null)}
          onSuccess={() => onRefresh()}
        />
      )}
    </>
  );
}
