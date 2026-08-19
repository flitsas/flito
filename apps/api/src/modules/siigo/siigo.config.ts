// Siigo API — configuración resuelta en un solo punto (HU #11248).
//
// El `Partner-Id` se valida aquí y no en cada llamada: Siigo monitorea ese valor y bloquea a quien
// envíe información falsa, así que un valor mal formado tiene que reventar antes de salir a la red,
// no después.

import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Falla de configuración del entorno, no del servicio. El router la traduce a 503. */
export class SiigoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiigoConfigError';
  }
}

export interface SiigoConfig {
  baseUrl: string;
  partnerId: string;
  ambiente: SiigoAmbiente;
}

/**
 * De 3 a 100 caracteres alfanuméricos, sin espacios ni caracteres especiales — es literalmente lo
 * que documenta Siigo. Un guion o un punto bastan para que la petición sea rechazada.
 */
const PARTNER_ID_RE = /^[A-Za-z0-9]{3,100}$/;

export function resolverConfig(): SiigoConfig {
  const partnerId = env.SIIGO_PARTNER_ID?.trim();
  if (!partnerId) {
    throw new SiigoConfigError(
      'SIIGO_PARTNER_ID no está configurado. Siigo exige la cabecera Partner-Id con el nombre de la '
      + 'aplicación integradora en todas las peticiones.',
    );
  }
  if (!PARTNER_ID_RE.test(partnerId)) {
    throw new SiigoConfigError(
      `SIIGO_PARTNER_ID inválido ("${partnerId}"): debe tener entre 3 y 100 caracteres alfanuméricos, `
      + 'sin espacios ni caracteres especiales.',
    );
  }
  // Sin barra final: las rutas se concatenan como `${baseUrl}/v1/invoices`.
  const baseUrl = env.SIIGO_BASE_URL.replace(/\/+$/, '');

  return { baseUrl, partnerId, ambiente: env.SIIGO_AMBIENTE };
}

/** Diagnóstico sin lanzar, para pantallas de administración. */
export function configDisponible(): boolean {
  try {
    resolverConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Si este ambiente puede producir efectos FUERA de Siigo: el timbre ante la DIAN y el correo al
 * cliente (HU A6).
 *
 * Los dos comparten regla porque comparten la propiedad que importa: **no se deshacen**. Una
 * factura que la DIAN aceptó solo se corrige con nota crédito, y un correo que salió ya lo leyó
 * alguien. Crear el documento en Siigo Nube, en cambio, es reversible y es justo lo que hace falta
 * para ensayar.
 *
 * **Se deriva del ambiente y no se configura, a propósito.** Un interruptor con este poder es un
 * interruptor que algún día está mal puesto —y el día que lo esté, lo que sale es una factura real
 * a nombre de FLIT o un correo a un cliente que no esperaba nada—. Derivarlo lo vuelve imposible de
 * equivocar sin editar código, que es exactamente la fricción que se quiere.
 *
 * Si algún día hace falta ensayar el timbre contra la empresa de pruebas, eso es una decisión
 * nueva: se toma entonces y se escribe aquí, no se deja abierta «por si acaso».
 */
export function efectosExternosPermitidos(ambiente: SiigoAmbiente): boolean {
  return ambiente === 'produccion';
}
