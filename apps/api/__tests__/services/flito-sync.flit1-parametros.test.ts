// HU #13628 (Feature #13612, Épica #13576) — parámetros de la lectura automática de FLIT 1.
// Frontera HTTP de `/api/flito/sync/flit1/*`: GET/PUT /parametros-lectura (AC1-AC7) y GET /estado-lectura (AC8),
// más las funciones puras del servicio (arranque por defecto, validación, detalle de auditoría). Datos SINTÉTICOS.
//
// El servicio corre de verdad sobre el mock keyed por tabla (calco de `flito-sync.interruptores.test.ts`).
// Como ese mock devuelve la fila que se le dé sin mirar la proyección y su `.for()` es un passthrough,
// el `FOR UPDATE` de RN-05 se comprueba con una transacción que registra la cadena que emite el servicio.
// Reloj fijo y `TZ=UTC` en el comando: la fecha de Bogotá no puede salir del huso local de la máquina.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { operacionesDePartida, testToken, type TestRole } from '../helpers/auth.js';
import { DEFAULTS_PARAMETROS_LECTURA_FLIT1, LIMITES_PARAMETROS_LECTURA_FLIT1 } from '@operaciones/shared-types';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const sync = vi.hoisted(() => ({
  sincronizar: vi.fn(), leerUltimaSincronizacion: vi.fn(), guardarUltimaSincronizacion: vi.fn(), hayTramites: vi.fn(),
}));
vi.mock('../../src/modules/flito-sync/flito-sync.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), ...sync,
}));

// Import diferido: el servicio carga `db/client.js`, que tiene que resolver al mock ya creado.
const {
  arranquePorDefecto, detalleAuditoriaParametrosFlit1, esFechaReal, problemasParametrosFlit1,
} = await import('../../src/modules/flito-sync/flito-sync-flit1-parametros.service.js');

const BASE = '/api/flito/sync';
const RUTA = `${BASE}/flit1/parametros-lectura`;
const ESTADO = `${BASE}/flit1/estado-lectura`;
const TABLA = 'flito_sync_flit1_lectura';
const CONFIGURAR = 'tramites.sincronizacion.configurar';
const VER_ESTADO = 'sync.sync.ver_estado';
// 03:00 UTC del 16 = 22:00 del 15 en Bogotá: el «hoy» del servidor (UTC) y el de Bogotá difieren.
const RELOJ = new Date('2026-10-16T03:00:00.000Z');
const HOY_BOGOTA = '2026-10-15';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flito-sync.routes.js');
  app.use(BASE, router);
  app.use((_e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'interno' });
  });
  return app;
}

