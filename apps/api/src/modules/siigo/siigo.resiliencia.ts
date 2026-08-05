// Siigo API — control de tasa, reintentos y cortacircuitos (HU #11249).
//
// Siigo permite 100 peticiones por minuto POR EMPRESA y bloquea temporalmente el usuario API si
// durante 7 días la proporción de errores supera el 80 % del total. Las dos cifras juntas obligan a
// algo más que un `try/catch`: hay que autolimitarse antes de que Siigo tenga que hacerlo, y hay que
// dejar de insistir cuando insistir no arregla nada.
//
// Tres decisiones que sostienen eso:
//
//   1. Los errores de DATOS no cuentan para el cortacircuitos. Un `parameter_required` significa que
//      nuestro payload está mal, no que Siigo esté caído. Si contara, un lote con un dato malo
//      abriría el circuito y frenaría facturas sanas de otros clientes.
//   2. `dormir` y `ahora` se inyectan. Un limitador que llama a `setTimeout` a 60 s es imposible de
//      probar de verdad; inyectándolos, el test recorre una ventana entera sin esperar.
//   3. El excedente ESPERA, no se descarta. Una factura que se cae de la cola por exceso de tráfico
//      es una factura que alguien tiene que descubrir a mano.

import { withCircuitBreaker } from '../../services/circuitBreaker.js';
import { SiigoApiError } from './siigo.errors.js';

/** Tope documentado por Siigo, por empresa. */
export const MAX_PETICIONES_POR_VENTANA = 100;
export const VENTANA_MS = 60_000;

const MAX_INTENTOS_POR_DEFECTO = 4;
const BACKOFF_BASE_MS = 1_000;
/** Techo del backoff: más allá, esperar no aporta y solo retiene la cola. */
const BACKOFF_MAX_MS = 30_000;

/** Una operación agotó sus reintentos o fue rechazada sin posibilidad de reintento. */
export class SiigoOperacionFallida extends Error {
  readonly intentos: number;
  /** true = no se volverá a intentar automáticamente. Requiere intervención. */
  readonly definitivo: boolean;
  /** true = falló por un dato nuestro; corregirlo es la vía, no reintentar. */
  readonly requiereCorreccionDeDatos: boolean;
  readonly causa: unknown;

  constructor(args: {
    message: string; intentos: number; definitivo: boolean;
    requiereCorreccionDeDatos: boolean; causa: unknown;
  }) {
    super(args.message);
    this.name = 'SiigoOperacionFallida';
    this.intentos = args.intentos;
    this.definitivo = args.definitivo;
    this.requiereCorreccionDeDatos = args.requiereCorreccionDeDatos;
    this.causa = args.causa;
  }
}

export interface OpcionesResiliencia {
  /** Aísla el cupo por empresa. Con una sola empresa basta el valor por defecto. */
  clave?: string;
  maxIntentos?: number;
  baseBackoffMs?: number;
  /** Inyectables para poder probar el paso del tiempo sin esperarlo. */
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
  /** Se invoca en cada reintento. Lo usa la bitácora para dejar rastro del intento. */
  alReintentar?: (info: { intento: number; esperaMs: number; error: unknown }) => void;
}

const dormirReal = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

// ── Limitador de tasa: ventana deslizante por clave ─────────────────────────
//
// Se guardan las marcas de tiempo de las peticiones de la última ventana. Cuando hay 100, se espera
// justo hasta que la más antigua salga de la ventana. Es más preciso que un contador por minuto
// fijo, que permite 200 peticiones a caballo entre dos minutos.

const ventanas = new Map<string, number[]>();

/** Solo para tests y para el arranque del proceso. */
export function reiniciarLimitador(): void {
  ventanas.clear();
}

/** Peticiones registradas en la ventana vigente. Útil para diagnóstico. */
export function peticionesEnVentana(clave: string, ahora: () => number = Date.now): number {
  const t = ahora();
  return (ventanas.get(clave) ?? []).filter((x) => t - x < VENTANA_MS).length;
}

