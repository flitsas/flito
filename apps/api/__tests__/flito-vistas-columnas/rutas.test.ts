// ADR-0045 — rutas de vistas de columnas con supertest. Cubre HTTP: 401 sin token, 404 tabla desconocida,
// 403 por función de tabla (guarda) y por `tramites.vistas_columnas.administrar` en la predeterminada general
// (función de permiso, nunca el nombre del rol: HU #13425 AC6), 400 de Zod
// sin llamar al servicio, y el mapeo de errores de dominio a estado y `codigo`.
// La guarda de función y el servicio van como dobles: la lógica de permisos y de datos la prueba
// `servicio.pg.test.ts` (BD real) y `reglas.test.ts`. Aquí solo se prueba el contrato HTTP.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { neutralizarEnlaceDe, testToken } from '../helpers/auth.js';

// La frontera por enlace (authMiddleware) cierra al rol proveedor las escrituras de módulos fuera de su enlace;
// aquí se prueba la capa de la ruta (función, Zod), así que el enlace de proveedor se neutraliza.
neutralizarEnlaceDe('proveedor');

const concedidas = vi.hoisted(() => ({ set: new Set<string>() }));
const servicio = vi.hoisted(() => ({
  listarVistas: vi.fn(),
  crearVista: vi.fn(),
  actualizarVista: vi.fn(),
  borrarVista: vi.fn(),
  fijarPredeterminadaPersonal: vi.fn(),
  fijarPredeterminadaGeneral: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

// Guarda de función: passthrough si la función está concedida; 403 si no. Mismo contrato que exigirFuncion.
vi.mock('../../src/shared/middleware/exigir-funcion.js', () => ({
  exigirFuncion: (codigo: string) => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (concedidas.set.has(codigo)) next();
    else res.status(403).json({ error: 'Su rol no tiene esa función.', [codigo]: true });
  },
  funcionesConcedidas: async (_req: unknown, codigos: readonly string[]) => new Set(codigos.filter((c) => concedidas.set.has(c))),
  tieneFuncion: async (_req: unknown, codigo: string) => concedidas.set.has(codigo),
}));

const ADMINISTRAR = 'tramites.vistas_columnas.administrar';

vi.mock('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.service.js')>();
  return { ...actual, ...servicio };
});

