// HU #13426 (Feature #12871) — Derechos de tránsito abierto a `organismos_transito`: AC3, AC4, AC6, AC7.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura>, cargar: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  firmarDescargaEntidad: vi.fn(() => 'https://firmada'), uploadEntityDocument: vi.fn(), deleteEntityDocument: vi.fn(),
  getEntityDocumentStream: vi.fn(), presignedGetEntityDocument: vi.fn(),
}));
await import('../../src/db/client.js');

const FUNCIONES = ['derechos.cola.ver', 'derechos.cola.filtrar', 'derechos.recibos.cargar', 'derechos.candidatos.ver',
  'derechos.drive.listar', 'derechos.drive.ver_registro', 'derechos.drive.procesar', 'derechos.soporte.descargar'];
const S1 = '05001';
const S2 = '11001';
const SOPORTE = '00000000-0000-0000-0000-0000000000d4';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-derechos/flito-derechos.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/derechos', conAlcance('derechos', router));
  a.use(errorHandler);
  return a;
}
let sub = 8300;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;
const puente = () => h.cap.responder([{ c: S1 }, { c: S2 }]);
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('flito_gestor_organismos'));

beforeEach(() => { h.cap.reset(); });

describe('AC6 — organismos: listado, COUNT y facetas solo de SUS secretarías', () => {
  it('GET / → `organismo_codigo in (S1, S2)` en el COUNT y en la página', async () => {
    puente();
    h.cap.responder([], [{ total: 0 }]); // la consulta base se arma ANTES que el COUNT
    const r = await request(await app()).get('/api/flito/derechos').set('Authorization', await como('organismos_transito'));
    expect(r.status).toBe(200);
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) {
      expect(x.sql).toMatch(/"flito_derechos_tramite"\."organismo_codigo" in \(\$\d+, \$\d+\)/);
      expect(x.params).toEqual(expect.arrayContaining([S1, S2]));
    }
  });

  it('AC7 — facetas acotadas (las dos consultas)', async () => {
    puente();
    const r = await request(await app()).get('/api/flito/derechos/facetas').set('Authorization', await como('organismos_transito'));
    expect(r.status).toBe(200);
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.params).toEqual([S1, S2]);
  });

  it('AC2 — el soporte de un derecho de OTRA secretaría → 404, igual que inexistente; no se firma URL', async () => {
    puente();
    h.cap.responder([]); // no aparece con la condición de sus secretarías
    const r = await request(await app()).get(`/api/flito/derechos/soporte/${SOPORTE}`).set('Authorization', await como('organismos_transito'));
    expect([r.status, r.body]).toEqual([404, { error: 'El soporte no existe' }]);
  });

  it('AC1 — sin enlace: el listado no lleva condición de organismo', async () => {
    h.cap.responder([], [{ total: 0 }]);
    const r = await request(await app()).get('/api/flito/derechos').set('Authorization', await como('ninguno', 'mensajero'));
    expect(r.status).toBe(200);
    expect(wheres()).toHaveLength(0); // sin filtros ni alcance: `where(undefined)`
    for (const x of wheres()) expect(x.sql).not.toContain('organismo_codigo" in');
  });
});

describe('AC3 — carga con enlace: la secretaría es obligatoria y tiene que ser suya', () => {
  it.each([[null, 'sin secretaría'], ['08001', 'secretaría ajena']])('organismoCodigo=%s (%s) → 403 antes de procesar ni subir nada', async (org) => {
    puente();
    let req = request(await app()).post('/api/flito/derechos/cargar').set('Authorization', await como('organismos_transito'));
    if (org) req = req.field('organismoCodigo', org);
    const r = await req.attach('archivos', Buffer.from('%PDF-1.4'), { filename: 'r.pdf', contentType: 'application/pdf' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
    // Solo se leyó el alcance (la puente): nada de OCR, cruce ni storage.
    expect(h.cap.consultas).toHaveLength(1);
  });
});

describe('AC4 / P-2 — integración Drive y búsqueda por placa cerradas a todo enlace', () => {
  it.each([
    ['get', '/drive/archivos'], ['get', '/drive/registro'], ['post', '/drive/procesar'], ['get', '/candidatos/ABC123'],
  ] as const)('%s %s → 403 de la frontera, sin consultar', async (metodo, ruta) => {
    const r = await request(await app())[metodo](`/api/flito/derechos${ruta}`).set('Authorization', await como('organismos_transito')).send({});
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });

  it('compañía → Derechos cerrado (403 de la frontera)', async () => {
    const r = await request(await app()).get('/api/flito/derechos').set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});
