import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

// GradientButton — CTA primario FLIT + variantes de Certificar sin trámite (#14163).
export type VarianteBoton = 'primary' | 'success' | 'secondary' | 'alerta' | 'ghost';

interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: VarianteBoton;
  size?: 'sm' | 'md';
  ocupado?: boolean;
  children: ReactNode;
}

const KIT: Record<'secondary' | 'alerta' | 'ghost', string> = {
  secondary: 'btn secondary',
  alerta: 'btn alerta',
  ghost: 'btn ghost',
};

export function claseBoton(variant: VarianteBoton = 'primary', size: 'sm' | 'md' = 'md', extra = ''): string {
  if (variant === 'primary' || variant === 'success') {
    return `flit-focus inline-flex items-center justify-center gap-2 px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-55 disabled:cursor-not-allowed${size === 'sm' ? ' !h-9 !px-4 !text-xs' : ''}${extra ? ` ${extra}` : ''}`;
  }
  return `${KIT[variant]}${size === 'sm' ? ' sm' : ''}${extra ? ` ${extra}` : ''}`;
}

export default function GradientButton({
  variant = 'primary',
  size = 'md',
  ocupado = false,
  children,
  className = '',
  disabled,
  style,
  ...rest
}: GradientButtonProps) {
  const kit = variant === 'secondary' || variant === 'alerta' || variant === 'ghost';
  const gradient = variant === 'success' ? 'var(--flit-gradient-success)' : 'var(--flit-gradient-primary)';
  const baseStyle: CSSProperties | undefined = kit ? undefined : {
    height: size === 'sm' ? '36px' : '44px',
    borderRadius: 'var(--flit-radius-pill)',
    background: gradient,
    boxShadow: 'var(--flit-shadow-button)',
  };
  return (
    <button
      {...rest}
      disabled={disabled || ocupado}
      aria-busy={ocupado || undefined}
      className={claseBoton(variant, size, className)}
      style={kit ? style : { ...baseStyle, ...style }}
    >
      {children}
    </button>
  );
}
