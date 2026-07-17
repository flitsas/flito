import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

interface Resumen {
  rango: { desde: string; hasta: string };
  manifiestos: {
    borradores: string; listos: string; radicados: string;
    aceptados: string; rechazados: string; cumplidos: string;
    anulados: string; total: string;
  };
  remesas: {
    borradores: string; activas_sin_manifiesto: string;
    cumplidas: string; anuladas: string; total: string;
  };
  revenue: {
    revenue_total: string; revenue_facturable: string; anticipos: string;
  };
}

type KpiTone = 'accent' | 'success' | 'warning';

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

function fmtCop(n: number | string | null | undefined): string {
  if (n == null) return '$ 0';
  const v = typeof n === 'string' ? Number(n) : n;
  return '$ ' + v.toLocaleString('es-CO');
}

export default function RndcDashboard() {
  const [data, setData] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<Resumen>('/rndc/indicadores/resumen');
        setData(r);
      } catch (err) { toast.error(errorMessage(err)); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div className="p-8" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>;
  if (!data) return <div className="p-8" style={{ color: 'var(--flit-text-muted)' }}>Sin datos</div>;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Despachos y manifiestos RNDC"
        subtitle={`Periodo ${data.rango.desde} → ${data.rango.hasta}`}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiBox label="Manifiestos del periodo" value={data.manifiestos.total} sub={`${data.manifiestos.cumplidos} cumplidos`} tone="accent" />
        <KpiBox label="Ingreso facturable" value={fmtCop(data.revenue.revenue_facturable)} sub={`Anticipos ${fmtCop(data.revenue.anticipos)}`} tone="success" />
        <KpiBox label="Remesas activas sin manifiesto" value={data.remesas.activas_sin_manifiesto} sub={`${data.remesas.total} totales`} tone="warning" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniBox label="Borradores" value={data.manifiestos.borradores} />
        <MiniBox label="Listos" value={data.manifiestos.listos} />
        <MiniBox label="Radicados" value={data.manifiestos.radicados} />
        <MiniBox label="Cumplidos" value={data.manifiestos.cumplidos} />
        <MiniBox label="Aceptados" value={data.manifiestos.aceptados} />
        <MiniBox label="Rechazados" value={data.manifiestos.rechazados} tone="danger" />
        <MiniBox label="Anulados" value={data.manifiestos.anulados} tone="muted" />
        <MiniBox label="Revenue total" value={fmtCop(data.revenue.revenue_total)} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <ActionCard to="/rndc/remesas" title="Remesas" desc="Crear, asignar, cumplir remesas de carga" />
        <ActionCard to="/rndc/manifiestos" title="Manifiestos" desc="Generar manifiestos electrónicos para Mintransporte" />
        <ActionCard to="/rndc/maestros" title="Maestros" desc="Tenedores, propietarios y destinatarios de carga" />
      </div>
    </div>
  );
}

const KPI_COLOR: Record<KpiTone, string> = { accent: 'var(--flit-blue)', success: 'var(--flit-success)', warning: 'var(--flit-warning)' };
const KPI_CHIP_BG: Record<KpiTone, string> = { accent: 'rgba(79,116,201,0.14)', success: 'rgba(112,207,58,0.14)', warning: 'rgba(240,90,53,0.14)' };

function KpiBox({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone: KpiTone }) {
  return (
    <div className="bg-white p-6" style={CARD}>
      <span className="inline-flex items-center rounded-[999px] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ background: KPI_CHIP_BG[tone], color: KPI_COLOR[tone] }}>{label}</span>
      <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight" style={{ color: KPI_COLOR[tone] }}>{value}</p>
      {sub && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{sub}</p>}
    </div>
  );
}

function MiniBox({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'danger' | 'muted' }) {
  const color = tone === 'danger' ? 'var(--flit-danger)' : tone === 'muted' ? 'var(--flit-text-muted)' : 'var(--flit-text-primary)';
  return (
    <div className="bg-white p-4" style={CARD}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-1 text-lg font-semibold" style={{ color }}>{value}</p>
    </div>
  );
}

function ActionCard({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link to={to} className="block bg-white p-5 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]" style={CARD}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{title}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{desc}</p>
    </Link>
  );
}
