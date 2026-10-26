// HU #13891 (Feature #13888, ADR-0028 §9/§14) — purga por retención de las versiones REEMPLAZADAS del
// expediente de la compañía: `flito-bolsas-documentos-purga.service.ts` + `.cron.ts`. AC1–AC4.
//
// La base es un FAKE LOCAL, como en `flito-soat-retencion.service.test.ts`: no filtra. Por eso AC2/AC3
// se certifican dos veces: sobre el WHERE renderizado (`PgDialect.sqlToQuery`, con el corte exacto) y
// sobre la segunda barrera del servicio, dándole al fake filas que NO debe tocar.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

interface Escrito { tabla: string; datos?: Record<string, unknown>; cond?: unknown }

const f = vi.hoisted(() => ({
  selects: [] as { tabla: string; cond: unknown; limite?: number }[],
  updates: [] as Escrito[],
  inserts: [] as Escrito[],
  orden: [] as string[],
  candidatas: [] as unknown[],
  transacciones: 0,
  txFalla: false,
  pendientes: 0,
}));
const storage = vi.hoisted(() => ({ remove: vi.fn() }));
const logs = vi.hoisted(() => ({ lineas: [] as unknown[][] }));
const cron = vi.hoisted(() => ({ withLock: vi.fn(), env: {} as Record<string, unknown> }));

vi.mock('../../src/config/env.js', async (orig) => {
  const real = (await orig()) as { env: Record<string, unknown> };
  Object.assign(cron.env, real.env, { BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED: false, BOLSAS_DOCUMENTOS_RETENCION_ANIOS: 5 });
  return { env: cron.env };
});
vi.mock('../../src/shared/utils/lock.js', () => ({ withLock: cron.withLock }));
vi.mock('../../src/services/storage.js', () => ({ removeEntityDocument: storage.remove }));
vi.mock('../../src/shared/logger.js', () => {
  const l = {
    info: (...a: unknown[]) => { logs.lineas.push(a); },
    warn: (...a: unknown[]) => { logs.lineas.push(a); },
    error: (...a: unknown[]) => { logs.lineas.push(a); },
    debug: () => {},
    child: () => l,
  };
  return { loggerFor: () => l, logger: l };
});

vi.mock('../../src/db/client.js', () => {
  const nombre = (t: unknown) => { try { return getTableName(t as never); } catch { return '?'; } };
  const params = (cond: unknown) => new PgDialect().sqlToQuery(cond as never).params as unknown[];
  const update = (t: unknown) => ({
    set: (datos: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const tabla = nombre(t);
        f.updates.push({ tabla, datos, cond });
        f.orden.push(`update:${tabla}`);
        // Devuelve las candidatas cuyo id liga el WHERE (simula el UPDATE … RETURNING).
        const ids = (f.candidatas as { id: string }[]).map((c) => c.id).filter((id) => params(cond).includes(id));
        const p = Promise.resolve(undefined);
        return Object.assign(p, { returning: async () => ids.map((id) => ({ id })) });
      },
    }),
  });
  const insert = (t: unknown) => ({
    values: (datos: Record<string, unknown>) => {
      const tabla = nombre(t);
      f.inserts.push({ tabla, datos });
      f.orden.push(`insert:${tabla}`);
      const p = Promise.resolve(undefined);
      return Object.assign(p, { returning: async () => [{ id: `pend-${++f.pendientes}` }] });
    },
  });
  const db = {
    select: () => ({
      from: (t: unknown) => ({
        where: (cond: unknown) => {
          const leido = { tabla: nombre(t), cond, limite: undefined as number | undefined };
          f.selects.push(leido);
          const q = {
            orderBy: () => q,
            limit: async (n: number) => { leido.limite = n; return f.candidatas; },
          };
          return q;
        },
      }),
    }),
    update,
    insert,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      f.transacciones += 1;
      if (f.txFalla) throw Object.assign(new Error('conexión caída'), { name: 'DatabaseError' });
      return cb({ update, insert });
    },
  };
  return { db };
});

