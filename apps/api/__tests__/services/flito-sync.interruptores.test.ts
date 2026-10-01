// HU #13237 (Feature #13236, Épica #12736) — interruptor por fuente de la sincronización FLIT.
// Frontera HTTP de `/api/flito/sync`: GET/PUT /interruptores (AC1-AC4, AC10), la guarda del
// POST /sincronizar de FLIT 1 (AC5) y la habilitación en GET /estado de FLIT 1 (AC9).
// AC6-AC7 (lectura de FLIT 2) en `flito-sync.flit2-lectura.test.ts` y `flito-sync.flit2-cron.test.ts`;
// AC8-AC9 de FLIT 2 en `flito-sync.flit2-estado.test.ts`. Datos SINTÉTICOS.
//
// El servicio del interruptor corre de verdad sobre el mock keyed por tabla. Como ese mock devuelve la
// fila que se le dé sin mirar la proyección, los asertos de «sin credenciales» comprueban las CLAVES
// de la respuesta (y no solo que estén las propias), y los de persistencia leen lo que el servicio
// pasó a `insert().values()` y `onConflictDoUpdate()`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

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
const entorno = vi.hoisted(() => ({ cron: true }));
vi.mock('../../src/config/env.js', async (orig) => {
  const real = (await orig()) as { env: Record<string, unknown> };
  return { env: new Proxy(real.env, { get: (t, k) => (k === 'FLIT2_SYNC_CRON' ? entorno.cron : t[k as string]) }) };
});

const BASE = '/api/flito/sync';
const TABLA = 'flito_sync_interruptor';

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

let siguienteSub = 1300;
const auth = async (role: TestRole = 'admin', funciones?: string[]) =>
  `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role, funciones })}`;

const EN = new Date('2026-10-01T14:00:00.000Z');
// Filas «como en la base» con columnas ajenas de más: el servicio debe proyectar, no reenviar.
const FILAS = [
  { fuente: 'flit1', encendido: true, updatedAt: null, autorId: null, autorNombre: null, clientId: 'svc-flito', secretCipher: 'x' },
  { fuente: 'flit2', encendido: false, updatedAt: EN, autorId: 7, autorNombre: 'Usuaria Ejemplo', clientId: 'svc-flito', secretCipher: 'x' },
];

/** Espía de `insert` sobre la tabla del interruptor: guarda lo que el servicio intentó escribir. */
function espiarInsert() {
  const escrito: { tabla: string; values?: unknown; conflicto?: { target: unknown; set: Record<string, unknown> } }[] = [];
  kdb.insert.mockImplementation((t: unknown) => {
    const reg: (typeof escrito)[number] = { tabla: getTableName(t as never) };
    escrito.push(reg);
    const c: Record<string, unknown> = {
      values: (v: unknown) => { reg.values = v; return c; },
      onConflictDoUpdate: (o: { target: unknown; set: Record<string, unknown> }) => { reg.conflicto = o; return c; },
      then: (ok: (v: unknown) => unknown) => Promise.resolve([]).then(ok),
    };
    return c;
  });
  return escrito;
}

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  entorno.cron = true;
  for (const f of Object.values(sync)) f.mockReset();
  sync.leerUltimaSincronizacion.mockResolvedValue('2026-09-30T10:00:00.000Z');
  sync.hayTramites.mockResolvedValue(true);
  sync.guardarUltimaSincronizacion.mockResolvedValue(undefined);
  sync.sincronizar.mockResolvedValue({
    tramitesLeidos: 0, tramitesNuevos: 0, tramitesActualizados: 0, tramitesSinCambios: 0, companiasFaltantes: 0, organismosSinEmparejar: 0,
  });
});

describe('HU #13237 · AC1 · GET /interruptores', () => {
  it('con la función → 200: las dos fuentes en orden, valor, quién y cuándo, más el maestro de FLIT 2', async () => {
    kdb.when.select(TABLA, FILAS);
    const r = await request(await buildApp()).get(`${BASE}/interruptores`).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      fuentes: [
        { fuente: 'flit1', encendido: true, actualizadoEn: null, actualizadoPor: null },
        { fuente: 'flit2', encendido: false, actualizadoEn: EN.toISOString(), actualizadoPor: { id: 7, nombre: 'Usuaria Ejemplo' } },
      ],
      maestroFlit2: true,
    });
  });

  it('sin credenciales de FLIT 2: las claves son exactamente las del contrato', async () => {
    kdb.when.select(TABLA, FILAS);
    const r = await request(await buildApp()).get(`${BASE}/interruptores`).set('Authorization', await auth());
    expect(Object.keys(r.body).sort()).toEqual(['fuentes', 'maestroFlit2']);
    for (const f of r.body.fuentes) expect(Object.keys(f).sort()).toEqual(['actualizadoEn', 'actualizadoPor', 'encendido', 'fuente']);
    const json = JSON.stringify(r.body);
    for (const prohibido of ['svc-flito', 'clientId', 'secret']) expect(json).not.toContain(prohibido);
  });

  it('AC8: con FLIT2_SYNC_CRON=false el GET informa maestroFlit2=false', async () => {
    entorno.cron = false;
    kdb.when.select(TABLA, FILAS);
    const r = await request(await buildApp()).get(`${BASE}/interruptores`).set('Authorization', await auth());
    expect(r.body.maestroFlit2).toBe(false);
  });

  it('fila ausente → se informa encendida (sembrada encendida), sin autor', async () => {
    kdb.when.select(TABLA, [FILAS[1]]);
    const r = await request(await buildApp()).get(`${BASE}/interruptores`).set('Authorization', await auth());
    expect(r.body.fuentes[0]).toEqual({ fuente: 'flit1', encendido: true, actualizadoEn: null, actualizadoPor: null });
  });
});

