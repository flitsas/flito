import { useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useEscape, useBackdropClose } from '../../lib/hooks';
import { Icono } from '../flit/kit/Icono';
import GradientButton from '../flit/GradientButton';
import ModalPortal from '../flit/ModalPortal';

const DOC_TYPES = [
  { v: 'CC', l: 'Cédula de ciudadanía' },
  { v: 'CE', l: 'Cédula de extranjería' },
  { v: 'NIT', l: 'NIT (PJ)' },
  { v: 'PAS', l: 'Pasaporte' },
  { v: 'TI', l: 'Tarjeta de identidad' },
  { v: 'PEP', l: 'Permiso especial de permanencia' },
];

interface BeneficialOwner {
  docType: string;
  docNumber: string;
  fullName: string;
  ownershipPct: number;
  isPep: boolean;
}

interface FormState {
  kind: 'PN' | 'PJ';
  docType: string;
  docNumber: string;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  economicActivity: string;
  ciiu: string;
  fundOrigin: string;
  isPep: boolean;
  pepRole: string;
  pepKinship: string;
  factorCounterparty: number;
  factorProduct: number;
  factorChannel: number;
  factorJurisdiction: number;
  beneficialOwners: BeneficialOwner[];
}

const initial: FormState = {
  kind: 'PN', docType: 'CC', docNumber: '', fullName: '', email: '', phone: '', city: '', country: 'Colombia',
  economicActivity: '', ciiu: '', fundOrigin: '', isPep: false, pepRole: '', pepKinship: '',
  factorCounterparty: 1, factorProduct: 1, factorChannel: 1, factorJurisdiction: 1, beneficialOwners: [],
};

const FACTOR_LABELS = ['', 'Bajo', 'Medio', 'Alto'];

type Semantic = 'success' | 'warning' | 'danger';

function previewRisk(f: FormState): { level: string; tone: Semantic; review: string } {
  const score = f.factorCounterparty + f.factorProduct + f.factorChannel + f.factorJurisdiction;
  if (score >= 10) return { level: 'ALTO', tone: 'danger', review: '6 meses' };
  if (score >= 7) return { level: 'MEDIO', tone: 'warning', review: '12 meses' };
  return { level: 'BAJO', tone: 'success', review: '24 meses' };
}

/** Vista previa del riesgo con la pieza `.kit-alerta` (sin `role`: cambia con cada factor y no debe interrumpir). */
const TONO_ALERTA: Record<Semantic, 'ok' | 'warn' | 'danger'> = { success: 'ok', warning: 'warn', danger: 'danger' };
const ICONO_ALERTA: Record<Semantic, string> = { success: '/kit/aviso-ok.svg', warning: '/kit/aviso-alerta.svg', danger: '/kit/aviso-error.svg' };
const SECCION = 'mb-2 text-[0.8125rem] font-semibold text-text-primary';

