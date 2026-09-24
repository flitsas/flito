// FLITO Impuestos — la consulta RUNT del análisis post-envío (HU #12827, Feature #12822).
//
// UNA consulta por análisis: el paso `comparacion` la hace y la deja en `job.consultaRunt` para que
// la HU 12828 (autocertificación) la reutilice sin volver al RUNT ni llamar a `certificarImpuesto`.
//
// Replica la regla de `certificarImpuesto` (`certificacion.service.ts`): con documento del
// propietario se consulta placa + documento (prueba de propiedad, RN-02); sin él, placa + VIN. Sin
// placa, o sin documento ni VIN, NO se consulta. Todo por `limitadorRunt` (AC3 de la 12825). El
// traspaso en sincronización se reconoce ANTES de dar por caído el servicio. Nota: la duplicación de
// ~15 líneas con `certificarImpuesto` es deliberada; unificar es natural en la 12828.
//
// Nada del RUNT crudo se persiste desde aquí (`data` vive solo en memoria del job). Sin PII en logs.

import { consultarVehiculoRunt } from '../runt/runt.service.js';
import {
  esTraspasoEnSincronizacion, extraerColorCilindrajeRunt, extraerVehiculoRunt, runtSinRegistro,
  type ColorCilindrajeRunt, type DatosVehiculoRuntExtraido,
} from './certificacion-runt.js';
import { datosDelVehiculo } from './certificacion.service.js';
import type { LimitadorRunt } from './runt-limitador.js';

export type ConsultaRuntAnalisis =
  | { estado: 'ok'; via: 'documento' | 'vin'; data: unknown; vehiculo: DatosVehiculoRuntExtraido & ColorCilindrajeRunt }
  | { estado: 'sin_respuesta' | 'sin_registro' | 'traspaso' | 'sin_identificador' };

export async function consultarRuntDeImpuesto(impuestoId: string, runt: LimitadorRunt): Promise<ConsultaRuntAnalisis> {
  const datos = await datosDelVehiculo(impuestoId);
  const placa = datos?.placa?.trim() || null;
  const documento = datos?.ownerDocument?.trim() || null;
  const vin = datos?.vin?.trim() || null;
  if (!placa || (!documento && !vin)) return { estado: 'sin_identificador' };

  let resp: { ok?: boolean; data?: unknown; message?: string };
  try {
    resp = await runt.ejecutar(() => (documento
      ? consultarVehiculoRunt(placa, undefined, documento)
      : consultarVehiculoRunt(placa, vin ?? undefined, undefined)));
  } catch {
    return { estado: 'sin_respuesta' };
  }
  if (!resp?.ok || !resp?.data) {
    return { estado: esTraspasoEnSincronizacion(resp?.message) ? 'traspaso' : 'sin_respuesta' };
  }
  if (runtSinRegistro(resp.data)) return { estado: 'sin_registro' };
  return {
    estado: 'ok',
    via: documento ? 'documento' : 'vin',
    data: resp.data,
    vehiculo: { ...extraerVehiculoRunt(resp.data), ...extraerColorCilindrajeRunt(resp.data) },
  };
}
