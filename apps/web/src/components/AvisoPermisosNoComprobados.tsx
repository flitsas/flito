import { useState } from 'react';
import { useAuth } from '../lib/auth';
import GradientButton from './flit/GradientButton';

/**
 * Markup de InlineAlert tono warn (kit-alerta) escrito a mano: InlineAlert fuerza role="alert" en warn y este
 * aviso conserva role="status" (contrato de la HU y de sus E2E).
 *
 * HU #12872 (UX §1): la primera carga de `/permisos/mios` falló. «No saber no es no tener»: no se
 * pinta «sin acceso», se avisa en la página y se ofrece reintentar. Aviso persistente, no toast.
 */
export default function AvisoPermisosNoComprobados() {
  const { refrescarSesion } = useAuth();
  const [reintentando, setReintentando] = useState(false);
  const reintentar = async () => {
    setReintentando(true);
    try { await refrescarSesion(); } finally { setReintentando(false); }
  };
  return (
    <div
      role="status"
      data-testid="aviso-permisos-error"
      data-kit="alerta"
      data-tono="warn"
      className="kit-alerta mb-4 flex-wrap"
    >
      <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
      <span className="min-w-0 flex-1 text-sm">No pudimos comprobar tus permisos. Revisa tu conexión e inténtalo de nuevo.</span>
      <GradientButton variant="secondary" size="sm" onClick={reintentar} disabled={reintentando}>
        {reintentando ? 'Reintentando…' : 'Reintentar'}
      </GradientButton>
    </div>
  );
}