export default function CounterpartyForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState<FormState>(initial);
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const addBO = () => set('beneficialOwners', [...f.beneficialOwners, { docType: 'CC', docNumber: '', fullName: '', ownershipPct: 5, isPep: false }]);
  const removeBO = (i: number) => set('beneficialOwners', f.beneficialOwners.filter((_, idx) => idx !== i));
  const updateBO = (i: number, patch: Partial<BeneficialOwner>) =>
    set('beneficialOwners', f.beneficialOwners.map((bo, idx) => idx === i ? { ...bo, ...patch } : bo));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (f.kind === 'PJ' && f.beneficialOwners.length === 0) { toast.error('PJ requiere al menos un beneficiario final ≥5%'); return; }
    if (f.isPep && (!f.pepRole || !f.pepKinship)) { toast.error('Si es PEP, indique cargo y vínculo'); return; }
    if (f.fundOrigin.trim().length < 10) { toast.error('Declaración de origen de fondos muy corta'); return; }
    for (let i = 0; i < f.beneficialOwners.length; i++) {
      const bo = f.beneficialOwners[i];
      if (!bo.docNumber.trim() || bo.docNumber.length < 3) { toast.error(`Beneficiario ${i + 1}: documento inválido`); return; }
      if (!bo.fullName.trim() || bo.fullName.length < 2) { toast.error(`Beneficiario ${i + 1}: nombre requerido`); return; }
      if (bo.ownershipPct < 5 || bo.ownershipPct > 100) { toast.error(`Beneficiario ${i + 1}: % participación 5-100`); return; }
    }

    setSubmitting(true);
    try {
      await api.post('/laft/counterparties', {
        ...f,
        docNumber: f.docNumber.trim().toUpperCase(),
        fullName: f.fullName.trim(),
      });
      toast.success('Contraparte registrada');
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error registrando');
    } finally {
      setSubmitting(false);
    }
  };

  const risk = previewRisk(f);

  return (
    <ModalPortal>
    <div className="flit-modal kit-velo items-start justify-center p-3 sm:p-6" {...useBackdropClose(onClose)}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Nueva contraparte"
        className="kit-modal my-auto max-w-3xl"
      >
        <div className="kit-modal__cabeza">
          <Icono nombre="persona" disco size={52} />
          <h2 className="kit-modal__titulo">Nueva contraparte</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="kit-modal__cerrar">
            <Icono nombre="cerrar" size={20} />
          </button>
        </div>

        <div className="kit-modal__cuerpo space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Tipo">
              <select value={f.kind} onChange={(e) => set('kind', e.target.value as 'PN' | 'PJ')} className={inputCls}>
                <option value="PN">Persona Natural</option>
                <option value="PJ">Persona Jurídica</option>
              </select>
            </Field>
            <Field label="Documento">
              <select value={f.docType} onChange={(e) => set('docType', e.target.value)} className={inputCls}>
                {DOC_TYPES.map((d) => <option key={d.v} value={d.v}>{d.v} — {d.l}</option>)}
              </select>
            </Field>
            <Field label="Número">
              <input value={f.docNumber} onChange={(e) => set('docNumber', e.target.value)} required maxLength={20} className={inputCls} />
            </Field>
          </div>

          <Field label={f.kind === 'PJ' ? 'Razón social' : 'Nombre completo'}>
            <input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} required minLength={2} maxLength={200} className={inputCls} />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Email"><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={150} className={inputCls} /></Field>
            <Field label="Teléfono"><input value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={20} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Ciudad"><input value={f.city} onChange={(e) => set('city', e.target.value)} maxLength={100} className={inputCls} /></Field>
            <Field label="País"><input value={f.country} onChange={(e) => set('country', e.target.value)} maxLength={80} className={inputCls} /></Field>
            <Field label="CIIU"><input value={f.ciiu} onChange={(e) => set('ciiu', e.target.value)} maxLength={10} placeholder="6202" className={inputCls} /></Field>
          </div>
          <Field label="Actividad económica">
            <input value={f.economicActivity} onChange={(e) => set('economicActivity', e.target.value)} maxLength={200} className={inputCls} />
          </Field>

          <Field label="Declaración de origen de fondos">
            <textarea
              value={f.fundOrigin}
              onChange={(e) => set('fundOrigin', e.target.value)}
              required
              minLength={10}
              maxLength={2000}
              rows={3}
              className={inputCls + ' resize-none'}
              placeholder="El titular declara que los recursos provienen de actividades lícitas, específicamente..."
            />
          </Field>

          <div className="rounded-[9px] border border-[color:var(--kit-naranja)] p-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-[color:var(--kit-naranja-texto)]">
              <input type="checkbox" checked={f.isPep} onChange={(e) => set('isPep', e.target.checked)} className="h-4 w-4 accent-[var(--kit-naranja)]" />
              Persona Expuesta Políticamente (PEP)
            </label>
            {f.isPep && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Cargo público">
                  <input value={f.pepRole} onChange={(e) => set('pepRole', e.target.value)} maxLength={200} className={inputCls} />
                </Field>
                <Field label="Vínculo">
                  <select value={f.pepKinship} onChange={(e) => set('pepKinship', e.target.value)} className={inputCls}>
                    <option value="">Seleccione...</option>
                    <option value="titular">Titular</option>
                    <option value="1er_grado">Familiar 1er grado</option>
                    <option value="2do_grado">Familiar 2do grado</option>
                    <option value="asociado">Asociado cercano</option>
                  </select>
                </Field>
              </div>
            )}
          </div>

          <div>
            <p className={SECCION}>Matriz de riesgo</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FactorSel label="Contraparte" value={f.factorCounterparty} onChange={(v) => set('factorCounterparty', v)} />
              <FactorSel label="Producto/servicio" value={f.factorProduct} onChange={(v) => set('factorProduct', v)} />
              <FactorSel label="Canal" value={f.factorChannel} onChange={(v) => set('factorChannel', v)} />
              <FactorSel label="Jurisdicción" value={f.factorJurisdiction} onChange={(v) => set('factorJurisdiction', v)} />
            </div>
            <div className="kit-alerta mt-4" data-tono={TONO_ALERTA[risk.tone]} data-kit="alerta">
              <img src={ICONO_ALERTA[risk.tone]} alt="" aria-hidden="true" className="kit-alerta__icono" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="m-0 font-semibold">Riesgo {risk.level}</p>
                <p className="mt-0.5 text-xs text-text-secondary">Próxima revisión obligatoria en {risk.review}</p>
              </div>
            </div>
          </div>

          {f.kind === 'PJ' && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="m-0 text-[0.8125rem] font-semibold text-text-primary">Beneficiarios finales (5% o más)</p>
                <GradientButton type="button" variant="secondary" size="sm" onClick={addBO}>
                  Agregar
                </GradientButton>
              </div>
              {f.beneficialOwners.length === 0 && (
                <p className="text-xs italic text-text-tertiary">Agregue al menos uno</p>
              )}
              {f.beneficialOwners.map((bo, i) => (
                <div key={i} className="mb-3 grid grid-cols-2 items-center gap-2 sm:grid-cols-12">
                  <div className="col-span-1 sm:col-span-2">
                    <select value={bo.docType} onChange={(e) => updateBO(i, { docType: e.target.value })} className={inputCls}>
                      {DOC_TYPES.filter((d) => d.v !== 'NIT').map((d) => <option key={d.v} value={d.v}>{d.v}</option>)}
                    </select>
                  </div>
                  <div className="col-span-1 sm:col-span-3">
                    <input placeholder="Documento" value={bo.docNumber} onChange={(e) => updateBO(i, { docNumber: e.target.value })} className={inputCls} />
                  </div>
                  <div className="col-span-2 sm:col-span-5">
                    <input placeholder="Nombre" value={bo.fullName} onChange={(e) => updateBO(i, { fullName: e.target.value })} className={inputCls} />
                  </div>
                  <div className="col-span-1 sm:col-span-1">
                    <input type="number" min={5} max={100} value={bo.ownershipPct} onChange={(e) => updateBO(i, { ownershipPct: Number(e.target.value) })} className={inputCls} />
                  </div>
                  <div className="col-span-1 sm:col-span-1">
                    <button
                      type="button"
                      onClick={() => removeBO(i)}
                      className="flit-focus grid h-10 w-10 place-items-center rounded-full text-[color:var(--kit-naranja-texto)] transition-colors hover:bg-[var(--kit-hover)]"
                      aria-label="Eliminar beneficiario"
                    >
                      <Icono nombre="papelera" size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <GradientButton type="button" variant="alerta" onClick={onClose}>
              Cancelar
            </GradientButton>
            <GradientButton type="submit" disabled={submitting}>
              {submitting ? 'Guardando...' : 'Registrar contraparte'}
            </GradientButton>
          </div>
      </form>
    </div>
    </ModalPortal>
  );
}

const inputCls = 'control';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="campo">
      <span className="etiqueta">{label}</span>
      {children}
    </label>
  );
}

function FactorSel({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={inputCls}>
        <option value={1}>1 — {FACTOR_LABELS[1]}</option>
        <option value={2}>2 — {FACTOR_LABELS[2]}</option>
        <option value={3}>3 — {FACTOR_LABELS[3]}</option>
      </select>
    </Field>
  );
}
