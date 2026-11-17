// Dashboard estadístico de siniestros — PESV Paso 21 + indicadores Res. 40595 anexo.
// Fuente: GET /api/drivers/incidents/stats con agregados precomputados en backend.
// Capa visual FLIT (Fase 6E1). Labels/títulos del gate pesv-stats-siniestros conservados.

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador } from '../components/flit/Cargador';
import { BarrasGrupo, Dona, SERIE_KIT } from '../components/flit/Graficos';

interface Stats {
  periodo: { from: string; to: string };
  totales: {
    total: number; accidentes: number; casi: number; comparendos: number;
    fatales: number; graves: number; leves: number;
    victimas_total: number; dias_perdidos_total: number; costos_total: string;
    investigaciones: number; investigaciones_cerradas: number;
  };
  mensual: Array<{ mes: string; total: number; accidentes: number; graves_fatales: number; victimas: number }>;
  porCausa: Array<{ metodo: string; c: number }>;
  topConductores: Array<{ conductor_id: number; name: string | null; c: number; victimas: number }>;
  indicadoresPesv: { hht: number; frecuencia: number; severidad: number; indiceGravedad: number; formula: string };
}

const PALETA_CAUSAS = [SERIE_KIT.azul, SERIE_KIT.turquesa, SERIE_KIT.amarillo, SERIE_KIT.verde, SERIE_KIT.naranja, SERIE_KIT.gris];
const TARJETA = 'rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-5';
const TITULO = 'mb-4 text-sm font-semibold text-[color:var(--color-text-primary)]';

