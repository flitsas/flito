import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface ChecklistRow {
  id: number;
  vehicleId: number;
  plate: string | null;
  conductorId: number;
  conductorName: string | null;
  fechaHora: string;
  decision: 'apto' | 'no_apto' | 'condicional';
  anuladoAt: string | null;
}

const FILTROS = ['', 'apto', 'condicional', 'no_apto'];
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function Checklists() {
  const [items, setItems] = useState<ChecklistRow[]>([]);
  const [decision, setDecision] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (decision) params.set('decision', decision);
      const r = await api.get<{ data: ChecklistRow[] }>(`/drivers/checklists${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [decision]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Checklists preoperacionales"
        subtitle="Inspecciones diarias del vehículo antes de salir (Res. 40595/2022 paso 21)"
        actions={
          <Link to="/pesv/checklists/nuevo" className="flit-focus inline-flex items-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white" style={{ height: '44px', background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            Nuevo checklist
          </Link>
        }
      />

      <div className="flex flex-wrap gap-2">
        {FILTROS.map((d) => (
          <button
            key={d || 'todos'}
            onClick={() => setDecision(d)}
            className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold transition-colors"
            style={decision === d
              ? { background: 'var(--flit-gradient-primary)', color: '#fff' }
              : { border: '1px solid var(--flit-border-input)', background: '#fff', color: 'var(--flit-text-secondary)' }}
          >
            {d || 'Todos'}
          </button>
        ))}
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha</Th><Th>Vehículo</Th><Th>Conductor</Th><Th>Decisión</Th><Th>Estado</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin checklists</td></tr>}
              {items.map((c) => (
                <tr key={c.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{(c.fechaHora as string).slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-2.5"><Link to={`/fleet/${c.vehicleId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{c.plate || `#${c.vehicleId}`}</Link></td>
                  <td className="px-4 py-2.5"><Link to={`/pesv/conductores/${c.conductorId}`} className="text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>{c.conductorName}</Link></td>
                  <td className="px-4 py-2.5"><DecisionPill d={c.decision} /></td>
                  <td className="px-4 py-2.5 text-xs">{c.anuladoAt ? <span style={{ color: 'var(--flit-text-muted)' }}>Anulado</span> : <span style={{ color: 'var(--flit-success)' }}>Vigente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }

function DecisionPill({ d }: { d: string }) {
  const tone: Record<string, ChipTone> = { apto: 'success', condicional: 'warning', no_apto: 'danger' };
  return <StatusChip tone={tone[d] ?? 'neutral'}>{d.replace('_', ' ')}</StatusChip>;
}
