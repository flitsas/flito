import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp, FlitTable, FlitTh, FlitTr } from '../components/flit/flitPageKit';

type Tipo = 'R' | 'A' | 'C' | 'I';
interface MatrizResp {
  procesos: { codigo: string; nombre: string }[];
  roles: string[];
  celdas: Record<string, Record<string, Tipo[]>>;
}

const TIPOS: Tipo[] = ['R', 'A', 'C', 'I'];
// Tono del kit por tipo RACI.
const TIPO_TONO: Record<Tipo, ChipTone> = { R: 'success', A: 'active', C: 'warning', I: 'neutral' };
const TIPO_LABEL: Record<Tipo, string> = { R: 'Responsible', A: 'Accountable', C: 'Consulted', I: 'Informed' };
const ROLES = ['admin', 'lider_pesv', 'supervisor_flota', 'conductor', 'compliance', 'transito', 'proveedor'];

const inputCls = flitInp;
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];
const TENUE = 'text-[color:var(--color-text-tertiary)]';

function Pill({ t, children }: { t: Tipo; children: ReactNode }) {
  return <StatusChip tone={TIPO_TONO[t]}>{children}</StatusChip>;
}

type Proceso = MatrizResp['procesos'][number];

function columnasMatriz(matriz: MatrizResp, onEditar: (p: Proceso) => void): ColumnaTabla<Proceso>[] {
  return [
    {
      key: 'proceso', header: 'Proceso', render: (p) => (
        <div>
          <div className="font-mono text-xs font-semibold text-[color:var(--color-text-primary)]">{p.codigo}</div>
          <div className="text-xs text-[color:var(--color-text-secondary)]">{p.nombre}</div>
        </div>
      ),
    },
    ...ROLES.map((rol): ColumnaTabla<Proceso> => ({
      key: rol, header: rol.replace('_', ' '), render: (p) => {
        const tipos = matriz.celdas[p.codigo]?.[rol] || [];
        return (
          <div className="flex flex-wrap gap-1">
            {tipos.map((t) => <Pill key={t} t={t}>{t}</Pill>)}
            {tipos.length === 0 && <span className={`text-xs ${TENUE}`}>—</span>}
          </div>
        );
      },
    })),
    { key: 'acciones', header: '—', acciones: true, render: (p) => <GradientButton type="button" variant="secondary" size="sm" onClick={() => onEditar(p)}>Editar</GradientButton> },
  ];
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
        icono="flito-pesv"
        miga={MIGA}
        subtitle="Responsible / Accountable / Consulted / Informed · Paso 1.5 · Res. 40595"
        actions={<GradientButton type="button" onClick={() => setCreateNew(true)}>Nuevo proceso</GradientButton>}
      />

      <div className="flex flex-wrap gap-2">
        {TIPOS.map((t) => <Pill key={t} t={t}>{t} = {TIPO_LABEL[t]}</Pill>)}
      </div>

      <section className="card p-0">
        <DataTable<Proceso>
          ariaLabel="Matriz RACI"
          matriz
          columnas={matriz ? columnasMatriz(matriz, startEdit) : []}
          filas={matriz?.procesos ?? []}
          getKey={(p) => p.codigo}
          status={loading ? 'loading' : !matriz ? 'error' : undefined}
          onRetry={load}
          emptyMessage="Aún no hay procesos en la matriz RACI."
          emptyCta={<GradientButton type="button" onClick={() => setCreateNew(true)}>Definir primer proceso</GradientButton>}
        />
      </section>

      {createNew && (
        <FlitModal title="Nuevo proceso" onClose={() => setCreateNew(false)}>
          <div className="space-y-3">
            <input placeholder="Código (ej: S1.5)" value={newProc.codigo} onChange={(e) => setNewProc({ ...newProc, codigo: e.target.value })} className={inputCls} />
            <input placeholder="Nombre del proceso" value={newProc.nombre} onChange={(e) => setNewProc({ ...newProc, nombre: e.target.value })} className={inputCls} />
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setCreateNew(false)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={createProceso}>Continuar</GradientButton>
          </div>
        </FlitModal>
      )}

      {editProc && (
        <FlitModal title={`Editar matriz · ${editProc.codigo}`} onClose={() => setEditProc(null)}>
          <p className="mb-5 text-xs text-[color:var(--color-text-secondary)]">{editProc.nombre}</p>
          <FlitTable matriz label={`Asignaciones RACI · ${editProc.codigo}`}>
            <thead><tr>
              <FlitTh>Rol</FlitTh>{TIPOS.map((t) => <FlitTh key={t} center>{t}</FlitTh>)}
            </tr></thead>
            <tbody>
              {ROLES.map((rol) => (
                <FlitTr key={rol}>
                  <td className="px-3 py-2 text-xs text-[color:var(--color-text-primary)]">{rol.replace('_', ' ')}</td>
                  {TIPOS.map((t) => {
                    const sel = (editAsign[rol] || []).includes(t);
                    return (
                      <td key={t} className="px-2 py-2 text-center">
                        <input type="checkbox" checked={sel} onChange={() => toggleTipo(rol, t)} className="flit-focus h-4 w-4 cursor-pointer accent-[var(--kit-azul)]" />
                      </td>
                    );
                  })}
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <GradientButton type="button" variant="secondary" onClick={() => setEditProc(null)}>Cancelar</GradientButton>
            <GradientButton type="button" onClick={guardar}>Guardar matriz</GradientButton>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
