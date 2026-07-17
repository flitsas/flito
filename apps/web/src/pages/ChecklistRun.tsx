import { useEffect, useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';

interface Template { id: number; titulo: string; vigente: boolean; }
interface TemplateItem {
  id: number; orden: number; categoria: string | null;
  label: string; criterio: 'booleano' | 'tres_estados' | 'numerico';
  obligatorio: boolean; critico: boolean;
}
interface Vehicle { id: number; plate: string | null; alias: string | null; }

interface Response {
  itemId: number;
  valorBool?: boolean;
  valorEstado?: 'bueno' | 'regular' | 'malo';
  valorNum?: number;
  observacion?: string;
}

type ButtonTone = 'success' | 'warning' | 'danger';

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;
const TONE_VAR: Record<ButtonTone, string> = { success: 'var(--flit-gradient-success)', warning: 'linear-gradient(90deg,#F05A35,#F05A35)', danger: 'var(--flit-gradient-danger)' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
}

export default function ChecklistRun() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [responses, setResponses] = useState<Map<number, Response>>(new Map());
  const [pin, setPin] = useState('');
  const [medicion, setMedicion] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ data: Template[] }>('/drivers/checklists/templates'),
      api.get<{ data: Vehicle[] }>('/fleet/vehicles?limit=500'),
    ]).then(([t, v]) => { setTemplates(t.data); setVehicles(v.data); })
      .catch((err) => toast.error(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!templateId) { setItems([]); return; }
    api.get<{ items: TemplateItem[] }>(`/drivers/checklists/templates/${templateId}`)
      .then((r) => { setItems(r.items); setResponses(new Map()); })
      .catch((err) => toast.error(errorMessage(err)));
  }, [templateId]);

  const setResp = (itemId: number, patch: Partial<Response>) => {
    setResponses((prev) => {
      const next = new Map(prev);
      const cur = next.get(itemId) ?? { itemId };
      next.set(itemId, { ...cur, ...patch });
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!templateId || !vehicleId) { toast.error('Vehículo y plantilla requeridos'); return; }
    if (!/^\d{4,6}$/.test(pin)) { toast.error('PIN debe ser 4-6 dígitos'); return; }

    const arr = Array.from(responses.values());
    const obligatorios = items.filter((it) => it.obligatorio);
    const faltantes = obligatorios.filter((it) => !responses.has(it.id));
    if (faltantes.length > 0) {
      toast.error(`Faltan ${faltantes.length} items obligatorios`);
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        vehicleId: parseInt(vehicleId, 10),
        templateId: parseInt(templateId, 10),
        pin,
        responses: arr,
      };
      if (medicion) body.medicionActual = parseInt(medicion, 10);
      if (observaciones.trim()) body.observacionesGenerales = observaciones.trim();
      const r = await api.post<{ data: { id: number }; decision: string }>('/drivers/checklists', body);
      toast.success(`Checklist registrado — decisión: ${r.decision}`);
      navigate(`/pesv/checklists`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  void user;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Nuevo checklist preoperacional" subtitle="Inspeccione cada ítem antes de iniciar la jornada. Su PIN firma digitalmente." />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 bg-white p-5 md:grid-cols-2" style={CARD}>
          <Field label="Plantilla *">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputCls}>
              <option value="">— seleccione —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.titulo}</option>)}
            </select>
          </Field>
          <Field label="Vehículo *">
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputCls}>
              <option value="">— seleccione —</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate || `#${v.id}`} {v.alias ? `· ${v.alias}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Odómetro actual (km)"><input type="number" value={medicion} onChange={(e) => setMedicion(e.target.value)} className={inputCls} /></Field>
        </div>

        {items.length > 0 && (
          <div className="overflow-hidden bg-white" style={CARD}>
            <div className="border-b px-5 py-3 text-xs font-semibold uppercase tracking-wide" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>Items ({items.length})</div>
            <ul>
              {items.map((it) => {
                const cur = responses.get(it.id);
                return (
                  <li key={it.id} className="border-b px-5 py-3 last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                    <div className="mb-2 flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{it.label}</p>
                        <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                          {it.categoria || '—'}
                          {it.obligatorio && <span className="ml-2" style={{ color: 'var(--flit-danger)' }}>obligatorio</span>}
                          {it.critico && <span className="ml-2" style={{ color: 'var(--flit-warning)' }}>crítico</span>}
                        </p>
                      </div>
                    </div>
                    {it.criterio === 'booleano' && (
                      <div className="flex gap-2">
                        <ButtonGroup options={[
                          { value: true, label: 'Sí', tone: 'success' as ButtonTone },
                          { value: false, label: 'No', tone: 'danger' as ButtonTone },
                        ]} selected={cur?.valorBool} onSelect={(v) => setResp(it.id, { valorBool: v as boolean })} />
                      </div>
                    )}
                    {it.criterio === 'tres_estados' && (
                      <div className="flex gap-2">
                        <ButtonGroup options={[
                          { value: 'bueno', label: 'Bueno', tone: 'success' as ButtonTone },
                          { value: 'regular', label: 'Regular', tone: 'warning' as ButtonTone },
                          { value: 'malo', label: 'Malo', tone: 'danger' as ButtonTone },
                        ]} selected={cur?.valorEstado} onSelect={(v) => setResp(it.id, { valorEstado: v as 'bueno' | 'regular' | 'malo' })} />
                      </div>
                    )}
                    {it.criterio === 'numerico' && (
                      <input type="number" value={cur?.valorNum ?? ''} onChange={(e) => setResp(it.id, { valorNum: parseFloat(e.target.value) })} className={inputCls} />
                    )}
                    <input
                      value={cur?.observacion ?? ''}
                      onChange={(e) => setResp(it.id, { observacion: e.target.value })}
                      placeholder="Observación (opcional)"
                      maxLength={500}
                      className="flit-focus mt-2 w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-1.5 text-xs text-[color:var(--flit-text-primary)] outline-none"
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-3 bg-white p-5" style={CARD}>
          <Field label="Observaciones generales">
            <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} rows={2} className={inputCls} />
          </Field>
          <Field label="PIN del conductor (4-6 dígitos) *">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} className={`${inputCls} text-lg tracking-widest`} />
          </Field>
          <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>¿No tiene PIN? Configúrelo en el endpoint <code>/api/drivers/checklists/me/set-pin</code> antes de continuar.</p>
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => navigate('/pesv/checklists')} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <GradientButton type="submit" disabled={submitting || items.length === 0}>{submitting ? 'Registrando…' : 'Firmar y enviar'}</GradientButton>
        </div>
      </form>
    </div>
  );
}

function ButtonGroup<T>({ options, selected, onSelect }: {
  options: { value: T; label: string; tone: ButtonTone }[];
  selected: T | undefined;
  onSelect: (v: T) => void;
}) {
  return (
    <>
      {options.map((opt) => (
        <button
          type="button"
          key={String(opt.value)}
          onClick={() => onSelect(opt.value)}
          className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold transition-colors"
          style={selected === opt.value
            ? { background: TONE_VAR[opt.tone], color: '#fff' }
            : { border: '1px solid var(--flit-border-input)', background: '#fff', color: 'var(--flit-text-secondary)' }}
        >
          {opt.label}
        </button>
      ))}
    </>
  );
}
