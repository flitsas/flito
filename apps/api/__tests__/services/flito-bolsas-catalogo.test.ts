// HU #13900 (Feature #13886, ADR-0029) — catálogo de la bolsa de COMPAÑÍA por HTTP contra PostgreSQL de verdad:
// crear, editar, inactivar, reactivar, buscar por body, detalle, estado (con autogestión, AC11), frontera por
// enlace y recarga bloqueada sobre una bolsa inactiva.
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Las filas que crea (compañías y sus bolsas) se borran en `afterAll`. Lo que NO es de la base va mockeado:
// auditoría, redis, almacenamiento y la resolución del enlace (`alcanceDe`), que en producción lee la base de
// usuarios y aquí la fija cada caso.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';

const URL = process.env.TEST_DATABASE_URL;
const h = vi.hoisted(() => {
  // El cliente drizzle lee DATABASE_URL al importarse; `setup.ts` la deja en un valor ficticio.
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  return {
    alcance: { enlace: 'ninguno' } as { enlace: 'ninguno' } | { enlace: 'compania'; companiaId: number | null },
    subir: vi.fn(),
  };
});

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: h.subir, deleteEntityDocument: vi.fn(), firmarDescargaEntidad: vi.fn(() => 'https://firmada'),
  getEntityDocumentStream: vi.fn(), presignedGetEntityDocument: vi.fn(),
}));
vi.mock('../../src/shared/middleware/frontera-enlace.js', async (original) => ({
  ...(await original<typeof import('../../src/shared/middleware/frontera-enlace.js')>()),
  alcanceDe: vi.fn(async () => h.alcance),
}));

