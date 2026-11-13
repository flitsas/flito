import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { flitInp, FlitField } from '../components/flit/flitPageKit';

interface Training {
  id: number; titulo: string; descripcion: string | null; horas: string;
  fecha: string; instructor: string | null; modalidad: string;
  asistentes_count: number; asistio_count: number;
}

const SECUNDARIO = 'text-[color:var(--color-text-secondary)]';

const COLUMNAS: ColumnaTabla<Training>[] = [
  { key: 'fecha', header: 'Fecha', etiqueta: 'Fecha', render: (t) => <span className={`text-xs ${SECUNDARIO}`}>{t.fecha}</span> },
  { key: 'titulo', header: 'Título', etiqueta: 'Título', render: (t) => <span className="font-medium text-[color:var(--color-text-primary)]">{t.titulo}</span> },
  { key: 'horas', header: 'Horas', etiqueta: 'Horas', render: (t) => <span className={`tabular-nums ${SECUNDARIO}`}>{Number(t.horas)} h</span> },
  { key: 'modalidad', header: 'Modalidad', etiqueta: 'Modalidad', render: (t) => <span className={`capitalize ${SECUNDARIO}`}>{t.modalidad}</span> },
  { key: 'instructor', header: 'Instructor', etiqueta: 'Instructor', render: (t) => <span className={SECUNDARIO}>{t.instructor || '—'}</span> },
  {
    key: 'asistencia', header: 'Asistencia', etiqueta: 'Asistencia',
    render: (t) => (
      <span className={`text-xs ${SECUNDARIO}`}>
        <span className="font-bold tabular-nums text-[color:var(--kit-verde-texto)]">{t.asistio_count}</span> / {t.asistentes_count} registrados
      </span>
    ),
  },
];

export default function SafetyTrainings() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.capacitaciones.administrar');
  const [items, setItems] = useState<Training[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: Training[] }>('/drivers/trainings'); setItems(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Capacitaciones de seguridad vial"
        subtitle="Cursos PESV con asistencia, calificación y certificado"
        icono="flito-capacitaciones"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva capacitación</GradientButton> : undefined}
      />

      <DataTable
        ariaLabel="Capacitaciones de seguridad vial"
        columnas={COLUMNAS}
        filas={items}
        getKey={(t) => String(t.id)}
        emptyMessage="Sin capacitaciones"
      />

      {showCreate && <CreateTrainingModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateTrainingModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [titulo, setTitulo] = useState('');
  const [horas, setHoras] = useState('');
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [instructor, setInstructor] = useState('');
  const [modalidad, setModalidad] = useState<'presencial' | 'virtual' | 'mixta'>('presencial');
  const [descripcion, setDescripcion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!titulo.trim() || !horas || !fecha) { toast.error('Título, horas y fecha requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/drivers/trainings', {
        titulo: titulo.trim(),
        horas: parseFloat(horas),
        fecha,
        instructor: instructor.trim() || null,
        modalidad,
        descripcion: descripcion.trim() || null,
      });
      toast.success('Capacitación creada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nueva capacitación" onClose={onClose} icono="mas">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Título *"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="Horas *"><input type="number" min="0.5" step="0.5" value={horas} onChange={(e) => setHoras(e.target.value)} className={flitInp} /></FlitField>
          <FlitField label="Fecha *"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={flitInp} /></FlitField>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="Instructor"><input value={instructor} onChange={(e) => setInstructor(e.target.value)} maxLength={120} className={flitInp} /></FlitField>
          <FlitField label="Modalidad">
            <select value={modalidad} onChange={(e) => setModalidad(e.target.value as 'presencial' | 'virtual' | 'mixta')} className={flitInp}>
              <option value="presencial">Presencial</option>
              <option value="virtual">Virtual</option>
              <option value="mixta">Mixta</option>
            </select>
          </FlitField>
        </div>
        <FlitField label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={2000} rows={3} className={flitInp} /></FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
