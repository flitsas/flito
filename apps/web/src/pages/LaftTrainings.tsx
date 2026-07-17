import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';

interface Training {
  id: number;
  title: string;
  description: string | null;
  trainerName: string | null;
  scheduledAt: string;
  durationHours: string | null;
  passingScore: number;
  attendeesCount: number;
  attendedCount: number;
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function LaftTrainings() {
  const [data, setData] = useState<Training[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Training[]>('/laft/trainings');
      setData(rows);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Programa de capacitaciones"
        subtitle="Mínimo una capacitación anual al personal sobre prevención LA/FT/FPADM"
        actions={<GradientButton type="button" onClick={() => setShowForm(true)}>Programar</GradientButton>}
      />

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>{['Título', 'Capacitador', 'Fecha', 'Duración', 'Asistencia'].map((h) => <Th key={h}>{h}</Th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && data.length === 0 && <tr><td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin capacitaciones registradas</td></tr>}
              {!loading && data.map((t) => (
                <tr key={t.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{t.title}</p>
                    {t.description && <p className="mt-0.5 max-w-md truncate text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{t.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{t.trainerName || '—'}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                    {new Date(t.scheduledAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{t.durationHours ? `${t.durationHours}h` : '—'}</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>{t.attendedCount}/{t.attendeesCount}</span>
                    <span className="ml-1.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>asistieron</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showForm && <TrainingForm onClose={() => setShowForm(false)} onCreated={load} />}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

function TrainingForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({
    title: '', description: '', trainerName: '', scheduledAt: '', durationHours: '', passingScore: 70,
  });
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (f.title.trim().length < 3) { toast.error('Título muy corto'); return; }
    if (!f.scheduledAt) { toast.error('Fecha requerida'); return; }
    setSubmitting(true);
    try {
      await api.post('/laft/trainings', {
        title: f.title.trim(),
        description: f.description.trim() || undefined,
        trainerName: f.trainerName.trim() || undefined,
        scheduledAt: new Date(f.scheduledAt).toISOString(),
        durationHours: f.durationHours ? Number(f.durationHours) : undefined,
        passingScore: Number(f.passingScore),
      });
      toast.success('Capacitación programada');
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error');
    } finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nueva capacitación" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Título"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={200} className={inputCls} /></Field>
        <Field label="Descripción"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} className={inputCls + ' resize-none'} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacitador"><input value={f.trainerName} onChange={(e) => setF({ ...f, trainerName: e.target.value })} maxLength={120} className={inputCls} /></Field>
          <Field label="Duración (horas)"><input type="number" step="0.5" min="0.5" max="99" value={f.durationHours} onChange={(e) => setF({ ...f, durationHours: e.target.value })} className={inputCls} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha y hora"><input type="datetime-local" value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} required className={inputCls} /></Field>
          <Field label="Puntaje aprobatorio (%)"><input type="number" min={0} max={100} value={f.passingScore} onChange={(e) => setF({ ...f, passingScore: Number(e.target.value) })} className={inputCls} /></Field>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando...' : 'Programar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
