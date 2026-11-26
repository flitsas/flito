/**
 * Épica #14707 (ADR-0049 §7, diseño §3.3) — API de avisos por usuario, contra PostgreSQL de verdad.
 *
 * El `db` de la aplicación es el `dbProxy` de `flito-torre/torre-pg.ts`: una conexión con BEGIN abierto que cada test
 * deshace con ROLLBACK (la base local no se ensucia). Sin `TEST_DATABASE_URL` los describe se SALTAN (el CI no levanta
 * Postgres); la validación del body y la exigencia de sesión se prueban siempre.
 *
 * Cubre: RN-AV1 (aislamiento entre usuarios), RN-AV2 (solo no vistos, orden, placa y radicado por JOIN, conteo total),
 * RN-AV3 (marcar la lista exacta; ajeno o inexistente ignorado sin pistas; idempotencia), RN-AV4 (purga 90/180 días,
 * frontera inclusiva) y la ruta HTTP (sesión obligatoria, usuario del token, body inválido → 400).
 * Datos sintéticos: placas «ZQ…», ningún dato real.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { URL_BASE, dbProxy, abrirTx, cerrarTx, cerrarBase, sembrador, placaNueva } from './flito-torre/torre-pg.js';

vi.mock('../../src/db/client.js', () => ({ db: dbProxy, getPoolStats: vi.fn() }));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
// Sesión de prueba: el usuario sale de la cabecera `x-usuario` (como saldría del token); sin ella, 401.
vi.mock('../../src/shared/middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = req.headers['x-usuario'];
    if (!u) { res.status(401).json({ error: 'sin sesión' }); return; }
    req.user = { sub: Number(u), username: `u${u}`, role: 'admin' } as never;
    next();
  },
}));

// Enlace del usuario para la frontera real (`guardiaFrontera`): por defecto, cada usuario tiene el que diga el mapa.
const enlaces = vi.hoisted(() => new Map<number, string>());
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolverPermisos: async (userId: number) => ({
    ok: true, userId, rol: 'cliente', tipoEnlace: enlaces.get(userId) ?? 'ninguno', proveedor: null, funciones: new Set<string>(),
  }),
}));

const { listarAvisosNoVistos, marcarAvisosVistos, purgarAvisos } = await import('../../src/modules/flito-avisos/flito-avisos.service.js');
const { default: rutas } = await import('../../src/modules/flito-avisos/flito-avisos.routes.js');
const { guardiaFrontera } = await import('../../src/shared/middleware/frontera-enlace.js');

const app = express();
app.use(express.json());
app.use('/api/flito/avisos', rutas);

/**
 * Montaje con la FRONTERA POR ENLACE real delante (la que `authMiddleware` corre al final): decisión del humano
 * (2026-11-26) — un usuario con enlace (compañía, proveedor, organismo) también lee y marca SUS avisos.
 */
const appFrontera = express();
appFrontera.use(express.json());
appFrontera.use((req, res, next) => {
  req.user = { sub: Number(req.headers['x-usuario']), username: 'u', role: 'cliente' } as never;
  void guardiaFrontera(req, res, next);
});
appFrontera.use('/api/flito/avisos', rutas);

const describeDb = URL_BASE ? describe : describe.skip;
type Tx = Awaited<ReturnType<typeof abrirTx>>;
let tx: Tx;

let n = 0;
async function usuario(): Promise<number> {
  n += 1;
  const [u] = await tx`INSERT INTO users (username, name, password_hash, role)
    VALUES (${`av14707_${Date.now().toString(36)}_${n}`}, 'Prueba avisos', 'h', 'admin') RETURNING id`;
  return Number(u!.id);
}

async function aviso(o: { usuarioId: number; tramiteId?: string | null; concepto?: 'soat' | 'impuesto'; motivo?: string;
  creadoEn?: string; vistoEn?: string | null }): Promise<string> {
  const [a] = await tx`INSERT INTO flito_avisos_usuario (usuario_id, tipo, concepto, registro_id, tramite_id, motivo, creado_en, visto_en)
    VALUES (${o.usuarioId}, 'solicitud_retirada', ${o.concepto ?? 'impuesto'}, gen_random_uuid(), ${o.tramiteId ?? null},
      ${o.motivo ?? 'anulado'}, ${o.creadoEn ?? '2035-03-01T15:00:00Z'}, ${o.vistoEn ?? null}) RETURNING id`;
  return String(a!.id);
}

async function vistoEn(id: string): Promise<string | null> {
  const [f] = await tx`SELECT visto_en FROM flito_avisos_usuario WHERE id = ${id}`;
  return f ? (f.visto_en ? new Date(f.visto_en as string).toISOString() : null) : 'BORRADO';
}

afterAll(async () => { if (URL_BASE) await cerrarBase(); });

