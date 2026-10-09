// HU #13426 (Feature #12871, ADR-0024 §4.4) — `shared/alcance-filas.ts`: la condición por enlace que
// comparten los módulos FLITO abiertos. Unitario y sin base: se renderiza el SQL real con PgDialect.
//
// Reglas que fija:
//   · `ninguno` → sin condición (AC1).
//   · id presente → la condición de SUS filas (AC2/AC6).
//   · id ausente (companiaId null, organismos []) → `false`: CERO filas, nunca «todo».
//   · enlace que la condición no contempla (proveedor contra compañía…) o desconocido → `false`.
//   · `exigirPropio` → 403 sin consultar; el errorHandler lo traduce al cuerpo de la frontera.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { flitoImpuestos } from '../../src/db/schema.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const {
  AlcanceAjenoError, companiaDeAlcance, condicionPorCompania, condicionPorOrganismos, condicionPorProveedor,
  esPropio, exigirPropio,
} = await import('../../src/shared/alcance-filas.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');

const render = (c: SQL | undefined) => {
  if (!c) return null;
  const q = new PgDialect().sqlToQuery(c);
  return { sql: q.sql, params: q.params };
};

const COMPANIA_C = { enlace: 'compania' as const, companiaId: 42 };
const ORGS = { enlace: 'organismos_transito' as const, organismos: ['05001', '11001'] };
const PROV = { enlace: 'proveedor' as const, proveedorId: 'prov-1' };

describe('condicionPorCompania', () => {
  it('sin enlace → sin condición (ve todo, AC1)', () => {
    expect(condicionPorCompania(flitoImpuestos.companiaId, { enlace: 'ninguno' })).toBeUndefined();
  });
  it('compañía C → `compania_id = 42` ligado a SU id', () => {
    expect(render(condicionPorCompania(flitoImpuestos.companiaId, COMPANIA_C)))
      .toEqual({ sql: '"flito_impuestos"."compania_id" = $1', params: [42] });
  });
  it('compañía SIN id → `false` (cero filas, nunca todo)', () => {
    expect(render(condicionPorCompania(flitoImpuestos.companiaId, { enlace: 'compania', companiaId: null }))?.sql).toBe('false');
  });
  it('otro enlace (organismos, proveedor, desconocido) → `false` (falla cerrado)', () => {
    for (const a of [ORGS, PROV, { enlace: null }] as const) {
      expect(render(condicionPorCompania(flitoImpuestos.companiaId, a))?.sql).toBe('false');
    }
  });
});

describe('condicionPorOrganismos', () => {
  it('sin enlace → sin condición', () => {
    expect(condicionPorOrganismos(flitoImpuestos.organismoCodigo, { enlace: 'ninguno' })).toBeUndefined();
  });
  it('organismos [S1, S2] → `in ($1, $2)` con LOS DOS (no solo el primero)', () => {
    expect(render(condicionPorOrganismos(flitoImpuestos.organismoCodigo, ORGS)))
      .toEqual({ sql: '"flito_impuestos"."organismo_codigo" in ($1, $2)', params: ['05001', '11001'] });
  });
  it('lista vacía → `false`; compañía → `false`', () => {
    expect(render(condicionPorOrganismos(flitoImpuestos.organismoCodigo, { enlace: 'organismos_transito', organismos: [] }))?.sql).toBe('false');
    expect(render(condicionPorOrganismos(flitoImpuestos.organismoCodigo, COMPANIA_C))?.sql).toBe('false');
  });
});

describe('condicionPorProveedor', () => {
  it('proveedor → su id; sin id u otro enlace → `false`; sin enlace → nada', () => {
    expect(render(condicionPorProveedor(flitoImpuestos.id, PROV))).toEqual({ sql: '"flito_impuestos"."id" = $1', params: ['prov-1'] });
    expect(render(condicionPorProveedor(flitoImpuestos.id, { enlace: 'proveedor', proveedorId: null }))?.sql).toBe('false');
    expect(render(condicionPorProveedor(flitoImpuestos.id, COMPANIA_C))?.sql).toBe('false');
    expect(condicionPorProveedor(flitoImpuestos.id, { enlace: 'ninguno' })).toBeUndefined();
  });
});

describe('esPropio / exigirPropio / companiaDeAlcance', () => {
  it('compañía: solo SU id; un dueño ausente no es suyo', () => {
    expect(esPropio(COMPANIA_C, { companiaId: 42 })).toBe(true);
    expect(esPropio(COMPANIA_C, { companiaId: 43 })).toBe(false);
    expect(esPropio(COMPANIA_C, { companiaId: null })).toBe(false);
    expect(esPropio({ enlace: 'compania', companiaId: null }, { companiaId: null })).toBe(false);
  });
  it('organismos: cualquiera de SUS secretarías (S2 también); otra → no', () => {
    expect(esPropio(ORGS, { organismo: '11001' })).toBe(true);
    expect(esPropio(ORGS, { organismo: '08001' })).toBe(false);
  });
  it('sin enlace: todo es propio; proveedor o desconocido: nada', () => {
    expect(esPropio({ enlace: 'ninguno' }, { companiaId: 1 })).toBe(true);
    expect(esPropio(PROV, { companiaId: 1 })).toBe(false);
    expect(esPropio({ enlace: null }, { companiaId: 1 })).toBe(false);
  });
  it('exigirPropio lanza AlcanceAjenoError (403) en lo ajeno y no lanza en lo propio', () => {
    expect(() => exigirPropio(COMPANIA_C, { companiaId: 7 })).toThrow(AlcanceAjenoError);
    expect(() => exigirPropio(COMPANIA_C, { companiaId: 42 })).not.toThrow();
    expect(new AlcanceAjenoError().status).toBe(403);
  });
  it('companiaDeAlcance: `undefined` sin enlace (global); el id con compañía; `null` (cero filas) en el resto', () => {
    expect(companiaDeAlcance({ enlace: 'ninguno' })).toBeUndefined();
    expect(companiaDeAlcance(COMPANIA_C)).toBe(42);
    expect(companiaDeAlcance({ enlace: 'compania', companiaId: null })).toBeNull();
    expect(companiaDeAlcance(ORGS)).toBeNull();
    expect(companiaDeAlcance(PROV)).toBeNull();
  });
});

describe('errorHandler — AlcanceAjenoError → 403 con el cuerpo de la frontera', () => {
  it('una escritura ajena que lanza responde 403 `{ error: Sin permisos }`, no 500', async () => {
    const app = express();
    app.post('/x', () => { throw new AlcanceAjenoError(); });
    app.use(errorHandler);
    const r = await request(app).post('/x');
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});
