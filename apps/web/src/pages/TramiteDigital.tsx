// TRAM-ARCH-01d — página de trámites digitales (shell delgado).

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import LoteFlota from './tramite/LoteFlota';
import { useTramites } from './tramite/useTramites';
import TramiteListPanel from './tramite/TramiteListPanel';
import TramiteListToolbar from './tramite/TramiteListToolbar';
import TramitesEmbudo from './tramite/TramitesEmbudo';
import { useTramiteWizard } from './tramite/useTramiteWizard';
import TramiteWizardShell from './tramite/TramiteWizardShell';
import TramiteGestorDashboard from './tramite/TramiteGestorDashboard';
import type { TramiteListItem, TramiteFull } from './tramite/wizard/types';
import type { TramiteEmbudoCardData } from './tramite/TramiteEmbudoCard';
import RangoFechaFilter from '../components/flit/RangoFechaFilter';
import { fechaHoyColombia, restarDias, etiquetaRango, type RangoFechas } from '../lib/dateColombia';

function useDebounced(value: string, ms = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Vista = 'lista' | 'embudo' | 'dashboard';

export default function TramiteDigital() {
  const [vistaTramites, setVistaTramites] = useState<Vista>('lista');
  const [showLote, setShowLote] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [etapaFiltro, setEtapaFiltro] = useState('');
  const [modalidadFiltro, setModalidadFiltro] = useState<'' | 'matricula_inicial' | 'traspaso'>('');
  const [rangoFechas, setRangoFechas] = useState<RangoFechas | null>(() => {
    const h = fechaHoyColombia();
    return { desde: restarDias(h, 6), hasta: h };
  });
  const [page, setPage] = useState(1);
  const search = useDebounced(searchInput);
  const rangoLabel = rangoFechas ? etiquetaRango(rangoFechas.desde, rangoFechas.hasta) : null;

  useEffect(() => { setPage(1); }, [search, etapaFiltro, modalidadFiltro, rangoFechas]);

  const [refreshToken, setRefreshToken] = useState(0);
  const { tramites, total, loading, hasMore, error, load } = useTramites<TramiteListItem>({
    enabled: vistaTramites === 'lista',
    search,
    etapa: etapaFiltro,
    modalidadEntrada: modalidadFiltro,
    rango: rangoFechas,
    page,
  });

  // Página vacía tras paginar → volver a la anterior.
  useEffect(() => {
    if (!loading && vistaTramites === 'lista' && tramites.length === 0 && page > 1) {
      setPage((p) => Math.max(1, p - 1));
    }
  }, [loading, tramites.length, page, vistaTramites]);

  const refreshVista = useCallback(() => {
    if (vistaTramites === 'lista') load();
    else setRefreshToken((t) => t + 1);
  }, [load, vistaTramites]);

  const w = useTramiteWizard(refreshVista);
  const navigate = useNavigate();

  // TRAM-TRASPASO-F1.5: el traspaso abre su wizard dedicado (NO el VIN-first de
  // matrícula inicial). El resto sigue en el wizard estándar.
  const abrirTramite = useCallback((t: TramiteEmbudoCardData) => {
    if (t.modalidadEntrada === 'traspaso') { navigate(`/tramite/traspaso?id=${t.id}`); return; }
    w.continuarTramite(t as TramiteFull);
  }, [navigate, w]);

  const irALista = useCallback((opts?: { etapa?: string; search?: string }) => {
    if (opts?.etapa !== undefined) setEtapaFiltro(opts.etapa);
    if (opts?.search !== undefined) setSearchInput(opts.search);
    setPage(1);
    setVistaTramites('lista');
  }, []);

  const onSearchChange = useCallback((v: string) => {
    setSearchInput(v);
    setVistaTramites('lista');
  }, []);

  const onEtapaChange = useCallback((v: string) => {
    setEtapaFiltro(v);
    setPage(1);
    setVistaTramites('lista');
  }, []);

  const filtrosActivos = Boolean(search.trim() || etapaFiltro || modalidadFiltro);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Trámites digitales"
        subtitle={
          rangoFechas
            ? `Matrícula inicial · ingresos ${rangoLabel}`
            : 'Matrícula inicial de vehículos (histórico)'
        }
        actions={(
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowLote(true)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Carga masiva (CSV)</button>
            {/* TRAM-TRASPASO-F1: entrada al trámite de traspaso (placa-first). */}
            <Link to="/tramite/traspaso" className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>Traspaso</Link>
            <GradientButton type="button" onClick={w.abrirNuevo}>Nuevo trámite</GradientButton>
          </div>
        )}
      />

      {showLote && (
        <FlitModal title="Carga masiva de trámites (flota)" onClose={() => setShowLote(false)}>
          <LoteFlota onCreado={() => { setShowLote(false); refreshVista(); }} />
        </FlitModal>
      )}

      {!w.wizardOpen && (
        <div className="flex flex-col gap-4">
          <RangoFechaFilter
            rango={rangoFechas}
            onChange={setRangoFechas}
            loading={vistaTramites === 'lista' && loading}
            descripcion="Lista y embudo muestran trámites registrados en el rango (hora Colombia)."
          />

          {/* 1. Navegación de vista primero */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Vista de trámites">
              {([
                { key: 'lista' as const, label: 'Lista', hint: 'Buscar y paginar' },
                { key: 'embudo' as const, label: 'Embudo', hint: 'Resumen por etapa' },
                { key: 'dashboard' as const, label: 'Dashboard', hint: 'Métricas' },
              ]).map(({ key, label, hint }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={vistaTramites === key}
                  onClick={() => setVistaTramites(key)}
                  className="flit-focus h-9 rounded-[999px] border px-4 text-sm font-medium transition-colors"
                  style={{
                    borderColor: vistaTramites === key ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                    background: vistaTramites === key ? 'var(--flit-blue-soft)' : 'white',
                    color: vistaTramites === key ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
                  }}
                  title={hint}
                >
                  {label}
                </button>
              ))}
            </div>
            {filtrosActivos && vistaTramites !== 'lista' && (
              <button
                type="button"
                onClick={() => setVistaTramites('lista')}
                className="flit-focus text-xs font-semibold underline"
                style={{ color: 'var(--flit-blue)' }}
              >
                Filtros activos — ver en Lista
              </button>
            )}
          </div>

          {/* 2. Contenido acoplado a cada pestaña */}
          {vistaTramites === 'lista' && (
            <div className="flex flex-col gap-3">
              <TramiteListToolbar
                search={searchInput}
                onSearchChange={onSearchChange}
                etapa={etapaFiltro}
                onEtapaChange={onEtapaChange}
                modalidadEntrada={modalidadFiltro}
                onModalidadChange={(v) => { setModalidadFiltro(v); setPage(1); setVistaTramites('lista'); }}
                onRefresh={load}
                loading={loading}
              />
              <TramiteListPanel
                tramites={tramites}
                loading={loading}
                error={error}
                page={page}
                hasMore={hasMore}
                total={total}
                search={search}
                etapaFiltro={etapaFiltro}
                rangoLabel={rangoLabel ?? undefined}
                onPageChange={setPage}
                onOpen={(t) => abrirTramite(t)}
                onRefresh={load}
                onLimpiarFiltros={() => {
                  const h = fechaHoyColombia();
                  setSearchInput('');
                  setEtapaFiltro('');
                  setModalidadFiltro('');
                  setRangoFechas({ desde: restarDias(h, 6), hasta: h });
                  setPage(1);
                }}
              />
            </div>
          )}

          {vistaTramites === 'embudo' && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {([
                  { id: '' as const, label: 'Todos' },
                  { id: 'traspaso' as const, label: 'Traspasos STT' },
                  { id: 'matricula_inicial' as const, label: 'Matrícula inicial' },
                ]).map(({ id, label }) => (
                  <button
                    key={id || 'all'}
                    type="button"
                    onClick={() => setModalidadFiltro(id)}
                    className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
                    style={{
                      borderColor: modalidadFiltro === id ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                      background: modalidadFiltro === id ? 'var(--flit-blue-soft)' : 'white',
                      color: modalidadFiltro === id ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Vista resumen: hasta 50 trámites por columna{rangoLabel ? ` · ingresos ${rangoLabel}` : ''}. Para buscar un VIN o placa, usa la pestaña <strong>Lista</strong>.
              </p>
              <TramitesEmbudo
                refreshToken={refreshToken}
                rango={rangoFechas}
                rangoLabel={rangoLabel ?? undefined}
                modalidadEntrada={modalidadFiltro}
                onOpen={(t) => abrirTramite(t)}
                onVerMasEnLista={(etapa) => irALista({ etapa: etapa ?? '' })}
              />
            </div>
          )}

          {vistaTramites === 'dashboard' && <TramiteGestorDashboard />}
        </div>
      )}

      {w.wizardOpen && <TramiteWizardShell w={w} />}
    </div>
  );
}
