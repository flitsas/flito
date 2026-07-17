import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface RemesaRow {
  id: number;
  numero: string;
  consecutivoRndc: string | null;
  estado: 'borrador' | 'activa' | 'cumplida' | 'anulada';
  clientId: number | null;
  clientName: string | null;
  origenNombre: string | null;
  municipioOrigenDane: string;
  municipioDestinoDane: string;
  cantidadCargada: string;
  pesoKg: string | null;
  valorFlete: string;
  fechaCargue: string;
  manifiestoId: number | null;
  cumplidoAt: string | null;
}

const ESTADOS = ['', 'borrador', 'activa', 'cumplida', 'anulada'];

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral', activa: 'active', cumplida: 'success', anulada: 'danger',
};

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcRemesas() {
  const [items, setItems] = useState<RemesaRow[]>([]);
  const [estado, setEstado] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      const r = await api.get<{ data: RemesaRow[] }>(`/rndc/remesas${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  }, [estado]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Remesas de carga"
        subtitle="RNDC · Documentos de despacho que se agrupan en manifiestos electrónicos"
        actions={
          <Link to="/rndc/remesas/nueva" className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white" style={{ height: '44px', background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            Nueva remesa
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
              {e || 'Todos'}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        {loading && <div className="p-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Número</Th><Th>Cliente</Th><Th>Ruta</Th><Th>Cantidad</Th><Th>Flete</Th><Th>Fecha</Th><Th>Estado</Th><Th>Manifiesto</Th>
            </tr></thead>
            <tbody>
              {!loading && items.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin remesas</td></tr>}
              {items.map((r) => (
                <tr key={r.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs">
                    <Link to={`/rndc/remesas/${r.id}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{r.numero}</Link>
                    {r.consecutivoRndc && <span className="block text-[10px]" style={{ color: 'var(--flit-success)' }}>RNDC {r.consecutivoRndc}</span>}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.clientName ?? '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.municipioOrigenDane} → {r.municipioDestinoDane}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{Number(r.cantidadCargada).toLocaleString('es-CO')}</td>
                  <td className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>$ {Number(r.valorFlete).toLocaleString('es-CO')}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.fechaCargue}</td>
                  <td className="px-4 py-3"><StatusChip tone={ESTADO_TONE[r.estado] ?? 'neutral'}>{r.estado}</StatusChip></td>
                  <td className="px-4 py-3 text-xs">
                    {r.manifiestoId ? (
                      <Link to={`/rndc/manifiestos/${r.manifiestoId}`} className="hover:underline" style={{ color: 'var(--flit-blue)' }}>#{r.manifiestoId}</Link>
                    ) : <span style={{ color: 'var(--flit-text-muted)' }}>—</span>}
                  </td>
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
