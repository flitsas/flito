import type { ReactNode } from 'react';

/**
 * Aviso en página del UI Kit 2026: borde y fondo semántico al 10 %, ícono aviso-*.svg. Es el estado persistente
 * (regla 16): no es un toast. `role="status"` (info/ok) o `role="alert"` (warn/danger).
 */
export type TonoAviso = 'info' | 'ok' | 'warn' | 'danger';
const ICONO: Record<TonoAviso, string> = {
  info: '/kit/aviso-info.svg', ok: '/kit/aviso-ok.svg', warn: '/kit/aviso-alerta.svg', danger: '/kit/aviso-error.svg',
};

export default function InlineAlert({ tono = 'info', titulo, children, accion }: {
  tono?: TonoAviso; titulo?: string; children?: ReactNode; accion?: ReactNode;
}) {
  return (
    <div className="kit-alerta" data-tono={tono} data-kit="alerta" role={tono === 'warn' || tono === 'danger' ? 'alert' : 'status'}>
      <img src={ICONO[tono]} alt="" aria-hidden="true" className="kit-alerta__icono" />
      <div className="min-w-0 flex-1 text-sm">
        {titulo && <p className="m-0 font-semibold">{titulo}</p>}
        {children}
      </div>
      {accion}
    </div>
  );
}
