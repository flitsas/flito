// HU #13410 — recorrido de la corrida horaria de borrados pendientes:
// `flito-soat-borrados-pendientes.service.ts`. AC3–AC8. Matriz qa-a-13410, archivo F2.
//
// Mock propio por tabla: cada SELECT/UPDATE/INSERT queda registrado con su condición en crudo, y los
// asertos van sobre el SQL renderizado y los valores ESCRITOS, nunca sobre filas que el mock devuelve.
// `db.transaction` entrega un `tx` distinto de `db` para saber qué va dentro.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ligadosA, renderizar } from '../helpers/sql-ligado.js';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

type Op = { quien: 'tx' | 'db'; op: string; tabla: string; datos?: Record<string, unknown>; cond?: SQL; campos?: string[] };

const h = vi.hoisted(() => ({
  ops: [] as unknown[],
  pendientes: [] as unknown[],
  conteo: [] as unknown[],
  refSoportes: [] as unknown[],
  refIncompletas: [] as unknown[],
  updateDevuelve: 1,
}));
const removeMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => {
  const l: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  l.child = () => l;
  return l as Record<string, ReturnType<typeof vi.fn>>;
});

function nombre(tbl: unknown): string { return getTableName(tbl as never); }

function cliente(quien: 'tx' | 'db') {
  const registrar = (o: Op) => { (h.ops as Op[]).push(o); return o; };
  return {
    select: (campos: Record<string, unknown>) => {
      const o: Op = { quien, op: 'select', tabla: '', campos: Object.keys(campos) };
      const filas = () => {
        if (o.tabla === 'flito_soportes') return h.refSoportes;
        if (o.tabla === 'flito_soat_incompletas') return h.refIncompletas;
        return o.campos!.includes('n') ? h.conteo : h.pendientes;
      };
      const c: Record<string, unknown> = {
        from: (tbl: unknown) => { o.tabla = nombre(tbl); registrar(o); return c; },
        where: (cond: SQL) => { o.cond = cond; return c; },
        orderBy: () => c, limit: () => c, groupBy: () => c,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(filas()).then(res, rej),
      };
      return c;
    },
    update: (tbl: unknown) => ({
      set: (datos: Record<string, unknown>) => ({
        where: (cond: SQL) => {
          registrar({ quien, op: 'update', tabla: nombre(tbl), datos, cond });
          const p = Promise.resolve([]) as Promise<unknown[]> & { returning?: () => Promise<unknown[]> };
          p.returning = async () => Array.from({ length: h.updateDevuelve }, () => ({ id: 'x' }));
          return p;
        },
      }),
    }),
    insert: (tbl: unknown) => ({
      values: async (datos: Record<string, unknown>) => { registrar({ quien, op: 'insert', tabla: nombre(tbl), datos }); },
    }),
  };
}

