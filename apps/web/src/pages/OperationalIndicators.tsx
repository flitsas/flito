import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import KpiCard from '../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador } from '../components/flit/Cargador';

interface Indicators {
  desde: string; hasta: string;
  conductores_activos: number;
  inspecciones: { realizadas: number; esperadas: number; dias_laborales: number; pct: number | null; no_aptos: number };
  alcoholimetria: { total: number; positivos: number; positivos_pct: number | null; alerta_umbral: boolean };
  simulacros: { ejecutados_anio: number; meta_anual: number; cumple: boolean };
  top_conductores_no_aptos: { userId: number; name: string; noAptos: number }[];
  top_vehiculos_no_aptos: { vehicleId: number; plate: string | null; noAptos: number }[];
}

type KpiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const ENLACE = 'flit-focus rounded-[4px] font-semibold text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-action)] hover:underline';

const COLUMNAS_CONDUCTORES: ColumnaTabla<Indicators['top_conductores_no_aptos'][number]>[] = [
  { key: 'conductor', header: 'Conductor', etiqueta: 'Conductor', render: (c) => <Link to={`/pesv/conductores/${c.userId}`} className={ENLACE}>{c.name}</Link> },
  { key: 'noAptos', header: 'No-aptos', etiqueta: 'No-aptos', render: (c) => <StatusChip tone="danger">{c.noAptos}</StatusChip> },
];

const COLUMNAS_VEHICULOS: ColumnaTabla<Indicators['top_vehiculos_no_aptos'][number]>[] = [
  { key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo', render: (v) => <Link to={`/fleet/${v.vehicleId}`} className={ENLACE}>{v.plate || `#${v.vehicleId}`}</Link> },
  { key: 'noAptos', header: 'No-aptos', etiqueta: 'No-aptos', render: (v) => <StatusChip tone="danger">{v.noAptos}</StatusChip> },
];

export default function OperationalIndicators() {
  const today = new Date().toISOString().slice(0, 10);
  const default30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [desde, setDesde] = useState(default30);
  const [hasta, setHasta] = useState(today);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/drivers/operational-indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Indicadores operacionales PESV"
        subtitle="Inspecciones preoperacionales, alcoholimetría y simulacros"
        icono="flito-pesv"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="campo w-full sm:w-44">
          <label htmlFor="indicadores-desde">Desde</label>
          <input id="indicadores-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="control" />
        </div>
        <div className="campo w-full sm:w-44">
          <label htmlFor="indicadores-hasta">Hasta</label>
          <input id="indicadores-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="control" />
        </div>
        <GradientButton type="button" onClick={load}>Actualizar</GradientButton>
      </div>

      {!data ? <Cargador texto="Cargando…" className="py-16" /> : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Inspecciones realizadas" value={String(data.inspecciones.realizadas)} hint={`de ${data.inspecciones.esperadas} esperadas`} tone="neutral" />
            <Kpi
              label="% inspecciones"
              value={data.inspecciones.pct != null ? `${data.inspecciones.pct}%` : '—'}
              hint={`${data.inspecciones.dias_laborales} días lab × ${data.conductores_activos} conductores`}
              tone={data.inspecciones.pct != null && data.inspecciones.pct < 80 ? 'danger' : 'success'}
            />
            <Kpi label="No-aptos" value={String(data.inspecciones.no_aptos)} hint="checklists con falla crítica" tone="danger" />
            <Kpi label="Conductores activos" value={String(data.conductores_activos)} hint="con es_conductor=true" tone="info" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Kpi label="Pruebas alcoholimetría" value={String(data.alcoholimetria.total)} hint="en el período" tone="neutral" />
            <Kpi
              label="Positivos"
              value={`${data.alcoholimetria.positivos}`}
              hint={data.alcoholimetria.positivos_pct != null ? `${data.alcoholimetria.positivos_pct}% del total` : 'sin datos'}
              tone={data.alcoholimetria.alerta_umbral ? 'danger' : 'success'}
            />
            <Kpi
              label="Simulacros (año actual)"
              value={`${data.simulacros.ejecutados_anio}/${data.simulacros.meta_anual}`}
              hint={data.simulacros.cumple ? 'meta cumplida' : 'meta pendiente'}
              tone={data.simulacros.cumple ? 'success' : 'warning'}
            />
          </div>

          <Section title={`Top conductores con checklists no-apto (${data.top_conductores_no_aptos.length})`}>
            <DataTable
              ariaLabel="Top conductores con checklists no-apto"
              columnas={COLUMNAS_CONDUCTORES}
              filas={data.top_conductores_no_aptos}
              getKey={(c) => String(c.userId)}
              emptyMessage="Sin checklists no-apto en el período"
            />
          </Section>

          <Section title={`Top vehículos con checklists no-apto (${data.top_vehiculos_no_aptos.length})`}>
            <DataTable
              ariaLabel="Top vehículos con checklists no-apto"
              columnas={COLUMNAS_VEHICULOS}
              filas={data.top_vehiculos_no_aptos}
              getKey={(v) => String(v.vehicleId)}
              emptyMessage="Sin vehículos con checklists no-apto en el período"
            />
          </Section>
        </>
      )}
    </div>
  );
}

/** Los tonos de alerta (falla, meta pendiente) se marcan con la cifra naranja `pendiente` de la métrica del kit. */
function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: KpiTone }) {
  return <KpiCard label={label} value={value} hint={hint} pendiente={tone === 'danger' || tone === 'warning'} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{title}</h2>{children}</section>;
}
