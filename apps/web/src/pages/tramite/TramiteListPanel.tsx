// TRAM-OPS-02 — listado de trámites con rechazo OT (lista legacy hasta embudo Claude).

import { useState } from 'react';
import { STEPS } from '../../constants/tramite';
import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';
import MotivoRechazoChip from './MotivoRechazoChip';
import { claseBoton } from '../../components/flit/GradientButton';
import { Cargador } from '../../components/flit/Cargador';
import Placa from '../../components/flit/Placa';
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
    return <div className="py-12"><Cargador texto="Cargando trámites…" /></div>;
  }

  const hayFiltros = Boolean(search?.trim() || etapaFiltro || rangoLabel);

  if (!loading && tramites.length === 0) {
    return (
      <div className="p-12 text-center" style={{ borderRadius: '9px', border: '1px dashed var(--color-border-control)', background: 'var(--color-surface-elevated)' }}>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{error ? 'Error al cargar' : 'Sin resultados'}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          {error ?? (hayFiltros ? 'Prueba otro VIN, placa o estado' : 'Crea un trámite nuevo para empezar')}
        </p>
        {hayFiltros && onLimpiarFiltros && (
          <button type="button" onClick={onLimpiarFiltros} className={claseBoton('secondary', 'sm', 'mt-3')} data-variante="secundario">
            Limpiar filtros
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="text-xs tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
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
              className="flit-focus cursor-pointer bg-[var(--color-surface-elevated)] p-4 transition-colors hover:bg-[var(--kit-hover)]"
              style={{ borderRadius: '9px', border: '1px solid var(--color-border)' }}
              onClick={() => onOpen(t)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t); } }}
            >
              <div className="flex items-center gap-4">
                <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 lg:grid-cols-6">
                  <div><p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>Placa</p>{t.placa ? <Placa placa={t.placa} formatear={false} className="mt-0.5" /> : <p className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>—</p>}</div>
                  <div><p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>Comprador</p><p className="truncate text-sm" style={{ color: 'var(--color-text-secondary)' }}>{c.nombre || '—'}</p></div>
                  <div><p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>VIN</p><p className="font-mono text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{t.vin}</p></div>
                  <div><p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>Vehiculo</p><p className="truncate text-sm" style={{ color: 'var(--color-text-secondary)' }}>{[v.marca, v.linea].filter(Boolean).join(' ') || '—'}</p></div>
                  <div><p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>Paso</p><p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{t.paso}/5 — {STEPS[t.paso - 1]}</p></div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div>
                      <p className="text-xs uppercase" style={{ color: 'var(--color-text-tertiary)' }}>Estado</p>
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
                      className={claseBoton('alerta', 'sm')}
                      data-variante="alerta"
                    >
                      Rechazo OT
                    </button>
                  )}
                  <svg className="h-5 w-5" style={{ color: 'var(--color-text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Paginación de trámites">
        <button
          type="button"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(page - 1)}
          className={claseBoton('secondary', 'sm')}
          data-variante="secundario"
        >
          Anterior
        </button>
        <p className="text-xs tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          Página {page}
        </p>
        <button
          type="button"
          disabled={!hasMore || loading}
          onClick={() => onPageChange(page + 1)}
          className={claseBoton('secondary', 'sm')}
          data-variante="secundario"
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
