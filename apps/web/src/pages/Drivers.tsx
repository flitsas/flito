import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';

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

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function Drivers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Conductores"
        subtitle="Hojas de vida con licencia, examen psicosensométrico y categorías PESV"
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Promover conductor</GradientButton> : undefined}
      />

      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o usuario"
          className={inputCls + ' min-w-0 flex-1'}
        />
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          <input type="checkbox" checked={vencidos} onChange={(e) => setVencidos(e.target.checked)} style={{ accentColor: 'var(--flit-blue)' }} />
          Solo con docs vencidos
        </label>
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Nombre</Th><Th>Cédula</Th><Th>Licencia</Th><Th>Categorías</Th><Th>Vigencia</Th><Th>Psicosensométrico</Th><Th>Contrato</Th><Th></Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin conductores</td></tr>}
              {items.map((d) => {
                const licVencida = d.licenciaVigencia && d.licenciaVigencia <= today;
                const psicoVencido = d.examenPsicoVigencia && d.examenPsicoVigencia <= today;
                return (
                  <tr key={d.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3">
                      <Link to={`/pesv/conductores/${d.id}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-text-primary)' }}>{d.name}</Link>
                      <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>@{d.username}</p>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{d.cedula || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{d.licenciaNumero || '—'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{d.categorias?.join(', ') || '—'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: licVencida ? 'var(--flit-danger)' : 'var(--flit-text-secondary)', fontWeight: licVencida ? 700 : 400 }}>{d.licenciaVigencia || '—'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: psicoVencido ? 'var(--flit-danger)' : 'var(--flit-text-secondary)', fontWeight: psicoVencido ? 700 : 400 }}>{d.examenPsicoVigencia || '—'}</td>
                    <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{d.contratoTipo || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/pesv/conductores/${d.id}`} className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>Detalle</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateDriverModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
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
    <FlitModal title="Promover usuario a conductor PESV" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Usuario *">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
            <option value="">— seleccione —</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name} (@{c.username})</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cédula *"><input value={cedula} onChange={(e) => setCedula(e.target.value)} maxLength={12} className={inputCls} /></Field>
          <Field label="Número licencia *"><input value={licenciaNumero} onChange={(e) => setLicenciaNumero(e.target.value)} maxLength={40} className={inputCls} /></Field>
        </div>
        <Field label="Categorías *">
          <div className="flex flex-wrap gap-2">
            {CATEGORIAS.map((c) => {
              const on = categoriasSet.has(c);
              return (
                <button
                  type="button"
                  key={c}
                  onClick={() => toggleCategoria(c)}
                  className="flit-focus rounded-[999px] px-3 py-1 text-xs font-semibold transition-colors"
                  style={on
                    ? { background: 'var(--flit-blue)', color: '#fff' }
                    : { background: '#fff', border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vigencia licencia"><input type="date" value={licenciaVigencia} onChange={(e) => setLicenciaVigencia(e.target.value)} className={inputCls} /></Field>
          <Field label="Vigencia examen psicosensométrico"><input type="date" value={examenPsicoVigencia} onChange={(e) => setExamenPsicoVigencia(e.target.value)} className={inputCls} /></Field>
        </div>
        <Field label="Tipo de contrato">
          <select value={contratoTipo} onChange={(e) => setContratoTipo(e.target.value as ContratoTipo)} className={inputCls}>
            <option value="directo">Directo</option>
            <option value="contratista">Contratista</option>
            <option value="temporal">Temporal</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ARL"><input value={arl} onChange={(e) => setArl(e.target.value)} maxLength={80} className={inputCls} /></Field>
          <Field label="EPS"><input value={eps} onChange={(e) => setEps(e.target.value)} maxLength={80} className={inputCls} /></Field>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Promover'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
}
