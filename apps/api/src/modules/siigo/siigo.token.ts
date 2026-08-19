// Siigo API — obtención y caché del token de acceso (HU #11248).
//
// El token dura 24 horas. Pedir uno nuevo en cada llamada gastaría cuota del límite de 100
// peticiones por minuto en algo que no aporta nada, así que se cachea por ambiente y se renueva
// solo cuando toca.
//
// Dos detalles que sostienen el comportamiento bajo carga:
//
//   - Se renueva ANTES de vencer, con un margen. Un token que expira mientras la petición viaja
//     produce un 401 evitable, y el reintento cuesta el doble de tiempo que renovar a tiempo.
//   - Las renovaciones concurrentes comparten una sola promesa. Sin eso, diez emisiones en paralelo
//     al arrancar dispararían diez autenticaciones simultáneas contra Siigo.

import { obtenerCredencialActiva, type SiigoAmbiente } from './credenciales.service.js';
import { resolverConfig } from './siigo.config.js';
import { enModoMock, TOKEN_SIMULADO } from './siigo.mock.js';

/** El token fue rechazado o no pudo obtenerse. Nunca lleva el secreto en el mensaje. */
export class SiigoAuthError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SiigoAuthError';
    this.status = status;
  }
}

/** Margen de renovación anticipada. */
const MARGEN_RENOVACION_MS = 5 * 60_000;
/** Vigencia por defecto si Siigo no informa `expires_in`. La documentada son 24 horas. */
const VIGENCIA_POR_DEFECTO_MS = 24 * 60 * 60_000;
/** Una autenticación no debería tardar más que esto. */
const TIMEOUT_AUTH_MS = 30_000;

interface TokenEnCache {
  token: string;
  /** Instante a partir del cual hay que renovar (ya incluye el margen). */
  renovarDesde: number;
}

const cache = new Map<SiigoAmbiente, TokenEnCache>();
/** Renovaciones en vuelo, para que N peticiones concurrentes disparen UNA autenticación. */
const enVuelo = new Map<SiigoAmbiente, Promise<string>>();

/** Vacía la caché. Necesario tras un 401 y en los tests. */
export function invalidarToken(ambiente: SiigoAmbiente): void {
  cache.delete(ambiente);
}

export function invalidarTodos(): void {
  cache.clear();
  enVuelo.clear();
}

/**
 * Devuelve un token vigente para el ambiente, autenticando solo si hace falta.
 *
 * `forzarRenovacion` lo usa el cliente HTTP tras un 401: el token cacheado puede seguir dentro de
 * su ventana de vigencia y aun así haber sido revocado del lado de Siigo.
 */
export async function obtenerToken(
  ambiente: SiigoAmbiente,
  opciones: { forzarRenovacion?: boolean } = {},
): Promise<string> {
  if (opciones.forzarRenovacion) invalidarToken(ambiente);

  const cacheado = cache.get(ambiente);
  if (cacheado && Date.now() < cacheado.renovarDesde) return cacheado.token;

  const yaEnVuelo = enVuelo.get(ambiente);
  if (yaEnVuelo) return yaEnVuelo;

  const promesa = autenticar(ambiente).finally(() => enVuelo.delete(ambiente));
  enVuelo.set(ambiente, promesa);
  return promesa;
}

async function autenticar(ambiente: SiigoAmbiente): Promise<string> {
  // En modo simulado no hay credencial que resolver ni red que tocar (HU #11252). Se cachea igual
  // que un token real para que el comportamiento observable —una sola autenticación por ventana—
  // sea el mismo en ambos modos.
  if (enModoMock()) {
    cache.set(ambiente, { token: TOKEN_SIMULADO, renovarDesde: Date.now() + VIGENCIA_POR_DEFECTO_MS });
    return TOKEN_SIMULADO;
  }

  const config = resolverConfig();
  // Modo real: si no hay credencial activa, esto lanza. NO se cae al simulador — un fallback
  // silencioso haría creer que se facturó cuando no salió nada.
  const credencial = await obtenerCredencialActiva(ambiente);

  let respuesta: Response;
  try {
    respuesta = await fetch(`${config.baseUrl}/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Partner-Id': config.partnerId,
      },
      body: JSON.stringify({
        username: credencial.username,
        // unwrap() es el único punto donde el secreto sale de su envoltorio.
        access_key: credencial.accessKey.unwrap(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_AUTH_MS),
    });
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    throw new SiigoAuthError(`No se pudo contactar el servicio de autenticación de Siigo: ${detalle}`);
  }

  if (!respuesta.ok) {
    // 401 aquí significa credenciales rechazadas, no token vencido: no hay token todavía.
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw new SiigoAuthError(
        `Siigo rechazó las credenciales del ambiente "${ambiente}". Verifica el usuario y la clave `
        + 'de acceso en la administración de la integración.',
        respuesta.status,
      );
    }
    throw new SiigoAuthError(
      `El servicio de autenticación de Siigo respondió ${respuesta.status}.`,
      respuesta.status,
    );
  }

  const cuerpo = await respuesta.json().catch(() => null) as
    { access_token?: string; expires_in?: number } | null;

  const token = cuerpo?.access_token;
  if (!token) {
    throw new SiigoAuthError('La respuesta de autenticación de Siigo no trae access_token.');
  }

  // `expires_in` viene en segundos cuando viene. Si no, se asume la vigencia documentada.
  const vigenciaMs = typeof cuerpo?.expires_in === 'number' && cuerpo.expires_in > 0
    ? cuerpo.expires_in * 1000
    : VIGENCIA_POR_DEFECTO_MS;
  // El margen nunca puede dejar `renovarDesde` en el pasado: con vigencias muy cortas se renovaría
  // en cada llamada. Por eso se acota a la mitad de la vigencia.
  const margen = Math.min(MARGEN_RENOVACION_MS, vigenciaMs / 2);

  cache.set(ambiente, { token, renovarDesde: Date.now() + vigenciaMs - margen });
  return token;
}
