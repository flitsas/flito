// FLITO — piezas que comparten los tres formularios de usuario (alta, edición y contraseña).
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// **Esto NO es kit.** Igual que `AtaduraFields.tsx`, no vive en `components/flit/` y solo lo
// importan los formularios de esta carpeta: son el envoltorio de etiqueta, el pie de modal y la
// clase del input que ya existían dentro de la página, movidos tal cual para que los tres
// formularios pudieran salir a archivos propios.

import { errorMessage } from '../../lib/api';
import GradientButton from '../../components/flit/GradientButton';
import { flitInp } from '../../components/flit/flitPageKit';

export const PASSWORD_PATTERN = '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[!@#$%^&*]).{8,}$';
export const PASSWORD_TITLE = 'Mín 8 caracteres con minúscula, mayúscula, número y un especial (!@#$%^&*)';
// Campo del UI Kit 2026 (`flitInp` = `.control`): borde línea, radio 9, foco azul con la sombra del kit, inválido naranja.
export const inputCls = flitInp;

export const formatErrors = errorMessage;

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>{label}</span>
      {children}
    </label>
  );
}

export function Footer({ onClose, submitting, label }: { onClose: () => void; submitting: boolean; label: string }) {
  return (
    <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
      <GradientButton type="button" variant="secondary" onClick={onClose}>
        Cancelar
      </GradientButton>
      <GradientButton type="submit" disabled={submitting} ocupado={submitting}>
        {submitting ? 'Guardando...' : label}
      </GradientButton>
    </div>
  );
}
