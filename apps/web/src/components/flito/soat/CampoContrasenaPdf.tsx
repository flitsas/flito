// Campo de la contraseña de un PDF protegido (BUG 14569).
//
// La clave vive SOLO en el estado del componente que lo usa y viaja en el cuerpo multipart: nunca
// en la URL, en `localStorage` ni en `console`. `autoComplete="off"` para que el navegador no la
// guarde como si fuera la de FLITO.

import { useId } from 'react';
import { flitInp } from '../../flit/flitPageKit';

export default function CampoContrasenaPdf({ label, rotulo, valor, onCambio, disabled, autoFocus, ayuda }: {
  /** Nombre accesible del campo (lleva el archivo: único en la lista). */
  label: string;
  /** Texto visible del rótulo cuando el archivo ya se lee arriba (p. ej. «Contraseña»). Por defecto, `label`. */
  rotulo?: string;
  valor: string;
  onCambio: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Texto bajo el campo (p. ej. «La contraseña no abre este PDF»), anunciado con el input. */
  ayuda?: string | null;
}) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block break-all text-[11px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        {rotulo ?? label}
      </label>
      <input id={id} aria-label={rotulo ? label : undefined} type="password" autoComplete="off" spellCheck={false} maxLength={128}
        className={flitInp} value={valor} disabled={disabled} autoFocus={autoFocus}
        aria-describedby={ayuda ? idAyuda : undefined} aria-invalid={ayuda ? true : undefined}
        onChange={(e) => onCambio(e.target.value)} />
      {ayuda && (
        <p id={idAyuda} className="mt-1 text-xs" style={{ color: 'var(--kit-rojo-texto)' }}>{ayuda}</p>
      )}
    </div>
  );
}
