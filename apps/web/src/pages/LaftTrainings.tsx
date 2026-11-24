import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

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

const inputCls = 'control';
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

const COLUMNAS: ColumnaTabla<Training>[] = [
  {
    key: 'titulo',
    header: 'Título',
    render: (t) => (
      <>
        <p className="text-sm font-medium text-text-primary">{t.title}</p>
        {t.description && <p className="mt-0.5 max-w-md truncate text-[11px] text-text-tertiary">{t.description}</p>}
      </>
    ),
  },
  { key: 'capacitador', header: 'Capacitador', render: (t) => <span className="text-xs text-text-secondary">{t.trainerName || '—'}</span> },
  {
    key: 'fecha',
    header: 'Fecha',
    render: (t) => (
      <span className="text-xs text-text-secondary">
        {new Date(t.scheduledAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
      </span>
    ),
  },
  { key: 'duracion', header: 'Duración', render: (t) => <span className="text-xs text-text-secondary">{t.durationHours ? `${t.durationHours}h` : '—'}</span> },
  {
    key: 'asistencia',
    header: 'Asistencia',
    render: (t) => (
      <>
        <span className="text-xs font-semibold tabular-nums text-text-primary">{t.attendedCount}/{t.attendeesCount}</span>
        <span className="ml-1.5 text-[11px] text-text-tertiary">asistieron</span>
      </>
    ),
  },
];

export default function LaftTrainings() {
  const [data, setData] = useState<Training[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Bug #11768 — mismo defecto que en LaftUnusual: el fallo del listado solo se contaba con un
  // toast y la tabla quedaba en «Sin capacitaciones registradas». En SARLAFT ese cartel es una
  // afirmación con consecuencias (la capacitación anual es obligatoria y auditable), así que no
  // puede ser lo que se pinta cuando lo único cierto es que no se pudo leer.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.get<Training[]>('/laft/trainings');
      setData(rows);
    } catch (e) {
      setData([]);
      setError(errorMessage(e));
    }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : data.length === 0 ? 'empty' : 'ready';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Programa de capacitaciones"
        subtitle="Mínimo una capacitación anual al personal sobre prevención LA/FT/FPADM"
        icono="flito-laft"
        miga={MIGA}
        actions={<GradientButton type="button" onClick={() => setShowForm(true)}>Programar</GradientButton>}
      />

      <EstadoVista
        status={estado}
        cargando="Cargando..."
        onRetry={load}
        errorMessage={`No se pudo cargar el programa de capacitaciones. ${error ?? ''}`}
        emptyMessage="Sin capacitaciones registradas"
      >
        <DataTable ariaLabel="Programa de capacitaciones" columnas={COLUMNAS} filas={data} getKey={(t) => String(t.id)} />
      </EstadoVista>

      {showForm && <TrainingForm onClose={() => setShowForm(false)} onCreated={load} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="campo">
      <span className="etiqueta">{label}</span>
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
    <FlitModal title="Nueva capacitación" onClose={onClose} icono="calendario">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Título"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={200} className={inputCls} /></Field>
        <Field label="Descripción"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} className={inputCls + ' resize-none'} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Capacitador"><input value={f.trainerName} onChange={(e) => setF({ ...f, trainerName: e.target.value })} maxLength={120} className={inputCls} /></Field>
          <Field label="Duración (horas)"><input type="number" step="0.5" min="0.5" max="99" value={f.durationHours} onChange={(e) => setF({ ...f, durationHours: e.target.value })} className={inputCls} /></Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Fecha y hora"><input type="datetime-local" value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} required className={inputCls} /></Field>
          <Field label="Puntaje aprobatorio (%)"><input type="number" min={0} max={100} value={f.passingScore} onChange={(e) => setF({ ...f, passingScore: Number(e.target.value) })} className={inputCls} /></Field>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="alerta" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando...' : 'Programar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
