// FLITO — piezas que comparten los tres formularios de usuario (alta, edición y contraseña).
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Igual que `AtaduraFields.tsx`, no vive en `components/flit/` y solo lo
// importan los formularios de esta carpeta: son el envoltorio de etiqueta, el pie de modal y la
// clase del input que ya existían dentro de la página, movidos tal cual para que los tres
// formularios pudieran salir a archivos propios.

import { errorMessage } from '../../lib/api';
import GradientButton from '../../components/flit/GradientButton';

export const PASSWORD_PATTERN = '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[!@#$%^&*]).{8,}$';
export const PASSWORD_TITLE = 'Mín 8 caracteres con minúscula, mayúscula, número y un especial (!@#$%^&*)';
// Input FLIT: blanco, borde `--flit-border-input`, foco azul (.flit-focus bajo .flit-app).
export const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export const formatErrors = errorMessage;

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}

export function Footer({ onClose, submitting, label }: { onClose: () => void; submitting: boolean; label: string }) {
  return (
    <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <button
        type="button"
        onClick={onClose}
        className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium transition-colors"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
      >
        Cancelar
      </button>
      <GradientButton type="submit" disabled={submitting}>
        {submitting ? 'Guardando...' : label}
      </GradientButton>
    </div>
  );
}
