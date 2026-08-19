// Siigo API — diagnóstico de conexión (HU #11253).
//
// Antes de emitir una factura ante la DIAN conviene poder responder «¿esto está bien configurado?»
// sin arriesgar un comprobante. Eso es todo lo que hace este servicio.
//
// Nunca lanza: un diagnóstico que revienta no diagnostica nada. Todos los fallos se traducen a un
// resultado con `codigo`, para que la pantalla sepa qué decirle a quien lo ejecuta en vez de
// mostrarle una traza.

import { obtenerCredencialActiva, SiigoCredencialError, type SiigoAmbiente } from './credenciales.service.js';
import { resolverConfig, SiigoConfigError } from './siigo.config.js';
import { obtenerToken, SiigoAuthError } from './siigo.token.js';
import { siigoRequest } from './siigo.client.js';
import { traducirErrorSiigo } from './siigo.errors.js';
import { modoSiigo } from './siigo.mock.js';
import { ejecutarConResiliencia, SiigoOperacionFallida } from './siigo.resiliencia.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { SiigoEncKeyError } from '../../shared/utils/crypto.js';

/** Ruta liviana: un catálogo pequeño basta para probar credenciales y cabeceras de punta a punta. */
const RUTA_SONDA = '/v1/document-types?type=FV';

export type CodigoDiagnostico =
  | 'ok'
  | 'sin_configuracion'
  | 'sin_credenciales'
  | 'llave_maestra'
  | 'credenciales_rechazadas'
  | 'servicio_no_disponible'
  | 'error_inesperado';

export interface ResultadoDiagnostico {
  ok: boolean;
  codigo: CodigoDiagnostico;
  mensaje: string;
  ambiente: string;
  modo: string;
  /** Usuario de la credencial activa. Nunca el access_key. */
  username: string | null;
  /** true si se obtuvo un token utilizable. */
  tokenObtenido: boolean;
  duracionMs: number;
}

interface OpcionesDiagnostico {
  ambiente?: SiigoAmbiente;
  usuarioId?: number | null;
}

/**
 * Ejecuta la prueba de conexión.
 *
 * Pasa por el control de tasa como cualquier otra operación: pulsar el botón diez veces seguidas no
 * puede consumir la cuota que necesitan las facturas. Pero con UN solo intento — de un diagnóstico
 * se espera la verdad inmediata, no un resultado tras cuatro reintentos silenciosos.
 */
export async function probarConexion(opciones: OpcionesDiagnostico = {}): Promise<ResultadoDiagnostico> {
  const inicio = Date.now();
  const modo = modoSiigo();
  let ambiente = opciones.ambiente ?? 'pruebas';
  let username: string | null = null;

  const responder = (
    codigo: CodigoDiagnostico, mensaje: string, extra: { tokenObtenido?: boolean } = {},
  ): ResultadoDiagnostico => ({
    ok: codigo === 'ok',
    codigo,
    mensaje,
    ambiente,
    modo,
    username,
    tokenObtenido: extra.tokenObtenido ?? false,
    duracionMs: Date.now() - inicio,
  });

  try {
    const config = resolverConfig();
    ambiente = opciones.ambiente ?? config.ambiente;

    // Se resuelve la credencial aparte del token para poder mostrar el usuario en el resultado y
    // distinguir «no hay credenciales» de «Siigo las rechazó».
    if (modo === 'real') {
      const credencial = await obtenerCredencialActiva(ambiente);
      username = credencial.username;
    }

    const resultado = await ejecutarConResiliencia(async () => {
      await obtenerToken(ambiente, { forzarRenovacion: true });
      return siigoRequest({ metodo: 'GET', ruta: RUTA_SONDA, ambiente, timeoutMs: 30_000 });
    }, { clave: `diagnostico:${ambiente}`, maxIntentos: 1 });

    if (!resultado.ok) {
      const e = traducirErrorSiigo(resultado.status, resultado.datos);
      const r = responder('servicio_no_disponible',
        `Se obtuvo el token pero Siigo respondió ${resultado.status} al consultar un catálogo: ${e.descripcionOperativa}`,
        { tokenObtenido: true });
      await registrar(r, opciones.usuarioId, resultado.status, e.code);
      return r;
    }

    const r = responder('ok',
      `Conexión correcta con Siigo en el ambiente "${ambiente}" (modo ${modo}). El token se obtuvo y el catálogo respondió.`,
      { tokenObtenido: true });
    await registrar(r, opciones.usuarioId, resultado.status, null);
    return r;
  } catch (e) {
    const r = aResultado(e, responder);
    await registrar(r, opciones.usuarioId, null, r.codigo);
    return r;
  }
}

/**
 * Traduce cada fallo conocido a un mensaje que dice qué hacer, no qué se rompió.
 *
 * Lo primero es DESENVOLVER: `ejecutarConResiliencia` empaqueta lo que falla dentro de un
 * `SiigoOperacionFallida`, así que sin esto un rechazo de credenciales llegaría disfrazado de
 * «servicio no disponible» y mandaría a quien opera a mirar el estado de Siigo en vez de sus llaves.
 */
function aResultado(
  entrada: unknown,
  responder: (c: CodigoDiagnostico, m: string, x?: { tokenObtenido?: boolean }) => ResultadoDiagnostico,
): ResultadoDiagnostico {
  const e = entrada instanceof SiigoOperacionFallida ? entrada.causa : entrada;

  if (e instanceof SiigoConfigError) {
    return responder('sin_configuracion', `${e.message} Configúralo en las variables de entorno del servidor.`);
  }
  if (e instanceof SiigoEncKeyError) {
    return responder('llave_maestra', e.message);
  }
  if (e instanceof SiigoCredencialError) {
    if (e.codigo === 'no_configurada') {
      return responder('sin_credenciales',
        `${e.message} Regístralas en Administración › Integración con Siigo.`);
    }
    if (e.codigo === 'llave_maestra') return responder('llave_maestra', e.message);
    return responder('credenciales_rechazadas', e.message);
  }
  if (e instanceof SiigoAuthError) {
    return responder('credenciales_rechazadas', e.message);
  }

  // Cualquier otra cosa —red caída, timeout, fallo del cortacircuitos— es indisponibilidad del
  // servicio, no un problema de credenciales. Distinguirlo es justo lo que pide AC4.
  const detalle = e instanceof Error ? e.message : String(e);
  return responder('servicio_no_disponible',
    `No se pudo completar la prueba de conexión con Siigo: ${detalle}`);
}

async function registrar(
  r: ResultadoDiagnostico, usuarioId: number | null | undefined,
  statusHttp: number | null, codigo: string | null,
): Promise<void> {
  await registrarOperacion({
    operacion: 'diagnostico_conexion',
    metodo: 'GET',
    ruta: RUTA_SONDA,
    ambiente: r.ambiente,
    modo: r.modo,
    statusHttp,
    resultado: r.ok ? 'ok' : 'error_tecnico',
    codigo,
    mensaje: r.mensaje,
    duracionMs: r.duracionMs,
    createdBy: usuarioId ?? null,
  });
}
