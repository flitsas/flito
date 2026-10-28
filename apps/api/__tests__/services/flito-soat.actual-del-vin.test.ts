// Feature #14012 · HU #14016 (ADR-0031) — «el SOAT actual de un vehículo» tiene UNA definición.
//
// Cubre: el helper `soatActualDelVin` (abierto primero), el contexto «ya en FLITO» (frontera de 30
// días, abierto nunca renovable), el guard de `reversar` (AC8), el censo con DISTINCT ON (AC9) y que
// los cuatro llamadores no vuelvan a leer `where vin = ? limit 1` a pelo.
//
// Mutantes que esto mata: `soatEstaAbierto` invertido; el lookup sin preferir el abierto; el censo sin
// DISTINCT ON (dos consultas al RUNT por vehículo); quitar el guard de `reversar` (23505 crudo).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar } from '../helpers/sql-ligado.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { soatActualDelVin, hayOtroAbiertoAlReabrir, ORDEN_SOAT_ACTUAL } =
  await import('../../src/modules/flito-soat/flito-soat-actual.js');
const { contextoFlito, contextoSinFlito, diasEntre } =
  await import('../../src/modules/flito-soat/flito-soat-contexto.js');
const { condicionCenso, corteDelDia } = await import('../../src/modules/flito-soat/flito-soat-vigencia.service.js');
const svc = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { ESTADOS_SOAT_TERMINALES, soatEstaAbierto, EstadoSoat } = await import('@operaciones/shared-types');
const { db } = await import('../../src/db/client.js');

let espia: ReturnType<typeof crearEspia>;
beforeEach(() => { kdb.reset(); espia = crearEspia(kdb); });

describe('shared-types — terminal = SOLO `pagado`', () => {
  it('`pagado` es el único terminal; pendiente, solicitado y con_novedad están abiertos', () => {
    expect(ESTADOS_SOAT_TERMINALES).toEqual(['pagado']);
    expect(soatEstaAbierto('pagado')).toBe(false);
    for (const e of ['pendiente', 'solicitado', 'con_novedad'] as const) expect(soatEstaAbierto(e)).toBe(true);
  });
});

describe('contextoFlito — días de vigencia y renovable', () => {
  const HOY = '2026-09-09';
  const pagado = (venceEl: string | null) => ({ id: 'x', estado: EstadoSoat.PAGADO, venceEl });

  it('diasEntre cuenta días corridos con signo', () => {
    expect(diasEntre(HOY, '2026-10-09')).toBe(30);
    expect(diasEntre(HOY, '2026-09-04')).toBe(-5);
  });

  it('frontera inclusiva: 30 días es renovable, 31 no', () => {
    expect(contextoFlito(pagado('2026-10-09'), HOY)).toMatchObject({ diasVigencia: 30, renovable: true });
    expect(contextoFlito(pagado('2026-10-10'), HOY)).toMatchObject({ diasVigencia: 31, renovable: false });
  });

  it('vencido es renovable y la fecha del RUNT manda sobre la de flito_soat', () => {
    expect(contextoFlito(pagado('2026-09-01'), HOY)).toMatchObject({ diasVigencia: -8, fuenteVigencia: 'flito', renovable: true });
    expect(contextoFlito(pagado('2026-09-01'), HOY, '2026-12-31')).toMatchObject({ fuenteVigencia: 'runt', renovable: false });
  });

  it('un abierto NUNCA es renovable y expone su estado; sin fecha tampoco', () => {
    const c = contextoFlito({ id: 'x', estado: EstadoSoat.CON_NOVEDAD, venceEl: '2026-09-01' }, HOY);
    expect(c).toMatchObject({ abierto: true, estadoAbierto: 'con_novedad', renovable: false });
    expect(contextoFlito(pagado(null), HOY)).toMatchObject({ diasVigencia: null, fuenteVigencia: null, renovable: false });
  });

  it('sin SOAT en FLITO: yaEnFlito false', () => {
    expect(contextoSinFlito(HOY, null)).toMatchObject({ yaEnFlito: false, abierto: false, soatId: null });
  });
});

