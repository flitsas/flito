// Circuit breaker simple sin dependencias externas
interface CBState { failures: number; lastFailure: number; open: boolean; }

const circuits = new Map<string, CBState>();
const THRESHOLD = 5;
const RESET_MS = 60000; // 1 min

export function withCircuitBreaker<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const state = circuits.get(name) || { failures: 0, lastFailure: 0, open: false };

  if (state.open) {
    if (Date.now() - state.lastFailure > RESET_MS) {
      state.open = false; state.failures = 0; // half-open
    } else {
      return Promise.reject(new Error(`Servicio ${name} temporalmente no disponible`));
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