import {
  ACCION_BITACORA_PURGA, LOTE_PURGA, ORIGEN_PURGA_BOLSAS_DOCUMENTOS, corteRetencion, ejecutarPurgaVersiones,
} from '../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos-purga.service.js';
import {
  NOMBRE_LOCK_PURGA, latidoPurgaVersiones, reiniciarEstadoPurga, startBolsasDocumentosPurgaCron,
  stopBolsasDocumentosPurgaCron,
} from '../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos-purga.cron.js';
import { condicionAbiertos } from '../../src/modules/flito-soat/flito-soat-borrados-pendientes.service.js';
import { huellaClave } from '../../src/services/storage-errores.js';

const AHORA = new Date('2026-10-23T08:30:00.000Z'); // 03:30 en Bogotá
const CORTE = new Date('2021-10-23T08:30:00.000Z');
const DIA = 24 * 60 * 60_000;
const NIT = '900123456';
const clave = (n: number) => `bolsas/${NIT}/camara_comercio/v${n}-Acta Juan Perez.pdf`;

function version(id: string, o: Partial<Record<string, unknown>> = {}) {
  return {
    id, companiaId: 77, storageKey: clave(Number(id.slice(-1)) || 1), tamanoBytes: 1000,
    vigente: false, reemplazadoEn: new Date(CORTE.getTime() - DIA), purgadoEn: null, ...o,
  };
}

const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as never);
const texto = (x: unknown) => JSON.stringify(x);

function sinPii(): void {
  const todo = texto(logs.lineas) + texto(f.inserts.filter((i) => i.tabla === 'audit_logs'));
  expect(todo).not.toContain(NIT);
  expect(todo).not.toContain('Juan Perez');
  expect(todo).not.toContain('bolsas/');
}

beforeEach(() => {
  f.selects = []; f.updates = []; f.inserts = []; f.orden = []; f.candidatas = [];
  f.transacciones = 0; f.txFalla = false; f.pendientes = 0;
  logs.lineas = [];
  storage.remove.mockReset();
  storage.remove.mockImplementation(async () => { f.orden.push('storage.remove'); });
  cron.withLock.mockReset();
  cron.withLock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<unknown>) => fn());
  cron.env.BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED = false;
  reiniciarEstadoPurga();
});

describe('corte y consulta (RN-BDP1)', () => {
  it('N = 5 años por defecto: el corte es ahora − 5 años', () => {
    expect(corteRetencion(AHORA)).toEqual(CORTE);
  });

  it('el WHERE exige no vigente, no purgada, con clave y reemplazada en o antes del corte; lote 200', async () => {
    await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(f.selects).toHaveLength(1);
    const { sql, params } = render(f.selects[0].cond);
    expect(sql).toContain('not "flito_bolsas_documentos"."vigente"');
    expect(sql).toContain('"flito_bolsas_documentos"."purgado_en" is null');
    expect(sql).toContain('"flito_bolsas_documentos"."storage_key" is not null');
    expect(sql).toContain('"flito_bolsas_documentos"."reemplazado_en" <= $1');
    expect(params).toEqual([CORTE.toISOString()]);
    expect(f.selects[0].limite).toBe(LOTE_PURGA);
    expect(LOTE_PURGA).toBe(200);
  });
});

