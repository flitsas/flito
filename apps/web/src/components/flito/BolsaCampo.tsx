// Campo de formulario con su mensaje de error, para los cuatro formularios de bolsas.
//
// El error va FUERA del `<label>` a propósito. Metido dentro —que es como se escribe sin pensarlo—
// pasa a formar parte del nombre accesible del campo, y un lector de pantalla acaba anunciando
// «Valor de la recarga, el valor de la recarga debe ser mayor que cero» cada vez que se enfoca el
// input. Fuera y con `role="alert"` se anuncia cuando aparece, que es cuando importa.

import type { ReactNode } from 'react';
import { FlitField } from '../flit/flitPageKit';

export default function Campo({ etiqueta, error, ayuda, children }: {
  etiqueta: string;
  /** Mensaje de validación. Solo se pinta cuando hay algo que corregir. */
  error?: string | null;
  /** Nota permanente bajo el campo: qué hace el dato, no qué está mal. */
  ayuda?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <FlitField label={etiqueta}>{children}</FlitField>
      {ayuda && <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{ayuda}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger)' }}>{error}</p>
      )}
    </div>
  );
}
