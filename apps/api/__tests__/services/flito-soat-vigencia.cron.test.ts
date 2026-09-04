// FLITO SOAT — programación de la verificación diaria de vigencia (Feature #12075, HU #12095).
//
// Lo que se prueba es TIEMPO, y el tiempo se prueba moviendo el reloj: `vi.useFakeTimers` con
// `toFake: ['Date']` y `setSystemTime` sobre instantes UTC reales. Salvo el test unitario de
// `ahoraEnBogota`, ningún test le pasa la hora al cron: la lee del sistema, como en producción.
//
// Para que eso signifique algo, este archivo FIJA el huso del proceso en UTC (ver `TZ` abajo). Sin
// esa línea la garantía sería condicional: en una máquina en `-05` —que es donde se desarrolla— una
// implementación que leyera `getHours()` del proceso daría la misma hora que `America/Bogota` y
// pasaría los 29 tests, para romperse en el contenedor y en CI, que corren en UTC. Con `TZ=UTC` el
// reloj del proceso y el de Bogotá difieren siempre en 5 horas, así que atar la corrida al reloj del
// contenedor en vez de a `America/Bogota` (violar RN-D4) pone rojo este archivo en CUALQUIER máquina.
//
// Por orden de importancia:
//
//   1. **La hora es la de Colombia** (AC2). El contenedor corre en UTC: 00:10 de Bogotá son las
//      05:10 UTC. Se afirma sobre el instante UTC y sobre el DÍA, que a las 23:59 de Bogotá todavía
//      es el de ayer aunque en UTC ya sea el siguiente.
//   2. **El día no se repite** (AC5), y no se repite después de REINICIAR el proceso: el test vuelve
//      a importar el módulo con `resetModules` —memoria limpia— y la corrida sigue sin lanzarse
//      porque el estado se lee de la base.
//   3. **La cadencia del reintento** (AC6): un día completo de latidos de 5 minutos produce
//      exactamente 4 ejecuciones —00:10, 01:10, 02:10, 03:10— y ni una más. El cuarto reintento no
//      ocurre y el día se cierra como `parcial`.
//   4. **El candado** (AC4): la corrida entera va dentro, y la instancia que no lo obtiene no llama
//      al recorrido.
//   5. **La puerta por env** (AC3) y que apagar el cron no deja un día colgado.
//   6. **Los logs no llevan PII** (AC7): se afirma sobre las CLAVES de todo lo logueado, no sobre
//      una línea elegida a mano. Y sobre los VALORES en el único punto por donde puede entrar texto
//      libre —el error del recorrido, que redactará la HU #12096—: una excepción con una placa en el
//      mensaje no debe dejar rastro de ella en ninguna línea.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

