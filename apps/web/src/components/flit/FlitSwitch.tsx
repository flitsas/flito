// FlitSwitch — interruptor del kit FLITO (HU #13238, spec `docs/ux/flito-tramites-sincronizacion-interruptores.md`).
//
// Reglas:
//   · `<button role="switch" aria-checked>`: Espacio y Enter lo accionan porque es un botón nativo;
//   · nombre accesible por `aria-labelledby` a un texto sr-only (el «label asociado» del AC) y
//     `aria-describedby` al texto de estado visible, que el que lo use pinta fuera;
//   · `ocupado` = aria-disabled + aria-busy, nunca `disabled` nativo: el foco no se pierde mientras se
//     guarda, y un clic en ese estado no hace nada;
//   · área de pulsación h-10 (la altura de control de las barras) con velo de hover y `flit-focus`;
//   · solo tokens `--flit-*` con par oscuro: carril encendido `--flit-blue-text`, apagado
//     `--flit-text-muted`, pulgar `--flit-bg-card`. El desplazamiento del pulgar es feedback de estado
//     (transform + duración del kit) y se apaga con `prefers-reduced-motion`.

import { forwardRef, useId } from 'react';

export interface FlitSwitchProps {
  checked: boolean;
  /** Se llama con el valor pedido; el dueño decide cuándo cambia `checked` (no optimista). */
  onToggle: (siguiente: boolean) => void;
  /** Nombre accesible («Recibir trámites de FLIT 1»). */
  etiqueta: string;
  /** Guardando: queda aria-disabled + aria-busy y conserva el valor. */
  ocupado?: boolean;
  /** ids del texto de estado / motivo. */
  describedBy?: string;
  testId?: string;
}

const FlitSwitch = forwardRef<HTMLButtonElement, FlitSwitchProps>(function FlitSwitch(
  { checked, onToggle, etiqueta, ocupado = false, describedBy, testId },
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
        className={`flit-focus inline-flex h-10 shrink-0 items-center rounded-full px-1 transition-colors ${
          ocupado ? 'cursor-progress' : 'cursor-pointer hover:bg-[var(--flit-bg-hover)]'}`}>
        <span aria-hidden="true" className="relative inline-block h-6 w-11 rounded-full transition-colors"
          style={{ background: checked ? 'var(--flit-blue-text)' : 'var(--flit-text-muted)' }}>
          <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform motion-reduce:transition-none ${
            checked ? 'translate-x-5' : 'translate-x-0'}`}
            style={{ background: 'var(--flit-bg-card)', transitionDuration: 'var(--flit-duration-base)' }} />
        </span>
      </button>
    </>
  );
});

export default FlitSwitch;
