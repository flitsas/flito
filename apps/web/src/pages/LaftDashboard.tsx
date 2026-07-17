import { useEffect, useState, useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

// MVP read-only (USR-5): Tablero LAFT. Conectado a GET /api/laft/dashboard
// (laft_dashboard, accesible a admin|compliance|auditor). Solo lectura.
interface Dashboard {
  officerInfo?: { principal?: boolean; suplente?: boolean; principalIso17024?: boolean; ok?: boolean };
  manualVigente?: { version?: number; publicadoAt?: string | null; sha256?: string | null } | null;
  contrapartesAgg?: { total?: number; alto?: number; pendientes?: number; bloqueadas?: number };
  empleadosVencidos?: number;
}

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

const TONE_COLOR: Record<'default' | 'ok' | 'warn' | 'danger', string> = {
  default: 'var(--flit-text-primary)',
  ok: 'var(--flit-success)',
  warn: 'var(--flit-warning)',
  danger: 'var(--flit-danger)',
};

function Card({ label, value, tone = 'default', hint }: { label: string; value: React.ReactNode; tone?: 'default' | 'ok' | 'warn' | 'danger'; hint?: string }) {
  return (
    <div className="bg-white p-5" style={CARD}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight" style={{ color: TONE_COLOR[tone] }}>{value}</p>
      {hint && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>}
    </div>
  );
}

export default function LaftDashboard() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setD(await api.get<Dashboard>('/laft/dashboard')); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cp = d?.contrapartesAgg ?? {};

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Estado del cumplimiento"
        subtitle="Indicadores clave del sistema SARLAFT: gobierno, manual vigente, contrapartes y debida diligencia"
      />

      {loading && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</p>}
      {!loading && error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}
      {!loading && !error && d && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card
            label="Oficial de cumplimiento"
            value={d.officerInfo?.ok ? 'Conforme' : 'Revisar'}
            tone={d.officerInfo?.ok ? 'ok' : 'warn'}
            hint={`Principal: ${d.officerInfo?.principal ? 'sí' : 'no'} · Suplente: ${d.officerInfo?.suplente ? 'sí' : 'no'} · ISO 17024: ${d.officerInfo?.principalIso17024 ? 'sí' : 'no'}`}
          />
          <Card
            label="Manual SARLAFT vigente"
            value={d.manualVigente?.version != null ? `v${d.manualVigente.version}` : 'Sin publicar'}
            tone={d.manualVigente?.version != null ? 'ok' : 'warn'}
            hint={d.manualVigente?.publicadoAt ? `Publicado ${new Date(d.manualVigente.publicadoAt).toLocaleDateString('es-CO')}` : 'No hay manual publicado'}
          />
          <Card
            label="Contrapartes"
            value={cp.total ?? 0}
            hint={`Riesgo alto: ${cp.alto ?? 0} · Pendientes: ${cp.pendientes ?? 0} · Bloqueadas: ${cp.bloqueadas ?? 0}`}
          />
          <Card
            label="KYC empleados vencidos"
            value={d.empleadosVencidos ?? 0}
            tone={(d.empleadosVencidos ?? 0) > 0 ? 'danger' : 'ok'}
            hint="Revisión periódica de debida diligencia"
          />
        </div>
      )}
    </div>
  );
}
