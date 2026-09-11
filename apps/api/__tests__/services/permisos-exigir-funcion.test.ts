// HU #12082 — `exigirFuncion`: la guarda HTTP del motor único, con un router de LABORATORIO.
//
// No se monta el router de ningún módulo (memoria: eso arrastra ~786 tests seriales). `resolverPermisos`
// se mockea —la lectura la prueba `permisos-resolutor.test.ts`— y aquí se afirma lo que la guarda hace
// con el resultado: 401/403/next, el texto de cada motivo, la bitácora sin PII y sin `await`, y la
// deduplicación por (usuario, función, ventana).
//
// Tasks de QA que fija este fichero: #12260, #12261, #12263, #12264, #12265, #12266, #12267,
// #12274 (M2) y #12275 (M3).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermisosResueltos } from '../../src/shared/permisos-efectivos.js';

const resolverMock = vi.fn<(userId: number) => Promise<PermisosResueltos>>();
const warnMock = vi.fn();

/** El escritor observado: cada `values()` y su `onConflictDoUpdate()`. */
const escrituras: { fila: Record<string, unknown>; set: Record<string, unknown> }[] = [];
let escrituraFalla: Error | null = null;
const insertMock = vi.fn(() => {
  const entrada: { fila: Record<string, unknown>; set: Record<string, unknown> } = { fila: {}, set: {} };
  const promesa = () => (escrituraFalla ? Promise.reject(escrituraFalla) : Promise.resolve([]));
  const t = {
    values: (v: Record<string, unknown>) => { entrada.fila = v; escrituras.push(entrada); return t; },
    onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => { entrada.set = cfg.set; return t; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => promesa().then(res, rej),
    catch: (rej: (e: unknown) => unknown) => promesa().catch(rej),
  };
  return t;
});

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: (...a: unknown[]) => insertMock(...(a as [])), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/logger.js', () => ({
  loggerFor: () => ({ warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/shared/permisos-efectivos.js', () => ({
  resolverPermisos: (id: number) => resolverMock(id),
  invalidarPermisosDe: vi.fn(),
  invalidarPermisosDeRol: vi.fn(),
  paginasEfectivasDeUsuario: vi.fn().mockResolvedValue([]),
}));

const { exigirFuncion, tieneFuncion, motivoDenegacionFuncion, textoDe } = await import('../../src/shared/middleware/exigir-funcion.js');
const { VENTANA_DEDUP_MS } = await import('../../src/shared/historial/permisos-intentos-denegados.js');
const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const ok = (funciones: string[], extra: Partial<Extract<PermisosResueltos, { ok: true }>> = {}): PermisosResueltos => ({
  ok: true, userId: 7, rol: 'gestor', tipoPrincipal: 'interno', funciones: new Set(funciones),
  version: 'v1', resueltoEn: new Date(), ...extra,
});
const fallo: PermisosResueltos = { ok: false, userId: 7, motivo: 'resolucion' };

/** Inyecta `req.user` como lo dejaría `authMiddleware`, sin verificar ningún token. */
const como = (user: Partial<Request['user']> | null) => (req: Request, _res: Response, next: NextFunction) => {
  if (user) req.user = { sub: 7, username: 'ana.perez@ejemplo.test', role: 'gestor', ...user } as Request['user'];
  next();
};

const handler = vi.fn((_req: Request, res: Response) => { res.status(200).json({ ok: true }); });

function laboratorio(user: Partial<Request['user']> | null = {}): Express {
  const app = express();
  app.use(express.json());
  app.post('/x', como(user), exigirFuncion('soat.solicitud.crear'), handler);
  app.post('/api/flito/soat/solicitud', como(user), exigirFuncion('soat.solicitud.crear'), handler);
  app.use('/api/largo', como(user), exigirFuncion('soat.solicitud.crear'), handler);
  app.post('/inventada', como(user), exigirFuncion('soat.inventada.hacer'), handler);
  return app;
}

// La suite apaga la bitácora del 403 (`PERMISOS_SKIP_BITACORA_INTENTOS` en setup.ts, HU #12083) para que
// los specs de los módulos reconducidos no vean consumido su `insert`. ESTE fichero sí la prueba: la enciende.
beforeAll(() => { delete process.env.PERMISOS_SKIP_BITACORA_INTENTOS; });
afterAll(() => { process.env.PERMISOS_SKIP_BITACORA_INTENTOS = '1'; });