describe('soatActualDelVin', () => {
  it('devuelve la fila del lookup y null si no hay', async () => {
    const fila = { id: 'a', estado: 'pendiente', companiaId: 1, venceEl: null, createdAt: new Date() };
    kdb.when.select('flito_soat', [fila]);
    expect(await soatActualDelVin(db, 'VIN')).toMatchObject({ id: 'a', estado: 'pendiente' });
    kdb.reset();
    kdb.when.select('flito_soat', []);
    expect(await soatActualDelVin(db, 'VIN')).toBeNull();
  });

  it('el orden prefiere el ABIERTO y luego el más reciente', () => {
    const [abierto, creado, id] = ORDEN_SOAT_ACTUAL.map((o) => renderizar(o).sql);
    expect(abierto).toContain(`<> 'pagado'`);
    expect(abierto.toLowerCase()).toContain('desc');
    expect(creado).toContain('created_at');
    expect(id).toContain('"id"');
  });
});

describe('AC8 — reversar un `pagado` con otro abierto del mismo vehículo', () => {
  const SOAT_ID = '50a70000-0000-4000-8000-00000000dd01';
  const fila = { id: SOAT_ID, companiaId: 7, proveedorSoatId: null, gestionOperaciones: false, estado: 'pagado' };
  const ctxAdmin = {
    userId: 1, username: 'a', role: 'admin', proyeccionCliente: false, alcance: 'todo', proveedorSoatId: null, companiaId: null,
  } as Parameters<typeof svc.reversar>[3];

  it('hayOtroAbiertoAlReabrir: true con otro abierto; false sin él; false hacia `pagado` sin consultar', async () => {
    kdb.when.select('flito_soat', [{ id: 'otro' }]);
    expect(await hayOtroAbiertoAlReabrir(db, SOAT_ID, 'pendiente')).toBe(true);
    kdb.reset();
    kdb.when.select('flito_soat', []);
    expect(await hayOtroAbiertoAlReabrir(db, SOAT_ID, 'con_novedad')).toBe(false);
    expect(await hayOtroAbiertoAlReabrir(db, SOAT_ID, 'pagado')).toBe(false);
  });

  it('con otro abierto: 409 y CERO UPDATE', async () => {
    kdb.when.selectOnce('flito_soat', [fila]).select('flito_soat', [{ id: 'otro-abierto' }])
      .update('flito_soat', [fila]);
    await expect(svc.reversar(SOAT_ID, 'pendiente', 'error de carga', ctxAdmin))
      .rejects.toMatchObject({ status: 409 });
    expect(espia.updatesEn('flito_soat')).toHaveLength(0);
  });

  it('sin otro abierto: funciona como hoy (un UPDATE)', async () => {
    kdb.when.selectOnce('flito_soat', [fila]).select('flito_soat', [])
      .update('flito_soat', [{ ...fila, estado: 'pendiente' }]);
    await expect(svc.reversar(SOAT_ID, 'pendiente', 'error de carga', ctxAdmin)).resolves.toBeTruthy();
    expect(espia.updatesEn('flito_soat')).toHaveLength(1);
  });
});

describe('AC9 — el censo consulta UNA vez por vehículo (fila actual)', () => {
  it('el predicado lleva DISTINCT ON (vehiculo_id) con el abierto primero, sin dejar de exigir comprobante', () => {
    const q = renderizar(condicionCenso(corteDelDia('2026-09-09'))).sql;
    expect(q).toContain('DISTINCT ON (vehiculo_id)');
    expect(q).toContain(`ORDER BY vehiculo_id, (estado <> 'pagado') DESC, created_at DESC, id DESC`);
    expect(q.toLowerCase()).toContain('exists');
  });
});

describe('los llamadores usan el helper y no `where vin … limit(1)` a pelo', () => {
  const leer = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/modules/${rel}`, import.meta.url)), 'utf8');
  const A_PELO = /from\(flitoSoat\)\.where\(eq\(flitoSoat\.vin,[^)]*\)\)\.limit\(1\)/;

  it.each([
    'flito-soat/flito-soat-cliente.service.ts',
    'flito-soat/flito-soat-incompletas-reintento.service.ts',
    'flito-sync/flito-sync.service.ts',
    'flito-excepciones/flito-excepciones.service.ts',
  ])('%s', (rel) => {
    const src = leer(rel);
    expect(src).toContain('soatActualDelVin');
    expect(src).not.toMatch(A_PELO);
  });
});
