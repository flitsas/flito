// Qué le falta a un cliente para poder facturarse, en dos grupos (HU #11299, AC4).
//
// Lo comparten el detalle de la lista (bloque B) y la fila fallida de la sincronización (bloque D),
// y por eso vive suelto: el 422 de `POST /siigo/terceros/cliente/:id` devuelve EXACTAMENTE el mismo
// `FaltanteCliente[]` que el informe del validador, así que pintarlo dos veces con dos componentes
// distintos sería inventar dos vocabularios para la misma carencia.
//
// Las tres decisiones que hacen que esto no se lea como un volcado de errores:
//
//   1. **Dos grupos con encabezado propio, no una lista.** El backend separa los motivos que piden
//      una DECISIÓN (tipo de persona, identificación duplicada, partición del nombre) de los que
//      piden CAPTURAR un dato, y separa porque se resuelven de forma distinta. «Hay que decidir» va
//      primero aunque casi siempre sea el grupo más pequeño: es el que bloquea al otro.
//   2. **Un `<li>` por carencia, con la frase completa.** Un lector de pantalla anuncia «lista de 5
//      elementos, elemento 1…», que es literalmente el «uno por uno» del AC4. Nada de motivos
//      concatenados con comas ni escondidos en un `title`.
//   3. **La lista puede CRECER al corregir, y se avisa antes.** `evaluarCliente` omite la revisión
//      del nombre mientras el tipo de persona esté sin clasificar. Sin la frase de aviso, completar
//      un dato y ver aparecer otro se lee como un error del sistema.

import type { ReactNode } from 'react';
import type { FaltanteCliente } from '@operaciones/shared-types';
import { agruparFaltantes } from './tipos';

/** El texto es el que manda el servidor. Ver la nota de PII del componente padre. */
function Grupo({ titulo, faltantes, pie }: {
  titulo: string;
  faltantes: FaltanteCliente[];
  pie?: ReactNode;
}) {
  if (faltantes.length === 0) return null;
  return (
    <div>
      <h5 className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {titulo} ({faltantes.length})
      </h5>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
        {faltantes.map((f) => (
          <li key={f.motivo}>
            {f.detalle}
            {f.motivo === 'ubicacion_faltante' && (
              <span className="block" style={{ color: 'var(--flit-text-muted)' }}>
                Se confirma abajo, en «Equivalencias de ciudad».
              </span>
            )}
          </li>
        ))}
      </ul>
      {pie}
    </div>
  );
}

export default function FaltantesCliente({ faltantes, mensajeSinLista }: {
  faltantes: readonly FaltanteCliente[];
  /**
   * Qué decir cuando no hay lista que pintar. Ocurre de verdad: el 409 `sin_identificacion` llega
   * sin `faltantes` —la identidad se arma antes de validar— y el 422 los trae vacíos en su caso
   * defensivo. Ahí manda el texto del servidor y no un «no falta nada» que contradiría al fallo.
   */
  mensajeSinLista?: string;
}) {
  const { decidir, capturar } = agruparFaltantes(faltantes);

  if (faltantes.length === 0) {
    return mensajeSinLista === undefined ? null : (
      <p className="text-xs" style={{ color: 'var(--flit-text-primary)' }}>{mensajeSinLista}</p>
    );
  }

  return (
    <div className="space-y-3">
      <Grupo
        titulo="Hay que decidir"
        faltantes={decidir}
        pie={(
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Al clasificarlo pueden aparecer datos nuevos que ahora no se pueden evaluar: el nombre
            solo se revisa cuando ya se sabe qué es.
          </p>
        )}
      />
      <Grupo titulo="Hay que capturar" faltantes={capturar} />
    </div>
  );
}
