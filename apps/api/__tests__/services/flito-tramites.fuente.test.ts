// HU #13070 — fuente del trámite (FLIT / FLIT 2) en el listado de Gestión Trámites.
//
// AC4: la fila entrega `fuente`. AC5: `fuente=flit2` filtra la página Y el conteo. AC6: sin fuente o
// con un valor desconocido no se filtra ni falla. AC7: se combina con estado, empresa y fechas.
//
// El helper `chain()` descarta los argumentos de `.where()` y devuelve la fila entera aunque el
// select pida menos columnas, así que un aserto sobre la fila del mock no prueba el filtro. Aquí el
// `select` es un espía que GUARDA cada `.where()`, y se renderiza el SQL con el dialecto de Postgres:
// lo que se asierta es la condición que de verdad llegaría a la base.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';

const wheres: (SQL | undefined)[] = [];
let respuestas: unknown[][] = [];

/** Chain thenable que registra el argumento de `.where()` y resuelve a la siguiente respuesta. */
function espia() {
  const filas = respuestas.shift() ?? [];
  const t: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'groupBy']) t[m] = () => t;
  t.where = (c: SQL | undefined) => { wheres.push(c); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej);
  return t;
}

const selectMock = vi.fn(() => espia());
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));

const { listar } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');
const { default: tramitesRoutes } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
const { FUENTES_TRAMITE, ETIQUETA_FUENTE_TRAMITE, esFuenteTramite } = await import('@operaciones/shared-types');

const dialecto = new PgDialect();
const render = (c: SQL | undefined) => (c ? dialecto.sqlToQuery(c) : { sql: '', params: [] as unknown[] });
/** [conteo, página]: las dos consultas del listado que llevan los filtros. */
const condicionesLeidas = () => [render(wheres[0]), render(wheres[1])];
const COND_FUENTE = '"flito_tramites"."fuente" = $';

function filaCruda(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', fuente: 'flit2', estadoTramite: null, placa: 'QTQ100', companiaNombre: 'ACME',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaDocEstado: null, soatEstado: null, soatValorPagado: null, soatExtraccion: null,
    impuestoEstado: null, impuestoValorPagado: null, impuestoMarcadoPorDiferencia: false, impuestoExtraccion: null,
    flitEstado: 'Asignado', tipoTramite: 'Traspaso', ciudad: 'FUNZA', companiaId: 7, companiaNit: '900',
    transitoNombreFlit: 'STRIA FUNZA', facturaVentaFlitId: null, fechaAprobacion: null,
    fechaCreacionFlit: null, creadoEn: new Date('2026-07-01T00:00:00Z'),
    sincronizadoEn: new Date('2026-07-20T00:00:00Z'), organismoAlias: 'Funza', organismoCodigo: '25286',
    vin: 'VIN123', marca: 'Renault', linea: 'Logan', tipoVehiculo: 'automovil',
    soatId: null, soatProveedorId: null, soatProveedorNombre: null, soatSlaHoras: null,
    soatEnviadoEn: null, soatPagadoEn: null, soatMotivoRechazo: null,
    impuestoId: null, impuestoExtraccionFacturaVenta: null, impuestoValorLiquidado: null,
    impuestoEnviadoEn: null, impuestoPagadoEn: null, impuestoSlaHoras: null, impuestoMotivoRechazo: null,
    ...over,
  };
}

beforeEach(() => {
  wheres.length = 0;
  selectMock.mockClear();
  // count, página, compradores, excepciones de autogestión.
  respuestas = [[{ total: 1 }], [filaCruda()], [], []];
});

describe('HU #13070 · vocabulario compartido de la fuente', () => {
  it('las dos fuentes son flit y flit2, con sus etiquetas, y la guarda rechaza lo demás', () => {
    expect([...FUENTES_TRAMITE]).toEqual(['flit', 'flit2']);
    expect(ETIQUETA_FUENTE_TRAMITE).toEqual({ flit: 'FLIT', flit2: 'FLIT 2' });
    expect(esFuenteTramite('flit2')).toBe(true);
    for (const v of ['FLIT2', 'otra', '', undefined, 2, ['flit']]) expect(esFuenteTramite(v)).toBe(false);
  });
});

