import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import { Fichas } from '../components/flit/Bloques';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { EstadoVista, type EstadoUi } from '../components/flit/Cargador';

type Decision = 'pendiente' | 'en_analisis' | 'descartada' | 'escalada' | 'reportada';

interface UnusualOp {
  id: number;
  counterpartyId: number | null;
  counterpartyName: string | null;
  counterpartyDoc: string | null;
  detectedAt: string;
  source: string;
  signals: string[];
  amount: string | null;
  currency: string;
  description: string;
  decision: Decision;
  decidedAt: string | null;
  version: number;
}

const DECISION_LABEL: Record<Decision, { label: string; tone: ChipTone }> = {
  pendiente: { label: 'Pendiente', tone: 'neutral' },
  en_analisis: { label: 'En análisis', tone: 'warning' },
  descartada: { label: 'Descartada', tone: 'neutral' },
  escalada: { label: 'Escalada', tone: 'danger' },
  reportada: { label: 'Reportada UIAF', tone: 'danger' },
};

const SOURCE_OPTIONS = [
  'transaccion_montos_atipicos',
  'fragmentacion_pagos',
  'cliente_alto_riesgo_pep',
  'cambio_subito_volumen',
  'pais_alto_riesgo',
  'otro',
];

const inputCls = 'control';
const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'LAFT', to: '/laft' }];

