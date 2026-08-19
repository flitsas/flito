// FLITO — Comparendos: el estado del panel de detalle (HU #11562, Feature #11495 17b).
//
// Una petición y un refresco que NO es una petición. Eso es todo lo que hace este archivo, y las
// dos mitades importan por separado:
//
//   · **Abrir** — `GET /registros/:id`. Una sola llamada: el detalle ya trae `eventos[]`, así que
//     `GET /registros/:id/eventos` no se usa (sería una segunda petición por cada panel abierto
//     para un dato que ya llegó).
//   · **Refrescar tras gestionar** — el cuerpo del `PATCH` **es** un `ComparendoRegistroDetalle`
//     completo, con su timeline ya actualizado dentro de la transacción que lo escribió (HU
//     #11557). Se reemplaza el estado con él y no se vuelve a pedir nada. Un `GET` extra aquí no
//     sería «ser cuidadoso», sería el bug que la nota QA #53 de la spec nombra: el AC3 pide que la
//     fila y el timeline cambien SIN que se vuelva a pedir la página.
//
// Y una tentación que hay que descartar por escrito, porque es la que primero se le ocurre a
// cualquiera: **no se fabrica el evento nuevo en el cliente**. Quien lo fabrique tiene que adivinar
// dos cosas que solo sabe el servidor —si lo que pasó fue `gestion_registrada` o `gestion_retirada`,
// y qué otros eventos insertó una corrida de sync mientras el formulario estaba abierto— y las va a
// adivinar mal el día que importe.
//
// El texto del servidor NO se pinta, igual que en el resto del módulo desde la #11559: el copy sale
// del código de estado y, cuando lo hay, del `codigo` estable del cuerpo de error. Este panel se
// pide por identificador, así que es justo donde un mensaje del backend tiene más probabilidad de
// repetir el dato consultado. Aquí tampoco hay ningún `console.*`: el módulo trata datos personales
// y la consola del navegador no está bajo la retención que la Ley 1581 exige.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComparendoRegistroDetalle,
  ComparendosGestionPatch,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';

const RUTA = '/flito/comparendos';

/**
 * Error del panel: qué se le dice al usuario y qué se le ofrece hacer.
 *
 * `cerrarYRecargar` es propia del 404 y no un lujo: el comparendo ya no existe, así que ni
 * reintentar ni quedarse mirando el panel llevan a ninguna parte — lo único útil es cerrar y traer
 * la lista otra vez, porque la fila que se ve por detrás también es mentira.
 */
export interface ErrorPanel {
  texto: string;
  accion: 'reintentar' | 'cerrarYRecargar' | null;
}

/** `codigo` del cuerpo de error, que `ApiError.rawDetails` conserva. NO se mira el texto. */
export function codigoDeError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

export function errorDePanel(e: unknown): ErrorPanel {
  if (e instanceof ApiError) {
    if (e.status === 404) {
      return {
        texto: 'Este comparendo ya no está en el sistema. Puede que se haya purgado por retención '
          + 'de datos.',
        accion: 'cerrarYRecargar',
      };
    }
    if (e.status === 403) {
      return {
        texto: 'Tu usuario ya no tiene acceso a los comparendos. Habla con un administrador.',
        accion: null,
      };
    }
    if (e.status === 429) {
      return {
        texto: 'Se hicieron demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo. '
          + 'El módulo limita las consultas porque cada página trae datos personales.',
        accion: 'reintentar',
      };
    }
    if (e.status === 0) {
      return {
        texto: 'No hubo respuesta del servidor al cargar el comparendo. Revisa tu conexión y vuelve '
          + 'a intentarlo.',
        accion: 'reintentar',
      };
    }
  }
  return { texto: 'No se pudo cargar el comparendo. Vuelve a intentarlo.', accion: 'reintentar' };
}

export interface DetalleComparendo {
  /** `null` = todavía no se sabe (cargando o error). */
  detalle: ComparendoRegistroDetalle | null;
  cargando: boolean;
  error: ErrorPanel | null;
  /** Repite el `GET`. Es la salida del estado de error. */
  recargar: () => void;
  /** Reemplaza el panel con el cuerpo del `PATCH`. **No pide nada**: ver la cabecera. */
  reemplazar: (nuevo: ComparendoRegistroDetalle) => void;
}

/**
 * Trae el comparendo con su timeline. `id` en `null` = el panel está cerrado y no se pide nada.
 */
export function useComparendoDetalle(id: string | null): DetalleComparendo {
  const [detalle, setDetalle] = useState<ComparendoRegistroDetalle | null>(null);
  const [error, setError] = useState<ErrorPanel | null>(null);
  const [nonce, setNonce] = useState(0);
  // Una petición por vuelo, la última gana: abrir una fila, cerrar y abrir otra deprisa no puede
  // acabar pintando el comparendo que ya no se está mirando.
  const vuelo = useRef(0);

  useEffect(() => {
    const turno = vuelo.current + 1;
    vuelo.current = turno;
    setDetalle(null);
    setError(null);
    if (id === null) return;
    api.get<ComparendoRegistroDetalle>(`${RUTA}/registros/${id}`)
      .then((d) => { if (turno === vuelo.current) setDetalle(d); })
      .catch((e) => { if (turno === vuelo.current) setError(errorDePanel(e)); });
  }, [id, nonce]);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  const reemplazar = useCallback((nuevo: ComparendoRegistroDetalle) => {
    // Se le da su propio turno de vuelo para que una respuesta del `GET` que venga tarde —el
    // reintento de un error, por ejemplo— no pise el registro recién guardado con el de antes.
    vuelo.current += 1;
    setError(null);
    setDetalle(nuevo);
  }, []);

  return {
    detalle,
    cargando: id !== null && detalle === null && error === null,
    error,
    recargar,
    reemplazar,
  };
}

/** `PATCH /registros/:id/gestion`. Devuelve el registro entero con su timeline ya actualizado. */
export function guardarGestion(
  id: string,
  cambios: ComparendosGestionPatch,
): Promise<ComparendoRegistroDetalle> {
  return api.patch<ComparendoRegistroDetalle>(`${RUTA}/registros/${id}/gestion`, cambios);
}
