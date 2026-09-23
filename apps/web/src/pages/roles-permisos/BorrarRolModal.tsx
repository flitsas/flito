// HU #12085 — Borrar un rol (ficha §8.2, casos 2 y 3).
//
// Solo se abre para un rol `borrable`. Si entre la lectura y el clic alguien le asignó usuarios, el
// `DELETE` responde 409 con `{ error, usuarios }` y el modal cambia al caso 2 con el número FRESCO
// del servidor, sin cerrarse: el conteo de la cabecera puede ser viejo; la respuesta no.
//
// «Borrar rol» es el botón de peligro (`--flit-danger`), no `GradientButton`: un gradiente de marca
// sobre una acción destructiva enseña a pulsar sin leer. «Ir a Usuarios» va a `/users` SIN filtro
// (decisión 10): el filtro por rol de esa pantalla vive en estado y un parámetro no lo aplicaría.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RolCatalogo } from '@operaciones/shared-types';
import { ApiError, errorMessage, permisosApi } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import { usuariosTienenEsteRol } from './modulos';

interface Props {
  rol: RolCatalogo;
  onClose: () => void;
  onBorrado: (codigo: string) => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
}

const BTN_PELIGRO = 'flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-50';

export default function BorrarRolModal({ rol, onClose, onBorrado, restoreFocusRef }: Props) {
  const navigate = useNavigate();
  const [borrando, setBorrando] = useState(false);
  const [rechazo, setRechazo] = useState<{ usuarios: number | null; error: string } | null>(null);

  const borrar = async () => {
    setBorrando(true);
    try {
      await permisosApi.borrarRol(rol.codigo);
      onBorrado(rol.codigo);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detalles = err.rawDetails as { usuarios?: unknown } | null;
        const usuarios = typeof detalles?.usuarios === 'number' ? detalles.usuarios : null;
        setRechazo({ usuarios, error: err.message });
      } else {
        setRechazo({ usuarios: null, error: errorMessage(err) });
      }
    } finally {
      setBorrando(false);
    }
  };

  return (
    <FlitModal title={`Borrar el rol ${rol.nombre}`} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      {rechazo ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            {rechazo.usuarios !== null ? usuariosTienenEsteRol(rechazo.usuarios) : rechazo.error}
          </p>
          {rechazo.usuarios !== null && (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Un rol no se puede borrar mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cerrar</button>
            {rechazo.usuarios !== null && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => navigate('/users')}>Ir a Usuarios</button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Ningún usuario tiene este rol.</p>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Al borrarlo desaparece de este cuadro y de la lista de roles del formulario de usuario. No se puede deshacer.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={borrando}>Cancelar</button>
            <button type="button" className={BTN_PELIGRO} style={{ background: 'var(--flit-danger)' }} onClick={borrar} disabled={borrando}>
              {borrando ? 'Borrando…' : 'Borrar rol'}
            </button>
          </div>
        </div>
      )}
    </FlitModal>
  );
}