const FUNCIONES = [
  'bolsas.bolsa.listar', 'bolsas.bolsa.crear', 'bolsas.bolsa.ver', 'bolsas.bolsa.editar', 'bolsas.bolsa.inactivar',
  'bolsas.movimientos.ver', 'bolsas.recarga.registrar', 'bolsas.cierres.ver',
];
const USUARIO = 'hu13900@flit.io';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!URL)('HU #13900 — catálogo de la bolsa de compañía (PostgreSQL real)', () => {
  let app: express.Express;
  let sql: import('postgres').Sql;
  let auth: string;
  let authSinCrear: string;
  const companias: number[] = [];
  let A: number; let B: number; let SIN: number; let AUTO: number;

  async function nuevaCompania(nombre: string, autogestion: { soat?: boolean } = {}): Promise<number> {
    const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable)
      VALUES (${`HU13900 ${nombre} ${Date.now()}`}, ${`9${String(Date.now()).slice(-8)}${companias.length}`}, ${autogestion.soat ?? false})
      RETURNING id`;
    companias.push(c!.id as number);
    return c!.id as number;
  }
  const crear = (body: unknown, a = auth) => request(app).post('/api/flito/bolsas').set('Authorization', a).send(body as object);
  async function eventos(bolsaId: string) {
    return sql`SELECT accion, motivo, snapshot, usuario_nombre FROM flito_bolsas_unicas_eventos WHERE bolsa_id = ${bolsaId} ORDER BY created_at, accion`;
  }

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    // `creada_por_id`, `usuario_id`… son FK a users: el sub del token tiene que existir.
    auth = `Bearer ${await testToken({ sub: u!.id as number, role: 'xyz_renombrado' as never, username: USUARIO, funciones: FUNCIONES })}`;
    authSinCrear = `Bearer ${await testToken({ sub: 913900, role: 'xyz_renombrado' as never, funciones: FUNCIONES.filter((f) => f !== 'bolsas.bolsa.crear') })}`;
    A = await nuevaCompania('Alfa');
    B = await nuevaCompania('Beta');
    SIN = await nuevaCompania('Sin bolsa');
    AUTO = await nuevaCompania('Autogestiona SOAT', { soat: true });
    const a = express();
    a.use(express.json());
    const { default: router } = await import('../../src/modules/flito-bolsas/flito-bolsas.routes.js');
    const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
    a.use('/api/flito/bolsas', router);
    a.use(errorHandler);
    app = a;
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = companias;
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    await sql`DELETE FROM clients WHERE id IN ${sql(ids)}`;
    await sql.end();
  });

  beforeEach(() => { h.alcance = { enlace: 'ninguno' }; h.subir.mockReset(); });

  let bolsaA: string;
  let bolsaB: string;

  it('AC1 · crear → 201 activa, saldo 0, esos conceptos, y evento «crear» con el usuario', async () => {
    const r = await crear({ alcance: 'compania', companiaId: A, conceptos: ['soat', 'impuesto'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      alcance: 'compania', companiaId: A, activa: true, saldo: 0, conceptos: ['impuesto', 'soat'], cobertura: [],
      inactivadaEn: null, motivoInactivacion: null, conceptosAutogestionados: [],
    });
    expect(r.body.companiaNombre).toMatch(/^HU13900 Alfa/);
    bolsaA = r.body.id;
    const ev = await eventos(bolsaA);
    expect(ev.map((e) => [e.accion, e.usuario_nombre])).toEqual([['crear', USUARIO]]);
    expect(ev[0]!.snapshot).toEqual({ alcance: 'compania', companiaId: A, conceptos: ['impuesto', 'soat'] });

    const rb = await crear({ alcance: 'compania', companiaId: B, conceptos: ['soat'] });
    expect(rb.status).toBe(201);
    bolsaB = rb.body.id;
  });

  it('AC2 · la compañía ya tiene bolsa → 409 `bolsa_compania_existe` con {bolsaId, activa}; no se crea nada', async () => {
    const r = await crear({ alcance: 'compania', companiaId: A, conceptos: ['derecho'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'bolsa_compania_existe', bolsaId: bolsaA, activa: true });
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id = ${A}`;
    expect(n!.n).toBe(1);
  });

  it.each([
    ['sin conceptos', { alcance: 'compania', conceptos: [] }],
    ['conceptos ausentes', { alcance: 'compania' }],
    ['con GMF', { alcance: 'compania', conceptos: ['soat', 'gmf'] }],
    ['concepto desconocido', { alcance: 'compania', conceptos: ['peaje'] }],
  ])('AC3 · %s → 400 `datos_invalidos`', async (_c, body) => {
    const r = await crear({ ...body, companiaId: SIN });
    expect([r.status, r.body.codigo]).toEqual([400, 'datos_invalidos']);
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE compania_id = ${SIN}`;
    expect(n!.n).toBe(0);
  });

  it('AC3 · compañía inexistente → 404; alcance tránsito (HU-G) → 400 con mensaje claro', async () => {
    expect((await crear({ alcance: 'compania', companiaId: 2_147_000_000, conceptos: ['soat'] })).status).toBe(404);
    const t = await crear({ alcance: 'transito', nombre: 'X', organismos: ['05001'], conceptos: ['derecho'] });
    expect([t.status, t.body.codigo]).toEqual([400, 'datos_invalidos']);
    expect(t.body.error).toMatch(/tránsito/);
  });

  it('AC4 · PATCH de conceptos no cambia compañía ni alcance y deja «editar» con el antes y el después', async () => {
    const r = await request(app).patch(`/api/flito/bolsas/bolsa/${bolsaB}`).set('Authorization', auth)
      .send({ conceptos: ['soat', 'derecho'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: bolsaB, alcance: 'compania', companiaId: B, conceptos: ['derecho', 'soat'] });
    const ev = (await eventos(bolsaB)).filter((e) => e.accion === 'editar');
    expect(ev.map((e) => e.snapshot)).toEqual([{ antes: { conceptos: ['soat'] }, despues: { conceptos: ['derecho', 'soat'] } }]);
    // El cuerpo no puede mover la bolsa de compañía.
    const mover = await request(app).patch(`/api/flito/bolsas/bolsa/${bolsaB}`).set('Authorization', auth)
      .send({ conceptos: ['soat'], companiaId: A });
    expect([mover.status, mover.body.codigo]).toEqual([400, 'datos_invalidos']);
  });

  it('AC5 · inactivar guarda quién, cuándo y motivo, conserva saldo y movimientos, y deja «inactivar»', async () => {
    await sql`UPDATE flito_bolsas_unicas SET saldo = 125000 WHERE id = ${bolsaB}`;
    const corto = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/inactivar`).set('Authorization', auth).send({ motivo: 'abc' });
    expect([corto.status, corto.body.codigo]).toEqual([400, 'datos_invalidos']);

    const r = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/inactivar`).set('Authorization', auth)
      .send({ motivo: 'Cliente suspendido por cartera' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      activa: false, saldo: 125000, inactivadaPorNombre: USUARIO, motivoInactivacion: 'Cliente suspendido por cartera',
    });
    expect(Date.parse(r.body.inactivadaEn)).toBeGreaterThan(Date.now() - 60_000);
    const ev = (await eventos(bolsaB)).filter((e) => e.accion === 'inactivar');
    expect(ev.map((e) => [e.motivo, e.usuario_nombre])).toEqual([['Cliente suspendido por cartera', USUARIO]]);

    const otra = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/inactivar`).set('Authorization', auth)
      .send({ motivo: 'Cliente suspendido por cartera' });
    expect([otra.status, otra.body.codigo]).toEqual([409, 'ya_inactiva']);
  });

  it('AC2 · inactiva sigue contando: crear otra → 409 con {bolsaId, activa:false}', async () => {
    const r = await crear({ alcance: 'compania', companiaId: B, conceptos: ['soat'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'bolsa_compania_existe', bolsaId: bolsaB, activa: false });
  });

  it('AC4 · editar una bolsa inactiva → 409 `bolsa_inactiva`', async () => {
    const r = await request(app).patch(`/api/flito/bolsas/bolsa/${bolsaB}`).set('Authorization', auth).send({ conceptos: ['soat'] });
    expect([r.status, r.body.codigo]).toEqual([409, 'bolsa_inactiva']);
  });

  it('AC10 · recarga sobre una bolsa inactiva → 409 `bolsa_inactiva`, sin subir el soporte ni cambiar el saldo', async () => {
    const r = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/recargas`).set('Authorization', auth)
      .set('Idempotency-Key', `hu13900-${Date.now()}`)
      .field('valor', '50000').attach('soporte', PDF, { filename: 'recarga.pdf', contentType: 'application/pdf' });
    expect([r.status, r.body.codigo]).toEqual([409, 'bolsa_inactiva']);
    expect(h.subir).not.toHaveBeenCalled();
    const [b] = await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${bolsaB}`;
    expect(Number(b!.saldo)).toBe(125000);
    const [m] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${bolsaB}`;
    expect(m!.n).toBe(0);
  });

  it('AC7 · POST /buscar {alcance:compania, activa:false} → solo las inactivas, con companiaId y companiaNombre; nada por query', async () => {
    const r = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', auth).send({ alcance: 'compania', activa: false });
    expect(r.status).toBe(200);
    expect(r.body.every((b: { activa: boolean; alcance: string }) => !b.activa && b.alcance === 'compania')).toBe(true);
    const mia = r.body.find((b: { id: string }) => b.id === bolsaB);
    expect(mia).toMatchObject({ companiaId: B, activa: false });
    expect(mia.companiaNombre).toMatch(/^HU13900 Beta/);
    expect(mia).not.toHaveProperty('motivoInactivacion');
    expect(r.body.some((b: { id: string }) => b.id === bolsaA)).toBe(false);

    const porTexto = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', auth).send({ texto: 'HU13900 Alfa' });
    expect(porTexto.body.map((b: { id: string }) => b.id)).toEqual([bolsaA]);

    const q = await request(app).post('/api/flito/bolsas/buscar?texto=Alfa').set('Authorization', auth).send({});
    expect([q.status, q.body.codigo]).toEqual([400, 'datos_invalidos']);
  });

  it('AC6 · reactivar con motivo → activa y evento «reactivar»; reactivar una activa → 409 `ya_activa`', async () => {
    const r = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/reactivar`).set('Authorization', auth)
      .send({ motivo: 'Cartera al día' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ activa: true, saldo: 125000, inactivadaEn: null, motivoInactivacion: null });
    expect((await eventos(bolsaB)).filter((e) => e.accion === 'reactivar').map((e) => e.motivo)).toEqual(['Cartera al día']);
    const otra = await request(app).post(`/api/flito/bolsas/bolsa/${bolsaB}/reactivar`).set('Authorization', auth)
      .send({ motivo: 'Cartera al día' });
    expect([otra.status, otra.body.codigo]).toEqual([409, 'ya_activa']);
  });

  it('Habeas Data · la compañía (enlace) no ve quién de FLIT inactivó su bolsa ni el motivo; sí cuándo; FLIT sí', async () => {
    const ruta = `/api/flito/bolsas/bolsa/${bolsaB}`;
    h.alcance = { enlace: 'compania', companiaId: B };
    // Escritura desde el canal Cliente: la respuesta ya sale proyectada.
    const w = await request(app).post(`${ruta}/inactivar`).set('Authorization', auth).send({ motivo: 'Pausa pedida por gerencia' });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ activa: false, inactivadaPorNombre: null, motivoInactivacion: null });
    expect(Date.parse(w.body.inactivadaEn)).toBeGreaterThan(Date.now() - 60_000);
    // Detalle.
    const det = await request(app).get(ruta).set('Authorization', auth);
    expect(det.status).toBe(200);
    expect(det.body).toMatchObject({ activa: false, inactivadaPorNombre: null, motivoInactivacion: null, inactivadaEn: w.body.inactivadaEn });
    // Listado: el resumen no trae ni nombre ni motivo (tampoco a FLIT); la bolsa sí aparece, inactiva.
    const lista = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', auth).send({});
    expect(lista.body.map((b: { id: string; activa: boolean }) => [b.id, b.activa])).toEqual([[bolsaB, false]]);
    expect(lista.body[0]).not.toHaveProperty('inactivadaPorNombre');
    expect(lista.body[0]).not.toHaveProperty('motivoInactivacion');
    expect(JSON.stringify(lista.body)).not.toContain(USUARIO);

    // Interno de FLIT (sin enlace): ve el nombre y el motivo.
    h.alcance = { enlace: 'ninguno' };
    const flit = await request(app).get(ruta).set('Authorization', auth);
    expect(flit.body).toMatchObject({
      activa: false, inactivadaPorNombre: USUARIO, motivoInactivacion: 'Pausa pedida por gerencia', inactivadaEn: w.body.inactivadaEn,
    });

    // Reactivar desde el canal Cliente: tampoco devuelve nombre ni motivo.
    h.alcance = { enlace: 'compania', companiaId: B };
    const re = await request(app).post(`${ruta}/reactivar`).set('Authorization', auth).send({ motivo: 'Fin de la pausa' });
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ activa: true, inactivadaPorNombre: null, motivoInactivacion: null });
  });

  it('AC8 · estado sin bolsa → 200 {existe:false, activa:false}, no 404; con bolsa → existe', async () => {
    const sin = await request(app).get(`/api/flito/bolsas/compania/${SIN}/estado`).set('Authorization', auth);
    expect([sin.status, sin.body]).toEqual([200, { existe: false, activa: false, conceptosAutogestionados: [] }]);
    const con = await request(app).get(`/api/flito/bolsas/compania/${A}/estado`).set('Authorization', auth);
    expect(con.body).toEqual({ existe: true, activa: true, conceptosAutogestionados: [] });
  });

  it('AC9 · sin `bolsas.bolsa.crear` → 403, sin crear nada', async () => {
    const r = await crear({ alcance: 'compania', companiaId: SIN, conceptos: ['soat'] }, authSinCrear);
    expect(r.status).toBe(403);
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE compania_id = ${SIN}`;
    expect(n!.n).toBe(0);
  });

  it('AC9 · con enlace a la compañía A: el listado solo trae la de A; detalle de B → 404; escribir en B → 403', async () => {
    h.alcance = { enlace: 'compania', companiaId: A };
    const lista = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', auth).send({});
    expect(lista.body.map((b: { id: string }) => b.id)).toEqual([bolsaA]);
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${bolsaA}`).set('Authorization', auth)).status).toBe(200);
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${bolsaB}`).set('Authorization', auth)).status).toBe(404);
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${bolsaB}/movimientos`).set('Authorization', auth)).status).toBe(404);
    const patch = await request(app).patch(`/api/flito/bolsas/bolsa/${bolsaB}`).set('Authorization', auth).send({ conceptos: ['soat'] });
    expect(patch.status).toBe(403);
    expect((await crear({ alcance: 'compania', companiaId: SIN, conceptos: ['soat'] })).status).toBe(403);
    expect((await request(app).get(`/api/flito/bolsas/compania/${B}/estado`).set('Authorization', auth)).status).toBe(404);
  });

  it('las rutas por bolsa delegan en el canal Cliente: movimientos y cierres de A responden', async () => {
    const m = await request(app).get(`/api/flito/bolsas/bolsa/${bolsaA}/movimientos`).set('Authorization', auth);
    expect([m.status, m.body]).toEqual([200, []]);
    const c = await request(app).get(`/api/flito/bolsas/bolsa/${bolsaA}/cierres`).set('Authorization', auth);
    expect([c.status, c.body]).toEqual([200, []]);
    expect((await request(app).get('/api/flito/bolsas/bolsa/no-es-uuid').set('Authorization', auth)).status).toBe(404);
  });

  it('AC11 · autogestión: crear marcando SOAT autogestionado → 201 (no se bloquea) y el dato sale en estado y detalle', async () => {
    const antes = await request(app).get(`/api/flito/bolsas/compania/${AUTO}/estado`).set('Authorization', auth);
    expect(antes.body).toEqual({ existe: false, activa: false, conceptosAutogestionados: ['soat'] });
    const r = await crear({ alcance: 'compania', companiaId: AUTO, conceptos: ['soat', 'derecho'] });
    expect(r.status).toBe(201);
    expect(r.body.conceptosAutogestionados).toEqual(['soat']);
    const det = await request(app).get(`/api/flito/bolsas/bolsa/${r.body.id}`).set('Authorization', auth);
    expect(det.body.conceptosAutogestionados).toEqual(['soat']);
    const est = await request(app).get(`/api/flito/bolsas/compania/${AUTO}/estado`).set('Authorization', auth);
    expect(est.body).toEqual({ existe: true, activa: true, conceptosAutogestionados: ['soat'] });
    // Se calcula en LECTURA: si la compañía deja de autogestionar, el detalle lo refleja sin tocar la bolsa.
    await sql`UPDATE clients SET soat_autogestionable = false WHERE id = ${AUTO}`;
    const despues = await request(app).get(`/api/flito/bolsas/bolsa/${r.body.id}`).set('Authorization', auth);
    expect(despues.body.conceptosAutogestionados).toEqual([]);
    // Todo en false (A) → [].
    const a = await request(app).get(`/api/flito/bolsas/bolsa/${bolsaA}`).set('Authorization', auth);
    expect(a.body.conceptosAutogestionados).toEqual([]);
  });
});
