// FLITO sync — pase de FLIT 2 y «Probar conexión» (HU #13063, Feature #13057).
// Diseño: `docs/diseno/hu-13061-13063-acceso-flit2.md`. Contrato: `docs/integraciones/flit2-api.md` §2.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  El pase (JWT de FLIT 2) vive solo en la memoria del proceso (`flit2-pase.cache.ts`): nunca en
//        la base ni en un log, y viaja como `Redacted`. Se reutiliza hasta que falten menos de 60 s
//        para su vencimiento; con varias peticiones a la vez sale UNA sola petición de token.
// RN-02  Traducción única de la respuesta del token (la usan `obtenerPase` y `probarConexion`):
//        200 → pase · 401 → rechazo `invalid_client` · 403 → rechazo `secret_rotation_required` ·
//        423 → pausa de 15 min · 429 → pausa según `Retry-After` (60 s si falta) · timeout, red, 5xx
//        o cuerpo ilegible → no responde (sin marca). El cuerpo RFC 7807 de FLIT 2 nunca se reenvía.
// RN-03  Los procesos automáticos (`obtenerPase` / `conPase`) no llaman a FLIT 2 si la fila vigente
//        está marcada como rechazada o tiene una pausa futura: fallan al instante, sin bucle.
// RN-04  `conPase` ante un 401 del recurso descarta el pase y lo renueva UNA vez; si vuelve el 401,
//        se entrega esa respuesta a quien llamó.
// RN-05  «Probar conexión» pide SIEMPRE un pase nuevo y, si sale bien, lo deja como el vigente. Llama
//        aunque la fila esté rechazada (decisión del PO) y, con un 200, limpia las marcas. Solo NO
//        llama con una pausa futura: responde `bloqueado` (423) o `espera` (429) según su motivo.
// RN-06  Un valor de `resultado` por caso (contrato con la pantalla, que pinta su propio texto):
//        `rechazado` = 401 · `cambio_clave` = 403 · `bloqueado` = 423 · `espera` = 429.

import type { Flit2PruebaResultado } from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { Redacted } from '../../shared/utils/crypto.js';
import {
  type Flit2AccesoVigente,
  leerSecretoVigente,
  limpiarMarcas,
  marcarBloqueo,
  marcarRechazo,
} from './flit2-acceso.service.js';
import {
  type Flit2Pase,
  generacionActual,
  guardarPaseEnCache,
  invalidarPase,
  paseEnCache,
  peticionEnVuelo,
  registrarPeticionEnVuelo,
} from './flit2-pase.cache.js';
import {
  Flit2BloqueadoError,
  Flit2NoConfiguradoError,
  Flit2NoRespondeError,
  Flit2RechazadoError,
  Flit2SinAccesoError,
  type Flit2MotivoBloqueo,
  type Flit2MotivoRechazo,
} from './flit2.errors.js';

export { invalidarPase, type Flit2Pase };

const log = loggerFor('flito-sync-flit2');

const RUTA_TOKEN = '/api/v1/external/auth/token';
const SCOPE_PII = 'external.tramites.pii.read';
const TIMEOUT_MS = 10_000;
/** Margen de renovación: con menos de esto por delante, el pase ya no se reutiliza. */
const MARGEN_RENOVACION_MS = 60_000;
/** 423 `client_locked`: FLIT 2 libera el acceso a los 15 min. */
const PAUSA_BLOQUEO_MS = 15 * 60_000;
/** 429 sin `Retry-After` legible. */
const ESPERA_POR_DEFECTO_S = 60;

/** Copy fijo de la prueba (AC de la HU): nunca sale del cuerpo de FLIT 2. */
const MENSAJES = {
  conectado: 'conectado con FLIT 2',
  conectado_sin_pii: 'conectado, pero sin permiso de datos personales: SOAT e impuestos de FLIT 2 quedarán en espera',
  invalid_client: 'usuario o contraseña rechazados por FLIT 2',
  secret_rotation_required: 'FLIT 2 exige cambiar la contraseña de este acceso',
  client_locked: 'FLIT 2 bloqueó temporalmente el acceso; se libera solo en 15 minutos',
  rate_limited: 'FLIT 2 pidió esperar; intenta de nuevo en un minuto',
  no_responde: 'FLIT 2 no responde',
  sin_acceso: 'primero hay que guardar un acceso',
  no_configurado: 'FLIT 2 no está configurado en este ambiente',
} as const;

function baseUrl(): string {
  const base = env.FLIT2_BASE_URL;
  if (!base) throw new Flit2NoConfiguradoError();
  return base;
}

