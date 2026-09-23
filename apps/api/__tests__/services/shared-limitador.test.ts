// HU #12825 (AC3) — el limitador global en memoria: tope, orden FIFO y liberación ante rechazos.
import { describe, it, expect } from 'vitest';
import { crearLimitador } from '../../src/shared/utils/limitador.js';

const diferido = () => {
  let resolve!: () => void; let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tic = () => new Promise((r) => setImmediate(r));

describe('crearLimitador', () => {
  it('con 6 tareas nunca hay más de 2 en vuelo, y todas terminan', async () => {
    const lim = crearLimitador(2);
    let enVuelo = 0; let pico = 0;
    const tareas = Array.from({ length: 6 }, (_, i) => lim.ejecutar(async () => {
      enVuelo++; pico = Math.max(pico, enVuelo, lim.enVuelo());
      await tic();
      enVuelo--;
      return i;
    }));
    expect(await Promise.all(tareas)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pico).toBe(2);
    expect(lim.enVuelo()).toBe(0);
  });

  it('las que esperan entran en orden de llegada (FIFO)', async () => {
    const lim = crearLimitador(1);
    const orden: number[] = [];
    const bloqueo = diferido();
    const primera = lim.ejecutar(() => bloqueo.promise);
    const resto = [1, 2, 3].map((n) => lim.ejecutar(async () => { orden.push(n); }));
    await tic();
    expect(orden).toEqual([]); // la primera retiene el único cupo
    bloqueo.resolve();
    await Promise.all([primera, ...resto]);
    expect(orden).toEqual([1, 2, 3]);
  });

  it('un rechazo llega a quien llamó y no deja el cupo retenido', async () => {
    const lim = crearLimitador(1);
    await expect(lim.ejecutar(async () => { throw new Error('runt caído'); })).rejects.toThrow('runt caído');
    expect(lim.enVuelo()).toBe(0);
    await expect(lim.ejecutar(async () => 'ok')).resolves.toBe('ok');
  });

  it('un rechazo con otra en espera le pasa el cupo, sin superar el tope', async () => {
    const lim = crearLimitador(1);
    const falla = diferido();
    const a = lim.ejecutar(() => falla.promise);
    const b = lim.ejecutar(async () => lim.enVuelo());
    falla.reject(new Error('x'));
    await expect(a).rejects.toThrow('x');
    expect(await b).toBe(1);
    expect(lim.enVuelo()).toBe(0);
  });

  it('rechaza un tope inválido', () => {
    expect(() => crearLimitador(0)).toThrow();
  });
});

describe('limitadorRunt — la instancia del proceso', () => {
  it('el tope es 2 (CONCURRENCIA_CERTIFICACION): con 3 simultáneas, 2 en vuelo y 1 esperando', async () => {
    const { limitadorRunt } = await import('../../src/modules/flito-impuestos/runt-limitador.js');
    const soltar: Array<() => void> = [];
    let arrancadas = 0;
    const tareas = [0, 1, 2].map(() => limitadorRunt.ejecutar(() => {
      arrancadas++;
      return new Promise<void>((res) => { soltar.push(res); });
    }));
    await tic();
    expect(limitadorRunt.enVuelo()).toBe(2);
    expect(arrancadas).toBe(2);

    soltar[0]!();
    await tic();
    expect(arrancadas).toBe(3);
    expect(limitadorRunt.enVuelo()).toBe(2);

    soltar[1]!(); soltar[2]!();
    await Promise.all(tareas);
    expect(limitadorRunt.enVuelo()).toBe(0);
  });
});