vi.mock('../../src/db/client.js', () => ({
  db: { ...cliente('db'), transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(cliente('tx'))) },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/services/storage.js', () => ({ removeEntityDocument: removeMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const svc = await import('../../src/modules/flito-soat/flito-soat-borrados-pendientes.service.js');
const { flitoStorageBorradosPendientesAbiertos } = await import('../../src/shared/metrics.js');
const { db } = await import('../../src/db/client.js');

const AHORA = new Date('2026-10-07T15:00:00.000Z');
const H = 60 * 60_000;
const P1 = '9e000000-0000-4000-8000-0000000134a1';
const P2 = '9e000000-0000-4000-8000-0000000134a2';
const KEY = 'clientes/900123456/soat/documentos-adicionales/abc/cedula-de-juan-perez.pdf';
const KEY2 = 'clientes/900123456/soat/documentos-adicionales/abc/rut-de-maria.pdf';
const ORIGEN = 'soat.documento_adicional';
const T = 'flito_storage_borrados_pendientes';
const dialecto = new PgDialect();

const pendiente = (over: Record<string, unknown> = {}) => ({
  id: P1, storageKey: KEY, origen: ORIGEN, intentos: 3, creadoEn: new Date(AHORA.getTime() - 2 * H), ultimaAlertaEn: null, ...over,
});
const ops = () => h.ops as Op[];
const opsEn = (op: string, tabla: string) => ops().filter((o) => o.op === op && o.tabla === tabla);
const sqlDe = (v: unknown) => dialecto.sqlToQuery(v as SQL).sql;
const todoLoLogueado = () => JSON.stringify([logMock.error.mock.calls, logMock.warn.mock.calls, logMock.info.mock.calls]);
const accessDenied = () => Object.assign(new Error(`Access Denied ${KEY}`), { code: 'AccessDenied' });
async function gauge(): Promise<{ value: number; labels: Record<string, unknown> }[]> {
  return (await flitoStorageBorradosPendientesAbiertos.get()).values as never;
}

beforeEach(() => {
  h.ops.length = 0;
  h.pendientes = [pendiente()];
  h.conteo = [];
  h.refSoportes = [];
  h.refIncompletas = [];
  h.updateDevuelve = 1;
  removeMock.mockReset().mockResolvedValue(undefined);
  (db as { transaction: ReturnType<typeof vi.fn> }).transaction.mockClear();
  Object.values(logMock).forEach((f) => typeof f === 'function' && 'mockClear' in f && f.mockClear());
  flitoStorageBorradosPendientesAbiertos.reset();
});

describe('Lectura — abiertos, no intentados en los últimos 55 min, los más viejos primero', () => {
  it('la condición leída exige `resuelto_en is null` y `ultimo_intento_en` nulo o <= ahora − 55 min', async () => {
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const [sel] = opsEn('select', T).filter((o) => !o.campos!.includes('n'));
    const q = renderizar(sel.cond!);
    expect(q.sql).toMatch(/"flito_storage_borrados_pendientes"\."resuelto_en" is null/);
    expect(q.sql).toMatch(/"flito_storage_borrados_pendientes"\."ultimo_intento_en" is null/);
    const m = /"flito_storage_borrados_pendientes"\."ultimo_intento_en" <= \$(\d+)/.exec(q.sql);
    expect(m).not.toBeNull();
    expect(new Date(q.params[Number(m![1]) - 1] as string).getTime()).toBe(AHORA.getTime() - 55 * 60_000);
    expect(svc.LOTE_BORRADOS).toBe(100);
  });
});

describe('AC3 — el cron borra y resuelve el pendiente, con Bitácora sin PII', () => {
  it('TC-3.1 removeEntityDocument(clave exacta); UPDATE en transacción que cierra, suma el intento y pone la clave a NULL', async () => {
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(KEY);
    const [up] = opsEn('update', T);
    expect(up.quien).toBe('tx');
    const { intentos, ...resto } = up.datos!;
    expect(resto).toEqual({ resueltoEn: AHORA, motivoCierre: 'borrado', storageKey: null, ultimoIntentoEn: AHORA });
    expect(sqlDe(intentos)).toMatch(/"intentos" \+ 1/);
    const q = renderizar(up.cond!);
    expect(ligadosA(q, '"flito_storage_borrados_pendientes"."id"')).toEqual([P1]);
    expect(q.sql).toMatch(/"resuelto_en" is null/);
    expect(r).toMatchObject({ leidos: 1, borrados: 1, fallidos: 0 });
  });

  it('TC-3.2 una Bitácora `delete` del sistema con el id del pendiente y el origen; sin clave, huella ni NIT', async () => {
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const audits = opsEn('insert', 'audit_logs');
    expect(audits).toHaveLength(1);
    expect(audits[0].quien).toBe('tx');
    expect(audits[0].datos).toEqual({
      userId: null, userEmail: 'sistema', action: 'delete', resource: 'soat.storage.borrado_pendiente_resuelto',
      resourceId: P1, detail: 'soat.storage.borrado_pendiente_resuelto: origen soat.documento_adicional; motivo borrado; intentos 4.',
    });
    const serial = JSON.stringify(audits);
    expect(serial).not.toContain('900123456');
    expect(serial).not.toContain('cedula');
  });

  it('idempotencia: si el UPDATE no toma la fila (otro la cerró), no hay Bitácora', async () => {
    h.updateDevuelve = 0;
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(opsEn('insert', 'audit_logs')).toEqual([]);
    expect(r.borrados).toBe(0);
  });
});

describe('AC4/AC5 — un fallo NO cierra; «no existe» SÍ cierra', () => {
  it('TC-4.1 AccessDenied: UPDATE suma intento, anota hora y CÓDIGO (no el mensaje); no cierra, no toca la clave, sin Bitácora', async () => {
    removeMock.mockRejectedValueOnce(accessDenied());
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(opsEn('delete', T)).toEqual([]);
    const [up] = opsEn('update', T);
    const { intentos, ...resto } = up.datos!;
    expect(resto).toEqual({ ultimoIntentoEn: AHORA, ultimoError: 'AccessDenied' });
    expect(sqlDe(intentos)).toMatch(/"intentos" \+ 1/);
    expect(opsEn('insert', 'audit_logs')).toEqual([]);
    expect(r).toMatchObject({ fallidos: 1, borrados: 0 });
    expect(todoLoLogueado()).not.toContain('900123456');
  });

  it('TC-5.1 NoSuchKey: se cierra como `inexistente` (clave a NULL) con Bitácora y sin log de error', async () => {
    removeMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'NoSuchKey' }));
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const [up] = opsEn('update', T);
    expect(up.datos).toMatchObject({ resueltoEn: AHORA, motivoCierre: 'inexistente', storageKey: null });
    expect(opsEn('insert', 'audit_logs')[0].datos!.detail).toContain('motivo inexistente');
    expect(logMock.error).not.toHaveBeenCalled();
    expect(r).toMatchObject({ inexistentes: 1, fallidos: 0 });
  });

  it('TC-4.2 aislamiento: el 1.º falla y el 2.º se resuelve igual', async () => {
    h.pendientes = [pendiente(), pendiente({ id: P2, storageKey: KEY2 })];
    removeMock.mockRejectedValueOnce(accessDenied()).mockResolvedValueOnce(undefined);
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const ups = opsEn('update', T);
    expect(ups).toHaveLength(2);
    expect(ligadosA(renderizar(ups[1].cond!), '"flito_storage_borrados_pendientes"."id"')).toEqual([P2]);
    expect(ups[1].datos).toMatchObject({ motivoCierre: 'borrado', storageKey: null });
    expect(r).toMatchObject({ leidos: 2, fallidos: 1, borrados: 1 });
  });
});

