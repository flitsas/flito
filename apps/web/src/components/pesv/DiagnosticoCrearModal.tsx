// Modal creación diagnóstico PESV. Extraído de PesvDiagnostico.tsx (chunk B) para
// mantener la página principal ≤400L. Permite seleccionar nivel de empresa (Básico /
// Estándar / Avanzado) con criterios visibles y registrar justificación opcional
// (trazabilidad Ley 1581, decisión PO 2026-05-12).
//
// Microcopy MOLANO: Res. 40595/2022 anexo metodológico.
import { useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import type { NivelEmpresa } from '../../types/pesv';

interface CreateForm {
  anio: number; fecha: string; nivelEmpresa: NivelEmpresa;
  nivelCriterioJustificacion: string; observaciones: string;
}

const NIVELES: { value: NivelEmpresa; label: string; criterio: string }[] = [
  { value: 'basico', label: 'Básico', criterio: 'Flota ≤10 vehículos · servicio propio · no misional' },
  { value: 'estandar', label: 'Estándar', criterio: '11–50 vehículos o servicio mixto' },
  { value: 'avanzado', label: 'Avanzado', criterio: '>50 vehículos · transporte público · misional · carga' },
];

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium" style={{ color: 'var(--flit-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

export interface DiagnosticoCrearModalProps {
  onClose: () => void;
  onCreated: (id: number) => void;
}

export default function DiagnosticoCrearModal({ onClose, onCreated }: DiagnosticoCrearModalProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<CreateForm>({
    anio: new Date().getFullYear(),
    fecha: today,
    nivelEmpresa: 'avanzado',
    nivelCriterioJustificacion: '',
    observaciones: '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: number; anio: number; count: number }>('/pesv/diagnostico', {
        anio: form.anio,
        fecha: form.fecha,
        nivelEmpresa: form.nivelEmpresa,
        nivelCriterioJustificacion: form.nivelCriterioJustificacion.trim() || null,
        observaciones: form.observaciones.trim() || null,
      });
      toast.success(`Diagnóstico ${r.anio} creado con ${r.count} estándares en estado pendiente`);
      onCreated(r.id);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  // FLIT-CLEANUP-08 PR1: modal unificado vía FlitModal. El nombre accesible del
  // diálogo lo provee `title` (aria-label) → "Nuevo diagnóstico PESV", igual que
  // antes (E2E `getByRole('dialog', { name: /Nuevo diagnóstico PESV/i })`).
  return (
    <FlitModal title="Nuevo diagnóstico PESV" onClose={onClose} wide>
        <p className="mb-5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Res. 40595/2022 anexo metodológico · auto-clasificación con justificación opcional Ley 1581/2012.</p>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <Field label="Año">
            <input type="number" min={2020} max={2100} value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value, 10) || form.anio })} className={inputCls} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} className={inputCls} />
          </Field>
        </div>

        <fieldset className="mb-3">
          <legend className="mb-2 block text-[11px] font-medium" style={{ color: 'var(--flit-text-secondary)' }}>Nivel de empresa</legend>
          <div className="space-y-2">
            {NIVELES.map((n) => {
              const on = form.nivelEmpresa === n.value;
              return (
                <label key={n.value} className="flex cursor-pointer items-start gap-3 rounded-[12px] p-3 transition-colors" style={on
                  ? { border: '1px solid var(--flit-blue)', background: 'rgba(79,116,201,0.10)' }
                  : { border: '1px solid var(--flit-border-soft)', background: '#fff' }}>
                  <input type="radio" name="nivelEmpresa" value={n.value} checked={on} onChange={() => setForm({ ...form, nivelEmpresa: n.value })} className="mt-1" style={{ accentColor: 'var(--flit-blue)' }} />
                  <div>
                    <span className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{n.label}</span>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{n.criterio}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Field label="Justificación del nivel (opcional, trazabilidad Ley 1581)">
          <textarea value={form.nivelCriterioJustificacion} onChange={(e) => setForm({ ...form, nivelCriterioJustificacion: e.target.value.slice(0, 2000) })} rows={2} maxLength={2000} placeholder="Tamaño de flota, tipo de servicio, misionalidad..." className={inputCls} />
        </Field>
        <div className="mt-3">
          <Field label="Observaciones (opcional)">
            <textarea value={form.observaciones} onChange={(e) => setForm({ ...form, observaciones: e.target.value.slice(0, 2000) })} rows={2} maxLength={2000} className={inputCls} />
          </Field>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Cancelar</button>
          <button onClick={submit} disabled={busy} className="flit-focus inline-flex h-10 items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55" style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>{busy ? 'Creando…' : 'Crear diagnóstico'}</button>
        </div>
    </FlitModal>
  );
}
