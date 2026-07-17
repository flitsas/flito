import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';

interface Training {
  id: number; titulo: string; descripcion: string | null; horas: string;
  fecha: string; instructor: string | null; modalidad: string;
  asistentes_count: number; asistio_count: number;
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function SafetyTrainings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nueva capacitación</GradientButton> : undefined}
      />

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha</Th><Th>Título</Th><Th>Horas</Th><Th>Modalidad</Th><Th>Instructor</Th><Th>Asistencia</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin capacitaciones</td></tr>}
              {items.map((t) => (
                <tr key={t.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{t.fecha}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{t.titulo}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{Number(t.horas)} h</td>
                  <td className="px-4 py-3 capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{t.modalidad}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{t.instructor || '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--flit-success)' }}>{t.asistio_count}</span> / {t.asistentes_count} registrados
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateTrainingModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
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
    <FlitModal title="Nueva capacitación" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Título *"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={150} className={inputCls} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Horas *"><input type="number" min="0.5" step="0.5" value={horas} onChange={(e) => setHoras(e.target.value)} className={inputCls} /></Field>
          <Field label="Fecha *"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={inputCls} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Instructor"><input value={instructor} onChange={(e) => setInstructor(e.target.value)} maxLength={120} className={inputCls} /></Field>
          <Field label="Modalidad">
            <select value={modalidad} onChange={(e) => setModalidad(e.target.value as 'presencial' | 'virtual' | 'mixta')} className={inputCls}>
              <option value="presencial">Presencial</option>
              <option value="virtual">Virtual</option>
              <option value="mixta">Mixta</option>
            </select>
          </Field>
        </div>
        <Field label="Descripción"><textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={2000} rows={3} className={inputCls} /></Field>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