describe('AC1 — versión reemplazada hace más de N años', () => {
  it('anula la clave y marca purgado_en, encola el borrado, borra el objeto y cierra el pendiente', async () => {
    f.candidatas = [version('v-1'), version('v-2', { reemplazadoEn: CORTE })]; // frontera inclusiva
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });

    expect(r).toEqual({ consideradas: 2, purgadas: 2, companias: 1, bytes: 2000, objetosBorrados: 2, objetosPendientes: 0 });
    expect(f.transacciones).toBe(1);
    const marca = f.updates.find((u) => u.tabla === 'flito_bolsas_documentos')!;
    expect(marca.datos).toEqual({ storageKey: null, purgadoEn: AHORA });
    const { sql, params } = render(marca.cond);
    expect(sql).toContain('"flito_bolsas_documentos"."vigente" = $');
    expect(sql).toContain('"flito_bolsas_documentos"."purgado_en" is null');
    expect(params).toEqual(expect.arrayContaining(['v-1', 'v-2', 77, false]));

    const pendientes = f.inserts.filter((i) => i.tabla === 'flito_storage_borrados_pendientes');
    expect(pendientes.map((p) => p.datos)).toEqual([
      { storageKey: clave(1), claveHash: huellaClave(clave(1)), origen: ORIGEN_PURGA_BOLSAS_DOCUMENTOS },
      { storageKey: clave(2), claveHash: huellaClave(clave(2)), origen: ORIGEN_PURGA_BOLSAS_DOCUMENTOS },
    ]);
    // Marca → encolado → Bitácora (misma transacción) → borrado del objeto.
    expect(f.orden.slice(0, 5)).toEqual([
      'update:flito_bolsas_documentos', 'insert:flito_storage_borrados_pendientes',
      'insert:flito_storage_borrados_pendientes', 'insert:audit_logs', 'storage.remove',
    ]);
    expect(storage.remove.mock.calls.map((c) => c[0])).toEqual([clave(1), clave(2)]);
    const cierres = f.updates.filter((u) => u.tabla === 'flito_storage_borrados_pendientes');
    expect(cierres).toHaveLength(2);
    for (const c of cierres) expect(c.datos).toMatchObject({ resueltoEn: AHORA, motivoCierre: 'borrado', storageKey: null });
  });

  it('deja UNA huella de auditoría por compañía (compañía, cantidad; la fecha es la del registro) sin PII', async () => {
    f.candidatas = [version('v-1'), version('v-2'), version('v-3', { companiaId: 88 })];
    await ejecutarPurgaVersiones({ ahora: AHORA });
    const audit = f.inserts.filter((i) => i.tabla === 'audit_logs').map((i) => i.datos!);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      userId: null, userEmail: 'sistema', action: 'delete', resource: ACCION_BITACORA_PURGA, resourceId: '77',
    });
    expect(audit[0].detail).toContain('Versiones purgadas: 2.');
    expect(audit[0].detail).toContain('retención de 5 años');
    expect(audit[1]).toMatchObject({ resourceId: '88' });
    expect(audit[1].detail).toContain('Versiones purgadas: 1.');
    sinPii();
  });
});

