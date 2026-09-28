// «Reintentar consulta» de una solicitud aparcada porque el RUNT no respondió (HU #12998, UX §3.3).
//
// Un solo hook para la fila y el detalle: el estado «en vuelo» es el mismo (la fila de una solicitud
// que se consulta desde el detalle también queda ocupada) y el toast sale una sola vez por acción.
//
// Los toasts son el copy literal de la spec, impersonal para servir al Cliente y a Operaciones; solo
// «sin red» se ramifica (usted / tú). Nunca llevan el mensaje crudo del API, el código del RUNT, el
// propietario ni el VIN completo: del VIN solo los 4 últimos caracteres.

import { useCallback, useState } from 'react';
import type { ResultadoReintentoRunt, SolicitudIncompletaFila } from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import { fechaLargaOGuion } from '../../../lib/soatCliente';
import { toastError, toastOk } from '../../flit/ToastFlito';

export const FUNCION_REINTENTAR_RUNT = 'soat.solicitud.reintentar_runt';

/** Lo que recibe quien pidió el reintento: el 200 tal cual, o qué clase de fallo hubo. */
export type DesenlaceReintento = ResultadoReintentoRunt | { resultado: 'conflicto' } | { resultado: 'fallo' };

export type OrigenReintento = 'fila' | 'detalle';

const DESCARTADA_SIN_VIN = 'La solicitud quedó descartada: el RUNT no tiene registrado ese VIN. Puede verla en «Descartadas».';

/** El toast de un 200. Exportado para leerlo desde un solo sitio si otra pantalla lo necesita. */
export function toastDeResultado(r: ResultadoReintentoRunt, vin: string): void {
  if (r.resultado === 'completada') {
    toastOk(r.vigenciaProxima
      ? `El RUNT respondió: la solicitud pasó a Solicitado. El SOAT actual vence el ${fechaLargaOGuion(r.vigenciaProxima.venceEl)}.`
      : `El RUNT respondió: la solicitud del VIN …${vin.slice(-4)} pasó a Solicitado.`);
    return;
  }
  if (r.resultado === 'sigue_incompleta') {
    toastError('El RUNT sigue sin responder. La solicitud se conserva por validar; intente más tarde.');
    return;
  }
  if (r.motivo === 'soat_vigente') {
    const hasta = fechaLargaOGuion(r.soatActivo?.vencimiento);
    toastError(hasta !== '—'
      ? `La solicitud quedó descartada: el vehículo ya tiene SOAT activo hasta el ${hasta}. Puede verla en «Descartadas».`
      : 'La solicitud quedó descartada: el vehículo ya tiene SOAT activo. Puede verla en «Descartadas».');
    return;
  }
  if (r.motivo === 'solicitud_existente') {
    toastError('La solicitud quedó descartada: ese VIN ya tenía una solicitud en la cola de FLITO. Puede verla en «Descartadas».');
    return;
  }
  // `runt_sin_registro`, `runt_no_cuadra`, `runt_sin_vin`: el 422 del RUNT, un solo copy (AC3).
  toastError(DESCARTADA_SIN_VIN);
}

export default function useReintentoRunt({ esCliente, onResuelto }: { esCliente: boolean; onResuelto: () => void }) {
  // Por id: la consulta de una fila no bloquea al resto de la cola (UX §3.3).
  const [enVuelo, setEnVuelo] = useState<Record<string, OrigenReintento>>({});

  const reintentar = useCallback(async (fila: SolicitudIncompletaFila, origen: OrigenReintento): Promise<DesenlaceReintento> => {
    setEnVuelo((m) => ({ ...m, [fila.id]: origen }));
    let desenlace: DesenlaceReintento;
    try {
      const r = await api.post<ResultadoReintentoRunt>(`/flito/soat/cliente/incompletas/${fila.id}/reintentar`, {});
      toastDeResultado(r, fila.vin);
      desenlace = r;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409) {
        toastError('Esta solicitud ya había cambiado de estado. La lista se actualizó.');
        desenlace = { resultado: 'conflicto' };
      } else if (status === 429) {
        toastError(esCliente
          ? 'Hubo demasiadas consultas seguidas. Espere unos minutos e intente de nuevo.'
          : 'Hubo demasiadas consultas seguidas. Espera unos minutos e intenta de nuevo.');
        desenlace = { resultado: 'fallo' };
      } else {
        toastError(esCliente
          ? 'No pudimos reintentar la consulta. Revise su conexión e intente de nuevo.'
          : 'No pudimos reintentar la consulta. Revisa tu conexión e intenta de nuevo.');
        desenlace = { resultado: 'fallo' };
      }
    } finally {
      setEnVuelo((m) => { const n = { ...m }; delete n[fila.id]; return n; });
    }
    // Cualquier desenlace que cambió algo (o que dice que otro lo cambió) refresca la cola y las
    // pastillas: la completada sale de «Por validar» y aparece en la cola normal.
    if (desenlace.resultado !== 'fallo') onResuelto();
    return desenlace;
  }, [esCliente, onResuelto]);

  return { enVuelo, reintentar };
}
