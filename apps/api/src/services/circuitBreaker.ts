// Circuit breaker simple sin dependencias externas
interface CBState { failures: number; lastFailure: number; open: boolean; }

const circuits = new Map<string, CBState>();
const THRESHOLD = 5;
const RESET_MS = 60000; // 1 min

/**
 * Rechazo por circuito abierto: la llamada NO se intentó.
 *
 * El `message` conserva el texto histórico —hay servicios que lo propagan tal cual a sus logs— pero
 * el nombre del circuito viaja además en `circuito`, para que quien traduce el error a un mensaje de
 * usuario pueda reconocer la causa sin tener que parsear la cadena, y sobre todo sin filtrar una
 * clave interna (`siigo:catalogos:pruebas:tax`) a una pantalla de operación.
 */
export class CircuitoAbiertoError extends Error {
  readonly circuito: string;

  constructor(circuito: string) {
    super(`Servicio ${circuito} temporalmente no disponible`);
    this.name = 'CircuitoAbiertoError';
    this.circuito = circuito;
  }
}

/**
 * ¿Está abierto el circuito AHORA MISMO? Consulta pura: no toca el estado.
 *
 * Existe para poder decidir ANTES de empezar un trabajo que se sabe que va a rebotar. El caso que la
 * motiva es concreto y caro: `emitirFactura` reserva la clave de idempotencia y solo entonces llama
 * a Siigo. Con el circuito abierto, la llamada muere con `CircuitoAbiertoError` —que no es un
 * `SiigoApiError`—, así que el emisor no puede afirmar que Siigo la rechazara y deja la fila
 * `en_proceso`, que es lo correcto: no sabe si el POST salió. Pero el POST no salió nunca. Resultado:
 * una factura reservada ocupando su trámite unos 45 minutos —lo que tarde el arrendamiento más el
 * barrido— por una petición que jamás se hizo. Preguntar antes cuesta un `Map.get`.
 *
 * **Respeta el medio abierto.** Pasado `RESET_MS` desde el último fallo, `withCircuitBreaker` deja
 * pasar la siguiente llamada para probar si el servicio volvió; decir «abierto» aquí impediría esa
 * prueba y el circuito no se cerraría nunca. Y no muta nada: quien decide reabrir es la llamada real,
 * no quien pregunta.
 */
export function circuitoAbierto(name: string): boolean {
  const state = circuits.get(name);
  if (!state || !state.open) return false;
  return Date.now() - state.lastFailure <= RESET_MS;
}

export function withCircuitBreaker<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const state = circuits.get(name) || { failures: 0, lastFailure: 0, open: false };

  if (state.open) {
    if (Date.now() - state.lastFailure > RESET_MS) {
      state.open = false; state.failures = 0; // half-open
    } else {
      return Promise.reject(new CircuitoAbiertoError(name));
    }
  }

  return fn().then(result => {
    state.failures = 0; state.open = false;
    circuits.set(name, state);
    return result;
  }).catch(err => {
    state.failures++;
    state.lastFailure = Date.now();
    if (state.failures >= THRESHOLD) state.open = true;
    circuits.set(name, state);
    throw err;
  });
}