export default function LaftUnusual() {
  const [data, setData] = useState<UnusualOp[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UnusualOp | null>(null);

  // Bug #11768 — esta pantalla tenía tres estados, no cuatro: un fallo del listado se contaba con
  // un toast que se desvanece y dejaba la tabla en «Sin operaciones registradas». Es la peor forma
  // de fallar de un módulo de cumplimiento: «no hay señales de alerta» y «no pude leer las señales
  // de alerta» son conclusiones opuestas y se veían idénticas, sin camino de vuelta salvo recargar.
  // Se adopta el estado de error en el cuerpo que ya usan LaftAuditPlan / LaftManual / LaftOfficer,
  // con el «Reintentar» que ya existe en finanzas (ContadoresFacturacion, TarjetaEnvioFacturacion).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filter) params.set('decision', filter);
      const res = await api.get<{ rows: UnusualOp[]; total: number }>(`/laft/unusual?${params}`);
      setData(res.rows);
      setTotal(res.total);
    } catch (e) {
      // Se vacía lo que había: dejar filas viejas bajo un cartel de error es enseñar contrapartes
      // que ya no se sabe si siguen ahí, con su documento al lado.
      setData([]);
      setTotal(0);
      setError(errorMessage(e));
    }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const estado: EstadoUi = loading ? 'loading' : error ? 'error' : data.length === 0 ? 'empty' : 'ready';

  const columnas: ColumnaTabla<UnusualOp>[] = [
    { key: 'detectada', header: 'Detectada', render: (op) => <span className="text-xs text-text-secondary">{new Date(op.detectedAt).toLocaleDateString('es-CO')}</span> },
    {
      key: 'contraparte',
      header: 'Contraparte',
      render: (op) => op.counterpartyName ? (
        <div>
          <p className="text-sm text-text-primary">{op.counterpartyName}</p>
          <p className="mono text-text-tertiary">{op.counterpartyDoc}</p>
        </div>
      ) : <span className="text-xs italic text-text-tertiary">Sin contraparte</span>,
    },
    { key: 'origen', header: 'Origen', render: (op) => <span className="text-xs text-text-secondary">{op.source.replace(/_/g, ' ')}</span> },
    {
      key: 'monto',
      header: 'Monto',
      render: (op) => <span className="text-xs font-semibold tabular-nums text-text-primary">{op.amount ? `${Number(op.amount).toLocaleString('es-CO')} ${op.currency}` : '—'}</span>,
    },
    {
      key: 'senales',
      header: 'Señales',
      render: (op) => (
        <div className="flex max-w-md flex-wrap gap-1">
          {(op.signals || []).slice(0, 3).map((s, i) => <StatusChip key={i} tone="warning">{s}</StatusChip>)}
          {(op.signals || []).length > 3 && <span className="text-[11px] text-text-tertiary">+{op.signals.length - 3}</span>}
        </div>
      ),
    },
    { key: 'decision', header: 'Decisión', render: (op) => <StatusChip tone={DECISION_LABEL[op.decision].tone}>{DECISION_LABEL[op.decision].label}</StatusChip> },
    {
      key: 'acciones',
      header: 'Acciones',
      align: 'right',
      acciones: true,
      render: (op) => (
        <GradientButton type="button" variant="secondary" size="sm" onClick={() => { setEditing(op); setShowForm(true); }}>
          Analizar
        </GradientButton>
      ),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Operaciones inusuales"
        subtitle="Detección y análisis de señales de alerta sobre la operación"
        icono="flito-laft"
        miga={MIGA}
        actions={<GradientButton type="button" onClick={() => { setEditing(null); setShowForm(true); }}>Registrar señal</GradientButton>}
      />

      <section className="flex flex-wrap items-center gap-3 rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={inputCls + ' sm:max-w-xs'}>
          <option value="">Todas las decisiones</option>
          {Object.entries(DECISION_LABEL).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}
        </select>
        {/* Bug #11768 — el contador va guardado por `!error` igual que el cuerpo de la tabla, y no
            es un detalle: bajo un 500 esta línea decía «0 operaciones registradas» a 20 px del
            cartel de error, que es LA MISMA afirmación que el Bug corrige, dicha por la cabecera.
            Se oculta en vez de pintar «—» porque el estado de error de abajo ya explica por qué no
            hay número, y un guion suelto junto a un filtro se lee como «cero». */}
        {!error && <span className="text-xs text-text-tertiary">{total} operaciones registradas</span>}
      </section>

      <EstadoVista
        status={estado}
        cargando="Cargando..."
        onRetry={load}
        errorMessage={`No se pudo cargar el listado de operaciones inusuales. ${error ?? ''}`}
        emptyMessage="Sin operaciones registradas"
      >
        <DataTable ariaLabel="Operaciones inusuales" columnas={columnas} filas={data} getKey={(op) => String(op.id)} />
      </EstadoVista>

      {showForm && (
        <UnusualForm
          editing={editing}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={load}
        />
      )}
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

function UnusualForm({ editing, onClose, onSaved }: { editing: UnusualOp | null; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const isEdit = editing !== null;
  const [form, setForm] = useState({
    source: editing?.source ?? SOURCE_OPTIONS[0],
    counterpartyId: editing?.counterpartyId ?? null as number | null,
    amount: editing?.amount ?? '',
    currency: editing?.currency ?? 'COP',
    description: editing?.description ?? '',
    signalsText: (editing?.signals ?? []).join('\n'),
    analysisText: '',
    decision: editing?.decision ?? 'pendiente' as Decision,
    decisionReason: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const signals = form.signalsText.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!isEdit) {
        if (signals.length === 0) { toast.error('Indique al menos una señal de alerta'); setSubmitting(false); return; }
        if (form.description.trim().length < 10) { toast.error('Descripción muy corta'); setSubmitting(false); return; }
        await api.post('/laft/unusual', {
          source: form.source,
          counterpartyId: form.counterpartyId,
          amount: form.amount ? Number(form.amount) : undefined,
          currency: form.currency,
          description: form.description,
          signals,
        });
        toast.success('Operación registrada');
      } else {
        if ((form.decision === 'descartada' || form.decision === 'reportada') && !form.decisionReason.trim()) {
          toast.error('Esta decisión requiere justificación'); setSubmitting(false); return;
        }
        await api.patch(`/laft/unusual/${editing!.id}`, {
          analysisText: form.analysisText || undefined,
          decision: form.decision,
          decisionReason: form.decisionReason || undefined,
          version: editing!.version,
        });
        toast.success('Decisión actualizada');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error guardando');
    } finally { setSubmitting(false); }
  };

  return (
    <FlitModal title={isEdit ? 'Análisis y decisión' : 'Registrar señal'} onClose={onClose} icono={isEdit ? 'lapiz' : 'alerta'}>
      <form onSubmit={submit} className="space-y-4">
        {!isEdit && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Origen / motivo">
                <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className={inputCls}>
                  {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </Field>
              <Field label="ID contraparte (opcional)">
                <input
                  type="number"
                  value={form.counterpartyId ?? ''}
                  onChange={(e) => setForm({ ...form, counterpartyId: e.target.value ? Number(e.target.value) : null })}
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Monto"><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} /></Field>
              <Field label="Moneda"><input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} maxLength={10} className={inputCls} /></Field>
            </div>
            <Field label="Señales (una por línea)">
              <textarea
                value={form.signalsText}
                onChange={(e) => setForm({ ...form, signalsText: e.target.value })}
                rows={3}
                className={inputCls + ' resize-none'}
                placeholder="Pago en efectivo arriba de 50M&#10;Cambio súbito de patrón&#10;Operación con país de alto riesgo"
              />
            </Field>
            <Field label="Descripción detallada">
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={4}
                required
                minLength={10}
                className={inputCls + ' resize-none'}
              />
            </Field>
          </>
        )}
        {isEdit && (
          <>
            <Fichas items={[
              { etiqueta: 'Origen', valor: editing!.source.replace(/_/g, ' ') },
              { etiqueta: 'Descripción original', valor: editing!.description },
            ]} />
            <Field label="Análisis del Empleado de Cumplimiento">
              <textarea
                value={form.analysisText}
                onChange={(e) => setForm({ ...form, analysisText: e.target.value })}
                rows={5}
                className={inputCls + ' resize-none'}
                placeholder="Resultado del análisis: contexto, validaciones, conclusión..."
              />
            </Field>
            <Field label="Decisión">
              <select value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value as Decision })} className={inputCls}>
                {Object.entries(DECISION_LABEL).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}
              </select>
            </Field>
            {(form.decision === 'descartada' || form.decision === 'reportada') && (
              <Field label="Justificación (obligatoria para esta decisión)">
                <textarea
                  value={form.decisionReason}
                  onChange={(e) => setForm({ ...form, decisionReason: e.target.value })}
                  rows={3}
                  required
                  className={inputCls + ' resize-none'}
                />
              </Field>
            )}
          </>
        )}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="alerta" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando...' : isEdit ? 'Guardar decisión' : 'Registrar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
