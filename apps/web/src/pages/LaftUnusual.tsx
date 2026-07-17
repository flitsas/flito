import { useEffect, useState, useCallback, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

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

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function LaftUnusual() {
  const [data, setData] = useState<UnusualOp[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UnusualOp | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filter) params.set('decision', filter);
      const res = await api.get<{ rows: UnusualOp[]; total: number }>(`/laft/unusual?${params}`);
      setData(res.rows);
      setTotal(res.total);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Operaciones inusuales"
        subtitle="Detección y análisis de señales de alerta sobre la operación"
        actions={<GradientButton type="button" onClick={() => { setEditing(null); setShowForm(true); }}>Registrar señal</GradientButton>}
      />

      <section className="flex flex-wrap items-center gap-3 bg-white p-4" style={CARD}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={inputCls + ' max-w-xs'}>
          <option value="">Todas las decisiones</option>
          {Object.entries(DECISION_LABEL).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{total} operaciones registradas</span>
      </section>

      <section className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Detectada</Th><Th>Contraparte</Th><Th>Origen</Th><Th>Monto</Th><Th>Señales</Th><Th>Decisión</Th><Th className="text-right">Acciones</Th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && data.length === 0 && <tr><td colSpan={7} className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin operaciones registradas</td></tr>}
              {!loading && data.map((op) => {
                const d = DECISION_LABEL[op.decision];
                return (
                  <tr key={op.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{new Date(op.detectedAt).toLocaleDateString('es-CO')}</td>
                    <td className="px-4 py-3">
                      {op.counterpartyName ? (
                        <div>
                          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{op.counterpartyName}</p>
                          <p className="font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{op.counterpartyDoc}</p>
                        </div>
                      ) : <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin contraparte</span>}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{op.source.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                      {op.amount ? `${Number(op.amount).toLocaleString('es-CO')} ${op.currency}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-md flex-wrap gap-1">
                        {(op.signals || []).slice(0, 3).map((s, i) => <StatusChip key={i} tone="warning">{s}</StatusChip>)}
                        {(op.signals || []).length > 3 && <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>+{op.signals.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusChip tone={d.tone}>{d.label}</StatusChip></td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => { setEditing(op); setShowForm(true); }}
                        className="flit-focus inline-flex h-7 items-center rounded-[999px] px-2.5 text-xs font-semibold"
                        style={{ background: 'rgba(79,116,201,0.14)', color: 'var(--flit-blue)' }}
                      >
                        Analizar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide ${className}`} style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{label}</span>
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
    <FlitModal title={isEdit ? 'Análisis y decisión' : 'Registrar señal'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!isEdit && (
          <>
            <div className="grid grid-cols-2 gap-3">
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
            <div className="grid grid-cols-3 gap-3">
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
            <div className="rounded-[12px] p-4" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Origen</p>
              <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{editing!.source.replace(/_/g, ' ')}</p>
              <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Descripción original</p>
              <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{editing!.description}</p>
            </div>
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
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando...' : isEdit ? 'Guardar decisión' : 'Registrar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