describe('HU #13237 · AC2 · PUT /interruptores/:fuente persiste en la base', () => {
  it('apagar FLIT 2 → upsert con encendido=false, autor y hora; 200 con el interruptor releído', async () => {
    const escrito = espiarInsert();
    kdb.when.selectOnce(TABLA, [{ encendido: true }]) // FOR UPDATE: el anterior
      .selectOnce(TABLA, [{ ...FILAS[1], autorId: 1301, autorNombre: 'Ops' }]); // relectura
    const sub = siguienteSub;
    const r = await request(await buildApp()).put(`${BASE}/interruptores/flit2`)
      .set('Authorization', await auth()).send({ encendido: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fuente: 'flit2', encendido: false, actualizadoEn: EN.toISOString(), actualizadoPor: { id: 1301, nombre: 'Ops' } });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(escrito).toHaveLength(1);
    expect(escrito[0]).toMatchObject({ tabla: TABLA, values: { fuente: 'flit2', encendido: false, updatedBy: sub } });
    expect((escrito[0]!.values as { updatedAt: unknown }).updatedAt).toBeInstanceOf(Date);
    expect(escrito[0]!.conflicto!.set).toMatchObject({ encendido: false, updatedBy: sub });
    expect(Object.keys(escrito[0]!.conflicto!.set).sort()).toEqual(['encendido', 'updatedAt', 'updatedBy']);
  });

  it('encender FLIT 1 escribe la fila flit1 con encendido=true', async () => {
    const escrito = espiarInsert();
    kdb.when.selectOnce(TABLA, [{ encendido: false }]).selectOnce(TABLA, [{ ...FILAS[0], encendido: true }]);
    const r = await request(await buildApp()).put(`${BASE}/interruptores/flit1`)
      .set('Authorization', await auth()).send({ encendido: true });
    expect(r.status).toBe(200);
    expect(escrito[0]).toMatchObject({ values: { fuente: 'flit1', encendido: true } });
  });
});

