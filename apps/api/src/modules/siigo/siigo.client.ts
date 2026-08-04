// Siigo API — cliente HTTP (HU #11248).
//
// Toda llamada a Siigo pasa por aquí. Concentrarlas en un punto es lo que garantiza que ninguna se
// vaya sin `Authorization` o sin `Partner-Id`, que es justo lo que Siigo penaliza.
//
// La clave de idempotencia SOLO viaja en los POST de comprobantes. Enviarla en un GET no tiene
// efecto según la documentación, pero enviarla donde no corresponde es una señal de que quien llama
// se confundió, así que se rechaza en vez de ignorarse en silencio.

import { obtenerToken, SiigoAuthError } from './siigo.token.js';
import { resolverConfig } from './siigo.config.js';
import { traducirErrorSiigo, type SiigoApiError } from './siigo.errors.js';
import { enModoMock, respuestaSimulada } from './siigo.mock.js';
import type { SiigoAmbiente } from './credenciales.service.js';

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Métodos donde la cabecera de idempotencia tiene sentido. */
const METODOS_IDEMPOTENTES = new Set<MetodoHttp>(['POST']);

/** Alfanumérica, sin espacios ni especiales, máximo 30 — lo que documenta Siigo. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9]{1,30}$/;

/** Timeout largo: Siigo recomienda 120 s o más en creación de comprobantes. */
const TIMEOUT_POR_DEFECTO_MS = 120_000;

export interface SiigoRequest {
  metodo: MetodoHttp;
  /** Ruta relativa, empezando por `/`. Ej.: `/v1/invoices`. */
  ruta: string;
  cuerpo?: unknown;
  /** Solo válida en POST. Identificador estable propio, nunca aleatorio. */
  idempotencyKey?: string;
  ambiente?: SiigoAmbiente;
  timeoutMs?: number;
}

export interface SiigoRespuesta<T = unknown> {
  status: number;
  ok: boolean;
  datos: T;
}

/** Fallo de uso del cliente detectado antes de salir a la red. */
export class SiigoRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiigoRequestError';
  }
}

/**
 * Ejecuta una petición contra Siigo con las cabeceras obligatorias resueltas.
 *
 * Ante un 401 renueva el token y reintenta UNA vez. Un solo reintento y no más: si el segundo
 * intento también devuelve 401, el problema son las credenciales, y reintentar en bucle solo
 * acerca el bloqueo por proporción de errores que aplica Siigo.
 */
export async function siigoRequest<T = unknown>(req: SiigoRequest): Promise<SiigoRespuesta<T>> {
  const config = resolverConfig();
  const ambiente = req.ambiente ?? config.ambiente;

  if (req.idempotencyKey !== undefined) {
    if (!METODOS_IDEMPOTENTES.has(req.metodo)) {
      throw new SiigoRequestError(
        `La clave de idempotencia solo aplica a POST de comprobantes; se intentó enviar en ${req.metodo} ${req.ruta}.`,
      );
    }
    if (!IDEMPOTENCY_KEY_RE.test(req.idempotencyKey)) {
      throw new SiigoRequestError(
        'La clave de idempotencia debe ser alfanumérica, sin espacios ni caracteres especiales, de máximo 30 caracteres.',
      );
    }
  }

  // Modo simulado: se corta ANTES de resolver el token y antes de tocar la red (HU #11252).
  // El orden importa: validar la idempotencia arriba y cortar aquí hace que el simulador ejerza las
  // mismas reglas de uso que el modo real, en vez de ser un atajo que las esquiva.
  if (enModoMock()) {
    const simulada = respuestaSimulada(req.metodo, req.ruta);
    return { status: simulada.status, ok: simulada.ok, datos: simulada.datos as T };
  }

  const ejecutar = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: token,
      'Partner-Id': config.partnerId,
      Accept: 'application/json',
    };
    if (req.cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    return fetch(`${config.baseUrl}${req.ruta}`, {
      method: req.metodo,
      headers,
      body: req.cuerpo !== undefined ? JSON.stringify(req.cuerpo) : undefined,
      signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_POR_DEFECTO_MS),
    });
  };

  let respuesta = await ejecutar(await obtenerToken(ambiente));

  if (respuesta.status === 401) {
    // El token cacheado puede seguir dentro de su ventana y aun así haber sido revocado en Siigo.
    const tokenNuevo = await obtenerToken(ambiente, { forzarRenovacion: true });
    respuesta = await ejecutar(tokenNuevo);

    if (respuesta.status === 401) {
      throw new SiigoAuthError(
        `Siigo rechazó la petición ${req.metodo} ${req.ruta} incluso con un token recién renovado. `
        + 'Verifica las credenciales del ambiente en la administración de la integración.',
        401,
      );
    }
  }

  const datos = await respuesta.json().catch(() => null) as T;
  return { status: respuesta.status, ok: respuesta.ok, datos };
}

/**
 * Igual que `siigoRequest`, pero traduce cualquier respuesta fallida a `SiigoApiError` (HU #11250).
 *
 * Es la forma que deben usar los servicios de negocio: obliga a tratar el fallo y trae ya resuelto
 * si la operación se reintenta o si hay que corregir un dato. `siigoRequest` queda para quien
 * necesite inspeccionar el estado crudo, como el diagnóstico de conexión.
 */
export async function siigoRequestOrThrow<T = unknown>(req: SiigoRequest): Promise<T> {
  const r = await siigoRequest<T>(req);
  if (!r.ok) throw traducirErrorSiigo(r.status, r.datos);
  return r.datos;
}

export type { SiigoApiError };
