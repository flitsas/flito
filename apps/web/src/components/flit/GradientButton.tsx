import type { ButtonHTMLAttributes, ReactNode } from 'react';

// GradientButton — CTA primario FLIT: pastilla con gradiente turquesa→azul (o
// verde para acciones de éxito), texto blanco. Patrón obligatorio del prototipo
// para acciones principales (prototype_rules.md · Botones primarios).
// Regla: solo texto en el botón — sin icono «+» ni prefijo «+» en la etiqueta.
interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'success';
  children: ReactNode;
}

export default function GradientButton({
  variant = 'primary',
  children,
  className = '',
  ...rest
}: GradientButtonProps) {
  const gradient = variant === 'success' ? 'var(--flit-gradient-success)' : 'var(--flit-gradient-primary)';
  return (
    <button
      {...rest}
      className={`flit-focus inline-flex items-center justify-center gap-2 px-6 text-sm font-semibold text-white
                  transition-transform motion-safe:active:scale-[0.99]
                  disabled:opacity-55 disabled:cursor-not-allowed ${className}`}
      style={{
        height: '44px',
        borderRadius: 'var(--flit-radius-pill)',
        background: gradient,
        boxShadow: 'var(--flit-shadow-button)',
      }}
    >
      {children}
    </button>
  );
}
