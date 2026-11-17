// HU #12085 — Borrar un rol (ficha §8.2, casos 2 y 3).
//
// Solo se abre para un rol `borrable`. Si entre la lectura y el clic alguien le asignó usuarios, el
// `DELETE` responde 409 con `{ error, usuarios }` y el modal cambia al caso 2 con el número FRESCO
// del servidor, sin cerrarse: el conteo de la cabecera puede ser viejo; la respuesta no.
//
// «Borrar rol» es el botón destructivo del kit (`GradientButton variant="alerta"`, naranja): nunca el
// azul de avanzar sobre una acción que no se deshace. «Ir a Usuarios» va a `/users` SIN filtro
// (decisión 10): el filtro por rol de esa pantalla vive en estado y un parámetro no lo aplicaría.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RolCatalogo } from '@operaciones/shared-types';
import { ApiError, errorMessage, permisosApi } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import { usuariosTienenEsteRol } from './modulos';

interface Props {
  rol: RolCatalogo;
  onClose: () => void;
  onBorrado: (codigo: string) => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
}

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
    <FlitModal title={`Borrar el rol ${rol.nombre}`} onClose={onClose} restoreFocusRef={restoreFocusRef} icono="papelera">
      {rechazo ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            {rechazo.usuarios !== null ? usuariosTienenEsteRol(rechazo.usuarios) : rechazo.error}
          </p>
          {rechazo.usuarios !== null && (
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Un rol no se puede borrar mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <GradientButton type="button" variant="secondary" onClick={onClose}>Cerrar</GradientButton>
            {rechazo.usuarios !== null && (
              <GradientButton type="button" onClick={() => navigate('/users')}>Ir a Usuarios</GradientButton>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>Ningún usuario tiene este rol.</p>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Al borrarlo desaparece de este cuadro y de la lista de roles del formulario de usuario. No se puede deshacer.
          </p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <GradientButton type="button" variant="secondary" onClick={onClose} disabled={borrando}>Cancelar</GradientButton>
            <GradientButton type="button" variant="alerta" onClick={borrar} disabled={borrando}>
              {borrando ? 'Borrando…' : 'Borrar rol'}
            </GradientButton>
          </div>
        </div>
      )}
    </FlitModal>
  );
}