/** Código RFC 7807 de FLIT 2, solo para el log: se acepta si tiene forma de código, nada más. */
async function codigoDeProblema(res: Response): Promise<string | null> {
  try {
    const cuerpo = await res.json() as Record<string, unknown>;
    for (const campo of ['code', 'error', 'type', 'title']) {
      const valor = cuerpo?.[campo];
      if (typeof valor !== 'string') continue;
      const codigo = valor.split('/').pop() ?? '';
      if (/^[a-z_]{1,40}$/.test(codigo)) return codigo;
    }
  } catch { /* cuerpo vacío o no JSON: da igual, manda el estado HTTP */ }
  return null;
}

/** `Retry-After` en segundos o fecha HTTP; acotado a [1 s, 1 h] para que una cabecera rara no congele. */
function segundosDeEspera(cabecera: string | null, ahora: Date): number {
  if (!cabecera) return ESPERA_POR_DEFECTO_S;
  const s = Number(cabecera.trim());
  const segundos = Number.isFinite(s)
    ? s
    : Math.ceil((Date.parse(cabecera) - ahora.getTime()) / 1000);
  if (!Number.isFinite(segundos) || segundos <= 0) return ESPERA_POR_DEFECTO_S;
  return Math.min(segundos, 3600);
}

/** Si la escritura de la marca falla, se registra y se sigue: el error que importa es el de FLIT 2. */
async function marcar(accion: () => Promise<void>, filaId: number): Promise<void> {
  try {
    await accion();
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e), id: filaId }, 'no se pudo marcar el acceso a FLIT 2');
  }
}

async function rechazar(acceso: Flit2AccesoVigente, motivo: Flit2MotivoRechazo): Promise<never> {
  invalidarPase();
  await marcar(() => marcarRechazo(acceso.id, motivo), acceso.id);
  throw new Flit2RechazadoError(motivo);
}

async function pausar(acceso: Flit2AccesoVigente, motivo: Flit2MotivoBloqueo, hasta: Date): Promise<never> {
  await marcar(() => marcarBloqueo(acceso.id, hasta, motivo), acceso.id);
  throw new Flit2BloqueadoError(motivo, hasta);
}

/** Pide un token a FLIT 2 con el acceso dado y traduce la respuesta (RN-02). No toca la caché. */
async function pedirPaseNuevo(base: string, acceso: Flit2AccesoVigente): Promise<Flit2Pase> {
  let res: Response;
  try {
    res = await fetch(new URL(RUTA_TOKEN, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId: acceso.clientId, clientSecret: acceso.secreto.unwrap() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Una redirección reenviaría el clientSecret a otro destino: se rechaza y cae en «no responde».
      redirect: 'error',
    });
  } catch (e) {
    // Solo el nombre del fallo (TimeoutError, TypeError…): el mensaje podría arrastrar la URL.
    log.warn({ causa: e instanceof Error ? e.name : typeof e }, 'FLIT 2 no respondió a la petición de pase');
    throw new Flit2NoRespondeError();
  }

  const ahora = new Date();
  if (res.status === 200) return leerPase(res, ahora);

  const codigo = await codigoDeProblema(res);
  log.warn({ status: res.status, codigo }, 'FLIT 2 no concedió el pase');
  if (res.status === 401) return rechazar(acceso, 'invalid_client');
  if (res.status === 403) return rechazar(acceso, 'secret_rotation_required');
  if (res.status === 423) return pausar(acceso, 'client_locked', new Date(ahora.getTime() + PAUSA_BLOQUEO_MS));
  if (res.status === 429) {
    const segundos = segundosDeEspera(res.headers.get('retry-after'), ahora);
    return pausar(acceso, 'rate_limited', new Date(ahora.getTime() + segundos * 1000));
  }
  throw new Flit2NoRespondeError();
}

async function leerPase(res: Response, ahora: Date): Promise<Flit2Pase> {
  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = await res.json() as Record<string, unknown>;
  } catch {
    log.warn('FLIT 2 respondió 200 al pase con un cuerpo que no es JSON');
    throw new Flit2NoRespondeError();
  }
  const { accessToken, expiresIn, scope } = cuerpo ?? {};
  if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
    log.warn('FLIT 2 respondió 200 al pase sin accessToken o expiresIn válidos');
    throw new Flit2NoRespondeError();
  }
  const permisos = Array.isArray(scope) ? scope.filter((s): s is string => typeof s === 'string') : [];
  return {
    authorization: new Redacted(`Bearer ${accessToken}`),
    scope: permisos,
    conPii: permisos.includes(SCOPE_PII),
    expiraEn: new Date(ahora.getTime() + expiresIn * 1000),
  };
}

/** RN-03: marcas de la fila vigente que impiden llamar desde un proceso automático. */
function exigirSinMarcas(acceso: Flit2AccesoVigente, ahora: Date): void {
  if (acceso.rechazadoEn) throw new Flit2RechazadoError(acceso.rechazoMotivo ?? 'invalid_client');
  if (acceso.bloqueadoHasta && acceso.bloqueadoHasta.getTime() > ahora.getTime()) {
    throw new Flit2BloqueadoError(acceso.bloqueoMotivo ?? 'client_locked', acceso.bloqueadoHasta);
  }
}