async function esperarTurno(
  clave: string, ahora: () => number, dormir: (ms: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    const t = ahora();
    const vigentes = (ventanas.get(clave) ?? []).filter((x) => t - x < VENTANA_MS);

    if (vigentes.length < MAX_PETICIONES_POR_VENTANA) {
      vigentes.push(t);
      ventanas.set(clave, vigentes);
      return;
    }

    // La más antigua marca cuándo se libera un cupo. +1 ms para no despertar justo en el borde.
    const esperaMs = VENTANA_MS - (t - vigentes[0]!) + 1;
    ventanas.set(clave, vigentes);
    await dormir(esperaMs);
  }
}

/** Espera creciente con tope. El tope evita que el intento 6 duerma media hora. */
export function backoffMs(intento: number, base = BACKOFF_BASE_MS): number {
  return Math.min(base * 2 ** (intento - 1), BACKOFF_MAX_MS);
}

/**
 * ¿El fallo es culpa de un dato nuestro? Esos no se reintentan ni abren el circuito.
 *
 * Es un predicado de tipo y no un `boolean` a propósito: quien lo usa necesita seguir viendo un
 * `SiigoApiError` para poder leer su descripción operativa.
 */
function esErrorDeDatos(e: unknown): e is SiigoApiError {
  return e instanceof SiigoApiError && !e.reintentable;
}

/**
 * Ejecuta una operación contra Siigo respetando el límite de tasa, con reintentos de espera
 * creciente y protegida por el cortacircuitos.
 *
 * Cada intento consume un cupo de la ventana: un reintento es una petición más para Siigo, y no
 * contarlo sería justo la forma de superar el límite mientras se cree que se respeta.
 */
export async function ejecutarConResiliencia<T>(
  operacion: () => Promise<T>,
  opciones: OpcionesResiliencia = {},
): Promise<T> {
  const clave = opciones.clave ?? 'siigo';
  const maxIntentos = opciones.maxIntentos ?? MAX_INTENTOS_POR_DEFECTO;
  const base = opciones.baseBackoffMs ?? BACKOFF_BASE_MS;
  const dormir = opciones.dormir ?? dormirReal;
  const ahora = opciones.ahora ?? Date.now;

  let ultimoError: unknown = null;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    await esperarTurno(clave, ahora, dormir);

    try {
      // El cortacircuitos solo debe ver fallos DEL SERVICIO. Un error de datos se envuelve para que
      // salga del breaker como éxito y se vuelve a lanzar fuera: así no suma al contador de fallos.
      const resultado = await withCircuitBreaker(`siigo:${clave}`, async () => {
        try {
          return { ok: true as const, valor: await operacion() };
        } catch (e) {
          if (esErrorDeDatos(e)) return { ok: false as const, error: e };
          throw e;
        }
      });

      if (resultado.ok) return resultado.valor;

      // Error de datos: definitivo desde el primer intento. Reintentar un payload inválido solo
      // gasta cuota para recibir exactamente el mismo rechazo.
      const err = resultado.error;
      throw new SiigoOperacionFallida({
        message: err.descripcionOperativa,
        intentos: intento,
        definitivo: true,
        requiereCorreccionDeDatos: true,
        causa: err,
      });
    } catch (e) {
      if (e instanceof SiigoOperacionFallida) throw e;

      ultimoError = e;
      const quedanIntentos = intento < maxIntentos;
      if (!quedanIntentos) break;

      const esperaMs = backoffMs(intento, base);
      opciones.alReintentar?.({ intento, esperaMs, error: e });
      await dormir(esperaMs);
    }
  }

  const detalle = ultimoError instanceof Error ? ultimoError.message : String(ultimoError);
  throw new SiigoOperacionFallida({
    message: `La operación contra Siigo falló tras ${maxIntentos} intentos: ${detalle}`,
    intentos: maxIntentos,
    definitivo: true,
    requiereCorreccionDeDatos: false,
    causa: ultimoError,
  });
}
