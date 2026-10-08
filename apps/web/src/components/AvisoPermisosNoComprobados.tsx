import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { flitBtnSecondarySm } from './flit/flitPageKit';

/**
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
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-danger-text)' }}
    >
      <span>No pudimos comprobar tus permisos. Revisa tu conexión e inténtalo de nuevo.</span>
      <button type="button" className={flitBtnSecondarySm} onClick={reintentar} disabled={reintentando}>
        {reintentando ? 'Reintentando…' : 'Reintentar'}
      </button>
    </div>
  );
}
