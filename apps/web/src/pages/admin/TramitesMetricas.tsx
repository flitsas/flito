// TRAMITES-ABCD · Sprint A — panel admin de KPIs del epic TRAM-INNOV.
// Patrón RumSummary.tsx: guard admin, selector de ventana, tarjetas KPI + tablas FLIT.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import NoAccess from '../../components/NoAccess';
import { useAuth } from '../../lib/auth';
import PageHeaderCard from '../../components/flit/PageHeaderCard';
import KpiCard from '../../components/flit/KpiCard';
import InlineAlert from '../../components/flit/InlineAlert';
import GradientButton from '../../components/flit/GradientButton';
import { Dona, SERIE_KIT } from '../../components/flit/Graficos';
import { FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr } from '../../components/flit/flitPageKit';

interface MetricsResponse {
  ok: boolean;
  windowDays: number;
  preflight: { overall_status: string; n: number }[];
  tiempoTransito: { horas_mediana: number | null; n: number };
  rechazosOt: { rechazos: number; enviados: number };
  rechazosPorMotivo: { codigo: string; n: number }[];
  tipologias: { tipologia: string; n: number }[];
  notificaciones: { canal: string; n: number }[];
  portal: { rol: string; invitados: number; con_consentimiento: number }[];
  lotes: { lotes: number; filas: number; tramites_creados: number };
}

const DAY_OPTIONS = [7, 30, 90] as const;

const PREFLIGHT_LABEL: Record<string, string> = { green: 'Verde', yellow: 'Amarillo', red: 'Rojo' };

function MiniTable({ title, head, rows, empty }: { title: string; head: string[]; rows: (string | number)[][]; empty: string }) {
  return (
    <section className="card">
      <p className="mb-3 text-base font-semibold text-[color:var(--color-text-primary)]">{title}</p>
      <FlitTable label={title}>
        <thead>
          <tr>{head.map((h) => <FlitTh key={h}>{h}</FlitTh>)}</tr>
        </thead>
        <tbody className="text-sm">
          {rows.length === 0 ? (
            <tr><td colSpan={head.length} className="px-4 py-6 text-center text-[color:var(--color-text-tertiary)]">{empty}</td></tr>
          ) : rows.map((r, i) => (
            <FlitTr key={i}>
              {r.map((c, j) => <td key={j} className={`px-4 py-2.5 tabular-nums ${j === 0 ? 'text-[color:var(--color-text-primary)]' : 'text-[color:var(--color-text-secondary)]'}`}>{c}</td>)}
            </FlitTr>
          ))}
        </tbody>
      </FlitTable>
    </section>
  );
}

const PREFLIGHT_SERIE: Record<string, string> = { green: SERIE_KIT.verde, yellow: SERIE_KIT.amarillo, red: SERIE_KIT.rojo };

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

