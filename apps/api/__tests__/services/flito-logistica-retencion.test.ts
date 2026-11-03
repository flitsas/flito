// HU #14113 (Feature #14091) — purga por retención de la cédula de las firmas de logística:
// `flito-logistica-retencion.service.ts`. AC1–AC5.
//
// La base es un FAKE LOCAL: este test certifica qué columnas se anulan y el SQL del WHERE, no las
// filas que el propio test registró.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Escrito { tabla: string; datos?: Record<string, unknown>; cond?: unknown }

const f = vi.hoisted(() => ({
  updates: [] as Escrito[],
  devuelve: {
    actas: [] as { id: string }[],
    recogida: [] as { id: string }[],
  },
}));

const logs = vi.hoisted(() => ({ lineas: [] as unknown[][] }));

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
  return {
    db: {
      update: (t: unknown) => ({
        set: (datos: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              const tabla = nombre(t);
              f.updates.push({ tabla, datos, cond });
              if (tabla === 'flito_logistica_acta_firmas') return f.devuelve.actas;
              if (tabla === 'flito_logistica_recogida_firmantes') return f.devuelve.recogida;
              return [];
            },
          }),
        }),
      }),
    },
    getPoolStats: vi.fn(),
  };
});

const svc = await import('../../src/modules/flito-logistica/flito-logistica-retencion.service.js');

const dialecto = new PgDialect();
const render = (cond: unknown) => {
  const q = dialecto.sqlToQuery(cond as never);
  return { sql: q.sql.replace(/\s+/g, ' '), params: q.params };
};

const AHORA = new Date('2026-10-07T10:10:00.000Z');
const NOMBRE_PLANTA = 'Persona Sintetica Lopez';
const CEDULA_PLANTA = '1020304050';

beforeEach(() => {
  f.updates = [];
  f.devuelve = { actas: [], recogida: [] };
  logs.lineas = [];
});

describe('AC1 — purga a los 10 años', () => {
  it('anula solo documento_cifrado y documento_ultimos; no toca nombre ni firma', async () => {
    f.devuelve = {
      actas: [{ id: '14113000-0000-4000-8000-00000000000a' }],
      recogida: [{ id: '14113000-0000-4000-8000-00000000000b' }],
    };
    const r = await svc.ejecutarPurgaRetencionLogistica({ ahora: AHORA });
    expect(r).toEqual({ actasPurgadas: 1, recogidaPurgadas: 1 });
    expect(f.updates).toHaveLength(2);
    const tablas = f.updates.map((u) => u.tabla).sort();
    expect(tablas).toEqual(['flito_logistica_acta_firmas', 'flito_logistica_recogida_firmantes']);
    for (const u of f.updates) {
      expect(u.datos).toEqual({ documentoCifrado: null, documentoUltimos: null });
      expect(u.datos).not.toHaveProperty('nombre');
      expect(u.datos).not.toHaveProperty('firmaStorageKey');
    }
  });

  it('el WHERE de ambas tablas es firmado_en <= corte (10 años) y cédula aún presente', async () => {
    await svc.ejecutarPurgaRetencionLogistica({ ahora: AHORA });
    const corte = svc.corteRetencion(AHORA);
    expect(svc.ANIOS_RETENCION).toBe(10);
    expect(corte.toISOString()).toBe('2016-10-07T10:10:00.000Z');
    expect(f.updates).toHaveLength(2);
    for (const u of f.updates) {
      const { sql, params } = render(u.cond);
      expect(sql).toMatch(/"firmado_en" <= \$1/);
      expect(params[0]).toBe(corte.toISOString());
      expect(sql).toMatch(/"documento_cifrado" is not null/);
      expect(sql).toMatch(/"documento_ultimos" is not null/);
      expect(sql).toMatch(/ or /i);
      expect(sql).not.toMatch(/now\(\)|interval/i);
    }
  });
});

describe('AC2 — antes de 10 años no se toca', () => {
  it('predicado puro: exactamente 10 años y 10 años −1 s sí; 10 años +1 s no', () => {
    const corte = svc.corteRetencion(AHORA);
    expect(svc.esPurgable(corte, AHORA)).toBe(true);
    expect(svc.esPurgable(new Date(corte.getTime() - 1000), AHORA)).toBe(true);
    expect(svc.esPurgable(new Date(corte.getTime() + 1000), AHORA)).toBe(false);
  });
});

describe('AC3 — idempotente', () => {
  it('la segunda corrida no cambia nada: 0 filas (el WHERE exige cédula presente)', async () => {
    f.devuelve = {
      actas: [{ id: '14113000-0000-4000-8000-00000000000a' }],
      recogida: [{ id: '14113000-0000-4000-8000-00000000000b' }],
    };
    const r1 = await svc.ejecutarPurgaRetencionLogistica({ ahora: AHORA });
    expect(r1).toEqual({ actasPurgadas: 1, recogidaPurgadas: 1 });
    f.devuelve = { actas: [], recogida: [] };
    const r2 = await svc.ejecutarPurgaRetencionLogistica({ ahora: AHORA });
    expect(r2).toEqual({ actasPurgadas: 0, recogidaPurgadas: 0 });
    const ultimo = f.updates[f.updates.length - 1];
    expect(render(ultimo.cond).sql).toMatch(/"documento_cifrado" is not null/);
  });
});

describe('AC4 — sin PII en logs del servicio', () => {
  it('una corrida no deja cédula ni nombre en el log', async () => {
    f.devuelve = {
      actas: [{ id: '14113000-0000-4000-8000-00000000000a' }],
      recogida: [{ id: '14113000-0000-4000-8000-00000000000b' }],
    };
    await svc.ejecutarPurgaRetencionLogistica({ ahora: AHORA });
    const texto = JSON.stringify(logs.lineas);
    expect(texto).not.toContain(NOMBRE_PLANTA);
    expect(texto).not.toContain(CEDULA_PLANTA);
    expect(texto).not.toMatch(/documento_cifrado|documento_ultimos/);
  });
});

describe('AC5 — política declarada', () => {
  it('docs/privacy/retencion-flito-logistica.md declara 10 años, qué se borra, qué se conserva y Ley 1581', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(path.resolve(dir, '../../../../docs/privacy/retencion-flito-logistica.md'), 'utf8');
    expect(doc).toMatch(/10 años/);
    expect(doc).toMatch(/documento_cifrado/);
    expect(doc).toMatch(/documento_ultimos/);
    expect(doc).toMatch(/nombre/);
    expect(doc).toMatch(/firma_storage_key/);
    expect(doc).toMatch(/Ley 1581/);
    expect(doc).toMatch(/flito_logistica_acta_firmas/);
    expect(doc).toMatch(/flito_logistica_recogida_firmantes/);
    expect(doc).toMatch(/LOGISTICA_RETENCION_CRON_ENABLED/);
    expect(doc).toMatch(/firmado_en/);
  });
});