// ── El huso del PROCESO, fijado a UTC para todo este archivo ────────────────────────────────────
//
// Lo que se verifica aquí es que la hora del negocio salga de `Intl`/`America/Bogota` y no del reloj
// del proceso (RN-D4). En una máquina en `-05` las dos coinciden y el aserto no distingue nada: el
// archivo entero pasa a ser un control positivo vacío. Se fija UTC —el huso del contenedor y el de
// CI— antes de importar el cron, para que la garantía no dependa de dónde se corra la suite.
//
// Node re-lee `process.env.TZ` en cada `Date` a partir de la v16, así que basta con asignarlo aquí;
// se restaura al terminar porque con `fileParallelism: false` el proceso se reutiliza entre archivos
// y el huso no es nuestro para cambiárselo a los demás specs.
const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** El candado se mockea para ejercer las dos ramas: la instancia que gana y la que no (AC4). */
const withLockMock = vi.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
vi.mock('../../src/shared/utils/lock.js', () => ({
  withLock: (n: string, t: number, fn: () => Promise<unknown>) => withLockMock(n, t, fn),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

interface Llamada { dia: string; intento: number; ts: string }
const llamadas: Llamada[] = [];
let respuesta = { considerados: 0, verificados: 0, pendientes: 0 };
let recorridoLanza: Error | null = null;
/** Si está puesto, el recorrido se queda esperando aquí: simula un intento en vuelo. */
let bloqueo: Promise<void> | null = null;
/** Se avisa en cuanto el recorrido ENTRA, que es el punto en el que la escritura de entrada ya ocurrió. */
let avisarEntrada: (() => void) | null = null;

/**
 * El recorrido es el punto de extensión de la HU #12096 y aquí se mockea: esta HU entrega el
 * andamiaje, no el recorrido. Se registra el instante de cada llamada porque la cadencia horaria del
 * AC6 se afirma sobre ESO y no sobre el número de llamadas.
 *
 * El control del bloqueo va por variables y NO por `mockImplementationOnce`: con `retry: 1` en la
 * configuración de vitest, una implementación de un solo uso que no se consume sobrevive al test y
 * se la come el siguiente.
 */
const recorrerMock = vi.fn(async (p: { dia: string; intento: number }) => {
  llamadas.push({ ...p, ts: new Date().toISOString() });
  avisarEntrada?.();
  if (bloqueo) await bloqueo;
  if (recorridoLanza) throw recorridoLanza;
  return respuesta;
});
vi.mock('../../src/modules/flito-soat/flito-soat-vigencia.service.js', () => ({
  recorrerVigenciaSoat: (p: { dia: string; intento: number }) => recorrerMock(p),
}));

const registros: unknown[][] = [];
const loggerFalso = {
  debug: (...a: unknown[]) => { registros.push(a); },
  info: (...a: unknown[]) => { registros.push(a); },
  warn: (...a: unknown[]) => { registros.push(a); },
  error: (...a: unknown[]) => { registros.push(a); },
  child: () => loggerFalso,
};
vi.mock('../../src/shared/logger.js', () => ({ logger: loggerFalso, loggerFor: () => loggerFalso }));

const RUTA_CRON = '../../src/modules/flito-soat/flito-soat-vigencia.cron.js';
const {
  KV_CLAVE_CORRIDA,
  MAX_REINTENTOS,
  ahoraEnBogota,
  decidirCorrida,
  latidoVigenciaSoat,
  startSoatVigenciaCron,
  stopSoatVigenciaCron,
} = await import(RUTA_CRON);
type EstadoDelDia = Awaited<ReturnType<typeof import('../../src/modules/flito-soat/flito-soat-vigencia.cron.js')['leerEstadoDelDia']>>;

const espia = crearEspia(kdb);

/** Estado con el que arranca el día en la base, cuando el test necesita uno previo. */
let kvInicial: unknown = null;

/**
 * `system_kv` se simula PERSISTENTE: lo último que el cron escribió es lo que el cron lee. Sin esto
 * la idempotencia del día (AC5) sería inverificable — el mock devolvería siempre lo mismo y un cron
 * que no escribiera nada pasaría igual.
 */
function registrarKvPersistente(): void {
  kdb.when.select('system_kv', () => {
    const escrito = (espia.ultimoInsertEn('system_kv') as { v?: unknown }).v;
    const v = escrito ?? kvInicial;
    return v ? [{ v }] : [];
  });
}

/** Estados escritos, en orden. */
function escrituras(): NonNullable<EstadoDelDia>[] {
  return espia.insertsEn('system_kv').map((m) => m.datos.v as NonNullable<EstadoDelDia>);
}

/** El estado que quedaría en la base. */
function persistido(): NonNullable<EstadoDelDia> | null {
  return escrituras().at(-1) ?? null;
}

/** Instante UTC. Bogotá es UTC-5 todo el año (Colombia no tiene horario de verano). */
function enUtc(iso: string): void {
  vi.setSystemTime(Date.parse(iso));
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  registrarKvPersistente();
  withLockMock.mockReset();
  withLockMock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
  recorrerMock.mockClear();
  llamadas.length = 0;
  registros.length = 0;
  kvInicial = null;
  respuesta = { considerados: 0, verificados: 0, pendientes: 0 };
  recorridoLanza = null;
  bloqueo = null;
  avisarEntrada = null;
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── AC2 — hora fija de Colombia sobre reloj UTC ────────────────────────

describe('AC2 — la hora es la de Bogotá, no la del contenedor', () => {
  it('el harness corre en UTC: el reloj del proceso y el de Bogotá NUNCA coinciden', () => {
    // Control del control. Si alguien quita el `TZ = 'UTC'` de arriba, todo lo que sigue puede
    // volverse verde vacío en una máquina en `-05`; esto lo cuenta antes de que pase.
    expect(process.env.TZ).toBe('UTC');
    const t = new Date('2026-09-04T05:10:00Z');
    expect(t.getHours()).toBe(5);            // el reloj del proceso
    expect(ahoraEnBogota(t).hora).toBe(0);   // el del negocio, cinco horas atrás
  });

  it('05:10 UTC son las 00:10 del día en Bogotá (y 04:59 UTC todavía es el día anterior)', () => {
    expect(ahoraEnBogota(new Date('2026-09-04T05:10:00Z')))
      .toMatchObject({ dia: '2026-09-04', hora: 0, minuto: 10 });
    // La frontera del día: en UTC ya es el 4, en Bogotá siguen siendo las 23:59 del 3.
    expect(ahoraEnBogota(new Date('2026-09-04T04:59:00Z')))
      .toMatchObject({ dia: '2026-09-03', hora: 23, minuto: 59 });
  });

  it('a las 00:10 de Bogotá la corrida arranca (intento 1, con el día de Bogotá)', async () => {
    enUtc('2026-09-04T05:10:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'correr', intento: 1, motivo: 'corrida_inicial' });
    expect(recorrerMock).toHaveBeenCalledTimes(1);
    expect(llamadas[0]).toMatchObject({ dia: '2026-09-04', intento: 1 });
  });

  it('a las 00:05 de Bogotá (antes del minuto 10) el latido no hace nada', async () => {
    enUtc('2026-09-04T05:05:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'fuera_de_ventana' });
    expect(recorrerMock).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();
    expect(espia.insertsEn('system_kv')).toHaveLength(0);
  });

  it('a las 10:00 de Bogotá el latido no hace nada', async () => {
    enUtc('2026-09-04T15:00:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'fuera_de_ventana' });
    expect(recorrerMock).not.toHaveBeenCalled();
    expect(withLockMock).not.toHaveBeenCalled();
  });

  it('a las 00:10 UTC (19:10 del día anterior en Bogotá) NO arranca: el reloj del contenedor no manda', async () => {
    enUtc('2026-09-04T00:10:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'fuera_de_ventana' });
    expect(recorrerMock).not.toHaveBeenCalled();
  });

  it('dentro de la hora 0 pero ya corrida, el segundo latido del día no relanza', async () => {
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();
    expect(recorrerMock).toHaveBeenCalledTimes(1);

    enUtc('2026-09-04T05:40:00Z'); // 00:40 Bogotá, misma ventana
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'dia_cerrado' });
    expect(recorrerMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────── AC5 — idempotencia del día, fuera de memoria ───────────────────────

describe('AC5 — la corrida del día no se repite, tampoco tras reiniciar el proceso', () => {
  it('el estado del día se PERSISTE (no es una variable): la corrida deja fila en system_kv', async () => {
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    const claves = espia.insertsEn('system_kv').map((m) => m.datos.k);
    expect(claves.every((k) => k === KV_CLAVE_CORRIDA)).toBe(true);
    expect(persistido()).toMatchObject({ dia: '2026-09-04', estado: 'completa', intentos: 1 });
  });

  it('reinicio dentro de la ventana → módulo recién importado (memoria limpia) y NO relanza', async () => {
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();
    expect(recorrerMock).toHaveBeenCalledTimes(1);

    // El reinicio: se tira el módulo y se vuelve a importar. Todo lo que viviera en una variable de
    // este archivo (banderas de «ya corrí hoy») nace de cero. Lo único que sobrevive es la base.
    vi.resetModules();
    const recargado = await import(RUTA_CRON);

    enUtc('2026-09-04T05:35:00Z'); // 00:35 Bogotá, todavía la ventana del mismo día
    const d = await recargado.latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'dia_cerrado' });
    expect(recorrerMock).toHaveBeenCalledTimes(1);
    expect(withLockMock).toHaveBeenCalledTimes(1); // el del primer latido, no el del reinicio
  });

  it('al día SIGUIENTE sí vuelve a correr', async () => {
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    enUtc('2026-09-05T05:10:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'correr', intento: 1, motivo: 'corrida_inicial' });
    expect(llamadas.map((l) => l.dia)).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('si el estado del día no se puede leer, no se corre a ciegas', async () => {
    kdb.reset();
    espia.reiniciar();
    kdb.when.selectThrow('system_kv', new Error('base caída'));

    enUtc('2026-09-04T05:10:00Z');
    const d = await latidoVigenciaSoat();

    expect(d).toEqual({ accion: 'esperar', motivo: 'estado_ilegible' });
    expect(recorrerMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────── AC4 — un solo servidor ───────────────────────────────────────

describe('AC4 — el candado decide quién ejecuta', () => {
  it('la corrida ENTERA va dentro de withLock: nada se recorre antes de tenerlo', async () => {
    let recorridosAntesDelCandado = -1;
    withLockMock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => {
      recorridosAntesDelCandado = recorrerMock.mock.calls.length;
      return fn();
    });

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    expect(recorridosAntesDelCandado).toBe(0);
    expect(recorrerMock).toHaveBeenCalledTimes(1);
    expect(withLockMock.mock.calls[0][0]).toBe('flito-soat-vigencia');
    // TTL menor que la hora del reintento: un dueño muerto no puede congelar el intento siguiente.
    expect(withLockMock.mock.calls[0][1]).toBeLessThan(60 * 60_000);
  });

  it('la instancia que NO obtiene el candado no consulta nada y lo registra', async () => {
    withLockMock.mockResolvedValue(null);

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    expect(withLockMock).toHaveBeenCalledTimes(1);
    expect(recorrerMock).not.toHaveBeenCalled();
    expect(registros.some((r) => String(r[1]).includes('otra instancia'))).toBe(true);
  });
});

// ─────────────────────────────── AC6 — reintento horario, hasta tres ────────────────────────────

describe('AC6 — reintento cada hora, tope de tres', () => {
  it('un día entero de latidos con el RUNT caído: 4 ejecuciones a 00:10, 01:10, 02:10 y 03:10, y ninguna más', async () => {
    respuesta = { considerados: 10, verificados: 4, pendientes: 6 };

    // Latidos reales, cada 5 minutos, desde las 00:00 hasta las 08:00 de Bogotá.
    const arranque = Date.parse('2026-09-04T05:00:00Z');
    for (let i = 0; i <= 8 * 12; i++) {
      vi.setSystemTime(arranque + i * 5 * 60_000);
      await latidoVigenciaSoat();
    }

    expect(llamadas.map((l) => l.ts)).toEqual([
      '2026-09-04T05:10:00.000Z', // 00:10 Bogotá — corrida inicial
      '2026-09-04T06:10:00.000Z', // 01:10 — reintento 1
      '2026-09-04T07:10:00.000Z', // 02:10 — reintento 2
      '2026-09-04T08:10:00.000Z', // 03:10 — reintento 3
    ]);
    expect(llamadas.map((l) => l.intento)).toEqual([1, 2, 3, 4]);
    expect(llamadas.every((l) => l.dia === '2026-09-04')).toBe(true);
    expect(MAX_REINTENTOS).toBe(3);

    // El cuarto reintento no ocurre: el día se cierra como parcial y deja constancia.
    expect(persistido()).toMatchObject({
      dia: '2026-09-04', estado: 'parcial', intentos: 4, pendientes: 6, proximoIntentoEn: null,
    });
    expect(registros.some((r) => String(r[1]).includes('PARCIAL'))).toBe(true);
  });

  it('a los 55 minutos el reintento todavía no toca; a los 60, sí', async () => {
    respuesta = { considerados: 3, verificados: 1, pendientes: 2 };

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();
    expect(persistido()).toMatchObject({
      estado: 'en_curso', intentos: 1, proximoIntentoEn: '2026-09-04T06:10:00.000Z',
    });

    enUtc('2026-09-04T06:05:00Z');
    expect(await latidoVigenciaSoat()).toEqual({ accion: 'esperar', motivo: 'reintento_no_vencido' });
    expect(recorrerMock).toHaveBeenCalledTimes(1);

    enUtc('2026-09-04T06:10:00Z');
    expect(await latidoVigenciaSoat()).toEqual({ accion: 'correr', intento: 2, motivo: 'reintento' });
    expect(recorrerMock).toHaveBeenCalledTimes(2);
  });

  it('sin pendientes NO se reintenta: el día se cierra completo en el primer intento', async () => {
    respuesta = { considerados: 9, verificados: 9, pendientes: 0 };

    const arranque = Date.parse('2026-09-04T05:00:00Z');
    for (let i = 0; i <= 5 * 12; i++) {
      vi.setSystemTime(arranque + i * 5 * 60_000);
      await latidoVigenciaSoat();
    }

    expect(recorrerMock).toHaveBeenCalledTimes(1);
    expect(persistido()).toMatchObject({ estado: 'completa', intentos: 1, proximoIntentoEn: null });
  });

  it('el reintento lleva el MISMO día y el intento siguiente: con eso el recorrido (HU #12096) excluye lo ya verificado', async () => {
    respuesta = { considerados: 5, verificados: 2, pendientes: 3 };

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();
    enUtc('2026-09-04T06:10:00Z');
    await latidoVigenciaSoat();

    expect(llamadas).toMatchObject([
      { dia: '2026-09-04', intento: 1 },
      { dia: '2026-09-04', intento: 2 },
    ]);
    // Los verificados se ACUMULAN en el día: el reintento no vuelve a contar los de antes.
    expect(persistido()).toMatchObject({ verificados: 4, pendientes: 3 });
  });

  it('un recorrido que revienta cuenta como intento con pendientes: se reprograma, no se da el día por bueno', async () => {
    recorridoLanza = new Error('RUNT no responde');

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    expect(persistido()).toMatchObject({
      estado: 'en_curso', intentos: 1, proximoIntentoEn: '2026-09-04T06:10:00.000Z',
    });
    expect(registros.some((r) => String(r[1]).includes('el recorrido falló'))).toBe(true);

    recorridoLanza = null;
    respuesta = { considerados: 2, verificados: 2, pendientes: 0 };
    enUtc('2026-09-04T06:10:00Z');
    expect(await latidoVigenciaSoat()).toEqual({ accion: 'correr', intento: 2, motivo: 'reintento' });
    expect(persistido()).toMatchObject({ estado: 'completa' });
  });

  it('el intento siguiente se fecha ANTES de empezar: un proceso que muere a mitad no congela el día', async () => {
    let soltar!: () => void;
    bloqueo = new Promise<void>((res) => { soltar = res; });
    const entroElRecorrido = new Promise<void>((res) => { avisarEntrada = res; });

    enUtc('2026-09-04T05:10:00Z');
    const enCurso = latidoVigenciaSoat();
    await entroElRecorrido;

    // El intento está en vuelo y todavía no hay cierre, pero el estado YA dice cuándo se retoma: si
    // el proceso muriera ahora, a las 01:10 cualquier instancia ve un reintento vencido y sigue.
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]).toMatchObject({
      estado: 'en_curso', intentos: 1, proximoIntentoEn: '2026-09-04T06:10:00.000Z',
    });

    soltar();
    await enCurso; // se deja terminar: un latido colgado dejaría el módulo con un intento en vuelo
  });

  it('mientras un intento está en vuelo, el latido siguiente no lanza otro', async () => {
    respuesta = { considerados: 1, verificados: 1, pendientes: 0 };
    let soltar!: () => void;
    bloqueo = new Promise<void>((res) => { soltar = res; });
    const entroElRecorrido = new Promise<void>((res) => { avisarEntrada = res; });

    enUtc('2026-09-04T05:10:00Z');
    const enCurso = latidoVigenciaSoat();
    await entroElRecorrido;

    enUtc('2026-09-04T05:15:00Z');
    expect(await latidoVigenciaSoat()).toEqual({ accion: 'esperar', motivo: 'en_vuelo' });
    expect(recorrerMock).toHaveBeenCalledTimes(1);

    soltar();
    await enCurso;
    expect(persistido()).toMatchObject({ estado: 'completa' });
  });
});

// ─────────────────────────── decidirCorrida — la tabla de decisión, aislada ─────────────────────

describe('decidirCorrida — la decisión, sin base ni candado de por medio', () => {
  const reloj = (dia: string, hora: number, minuto: number, ms = 0) => ({ dia, hora, minuto, ms });

  it('día parcial → no se toca más hasta mañana', () => {
    const estado = {
      dia: '2026-09-04', estado: 'parcial' as const, intentos: 4, verificados: 1, pendientes: 2,
      proximoIntentoEn: null, actualizadoEn: '2026-09-04T08:10:00.000Z',
    };
    expect(decidirCorrida(estado, reloj('2026-09-04', 9, 0, Date.parse('2026-09-04T14:00:00Z'))))
      .toEqual({ accion: 'esperar', motivo: 'reintentos_agotados' });
  });

  it('en_curso sin fecha de reintento → no se relanza (los reintentos ya se gastaron)', () => {
    const estado = {
      dia: '2026-09-04', estado: 'en_curso' as const, intentos: 4, verificados: 0, pendientes: 1,
      proximoIntentoEn: null, actualizadoEn: '2026-09-04T08:10:00.000Z',
    };
    expect(decidirCorrida(estado, reloj('2026-09-04', 4, 0, Date.parse('2026-09-04T09:00:00Z'))))
      .toEqual({ accion: 'esperar', motivo: 'reintentos_agotados' });
  });

  it('un reintento vencido se atiende a cualquier hora: la ventana de las 00:10 es solo para el arranque', () => {
    const estado = {
      dia: '2026-09-04', estado: 'en_curso' as const, intentos: 2, verificados: 0, pendientes: 5,
      proximoIntentoEn: '2026-09-04T07:10:00.000Z', actualizadoEn: '2026-09-04T06:10:00.000Z',
    };
    expect(decidirCorrida(estado, reloj('2026-09-04', 2, 15, Date.parse('2026-09-04T07:15:00Z'))))
      .toEqual({ accion: 'correr', intento: 3, motivo: 'reintento' });
  });

  it('estado de OTRO día → manda la ventana de arranque de hoy', () => {
    const ayer = {
      dia: '2026-09-03', estado: 'parcial' as const, intentos: 4, verificados: 0, pendientes: 9,
      proximoIntentoEn: null, actualizadoEn: '2026-09-03T08:10:00.000Z',
    };
    expect(decidirCorrida(ayer, reloj('2026-09-04', 0, 10, Date.parse('2026-09-04T05:10:00Z'))))
      .toEqual({ accion: 'correr', intento: 1, motivo: 'corrida_inicial' });
    expect(decidirCorrida(ayer, reloj('2026-09-04', 6, 0, Date.parse('2026-09-04T11:00:00Z'))))
      .toEqual({ accion: 'esperar', motivo: 'fuera_de_ventana' });
  });
});

// ────────────────────────── AC3 — interruptor y apagado sin corridas colgadas ───────────────────

describe('AC3 — la puerta es positiva', () => {
  afterEach(() => {
    delete process.env.SOAT_VIGENCIA_CRON_ENABLED;
  });

  it('sin SOAT_VIGENCIA_CRON_ENABLED el cron no arranca y lo dice en el log', async () => {
    delete process.env.SOAT_VIGENCIA_CRON_ENABLED;
    vi.resetModules();
    const cron = await import(RUTA_CRON);

    const espiaInterval = vi.spyOn(globalThis, 'setInterval');
    cron.startSoatVigenciaCron();

    expect(espiaInterval).not.toHaveBeenCalled();
    expect(registros.some((r) => String(r[1]).includes('DESHABILITADA'))).toBe(true);
    cron.stopSoatVigenciaCron();
    espiaInterval.mockRestore();
  });

  it('SOAT_VIGENCIA_CRON_ENABLED=0 tampoco arranca (solo el 1 explícito)', async () => {
    process.env.SOAT_VIGENCIA_CRON_ENABLED = '0';
    vi.resetModules();
    const cron = await import(RUTA_CRON);

    const espiaInterval = vi.spyOn(globalThis, 'setInterval');
    cron.startSoatVigenciaCron();

    expect(espiaInterval).not.toHaveBeenCalled();
    cron.stopSoatVigenciaCron();
    espiaInterval.mockRestore();
  });

  it('SOAT_VIGENCIA_CRON_ENABLED=1 arranca el latido, y stop lo detiene', async () => {
    process.env.SOAT_VIGENCIA_CRON_ENABLED = '1';
    vi.resetModules();
    const cron = await import(RUTA_CRON);

    const espiaInterval = vi.spyOn(globalThis, 'setInterval');
    const espiaClear = vi.spyOn(globalThis, 'clearInterval');
    cron.startSoatVigenciaCron();

    expect(espiaInterval).toHaveBeenCalledTimes(1);
    expect(registros.some((r) => String(r[1]).includes('ACTIVA'))).toBe(true);

    cron.stopSoatVigenciaCron();
    expect(espiaClear).toHaveBeenCalledTimes(1);
    espiaInterval.mockRestore();
    espiaClear.mockRestore();
  });

  it('apagarlo entre corridas no deja ninguna a medio cerrar: el estado persistido es un intento cerrado', async () => {
    respuesta = { considerados: 4, verificados: 1, pendientes: 3 };
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    stopSoatVigenciaCron();

    const estado = persistido()!;
    expect(estado.estado).toBe('en_curso');
    expect(estado.intentos).toBe(1);
    // Lo único que sería «a medio cerrar» es un en_curso sin fecha de retome: nadie lo recogería.
    expect(estado.proximoIntentoEn).toBe('2026-09-04T06:10:00.000Z');
    expect(estado.pendientes).toBe(3);
  });
});

// ─────────────────────────────────── AC7 — logs sin PII ─────────────────────────────────────────

describe('AC7 — los logs llevan host, día, intento y totales, y nada más', () => {
  it('ninguna línea del cron lleva placa, VIN, documento ni nombre', async () => {
    respuesta = { considerados: 12, verificados: 7, pendientes: 5 };

    const arranque = Date.parse('2026-09-04T05:00:00Z');
    for (let i = 0; i <= 5 * 12; i++) {
      vi.setSystemTime(arranque + i * 5 * 60_000);
      await latidoVigenciaSoat();
    }
    // Y la rama del candado perdido, que también loguea.
    withLockMock.mockResolvedValue(null);
    kvInicial = null;
    enUtc('2026-09-05T05:10:00Z');
    await latidoVigenciaSoat();

    const permitidas = new Set([
      'host', 'dia', 'intento', 'maxReintentos', 'reintentos', 'considerados', 'verificados',
      'verificadosDelDia', 'pendientes', 'estado', 'proximoIntentoEn', 'lock', 'err',
      'zona', 'hora', 'latidoMin',
    ]);
    const prohibidas = ['placa', 'vin', 'documento', 'nombre', 'cedula', 'nit', 'correo', 'email'];

    expect(registros.length).toBeGreaterThan(3);
    for (const [datos] of registros) {
      const claves = Object.keys(datos as Record<string, unknown>);
      expect(claves.filter((k) => !permitidas.has(k))).toEqual([]);
      for (const p of prohibidas) {
        expect(claves.map((k) => k.toLowerCase())).not.toContain(p);
      }
    }
  });

  it('un recorrido que revienta con una placa en el mensaje NO deja la placa en ningún log', async () => {
    // El agujero que esto tapa: `err` es una clave PERMITIDA por la lista blanca de arriba, y su
    // valor lo redactará la HU #12096. Un aserto sobre claves da verde aunque el valor traiga la
    // placa entera; este mira los VALORES de todo lo logueado.
    class RuntSinRespuestaError extends Error {
      override name = 'RuntSinRespuestaError';
    }
    recorridoLanza = new RuntSinRespuestaError('RUNT: placa ABC123 sin respuesta (doc 1098765432)');

    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    const fallo = registros.find((r) => String(r[1]).includes('el recorrido falló'))?.[0] as Record<string, unknown>;
    expect(fallo).toBeDefined();
    // Del error sobrevive el NOMBRE —diagnóstico suficiente— y nada del mensaje.
    expect(fallo.err).toBe('RuntSinRespuestaError');

    const todoLoLogueado = JSON.stringify(registros);
    expect(todoLoLogueado).not.toContain('ABC123');
    expect(todoLoLogueado).not.toContain('1098765432');
    expect(todoLoLogueado).not.toContain('sin respuesta');
  });

  it('tampoco la deja el error de LECTURA del estado, que viene de la base', async () => {
    kdb.reset();
    espia.reiniciar();
    kdb.when.selectThrow('system_kv', new Error('timeout consultando placa ABC123'));

    enUtc('2026-09-04T05:10:00Z');
    expect(await latidoVigenciaSoat()).toEqual({ accion: 'esperar', motivo: 'estado_ilegible' });

    const lectura = registros.find((r) => String(r[1]).includes('no se pudo leer'))?.[0] as Record<string, unknown>;
    expect(lectura.err).toBe('Error');
    expect(JSON.stringify(registros)).not.toContain('ABC123');
  });

  it('la línea de cierre trae el día, el intento y los totales (que es para lo que se lee)', async () => {
    respuesta = { considerados: 12, verificados: 12, pendientes: 0 };
    enUtc('2026-09-04T05:10:00Z');
    await latidoVigenciaSoat();

    const cierre = registros.find((r) => String(r[1]).includes('completa'))?.[0] as Record<string, unknown>;
    expect(cierre).toMatchObject({
      dia: '2026-09-04', intento: 1, considerados: 12, verificados: 12, pendientes: 0, estado: 'completa',
    });
    expect(typeof cierre.host).toBe('string');
  });
});