beforeEach(() => {
  resolverMock.mockReset();
  handler.mockClear();
  warnMock.mockReset();
  insertMock.mockClear();
  escrituras.length = 0;
  escrituraFalla = null;
});
afterEach(() => { vi.useRealTimers(); });

const tick = () => new Promise((r) => setImmediate(r));

describe('TC #12260 AC2 — exigirFuncion: 403 sin ejecutar el handler, next() con la función, 401 sin req.user', () => {
  it('(1) conjunto {soat.cola.ver} → 403 { error, funcion } y el handler NO corre (mutante M2: next() en vez de 403)', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const r = await request(laboratorio()).post('/x').send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ funcion: 'soat.solicitud.crear' });
    expect(typeof r.body.error).toBe('string');
    expect(handler).not.toHaveBeenCalled();
  });

  it('(2) conjunto con soat.solicitud.crear → 200 y el handler corre una vez', async () => {
    resolverMock.mockResolvedValue(ok(['soat.solicitud.crear']));
    const r = await request(laboratorio()).post('/x').send({});
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('(3) sin req.user → 401 { error: Token requerido }; ni el resolutor ni el handler se llaman', async () => {
    const r = await request(laboratorio(null)).post('/x').send({});
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Token requerido' });
    expect(resolverMock).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('montaje: exporta un RequestHandler y documenta el patrón authMiddleware → exigirFuncion, como exigirAccionSiigo', () => {
    const guarda = exigirFuncion('soat.solicitud.crear');
    expect(typeof guarda).toBe('function');
    expect(guarda.length).toBe(3);
    const aqui = path.dirname(fileURLToPath(import.meta.url));
    const fuente = readFileSync(path.resolve(aqui, '../../src/shared/middleware/exigir-funcion.ts'), 'utf8');
    expect(fuente).toMatch(/Se monta DESPUÉS de `authMiddleware`/);
    // Desde la HU #12083 se monta en las rutas de producto, y SIEMPRE a nivel de ruta (ADR-0016 §2).
    expect(fuente).toMatch(/A NIVEL DE RUTA \(ADR-0016 §2\)/);
    expect(fuente).toMatch(/nunca en un `router\.use`/);
  });

  it('no decide con req.user.role contra un mapa fijo: el mismo rol con dos conjuntos recibe dos respuestas', async () => {
    resolverMock.mockResolvedValueOnce(ok(['soat.solicitud.crear'], { rol: 'gestor' }));
    expect((await request(laboratorio()).post('/x').send({})).status).toBe(200);
    resolverMock.mockResolvedValueOnce(ok([], { rol: 'gestor' }));
    expect((await request(laboratorio()).post('/x').send({})).status).toBe(403);
  });
});

describe('HU #12083 — tieneFuncion(req, codigo): la misma decisión, dentro de un handler', () => {
  const reqCon = (user: Partial<Request['user']> | null) => ({
    user: user ? { sub: 7, username: 'ana.perez@ejemplo.test', role: 'gestor', ...user } : undefined,
    method: 'PATCH', baseUrl: '/api/tramites', route: { path: '/:id' }, originalUrl: '/api/tramites/123',
  }) as unknown as Request;

  it('SÍ cuando el conjunto tiene el código; NO (y bitácora con la plantilla, sin dato) cuando no; NO sin req.user y sin consultar', async () => {
    resolverMock.mockResolvedValueOnce(ok(['tramite.tramite.forzar_continuar']));
    expect(await tieneFuncion(reqCon({}), 'tramite.tramite.forzar_continuar')).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();

    resolverMock.mockResolvedValueOnce(ok(['tramite.tramite.editar']));
    expect(await tieneFuncion(reqCon({}), 'tramite.tramite.forzar_continuar')).toBe(false);
    await tick();
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(escrituras[0]!.fila).toMatchObject({
      userId: 7, rolCodigo: 'gestor', funcionCodigo: 'tramite.tramite.forzar_continuar', motivo: 'sin_funcion',
      metodo: 'PATCH', ruta: '/api/tramites/:id',
    });

    resolverMock.mockClear();
    expect(await tieneFuncion(reqCon(null), 'tramite.tramite.forzar_continuar')).toBe(false);
    expect(resolverMock).not.toHaveBeenCalled();
  });

  it('el fallo del resolutor es NO, no una excepción: el handler responde su 403 y no un 500', async () => {
    resolverMock.mockResolvedValueOnce(fallo);
    await expect(tieneFuncion(reqCon({}), 'tramite.tramite.forzar_continuar')).resolves.toBe(false);
    await tick();
    expect(escrituras[0]!.fila).toMatchObject({ motivo: 'no_resuelto' });
  });
});

describe('TC #12261 AC3 — un JWT válido con allowedPages manipulado decide igual que sin el campo: el motor resuelve contra la base y del token solo usa sub (y role para el texto de bitácora)', () => {
  const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);
  const firmar = (claims: Record<string, unknown>) => new SignJWT({ username: 'ana', role: 'gestor', ...claims })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('7').setIssuedAt().setExpirationTime('1h').sign(secret());

  function conAuth(): { app: Express; visto: { user?: Request['user'] } } {
    const visto: { user?: Request['user'] } = {};
    const app = express();
    app.use(express.json());
    app.post('/x', authMiddleware, (req, _res, next) => { visto.user = req.user; next(); },
      exigirFuncion('soat.solicitud.crear'), handler);
    return { app, visto };
  }

  it('A (sin allowedPages) y B (allowedPages y funciones inventadas) reciben el MISMO 403; resolverPermisos se llamó con 7 y req.user no lleva el campo', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const a = await firmar({});
    const b = await firmar({ allowedPages: ['soat.solicitud.crear', 'pagina.users', '*'], funciones: ['soat.solicitud.crear'] });

    const { app, visto } = conAuth();
    const ra = await request(app).post('/x').set('Authorization', `Bearer ${a}`).send({});
    const rb = await request(app).post('/x').set('Authorization', `Bearer ${b}`).send({});

    expect(ra.status).toBe(403);
    expect(rb.status).toBe(403);
    expect(rb.body).toEqual(ra.body);
    expect(rb.body.funcion).toBe('soat.solicitud.crear');
    expect(handler).not.toHaveBeenCalled();
    // La frontera y la guarda comparten el resolutor: todas las llamadas fueron con el sub verificado.
    expect(resolverMock).toHaveBeenCalled();
    for (const [arg] of resolverMock.mock.calls) expect(arg).toBe(7);
    expect(visto.user).toBeDefined();
    expect(visto.user).not.toHaveProperty('allowedPages');
    expect(Object.keys(visto.user!).sort()).toEqual(['role', 'sub', 'transitoCodigo', 'username']);
  });

  it('el texto de bitácora usa el rol del token VERIFICADO, no uno del cuerpo ni de la query', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const { app } = conAuth();
    await request(app).post('/x?role=admin').set('Authorization', `Bearer ${await firmar({})}`).send({ role: 'admin' });
    await tick();
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]!.fila.rolCodigo).toBe('gestor');
    expect(escrituras[0]!.fila.userId).toBe(7);
  });
});

