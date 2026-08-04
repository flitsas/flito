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
