// Acciones de la cabecera del módulo Impuestos (Épica #14560, ronda 2). La cabecera (`PageHeaderCard`)
// es del shell, que pinta también las pestañas; sus acciones (carga masiva, «Exportar a Excel» con su
// nota y su casilla) dependen del estado de la cola, que vive en la página. En vez de subir ese estado
// al shell, el shell deja un HUECO dentro de la cabecera y la página pinta ahí sus acciones con un
// portal: mismo estado, mismos permisos, y la cabecera queda igual que la del SOAT.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const HuecoCabecera = createContext<HTMLElement | null>(null);

export const ProveedorHuecoCabecera = HuecoCabecera.Provider;

/** Pinta `children` dentro de la cabecera del shell; sin shell (o antes de montarlo), en su sitio. */
export function AccionesCabecera({ children }: { children: ReactNode }) {
  const hueco = useContext(HuecoCabecera);
  return hueco ? createPortal(children, hueco) : <>{children}</>;
}
