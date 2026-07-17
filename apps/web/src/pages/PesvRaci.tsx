import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';

type Tipo = 'R' | 'A' | 'C' | 'I';
interface MatrizResp {
  procesos: { codigo: string; nombre: string }[];
  roles: string[];
  celdas: Record<string, Record<string, Tipo[]>>;
}

const TIPOS: Tipo[] = ['R', 'A', 'C', 'I'];
// Color + fondo por tipo RACI (FLIT).
const TIPO_STYLE: Record<Tipo, { fg: string; bg: string }> = {
  R: { fg: 'var(--flit-success)', bg: 'rgba(112,207,58,0.14)' },
  A: { fg: 'var(--flit-blue)', bg: 'rgba(79,116,201,0.14)' },
  C: { fg: 'var(--flit-warning)', bg: 'rgba(240,90,53,0.14)' },
  I: { fg: 'var(--flit-text-muted)', bg: 'rgba(125,135,152,0.12)' },
};
const TIPO_LABEL: Record<Tipo, string> = { R: 'Responsible', A: 'Accountable', C: 'Consulted', I: 'Informed' };
const ROLES = ['admin', 'lider_pesv', 'supervisor_flota', 'conductor', 'compliance', 'transito', 'proveedor'];

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const cancelBtn = 'flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium';

function Pill({ t, children }: { t: Tipo; children: ReactNode }) {
  const s = TIPO_STYLE[t];
  return <span className="inline-flex items-center rounded-[999px] px-2 py-1 text-[11px] font-semibold" style={{ color: s.fg, background: s.bg }}>{children}</span>;
}

export default function PesvRaci() {
  const [matriz, setMatriz] = useState<MatrizResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [editProc, setEditProc] = useState<{ codigo: string; nombre: string } | null>(null);
  const [editAsign, setEditAsign] = useState<Record<string, Tipo[]>>({});
  const [createNew, setCreateNew] = useState(false);
  const [newProc, setNewProc] = useState({ codigo: '', nombre: '' });

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<MatrizResp>('/pesv/raci/matriz');
      setMatriz(r);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const startEdit = (proc: { codigo: string; nombre: string }) => {
    setEditProc(proc);
    const celdas = matriz?.celdas[proc.codigo] || {};
    const asign: Record<string, Tipo[]> = {};
    for (const rol of ROLES) asign[rol] = celdas[rol] || [];
    setEditAsign(asign);
  };

  const toggleTipo = (rol: string, tipo: Tipo) => {
    setEditAsign((prev) => {
      const curr = prev[rol] || [];
      const next = curr.includes(tipo) ? curr.filter((t) => t !== tipo) : [...curr, tipo];
      return { ...prev, [rol]: next };
    });
  };

  const guardar = async () => {
    if (!editProc) return;
    try {
      const asignaciones = Object.entries(editAsign)
        .filter(([, tipos]) => tipos.length > 0)
        .map(([rol, tipos]) => ({ rol, tipos }));
      await api.put('/pesv/raci/proceso', { procesoCodigo: editProc.codigo, procesoNombre: editProc.nombre, asignaciones });
      toast.success('Matriz actualizada');
      setEditProc(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const createProceso = async () => {
    if (newProc.codigo.length < 1 || newProc.nombre.length < 3) { toast.error('Código y nombre obligatorios'); return; }
    setEditProc(newProc);
    const empty: Record<string, Tipo[]> = {};
    for (const rol of ROLES) empty[rol] = [];
    setEditAsign(empty);
    setCreateNew(false);
    setNewProc({ codigo: '', nombre: '' });
  };

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Matriz RACI"
        subtitle="Responsible / Accountable / Consulted / Informed · Paso 1.5 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setCreateNew(true)}>Nuevo proceso</GradientButton>}
      />

      <div className="flex flex-wrap gap-2">
        {TIPOS.map((t) => <Pill key={t} t={t}>{t} = {TIPO_LABEL[t]}</Pill>)}
      </div>

      {loading && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando matriz...</p>}

      {!loading && matriz && matriz.procesos.length === 0 && (
        <div className="bg-white p-12 text-center" style={CARD}>
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Aún no hay procesos en la matriz RACI.</p>
          <div className="mt-4 flex justify-center">
            <GradientButton type="button" onClick={() => setCreateNew(true)}>Definir primer proceso</GradientButton>
          </div>
        </div>
      )}

      {!loading && matriz && matriz.procesos.length > 0 && (
        <div className="overflow-x-auto bg-white" style={CARD}>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Proceso</Th>
                {ROLES.map((r) => <Th key={r}>{r.replace('_', ' ')}</Th>)}
                <Th>—</Th>
              </tr>
            </thead>
            <tbody>
              {matriz.procesos.map((p) => (
                <tr key={p.codigo} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{p.codigo}</div>
                    <div className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.nombre}</div>
                  </td>
                  {ROLES.map((rol) => {
                    const tipos = matriz.celdas[p.codigo]?.[rol] || [];
                    return (
                      <td key={rol} className="px-2 py-3">
                        <div className="flex flex-wrap gap-1">
                          {tipos.map((t) => <span key={t} className="inline-flex items-center rounded-[999px] px-1.5 py-0.5 text-[10px] font-bold" style={{ color: TIPO_STYLE[t].fg, background: TIPO_STYLE[t].bg }}>{t}</span>)}
                          {tipos.length === 0 && <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>—</span>}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-2 py-3"><button onClick={() => startEdit(p)} className="flit-focus text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createNew && (
        <FlitModal title="Nuevo proceso" onClose={() => setCreateNew(false)}>
          <div className="space-y-3">
            <input placeholder="Código (ej: S1.5)" value={newProc.codigo} onChange={(e) => setNewProc({ ...newProc, codigo: e.target.value })} className={inputCls} />
            <input placeholder="Nombre del proceso" value={newProc.nombre} onChange={(e) => setNewProc({ ...newProc, nombre: e.target.value })} className={inputCls} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setCreateNew(false)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={createProceso}>Continuar</GradientButton>
          </div>
        </FlitModal>
      )}

      {editProc && (
        <FlitModal title={`Editar matriz · ${editProc.codigo}`} onClose={() => setEditProc(null)}>
          <p className="mb-5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{editProc.nombre}</p>
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Rol</Th>{TIPOS.map((t) => <Th key={t}>{t}</Th>)}
            </tr></thead>
            <tbody>
              {ROLES.map((rol) => (
                <tr key={rol} className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>{rol.replace('_', ' ')}</td>
                  {TIPOS.map((t) => {
                    const sel = (editAsign[rol] || []).includes(t);
                    return (
                      <td key={t} className="px-2 py-2 text-center">
                        <input type="checkbox" checked={sel} onChange={() => toggleTipo(rol, t)} className="h-4 w-4 cursor-pointer" style={{ accentColor: 'var(--flit-blue)' }} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setEditProc(null)} className={cancelBtn} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
            <GradientButton type="button" onClick={guardar}>Guardar matriz</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>; }