describe('AC6 — clave aún referenciada: no se borra el objeto', () => {
  it('TC-6.1 referenciada por un soporte: sin remove; cierre `referenciada` con la clave a NULL; warn sin clave', async () => {
    h.refSoportes = [{ clave: KEY }];
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(removeMock).not.toHaveBeenCalled();
    const [sel] = opsEn('select', 'flito_soportes');
    expect(ligadosA(renderizar(sel.cond!), '"flito_soportes"."storage_key"')).toEqual([KEY]);
    expect(opsEn('update', T)[0].datos).toEqual({ resueltoEn: AHORA, motivoCierre: 'referenciada', storageKey: null });
    expect(logMock.warn).toHaveBeenCalledWith(
      { evento: 'soat.storage.borrado_pendiente_referenciada', pendienteId: P1, origen: ORIGEN }, expect.any(String),
    );
    expect(todoLoLogueado()).not.toContain('900123456');
    expect(opsEn('insert', 'audit_logs')).toEqual([]);
    expect(r.referenciados).toBe(1);
  });

  it('TC-6.2 referenciada como factura de una solicitud por validar: igual, sin remove', async () => {
    h.refIncompletas = [{ clave: KEY }];
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const [sel] = opsEn('select', 'flito_soat_incompletas');
    expect(ligadosA(renderizar(sel.cond!), '"flito_soat_incompletas"."factura_storage_key"')).toEqual([KEY]);
    expect(removeMock).not.toHaveBeenCalled();
    expect(opsEn('update', T)[0].datos).toMatchObject({ motivoCierre: 'referenciada' });
  });

  it('TC-6.3 sin referencias: sí borra (la comprobación no lo vuelve todo «referenciada»)', async () => {
    h.refSoportes = [{ clave: 'otra/clave.pdf' }];
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(removeMock).toHaveBeenCalledWith(KEY);
  });
});