describe('AC2 — documentos vigentes de cualquier antigüedad', () => {
  it('no purga una vigente aunque la consulta la devolviera (segunda barrera)', async () => {
    f.candidatas = [version('v-1', { vigente: true, reemplazadoEn: null }),
      version('v-2', { vigente: true, reemplazadoEn: new Date('2001-01-01T00:00:00Z') })];
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(r.purgadas).toBe(0);
    expect(f.transacciones).toBe(0);
    expect(f.updates).toHaveLength(0);
    expect(f.inserts).toHaveLength(0);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('AC3 — versión reemplazada hace menos de N años', () => {
  it('se conserva (un día antes del corte no entra)', async () => {
    f.candidatas = [version('v-1', { reemplazadoEn: new Date(CORTE.getTime() + 1) }),
      version('v-2', { reemplazadoEn: new Date(AHORA.getTime() - 365 * DIA) })];
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(r.purgadas).toBe(0);
    expect(f.transacciones).toBe(0);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('una ya purgada no se vuelve a tocar', async () => {
    f.candidatas = [version('v-1', { storageKey: null, purgadoEn: new Date('2026-01-01T00:00:00Z') })];
    await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(f.transacciones).toBe(0);
  });
});

describe('AC4 — falla el borrado en storage', () => {
  it('el registro y el pendiente quedan; el fallo se loguea sin PII; el barrido lo reintenta', async () => {
    storage.remove.mockRejectedValue(Object.assign(new Error(`AccessDenied ${clave(1)}`), { code: 'AccessDenied' }));
    f.candidatas = [version('v-1')];
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });

    expect(r).toMatchObject({ purgadas: 1, objetosBorrados: 0, objetosPendientes: 1 });
    // La fila sigue (solo se marcó; nunca DELETE) y el pendiente queda ABIERTO con el error.
    expect(f.updates.find((u) => u.tabla === 'flito_bolsas_documentos')!.datos).toEqual({ storageKey: null, purgadoEn: AHORA });
    const fallo = f.updates.find((u) => u.tabla === 'flito_storage_borrados_pendientes')!;
    expect(fallo.datos).toEqual({ intentos: 1, ultimoIntentoEn: AHORA, ultimoError: 'AccessDenied' });
    expect(fallo.datos).not.toHaveProperty('resueltoEn');

    const linea = logs.lineas.find((l) => texto(l).includes('purga_objeto_pendiente'))!;
    expect(linea[0]).toEqual({
      evento: 'bolsas.documentos.purga_objeto_pendiente', documentoId: 'v-1',
      claveHash: huellaClave(clave(1)), err: 'AccessDenied',
    });
    sinPii();

    // Reintento: el barrido de borrados pendientes no filtra por origen.
    const { sql } = render(condicionAbiertos(new Date(AHORA.getTime() + 60 * 60_000)));
    expect(sql).not.toContain('origen');
    expect(sql).toContain('"resuelto_en" is null');
  });

  it('«el objeto no existe» cuenta como borrado', async () => {
    storage.remove.mockRejectedValue(Object.assign(new Error('x'), { code: 'NoSuchKey' }));
    f.candidatas = [version('v-1')];
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(r).toMatchObject({ objetosBorrados: 1, objetosPendientes: 0 });
    expect(f.updates.find((u) => u.tabla === 'flito_storage_borrados_pendientes')!.datos)
      .toMatchObject({ motivoCierre: 'inexistente' });
  });

  it('si la transacción falla no se borra ningún objeto y la corrida sigue con la otra compañía', async () => {
    f.txFalla = true;
    f.candidatas = [version('v-1'), version('v-2', { companiaId: 88 })];
    const r = await ejecutarPurgaVersiones({ ahora: AHORA });
    expect(r.purgadas).toBe(0);
    expect(f.transacciones).toBe(2);
    expect(storage.remove).not.toHaveBeenCalled();
    sinPii();
  });
});

describe('cron (RN-BDP4)', () => {
  it('puerta positiva: sin el flag no arranca y lo dice', () => {
    const spy = vi.spyOn(global, 'setInterval');
    startBolsasDocumentosPurgaCron();
    expect(spy).not.toHaveBeenCalled();
    expect(texto(logs.lineas)).toContain('DESHABILITADA');
    spy.mockRestore();
  });

  it('con el flag arranca y se detiene', () => {
    cron.env.BOLSAS_DOCUMENTOS_PURGA_CRON_ENABLED = true;
    const spy = vi.spyOn(global, 'setInterval');
    startBolsasDocumentosPurgaCron();
    expect(spy).toHaveBeenCalledTimes(1);
    stopBolsasDocumentosPurgaCron();
    spy.mockRestore();
  });

  it('corre a las 03:xx de Bogotá, una vez al día, dentro de withLock', async () => {
    expect(await latidoPurgaVersiones(new Date('2026-10-23T03:30:00Z'))).toBe('fuera_de_ventana');
    expect(await latidoPurgaVersiones(AHORA)).toBe('corrida');
    expect(cron.withLock).toHaveBeenCalledWith(NOMBRE_LOCK_PURGA, 30 * 60_000, expect.any(Function));
    expect(await latidoPurgaVersiones(new Date(AHORA.getTime() + 10 * 60_000))).toBe('ya_corrio_hoy');
  });

  it('otra instancia con el candado: no purga', async () => {
    cron.withLock.mockResolvedValue(null);
    expect(await latidoPurgaVersiones(AHORA)).toBe('otra_instancia');
    expect(f.selects).toHaveLength(0);
  });
});