describe('HU #13070 · listar — la fuente en la fila y en el filtro', () => {
  it('AC4: la fila del listado entrega la fuente del trámite', async () => {
    const { items: [f] } = await listar();
    expect(f.fuente).toBe('flit2');
  });

  it('AC4: la proyección de la página SELECCIONA la columna fuente (no es la fila del mock)', async () => {
    await listar();
    // El segundo select es la proyección de la página; su objeto de columnas lleva `fuente`.
    const columnas = (selectMock.mock.calls[1] as unknown[])[0] as Record<string, { name?: string }>;
    expect(columnas.fuente?.name).toBe('fuente');
  });

  it('AC5: fuente=flit2 filtra la página Y el conteo (total y paginación del filtro)', async () => {
    await listar({ fuente: 'flit2' });
    const [conteo, pagina] = condicionesLeidas();
    for (const q of [conteo, pagina]) {
      expect(q.sql).toContain(COND_FUENTE);
      expect(q.params).toContain('flit2');
    }
  });

  it('AC6: sin fuente no se filtra por fuente', async () => {
    await listar({});
    for (const q of condicionesLeidas()) expect(q.sql).not.toContain('"fuente"');
  });

  it('AC7: la fuente se combina con estado, empresa y fechas (todas en el mismo WHERE)', async () => {
    await listar({
      fuente: 'flit', estados: ['Asignado'], empresas: ['900123'],
      creadoDesde: '2026-07-01', aprobadoHasta: '2026-07-31',
    });
    const [conteo, pagina] = condicionesLeidas();
    for (const q of [conteo, pagina]) {
      expect(q.sql).toContain(COND_FUENTE);
      expect(q.sql).toContain('"flito_tramites"."flit_estado" in');
      expect(q.sql).toContain('"flito_tramites"."compania_nit" in');
      expect(q.sql).toContain('"flito_tramites"."fecha_creacion_flit"');
      expect(q.sql).toContain('"flito_tramites"."fecha_aprobacion"');
      expect(q.sql).toMatch(/ and /);
      expect(q.params).toEqual(expect.arrayContaining(['flit', 'Asignado', '900123', '2026-07-01', '2026-07-31']));
    }
  });
});

describe('HU #13070 · GET /api/flito/tramites — parseo del query fuente', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/tramites', tramitesRoutes);

  it('AC4+AC5: ?fuente=flit2 responde 200, filtra la consulta y la fila trae su fuente', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/tramites?fuente=flit2').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].fuente).toBe('flit2');
    const [conteo, pagina] = condicionesLeidas();
    expect(conteo.sql).toContain(COND_FUENTE);
    expect(pagina.sql).toContain(COND_FUENTE);
  });

  it('AC6: un valor desconocido de fuente se ignora — 200 y sin condición de fuente', async () => {
    const token = await testToken({ role: 'admin' });
    for (const v of ['otra', 'FLIT2', '']) {
      wheres.length = 0;
      respuestas = [[{ total: 1 }], [filaCruda()], [], []];
      // Con otro filtro activo el WHERE no está vacío: la ausencia de la fuente no es un verde vacío.
      const res = await request(app).get(`/api/flito/tramites?fuente=${v}&estados=Asignado`).set('Authorization', `Bearer ${token}`);
      expect(res.status, `fuente=${v}`).toBe(200);
      for (const q of condicionesLeidas()) {
        expect(q.sql, `fuente=${v}`).toContain('"flito_tramites"."flit_estado" in');
        expect(q.sql, `fuente=${v}`).not.toContain('"fuente"');
      }
    }
  });

  it('AC6: sin fuente en el query tampoco se filtra', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).get('/api/flito/tramites').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const q of condicionesLeidas()) expect(q.sql).not.toContain('"fuente"');
  });
});
