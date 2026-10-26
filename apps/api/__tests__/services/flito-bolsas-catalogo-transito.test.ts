// HU #13907 (Feature #13887, ADR-0029, HU-G back) — rama TRÁNSITO del catálogo único por HTTP contra PostgreSQL
// de verdad: crear, editar, inactivar, reactivar, cerrar el mes, imputación tras el cierre, frontera por enlace,
// funciones y autogestión por organismo (D15).
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Las secretarías son de PRUEBA (códigos 997xx creados aquí): con las reales (11001…) el caso dependería de las
// bolsas que haya en la base local. `ORG_A` hace el papel de 11001 en el AC. Todo lo creado se borra en `afterAll`.
// Lo que NO es de la base va mockeado: auditoría, redis, almacenamiento y la resolución del enlace (`alcanceDe`).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';

const URL = process.env.TEST_DATABASE_URL;
const h = vi.hoisted(() => {
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
  'bolsas.transito.crear', 'bolsas.transito.ver', 'bolsas.transito.editar', 'bolsas.transito.inactivar',
  'bolsas.transito.cierres.ver', 'bolsas.transito.cierre.crear', 'bolsas.transito.cargar',
];
const USUARIO = 'hu13907@flit.io';
const SUF = String(Date.now()).slice(-6);
const ORG_A = '99701'; // «11001» del AC
const ORG_B = '99702';
const ORG_C = '99703';
const ORG_AUTO = '99704';
const ORGS = [ORG_A, ORG_B, ORG_C, ORG_AUTO];
const NOV = new Date('2026-12-10T15:00:00Z');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe.skipIf(!URL)('HU #13907 — catálogo de la bolsa de tránsito (PostgreSQL real)', () => {
  let app: express.Express;
  let sql: import('postgres').Sql;
  let auth: string;
  let authSinCierresVer: string;
  let userId: number;
  const creados: string[] = [];
  let orgsCreados: string[] = [];

  const crear = (body: unknown, a = auth) => request(app).post('/api/flito/bolsas').set('Authorization', a).send(body as object);
  const editar = (id: string, body: unknown, a = auth) =>
    request(app).patch(`/api/flito/bolsas/bolsa/${id}`).set('Authorization', a).send(body as object);
  const motivo = (id: string, accion: 'inactivar' | 'reactivar', a = auth) =>
    request(app).post(`/api/flito/bolsas/bolsa/${id}/${accion}`).set('Authorization', a).send({ motivo: 'Cambio de convenio' });
  // Con el reloj falso el token firmado hoy estaría vencido: se firma bajo el mismo reloj.
  const ahora = async () => `Bearer ${await testToken({ sub: userId, role: 'xyz_renombrado' as never, username: USUARIO, funciones: FUNCIONES })}`;
  const cerrar = async (id: string, periodo: string, a?: string) =>
    request(app).post(`/api/flito/bolsas/bolsa/${id}/cierres`).set('Authorization', a ?? await ahora()).send({ periodo });
  const cierres = async (id: string, a?: string) =>
    request(app).get(`/api/flito/bolsas/bolsa/${id}/cierres`).set('Authorization', a ?? await ahora());
  const nombre = (n: string) => `HU13907 ${n} ${SUF}`;
  async function nueva(n: string, organismos: string[], conceptos: string[]): Promise<string> {
    const r = await crear({ alcance: 'transito', nombre: nombre(n), organismos, conceptos });
    expect(r.status).toBe(201);
    creados.push(r.body.id);
    return r.body.id as string;
  }
  async function cobertura(id: string) {
    return sql`SELECT organismo_codigo, concepto, activa FROM flito_bolsas_unicas_cobertura WHERE bolsa_id = ${id}
      ORDER BY organismo_codigo, concepto`;
  }
  async function eventos(id: string) {
    return sql`SELECT accion, snapshot, usuario_nombre FROM flito_bolsas_unicas_eventos WHERE bolsa_id = ${id} ORDER BY created_at, accion`;
  }
  async function asentar(bolsaId: string, tipo: 'entrada' | 'salida', valor: number, fecha: string) {
    const { db } = await import('../../src/db/client.js');
    const { asentarEnBolsa, bolsaBloqueadaPorId } = await import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
    return db.transaction(async (tx) => {
      const bolsa = (await bolsaBloqueadaPorId(tx, bolsaId))!;
      return asentarEnBolsa(tx, bolsa, { tipo, origen: tipo === 'entrada' ? 'recarga' : 'manual', valor, fecha }, { userId, nombre: USUARIO });
    });
  }

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    userId = u!.id as number;
    auth = `Bearer ${await testToken({ sub: userId, role: 'xyz_renombrado' as never, username: USUARIO, funciones: FUNCIONES })}`;
    authSinCierresVer = `Bearer ${await testToken({
      // Otro `sub`: el doble de permisos se indexa por `sub` y el último token firmado para él es el que vale.
      sub: 913907, role: 'xyz_renombrado' as never, funciones: FUNCIONES.filter((f) => f !== 'bolsas.transito.cierres.ver'),
    })}`;
    const filas = await sql`INSERT INTO organismos_transito_config (codigo, alias)
      SELECT c, 'HU13907 ' || c FROM unnest(${ORGS}::varchar[]) AS c ON CONFLICT (codigo) DO NOTHING RETURNING codigo`;
    orgsCreados = filas.map((f) => f.codigo as string);
    await sql`UPDATE flito_organismo_vigencias SET hasta = now() WHERE organismo_codigo IN ${sql(ORGS)} AND hasta IS NULL`;
    await sql`INSERT INTO flito_organismo_vigencias (organismo_codigo, modalidad, desde, motivo, actor_nombre)
      VALUES (${ORG_AUTO}, 'autogestionado', now(), 'HU13907 prueba', 'hu13907')`;
    const a = express();
    a.use(express.json());
    const { default: router } = await import('../../src/modules/flito-bolsas/flito-bolsas.routes.js');
    const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
    a.use('/api/flito/bolsas', router);
    a.use(errorHandler);
    app = a;
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (!sql) return;
    const ids = creados.length ? creados : ['00000000-0000-0000-0000-000000000000'];
    await sql`DELETE FROM flito_bolsas_unicas_eventos WHERE bolsa_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_cierres WHERE bolsa_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_cobertura WHERE bolsa_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_organismo_vigencias WHERE organismo_codigo IN ${sql(ORGS)} AND motivo = 'HU13907 prueba'`;
    if (orgsCreados.length) await sql`DELETE FROM organismos_transito_config WHERE codigo IN ${sql(orgsCreados)}`;
    await sql.end();
  });

  beforeEach(() => { h.alcance = { enlace: 'ninguno' }; h.subir.mockReset(); });

  let cund: string;
  let otra: string;
  let toma: string;

  it('AC1 · sin enlace y con bolsas.transito.crear: dos secretarías × impuesto y derecho → 201 activa, 4 parejas, evento «crear»', async () => {
    const r = await crear({ alcance: 'transito', nombre: nombre('Bolsa Cundinamarca'), organismos: [ORG_B, ORG_C], conceptos: ['impuesto', 'derecho'] });
    expect(r.status).toBe(201);
    cund = r.body.id;
    creados.push(cund);
    expect(r.body).toMatchObject({
      alcance: 'transito', nombre: nombre('Bolsa Cundinamarca'), companiaId: null, activa: true, saldo: 0,
      conceptos: ['derecho', 'impuesto'], paresAutogestionados: [], conceptosAutogestionados: [],
    });
    expect(r.body.cobertura).toEqual([
      { organismoCodigo: ORG_B, concepto: 'derecho' }, { organismoCodigo: ORG_B, concepto: 'impuesto' },
      { organismoCodigo: ORG_C, concepto: 'derecho' }, { organismoCodigo: ORG_C, concepto: 'impuesto' },
    ]);
    expect((await cobertura(cund)).every((c) => c.activa)).toBe(true);
    const ev = await eventos(cund);
    expect(ev.map((e) => [e.accion, e.usuario_nombre])).toEqual([['crear', USUARIO]]);
    expect(ev[0]!.snapshot).toMatchObject({ alcance: 'transito', organismos: [ORG_B, ORG_C], conceptos: ['derecho', 'impuesto'] });
  });

  it('AC2 · otra activa cubre (ORG_A, impuesto): crear o editar con esa pareja → 409 `cobertura_ocupada` con la pareja y su bolsa', async () => {
    otra = await nueva('Bolsa Bogota', [ORG_A], ['impuesto']);
    const r = await crear({ alcance: 'transito', nombre: nombre('Choca'), organismos: [ORG_A], conceptos: ['impuesto', 'soat'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      codigo: 'cobertura_ocupada',
      pares: [{ organismoCodigo: ORG_A, concepto: 'impuesto', bolsaId: otra, bolsaNombre: nombre('Bolsa Bogota') }],
    });
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE nombre = ${nombre('Choca')}`;
    expect(n!.n).toBe(0);

    const e = await editar(cund, { alcance: 'transito', nombre: nombre('Bolsa Cundinamarca'), organismos: [ORG_A, ORG_B], conceptos: ['impuesto'] });
    expect(e.status).toBe(409);
    expect(e.body.pares).toEqual([{ organismoCodigo: ORG_A, concepto: 'impuesto', bolsaId: otra, bolsaNombre: nombre('Bolsa Bogota') }]);
    expect(await cobertura(cund)).toHaveLength(4); // la edición rechazada no tocó nada
  });

  it('AC2 · nombre de otra bolsa de tránsito → 409 `nombre_en_uso` (al crear y al editar)', async () => {
    const r = await crear({ alcance: 'transito', nombre: nombre('Bolsa Bogota'), organismos: [ORG_C], conceptos: ['soat'] });
    expect([r.status, r.body.codigo]).toEqual([409, 'nombre_en_uso']);
    const e = await editar(cund, { nombre: nombre('Bolsa Bogota'), organismos: [ORG_B], conceptos: ['derecho'] });
    expect([e.status, e.body.codigo]).toEqual([409, 'nombre_en_uso']);
  });

  it('AC3 · editar activa: nombre, secretarías y conceptos → cobertura como se envió y evento «editar» con antes/después', async () => {
    const r = await editar(cund, { alcance: 'transito', nombre: nombre('Cundinamarca Norte'), organismos: [ORG_B], conceptos: ['soat', 'derecho'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: cund, alcance: 'transito', nombre: nombre('Cundinamarca Norte'), activa: true });
    expect(r.body.cobertura).toEqual([{ organismoCodigo: ORG_B, concepto: 'derecho' }, { organismoCodigo: ORG_B, concepto: 'soat' }]);
    const ev = (await eventos(cund)).filter((x) => x.accion === 'editar');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.snapshot).toEqual({
      antes: { nombre: nombre('Bolsa Cundinamarca'), organismos: [ORG_B, ORG_C], conceptos: ['derecho', 'impuesto'] },
      despues: { nombre: nombre('Cundinamarca Norte'), organismos: [ORG_B], conceptos: ['derecho', 'soat'] },
    });
  });

  it('AC4 · inactivar con motivo → bolsa y cobertura inactivas, saldo e historial intactos; otra puede tomar (ORG_A, impuesto)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOV });
    try { await asentar(otra, 'entrada', 50_000, '2026-11-05'); } finally { vi.useRealTimers(); }
    const r = await motivo(otra, 'inactivar');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ activa: false, saldo: 50_000, motivoInactivacion: 'Cambio de convenio' });
    expect((await cobertura(otra)).map((c) => c.activa)).toEqual([false]);
    const [m] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${otra}`;
    expect(m!.n).toBe(1);
    // La pareja quedó libre: otra bolsa la toma.
    toma = await nueva('Toma Bogota', [ORG_A], ['impuesto']);
  });

  it('AC3 · editar una bolsa inactiva → 409 `bolsa_inactiva`', async () => {
    const e = await editar(otra, { nombre: nombre('Bolsa Bogota'), organismos: [ORG_C], conceptos: ['soat'] });
    expect([e.status, e.body.codigo]).toEqual([409, 'bolsa_inactiva']);
  });

  it('AC5 · reactivar con su pareja tomada → 409 `cobertura_ocupada` con esa pareja y sigue inactiva; liberada → activa', async () => {
    const r = await motivo(otra, 'reactivar');
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('cobertura_ocupada');
    expect(r.body.pares).toEqual([
      { organismoCodigo: ORG_A, concepto: 'impuesto', bolsaId: toma, bolsaNombre: nombre('Toma Bogota') },
    ]);
    const [b] = await sql`SELECT activa FROM flito_bolsas_unicas WHERE id = ${otra}`;
    expect(b!.activa).toBe(false);
    expect((await cobertura(otra)).map((c) => c.activa)).toEqual([false]);

    expect((await motivo(toma, 'inactivar')).status).toBe(200);
    const ok = await motivo(otra, 'reactivar');
    expect(ok.status).toBe(200);
    expect(ok.body.activa).toBe(true);
    expect((await cobertura(otra)).map((c) => c.activa)).toEqual([true]);
  });

  it('AC5 · dos reactivaciones simultáneas sobre la misma pareja: una gana y la otra → 409 con la pareja (23505 traducido), no 500', async () => {
    const x = await nueva('Carrera X', [ORG_C], ['soat']);
    expect((await motivo(x, 'inactivar')).status).toBe(200);
    const y = await nueva('Carrera Y', [ORG_C], ['soat']);
    expect((await motivo(y, 'inactivar')).status).toBe(200);
    // Ninguna ve a la otra activa al leer; la que confirma segunda choca contra el índice parcial (o, si llega
    // tarde, contra la lectura). En ambos caminos el contrato es el mismo.
    const [rx, ry] = await Promise.all([motivo(x, 'reactivar'), motivo(y, 'reactivar')]);
    expect([rx.status, ry.status].sort()).toEqual([200, 409]);
    const [gana, pierde] = rx.status === 200 ? [x, ry] : [y, rx];
    expect(pierde.body).toMatchObject({
      codigo: 'cobertura_ocupada', pares: [{ organismoCodigo: ORG_C, concepto: 'soat', bolsaId: gana }],
    });
    const activas = await sql`SELECT id FROM flito_bolsas_unicas WHERE id IN ${sql([x, y])} AND activa`;
    expect(activas.map((f) => f.id)).toEqual([gana]);
    expect((await motivo(gana, 'inactivar')).status).toBe(200);
  });

  it('AC6 · con movimientos en 2026-11: cerrar 2026-11 → saldo inicial, entradas, salidas, saldo final y número; repetir → 409', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOV });
    try {
      await asentar(cund, 'entrada', 100_000, '2026-11-03');
      await asentar(cund, 'salida', 30_000, '2026-11-20');
      const r = await cerrar(cund, '2026-11');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        bolsaId: cund, periodo: '2026-11', saldoInicial: 0, totalEntradas: 100_000, totalSalidas: 30_000, saldoFinal: 70_000,
        movimientos: 2, cerradoPorNombre: USUARIO,
      });
      const otraVez = await cerrar(cund, '2026-11');
      expect(otraVez.status).toBe(409);
      const lista = await cierres(cund);
      expect(lista.status).toBe(200);
      expect(lista.body.map((c: { periodo: string }) => c.periodo)).toEqual(['2026-11']);
    } finally { vi.useRealTimers(); }
  });

  it('AC6 · una bolsa INACTIVA también admite su cierre', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOV });
    try {
      const inactiva = toma; // «Toma Bogota», inactiva desde AC5
      const r = await cerrar(inactiva, '2026-11');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ bolsaId: inactiva, movimientos: 0, saldoFinal: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('AC7 · con 2026-11 cerrado, un movimiento con fecha de noviembre 2026 queda imputado a 2026-12', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOV });
    try {
      const { movimiento } = await asentar(cund, 'entrada', 5_000, '2026-11-28');
      expect([movimiento.fecha, movimiento.periodo]).toEqual(['2026-11-28', '2026-12']);
    } finally { vi.useRealTimers(); }
  });

  it('AC8 · con enlace a compañía → 403 al crear, editar, inactivar o cerrar tránsito, sin tocar nada', async () => {
    h.alcance = { enlace: 'compania', companiaId: 1 };
    const c = await crear({ alcance: 'transito', nombre: nombre('Con enlace'), organismos: [ORG_C], conceptos: ['soat'] });
    expect(c.status).toBe(403);
    expect((await editar(cund, { nombre: nombre('Con enlace'), organismos: [ORG_C], conceptos: ['soat'] })).status).toBe(403);
    expect((await motivo(cund, 'inactivar')).status).toBe(403);
    expect((await cerrar(cund, '2026-10')).status).toBe(403);
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE nombre = ${nombre('Con enlace')}`;
    expect(n!.n).toBe(0);
    const [b] = await sql`SELECT activa, nombre FROM flito_bolsas_unicas WHERE id = ${cund}`;
    expect(b).toMatchObject({ activa: true, nombre: nombre('Cundinamarca Norte') });
  });

  it('AC8 · sin bolsas.transito.cierres.ver → 403 al pedir cierres; sin bolsas.transito.crear → 403 al crear', async () => {
    expect((await cierres(cund, authSinCierresVer)).status).toBe(403);
    const soloLectura = `Bearer ${await testToken({ sub: 913908, role: 'xyz_renombrado' as never, funciones: ['bolsas.transito.ver'] })}`;
    const r = await crear({ alcance: 'transito', nombre: nombre('Sin funcion'), organismos: [ORG_C], conceptos: ['derecho'] }, soloLectura);
    expect(r.status).toBe(403);
    const [n] = await sql`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE nombre = ${nombre('Sin funcion')}`;
    expect(n!.n).toBe(0);
  });

  it('AC8 · las funciones nuevas las conceden las mismas acciones que a su par; ninguna es del rol `operaciones`', async () => {
    const { codigosQueConceden } = await import('../../src/modules/permisos/arbol/expansion.js');
    const { PARTIDA_DE_OPERACION_NUEVA } = await import('../../src/modules/permisos/arbol/acciones-finanzas.js');
    const pares: Array<[string, string]> = [
      ['bolsas.transito.inactivar', 'bolsas.transito.editar'],
      ['bolsas.transito.cierres.ver', 'bolsas.cierres.ver'],
      ['bolsas.transito.cierre.crear', 'bolsas.cierre.crear'],
    ];
    for (const [nueva, par] of pares) {
      expect(PARTIDA_DE_OPERACION_NUEVA[nueva]).toBe(par);
      const acciones = (c: string) => codigosQueConceden(c).filter((x) => x.startsWith('accion.')).sort();
      expect(acciones(nueva).length).toBeGreaterThan(0);
      expect(acciones(par)).toEqual(expect.arrayContaining(acciones(nueva)));
    }
    const [o] = await sql`SELECT count(*)::int AS n FROM permisos_rol_funcion WHERE rol_codigo = 'operaciones'
      AND funcion_codigo IN ${sql(pares.map(([n]) => n))}`;
    expect(o!.n).toBe(0);
  });

  it('AC9 · secretaría autogestionada: el detalle marca (secretaría, impuesto) como autogestionada; crear y editar se aceptan', async () => {
    const id = await nueva('Autogestion', [ORG_AUTO, ORG_C], ['impuesto', 'derecho']);
    const det = await request(app).get(`/api/flito/bolsas/bolsa/${id}`).set('Authorization', auth);
    expect(det.status).toBe(200);
    expect(det.body.paresAutogestionados).toEqual([{ organismoCodigo: ORG_AUTO, concepto: 'impuesto' }]);
    const e = await editar(id, { nombre: nombre('Autogestion'), organismos: [ORG_AUTO], conceptos: ['impuesto'] });
    expect(e.status).toBe(200);
    expect(e.body.paresAutogestionados).toEqual([{ organismoCodigo: ORG_AUTO, concepto: 'impuesto' }]);
    // Se calcula al CONSULTAR: si el organismo deja de ser autogestionado, el detalle lo refleja sin tocar la bolsa.
    await sql`UPDATE flito_organismo_vigencias SET hasta = now() WHERE organismo_codigo = ${ORG_AUTO} AND hasta IS NULL`;
    const despues = await request(app).get(`/api/flito/bolsas/bolsa/${id}`).set('Authorization', auth);
    expect(despues.body.paresAutogestionados).toEqual([]);
  });

  // ── G-rutas: equivalentes en `/bolsa/:bolsaId/*` de lo que la web de tránsito consume hoy por `/transito/*` ──

  let recargable: string;

  it('G-rutas · POST /buscar {alcance:transito} (sustituye GET /transito) → solo bolsas de tránsito, con nivel de tránsito; query → 400', async () => {
    recargable = await nueva('Recargas', [ORG_C], ['derecho']);
    const r = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', auth).send({ alcance: 'transito', texto: SUF });
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((b: { alcance: string }) => b.alcance === 'transito')).toBe(true);
    const fila = r.body.find((b: { id: string }) => b.id === recargable);
    expect(fila).toMatchObject({
      alcance: 'transito', companiaId: null, cobertura: [{ organismoCodigo: ORG_C, concepto: 'derecho' }],
      transito: { nivel: 'sin_cargas', deuda: 0, totalCargado: 0, totalConsumido: 0 },
    });
    const q = await request(app).post('/api/flito/bolsas/buscar?texto=x').set('Authorization', auth).send({ alcance: 'transito' });
    expect([q.status, q.body.codigo]).toEqual([400, 'datos_invalidos']);
  });

  it('G-rutas · POST /buscar de tránsito exige bolsas.transito.listar (403 sin ella); el de compañía sigue igual', async () => {
    const soloCompania = `Bearer ${await testToken({ sub: 913909, role: 'xyz_renombrado' as never, funciones: ['bolsas.bolsa.listar'] })}`;
    const t = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', soloCompania).send({ alcance: 'transito' });
    expect(t.status).toBe(403);
    const c = await request(app).post('/api/flito/bolsas/buscar').set('Authorization', soloCompania).send({ alcance: 'compania' });
    expect(c.status).toBe(200);
  });

  it('G-rutas · POST /bolsa/:id/recargas (sustituye POST /transito/:id/cargas) con soporte → 201 {movimiento, saldo}; el libro y el detalle la reflejan', async () => {
    h.subir.mockResolvedValue('bolsas-transito/prueba/cargas/soporte.pdf');
    const r = await request(app).post(`/api/flito/bolsas/bolsa/${recargable}/recargas`).set('Authorization', auth)
      .field('valor', '250000').field('observacion', 'Transferencia HU13907')
      .attach('soporte', PDF, { filename: 'soporte.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ saldo: 250_000, duplicado: false, movimiento: { tipo: 'entrada', valor: 250_000 } });
    expect(h.subir).toHaveBeenCalledTimes(1);
    expect(r.body.movimiento.soporteId).toEqual(expect.any(String));

    const m = await request(app).get(`/api/flito/bolsas/bolsa/${recargable}/movimientos`).set('Authorization', auth);
    expect(m.status).toBe(200);
    expect(m.body).toHaveLength(1);
    expect(m.body[0]).toMatchObject({ id: r.body.movimiento.id, tipo: 'entrada', valor: 250_000, observacion: 'Transferencia HU13907' });

    const d = await request(app).get(`/api/flito/bolsas/bolsa/${recargable}`).set('Authorization', auth);
    expect(d.body).toMatchObject({ saldo: 250_000, ultimaEntradaValor: 250_000, transito: { nivel: 'normal', totalCargado: 250_000 } });
  });

  it('G-rutas · recarga a una bolsa de tránsito inactiva → 409 `bolsa_inactiva` sin subir el soporte ni mover el saldo', async () => {
    expect((await motivo(recargable, 'inactivar')).status).toBe(200);
    const r = await request(app).post(`/api/flito/bolsas/bolsa/${recargable}/recargas`).set('Authorization', auth)
      .field('valor', '1000').attach('soporte', PDF, { filename: 'soporte.pdf', contentType: 'application/pdf' });
    expect([r.status, r.body.codigo]).toEqual([409, 'bolsa_inactiva']);
    expect(h.subir).not.toHaveBeenCalled();
    const [b] = await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${recargable}`;
    expect(Number(b!.saldo)).toBe(250_000);
  });

  it('G-rutas · funciones: movimientos exige bolsas.transito.ver_movimientos y recargas bolsas.transito.cargar; con enlace → 403/404', async () => {
    const sinNada = `Bearer ${await testToken({ sub: 913910, role: 'xyz_renombrado' as never, funciones: ['bolsas.transito.crear'] })}`;
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${recargable}/movimientos`).set('Authorization', sinNada)).status).toBe(403);
    expect((await request(app).post(`/api/flito/bolsas/bolsa/${recargable}/recargas`).set('Authorization', sinNada).field('valor', '1')).status).toBe(403);
    h.alcance = { enlace: 'compania', companiaId: 1 };
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${recargable}/movimientos`).set('Authorization', auth)).status).toBe(404);
    expect((await request(app).post(`/api/flito/bolsas/bolsa/${recargable}/recargas`).set('Authorization', auth).field('valor', '1')).status).toBe(403);
  });

  it('G-rutas · HU #13911 (AC6): la ruta antigua /transito/:bolsaId ya no existe → 404; la nueva sí responde', async () => {
    const r = await request(app).get(`/api/flito/bolsas/transito/${recargable}`).set('Authorization', auth);
    expect(r.status).toBe(404);
    expect((await request(app).get(`/api/flito/bolsas/bolsa/${recargable}`).set('Authorization', auth)).status).toBe(200);
  });
});
