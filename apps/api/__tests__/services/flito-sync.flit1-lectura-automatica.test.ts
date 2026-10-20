// HU #13629 (Feature #13612, Épica #13576) — un tick de la lectura automática de FLIT 1: interruptor (AC7),
// candado (AC5), parámetros releídos en cada tick (AC8), escrituras del estado (AC1, AC2, AC4), semilla
// (AC3) y logs sin PII (AC10). El candado se mockea en `candado-advisory.ts` (su mecanismo lo cubre
// `flito-sync.flit2-candado.test.ts`); `sincronizar` se mockea (su escritura la cubren los tests del sync).
// La base es un doble mínimo que registra la proyección pedida y cada `SET`. Datos SINTÉTICOS.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.TZ = 'UTC';

const st = vi.hoisted(() => ({
  fila: undefined as Record<string, unknown> | undefined,
  proyeccion: [] as string[],
  updates: [] as Record<string, unknown>[],
  selectThrow: null as unknown,
  ocupado: false,
  claves: [] as unknown[],
}));
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: (proj: Record<string, unknown>) => {
      st.proyeccion = Object.keys(proj);
      return { from: () => ({ where: () => ({ limit: async () => {
        if (st.selectThrow) throw st.selectThrow;
        return st.fila ? [st.fila] : [];
      } }) }) };
    },
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: async () => { st.updates.push(s); } }) }),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/modules/flito-sync/candado-advisory.js', () => ({
  conCandado: async (clave: unknown, fn: () => Promise<unknown>) => {
    st.claves.push(clave);
    if (st.ocupado) return { tomado: false };
    return { tomado: true, valor: await fn() };
  },
}));
const interruptor = vi.hoisted(() => ({ fuenteHabilitada: vi.fn() }));
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', () => interruptor);
const sync = vi.hoisted(() => ({
  sincronizar: vi.fn(), leerUltimaSincronizacion: vi.fn(), guardarUltimaSincronizacion: vi.fn(),
}));
vi.mock('../../src/modules/flito-sync/flito-sync.service.js', () => sync);
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
const entorno = vi.hoisted(() => ({ syncHabilitado: true }));
vi.mock('../../src/config/env.js', async (orig) => {
  const real = (await orig()) as { env: Record<string, unknown> };
  return { env: new Proxy(real.env, { get: (t, k) => {
    if (k === 'SYNC_HABILITADO') return entorno.syncHabilitado;
    if (k === 'FLIT2_SYNC_CRON') return false;
    return t[k as string];
  } }) };
});
vi.mock('../../src/modules/flito-sync/flit2-lectura.service.js', () => ({ leerConCandado: vi.fn() }));

const { correrLecturaFlit1Programada, CLAVE_CANDADO_LECTURA_FLIT1, codigoFalloFlit1 } =
  await import('../../src/modules/flito-sync/flit1-lectura-automatica.service.js');
const { Flit1ReporteError } = await import('../../src/modules/flito-sync/flit-http.adapter.js');
const { startFlitSync, stopFlitSync, tickLecturaFlit1, TICK_FLIT1_MS } = await import('../../src/modules/flito-sync/flito-sync.cron.js');

const AHORA = new Date('2026-10-16T15:00:00Z'); // 10:00 en Bogotá
const MIN = 60_000;
const hace = (ms: number) => new Date(AHORA.getTime() - ms);
const CEDULA = '1023456789';

function filaBase(over: Record<string, unknown> = {}) {
  return {
    frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null,
    ultimaCorridaEn: hace(2 * MIN), ultimaBuenaEn: hace(2 * MIN), nocturnaBuenaDia: '2026-10-16',
    proximaPrevistaEn: AHORA, ...over,
  };
}
const RESULTADO = {
  tramitesLeidos: 3, tramitesNuevos: 1, tramitesActualizados: 1, tramitesSinCambios: 1, soatCreados: 0,
  soatBloqueadosPorVin: 0, impuestosBloqueadosPorVehiculo: 0, impuestosCreados: 0, companiasFaltantes: 0,
  organismosSinEmparejar: 0, tramitesOmitidosOtraFuente: 0, ejecutadoEn: AHORA.toISOString(), tramitesFallidos: 0,
};
const logsEnTexto = () => JSON.stringify(Object.values(logMock).map((m) => m.mock.calls));

beforeEach(() => {
  st.fila = filaBase(); st.proyeccion = []; st.updates = []; st.selectThrow = null; st.ocupado = false; st.claves = [];
  interruptor.fuenteHabilitada.mockReset().mockResolvedValue(true);
  sync.sincronizar.mockReset().mockResolvedValue(RESULTADO);
  sync.leerUltimaSincronizacion.mockReset().mockResolvedValue(null);
  sync.guardarUltimaSincronizacion.mockReset();
  for (const m of Object.values(logMock)) m.mockClear();
  entorno.syncHabilitado = true;
});

