/** Interruptor del UI Kit 2026: el dibujo del paquete de íconos (68×36; verde encendido, gris apagado). */
import { forwardRef, useId } from 'react';

export interface FlitSwitchProps {
  checked: boolean;
  onToggle: (siguiente: boolean) => void;
  etiqueta: string;
  ocupado?: boolean;
  describedBy?: string;
  testId?: string;
  /** Encendido en naranja: para interruptores cuyo «encendido» es una emergencia o suspensión. */
  alerta?: boolean;
}

const FlitSwitch = forwardRef<HTMLButtonElement, FlitSwitchProps>(function FlitSwitch(
  { checked, onToggle, etiqueta, ocupado = false, describedBy, testId, alerta = false },
  ref,
) {
  const idEtiqueta = useId();
  return (
    <>
      <span id={idEtiqueta} className="sr-only">{etiqueta}</span>
      <button ref={ref} type="button" role="switch" aria-checked={checked}
        aria-labelledby={idEtiqueta} aria-describedby={describedBy}
        aria-disabled={ocupado || undefined} aria-busy={ocupado || undefined}
        data-testid={testId}
        onClick={() => { if (!ocupado) onToggle(!checked); }}
        className={`kit-interruptor${alerta ? ' kit-interruptor--alerta' : ''}`} />
    </>
  );
});

export default FlitSwitch;
