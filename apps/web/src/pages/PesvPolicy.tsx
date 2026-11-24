import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp } from '../components/flit/flitPageKit';

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

const inputCls = flitInp;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];
const TENUE = 'text-[color:var(--color-text-tertiary)]';
const LABEL = 'mb-1.5 block text-[0.8125rem] font-semibold text-[color:var(--color-text-primary)]';

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
        icono="flito-pesv"
        miga={MIGA}
        subtitle="Firmada por representante legal · WORM tras firma · Res. 40595/2022"
        actions={<GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva versión</GradientButton>}
      />

      {vigente && (
        <section className="card border-[color:var(--kit-verde)]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--kit-verde-texto)]">Vigente</span>
              <h2 className="mt-0.5 text-lg font-semibold text-[color:var(--color-text-primary)]">v{vigente.version} · {vigente.titulo}</h2>
            </div>
            <span className="text-xs text-[color:var(--color-text-secondary)]">Desde {vigente.vigenciaDesde}</span>
          </div>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[color:var(--color-text-primary)]">{vigente.contenidoMd}</pre>
          <p className={`mt-2 text-[11px] ${TENUE}`}>Firmada {vigente.firmadaAt?.slice(0, 10) ?? '—'}</p>
        </section>
      )}

      <section className="card p-0">
        <DataTable<Policy>
          ariaLabel="Versiones de la política de seguridad vial"
          columnas={columnas(firmar)}
          filas={items}
          getKey={(p) => String(p.id)}
          status={loading ? 'loading' : undefined}
          emptyMessage="Sin políticas registradas"
        />
      </section>

      {showCreate && (
        <FlitModal title="Nueva versión de Política PSV" onClose={() => setShowCreate(false)}>
          <div className="space-y-3">
            <div>
              <label htmlFor="pol-titulo" className={LABEL}>Título</label>
              <input id="pol-titulo" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className={inputCls} placeholder="Política de Seguridad Vial 2026" />
            </div>
            <div>
              <label htmlFor="pol-vigencia" className={LABEL}>Vigencia desde</label>
              <input id="pol-vigencia" type="date" value={form.vigenciaDesde} onChange={(e) => setForm({ ...form, vigenciaDesde: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label htmlFor="pol-contenido" className={LABEL}>Contenido (Markdown)</label>
              <textarea id="pol-contenido" value={form.contenidoMd} onChange={(e) => setForm({ ...form, contenidoMd: e.target.value })} rows={10} className={`${inputCls} font-mono text-xs`} placeholder="# Política de Seguridad Vial&#10;&#10;[Empresa] se compromete con..." />
            </div>
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={create}>Crear borrador</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function columnas(firmar: (id: number) => void): ColumnaTabla<Policy>[] {
  return [
    { key: 'version', header: 'Versión', render: (p) => <span className="font-mono text-sm text-[color:var(--color-text-primary)]">v{p.version}</span> },
    { key: 'titulo', header: 'Título', render: (p) => <span className="text-sm font-medium text-[color:var(--color-text-primary)]">{p.titulo}</span> },
    { key: 'vigencia', header: 'Vigencia', render: (p) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{p.vigenciaDesde}{p.vigenciaHasta ? ' → ' + p.vigenciaHasta : ''}</span> },
    { key: 'estado', header: 'Estado', render: (p) => <EstadoPill estado={p.estado} /> },
    {
      key: 'acciones', header: 'Acciones', acciones: true,
      render: (p) => (p.estado === 'borrador' ? <GradientButton type="button" variant="success" size="sm" onClick={() => firmar(p.id)}>Firmar</GradientButton> : null),
    },
  ];
}
function EstadoPill({ estado }: { estado: string }) {
  const tone: Record<string, ChipTone> = { borrador: 'warning', vigente: 'success', reemplazada: 'neutral' };
  return <StatusChip tone={tone[estado] ?? 'neutral'}>{estado}</StatusChip>;
}
