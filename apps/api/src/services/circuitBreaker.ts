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
