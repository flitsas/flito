import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface ManifiestoRow {
  id: number;
  numero: string;
  consecutivoRndc: string | null;
  estado: string;
  fechaExpedicion: string;
  valorFleteTotal: string;
  placaPrincipal: string | null;
  conductorNombre: string | null;
  origenDane: string;
  destinoDane: string;
  radicadoAt: string | null;
  cumplidoAt: string | null;
}

const ESTADOS = ['', 'borrador', 'listo', 'radicado_rndc', 'aceptado', 'rechazado', 'cumplido', 'anulado'];

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral', listo: 'active', radicado_rndc: 'active',
  aceptado: 'success', rechazado: 'danger', cumplido: 'success', anulado: 'neutral',
};

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcManifiestos() {
  const [items, setItems] = useState<ManifiestoRow[]>([]);
  const [estado, setEstado] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      const r = await api.get<{ data: ManifiestoRow[] }>(`/rndc/manifiestos${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  }, [estado]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Manifiestos electrónicos"
        subtitle="RNDC · Documentos legales de transporte de carga ante Mintransporte"
        actions={
          <Link to="/rndc/manifiestos/nuevo" className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white" style={{ height: '44px', background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            Nuevo manifiesto
          </Link>
        }
      />

      <div className="flex w-fit flex-wrap gap-2">
        {ESTADOS.map((e) => {
          const active = estado === e;
          return (
            <button key={e || 'todos'} onClick={() => setEstado(e)}
              className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold capitalize transition-colors"
              style={active
                ? { background: 'var(--flit-blue)', color: '#fff' }
                : { background: '#fff', border: '1px solid var(--flit-border-soft)', color: 'var(--flit-text-muted)' }}>
              {(e || 'Todos').replace('_', ' ')}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        {loading && <div className="p-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Número</Th><Th>Vehículo</Th><Th>Conductor</Th><Th>Ruta</Th><Th>Flete</Th><Th>Fecha</Th><Th>Estado</Th>
            </tr></thead>
            <tbody>
              {!loading && items.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin manifiestos</td></tr>}
              {items.map((m) => (
                <tr key={m.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs">
                    <Link to={`/rndc/manifiestos/${m.id}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{m.numero}</Link>
                    {m.consecutivoRndc && <span className="block text-[10px]" style={{ color: 'var(--flit-success)' }}>RNDC {m.consecutivoRndc}</span>}
                  </td>
                  <td className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>{m.placaPrincipal ?? '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{m.conductorNombre ?? '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{m.origenDane} → {m.destinoDane}</td>
                  <td className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>$ {Number(m.valorFleteTotal).toLocaleString('es-CO')}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{m.fechaExpedicion}</td>
                  <td className="px-4 py-3"><StatusChip tone={ESTADO_TONE[m.estado] ?? 'neutral'}>{m.estado.replace('_', ' ')}</StatusChip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
