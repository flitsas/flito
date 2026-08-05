// HU #11249 — control de tasa, reintentos y cortacircuitos (Feature #11239).
//
// El tiempo se inyecta en vez de simularse con temporizadores: así el test recorre una ventana
// entera de 60 s sin esperarla y sin depender del reloj del runner.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ejecutarConResiliencia, reiniciarLimitador, peticionesEnVentana, backoffMs,
  SiigoOperacionFallida, MAX_PETICIONES_POR_VENTANA, VENTANA_MS,
} from '../../src/modules/siigo/siigo.resiliencia.js';
import { SiigoApiError } from '../../src/modules/siigo/siigo.errors.js';

/** Reloj controlable: `dormir` adelanta el tiempo en vez de esperarlo. */
function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  const dormidas: number[] = [];
  return {
    ahora: () => t,
    dormir: async (ms: number) => { dormidas.push(ms); t += ms; },
    avanzar: (ms: number) => { t += ms; },
    dormidas,
  };
}

function errorDeDatos(code = 'parameter_required') {
  return new SiigoApiError({
    status: 400, code, message: `falta ${code}`, params: ['date'], reintentable: false,
  });
}

function errorTransitorio(code = 'service_unavailable') {
  return new SiigoApiError({
    status: 503, code, message: 'Siigo no disponible', reintentable: true,
  });
}

/** Clave distinta por test: el cortacircuitos guarda estado global por nombre. */
let n = 0;
const claveUnica = () => `test-${++n}`;

beforeEach(() => { reiniciarLimitador(); });

describe('AC1 — nunca se supera el límite', () => {
  it('300 operaciones se procesan todas sin pasar de 100 por minuto', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();
    let ejecutadas = 0;

    for (let i = 0; i < 300; i++) {
      await ejecutarConResiliencia(async () => { ejecutadas++; }, {
        clave, ahora: reloj.ahora, dormir: reloj.dormir,
      });
    }

    // Ninguna se pierde.
    expect(ejecutadas).toBe(300);
    // Y en ningún instante la ventana llegó a superar el tope.
    expect(peticionesEnVentana(clave, reloj.ahora)).toBeLessThanOrEqual(MAX_PETICIONES_POR_VENTANA);
    // 300 peticiones a 100 por ventana exigen haber esperado al menos dos ventanas.
    expect(reloj.dormidas.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2 * VENTANA_MS);
  });

  it('las primeras 100 no esperan nada', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();

    for (let i = 0; i < MAX_PETICIONES_POR_VENTANA; i++) {
      await ejecutarConResiliencia(async () => i, { clave, ahora: reloj.ahora, dormir: reloj.dormir });
    }
    expect(reloj.dormidas).toHaveLength(0);
  });

  it('la 101 espera justo hasta que la más antigua sale de la ventana', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();

    for (let i = 0; i < MAX_PETICIONES_POR_VENTANA; i++) {
      await ejecutarConResiliencia(async () => i, { clave, ahora: reloj.ahora, dormir: reloj.dormir });
    }
    // 10 s después, la ventana sigue llena.
    reloj.avanzar(10_000);
    await ejecutarConResiliencia(async () => 'extra', { clave, ahora: reloj.ahora, dormir: reloj.dormir });

    expect(reloj.dormidas).toHaveLength(1);
    // Faltaban 50 s para que la primera saliera de la ventana (+1 ms de margen).
    expect(reloj.dormidas[0]).toBe(VENTANA_MS - 10_000 + 1);
  });

  it('el cupo es por clave: dos empresas no se estorban', async () => {
    const reloj = relojFalso();
    const a = claveUnica();
    const b = claveUnica();

    for (let i = 0; i < MAX_PETICIONES_POR_VENTANA; i++) {
      await ejecutarConResiliencia(async () => i, { clave: a, ahora: reloj.ahora, dormir: reloj.dormir });
    }
    await ejecutarConResiliencia(async () => 'otra', { clave: b, ahora: reloj.ahora, dormir: reloj.dormir });

    expect(reloj.dormidas).toHaveLength(0);
  });

  it('pasada la ventana el cupo se libera solo', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();

    for (let i = 0; i < MAX_PETICIONES_POR_VENTANA; i++) {
      await ejecutarConResiliencia(async () => i, { clave, ahora: reloj.ahora, dormir: reloj.dormir });
    }
    reloj.avanzar(VENTANA_MS + 1);
    expect(peticionesEnVentana(clave, reloj.ahora)).toBe(0);
  });
});