describe('HU #13629 · AC1 · corrida periódica buena', () => {
  it('lee la ventana, marca el inicio y la próxima antes de leer, y luego la última buena', async () => {
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('buena');
    expect(sync.sincronizar).toHaveBeenCalledWith({ initialDate: '20261009', finalDate: '20261017' });
    expect(st.updates).toEqual([
      { ultimaCorridaEn: AHORA, proximaPrevistaEn: new Date(AHORA.getTime() + 2 * MIN) },
      { ultimaBuenaEn: AHORA },
    ]);
    expect(st.proyeccion).toEqual(expect.arrayContaining(['ultimaCorridaEn', 'nocturnaBuenaDia', 'ultimaBuenaEn', 'frecuenciaMinutos']));
    const [, info] = logMock.info.mock.calls.find((c) => c[1] === 'lectura FLIT 1 automática')!.reverse() as [string, Record<string, unknown>];
    expect(Object.keys(info).sort()).toEqual(['actualizados', 'fallidos', 'finalDate', 'initialDate', 'leidos', 'ms', 'nuevos', 'omitidosOtraFuente', 'sinCambios', 'tipo'].sort());
  });

  it('D5/P-4: con trámites fallidos la corrida es buena y además marca tramites_con_fallo', async () => {
    sync.sincronizar.mockResolvedValue({ ...RESULTADO, tramitesFallidos: 2 });
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('buena');
    expect(st.updates[1]).toMatchObject({ ultimaBuenaEn: AHORA, ultimoFalloCodigo: 'tramites_con_fallo' });
    expect(st.updates[1].ultimoFalloEn).toBeInstanceOf(Date);
  });
});

describe('HU #13629 · AC2 · nocturna', () => {
  it('a las 02:00 Bogotá con la de hoy pendiente: lee la ventana nocturna y guarda el día', async () => {
    const ahora = new Date('2026-10-16T07:00:00Z');
    st.fila = filaBase({ ultimaCorridaEn: new Date('2026-10-16T06:59:30Z'), ultimaBuenaEn: new Date('2026-10-16T06:59:30Z'), nocturnaBuenaDia: '2026-10-15' });
    expect(await correrLecturaFlit1Programada(ahora)).toBe('buena');
    expect(sync.sincronizar).toHaveBeenCalledWith({ initialDate: '20260817', finalDate: '20261017' });
    expect(st.updates[1]).toEqual({ ultimaBuenaEn: ahora, nocturnaBuenaDia: '2026-10-16' });
  });
});

describe('HU #13629 · AC3 · semilla de la primera lectura', () => {
  it('sin última buena ni arranque: usa el día de system_kv, solo leyéndolo', async () => {
    st.fila = filaBase({ ultimaCorridaEn: null, ultimaBuenaEn: null, proximaPrevistaEn: null });
    sync.leerUltimaSincronizacion.mockResolvedValue('2026-10-01T20:00:00.000Z');
    await correrLecturaFlit1Programada(AHORA);
    expect(sync.sincronizar).toHaveBeenCalledWith({ initialDate: '20261001', finalDate: '20261017' });
    expect(sync.guardarUltimaSincronizacion).not.toHaveBeenCalled();
  });

  it('con una corrida buena previa no se consulta system_kv', async () => {
    await correrLecturaFlit1Programada(AHORA);
    expect(sync.leerUltimaSincronizacion).not.toHaveBeenCalled();
  });

  it('system_kv ilegible: se ignora con un warn que no repite el valor', async () => {
    st.fila = filaBase({ ultimaCorridaEn: null, ultimaBuenaEn: null });
    sync.leerUltimaSincronizacion.mockResolvedValue(`basura ${CEDULA}`);
    await correrLecturaFlit1Programada(AHORA);
    expect(sync.sincronizar).toHaveBeenCalledWith({ initialDate: '20260916', finalDate: '20261017' });
    expect(logsEnTexto()).not.toContain(CEDULA);
  });
});

describe('HU #13629 · AC4 · corrida fallida', () => {
  it('fallo de FLIT 1: guarda hora y código del fallo y NO mueve la última buena', async () => {
    sync.sincronizar.mockRejectedValue(new Flit1ReporteError('flit1_http_503', 503));
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('fallo');
    expect(st.updates).toHaveLength(2);
    expect(st.updates[0]).toEqual({ ultimaCorridaEn: AHORA, proximaPrevistaEn: new Date(AHORA.getTime() + 2 * MIN) });
    expect(st.updates[1]).toMatchObject({ ultimoFalloCodigo: 'flit1_http_503' });
    expect(st.updates[1].ultimoFalloEn).toBeInstanceOf(Date);
    expect(st.updates.some((u) => 'ultimaBuenaEn' in u)).toBe(false);
  });

  it('falla el select de la fila: código base_datos y no se llama a FLIT 1', async () => {
    st.selectThrow = new Error('conexión perdida');
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('fallo');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(st.updates).toEqual([expect.objectContaining({ ultimoFalloCodigo: 'base_datos' })]);
  });

  it('codigoFalloFlit1: adaptador, Postgres y desconocido', () => {
    expect(codigoFalloFlit1(new Flit1ReporteError('flit1_timeout'))).toBe('flit1_timeout');
    expect(codigoFalloFlit1(Object.assign(new Error('x'), { code: '23505' }))).toBe('base_datos');
    expect(codigoFalloFlit1(Object.assign(new Error('x'), { name: 'PostgresError' }))).toBe('base_datos');
    expect(codigoFalloFlit1(new Error('x'))).toBe('desconocido');
    expect(codigoFalloFlit1('cadena')).toBe('desconocido');
  });
});

