// Reglas puras de la certificación sin trámite. La igualdad de cada campo la decide
// `compararFacturaConRunt` (la misma de la cola). Aquí solo se exige que los seis coincidan.
import type { CampoExtraido, ComparacionCampoFacturaRunt, ExtraccionFacturaVentaImpuesto } from '@operaciones/shared-types';
import { CAMPOS_COMPARACION_FACTURA_RUNT } from '@operaciones/shared-types';
import { esTraspasoEnSincronizacion } from './certificacion-runt.js';

export interface DatosVehiculoDiligenciados {
  vin: string;
  marca: string;
  linea: string;
  anio: string;
  color: string;
  cilindrada: string;
}

/** Placa y VIN comparables: mayúsculas y solo letras o dígitos. */
export function normalizarClave(valor: string): string {
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function campo(valor: string): CampoExtraido {
  return { valor, confianza: 1, confiable: true };
}

/** Lo diligenciado entra como extracción fiable, para reutilizar la comparación de la cola. */
export function extraccionDesdeDiligenciado(d: DatosVehiculoDiligenciados): ExtraccionFacturaVentaImpuesto {
  return {
    vin: campo(d.vin),
    marca: campo(d.marca),
    linea: campo(d.linea),
    anioVehiculo: campo(d.anio),
    color: campo(d.color),
    cilindrada: campo(d.cilindrada),
  };
}

/**
 * Certifica solo si los seis campos vehiculares salieron `coincide`.
 * Un `no_verificable` (el RUNT no trajo el dato) no alcanza.
 */
export function seisCoinciden(campos: readonly ComparacionCampoFacturaRunt[]): boolean {
  if (campos.length !== CAMPOS_COMPARACION_FACTURA_RUNT.length) return false;
  const porCampo = new Map(campos.map((c) => [c.campo, c.resultado]));
  return CAMPOS_COMPARACION_FACTURA_RUNT.every((c) => porCampo.get(c) === 'coincide');
}

/**
 * El texto del RUNT no se guarda ni se muestra: solo distingue «no está» de «no respondió».
 * Un `ok:false` con HTTP 200 es un rechazo: el RUNT respondió (ver `anotarTransporte` en runt.service). El
 * documento que no corresponde llega así y se reporta como `sin_vehiculo`, no como una caída del servicio.
 */
export function clasificarFalloRunt(mensaje: string, httpStatus?: number): 'sin_vehiculo' | 'sin_respuesta' {
  if (httpStatus === 200 || esTraspasoEnSincronizacion(mensaje)) return 'sin_vehiculo';
  const m = mensaje.toLowerCase();
  if (m.includes('no se encuentra') || m.includes('no encontr') || m.includes('no existe') || m.includes('no registr')) {
    return 'sin_vehiculo';
  }
  return 'sin_respuesta';
}

export function esPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}
