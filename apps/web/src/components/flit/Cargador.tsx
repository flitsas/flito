import type { ReactNode } from 'react';
import { Icono } from './kit/Icono';
import GradientButton from './GradientButton';

/**
 * Cargador del UI Kit 2026 (`.cargador`, 132 px): pista azul fija, carrito y línea turquesa girando en sentidos
 * contrarios (2,4 s / 3,2 s); se detiene con reduced-motion. Marcador E2E: data-kit="cargador" role="status" aria-busy.
 */
export function Cargador({ texto = 'Cargando…', className = '' }: { texto?: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-kit="cargador" className={`kit-vacio ${className}`}>
      <span className="cargador" aria-hidden="true">
        <img className="cargador__pista" src="/kit/carga-pista.svg" alt="" />
        <span className="cargador__linea"><img src="/kit/carga-linea.svg" alt="" /></span>
        <span className="cargador__carro"><img src="/kit/carga-carro.svg" alt="" /></span>
      </span>
      <p>{texto}</p>
    </div>
  );
}

/** Girador de 16 px para dentro de botones y líneas (el `.girador` del kit). */
export function Girador({ className = '' }: { className?: string }) {
  return <Icono nombre="girador" size={16} className={`animate-spin motion-reduce:animate-none ${className}`} />;
}

/** Vacío del kit (`.vacio`): disco 72 hover con ícono gris, texto gris 600 y siguiente paso. */
export function Vacio({ texto, detalle, icono = 'carpeta', accion }: {
  texto: string; detalle?: string; icono?: Parameters<typeof Icono>[0]['nombre']; accion?: ReactNode;
}) {
  return (
    <div className="kit-vacio" data-kit="vacio">
      <Icono nombre={icono} disco size={72} />
      <p>{texto}</p>
      {detalle && <small>{detalle}</small>}
      {accion}
    </div>
  );
}

/** Error del kit: disco con nube-alerta naranja, mensaje y reintento. */
export function ErrorVista({ texto, onReintentar }: { texto: string; onReintentar?: () => void }) {
  return (
    <div className="kit-vacio" role="alert" data-kit="error">
      <span className="kit-disco h-[72px] w-[72px] !text-[color:var(--kit-naranja)]"><Icono nombre="nube-alerta" size={36} /></span>
      <p className="!text-[color:var(--color-text-primary)]">{texto}</p>
      {onReintentar && (
        <GradientButton variant="secondary" size="sm" onClick={onReintentar}>
          <Icono nombre="reintento" size={16} />
          Reintentar
        </GradientButton>
      )}
    </div>
  );
}

export type EstadoUi = 'loading' | 'empty' | 'error' | 'ready';

/**
 * Los 4 estados de una vista con datos (regla 9), con las piezas del kit (UiStateBoundary de flit develop).
 * `ready` pinta los hijos. data-testid ui-loading / ui-empty / ui-error como en flit.
 */
export function EstadoVista({
  status, children, emptyMessage = 'No hay información para mostrar.', emptyDetalle, emptyCta,
  errorMessage = 'No pudimos cargar la información.', onRetry, cargando = 'Cargando…',
}: {
  status: EstadoUi; children?: ReactNode; emptyMessage?: string; emptyDetalle?: string; emptyCta?: ReactNode;
  errorMessage?: string; onRetry?: () => void; cargando?: string;
}) {
  if (status === 'loading') return <div data-testid="ui-loading"><Cargador texto={cargando} /></div>;
  if (status === 'error') return <div data-testid="ui-error"><ErrorVista texto={errorMessage} onReintentar={onRetry} /></div>;
  if (status === 'empty') return <div data-testid="ui-empty"><Vacio texto={emptyMessage} detalle={emptyDetalle} accion={emptyCta} /></div>;
  return <>{children}</>;
}
export const UiStateBoundary = EstadoVista;
