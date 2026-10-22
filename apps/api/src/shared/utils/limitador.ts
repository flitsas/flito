/**
 * Semáforo FIFO en memoria: como mucho `max` ejecuciones de `fn` en vuelo a la vez, compartido por
 * todos los que usen la MISMA instancia (a diferencia de `conConcurrencia`, que limita un solo lote).
 *
 * Sin dependencias. El cupo se libera en `finally`, así que un rechazo no lo deja retenido; el error
 * llega intacto a quien llamó. Vale para un proceso: con varias réplicas el tope sería por réplica.
 */
export interface Limitador {
  ejecutar<T>(fn: () => Promise<T>): Promise<T>;
  /** Cuántas ejecuciones hay en vuelo ahora mismo (observabilidad y tests). */
  enVuelo(): number;
}

export function crearLimitador(max: number): Limitador {
  if (!Number.isInteger(max) || max < 1) throw new Error(`crearLimitador: max inválido (${max})`);
  let activos = 0;
  const espera: Array<() => void> = [];

  const adquirir = (): Promise<void> => {
    if (activos < max) { activos++; return Promise.resolve(); }
    // El cupo pasa directo al siguiente en `liberar`: `activos` no baja ni sube en el traspaso.
    return new Promise<void>((resolve) => { espera.push(resolve); });
  };
  const liberar = (): void => {
    const siguiente = espera.shift();
    if (siguiente) siguiente(); else activos--;
  };

  return {
    async ejecutar<T>(fn: () => Promise<T>): Promise<T> {
      await adquirir();
      try {
        return await fn();
      } finally {
        liberar();
      }
    },
    enVuelo: () => activos,
  };
}