describe('TC #12263 AC4 — el fallo de base NO abre la puerta: 403 (no 500, no 200) con texto de resolución, y la siguiente petición vuelve a consultar', () => {
  it('primera: 403 no_resuelto (no «su rol no tiene esa función»); segunda: 200 porque el fallo no se cacheó', async () => {
    resolverMock.mockResolvedValueOnce(fallo).mockResolvedValueOnce(ok(['soat.solicitud.crear']));
    const app = laboratorio();
    const r1 = await request(app).post('/x').send({});
    expect(r1.status).toBe(403);
    expect(r1.body).toEqual({
      error: 'No se pudo verificar el permiso. Intente de nuevo.',
      funcion: 'soat.solicitud.crear',
      motivo: 'no_resuelto',
    });
    expect(r1.body.error).not.toMatch(/su rol no tiene/i);
    expect(handler).not.toHaveBeenCalled();
    await tick();
    expect(escrituras[0]!.fila.motivo).toBe('no_resuelto');

    const r2 = await request(app).post('/x').send({});
    expect(r2.status).toBe(200);
    expect(resolverMock).toHaveBeenCalledTimes(2);
  });

  it('mutante M3: un Set vacío en vez del fallo daría el texto de rol sin módulo — el texto distingue los dos', () => {
    expect(textoDe('no_resuelto', 'soat.solicitud.crear')).not.toBe(textoDe('sin_modulo', 'soat.solicitud.crear'));
    expect(motivoDenegacionFuncion(new Set(), 'soat.solicitud.crear')).toBe('sin_modulo');
  });
});