export default function TramitesMetricas() {
  const { hasFuncion } = useAuth();
  // HU #12872: la función de la guarda del endpoint, no el nombre del rol.
  const puedeVer = hasFuncion('tramite.metricas.ver_resumen');
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<MetricsResponse>(`/tramites/metrics/summary?days=${days}`);
      setData(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el resumen de métricas');
      setData(null);
    } finally { setLoading(false); }
  }, [days]);

  useEffect(() => { if (!puedeVer) return; load(); }, [puedeVer, load]);

  if (!puedeVer) return <NoAccess label="Métricas de trámites" />;

  const preflightTotal = data?.preflight.reduce((s, p) => s + p.n, 0) ?? 0;
  const preflightVerde = data?.preflight.find((p) => p.overall_status === 'green')?.n ?? 0;
  const rechazos = data?.rechazosOt.rechazos ?? 0;
  const enviados = data?.rechazosOt.enviados ?? 0;

  const esqueleto = <span className="kit-esqueleto inline-block h-6 w-16 align-middle" aria-hidden="true" />;

  return (
    <div className="flex flex-col">
      <PageHeaderCard
        title="Métricas de trámites"
        subtitle={`KPIs del epic TRAM-INNOV · ventana ${days} días`}
        icono="flito-tramites"
        miga={[{ etiqueta: 'Administración' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FlitPillGroup>
              {DAY_OPTIONS.map((d) => (
                <FlitPillButton key={d} active={days === d} onClick={() => setDays(d)}>
                  {d} días
                </FlitPillButton>
              ))}
            </FlitPillGroup>
            <GradientButton variant="secondary" onClick={() => load()} disabled={loading}>
              {loading ? 'Cargando…' : 'Actualizar'}
            </GradientButton>
          </div>
        }
      />

      {error && (
        <div className="espacio-abajo"><InlineAlert tono="danger">{error}</InlineAlert></div>
      )}

      {/* KPIs */}
      <div className="metricas" aria-busy={loading}>
        <KpiCard label="Pre-vuelo en verde" value={loading ? esqueleto : pct(preflightVerde, preflightTotal)} hint={`${preflightVerde}/${preflightTotal} pre-vuelos`} icono="flito-checklists" />
        <KpiCard label="Mediana wizard → tránsito" value={loading ? esqueleto : data?.tiempoTransito.horas_mediana != null ? `${data.tiempoTransito.horas_mediana} h` : '—'} hint={`${data?.tiempoTransito.n ?? 0} enviados`} icono="flito-jornadas" />
        <KpiCard label="Rechazo OT" value={loading ? esqueleto : pct(rechazos, enviados)} hint={`${rechazos} de ${enviados} enviados`} icono="flito-incidentes" pendiente={rechazos > 0} />
        <KpiCard label="Trámites en lote" value={loading ? esqueleto : String(data?.lotes.tramites_creados ?? 0)} hint={`${data?.lotes.lotes ?? 0} lote(s) · ${data?.lotes.filas ?? 0} filas`} icono="flito-bolsas" />
      </div>

      {/* Tablas */}
      <div className="rejilla rejilla--2 espacio-abajo">
        <MiniTable
          title="Pre-vuelo por resultado"
          head={['Estado', 'Trámites']}
          rows={(data?.preflight ?? []).map((p) => [PREFLIGHT_LABEL[p.overall_status] ?? p.overall_status, p.n])}
          empty="Sin pre-vuelos en la ventana"
        />
        <MiniTable
          title="Rechazos OT por motivo"
          head={['Motivo', 'Casos']}
          rows={(data?.rechazosPorMotivo ?? []).map((m) => [m.codigo, m.n])}
          empty="Sin rechazos tipificados en la ventana"
        />
        <MiniTable
          title="Adopción por tipología"
          head={['Tipología', 'Trámites']}
          rows={(data?.tipologias ?? []).map((t) => [t.tipologia, t.n])}
          empty="Sin trámites en la ventana"
        />
        <MiniTable
          title="Notificaciones por canal"
          head={['Canal', 'Enviadas']}
          rows={(data?.notificaciones ?? []).map((n) => [n.canal, n.n])}
          empty="Sin notificaciones en la ventana"
        />
        <MiniTable
          title="Portal externo (Ley 1581)"
          head={['Rol', 'Invitados', 'Consentimiento', '%']}
          rows={(data?.portal ?? []).map((p) => [p.rol, p.invitados, p.con_consentimiento, pct(p.con_consentimiento, p.invitados)])}
          empty="Sin participantes en la ventana"
        />
      </div>

      {/* Semáforo pre-vuelo (dona del kit) */}
      {(data?.preflight.length ?? 0) > 0 && (
        <section className="card espacio-abajo">
          <p className="mb-3 text-base font-semibold text-[color:var(--color-text-primary)]">Distribución pre-vuelo:</p>
          <Dona
            etiqueta="Distribución pre-vuelo"
            partes={data!.preflight.map((p) => ({ t: PREFLIGHT_LABEL[p.overall_status] ?? p.overall_status, v: p.n, c: PREFLIGHT_SERIE[p.overall_status] ?? SERIE_KIT.gris }))}
          />
        </section>
      )}

      <p className="text-xs text-[color:var(--color-text-tertiary)]">
        Solo agregados — sin datos personales. Fuente: tablas del epic TRAM-INNOV (§11). Baseline al merge de A1, remedir a 30/60 días.
      </p>
    </div>
  );
}