export default function RoadIncidentsStats() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const r = await api.get<Stats>('/drivers/incidents/stats' + (params.toString() ? '?' + params.toString() : ''));
      setData(r);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [from, to]);

  if (loading) return <Cargador texto="Cargando estadísticas..." className="py-16" />;
  if (!data) return null;

  const t = data.totales;
  const maxConductor = Math.max(1, ...data.topConductores.map((c) => c.c));
  const cierreInvestigacion = t.investigaciones > 0 ? (t.investigaciones_cerradas / t.investigaciones) * 100 : 0;
  const tonoCobertura = cierreInvestigacion >= 80 ? 'bg-[var(--kit-verde)]' : cierreInvestigacion >= 50 ? 'bg-[var(--kit-naranja)]' : 'bg-[var(--kit-rojo)]';

  const columnasTop: ColumnaTabla<Stats['topConductores'][number]>[] = [
    { key: 'conductor', header: 'Conductor', render: (c) => <span className="text-xs text-[color:var(--color-text-primary)]">{c.name ?? `#${c.conductor_id}`}</span> },
    { key: 'incidentes', header: 'Incidentes', align: 'right', render: (c) => <span className="text-xs font-semibold tabular-nums text-[color:var(--color-text-secondary)]">{c.c}</span> },
    { key: 'victimas', header: 'Víctimas', align: 'right', render: (c) => <span className="text-xs tabular-nums text-[color:var(--color-text-secondary)]">{c.victimas}</span> },
    {
      key: 'distribucion', header: 'Distribución', className: 'w-1/2',
      render: (c) => (
        <div className="h-2 min-w-[6rem] overflow-hidden rounded-[999px] bg-[var(--kit-hover)]">
          <div className="h-full rounded-[999px] bg-[var(--kit-rojo)]" style={{ width: `${(c.c / maxConductor) * 100}%` }} />
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Estadística de siniestros viales"
        subtitle="PESV Paso 21 · Res. 40595/2022 · indicadores frecuencia + severidad + gravedad"
        icono="flito-incidentes"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }, { etiqueta: 'Incidentes viales', to: '/pesv/incidentes' }]}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="campo w-full sm:w-44">
          <label htmlFor="siniestros-desde">Desde</label>
          <input id="siniestros-desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="control" />
        </div>
        <div className="campo w-full sm:w-44">
          <label htmlFor="siniestros-hasta">Hasta</label>
          <input id="siniestros-hasta" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="control" />
        </div>
        <span className="pb-3 text-xs text-[color:var(--color-text-tertiary)]">Periodo actual: {data.periodo.from} → {data.periodo.to}</span>
      </div>

      {/* KPIs principales */}
      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total" value={t.total.toLocaleString('es-CO')} />
        <KpiCard label="Accidentes" value={t.accidentes.toLocaleString('es-CO')} pendiente={t.accidentes > 0} />
        <KpiCard label="Casi accidentes" value={t.casi.toLocaleString('es-CO')} />
        <KpiCard label="Comparendos" value={t.comparendos.toLocaleString('es-CO')} />
        <KpiCard label="Fatales" value={t.fatales.toLocaleString('es-CO')} pendiente={t.fatales > 0} />
        <KpiCard label="Víctimas" value={t.victimas_total.toLocaleString('es-CO')} pendiente={t.victimas_total > 0} />
      </div>

      {/* Indicadores PESV anexo Res. 40595 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="HHT (horas-hombre trabajadas)" value={data.indicadoresPesv.hht.toFixed(2)} hint="suma horas conducción cerradas" />
        <KpiCard label="Índice frecuencia" value={data.indicadoresPesv.frecuencia.toFixed(2)} hint="(accidentes × 200K) / HHT" />
        <KpiCard label="Índice severidad" value={data.indicadoresPesv.severidad.toFixed(2)} hint="(días perdidos × 200K) / HHT" />
        <KpiCard label="Índice gravedad" value={data.indicadoresPesv.indiceGravedad.toFixed(2)} hint="frecuencia × severidad / 1000" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Serie mensual */}
        <section className={TARJETA}>
          <h3 className={TITULO}>Incidentes por mes (12 meses)</h3>
          {data.mensual.length === 0 ? <p className="grafico-vacio">Sin datos en el periodo</p> : (
            <>
              <BarrasGrupo
                titulo="Incidentes por mes (12 meses)"
                etiquetas={data.mensual.map((m) => m.mes)}
                series={[
                  { t: 'Accidentes', c: SERIE_KIT.rojo, v: data.mensual.map((m) => m.accidentes) },
                  { t: 'Casi/comparendos', c: SERIE_KIT.naranja, v: data.mensual.map((m) => m.total - m.accidentes) },
                ]}
              />
              <ul className="mt-3 space-y-1 text-xs">
                {data.mensual.map((m) => (
                  <li key={m.mes} className="flex flex-wrap justify-between gap-x-3 border-t border-[color:var(--color-border)] pt-1 first:border-t-0">
                    <span className="mono text-[color:var(--color-text-secondary)]">{m.mes}</span>
                    <span className="text-[color:var(--color-text-tertiary)]">{m.total} total · {m.graves_fatales} graves · {m.victimas} víctimas</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Por causa raíz */}
        <section className={TARJETA}>
          <h3 className={TITULO}>Por metodología de investigación</h3>
          <Dona
            etiqueta="Por metodología de investigación"
            pie="investigaciones"
            vacio="Sin investigaciones registradas en el periodo"
            partes={data.porCausa.map((c, i) => ({ t: c.metodo.replace(/_/g, ' '), v: c.c, c: PALETA_CAUSAS[i % PALETA_CAUSAS.length] }))}
          />
          <div className="mt-4 border-t border-[color:var(--color-border)] pt-3">
            <p className="text-xs text-[color:var(--color-text-secondary)]">Cobertura investigación causa raíz</p>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-3 flex-1 overflow-hidden rounded-[999px] bg-[var(--kit-hover)]">
                <div className={`h-full rounded-[999px] ${tonoCobertura}`} style={{ width: `${cierreInvestigacion}%` }} />
              </div>
              <span className="text-xs font-semibold tabular-nums text-[color:var(--color-text-primary)]">{cierreInvestigacion.toFixed(0)}%</span>
            </div>
            <p className="mt-1 text-[11px] text-[color:var(--color-text-tertiary)]">{t.investigaciones_cerradas} cerradas / {t.investigaciones} con investigación / {t.total} total</p>
          </div>
        </section>

        {/* Top conductores */}
        <section className={`${TARJETA} lg:col-span-2`}>
          <h3 className={TITULO}>Top 10 conductores con más incidentes</h3>
          <DataTable
            ariaLabel="Top 10 conductores con más incidentes"
            columnas={columnasTop}
            filas={data.topConductores}
            getKey={(c) => String(c.conductor_id)}
            emptyMessage="Sin datos"
          />
        </section>
      </div>

      <p className="text-[11px] text-[color:var(--color-text-tertiary)]">Fórmula: {data.indicadoresPesv.formula}</p>
    </div>
  );
}