describe('TC #12264 AC5 — el 403 trae { error, funcion } y distingue sin_funcion, sin_modulo y no_reconocida', () => {
  const TEXTO = {
    sin_funcion: 'Su rol no tiene esa función («Radicar una solicitud de SOAT»).',
    sin_modulo: 'No tiene acceso a este módulo («soat»).',
    no_reconocida: 'Función no reconocida.',
  };

  it('(1) {soat.cola.ver} pidiendo soat.solicitud.crear → sin_funcion, texto entero', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const r = await request(laboratorio()).post('/x').send({});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: TEXTO.sin_funcion, funcion: 'soat.solicitud.crear', motivo: 'sin_funcion' });
  });

  it('(2) {pagina.dashboard} pidiendo soat.solicitud.crear → sin_modulo, texto entero', async () => {
    resolverMock.mockResolvedValue(ok(['pagina.dashboard']));
    const r = await request(laboratorio()).post('/x').send({});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: TEXTO.sin_modulo, funcion: 'soat.solicitud.crear', motivo: 'sin_modulo' });
  });

  it('(3) un código que no existe en el catálogo → 403 (no 404 ni 400) no_reconocida', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver', 'pagina.dashboard']));
    const r = await request(laboratorio()).post('/inventada').send({});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: TEXTO.no_reconocida, funcion: 'soat.inventada.hacer', motivo: 'no_reconocida' });
  });

  it('los tres textos son distintos entre sí y ninguno lleva correo, nombre ni id', () => {
    const textos = Object.values(TEXTO);
    expect(new Set(textos).size).toBe(3);
    for (const t of textos) {
      expect(t).not.toMatch(/@|ana|perez|\b7\b/i);
    }
  });

  it('motivoDenegacionFuncion es pura y responde los mismos tres casos', () => {
    expect(motivoDenegacionFuncion(new Set(['soat.cola.ver']), 'soat.solicitud.crear')).toBe('sin_funcion');
    expect(motivoDenegacionFuncion(new Set(['pagina.dashboard']), 'soat.solicitud.crear')).toBe('sin_modulo');
    expect(motivoDenegacionFuncion(new Set(['soat.cola.ver']), 'soat.inventada.hacer')).toBe('no_reconocida');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('el «módulo» de una operación es el del catálogo, que para TODAS las operaciones coincide con el primer segmento del código; el de una página es su grupo', () => {
    const catalogo = catalogoCompleto();
    for (const f of catalogo.filter((x) => x.tipo === 'operacion')) {
      expect(f.modulo).toBe(f.codigo.split('.')[0]);
    }
    const pagina = catalogo.find((x) => x.codigo === 'pagina.users');
    expect(pagina?.modulo).toBe('administracion');
    // Tener OTRA página del mismo grupo ⇒ sin_funcion; ninguna del grupo ⇒ sin_modulo.
    expect(motivoDenegacionFuncion(new Set(['pagina.dashboard']), 'pagina.users')).toBe('sin_modulo');
    expect(motivoDenegacionFuncion(new Set(['pagina.privacy']), 'pagina.users')).toBe('sin_funcion');
  });
});

describe('TC #12265 AC6 — la bitácora lleva método, ruta sin query y recortada, función, rol e id numérico — y NUNCA correo, documento, teléfono ni nombre', () => {
  it('escribe exactamente una fila con los campos del AC y sin los datos sintéticos de query, cuerpo ni username', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const r = await request(laboratorio())
      .post('/api/flito/soat/solicitud?correo=ana.perez@ejemplo.test&documento=1020304050')
      .send({ telefono: '3001234567', nombre: 'Ana Pérez', documento: '1020304050' });
    expect(r.status).toBe(403);
    await tick();

    expect(escrituras).toHaveLength(1);
    const { fila } = escrituras[0]!;
    expect(fila).toMatchObject({
      metodo: 'POST', ruta: '/api/flito/soat/solicitud', funcionCodigo: 'soat.solicitud.crear',
      rolCodigo: 'gestor', userId: 7, motivo: 'sin_funcion',
    });
    expect(typeof fila.userId).toBe('number');
    expect(fila.ventanaInicio).toBeInstanceOf(Date);
    // Del `set` del UPSERT solo los valores planos: `veces` y `ultimaVez` son SQL de Drizzle (circulares).
    const { set } = escrituras[0]!;
    const texto = JSON.stringify(fila) + JSON.stringify({ motivo: set.motivo, metodo: set.metodo, ruta: set.ruta });
    for (const pii of ['ana.perez', '1020304050', '3001234567', 'Ana', 'ejemplo.test', '?']) {
      expect(texto).not.toContain(pii);
    }
    // Solo las columnas declaradas: no hay sitio para texto libre.
    expect(Object.keys(fila).sort()).toEqual(
      ['funcionCodigo', 'metodo', 'motivo', 'rolCodigo', 'ruta', 'userId', 'ventanaInicio'],
    );
  });

  it('una ruta de 500 caracteres (segmentos cortos, sin pinta de dato) queda recortada a 300', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const larga = '/api/largo/' + 'ab/'.repeat(163);
    expect(larga.length).toBe(500);
    await request(laboratorio()).post(larga).send({});
    await tick();
    expect((escrituras[0]!.fila.ruta as string).length).toBe(300);
    expect(escrituras[0]!.fila.ruta).toBe(larga.slice(0, 300));
  });

  it('el escritor recibe campos, no `req`: el UPSERT actualiza contador, ultima_vez y lo último que pasó', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    await request(laboratorio()).post('/x').send({});
    await tick();
    expect(Object.keys(escrituras[0]!.set).sort()).toEqual(['metodo', 'motivo', 'ruta', 'ultimaVez', 'veces']);
  });
});

