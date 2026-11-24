import { useEffect, useState, useCallback, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip from '../components/flit/StatusChip';
import GradientButton from '../components/flit/GradientButton';
import KpiCard from '../components/flit/KpiCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador, Vacio } from '../components/flit/Cargador';
import { FlitCard } from '../components/flit/flitPageKit';

interface Indicators {
  desde: string; hasta: string; vehicleId: number | null;
  mtbf_dias_promedio: number | null;
  mttr_horas: number | null;
  costo_total: number;
  costo_por_km: number | null;
  km_recorridos: number;
  disponibilidad_pct: number;
  ots_cerradas: number;
  costo_por_sistema: { sistema: string; monto: number }[];
  ots_reincidentes: { vehicleId: number; plate: string | null; falla: string; ocurrencias: number }[];
  mtbf_por_vehiculo: { vehicleId: number; plate: string | null; mtbfDias: number | null; ots: number }[];
}

type Reincidente = Indicators['ots_reincidentes'][number] & { _i: number };
type MtbfVehiculo = Indicators['mtbf_por_vehiculo'][number];

const fmtCurrency = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });

function defaultRange(): { desde: string; hasta: string } {
  const hasta = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  return { desde, hasta };
}

const ENLACE = 'flit-focus rounded-[4px] font-semibold text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-action)] hover:underline';
const SECUNDARIO = 'text-[color:var(--color-text-secondary)]';

const COLUMNAS_REINCIDENTES: ColumnaTabla<Reincidente>[] = [
  { key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo', render: (r) => <Link to={`/fleet/${r.vehicleId}`} className={ENLACE}>{r.plate || `#${r.vehicleId}`}</Link> },
  { key: 'falla', header: 'Falla', etiqueta: 'Falla', render: (r) => <span className={SECUNDARIO}>{r.falla}</span> },
  { key: 'ocurrencias', header: 'Ocurrencias', etiqueta: 'Ocurrencias', render: (r) => <StatusChip tone="danger">{r.ocurrencias}</StatusChip> },
];

const COLUMNAS_MTBF: ColumnaTabla<MtbfVehiculo>[] = [
  { key: 'vehiculo', header: 'Vehículo', etiqueta: 'Vehículo', render: (m) => <Link to={`/fleet/${m.vehicleId}`} className={ENLACE}>{m.plate || `#${m.vehicleId}`}</Link> },
  { key: 'mtbf', header: 'MTBF', etiqueta: 'MTBF', render: (m) => <span className={`${SECUNDARIO} tabular-nums`}>{m.mtbfDias != null ? `${m.mtbfDias} días` : '—'}</span> },
  { key: 'ots', header: 'OTs correctivas', etiqueta: 'OTs correctivas', render: (m) => <span className={`${SECUNDARIO} tabular-nums`}>{m.ots}</span> },
];

export default function MaintenanceIndicators() {
  const initial = defaultRange();
  const [desde, setDesde] = useState(initial.desde);
  const [hasta, setHasta] = useState(initial.hasta);
  const [data, setData] = useState<Indicators | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Indicators>(`/maintenance/indicators?desde=${desde}&hasta=${hasta}`);
      setData(r);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [desde, hasta]);
  useEffect(() => { load(); }, [load]);

  const maxCostoSist = data ? Math.max(1, ...data.costo_por_sistema.map((s) => s.monto)) : 1;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Indicadores de mantenimiento"
        subtitle="MTBF, MTTR, costo por kilómetro y por sistema, disponibilidad y reincidencias"
        icono="flito-mantenimiento"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }]}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="campo w-full sm:w-44">
          <label htmlFor="mant-indicadores-desde">Desde</label>
          <input id="mant-indicadores-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="control" />
        </div>
        <div className="campo w-full sm:w-44">
          <label htmlFor="mant-indicadores-hasta">Hasta</label>
          <input id="mant-indicadores-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="control" />
        </div>
        <GradientButton type="button" onClick={load}>Actualizar</GradientButton>
      </div>

      {!data ? <Cargador texto="Cargando…" className="py-16" /> : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="MTBF promedio" value={data.mtbf_dias_promedio != null ? `${data.mtbf_dias_promedio} días` : '—'} hint="Tiempo entre fallas correctivas" icono="flito-mantenimiento" />
            <KpiCard label="MTTR" value={data.mttr_horas != null ? `${data.mttr_horas} h` : '—'} hint="Tiempo medio de reparación" />
            <KpiCard label="Disponibilidad" value={`${data.disponibilidad_pct}%`} hint="Tiempo fuera de taller" icono="flito-flota" />
            <KpiCard label="OTs cerradas" value={String(data.ots_cerradas)} hint="En el período" icono="flito-ordenes-trabajo" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <KpiCard label="Costo total" value={fmtCurrency(data.costo_total)} hint="Mano de obra + repuestos + otros" icono="flito-repuestos" />
            <KpiCard label="Km recorridos" value={data.km_recorridos.toLocaleString('es-CO')} hint="MAX − MIN odómetro" />
            <KpiCard label="Costo por km" value={data.costo_por_km != null ? fmtCurrency(data.costo_por_km) : '—'} hint="costo total / km" />
          </div>

          <Section title={`Costo por sistema (${data.costo_por_sistema.length})`}>
            <FlitCard>
              {data.costo_por_sistema.length === 0 ? (
                <Vacio texto="Sin datos en el período" icono="reportes" />
              ) : (
                <ul className="flex flex-col gap-3">
                  {data.costo_por_sistema.map((s) => (
                    <li key={s.sistema}>
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 text-xs">
                        <span className="font-semibold text-[color:var(--color-text-primary)]">{s.sistema}</span>
                        <span className={`mono tabular-nums ${SECUNDARIO}`}>{fmtCurrency(s.monto)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[var(--kit-hover)]" aria-hidden="true">
                        <div className="h-2 rounded-full bg-[var(--kit-azul-relleno)]" style={{ width: `${(s.monto / maxCostoSist) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </FlitCard>
          </Section>

          <Section title={`OTs reincidentes (${data.ots_reincidentes.length})`}>
            <DataTable
              ariaLabel="OTs reincidentes"
              columnas={COLUMNAS_REINCIDENTES}
              filas={data.ots_reincidentes.map((r, i) => ({ ...r, _i: i }))}
              getKey={(r) => String(r._i)}
              emptyMessage="Sin reincidencias en el período"
            />
          </Section>

          <Section title={`MTBF por vehículo (${data.mtbf_por_vehiculo.length})`}>
            <DataTable
              ariaLabel="MTBF por vehículo"
              columnas={COLUMNAS_MTBF}
              filas={data.mtbf_por_vehiculo}
              getKey={(m) => String(m.vehicleId)}
              emptyMessage="Sin datos suficientes (se requieren al menos 2 OTs correctivas por vehículo)"
            />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">{title}</h2>{children}</section>;
}