describe('HU #13629 · AC5 · candado compartido', () => {
  it('usa la clave [13629, 1], distinta de la de FLIT 2', async () => {
    await correrLecturaFlit1Programada(AHORA);
    expect(CLAVE_CANDADO_LECTURA_FLIT1).toEqual([13_629, 1]);
    expect(st.claves).toEqual([[13_629, 1]]);
  });

  it('ocupado: se salta, lo dice en info y no lee FLIT 1 ni escribe nada', async () => {
    st.ocupado = true;
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('candado_ocupado');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(st.updates).toEqual([]);
    expect(logMock.info).toHaveBeenCalledWith('lectura FLIT 1 automática: otra corrida tiene el candado, se salta este tick');
  });
});

describe('HU #13629 · AC7 · el interruptor de FLIT 1 manda', () => {
  it('apagado: no toma el candado, no lee FLIT 1 y deja la próxima prevista vacía', async () => {
    interruptor.fuenteHabilitada.mockResolvedValue(false);
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('apagada');
    expect(interruptor.fuenteHabilitada).toHaveBeenCalledWith('flit1');
    expect(st.claves).toEqual([]);
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(st.updates).toEqual([{ proximaPrevistaEn: null }]);
  });

  it('error al leer el interruptor: no corre y no lanza', async () => {
    interruptor.fuenteHabilitada.mockRejectedValue(new Error(`fallo ${CEDULA}`));
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('fallo');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(logsEnTexto()).not.toContain(CEDULA);
  });
});

describe('HU #13629 · AC8 · parámetros releídos en cada tick', () => {
  it('frecuencia subida a 10 min: no corre y recalcula la próxima con la nueva frecuencia', async () => {
    st.fila = filaBase({ frecuenciaMinutos: 10, ultimaCorridaEn: hace(3 * MIN), proximaPrevistaEn: hace(MIN) });
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('no_toca');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(st.updates).toEqual([{ proximaPrevistaEn: new Date(AHORA.getTime() + 7 * MIN) }]);
  });

  it('la próxima ya correcta: el tick sin corrida no escribe', async () => {
    st.fila = filaBase({ ultimaCorridaEn: hace(MIN), proximaPrevistaEn: new Date(AHORA.getTime() + MIN) });
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('no_toca');
    expect(st.updates).toEqual([]);
  });

  it('sin la fila de parámetros: no corre (sin marca correría cada minuto)', async () => {
    st.fila = undefined;
    expect(await correrLecturaFlit1Programada(AHORA)).toBe('sin_fila');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(st.updates).toEqual([]);
  });
});

describe('HU #13629 · AC10 · logs sin PII', () => {
  it('un error con PII en el mensaje solo deja su código en el log', async () => {
    sync.sincronizar.mockRejectedValue(new Error(`duplicate key (numero_documento)=(${CEDULA})`));
    await correrLecturaFlit1Programada(AHORA);
    expect(st.updates[1]).toMatchObject({ ultimoFalloCodigo: 'desconocido' });
    expect(logsEnTexto()).not.toContain(CEDULA);
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ codigo: 'desconocido', tipo: 'periodica' }), 'lectura FLIT 1 automática falló');
  });
});

describe('HU #13629 · D1/D7 · timer del proceso', () => {
  afterEach(() => { stopFlitSync(); vi.useRealTimers(); });

  it('un tick no se encima con el anterior del mismo proceso', async () => {
    let soltar!: (v: unknown) => void;
    sync.sincronizar.mockReturnValue(new Promise((r) => { soltar = r; }));
    const primero = tickLecturaFlit1(AHORA);
    await vi.waitFor(() => expect(sync.sincronizar).toHaveBeenCalledTimes(1));
    await tickLecturaFlit1(AHORA);
    expect(logMock.debug).toHaveBeenCalledWith('lectura FLIT 1 automática: la anterior sigue en curso, se salta este tick');
    soltar(RESULTADO);
    await primero;
    expect(sync.sincronizar).toHaveBeenCalledTimes(1);
  });

  it('SYNC_HABILITADO encendida: cada 60 s hay un tick; apagada: el timer ni se arma', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    startFlitSync();
    expect(TICK_FLIT1_MS).toBe(60_000);
    await vi.advanceTimersByTimeAsync(TICK_FLIT1_MS);
    expect(interruptor.fuenteHabilitada).toHaveBeenCalledTimes(1);
    stopFlitSync();
    interruptor.fuenteHabilitada.mockClear();
    entorno.syncHabilitado = false;
    startFlitSync();
    await vi.advanceTimersByTimeAsync(3 * TICK_FLIT1_MS);
    expect(interruptor.fuenteHabilitada).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledWith('Lectura automática de FLIT 1 apagada (SYNC_HABILITADO=false).');
  });
});