describe('HU #13237 · AC3 · 400 datos_invalidos', () => {
  it.each([
    ['fuente inválida', 'flit3', { encendido: true }],
    ['encendido no booleano (texto)', 'flit2', { encendido: 'false' }],
    ['encendido no booleano (número)', 'flit2', { encendido: 0 }],
    ['sin encendido', 'flit2', {}],
    ['clave de más (.strict)', 'flit2', { encendido: true, fuente: 'flit1' }],
  ])('%s → 400 sin escribir ni auditar, y sin eco de lo recibido', async (_c, fuente, cuerpo) => {
    const escrito = espiarInsert();
    const r = await request(await buildApp()).put(`${BASE}/interruptores/${fuente}`)
      .set('Authorization', await auth()).send(cuerpo);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ codigo: 'datos_invalidos' });
    expect(r.body.faltantes.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('flit3');
    expect(escrito).toEqual([]);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('HU #13237 · AC4 · 401 sin sesión, 403 sin la función', () => {
  it.each([
    ['GET', `${BASE}/interruptores`],
    ['PUT', `${BASE}/interruptores/flit2`],
  ])('%s sin token → 401', async (metodo, ruta) => {
    const app = await buildApp();
    const r = metodo === 'GET' ? await request(app).get(ruta) : await request(app).put(ruta).send({ encendido: false });
    expect(r.status).toBe(401);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'financiera', 'gestor_impuestos'])('rol %s sin la función → 403 en GET y en PUT, sin escribir', async (rol) => {
    const escrito = espiarInsert();
    const app = await buildApp();
    expect((await request(app).get(`${BASE}/interruptores`).set('Authorization', await auth(rol))).status).toBe(403);
    expect((await request(app).put(`${BASE}/interruptores/flit2`).set('Authorization', await auth(rol)).send({ encendido: false })).status).toBe(403);
    expect(escrito).toEqual([]);
  });

  it('ver el estado (sync.sync.ver_estado) NO basta para configurar → 403', async () => {
    const r = await request(await buildApp()).put(`${BASE}/interruptores/flit2`)
      .set('Authorization', await auth('auditor', ['sync.sync.ver_estado'])).send({ encendido: false });
    expect(r.status).toBe(403);
  });
});

describe('HU #13237 · AC5 · POST /sincronizar con FLIT 1 apagada', () => {
  it('409 FUENTE_APAGADA: no consulta FLIT 1, no escribe, no mueve la última sincronización, no audita', async () => {
    kdb.when.select(TABLA, [{ encendido: false }]);
    const r = await request(await buildApp()).post(`${BASE}/sincronizar`)
      .set('Authorization', await auth()).send({ initialDate: '2026-09-01' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'FUENTE_APAGADA', fuente: 'flit1' });
    expect(typeof r.body.error).toBe('string');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(sync.leerUltimaSincronizacion).not.toHaveBeenCalled();
    expect(sync.guardarUltimaSincronizacion).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('control: encendida, la misma petición sincroniza y guarda la última', async () => {
    kdb.when.select(TABLA, [{ encendido: true }]);
    const r = await request(await buildApp()).post(`${BASE}/sincronizar`)
      .set('Authorization', await auth()).send({ initialDate: '2026-09-01' });
    expect(r.status).toBe(200);
    expect(sync.sincronizar).toHaveBeenCalledTimes(1);
    expect(sync.guardarUltimaSincronizacion).toHaveBeenCalledTimes(1);
  });

  it('si la base falla al leer el interruptor → 500 con copy propio, sin sincronizar (no se toma como «encendido»)', async () => {
    kdb.when.selectThrow(TABLA, new Error('conexión perdida'));
    const r = await request(await buildApp()).post(`${BASE}/sincronizar`)
      .set('Authorization', await auth()).send({ initialDate: '2026-09-01' });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('No se pudo verificar si la sincronización con FLIT 1 está encendida');
    expect(JSON.stringify(r.body)).not.toContain('conexión perdida');
    expect(sync.sincronizar).not.toHaveBeenCalled();
    expect(sync.guardarUltimaSincronizacion).not.toHaveBeenCalled();
  });
});

describe('HU #13237 · AC9 · GET /estado de FLIT 1 informa la habilitación', () => {
  it('quien tiene ver_estado y NO configurar ve habilitada=false con motivo interruptor, sin credenciales', async () => {
    kdb.when.select(TABLA, [{ encendido: false }]);
    const r = await request(await buildApp()).get(`${BASE}/estado`)
      .set('Authorization', await auth('auditor', ['sync.sync.ver_estado']));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ultimaSincronizacion: '2026-09-30T10:00:00.000Z', hayTramites: true, habilitada: false, motivoDeshabilitada: 'interruptor',
    });
  });

  it('encendida → habilitada=true y motivo null', async () => {
    kdb.when.select(TABLA, [{ encendido: true }]);
    const r = await request(await buildApp()).get(`${BASE}/estado`).set('Authorization', await auth());
    expect(r.body).toMatchObject({ habilitada: true, motivoDeshabilitada: null });
  });
});

describe('HU #13237 · AC10 · auditoría de cada PUT, sin PII', () => {
  it('cambio real: usuario (por req), fuente y par anterior → nuevo', async () => {
    espiarInsert();
    kdb.when.selectOnce(TABLA, [{ encendido: true }]).selectOnce(TABLA, [FILAS[1]]);
    await request(await buildApp()).put(`${BASE}/interruptores/flit2`).set('Authorization', await auth()).send({ encendido: false });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const [req, entrada] = auditMock.mock.calls[0]!;
    expect((req as { user?: { sub?: number } }).user?.sub).toBeTypeOf('number');
    expect(entrada).toEqual({
      action: 'update', resource: 'flito_sync_interruptor', resourceId: 'flit2',
      detail: 'Interruptor de sincronización flit2: encendido → apagado',
    });
  });

  it('mismo valor: también se audita, marcado «sin cambio»', async () => {
    espiarInsert();
    kdb.when.selectOnce(TABLA, [{ encendido: false }]).selectOnce(TABLA, [FILAS[1]]);
    await request(await buildApp()).put(`${BASE}/interruptores/flit2`).set('Authorization', await auth()).send({ encendido: false });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ detail: 'Interruptor de sincronización flit2: apagado → apagado (sin cambio)' });
  });

  it('fila ausente al guardar: el anterior es el default sembrado (encendido)', async () => {
    espiarInsert();
    kdb.when.selectOnce(TABLA, []).selectOnce(TABLA, [FILAS[1]]);
    await request(await buildApp()).put(`${BASE}/interruptores/flit2`).set('Authorization', await auth()).send({ encendido: false });
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ detail: 'Interruptor de sincronización flit2: encendido → apagado' });
  });

  it('el detalle no lleva nombre, correo ni id de la persona', async () => {
    espiarInsert();
    kdb.when.selectOnce(TABLA, [{ encendido: true }]).selectOnce(TABLA, [FILAS[1]]);
    await request(await buildApp()).put(`${BASE}/interruptores/flit2`).set('Authorization', await auth()).send({ encendido: false });
    const detalle = String((auditMock.mock.calls[0]![1] as { detail: string }).detail);
    for (const pii of ['Usuaria Ejemplo', 'ops@flit.io', '@', '1300', '1301', '1302']) expect(detalle).not.toContain(pii);
  });
});