describe('AC7 — alerta a las 72 h, como mucho una vez cada 24 h; gauge de abiertos', () => {
  const fallarCon = async (over: Record<string, unknown>) => {
    h.pendientes = [pendiente(over)];
    removeMock.mockRejectedValueOnce(accessDenied());
    return svc.ejecutarBorradosPendientes({ ahora: AHORA });
  };
  const alerto = () => logMock.error.mock.calls.some((c) => (c[0] as { evento?: string }).evento === 'soat.storage.borrado_pendiente_persistente');

  it('TC-7.1 72 h exactas: error persistente (id, origen, intentos; sin clave) y `ultima_alerta_en` en el mismo UPDATE', async () => {
    const r = await fallarCon({ creadoEn: new Date(AHORA.getTime() - 72 * H) });
    expect(logMock.error).toHaveBeenCalledWith(
      { evento: 'soat.storage.borrado_pendiente_persistente', pendienteId: P1, origen: ORIGEN, intentos: 4 }, expect.any(String),
    );
    expect(opsEn('update', T)[0].datos).toMatchObject({ ultimaAlertaEn: AHORA, ultimoError: 'AccessDenied' });
    expect(todoLoLogueado()).not.toContain('900123456');
    expect(r.alertados).toBe(1);
  });

  it('TC-7.2 71 h 59 min: sin alerta y sin tocar `ultima_alerta_en`', async () => {
    await fallarCon({ creadoEn: new Date(AHORA.getTime() - 72 * H + 60_000) });
    expect(alerto()).toBe(false);
    expect(opsEn('update', T)[0].datos).not.toHaveProperty('ultimaAlertaEn');
  });

  it('TC-7.3 alertado hace 23 h → no; hace 24 h → sí', async () => {
    await fallarCon({ creadoEn: new Date(AHORA.getTime() - 100 * H), ultimaAlertaEn: new Date(AHORA.getTime() - 23 * H) });
    expect(alerto()).toBe(false);
    h.ops.length = 0;
    await fallarCon({ creadoEn: new Date(AHORA.getTime() - 100 * H), ultimaAlertaEn: new Date(AHORA.getTime() - 24 * H) });
    expect(alerto()).toBe(true);
  });

  it('TC-7.4 más de 72 h pero el borrado sale bien: sin alerta', async () => {
    h.pendientes = [pendiente({ creadoEn: new Date(AHORA.getTime() - 200 * H) })];
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(alerto()).toBe(false);
  });

  it('TC-7.5 el gauge refleja los abiertos por origen del conteo (filtro `resuelto_en is null`) y vuelve a 0', async () => {
    h.conteo = [{ origen: ORIGEN, n: 2 }];
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    const [cnt] = opsEn('select', T).filter((o) => o.campos!.includes('n'));
    expect(renderizar(cnt.cond!).sql).toMatch(/"resuelto_en" is null/);
    expect(await gauge()).toEqual([{ value: 2, labels: { origen: ORIGEN } }]);
    expect(r.abiertos).toBe(2);
    h.conteo = [];
    h.pendientes = [];
    await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(await gauge()).toEqual([]);
  });

  it('debeAlertar: fronteras inclusivas', () => {
    expect(svc.debeAlertar({ creadoEn: new Date(AHORA.getTime() - 72 * H), ultimaAlertaEn: null }, AHORA)).toBe(true);
    expect(svc.debeAlertar({ creadoEn: new Date(AHORA.getTime() - 72 * H + 1), ultimaAlertaEn: null }, AHORA)).toBe(false);
    expect(svc.debeAlertar({ creadoEn: new Date(0), ultimaAlertaEn: new Date(AHORA.getTime() - 24 * H + 1) }, AHORA)).toBe(false);
  });
});

describe('AC8 — sin pendientes no se toca nada', () => {
  it('TC-8.4 0 abiertos: ni storage, ni transacción, ni UPDATE, ni Bitácora; solo el conteo del gauge', async () => {
    h.pendientes = [];
    const r = await svc.ejecutarBorradosPendientes({ ahora: AHORA });
    expect(removeMock).not.toHaveBeenCalled();
    expect((db as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
    expect(ops().filter((o) => o.op !== 'select')).toEqual([]);
    expect(opsEn('select', 'flito_soportes')).toEqual([]);
    expect(r).toEqual({ leidos: 0, borrados: 0, inexistentes: 0, referenciados: 0, fallidos: 0, alertados: 0, abiertos: 0 });
  });
});

describe('Ley 1581 — valoresCierre siempre borra la clave', () => {
  it('los tres motivos escriben `storageKey: null`', () => {
    for (const m of ['borrado', 'inexistente', 'referenciada'] as const) {
      expect(svc.valoresCierre(m, AHORA)).toEqual({ resueltoEn: AHORA, motivoCierre: m, storageKey: null });
    }
  });
});
