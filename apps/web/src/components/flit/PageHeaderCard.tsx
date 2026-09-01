import type { ReactNode, RefObject } from 'react';

// PageHeaderCard — título de pantalla DENTRO de tarjeta blanca (regla FLIT:
// el título no flota sobre el fondo azul claro). Slot de acciones a la derecha.
interface PageHeaderCardProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  leading?: ReactNode;
  /**
   * Referencia al `<h1>`, para poder llevarle el foco.
   *
   * La necesita cualquier pantalla a la que se llegue tras una acción que cambia de ruta —cargar una
   * boleta y aterrizar en su cuadre (HU #11680)— y cualquier modal que al cerrarse haya hecho
   * desaparecer el botón que lo abrió: sin un destino, el foco se cae a `<body>` y quien navega con
   * teclado empieza otra vez desde el principio del documento. Al pasarla, el título se vuelve
   * enfocable por programa (`tabIndex={-1}`) pero **no** entra en el orden de tabulación.
   */
  titleRef?: RefObject<HTMLHeadingElement>;
}

export default function PageHeaderCard(
  { title, subtitle, actions, leading, titleRef }: PageHeaderCardProps,
) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 bg-flit-card px-6 py-5"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        boxShadow: 'var(--flit-shadow-card)',
        border: '1px solid var(--flit-border-soft)',
      }}
    >
      <div className="flex min-w-0 items-center gap-4">
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
        <h1
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className="text-xl font-bold tracking-tight outline-none"
          style={{ color: 'var(--flit-blue-text)' }}
        >
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
