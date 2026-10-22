// FLITO Impuestos — la consulta RUNT del análisis post-envío (HU #12827, Feature #12822).
//
// UNA consulta por análisis: el paso `comparacion` la hace y la deja en `job.consultaRunt`; el paso
// `autocertificacion` (HU 12828) la reutiliza con `certificarConRespuestaRunt`, sin volver al RUNT.
//
// Misma regla que `certificarImpuesto` (`certificacion.service.ts`), compartida en
// `argumentosConsultaRunt` (`certificacion-runt.ts`): en MATRÍCULA se consulta SIEMPRE solo por VIN
// (RN-12827-M: el RUNT aún no tiene propietario y rechaza placa + documento y placa + VIN); sin VIN
// no se consulta. En traspaso/otros, placa + documento (prueba de propiedad, RN-02); sin él, placa +
// VIN. Sin placa NO se consulta (requisito sin cambio). Todo por `limitadorRunt` (AC3 de la 12825).
// El traspaso en sincronización se reconoce ANTES de dar por caído el servicio.
//
// Nada del RUNT crudo se persiste desde aquí (`data` vive solo en memoria del job). Sin PII en logs.

import { consultarVehiculoRunt } from '../runt/runt.service.js';
import {
  argumentosConsultaRunt, esTraspasoEnSincronizacion, extraerColorCilindrajeRunt, extraerVehiculoRunt, runtSinRegistro,
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
  if (!datos || !placa) return { estado: 'sin_identificador' };
  const args = argumentosConsultaRunt({
    tipoTramite: datos.tipoTramite, placa, documento: datos.ownerDocument, vin: datos.vin,
  });
  if (!args) return { estado: 'sin_identificador' };

  let resp: { ok?: boolean; data?: unknown; message?: string };
  try {
    resp = await runt.ejecutar(() => consultarVehiculoRunt(args.placa, args.vin, args.documento));
  } catch {
    return { estado: 'sin_respuesta' };
  }
  if (!resp?.ok || !resp?.data) {
    return { estado: esTraspasoEnSincronizacion(resp?.message) ? 'traspaso' : 'sin_respuesta' };
  }
  if (runtSinRegistro(resp.data)) return { estado: 'sin_registro' };
  return {
    estado: 'ok',
    via: args.via,
    data: resp.data,
    vehiculo: { ...extraerVehiculoRunt(resp.data), ...extraerColorCilindrajeRunt(resp.data) },
  };
}