/**
 * Pase vigente para los procesos automáticos (RN-01, RN-03). Lanza `Flit2NoConfiguradoError`,
 * `Flit2SinAccesoError`, `Flit2RechazadoError`, `Flit2BloqueadoError` o `Flit2NoRespondeError`.
 */
export async function obtenerPase(): Promise<Flit2Pase> {
  const base = baseUrl();
  const acceso = await leerSecretoVigente();
  const ahora = new Date();
  exigirSinMarcas(acceso, ahora);

  const guardado = paseEnCache(acceso.id);
  if (guardado && guardado.expiraEn.getTime() - ahora.getTime() > MARGEN_RENOVACION_MS) return guardado;

  const pendiente = peticionEnVuelo(acceso.id);
  if (pendiente) return pendiente;

  const generacion = generacionActual();
  const peticion = pedirPaseNuevo(base, acceso).then((pase) => {
    guardarPaseEnCache(acceso.id, pase, generacion);
    return pase;
  });
  registrarPeticionEnVuelo(acceso.id, peticion);
  return peticion;
}

/**
 * Llama a FLIT 2 con el pase vigente (RN-04). `fn` arma la petición con `pase.authorization`; ante
 * un 401 del recurso se descarta el pase y se reintenta UNA sola vez con uno nuevo.
 */
export async function conPase(fn: (pase: Flit2Pase) => Promise<Response>): Promise<Response> {
  const primera = await fn(await obtenerPase());
  if (primera.status !== 401) return primera;
  invalidarPase();
  return fn(await obtenerPase());
}

export interface Flit2Prueba {
  /** Fila probada (para `audit`); `null` si no había acceso o el ambiente no está configurado. */
  filaId: number | null;
  resultado: Flit2PruebaResultado;
}

const prueba = (
  filaId: number | null,
  resultado: Flit2PruebaResultado['resultado'],
  mensaje: string,
  extra: Partial<Pick<Flit2PruebaResultado, 'bloqueadoHasta' | 'scope'>> = {},
): Flit2Prueba => ({
  filaId,
  resultado: { resultado, mensaje, bloqueadoHasta: extra.bloqueadoHasta ?? null, scope: extra.scope ?? [] },
});

/** `POST /acceso/probar` (RN-05). El desenlace es dato: solo la falta de llave o un descifrado roto lanzan. */
export async function probarConexion(): Promise<Flit2Prueba> {
  const base = env.FLIT2_BASE_URL;
  if (!base) return prueba(null, 'no_configurado', MENSAJES.no_configurado);

  let acceso: Flit2AccesoVigente;
  try {
    acceso = await leerSecretoVigente();
  } catch (e) {
    if (e instanceof Flit2SinAccesoError) return prueba(null, 'sin_acceso', MENSAJES.sin_acceso);
    throw e;
  }

  const ahora = new Date();
  if (acceso.bloqueadoHasta && acceso.bloqueadoHasta.getTime() > ahora.getTime()) {
    const hasta = acceso.bloqueadoHasta.toISOString();
    return acceso.bloqueoMotivo === 'rate_limited'
      ? prueba(acceso.id, 'espera', MENSAJES.rate_limited, { bloqueadoHasta: hasta })
      : prueba(acceso.id, 'bloqueado', MENSAJES.client_locked, { bloqueadoHasta: hasta });
  }

  // AC8: pase nuevo siempre, sin mirar la caché ni sumarse a una petición en vuelo.
  const generacion = generacionActual();
  let pase: Flit2Pase;
  try {
    pase = await pedirPaseNuevo(base, acceso);
  } catch (e) {
    if (e instanceof Flit2RechazadoError) {
      return prueba(acceso.id, e.motivo === 'secret_rotation_required' ? 'cambio_clave' : 'rechazado', MENSAJES[e.motivo]);
    }
    if (e instanceof Flit2BloqueadoError) {
      return prueba(acceso.id, e.motivo === 'rate_limited' ? 'espera' : 'bloqueado', MENSAJES[e.motivo], {
        bloqueadoHasta: e.hasta.toISOString(),
      });
    }
    if (e instanceof Flit2NoRespondeError) return prueba(acceso.id, 'no_responde', MENSAJES.no_responde);
    throw e;
  }

  if (acceso.rechazadoEn || acceso.bloqueadoHasta) await marcar(() => limpiarMarcas(acceso.id), acceso.id);
  guardarPaseEnCache(acceso.id, pase, generacion);
  return pase.conPii
    ? prueba(acceso.id, 'conectado', MENSAJES.conectado, { scope: pase.scope })
    : prueba(acceso.id, 'conectado_sin_pii', MENSAJES.conectado_sin_pii, { scope: pase.scope });
}
