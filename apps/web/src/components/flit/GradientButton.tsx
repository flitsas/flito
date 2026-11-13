import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Botón del UI Kit 2026 (`.btn` de la propuesta; Button de flit develop packages/ui). Píldora plana, sin degradado
 * ni sombra (el nombre se conserva por compatibilidad). Color según función:
 *   primary = avanza (azul) · secondary = navega/secundario (tinta) · success = confirma (verde, texto tinta)
 *   · alerta = destructivo/cancelar (naranja) · ghost = enlace subrayado.
 * Marcador estable para E2E: `data-variante="primario|secundario|confirmar|alerta|ghost"`.
 */
export type VarianteBoton = 'primary' | 'success' | 'secondary' | 'alerta' | 'ghost';

const CLASE: Record<VarianteBoton, string> = {
  primary: 'btn', success: 'btn positiva', secondary: 'btn secondary', alerta: 'btn alerta', ghost: 'btn ghost',
};
const DATA: Record<VarianteBoton, string> = {
  primary: 'primario', success: 'confirmar', secondary: 'secundario', alerta: 'alerta', ghost: 'ghost',
};

interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: VarianteBoton;
  /** `sm`: 36 px de alto (barras y filas). Por defecto 44 px. */
  size?: 'sm' | 'md';
  /** Muestra el girador del kit y deshabilita el botón. */
  ocupado?: boolean;
  children: ReactNode;
}

export function claseBoton(variant: VarianteBoton = 'primary', size: 'sm' | 'md' = 'md', extra = ''): string {
  return `${CLASE[variant]}${size === 'sm' ? ' sm' : ''}${extra ? ` ${extra}` : ''}`;
}

export default function GradientButton({
  variant = 'primary',
  size = 'md',
  ocupado = false,
  children,
  className = '',
  disabled,
  ...rest
}: GradientButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || ocupado}
      aria-busy={ocupado || undefined}
      data-variante={DATA[variant]}
      className={claseBoton(variant, size, className)}
    >
      {children}
    </button>
  );
}