describe('Security review #12082 — la ruta de la bitácora es la PLANTILLA o el path ENMASCARADO, nunca cédula, placa, VIN ni token del path', () => {
  const TOKEN_HEX40 = '9f2c4b1d8e7a6f5c3b2a1d0e9f8c7b6a5d4c3b2a';

  function conRuta(): { app: Express; visto: { routePath?: unknown } } {
    const visto: { routePath?: unknown } = {};
    const lab = express.Router();
    lab.get('/preview/:docNumber', (req, _res, next) => { visto.routePath = req.route?.path; next(); },
      exigirFuncion('soat.solicitud.crear'), handler);
    const app = express();
    app.use('/api/lab', como({}), lab);
    return { app, visto };
  }

  function conRouterUse(): Express {
    const lab = express.Router();
    lab.use(exigirFuncion('soat.solicitud.crear'));
    lab.get('/candidatos/:placa', handler);
    lab.get('/v/:vin', handler);
    lab.get('/t/:token', handler);
    lab.get('/cola', handler);
    const app = express();
    app.use('/api/lab', como({}), lab);
    return app;
  }

  it('(i) guarda a nivel de ruta: req.route está poblado y la fila lleva la plantilla /api/lab/preview/:docNumber, no la cédula', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const { app, visto } = conRuta();
    const r = await request(app).get('/api/lab/preview/1020304050');
    expect(r.status).toBe(403);
    await tick();
    expect(visto.routePath).toBe('/preview/:docNumber');
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]!.fila.ruta).toBe('/api/lab/preview/:docNumber');
    expect(JSON.stringify(escrituras[0]!.fila)).not.toContain('1020304050');
  });

  it('(ii) guarda con router.use (req.route undefined): placa, VIN y token salen como *; un segmento normal queda intacto', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const app = conRouterUse();
    for (const p of ['/api/lab/candidatos/ABC123', '/api/lab/v/1HGCM82633A004352', `/api/lab/t/${TOKEN_HEX40}`, '/api/lab/c/ana.perez%40ejemplo.test', '/api/lab/cola']) {
      expect((await request(app).get(p)).status).toBe(403);
    }
    await tick();
    expect(escrituras.map((e) => e.fila.ruta)).toEqual([
      '/api/lab/candidatos/*', '/api/lab/v/*', '/api/lab/t/*', '/api/lab/c/*', '/api/lab/cola',
    ]);
    const todo = JSON.stringify(escrituras.map((e) => e.fila));
    for (const dato of ['ABC123', '1HGCM82633A004352', TOKEN_HEX40, 'ana.perez']) expect(todo).not.toContain(dato);
  });

  it('(iii) la query string sigue fuera en los dos caminos', async () => {
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    await request(conRuta().app).get('/api/lab/preview/1020304050?correo=ana.perez@ejemplo.test');
    await request(conRouterUse()).get('/api/lab/cola?documento=1020304050');
    await tick();
    expect(escrituras.map((e) => e.fila.ruta)).toEqual(['/api/lab/preview/:docNumber', '/api/lab/cola']);
    expect(JSON.stringify(escrituras.map((e) => e.fila))).not.toMatch(/\?|ana\.perez|1020304050/);
  });
});

