import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import PanelFiltros from '../components/flit/PanelFiltros';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { FlitCard, FlitField, flitInp, flitBtnSecondarySm } from '../components/flit/flitPageKit';
import '../components/fleet/estados-conductores';

interface Driver {
  id: number;
  name: string;
  username: string;
  email: string | null;
  cedula: string | null;
  licenciaNumero: string | null;
  categorias: string[] | null;
  licenciaVigencia: string | null;
  examenPsicoVigencia: string | null;
  contratoTipo: string | null;
}

interface NonDriverUser { id: number; name: string; username: string; }

const CATEGORIAS = ['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];

function iniciales(nombre: string): string {
  return nombre.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0)).join('').toUpperCase() || '·';
}

/** Fecha de vigencia: vencida → etiqueta «vencido» del kit; si no, texto secundario. */
function Vigencia({ fecha, vencida }: { fecha: string | null; vencida: boolean }) {
  if (!fecha) return <span className="text-xs text-[color:var(--color-text-secondary)]">—</span>;
  if (vencida) return <EtiquetaEstado estado="vencido">{fecha}</EtiquetaEstado>;
  return <span className="text-xs text-[color:var(--color-text-secondary)]">{fecha}</span>;
}

export default function Drivers() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.conductores.administrar');
  const [items, setItems] = useState<Driver[]>([]);
  const [search, setSearch] = useState('');
  const [vencidos, setVencidos] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (vencidos) params.set('vencidos', 'true');
      const r = await api.get<{ data: Driver[] }>(`/drivers${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [search, vencidos]);
  useEffect(() => { load(); }, [load]);

  const today = new Date().toISOString().slice(0, 10);

  const columnas: ColumnaTabla<Driver>[] = [
    {
      key: 'nombre', header: 'Nombre',
      render: (d) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="persona__avatar" aria-hidden="true">{iniciales(d.name)}</span>
          <span className="min-w-0">
            <Link to={`/pesv/conductores/${d.id}`} className="font-semibold text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-action)] hover:underline">{d.name}</Link>
            <p className="text-[0.6875rem] text-[color:var(--color-text-tertiary)]">@{d.username}</p>
          </span>
        </div>
      ),
    },
    { key: 'cedula', header: 'Cédula', render: (d) => <span className="text-[color:var(--color-text-secondary)]">{d.cedula || '—'}</span> },
    { key: 'licencia', header: 'Licencia', render: (d) => <span className="mono text-xs text-[color:var(--color-text-secondary)]">{d.licenciaNumero || '—'}</span> },
    { key: 'categorias', header: 'Categorías', render: (d) => <span className="text-xs text-[color:var(--color-text-secondary)]">{d.categorias?.join(', ') || '—'}</span> },
    { key: 'vigencia', header: 'Vigencia', render: (d) => <Vigencia fecha={d.licenciaVigencia} vencida={!!d.licenciaVigencia && d.licenciaVigencia <= today} /> },
    { key: 'psico', header: 'Psicosensométrico', render: (d) => <Vigencia fecha={d.examenPsicoVigencia} vencida={!!d.examenPsicoVigencia && d.examenPsicoVigencia <= today} /> },
    { key: 'contrato', header: 'Contrato', render: (d) => <span className="text-xs capitalize text-[color:var(--color-text-secondary)]">{d.contratoTipo || '—'}</span> },
    {
      key: 'acciones', header: '', etiqueta: 'Acciones', acciones: true, align: 'right',
      render: (d) => <Link to={`/pesv/conductores/${d.id}`} className={flitBtnSecondarySm}>Detalle</Link>,
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Conductores"
        subtitle="Hojas de vida con licencia, examen psicosensométrico y categorías PESV"
        icono="flito-conductores"
        miga={[{ etiqueta: 'Conductores' }]}
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Promover conductor</GradientButton> : undefined}
      />

      <FlitCard className="flex flex-col gap-4">
        <PanelFiltros
          busqueda={search}
          onBusqueda={setSearch}
          placeholder="Buscar por nombre o usuario"
          acciones={(
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
              <input type="checkbox" checked={vencidos} onChange={(e) => setVencidos(e.target.checked)} className="h-4 w-4 accent-[var(--kit-azul)]" />
              Solo con docs vencidos
            </label>
          )}
        />
        <DataTable
          ariaLabel="Conductores"
          columnas={columnas}
          filas={items}
          getKey={(d) => String(d.id)}
          emptyMessage="Sin conductores"
        />
      </FlitCard>

      {showCreate && <CreateDriverModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

type ContratoTipo = 'directo' | 'contratista' | 'temporal';

function CreateDriverModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [candidates, setCandidates] = useState<NonDriverUser[]>([]);
  const [userId, setUserId] = useState('');
  const [cedula, setCedula] = useState('');
  const [licenciaNumero, setLicenciaNumero] = useState('');
  const [categoriasSet, setCategoriasSet] = useState<Set<string>>(new Set());
  const [licenciaVigencia, setLicenciaVigencia] = useState('');
  const [examenPsicoVigencia, setExamenPsicoVigencia] = useState('');
  const [contratoTipo, setContratoTipo] = useState<ContratoTipo>('directo');
  const [arl, setArl] = useState('');
  const [eps, setEps] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  useEffect(() => {
    api.get<{ data: NonDriverUser[] }>('/drivers/candidates/non-driver')
      .then((r) => setCandidates(r.data)).catch((err) => toast.error(errorMessage(err)));
  }, []);

  const toggleCategoria = (c: string) => {
    setCategoriasSet((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) { toast.error('Seleccione un usuario'); return; }
    if (!cedula.trim() || !licenciaNumero.trim()) { toast.error('Cédula y número de licencia requeridos'); return; }
    if (categoriasSet.size === 0) { toast.error('Seleccione al menos una categoría'); return; }
    setSubmitting(true);
    try {
      const body = {
        userId: parseInt(userId, 10),
        profile: {
          cedula: cedula.trim(),
          licenciaNumero: licenciaNumero.trim().toUpperCase(),
          categorias: Array.from(categoriasSet),
          licenciaVigencia: licenciaVigencia || null,
          examenPsicoVigencia: examenPsicoVigencia || null,
          contratoTipo,
          arl: arl.trim() || null,
          eps: eps.trim() || null,
        },
      };
      await api.post('/drivers', body);
      toast.success('Conductor registrado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Promover usuario a conductor PESV" onClose={onClose} icono="credencial">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Usuario *">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={flitInp}>
            <option value="">— seleccione —</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name} (@{c.username})</option>)}
          </select>
        </FlitField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="Cédula *"><input value={cedula} onChange={(e) => setCedula(e.target.value)} maxLength={12} className={flitInp} /></FlitField>
          <FlitField label="Número licencia *"><input value={licenciaNumero} onChange={(e) => setLicenciaNumero(e.target.value)} maxLength={40} className={flitInp} /></FlitField>
        </div>
        <FlitField label="Categorías *">
          <div className="flex flex-wrap gap-2">
            {CATEGORIAS.map((c) => {
              const on = categoriasSet.has(c);
              return (
                <button
                  type="button"
                  key={c}
                  onClick={() => toggleCategoria(c)}
                  className={on
                    ? 'inline-flex h-8 items-center rounded-full border border-[color:var(--kit-azul)] bg-[var(--kit-azul-relleno)] px-3.5 text-xs font-semibold text-white transition-[filter] hover:brightness-90'
                    : 'inline-flex h-8 items-center rounded-full border border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] px-3.5 text-xs font-semibold text-[color:var(--color-text-secondary)] transition-colors hover:border-[color:var(--kit-azul)] hover:bg-[var(--kit-hover)]'}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </FlitField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="Vigencia licencia"><input type="date" value={licenciaVigencia} onChange={(e) => setLicenciaVigencia(e.target.value)} className={flitInp} /></FlitField>
          <FlitField label="Vigencia examen psicosensométrico"><input type="date" value={examenPsicoVigencia} onChange={(e) => setExamenPsicoVigencia(e.target.value)} className={flitInp} /></FlitField>
        </div>
        <FlitField label="Tipo de contrato">
          <select value={contratoTipo} onChange={(e) => setContratoTipo(e.target.value as ContratoTipo)} className={flitInp}>
            <option value="directo">Directo</option>
            <option value="contratista">Contratista</option>
            <option value="temporal">Temporal</option>
          </select>
        </FlitField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="ARL"><input value={arl} onChange={(e) => setArl(e.target.value)} maxLength={80} className={flitInp} /></FlitField>
          <FlitField label="EPS"><input value={eps} onChange={(e) => setEps(e.target.value)} maxLength={80} className={flitInp} /></FlitField>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Promover'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