describe('AC2 — respuesta de límite excedido', () => {
  it('un 429 se reintenta con espera creciente', async () => {
    const reloj = relojFalso();
    let intentos = 0;
    const op = vi.fn(async () => {
      intentos++;
      if (intentos < 3) throw new SiigoApiError({
        status: 429, code: 'requests_limit', message: 'demasiadas', reintentable: true,
      });
      return 'ok';
    });

    const r = await ejecutarConResiliencia(op, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir, baseBackoffMs: 100,
    });

    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
    // Creciente: 100 ms, luego 200 ms.
    expect(reloj.dormidas).toEqual([100, 200]);
  });

  it('cada reintento se reporta con su número de intento', async () => {
    const reloj = relojFalso();
    const reintentos: number[] = [];
    let intentos = 0;

    await ejecutarConResiliencia(async () => {
      intentos++;
      if (intentos < 3) throw errorTransitorio();
      return 'ok';
    }, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir, baseBackoffMs: 10,
      alReintentar: ({ intento }) => reintentos.push(intento),
    });

    expect(reintentos).toEqual([1, 2]);
  });

  it('mientras queden reintentos la operación no se marca como fallida', async () => {
    const reloj = relojFalso();
    let intentos = 0;
    const r = await ejecutarConResiliencia(async () => {
      intentos++;
      if (intentos === 1) throw errorTransitorio();
      return 'recuperada';
    }, { clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir, baseBackoffMs: 5 });

    expect(r).toBe('recuperada');
  });

  it('el backoff crece exponencialmente y se topa', () => {
    expect(backoffMs(1, 1000)).toBe(1000);
    expect(backoffMs(2, 1000)).toBe(2000);
    expect(backoffMs(3, 1000)).toBe(4000);
    // Sin tope, el intento 10 dormiría más de ocho minutos.
    expect(backoffMs(10, 1000)).toBe(30_000);
  });

  it('cada reintento consume cupo: un reintento también es una petición para Siigo', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();
    let intentos = 0;

    await ejecutarConResiliencia(async () => {
      intentos++;
      if (intentos < 3) throw errorTransitorio();
      return 'ok';
    }, { clave, ahora: reloj.ahora, dormir: reloj.dormir, baseBackoffMs: 1 });

    expect(peticionesEnVentana(clave, reloj.ahora)).toBe(3);
  });
});

describe('AC5 — los reintentos tienen fin', () => {
  it('agotados los intentos la operación queda fallida definitiva', async () => {
    const reloj = relojFalso();
    const op = vi.fn(async () => { throw errorTransitorio(); });

    const err = await ejecutarConResiliencia(op, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
      maxIntentos: 3, baseBackoffMs: 1,
    }).catch((e: SiigoOperacionFallida) => e);

    expect(err).toBeInstanceOf(SiigoOperacionFallida);
    expect((err as SiigoOperacionFallida).definitivo).toBe(true);
    expect((err as SiigoOperacionFallida).intentos).toBe(3);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('no reintenta más allá del máximo, aunque el error siga siendo transitorio', async () => {
    const reloj = relojFalso();
    const op = vi.fn(async () => { throw errorTransitorio(); });

    await ejecutarConResiliencia(op, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
      maxIntentos: 2, baseBackoffMs: 1,
    }).catch(() => null);

    expect(op).toHaveBeenCalledTimes(2);
    // Una sola espera entre los dos intentos: no duerme después del último.
    expect(reloj.dormidas).toEqual([1]);
  });

  it('el fallo definitivo conserva la causa para poder diagnosticar', async () => {
    const reloj = relojFalso();
    const causa = errorTransitorio('request_timeout');

    const err = await ejecutarConResiliencia(async () => { throw causa; }, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
      maxIntentos: 2, baseBackoffMs: 1,
    }).catch((e: SiigoOperacionFallida) => e);

    expect((err as SiigoOperacionFallida).causa).toBe(causa);
  });
});

