import type { ReactNode } from 'react';

// PageHeaderCard — título de pantalla DENTRO de tarjeta blanca (regla FLIT:
// el título no flota sobre el fondo azul claro). Slot de acciones a la derecha.
interface PageHeaderCardProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  leading?: ReactNode;
}

export default function PageHeaderCard({ title, subtitle, actions, leading }: PageHeaderCardProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 bg-white px-6 py-5"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        boxShadow: 'var(--flit-shadow-card)',
        border: '1px solid var(--flit-border-soft)',
      }}
    >
      <div className="flex min-w-0 items-center gap-4">
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{subtitle}</p>
        )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
