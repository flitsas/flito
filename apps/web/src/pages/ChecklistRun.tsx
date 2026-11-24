import { useEffect, useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { FlitCard, FlitField, flitInp, flitBtnSecondarySm } from '../components/flit/flitPageKit';
import '../components/fleet/estados-checklists';

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

// Respuesta elegida: relleno del color del manual con el texto «sobre relleno» del kit (claro y oscuro).
const OPCION_BASE = 'flit-focus inline-flex h-8 items-center whitespace-nowrap rounded-full px-3.5 text-[0.8125rem] font-semibold transition-[filter] hover:brightness-90 text-[color:var(--kit-sobre-relleno)]';
const OPCION_ACTIVA: Record<ButtonTone, string> = {
  success: `${OPCION_BASE} bg-[var(--kit-verde)]`,
  warning: `${OPCION_BASE} bg-[var(--kit-naranja)]`,
  danger: `${OPCION_BASE} bg-[var(--kit-rojo)]`,
};

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
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Nuevo checklist preoperacional"
        subtitle="Inspeccione cada ítem antes de iniciar la jornada. Su PIN firma digitalmente."
        icono="flito-checklists"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }, { etiqueta: 'Checklists preoperacionales', to: '/pesv/checklists' }]}
      />

      <form onSubmit={submit} className="flex w-full max-w-3xl flex-col gap-4">
        <FlitCard className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FlitField label="Plantilla *">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={flitInp}>
              <option value="">— seleccione —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.titulo}</option>)}
            </select>
          </FlitField>
          <FlitField label="Vehículo *">
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={flitInp}>
              <option value="">— seleccione —</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate || `#${v.id}`} {v.alias ? `· ${v.alias}` : ''}</option>)}
            </select>
          </FlitField>
          <FlitField label="Odómetro actual (km)"><input type="number" value={medicion} onChange={(e) => setMedicion(e.target.value)} className={flitInp} /></FlitField>
        </FlitCard>

        {items.length > 0 && (
          <FlitCard className="!p-0 overflow-hidden">
            <div className="border-b border-[color:var(--color-border)] bg-[var(--kit-hover)] px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">Items ({items.length})</div>
            <ul>
              {items.map((it) => {
                const cur = responses.get(it.id);
                return (
                  <li key={it.id} className="border-b border-[color:var(--color-border)] px-4 py-4 last:border-0 sm:px-5">
                    <div className="mb-3 flex items-start justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{it.label}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--color-text-tertiary)]">
                          {it.categoria || '—'}
                          {it.obligatorio && <EtiquetaEstado estado="item-obligatorio">obligatorio</EtiquetaEstado>}
                          {it.critico && <EtiquetaEstado estado="item-critico">crítico</EtiquetaEstado>}
                        </p>
                      </div>
                    </div>
                    {it.criterio === 'booleano' && (
                      <div className="flex flex-wrap gap-2">
                        <ButtonGroup options={[
                          { value: true, label: 'Sí', tone: 'success' as ButtonTone },
                          { value: false, label: 'No', tone: 'danger' as ButtonTone },
                        ]} selected={cur?.valorBool} onSelect={(v) => setResp(it.id, { valorBool: v as boolean })} />
                      </div>
                    )}
                    {it.criterio === 'tres_estados' && (
                      <div className="flex flex-wrap gap-2">
                        <ButtonGroup options={[
                          { value: 'bueno', label: 'Bueno', tone: 'success' as ButtonTone },
                          { value: 'regular', label: 'Regular', tone: 'warning' as ButtonTone },
                          { value: 'malo', label: 'Malo', tone: 'danger' as ButtonTone },
                        ]} selected={cur?.valorEstado} onSelect={(v) => setResp(it.id, { valorEstado: v as 'bueno' | 'regular' | 'malo' })} />
                      </div>
                    )}
                    {it.criterio === 'numerico' && (
                      <input type="number" value={cur?.valorNum ?? ''} onChange={(e) => setResp(it.id, { valorNum: parseFloat(e.target.value) })} className={flitInp} />
                    )}
                    <input
                      value={cur?.observacion ?? ''}
                      onChange={(e) => setResp(it.id, { observacion: e.target.value })}
                      placeholder="Observación (opcional)"
                      maxLength={500}
                      className={`${flitInp} mt-3`}
                    />
                  </li>
                );
              })}
            </ul>
          </FlitCard>
        )}

        <FlitCard className="flex flex-col gap-4">
          <FlitField label="Observaciones generales">
            <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={2000} rows={2} className={flitInp} />
          </FlitField>
          <FlitField label="PIN del conductor (4-6 dígitos) *">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} className={`${flitInp} text-lg tracking-widest`} />
          </FlitField>
          <p className="text-[11px] text-[color:var(--color-text-tertiary)]">¿No tiene PIN? Configúrelo en el endpoint <code>/api/drivers/checklists/me/set-pin</code> antes de continuar.</p>
        </FlitCard>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <GradientButton type="button" variant="secondary" onClick={() => navigate('/pesv/checklists')}>Cancelar</GradientButton>
          <GradientButton type="submit" variant="success" disabled={submitting || items.length === 0}>{submitting ? 'Registrando…' : 'Firmar y enviar'}</GradientButton>
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
          className={selected === opt.value ? OPCION_ACTIVA[opt.tone] : `flit-focus ${flitBtnSecondarySm} font-semibold`}
        >
          {opt.label}
        </button>
      ))}
    </>
  );
}