describe('ruta — sesión y validación (sin base)', () => {
  it('sin sesión → 401 en las dos rutas', async () => {
    expect((await request(app).get('/api/flito/avisos')).status).toBe(401);
    expect((await request(app).post('/api/flito/avisos/visto').send({ ids: [] })).status).toBe(401);
  });
  it('body inválido → 400 sin tocar nada: vacío, id no uuid, campo extra (sin «todos»)', async () => {
    for (const body of [{ ids: [] }, { ids: ['no-es-uuid'] }, { ids: ['00000000-0000-4000-8000-000000000000'], todos: true }, {}]) {
      const r = await request(app).post('/api/flito/avisos/visto').set('x-usuario', '1').send(body);
      expect(r.status).toBe(400);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('frontera por enlace (sin base): las dos rutas de avisos son de sesión y no abren nada más', () => {
  it.each(['compania', 'proveedor', 'organismos_transito'])('enlace %s: GET / y POST /visto pasan la frontera; otra ruta, 403', async (enlace) => {
    enlaces.set(901, enlace);
    // POST con body inválido: si la frontera deja pasar, responde la ruta (400), no la guarda (403).
    expect((await request(appFrontera).post('/api/flito/avisos/visto').set('x-usuario', '901').send({ ids: [] })).status).toBe(400);
    expect((await request(appFrontera).get('/api/flito/avisos/visto').set('x-usuario', '901')).status).toBe(403);
    expect((await request(appFrontera).post('/api/flito/avisos/otra').set('x-usuario', '901').send({})).status).toBe(403);
  });
});

describeDb('avisos por usuario (PostgreSQL)', () => {
  beforeEach(async () => { tx = await abrirTx(); auditMock.mockClear(); });
  afterEach(async () => { await cerrarTx(); });

  it('RN-AV1/AV2: cada usuario ve SOLO sus no vistos, del más reciente, con placa y radicado por JOIN y el conteo', async () => {
    const s = sembrador(tx);
    await s.organismos('05001');
    const cia = await s.cia();
    const placa = placaNueva();
    const tramiteId = await s.tramite({ cia, placa });
    const [{ id_flit: idFlit }] = await tx`SELECT id_flit FROM flito_tramites WHERE id = ${tramiteId}` as unknown as [{ id_flit: string }];
    const a = await usuario();
    const b = await usuario();
    const viejo = await aviso({ usuarioId: a, tramiteId, creadoEn: '2035-03-01T10:00:00Z', motivo: 'abortado' });
    const nuevo = await aviso({ usuarioId: a, tramiteId, concepto: 'soat', creadoEn: '2035-03-02T10:00:00Z', motivo: 'revocado' });
    await aviso({ usuarioId: a, tramiteId, vistoEn: '2035-03-03T10:00:00Z' }); // visto: no sale
    const deB = await aviso({ usuarioId: b, tramiteId });

    const ra = await listarAvisosNoVistos(a);
    expect(ra.noVistos).toBe(2);
    expect(ra.avisos.map((x) => x.id)).toEqual([nuevo, viejo]);
    expect(ra.avisos[0]).toMatchObject({ concepto: 'soat', motivo: 'revocado', tipo: 'solicitud_retirada', placa, idFlit, vistoEn: null });
    expect(ra.avisos[1]).toMatchObject({ concepto: 'impuesto', motivo: 'abortado' });
    expect(ra.avisos.map((x) => x.id)).not.toContain(deB);

    const rb = await listarAvisosNoVistos(b);
    expect(rb.avisos.map((x) => x.id)).toEqual([deB]);

    // Por HTTP: el usuario es el del token; la respuesta no se cachea.
    const http = await request(app).get('/api/flito/avisos').set('x-usuario', String(b));
    expect(http.status).toBe(200);
    expect(http.headers['cache-control']).toBe('no-store');
    expect(http.body).toEqual({ noVistos: 1, avisos: [expect.objectContaining({ id: deB, placa })] });
  });

  it('usuario con enlace (compañía, proveedor): pasa la frontera y lee y marca SOLO los suyos', async () => {
    const deCompania = await usuario();
    const deProveedor = await usuario();
    const interno = await usuario();
    enlaces.set(deCompania, 'compania');
    enlaces.set(deProveedor, 'proveedor');
    const suyo = await aviso({ usuarioId: deCompania });
    const delProveedor = await aviso({ usuarioId: deProveedor });
    const ajeno = await aviso({ usuarioId: interno });

    const r = await request(appFrontera).get('/api/flito/avisos').set('x-usuario', String(deCompania));
    expect(r.status).toBe(200);
    expect(r.body.avisos.map((x: { id: string }) => x.id)).toEqual([suyo]);
    expect(r.body.noVistos).toBe(1);
    const rp = await request(appFrontera).get('/api/flito/avisos').set('x-usuario', String(deProveedor));
    expect(rp.body.avisos.map((x: { id: string }) => x.id)).toEqual([delProveedor]);

    const v = await request(appFrontera).post('/api/flito/avisos/visto').set('x-usuario', String(deCompania)).send({ ids: [suyo, ajeno, delProveedor] });
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ marcados: 1 });
    expect(await vistoEn(ajeno)).toBeNull();
    expect(await vistoEn(delProveedor)).toBeNull();
  });

  it('RN-AV2: un aviso de SOAT sin trámite toma la placa del vehículo del SOAT', async () => {
    const s = sembrador(tx);
    await s.organismos('05001');
    const cia = await s.cia();
    const placa = placaNueva();
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VINAV${placa}`}) RETURNING id`;
    const [soat] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, organismo_codigo, estado, origen)
      VALUES (${`VINAV${placa}`}, ${v!.id}, ${cia}, '05001', 'pendiente', 'tramite') RETURNING id`;
    const u = await usuario();
    await tx`INSERT INTO flito_avisos_usuario (usuario_id, tipo, concepto, registro_id, tramite_id, motivo)
      VALUES (${u}, 'solicitud_retirada', 'soat', ${soat!.id}, NULL, 'anulado')`;
    const r = await listarAvisosNoVistos(u);
    expect(r.avisos[0]).toMatchObject({ placa, idFlit: null });
  });

  it('RN-AV3: marca la lista exacta; ajeno e inexistente se ignoran sin pistas; repetir es idempotente', async () => {
    const a = await usuario();
    const b = await usuario();
    const a1 = await aviso({ usuarioId: a });
    const a2 = await aviso({ usuarioId: a });
    const a3 = await aviso({ usuarioId: a }); // no está en la lista mostrada: sigue sin ver
    const deB = await aviso({ usuarioId: b });
    const inexistente = '00000000-0000-4000-8000-000000000001';

    const r = await request(app).post('/api/flito/avisos/visto').set('x-usuario', String(a)).send({ ids: [a1, a2, deB, inexistente] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ marcados: 2 });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const primero = await vistoEn(a1);
    expect(primero).not.toBeNull();
    expect(await vistoEn(a3)).toBeNull();
    expect(await vistoEn(deB)).toBeNull(); // el ajeno no cambia

    // Un id SOLO ajeno: misma respuesta que uno inexistente (no es oráculo de pertenencia).
    const soloAjeno = await request(app).post('/api/flito/avisos/visto').set('x-usuario', String(a)).send({ ids: [deB] });
    const soloInexistente = await request(app).post('/api/flito/avisos/visto').set('x-usuario', String(a)).send({ ids: [inexistente] });
    expect(soloAjeno.status).toBe(200);
    expect(soloAjeno.body).toEqual(soloInexistente.body);
    expect(soloAjeno.body).toEqual({ marcados: 0 });

    // Idempotencia: repetir no cambia `visto_en` ni cuenta de nuevo.
    expect(await marcarAvisosVistos(a, [a1, a2], new Date('2035-12-31T00:00:00Z'))).toBe(0);
    expect(await vistoEn(a1)).toBe(primero);
    expect((await listarAvisosNoVistos(a)).avisos.map((x) => x.id)).toEqual([a3]);
  });

  it('RN-AV4: purga vistos > 90 días y no vistos > 180 (frontera inclusiva); lo demás se queda', async () => {
    const u = await usuario();
    const ahora = new Date('2035-12-01T12:00:00Z');
    const dias = (d: number) => new Date(ahora.getTime() - d * 86_400_000).toISOString();
    const vistoViejo = await aviso({ usuarioId: u, creadoEn: dias(200), vistoEn: dias(90) }); // justo 90: se borra
    const vistoReciente = await aviso({ usuarioId: u, creadoEn: dias(200), vistoEn: dias(89) });
    const noVistoViejo = await aviso({ usuarioId: u, creadoEn: dias(180) }); // justo 180: se borra
    const noVistoReciente = await aviso({ usuarioId: u, creadoEn: dias(179) });

    const r = await purgarAvisos({ ahora });
    expect(r.vistos).toBeGreaterThanOrEqual(1);
    expect(r.noVistos).toBeGreaterThanOrEqual(1);
    expect(await vistoEn(vistoViejo)).toBe('BORRADO');
    expect(await vistoEn(noVistoViejo)).toBe('BORRADO');
    expect(await vistoEn(vistoReciente)).not.toBe('BORRADO');
    expect(await vistoEn(noVistoReciente)).toBeNull();

    // Segunda corrida: nada propio que borrar (idempotente).
    await purgarAvisos({ ahora });
    expect(await vistoEn(vistoReciente)).not.toBe('BORRADO');
  });
});
