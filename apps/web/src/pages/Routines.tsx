import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import { flitInp, FlitTh, FlitTr, FlitTable, FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

interface Routine { id: number; codigo: string; nombre: string; descripcion: string | null; activo: boolean; }

export default function Routines() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState<Routine[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: Routine[] }>('/maintenance/routines'); setItems(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Rutinas de mantenimiento"
        subtitle="Plantillas de trabajos+repuestos con periodicidad por km/horas/días"
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva rutina</GradientButton> : undefined}
      />

      <FlitTable>
        <table className="w-full text-sm">
          <thead><tr>
            <FlitTh>Código</FlitTh><FlitTh>Nombre</FlitTh><FlitTh>Descripción</FlitTh><FlitTh>Estado</FlitTh>
          </tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin rutinas registradas</td></tr>}
            {items.map((r) => (
              <FlitTr key={r.id}>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.codigo}</td>
                <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{r.nombre}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.descripcion || '—'}</td>
                <td className="px-4 py-2.5">
                  <StatusChip tone={r.activo ? 'success' : 'neutral'}>{r.activo ? 'Activa' : 'Inactiva'}</StatusChip>
                </td>
              </FlitTr>
            ))}
          </tbody>
        </table>
      </FlitTable>

      {showCreate && <RoutineForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function RoutineForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!codigo.trim() || !nombre.trim()) { toast.error('Código y nombre requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/maintenance/routines', {
        codigo: codigo.trim().toUpperCase(),
        nombre: nombre.trim(),
        descripcion: descripcion.trim() || null,
      });
      toast.success('Rutina creada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nueva rutina" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 px-6 pb-6">
        <FlitField label="Código *"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={20} className={flitInp} /></FlitField>
        <FlitField label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <FlitField label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={500} rows={3} className={flitInp} /></FlitField>
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>{submitting ? 'Guardando…' : 'Crear'}</button>
        </div>
      </form>
    </FlitModal>
  );
}