describe('TC #12266 AC6 — 10.000 reintentos del mismo (usuario, función) en la ventana escriben UNA fila; otra función u otra ventana escriben otra', () => {
  /** La tabla simulada: el UPSERT sobre la clave única (user_id, funcion_codigo, ventana_inicio). */
  function filasPorClave() {
    const tabla = new Map<string, number>();
    for (const { fila } of escrituras) {
      const clave = `${fila.userId}|${fila.funcionCodigo}|${(fila.ventanaInicio as Date).toISOString()}`;
      tabla.set(clave, (tabla.get(clave) ?? 0) + 1);
    }
    return tabla;
  }

  function res403() {
    const res = { statusCode: 0, status(c: number) { res.statusCode = c; return res; }, json() { return res; } };
    return res as unknown as Response & { statusCode: number };
  }

  it('la ventana es una constante nombrada de UNA hora', () => {
    expect(VENTANA_DEDUP_MS).toBe(3_600_000);
  });

  it('10.000 → 1 fila (veces 10000); función distinta → 2; otra ventana → 3; todas 403 y sin esperar la bitácora', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-10T15:10:00Z') });
    resolverMock.mockResolvedValue(ok(['pagina.dashboard']));
    const req = { user: { sub: 7, username: 'ana', role: 'gestor' }, method: 'POST', originalUrl: '/x' } as unknown as Request;
    const next = vi.fn();

    const soat = exigirFuncion('soat.solicitud.crear');
    const inicio = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const res = res403();
      await soat(req, res, next);
      if (res.statusCode !== 403) throw new Error(`respuesta ${res.statusCode} en la vuelta ${i}`);
    }
    expect(performance.now() - inicio).toBeLessThan(5_000);
    expect(next).not.toHaveBeenCalled();
    let tabla = filasPorClave();
    expect(tabla.size).toBe(1);
    expect([...tabla.values()][0]).toBe(10_000);
    // El escritor no bloqueó la respuesta: cada vuelta terminó en 403 sin resolver su promesa.
    expect(insertMock).toHaveBeenCalledTimes(10_000);

    await exigirFuncion('tramite.lote.crear')(req, res403(), next);
    tabla = filasPorClave();
    expect(tabla.size).toBe(2);

    vi.setSystemTime(new Date('2026-09-10T16:10:00Z')); // más allá de la ventana
    await soat(req, res403(), next);
    tabla = filasPorClave();
    expect(tabla.size).toBe(3);
    const claves = [...tabla.keys()];
    expect(claves[0]).toBe('7|soat.solicitud.crear|2026-09-10T15:00:00.000Z');
    expect(claves[2]).toBe('7|soat.solicitud.crear|2026-09-10T16:00:00.000Z');
  });
});

describe('TC #12267 AC6 — si la escritura de la bitácora falla, la respuesta sigue siendo 403 y no hay unhandledRejection', () => {
  it('responde el mismo 403 ANTES de que la bitácora se resuelva; log.warn sin PII; ningún unhandledRejection', async () => {
    escrituraFalla = new Error('disco lleno');
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const sinDueno: unknown[] = [];
    const escucha = (e: unknown) => { sinDueno.push(e); };
    process.on('unhandledRejection', escucha);
    try {
      const r = await request(laboratorio()).post('/x').send({});
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: 'Su rol no tiene esa función («Radicar una solicitud de SOAT»).',
        funcion: 'soat.solicitud.crear', motivo: 'sin_funcion',
      });
      expect(handler).not.toHaveBeenCalled();
      await tick(); await tick();
      expect(sinDueno).toEqual([]);
      expect(warnMock).toHaveBeenCalledTimes(1);
      const [meta] = warnMock.mock.calls[0]!;
      expect(meta).toMatchObject({ userId: 7, err: 'disco lleno' });
      expect(JSON.stringify(warnMock.mock.calls[0])).not.toMatch(/ana\.perez|ejemplo\.test/);
    } finally {
      process.off('unhandledRejection', escucha);
    }
  });

  it('el 403 se envía sin esperar la escritura: con una bitácora que nunca resuelve, la respuesta llega igual', async () => {
    insertMock.mockImplementationOnce(() => {
      const t = { values: () => t, onConflictDoUpdate: () => t, then: () => new Promise(() => undefined), catch: () => new Promise(() => undefined) };
      return t as never;
    });
    resolverMock.mockResolvedValue(ok(['soat.cola.ver']));
    const r = await request(laboratorio()).post('/x').send({});
    expect(r.status).toBe(403);
  });
});
