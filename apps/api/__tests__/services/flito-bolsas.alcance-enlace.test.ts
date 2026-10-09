// HU #13426 (Feature #12871) — Bolsas abierta a `compania`: AC2 (solo la bolsa de C, agregados
// incluidos), AC3 (escritura ajena 403 ANTES de multer: sin archivo huérfano) y AC4 (tránsito cerrado).
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({
  cap: null as unknown as ReturnType<typeof crearCaptura>,
  subir: vi.fn(), borrar: vi.fn(),
}));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: h.subir, deleteEntityDocument: h.borrar, firmarDescargaEntidad: vi.fn(() => 'https://firmada'),
  getEntityDocumentStream: vi.fn(), presignedGetEntityDocument: vi.fn(),
}));
await import('../../src/db/client.js');

const FUNCIONES = ['bolsas.consolidado.ver', 'bolsas.riesgo.ver', 'bolsas.alertas.ver', 'bolsas.bolsa.ver',
  'bolsas.movimientos.ver', 'bolsas.recarga.registrar', 'bolsas.soporte.descargar', 'bolsas.transito.listar',
  'bolsas.transito.ver', 'bolsas.movimiento.registrar', 'bolsas.movimiento.corregir'];
const C = 42;
const OTRA = 43;

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-bolsas/flito-bolsas.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/bolsas', conAlcance('bolsas', router));
  a.use(errorHandler);
  return a;
}
let sub = 8400;
const como = async (tipoEnlace: string, role = 'xyz_renombrado') =>
  `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: FUNCIONES })}`;
const deC = () => h.cap.responder([{ c: C, p: null }]);
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"'));

beforeEach(() => { h.cap.reset(); h.subir.mockReset(); h.borrar.mockReset(); });

describe('AC2 — solo la bolsa de C', () => {
  it('GET /:otra → 404 (igual que un cliente sin bolsa), sin leer la bolsa', async () => {
    deC();
    const r = await request(await app()).get(`/api/flito/bolsas/${OTRA}`).set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([404, { error: 'El cliente aún no tiene bolsa' }]);
    expect(h.cap.consultas).toHaveLength(1); // solo la lectura del alcance
  });

  it('GET /consolidado → el agregado cuenta SOLO la bolsa de C (`compania_id = C`)', async () => {
    deC();
    h.cap.responder([{ clientes: 1, saldoTotal: '10' }]);
    const r = await request(await app()).get('/api/flito/bolsas/consolidado').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(wheres()).toEqual([{ sql: '"flito_bolsas"."compania_id" = $1', params: [C] }]);
  });

  it('GET /alertas → saldo y conciliación de C; las alertas internas de FLIT no se consultan', async () => {
    deC();
    const r = await request(await app()).get('/api/flito/bolsas/alertas').set('Authorization', await como('compania'));
    expect(r.status).toBe(200);
    expect(r.body.conciliacion).toMatchObject({ soportesSinTramite: 0, boletasSinComprobante: 0 });
    const w = wheres();
    expect(w.length).toBeGreaterThanOrEqual(2);
    for (const x of w) expect(x.params).toContain(C);
  });

  it('GET /soportes/:id → solo un soporte del libro de C (el de tránsito no entra)', async () => {
    deC();
    h.cap.responder([]);
    const r = await request(await app()).get('/api/flito/bolsas/soportes/00000000-0000-0000-0000-0000000000e5')
      .set('Authorization', await como('compania'));
    expect(r.status).toBe(404);
    // El `exists` es una subconsulta: su WHERE se captura aparte. Una de ellas acota el libro a C, y
    // ninguna mira el libro de tránsito.
    const w = wheres();
    const delLibro = w.find((x) => x.sql.includes('"flito_bolsa_movimientos"."compania_id" = $'));
    expect(delLibro?.params).toContain(C);
    expect(w.some((x) => x.sql.includes('flito_bolsa_transito_movimientos'))).toBe(false);
  });

  it('AC1 — sin enlace: el consolidado es global (sin condición)', async () => {
    h.cap.responder([{ clientes: 3, saldoTotal: '30' }]);
    const r = await request(await app()).get('/api/flito/bolsas/consolidado').set('Authorization', await como('ninguno', 'mensajero'));
    expect(r.body).toEqual({ clientes: 3, saldoTotal: 30 });
    expect(wheres()).toEqual([]);
  });
});

