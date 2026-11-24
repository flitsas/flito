import { useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import KpiCard from '../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista } from '../components/flit/Cargador';
import { Dona, SERIE_KIT } from '../components/flit/Graficos';
import { flitInp } from '../components/flit/flitPageKit';

interface Indicators {
  desde: string; hasta: string;
  accidentes: number; casi_accidentes: number; comparendos: number;
  lesionados: number; fatales: number; dias_perdidos_total: number;
  costo_total: number; km_recorridos: number;
  tasa_accidentalidad: number | null;
  tasa_lesionados: number | null;
  tasa_fatales: number | null;
  severidad: number | null;
  cumplimiento_documental_pct: number | null;
  capacitacion_pct: number | null;
  total_conductores: number;
  top_conductores: { userId: number; name: string; incidentes: number; fatales: number; victimas: number }[];
}

type KpiTone = 'danger' | 'warning' | 'accent' | 'success' | 'info';
type TopConductor = Indicators['top_conductores'][number];

const fmtCurrency = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const dateInput = `${flitInp} h-10 w-auto`;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV' }];

const COLUMNAS_TOP: ColumnaTabla<TopConductor>[] = [
  { key: 'conductor', header: 'Conductor', render: (c) => <Link to={`/pesv/conductores/${c.userId}`} className="flit-focus rounded-sm font-semibold text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-action)] hover:underline">{c.name}</Link> },
  { key: 'accidentes', header: 'Accidentes', render: (c) => <StatusChip tone="danger">{c.incidentes}</StatusChip> },
  { key: 'fatales', header: 'Fatales', render: (c) => <span className="text-[color:var(--color-text-secondary)]">{c.fatales}</span> },
  { key: 'victimas', header: 'Víctimas', render: (c) => <span className="text-[color:var(--color-text-secondary)]">{c.victimas}</span> },
];

export default function PesvDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const default90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [desde, setDesde] = useState(default90);
  const [hasta, setHasta] = useState(today);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/drivers/pesv-indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Tablero PESV" subtitle="Indicadores Res. 40595/2022" icono="flito-pesv" miga={MIGA} />

      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="pesv-dash-desde" className="mb-1.5 block text-[0.8125rem] font-semibold text-[color:var(--color-text-primary)]">Desde</label>
          <input id="pesv-dash-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={dateInput} />
        </div>
        <div>
          <label htmlFor="pesv-dash-hasta" className="mb-1.5 block text-[0.8125rem] font-semibold text-[color:var(--color-text-primary)]">Hasta</label>
          <input id="pesv-dash-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={dateInput} />
        </div>
        <GradientButton type="button" onClick={load}>Actualizar</GradientButton>
      </div>

      <EstadoVista status={data ? 'ready' : 'loading'}>
        {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Accidentes" value={String(data.accidentes)} hint={`${data.fatales} fatales · ${data.lesionados} lesionados`} tone="danger" />
            <Kpi label="Tasa accidentalidad" value={data.tasa_accidentalidad != null ? `${data.tasa_accidentalidad}` : '—'} hint="por millón de km" tone="warning" />
            <Kpi label="Severidad" value={data.severidad != null ? `${data.severidad}` : '—'} hint="días perdidos / accidente" tone="info" />
            <Kpi label="Tasa fatalidad" value={data.tasa_fatales != null ? `${data.tasa_fatales}` : '—'} hint="por millón de km" tone="accent" />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Conductores totales" value={String(data.total_conductores)} hint="activos PESV" tone="success" />
            <Kpi label="Cumplimiento documental" value={data.cumplimiento_documental_pct != null ? `${data.cumplimiento_documental_pct}%` : '—'} hint="docs vigentes >30d" tone={data.cumplimiento_documental_pct != null && data.cumplimiento_documental_pct < 80 ? 'danger' : 'success'} />
            <Kpi label="Capacitación anual" value={data.capacitacion_pct != null ? `${data.capacitacion_pct}%` : '—'} hint="con ≥1 capacitación" tone={data.capacitacion_pct != null && data.capacitacion_pct < 80 ? 'warning' : 'success'} />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Kpi label="Costo total" value={fmtCurrency(data.costo_total)} hint="incidentes en período" tone="danger" />
            <Kpi label="Km recorridos" value={data.km_recorridos.toLocaleString('es-CO')} hint="flota propia" tone="accent" />
            <Kpi label="Días perdidos" value={String(data.dias_perdidos_total)} hint="total accidentes" tone="warning" />
          </div>

          <Section title={`Top conductores con accidentes (${data.top_conductores.length})`}>
            <section className="card p-0">
              <DataTable<TopConductor>
                ariaLabel="Top conductores con accidentes"
                columnas={COLUMNAS_TOP}
                filas={data.top_conductores}
                getKey={(c) => String(c.userId)}
                emptyMessage="Sin accidentes registrados en el período"
              />
            </section>
          </Section>

          <Section title="Otros eventos">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <KpiCard label="Casi-accidentes" value={data.casi_accidentes} pendiente={data.casi_accidentes > 0} />
              <KpiCard label="Comparendos" value={data.comparendos} />
              <div className="card">
                <Dona
                  etiqueta="Otros eventos"
                  partes={[
                    { t: 'Accidentes', v: data.accidentes, c: SERIE_KIT.rojo },
                    { t: 'Casi-accidentes', v: data.casi_accidentes, c: SERIE_KIT.naranja },
                    { t: 'Comparendos', v: data.comparendos, c: SERIE_KIT.azul },
                  ]}
                />
              </div>
            </div>
          </Section>
        </>
        )}
      </EstadoVista>
    </div>
  );
}

// Solo los indicadores que piden atención (tono danger/warning con umbral) van en naranja (`.metrica--pendiente`).
function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: KpiTone }) {
  return <KpiCard label={label} value={value} hint={hint} pendiente={tone === 'danger' || tone === 'warning'} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{title}</h2>{children}</section>;
}