describe('AC6 — los errores de datos no se reintentan', () => {
  it('un parameter_required falla al primer intento', async () => {
    const reloj = relojFalso();
    const op = vi.fn(async () => { throw errorDeDatos(); });

    const err = await ejecutarConResiliencia(op, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
    }).catch((e: SiigoOperacionFallida) => e);

    expect(op).toHaveBeenCalledTimes(1);
    expect((err as SiigoOperacionFallida).requiereCorreccionDeDatos).toBe(true);
    expect((err as SiigoOperacionFallida).definitivo).toBe(true);
    expect((err as SiigoOperacionFallida).intentos).toBe(1);
  });

  it('el mensaje es el operativo, no el crudo de Siigo', async () => {
    const reloj = relojFalso();
    const err = await ejecutarConResiliencia(async () => { throw errorDeDatos(); }, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
    }).catch((e: SiigoOperacionFallida) => e);

    expect((err as Error).message).toMatch(/Falta un parámetro obligatorio/);
    expect((err as Error).message).toContain('Campo: date');
  });

  it('no duerme nada: no hay espera que valga para un dato inválido', async () => {
    const reloj = relojFalso();
    await ejecutarConResiliencia(async () => { throw errorDeDatos(); }, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
    }).catch(() => null);

    expect(reloj.dormidas).toHaveLength(0);
  });
});

describe('AC4 — el circuito se abre ante fallos sostenidos', () => {
  it('tras varios fallos de servicio, las siguientes se rechazan de inmediato', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();
    const op = vi.fn(async () => { throw errorTransitorio(); });

    // El umbral del cortacircuitos compartido es de 5 fallos.
    for (let i = 0; i < 3; i++) {
      await ejecutarConResiliencia(op, {
        clave, ahora: reloj.ahora, dormir: reloj.dormir, maxIntentos: 2, baseBackoffMs: 1,
      }).catch(() => null);
    }

    const llamadasAntes = op.mock.calls.length;
    await ejecutarConResiliencia(op, {
      clave, ahora: reloj.ahora, dormir: reloj.dormir, maxIntentos: 1,
    }).catch(() => null);

    // Con el circuito abierto, la operación ni siquiera se invoca.
    expect(op.mock.calls.length).toBe(llamadasAntes);
  });

  it('un error de DATOS no abre el circuito: el payload está mal, Siigo no está caído', async () => {
    const reloj = relojFalso();
    const clave = claveUnica();
    const op = vi.fn(async () => { throw errorDeDatos(); });

    // Muchos más que el umbral del cortacircuitos.
    for (let i = 0; i < 10; i++) {
      await ejecutarConResiliencia(op, { clave, ahora: reloj.ahora, dormir: reloj.dormir })
        .catch(() => null);
    }
    expect(op).toHaveBeenCalledTimes(10);

    // Y una operación sana después sigue pasando: el circuito nunca se abrió.
    const r = await ejecutarConResiliencia(async () => 'sana', {
      clave, ahora: reloj.ahora, dormir: reloj.dormir,
    });
    expect(r).toBe('sana');
  });
});

describe('camino feliz', () => {
  it('una operación correcta devuelve su valor sin dormir ni reintentar', async () => {
    const reloj = relojFalso();
    const op = vi.fn(async () => ({ id: 'inv-1' }));

    const r = await ejecutarConResiliencia(op, {
      clave: claveUnica(), ahora: reloj.ahora, dormir: reloj.dormir,
    });

    expect(r).toEqual({ id: 'inv-1' });
    expect(op).toHaveBeenCalledTimes(1);
    expect(reloj.dormidas).toHaveLength(0);
  });
});