describe('AC3 — escritura ajena: 403 ANTES de multer (riesgo §7.2)', () => {
  it.each(['recargas', 'movimientos-manuales'])('POST /:otra/%s con archivo → 403; nada se sube ni se escribe', async (ruta) => {
    deC();
    const r = await request(await app()).post(`/api/flito/bolsas/${OTRA}/${ruta}`).set('Authorization', await como('compania'))
      .set('Idempotency-Key', 'k-1').field('valor', '1000')
      .attach('soporte', Buffer.from('%PDF-1.4'), { filename: 's.pdf', contentType: 'application/pdf' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.subir).not.toHaveBeenCalled();
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
  });
});

describe('AC3 — corregir un movimiento de OTRO libro bajo el path propio → 403', () => {
  it('el movimiento se busca con `compania_id = C` en el WHERE; si no aparece, 403 y no se escribe', async () => {
    deC();
    h.cap.responder([]);
    const r = await request(await app()).post(`/api/flito/bolsas/${C}/movimientos/00000000-0000-0000-0000-0000000000aa/correccion`)
      .set('Authorization', await como('compania')).send({ valor: 10, motivo: 'corrección de prueba' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(wheres()[0]!.sql).toContain('"flito_bolsa_movimientos"."compania_id" = $');
    expect(wheres()[0]!.params).toContain(C);
    expect(h.cap.consultas.filter((c) => c.tipo !== 'select')).toEqual([]);
  });
});

describe('AC4 — las bolsas de tránsito (de FLIT, por secretaría) cerradas a todo enlace', () => {
  it.each(['/transito', '/transito/00000000-0000-0000-0000-0000000000f6'])('GET %s → 403, sin consultar', async (ruta) => {
    const r = await request(await app()).get(`/api/flito/bolsas${ruta}`).set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });
});

describe('Habeas Data (bloqueante de security) — la compañía no recibe nombres de empleados de FLIT', () => {
  const VER = [...FUNCIONES, 'bolsas.cierres.ver'];
  const conVer = async (tipoEnlace: string, role = 'xyz_renombrado') =>
    `Bearer ${await testToken({ sub: ++sub, role: role as never, tipoEnlace, funciones: VER })}`;
  const EN = new Date('2026-10-01T00:00:00Z');
  const MOV = { m: { id: 'm1', companiaId: C, tipo: 'entrada', origen: 'recarga', concepto: null, organismoCodigo: null, tramiteId: null, valor: '10', saldoResultante: '10', periodo: '2026-10', fecha: '2026-10-01', observacion: null, soporteId: null, registradoPorNombre: 'Ana Interna', createdAt: EN }, idFlit: null };
  const CIERRE = { id: 'k1', companiaId: C, periodo: '2026-09', saldoInicial: '0', totalEntradas: '10', totalSalidas: '0', saldoFinal: '10', movimientos: 1, observaciones: null, cerradoPorNombre: 'Beto Interno', cerradoEn: EN };

  it('compañía: movimientos y cierres sin el nombre de quien los registró (`\'\'`, el vacío del contrato)', async () => {
    deC();
    h.cap.responder([MOV]);
    const m = await request(await app()).get(`/api/flito/bolsas/${C}/movimientos`).set('Authorization', await conVer('compania'));
    expect(m.status).toBe(200);
    expect(m.body).toEqual([expect.objectContaining({ id: 'm1', registradoPorNombre: '' })]);
    h.cap.reset();
    deC();
    h.cap.responder([CIERRE]);
    const c = await request(await app()).get(`/api/flito/bolsas/${C}/cierres`).set('Authorization', await conVer('compania'));
    expect(c.status).toBe(200);
    expect(c.body).toEqual([expect.objectContaining({ id: 'k1', cerradoPorNombre: '' })]);
    expect(JSON.stringify([m.body, c.body])).not.toMatch(/Ana Interna|Beto Interno/);
  });

  it('sin enlace: movimientos y cierres nombran a quien los registró', async () => {
    h.cap.responder([MOV]);
    const m = await request(await app()).get(`/api/flito/bolsas/${C}/movimientos`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(m.body[0].registradoPorNombre).toBe('Ana Interna');
    h.cap.responder([CIERRE]);
    const c = await request(await app()).get(`/api/flito/bolsas/${C}/cierres`).set('Authorization', await conVer('ninguno', 'admin'));
    expect(c.body[0].cerradoPorNombre).toBe('Beto Interno');
  });
});
