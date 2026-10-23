// HU #13854 (Feature #13696, IA-2) — `dr-flit-ia.cupo.ts` con RELOJ INYECTADO (AC4, AC5) y sin base.
// La conexión es un doble que interpreta las tres sentencias del módulo (INSERT/UPDATE/SELECT) sobre un
// mapa en memoria con la misma semántica que la 0247 (PK usuario × día, CHECK usados >= 0). Lo que
// importa aquí es QUÉ día y QUÉ tope manda el módulo; la semántica real del UPSERT (y la concurrencia)
// se prueba contra PostgreSQL en `__tests__/db/migracion-0247.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConexionCupo } from '../../../src/modules/flito-dr-flit/dr-flit-ia.cupo.js';

vi.mock('../../../src/db/client.js', () => ({ db: { execute: vi.fn() }, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const {
  consultarCupoIa, devolverCupoIa, diaCupoIa, reservarCupoIa,
} = await import('../../../src/modules/flito-dr-flit/dr-flit-ia.cupo.js');
const { iaDisponible, topeDiarioIa } = await import('../../../src/modules/flito-dr-flit/dr-flit.config.js');

const dialecto = new PgDialect();
let tabla: Map<string, number>;
let sentencias: string[];

const conexion: ConexionCupo = {
  async execute(q: SQL) {
    const { sql, params } = dialecto.sqlToQuery(q);
    const p = params as unknown[];
    sentencias.push(sql.trim().split(/\s+/)[0]!.toUpperCase());
    const clave = `${p[0]}|${p[1]}`;
    if (/^\s*INSERT/i.test(sql)) {
      const tope = Number(p[2]);
      if (!(tope >= 1)) return [];
      const actual = tabla.get(clave);
      if (actual === undefined) { tabla.set(clave, 1); return [{ usados: 1 }]; }
      if (actual < Number(p[3])) { tabla.set(clave, actual + 1); return [{ usados: actual + 1 }]; }
      return [];
    }
    if (/^\s*UPDATE/i.test(sql)) {
      const actual = tabla.get(clave);
      if (actual === undefined || actual <= 0) return [];
      tabla.set(clave, actual - 1);
      return [{ usados: actual - 1 }];
    }
    const actual = tabla.get(clave);
    return actual === undefined ? [] : [{ usados: actual }];
  },
};

// America/Bogota = UTC−5, sin horario de verano.
const D_2359 = new Date('2026-10-23T04:59:00Z');   // 2026-10-22 23:59 Bogotá
const D1_0000 = new Date('2026-10-23T05:00:00Z');  // 2026-10-23 00:00 Bogotá
const U = 42;

beforeEach(() => { tabla = new Map(); sentencias = []; });

describe('día de corte en America/Bogota (AC5)', () => {
  it('23:59 de Bogotá es el día D aunque en UTC ya sea D+1; 00:00 de Bogotá es D+1', () => {
    expect(diaCupoIa(D_2359)).toBe('2026-10-22');
    expect(diaCupoIa(D1_0000)).toBe('2026-10-23');
  });

  describe('sin importar la zona del servidor', () => {
    const tzOriginal = process.env.TZ;
    afterEach(() => { process.env.TZ = tzOriginal; if (tzOriginal === undefined) delete process.env.TZ; });

    it.each(['UTC', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('TZ=%s → mismo día de Bogotá', (tz) => {
      process.env.TZ = tz;
      expect(diaCupoIa(D_2359)).toBe('2026-10-22');
      expect(diaCupoIa(D1_0000)).toBe('2026-10-23');
    });
  });

  it('usuario en el tope a las 23:59 de D reserva a las 00:00 de D+1 → concedida y D+1 vale 1', async () => {
    tabla.set(`${U}|2026-10-22`, 30);
    expect(await reservarCupoIa(U, { conexion, tope: 30, ahora: D_2359 })).toMatchObject({ concedida: false, dia: '2026-10-22' });
    const r = await reservarCupoIa(U, { conexion, tope: 30, ahora: D1_0000 });
    expect(r).toEqual({ concedida: true, dia: '2026-10-23', usados: 1, tope: 30, restantes: 29 });
    expect(tabla.get(`${U}|2026-10-22`)).toBe(30);
  });
});

describe('reserva (AC1, AC2, AC9)', () => {
  it('AC1: con 29 usados reserva → 30 y restantes 0', async () => {
    tabla.set(`${U}|2026-10-22`, 29);
    expect(await reservarCupoIa(U, { conexion, tope: 30, ahora: D_2359 }))
      .toEqual({ concedida: true, dia: '2026-10-22', usados: 30, tope: 30, restantes: 0 });
  });

  it('AC2: con 30 usados no reserva, informa tope alcanzado y el contador no cambia', async () => {
    tabla.set(`${U}|2026-10-22`, 30);
    expect(await reservarCupoIa(U, { conexion, tope: 30, ahora: D_2359 }))
      .toEqual({ concedida: false, motivo: 'tope-alcanzado', dia: '2026-10-22', usados: 30, tope: 30, restantes: 0 });
    expect(tabla.get(`${U}|2026-10-22`)).toBe(30);
  });

  it('AC9: con tope 0 ninguna reserva se concede ni crea fila', async () => {
    const r = await reservarCupoIa(U, { conexion, tope: 0, ahora: D_2359 });
    expect(r).toMatchObject({ concedida: false, usados: 0, tope: 0, restantes: 0 });
    expect(tabla.size).toBe(0);
  });

  it('sin `tope` usa DRFLIT_IA_TOPE_DIARIO (default 30)', async () => {
    expect(topeDiarioIa()).toBe(30);
    expect(await reservarCupoIa(U, { conexion, ahora: D_2359 })).toMatchObject({ concedida: true, tope: 30, restantes: 29 });
  });
});

describe('devolución (AC4)', () => {
  it('reservado en D, devuelto ya en D+1: baja el contador de D, no el de D+1', async () => {
    const r = await reservarCupoIa(U, { conexion, tope: 30, ahora: D_2359 });
    await reservarCupoIa(U, { conexion, tope: 30, ahora: D1_0000 });
    expect(await devolverCupoIa(U, r.dia, { conexion })).toBe(true);
    expect(tabla.get(`${U}|2026-10-22`)).toBe(0);
    expect(tabla.get(`${U}|2026-10-23`)).toBe(1);
  });

  it('nunca baja de 0', async () => {
    tabla.set(`${U}|2026-10-22`, 0);
    expect(await devolverCupoIa(U, '2026-10-22', { conexion })).toBe(false);
    expect(tabla.get(`${U}|2026-10-22`)).toBe(0);
    expect(await devolverCupoIa(U, '2026-10-21', { conexion })).toBe(false);
    expect(tabla.has(`${U}|2026-10-21`)).toBe(false);
  });
});

describe('consulta', () => {
  it('sin fila → 0 usados; solo lee', async () => {
    expect(await consultarCupoIa(U, { conexion, tope: 30, ahora: D_2359 })).toEqual({ usados: 0, tope: 30, restantes: 30 });
    expect(sentencias).toEqual(['SELECT']);
  });

  it('si el tope bajó por debajo de lo usado, restantes no es negativo', async () => {
    tabla.set(`${U}|2026-10-22`, 12);
    expect(await consultarCupoIa(U, { conexion, tope: 10, ahora: D_2359 })).toEqual({ usados: 12, tope: 10, restantes: 0 });
  });
});

describe('iaDisponible (función pura)', () => {
  it.each([
    [true, 'sk-x', true],
    [true, undefined, false],
    [true, '', false],
    [false, 'sk-x', false],
  ] as const)('HABILITADA=%s, clave=%s → %s', (hab, clave, esperado) => {
    expect(iaDisponible({ DRFLIT_IA_HABILITADA: hab, ANTHROPIC_API_KEY: clave })).toBe(esperado);
  });
});