let siguienteSub = 13628;
const auth = async (role: TestRole = 'admin', funciones?: string[]) =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role, funciones })}`;

/** Un rol de partida que no tiene NINGUNA de las dos funciones (para medir el O de AC8 con lo que se añade). */
const ROL_SIN_NINGUNA = (['auditor', 'financiera', 'gestor_impuestos', 'mensajero', 'transito'] as TestRole[])
  .find((r) => { const ops = operacionesDePartida(r); return !ops.includes(CONFIGURAR) && !ops.includes(VER_ESTADO); })!;

const FILA_SEMBRADA = {
  frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null,
  actualizadoEn: null, autorId: null, autorNombre: null,
};
const VALIDO = { frecuenciaMinutos: 5, ventanaDias: 10, ventanaNocturnaDias: 45, arranque: '2026-09-01' };

/**
 * Transacción que registra la cadena emitida por el servicio: cada `select` (con su `.for()`) y cada
 * `insert` (con `values` y `onConflictDoUpdate`), en orden. El select del FOR UPDATE devuelve `previa`.
 */
function espiarTransaccion(previa: Record<string, unknown>[]) {
  const pasos: { op: 'select' | 'insert'; tabla?: string; lock?: unknown; values?: Record<string, unknown>; set?: Record<string, unknown>; target?: unknown }[] = [];
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      select: () => {
        const paso: (typeof pasos)[number] = { op: 'select' };
        pasos.push(paso);
        const c: Record<string, unknown> = {
          from: (t: unknown) => { paso.tabla = getTableName(t as never); return c; },
          where: () => c,
          for: (modo: unknown) => { paso.lock = modo; return c; },
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(previa).then(ok, ko),
        };
        return c;
      },
      insert: (t: unknown) => {
        const paso: (typeof pasos)[number] = { op: 'insert', tabla: getTableName(t as never) };
        pasos.push(paso);
        const c: Record<string, unknown> = {
          values: (v: Record<string, unknown>) => { paso.values = v; return c; },
          onConflictDoUpdate: (o: { target: unknown; set: Record<string, unknown> }) => { paso.set = o.set; paso.target = o.target; return c; },
          then: (ok: (v: unknown) => unknown) => Promise.resolve([]).then(ok),
        };
        return c;
      },
    };
    return cb(tx);
  });
  return pasos;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(RELOJ);
  kdb.reset();
  auditMock.mockClear();
  for (const f of Object.values(sync)) f.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('HU #13628 · funciones puras', () => {
  it('RN-03: arranque por defecto = hoy − 1 mes, con ajuste al último día del mes anterior', () => {
    expect(arranquePorDefecto('2026-10-15')).toBe('2026-09-15');
    expect(arranquePorDefecto('2026-03-31')).toBe('2026-02-28');
    expect(arranquePorDefecto('2028-03-31')).toBe('2028-02-29');
    expect(arranquePorDefecto('2026-01-10')).toBe('2025-12-10');
  });

  it('esFechaReal rechaza días que no existen y formatos ajenos', () => {
    expect(esFechaReal('2026-09-01')).toBe(true);
    for (const v of ['2026-02-30', '2026-13-01', 'x', '2026-9-1', '2026-09-01T00:00:00Z']) expect(esFechaReal(v)).toBe(false);
  });

  it('la validación no repite lo recibido y sale en orden fijo (arranque antes que la nocturna)', () => {
    const p = problemasParametrosFlit1({ ...VALIDO, arranque: '2099-01-01', ventanaDias: 30, ventanaNocturnaDias: 7 }, HOY_BOGOTA);
    expect(p.map((x) => x.campo)).toEqual(['arranque', 'ventanaNocturnaDias']);
    expect(JSON.stringify(p)).not.toContain('2099');
  });
});

describe('HU #13628 · AC1 · GET /flit1/parametros-lectura sin parámetros guardados', () => {
  it('fila sembrada → 2 / 7 / 60 y arranque = hoy (Bogotá) − 1 mes, sin autor', async () => {
    kdb.when.select(TABLA, [FILA_SEMBRADA]);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60,
      arranque: '2026-09-15', arranquePorDefecto: true, actualizadoEn: null, actualizadoPor: null,
    });
  });

  it('fila ausente → los mismos defaults (de las constantes compartidas)', async () => {
    kdb.when.select(TABLA, []);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ...DEFAULTS_PARAMETROS_LECTURA_FLIT1, arranque: '2026-09-15', arranquePorDefecto: true });
  });

  it('las claves de la respuesta son exactamente las del contrato (sin las columnas de estado)', async () => {
    kdb.when.select(TABLA, [{ ...FILA_SEMBRADA, ultimaBuenaEn: RELOJ, ultimoFalloCodigo: 'timeout' }]);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(Object.keys(r.body).sort()).toEqual(
      ['actualizadoEn', 'actualizadoPor', 'arranque', 'arranquePorDefecto', 'frecuenciaMinutos', 'ventanaDias', 'ventanaNocturnaDias'],
    );
  });
});

describe('HU #13628 · AC2 · PUT persiste y responde quién y cuándo', () => {
  it('FOR UPDATE antes del upsert, en la misma transacción; upsert por PK con los cuatro valores y el autor', async () => {
    const pasos = espiarTransaccion([{ frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null }]);
    kdb.when.select(TABLA, [{ ...VALIDO, actualizadoEn: RELOJ, autorId: 7, autorNombre: 'Usuaria Ejemplo' }]);
    const sub = siguienteSub;
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(VALIDO);
    expect(r.status).toBe(200);
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(pasos.map((p) => [p.op, p.tabla, p.lock])).toEqual([
      ['select', TABLA, 'update'],
      ['insert', TABLA, undefined],
    ]);
    const esperado = { ...VALIDO, parametrosActualizadosEn: RELOJ, parametrosActualizadosPor: sub };
    expect(pasos[1]!.values).toEqual({ id: 1, ...esperado });
    expect(pasos[1]!.set).toEqual(esperado);
    // RN-06: el PUT nunca toca las columnas de estado de la #13629.
    for (const k of ['ultimaBuenaEn', 'proximaPrevistaEn', 'ultimoFalloEn', 'ultimoFalloCodigo']) expect(pasos[1]!.set).not.toHaveProperty(k);
    expect(r.body).toEqual({
      ...VALIDO, arranquePorDefecto: false,
      actualizadoEn: RELOJ.toISOString(), actualizadoPor: { id: 7, nombre: 'Usuaria Ejemplo' },
    });
  });

  it('arranque = hoy en Bogotá (aunque en UTC ya sea mañana) → 200', async () => {
    espiarTransaccion([]);
    kdb.when.select(TABLA, [{ ...VALIDO, arranque: HOY_BOGOTA, actualizadoEn: RELOJ, autorId: 1, autorNombre: 'A' }]);
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send({ ...VALIDO, arranque: HOY_BOGOTA });
    expect(r.status).toBe(200);
  });

  it('un error de base se propaga como 500 y no se audita', async () => {
    kdb.transaction.mockRejectedValue(Object.assign(new Error('check'), { code: '23514' }));
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(VALIDO);
    expect(r.status).toBe(500);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('HU #13628 · AC3/AC4/AC5 · 400 con el campo inválido y sin escribir', () => {
  const casos: [string, Record<string, unknown>, string][] = [];
  for (const campo of Object.keys(LIMITES_PARAMETROS_LECTURA_FLIT1) as (keyof typeof LIMITES_PARAMETROS_LECTURA_FLIT1)[]) {
    const { min, max } = LIMITES_PARAMETROS_LECTURA_FLIT1[campo];
    // Para que solo falle el campo medido, la ventana y la nocturna se dejan compatibles entre sí.
    const base = campo === 'ventanaDias' ? { ...VALIDO, ventanaNocturnaDias: 90 } : campo === 'ventanaNocturnaDias' ? { ...VALIDO, ventanaDias: 1 } : VALIDO;
    casos.push([`${campo}=${min - 1}`, { ...base, [campo]: min - 1 }, campo]);
    casos.push([`${campo}=${max + 1}`, { ...base, [campo]: max + 1 }, campo]);
  }
  casos.push(['frecuenciaMinutos decimal', { ...VALIDO, frecuenciaMinutos: 2.5 }, 'frecuenciaMinutos']);
  casos.push(['ventanaDias como texto', { ...VALIDO, ventanaDias: '10' }, 'ventanaDias']);
  casos.push(['AC4 arranque mañana en Bogotá', { ...VALIDO, arranque: '2026-10-16' }, 'arranque']);
  casos.push(['AC4 arranque 2026-02-30', { ...VALIDO, arranque: '2026-02-30' }, 'arranque']);
  casos.push(['AC4 arranque "x"', { ...VALIDO, arranque: 'x' }, 'arranque']);
  casos.push(['arranque null (no admitido en el PUT)', { ...VALIDO, arranque: null }, 'arranque']);
  casos.push(['arranque ausente', { frecuenciaMinutos: 5, ventanaDias: 10, ventanaNocturnaDias: 45 }, 'arranque']);
  casos.push(['AC5 ventana 30 con nocturna 7', { ...VALIDO, ventanaDias: 30, ventanaNocturnaDias: 7 }, 'ventanaNocturnaDias']);
  casos.push(['clave de más (.strict())', { ...VALIDO, extra: 1 }, 'extra']);

  it('los casos cubren los dos bordes de los tres números (AC3)', () => {
    expect(casos.filter(([n]) => /^(frecuenciaMinutos|ventanaDias|ventanaNocturnaDias)=/.test(n)).map(([n]) => n)).toEqual([
      'frecuenciaMinutos=1', 'frecuenciaMinutos=61', 'ventanaDias=0', 'ventanaDias=91', 'ventanaNocturnaDias=6', 'ventanaNocturnaDias=91',
    ]);
  });

  it.each(casos)('%s → 400 datos_invalidos con campos=[ese campo]; no abre transacción ni audita', async (_n, cuerpo, campo) => {
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(cuerpo);
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('datos_invalidos');
    expect(r.body.campos).toEqual([campo]);
    expect(r.body.faltantes.length).toBeGreaterThan(0);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC5: el mensaje dice que la nocturna no puede ser menor que la ventana', async () => {
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth())
      .send({ ...VALIDO, ventanaDias: 30, ventanaNocturnaDias: 7 });
    expect(r.body.faltantes.join(' ')).toMatch(/nocturna no puede ser menor que la ventana/i);
  });

  it('el 400 no repite lo recibido', async () => {
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth())
      .send({ ...VALIDO, arranque: '2099-12-31' });
    expect(JSON.stringify(r.body)).not.toContain('2099');
  });
});

describe('HU #13628 · AC6 · 401 sin token, 403 sin la función', () => {
  it.each([['GET', RUTA], ['PUT', RUTA], ['GET', ESTADO]])('%s %s sin token → 401', async (metodo, ruta) => {
    const app = await buildApp();
    const r = metodo === 'GET' ? await request(app).get(ruta) : await request(app).put(ruta).send(VALIDO);
    expect(r.status).toBe(401);
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('sin `configurar` → 403 en GET y PUT, sin leer ni escribir ni auditar', async () => {
    const app = await buildApp();
    const g = await request(app).get(RUTA).set('Authorization', await auth(ROL_SIN_NINGUNA));
    const p = await request(app).put(RUTA).set('Authorization', await auth(ROL_SIN_NINGUNA)).send(VALIDO);
    expect([g.status, p.status]).toEqual([403, 403]);
    expect(p.body).toMatchObject({ funcion: CONFIGURAR });
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('ver el estado (sync.sync.ver_estado) NO basta para los parámetros → 403', async () => {
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth(ROL_SIN_NINGUNA, [VER_ESTADO])).send(VALIDO);
    expect(r.status).toBe(403);
  });
});

describe('HU #13628 · AC7 · auditoría con el par anterior → nuevo de cada parámetro, sin PII', () => {
  it('detalle con los cuatro pares; arranque nunca guardado se escribe «(hace 1 mes)»', () => {
    const d = detalleAuditoriaParametrosFlit1({ frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null }, VALIDO);
    expect(d).toBe('Parámetros de lectura de FLIT 1: frecuenciaMinutos 2 → 5; ventanaDias 7 → 10; ventanaNocturnaDias 60 → 45; arranque (hace 1 mes) → 2026-09-01');
  });

  it('mismos valores → también se marca «(sin cambio)»', () => {
    expect(detalleAuditoriaParametrosFlit1(VALIDO, VALIDO)).toMatch(/\(sin cambio\)$/);
  });

  it('cada PUT audita una vez (también al mismo valor), sobre la tabla y sin el nombre del usuario', async () => {
    for (const previa of [[{ frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: null }], [VALIDO]]) {
      auditMock.mockClear();
      espiarTransaccion(previa);
      kdb.when.select(TABLA, [{ ...VALIDO, actualizadoEn: RELOJ, autorId: 7, autorNombre: 'Usuaria Ejemplo' }]);
      const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(VALIDO);
      expect(r.status).toBe(200);
      expect(auditMock).toHaveBeenCalledTimes(1);
      const [, ev] = auditMock.mock.calls[0]!;
      expect(ev).toMatchObject({ action: 'update', resource: TABLA, resourceId: 'flit1' });
      expect(ev.detail).toContain('frecuenciaMinutos');
      expect(ev.detail).not.toContain('Usuaria');
      expect(ev.detail).not.toContain('ops@flit.io');
    }
  });

  it('fila ausente en el PUT → el anterior son los defaults sembrados', async () => {
    espiarTransaccion([]);
    kdb.when.select(TABLA, [{ ...VALIDO, actualizadoEn: RELOJ, autorId: 7, autorNombre: 'U' }]);
    await request(await buildApp()).put(RUTA).set('Authorization', await auth()).send(VALIDO);
    expect(auditMock.mock.calls[0]![1].detail).toContain('frecuenciaMinutos 2 → 5');
    expect(auditMock.mock.calls[0]![1].detail).toContain('arranque (hace 1 mes) → 2026-09-01');
  });
});

describe('HU #13628 · AC8 · GET /flit1/estado-lectura', () => {
  it('antes de la primera corrida → los tres vacíos', async () => {
    kdb.when.select(TABLA, [{ ultimaBuenaEn: null, proximaPrevistaEn: null, ultimoFalloEn: null, ultimoFalloCodigo: null }]);
    const r = await request(await buildApp()).get(ESTADO).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ultimaLecturaBuenaEn: null, proximaLecturaPrevistaEn: null, ultimoFallo: null });
    expect(sync.leerUltimaSincronizacion).not.toHaveBeenCalled();
  });

  it('fila ausente → también vacíos', async () => {
    kdb.when.select(TABLA, []);
    const r = await request(await buildApp()).get(ESTADO).set('Authorization', await auth());
    expect(r.body).toEqual({ ultimaLecturaBuenaEn: null, proximaLecturaPrevistaEn: null, ultimoFallo: null });
  });

  it('con datos → ISO y el fallo como { en, codigo }', async () => {
    const buena = new Date('2026-10-15T20:00:00.000Z');
    const proxima = new Date('2026-10-15T20:02:00.000Z');
    const fallo = new Date('2026-10-15T19:58:00.000Z');
    kdb.when.select(TABLA, [{ ultimaBuenaEn: buena, proximaPrevistaEn: proxima, ultimoFalloEn: fallo, ultimoFalloCodigo: 'timeout' }]);
    const r = await request(await buildApp()).get(ESTADO).set('Authorization', await auth());
    expect(r.body).toEqual({
      ultimaLecturaBuenaEn: buena.toISOString(), proximaLecturaPrevistaEn: proxima.toISOString(),
      ultimoFallo: { en: fallo.toISOString(), codigo: 'timeout' },
    });
  });

  it.each<[string, string[], number]>([
    ['solo ver_estado', [VER_ESTADO], 200],
    ['solo configurar', [CONFIGURAR], 200],
    ['ninguna de las dos', [], 403],
  ])('%s → %i', async (_n, funciones, status) => {
    expect(ROL_SIN_NINGUNA).toBeDefined();
    kdb.when.select(TABLA, []);
    const r = await request(await buildApp()).get(ESTADO).set('Authorization', await auth(ROL_SIN_NINGUNA, funciones));
    expect(r.status).toBe(status);
    if (status === 403) {
      expect(r.body).toMatchObject({ funcion: CONFIGURAR, motivo: expect.any(String) });
      expect(kdb.select).not.toHaveBeenCalled();
    }
  });
});
