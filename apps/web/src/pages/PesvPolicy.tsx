import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface Policy {
  id: number;
  version: number;
  titulo: string;
  contenidoMd: string;
  estado: 'borrador' | 'vigente' | 'reemplazada';
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  firmadaPor: number | null;
  firmadaAt: string | null;
  optimisticV: number;
  createdAt: string;
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function PesvPolicy() {
  const [items, setItems] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ titulo: '', contenidoMd: '', vigenciaDesde: '' });

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: Policy[] }>('/pesv/policy');
      setItems(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (form.titulo.length < 5 || form.contenidoMd.length < 20 || !form.vigenciaDesde) {
      toast.error('Completa los campos (título ≥5, contenido ≥20 chars, vigencia desde)');
      return;
    }
    try {
      await api.post('/pesv/policy', form);
      toast.success('Borrador creado');
      setShowCreate(false);
      setForm({ titulo: '', contenidoMd: '', vigenciaDesde: '' });
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const firmar = async (id: number) => {
    if (!confirm('¿Firmar y poner como vigente? La política actualmente vigente pasará a "reemplazada" (acción irreversible).')) return;
    try {
      await api.post(`/pesv/policy/${id}/firmar`);
      toast.success('Política firmada y vigente');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const vigente = items.find((p) => p.estado === 'vigente') || null;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Política de Seguridad Vial"
        subtitle="Firmada por representante legal · WORM tras firma · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva versión</GradientButton>}
      />

      {vigente && (
        <div className="rounded-[18px] p-6" style={{ border: '1px solid rgba(112,207,58,0.30)', background: 'rgba(112,207,58,0.08)' }}>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--flit-success)' }}>Vigente</span>
              <h2 className="mt-0.5 text-lg font-semibold" style={{ color: 'var(--flit-text-primary)' }}>v{vigente.version} · {vigente.titulo}</h2>
            </div>
            <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Desde {vigente.vigenciaDesde}</span>
          </div>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-[10px] bg-white p-4 text-xs" style={{ color: 'var(--flit-text-primary)', border: '1px solid var(--flit-border-soft)' }}>{vigente.contenidoMd}</pre>
          <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Firmada {vigente.firmadaAt?.slice(0, 10) ?? '—'}</p>
        </div>
      )}

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Versión</Th><Th>Título</Th><Th>Vigencia</Th><Th>Estado</Th><Th>Acciones</Th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="py-10 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin políticas registradas</td></tr>}
              {items.map((p) => (
                <tr key={p.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-sm" style={{ color: 'var(--flit-text-primary)' }}>v{p.version}</td>
                  <td className="px-4 py-3 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{p.titulo}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.vigenciaDesde}{p.vigenciaHasta ? ' → ' + p.vigenciaHasta : ''}</td>
                  <td className="px-4 py-3"><EstadoPill estado={p.estado} /></td>
                  <td className="px-4 py-3">
                    {p.estado === 'borrador' && (
                      <button onClick={() => firmar(p.id)} className="flit-focus inline-flex h-8 items-center rounded-[999px] px-3 text-xs font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>Firmar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <FlitModal title="Nueva versión de Política PSV" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Título</label>
              <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className={inputCls} placeholder="Política de Seguridad Vial 2026" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Vigencia desde</label>
              <input type="date" value={form.vigenciaDesde} onChange={(e) => setForm({ ...form, vigenciaDesde: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Contenido (Markdown)</label>
              <textarea value={form.contenidoMd} onChange={(e) => setForm({ ...form, contenidoMd: e.target.value })} rows={10} className={`${inputCls} font-mono text-xs`} placeholder="# Política de Seguridad Vial&#10;&#10;[Empresa] se compromete con..." />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={create}>Crear borrador</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }
function EstadoPill({ estado }: { estado: string }) {
  const tone: Record<string, ChipTone> = { borrador: 'warning', vigente: 'success', reemplazada: 'neutral' };
  return <StatusChip tone={tone[estado] ?? 'neutral'}>{estado}</StatusChip>;
}