describe('ADR-0045 rutas de vistas de columnas (HTTP)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  const BASE = '/api/flito/vistas-columnas/flito-tramites';

  beforeEach(async () => {
    vi.clearAllMocks();
    concedidas.set = new Set(['tramites.cola.ver']);
    if (!app) {
      const { createApp } = await import('../../src/app.js');
      app = createApp();
    }
  });

  it('sin token responde 401 y no llama al servicio', async () => {
    const r = await request(app).get(BASE);
    expect(r.status).toBe(401);
    expect(servicio.listarVistas).not.toHaveBeenCalled();
  });

  it('tabla que no existe en el catálogo: 404 TABLA_NO_ENCONTRADA', async () => {
    const r = await request(app).get('/api/flito/vistas-columnas/otra-tabla').set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`);
    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('TABLA_NO_ENCONTRADA');
  });

  it('sin la función de la tabla: 403 de la guarda, el servicio no se ejecuta', async () => {
    concedidas.set = new Set();
    const r = await request(app).get(BASE).set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`);
    expect(r.status).toBe(403);
    expect(servicio.listarVistas).not.toHaveBeenCalled();
  });

  it('GET con permiso devuelve la respuesta del servicio', async () => {
    servicio.listarVistas.mockResolvedValue({ tablaId: 'flito-tramites', vistas: [] });
    const r = await request(app).get(BASE).set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tablaId: 'flito-tramites', vistas: [] });
  });

  it('POST con nombre vacío: 400 por Zod y el servicio no se llama', async () => {
    const r = await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ nombre: '', alcance: 'personal', columnas: ['fuente'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(servicio.crearVista).not.toHaveBeenCalled();
  });

  it('POST con más de 30 columnas: 400 por Zod', async () => {
    const columnas = Array.from({ length: 31 }, (_, i) => `c${i}`);
    const r = await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ nombre: 'Muchas', alcance: 'personal', columnas });
    expect(r.status).toBe(400);
    expect(servicio.crearVista).not.toHaveBeenCalled();
  });

  it('POST válido: 201 con id y version', async () => {
    servicio.crearVista.mockResolvedValue({ id: 7, version: 1 });
    const r = await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ nombre: 'Cobranza', alcance: 'personal', columnas: ['fuente'] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 7, version: 1 });
  });

  it('mapea COLUMNA_NO_PERMITIDA a 403 con su codigo', async () => {
    const { ColumnaNoPermitidaError } = await import('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.service.js');
    servicio.crearVista.mockRejectedValue(new ColumnaNoPermitidaError(['correo']));
    const r = await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ nombre: 'Con correo', alcance: 'personal', columnas: ['correo'] });
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('COLUMNA_NO_PERMITIDA');
  });

  it('mapea CLAVE_DESCONOCIDA a 422 y VERSION_CONFLICTO a 409', async () => {
    const { ClaveDesconocidaError, VersionConflictoError } = await import('../../src/modules/flito-vistas-columnas/flito-vistas-columnas.service.js');
    const token = `Bearer ${await testToken({ role: 'proveedor' })}`;
    servicio.crearVista.mockRejectedValue(new ClaveDesconocidaError(['x']));
    const a = await request(app).post(`${BASE}/vistas`).set('Authorization', token).send({ nombre: 'a', alcance: 'personal', columnas: ['x'] });
    expect(a.status).toBe(422);
    expect(a.body.codigo).toBe('CLAVE_DESCONOCIDA');

    servicio.actualizarVista.mockRejectedValue(new VersionConflictoError());
    const b = await request(app).put(`${BASE}/vistas/7`).set('Authorization', token).send({ nombre: 'b', version: 1 });
    expect(b.status).toBe(409);
    expect(b.body.codigo).toBe('VERSION_CONFLICTO');
  });

  it('PUT vista con id no numérico: 400 por Zod', async () => {
    const r = await request(app).put(`${BASE}/vistas/abc`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ nombre: 'x', version: 1 });
    expect(r.status).toBe(400);
    expect(servicio.actualizarVista).not.toHaveBeenCalled();
  });

  it('predeterminada general: sin `tramites.vistas_columnas.administrar` responde 403 y el servicio no se llama (aunque el token diga admin)', async () => {
    const r = await request(app).put(`${BASE}/predeterminada/general`)
      .set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`)
      .send({ vistaId: 7 });
    expect(r.status).toBe(403);
    expect(r.body[ADMINISTRAR]).toBe(true);
    expect(servicio.fijarPredeterminadaGeneral).not.toHaveBeenCalled();
  });

  it('predeterminada general: con la función llega al servicio con puedeAdministrar=true y recibe 200', async () => {
    concedidas.set.add(ADMINISTRAR);
    servicio.fijarPredeterminadaGeneral.mockResolvedValue(undefined);
    const r = await request(app).put(`${BASE}/predeterminada/general`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ vistaId: 7 });
    expect(r.status).toBe(200);
    expect(servicio.fijarPredeterminadaGeneral).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ puedeAdministrar: true }), 7);
  });

  it('crear vista: el actor llega al servicio con puedeAdministrar según la función, no según el rol', async () => {
    servicio.crearVista.mockResolvedValue({ id: 1 });
    const cuerpo = { nombre: 'Mía', alcance: 'personal', columnas: ['fuente'] };
    await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`).send(cuerpo);
    expect(servicio.crearVista).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ puedeAdministrar: false }), expect.anything(), expect.anything());
    concedidas.set.add(ADMINISTRAR);
    await request(app).post(`${BASE}/vistas`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`).send(cuerpo);
    expect(servicio.crearVista).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ puedeAdministrar: true }), expect.anything(), expect.anything());
  });

  it('predeterminada general: cuerpo inválido (vistaId 0) responde 400', async () => {
    concedidas.set.add(ADMINISTRAR);
    const r = await request(app).put(`${BASE}/predeterminada/general`)
      .set('Authorization', `Bearer ${await testToken({ role: 'admin' })}`)
      .send({ vistaId: 0 });
    expect(r.status).toBe(400);
    expect(servicio.fijarPredeterminadaGeneral).not.toHaveBeenCalled();
  });

  it('predeterminada personal: null (restablecer) llega al servicio como sistema explícito', async () => {
    servicio.fijarPredeterminadaPersonal.mockResolvedValue(undefined);
    const r = await request(app).put(`${BASE}/predeterminada/personal`)
      .set('Authorization', `Bearer ${await testToken({ role: 'proveedor' })}`)
      .send({ vistaId: null });
    expect(r.status).toBe(200);
    expect(servicio.fijarPredeterminadaPersonal).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
  });
});
