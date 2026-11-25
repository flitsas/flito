import { useCallback, useState } from 'react';
import { useAuth } from '../../lib/auth';
import type { SectionGroup } from './useNavSections';

// Los cuatro estados del menú (Épica #14678, spec UX §4), comunes al dock y al menú lateral. El menú depende de los
// permisos efectivos (`/permisos/mios`): mientras no llegan se pinta el esqueleto; si la carga falló, «No se pudo
// cargar el menú.» con «Reintentar» (nunca el error crudo, nunca un toast: es un estado persistente y va donde pasa,
// dentro de la barra); si llegaron y no queda ninguna opción (fuera de Ayuda), el vacío con el siguiente paso.

export type EstadoMenu = 'cargando' | 'error' | 'vacio' | 'lleno';

export const COPY_MENU_ERROR = 'No se pudo cargar el menú.';
export const COPY_MENU_VACIO = 'Sin módulos asignados. Pedir acceso al administrador de FLITO.';

export interface EstadoDelMenu {
  estado: EstadoMenu;
  /** Vuelve a pedir la sesión y los permisos. Éxito: el menú aparece solo; fallo: el aviso sigue. */
  reintentar: () => void;
  reintentando: boolean;
}

export function useEstadoMenu(grouped: readonly SectionGroup[]): EstadoDelMenu {
  const { funciones, permisosError, refrescarSesion } = useAuth();
  const [reintentando, setReintentando] = useState(false);

  const reintentar = useCallback(() => {
    setReintentando(true);
    void refrescarSesion().finally(() => setReintentando(false));
  }, [refrescarSesion]);

  let estado: EstadoMenu;
  if (permisosError) estado = 'error';
  else if (funciones === null) estado = 'cargando';
  else estado = grouped.some((g) => g.section !== 'ayuda') ? 'lleno' : 'vacio';

  return { estado, reintentar, reintentando };
}
