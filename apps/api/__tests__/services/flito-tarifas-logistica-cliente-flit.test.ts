// HU #14106 (Feature B #14090) — conceptos `logistica_cliente` y `logistica_flit`, alias `logistica`,
// `vigenciaId` en `ValorTarifa` y migración 0279 (análisis estático; la mitad contra PostgreSQL
// vive en __tests__/db/migracion-0279.test.ts).
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { chain } from '../helpers/db.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { conceptoAlmacenado, esConceptoLogistica, esConceptoTarifa } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { tarifaDe, fijarTarifa, tipoDeLlave, TarifaError } =
  await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');

/** select() que graba el where/orderBy y responde `rows`. */
function grabando(rows: unknown[], sobre: { where?: SQL; orden?: unknown }) {
  const c = chain(rows) as unknown as Record<string, (a: unknown) => unknown>;
  const where = c.where!; const orderBy = c.orderBy!;
  c.where = (a: unknown) => { sobre.where = a as SQL; return where.call(c, a); };
  c.orderBy = (a: unknown) => { sobre.orden = a; return orderBy.call(c, a); };
  return c;
}

beforeEach(() => { selectMock.mockReset(); insertMock.mockReset(); });

describe('shared-types — catálogo de conceptos', () => {
  it('logistica_cliente y logistica_flit son conceptos válidos; logistica persiste como logistica_cliente', () => {
    expect(esConceptoTarifa('logistica_cliente')).toBe(true);
    expect(esConceptoTarifa('logistica_flit')).toBe(true);
    expect(conceptoAlmacenado('logistica')).toBe('logistica_cliente');
    expect(conceptoAlmacenado('logistica_flit')).toBe('logistica_flit');
    expect(conceptoAlmacenado('tramite_digital')).toBe('tramite_digital');
    expect(esConceptoLogistica('logistica_flit')).toBe(true);
    expect(esConceptoLogistica('tramite_digital')).toBe(false);
  });
});

describe('tarifaDe — AC2 entrega a FLIT vacía, AC3 alias, AC4 vigenciaId', () => {
  it('AC2: logistica_flit sin vigencia → sin precio y vigenciaId null', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await tarifaDe(7, 'logistica_flit', null)).toEqual({ valor: null, origen: 'no_configurada', vigenciaId: null });
  });

  it('AC2: logistica_flit consulta SOLO ese concepto (no cae a logistica_cliente)', async () => {
    const s: { where?: SQL } = {};
    selectMock.mockReturnValueOnce(grabando([], s));
    await tarifaDe(7, 'logistica_flit', null);
    const { sql, params } = renderizar(s.where!);
    expect(params).toContain('logistica_flit');
    expect(params).not.toContain('logistica_cliente');
    expect(params).not.toContain('logistica');
    expect(sql).toMatch(/is null/);
  });

  it('AC3: logistica y logistica_cliente consultan {logistica_cliente, logistica} y devuelven el mismo valor', async () => {
    for (const c of ['logistica', 'logistica_cliente'] as const) {
      const s: { where?: SQL } = {};
      selectMock.mockReturnValueOnce(grabando([{ id: 'v-1', valor: '45000' }], s));
      const r = await tarifaDe(7, c, 'Traspaso');
      expect(r).toEqual({ valor: 45000, origen: 'generica', vigenciaId: 'v-1' });
      expect(renderizar(s.where!).params).toEqual(expect.arrayContaining(['logistica_cliente', 'logistica']));
    }
  });

  it('AC3: durante el rollout, logistica_cliente manda sobre una logistica legada (orden)', async () => {
    const s: { where?: SQL; orden?: unknown } = {};
    selectMock.mockReturnValueOnce(grabando([{ id: 'v-1', valor: '1' }], s));
    await tarifaDe(7, 'logistica', null);
    expect(renderizar(s.orden as SQL).sql).toMatch(/"concepto" = 'logistica'\) ASC/);
  });

  it('AC4: trámite digital también devuelve vigenciaId; sin compañía → null', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'v-9', valor: '250000' }]));
    expect(await tarifaDe(7, 'tramite_digital', 'Matricula')).toEqual({ valor: 250000, origen: 'especifica', vigenciaId: 'v-9' });
    expect((await tarifaDe(null, 'logistica_cliente', null)).vigenciaId).toBeNull();
  });

  it('un cero configurado a propósito es precio (no «sin precio») y trae su vigenciaId', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'v-0', valor: '0' }]));
    expect(await tarifaDe(7, 'logistica_flit', null)).toEqual({ valor: 0, origen: 'generica', vigenciaId: 'v-0' });
  });
});

describe('escritura — la llave de logística no lleva tipo y logistica se persiste como logistica_cliente', () => {
  it('tipoDeLlave: los tres conceptos de logística rechazan tipo y devuelven null sin él', () => {
    for (const c of ['logistica', 'logistica_cliente', 'logistica_flit'] as const) {
      expect(tipoDeLlave(c, null)).toBeNull();
      expect(() => tipoDeLlave(c, 'Traspaso')).toThrow(TarifaError);
    }
  });

  it('fijarTarifa(logistica) inserta concepto logistica_cliente', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 7, name: 'ACME', logisticaAutogestionable: true, deletedAt: null }]));
    const grabado: { values?: unknown } = {};
    const ins = chain([{ id: 'nueva' }]) as unknown as Record<string, (a: unknown) => unknown>;
    ins.values = (a: unknown) => { grabado.values = a; return ins; };
    insertMock.mockReturnValueOnce(ins);
    selectMock.mockReturnValueOnce(chain([{
      id: 'nueva', companiaId: 7, companiaNombre: 'ACME', concepto: 'logistica_cliente', tipoTramite: null,
      valor: '100', vigenteDesde: new Date(), vigenteHasta: null, fijadoEn: new Date(),
    }]));
    const t = await fijarTarifa({ companiaId: 7, concepto: 'logistica', valor: 100 }, 1);
    expect(grabado.values).toMatchObject({ concepto: 'logistica_cliente', tipoTramite: null });
    expect(t.concepto).toBe('logistica'); // hacia fuera la UI actual sigue viendo `logistica` hasta B2 #14107
  });
});

describe('0279 — reglas del archivo (estático)', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
  const ARCHIVO = '0279_flito_tarifas_logistica_cliente_flit.sql';
  const SQL_0275 = readFileSync(path.join(dir, ARCHIVO), 'utf8');
  const limpio = SQL_0275.replace(/--[^\n]*/g, '');

  it('sin control de transacción, DO etiquetado, CHECK idempotentes (DROP IF EXISTS antes de ADD)', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0275)).toEqual([]);
    expect(limpio).toMatch(/DO \$logisticacliente0279\$/);
    expect(limpio).not.toMatch(/\$\$/);
    expect(limpio.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(2);
    expect(limpio).toMatch(/concepto IN \('tramite_digital', 'logistica', 'logistica_cliente', 'logistica_flit'\)/);
  });

  it('mueve logistica → logistica_cliente sin tocar valores, rangos ni ids, y omite solapes (no duplica)', () => {
    expect(limpio.match(/UPDATE flito_tarifas_vigencias/g)).toHaveLength(1);
    expect(limpio).toMatch(/SET concepto = 'logistica_cliente'/);
    expect(limpio).not.toMatch(/SET[^;]*(valor|vigente_desde|vigente_hasta)\s*=/);
    expect(limpio).toMatch(/NOT EXISTS/);
    expect(limpio).not.toMatch(/INSERT INTO flito_tarifas_vigencias/);
  });
});
