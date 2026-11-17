import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { flitInp, FlitField } from '../components/flit/flitPageKit';

interface Routine { id: number; codigo: string; nombre: string; descripcion: string | null; activo: boolean; }

const COLUMNAS: ColumnaTabla<Routine>[] = [
  { key: 'codigo', header: 'Código', etiqueta: 'Código', render: (r) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{r.codigo}</span> },
  { key: 'nombre', header: 'Nombre', etiqueta: 'Nombre', render: (r) => <span className="font-medium text-[color:var(--color-text-primary)]">{r.nombre}</span> },
  { key: 'descripcion', header: 'Descripción', etiqueta: 'Descripción', render: (r) => <span className="text-xs text-[color:var(--color-text-secondary)]">{r.descripcion || '—'}</span> },
  { key: 'estado', header: 'Estado', etiqueta: 'Estado', render: (r) => <EtiquetaEstado estado={r.activo ? 'activo' : 'inactivo'}>{r.activo ? 'Activa' : 'Inactiva'}</EtiquetaEstado> },
];

export default function Routines() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('maintenance.inicio.administrar');
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
        icono="flito-mantenimiento"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }]}
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva rutina</GradientButton> : undefined}
      />

      <DataTable
        ariaLabel="Rutinas de mantenimiento"
        columnas={COLUMNAS}
        filas={items}
        getKey={(r) => String(r.id)}
        emptyMessage="Sin rutinas registradas"
      />

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
    <FlitModal title="Nueva rutina" onClose={onClose} icono="mas">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Código *"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={20} className={flitInp} /></FlitField>
        <FlitField label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <FlitField label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={500} rows={3} className={flitInp} /></FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
