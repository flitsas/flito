// HU #13428 AC2/AC3 — Cada endpoint exige su acción. Muestreo 200/403 POR PAR ítem/acción, por HTTP: la guarda
// real (`exigirFuncion`) sobre el resolutor real (fuente de filas de pruebas), como el de #13427. Y los routers
// REALES de las guardas que deciden en línea: contraseña ajena y propia (`users`), «Ver mis datos»
// (`GET /api/auth/perfil`), clientes (crear / editar / datos fiscales) y la compañía por grupo de campos.
// Todo 403 se decide ANTES de tocar la base (db vacía) y deja fila en la bitácora de intentos denegados.
//
// Mutantes nombrados:
//   · en `users.routes.ts`, quitar el `if` de `[propia]` → cae «sin "Cambiar mi contraseña": 403 y bitácora».
//   · en `clients.routes.ts`, decidir el PATCH solo por `editar` → cae «solo claves fiscales: basta "Datos fiscales"».
//   · en `flito-parametrizacion.routes.ts`, pedir `companias.editar` a la autogestión → cae «autogestión sin editar».
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { conCadenaEnFuente } from '../helpers/auth.js';

const selectMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', () => ({ db: { select: selectMock }, getPoolStats: vi.fn() }));
// Implementación en el constructor (sobrevive a `mockReset`): el escritor real devuelve una promesa y `decidir` le hace `.catch`.
const bitacora = vi.hoisted(() => ({ registrarIntentoDenegado: vi.fn(async (_fila: { metodo: string; codigo: string; userId: number }) => undefined) }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => bitacora);
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/logger.js', () => {
  const l = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { loggerFor: () => l, logger: l };
});
vi.mock('../../src/shared/middleware/auth.js', () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const sub = Number(req.header('x-sub'));
    req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
    next();
  },
  invalidateSessionCacheFor: vi.fn(),
  blacklistToken: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { exigirFuncion } = await import('../../src/shared/middleware/exigir-funcion.js');
const { fijarFuenteDePermisos, invalidarPermisosDe } = await import('../../src/shared/permisos-efectivos.js');
const { ACCIONES_POR_AREA, operacionesDe } = await import('../../src/modules/permisos/arbol/expansion.js');
const usuarios = (await import('../../src/modules/users/users.routes.js')).default;
const auth = (await import('../../src/modules/auth/auth.routes.js')).default;
const clientes = (await import('../../src/modules/clients/clients.routes.js')).default;
const parametrizacion = (await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js')).default;

const ACCIONES = ACCIONES_POR_AREA.administracion;
/** La operación de muestra de cada acción (la primera de su grupo) y quién NO debe tenerla: todas las acciones que no la conceden. */
const MUESTRA = ACCIONES.map((accion) => {
  const op = operacionesDe(accion).find((o) => !o.startsWith('pagina.'))!;
  return { accion, op, sin: ACCIONES.filter((a) => !operacionesDe(a).includes(op)) };
});

let conjuntos: Record<number, readonly string[]> = {};
function fijar(c: Record<number, readonly string[]>) {
  conjuntos = c;
  for (const id of Object.keys(c)) invalidarPermisosDe(Number(id));
  fijarFuenteDePermisos(conCadenaEnFuente(async (userId) => ({ rol: `rol_${userId}`, tipoEnlace: 'ninguno', excepciones: [], funcionesDelRol: [...(conjuntos[userId] ?? [])] })));
}
const filas = () => bitacora.registrarIntentoDenegado.mock.calls.map(([f]) => `${f.metodo} ${f.codigo} ${f.userId}`);

const lab = express();
lab.use((req: Request, _res: Response, next: NextFunction) => {
  const sub = Number(req.header('x-sub'));
  req.user = { sub, username: 'prueba', role: `rol_${sub}` } as Request['user'];
  next();
});
const ok = (_req: Request, res: Response) => { res.json({ ok: true }); };
MUESTRA.forEach(({ op }, i) => lab.get(`/m/${i}`, exigirFuncion(op), ok));
lab.get('/usuarios', exigirFuncion('usuarios.usuario.listar'), ok);

const app = express();
app.use(express.json());
app.use('/users', usuarios);
app.use('/auth', auth);
app.use('/clients', clientes);
app.use('/par', parametrizacion);

beforeEach(() => {
  bitacora.registrarIntentoDenegado.mockClear();
  selectMock.mockReset();
});

describe('AC2 — muestreo 200/403 por par ítem/acción (guarda real, resolutor real)', () => {
  beforeAll(() => {
    expect(MUESTRA.filter((m) => !m.op).map((m) => m.accion)).toEqual([]);
    // HU #13945: + «Activar o desactivar clientes»; HU #13954: + «Eliminar clientes»; HU #13958: + «Activar o desactivar proveedores».
    expect(MUESTRA).toHaveLength(27);
  });

  it.each(MUESTRA.map((m, i) => [m.accion, m.op, i] as const))('%s → %s', async (accion, op, i) => {
    fijar({ 1: [accion], 2: MUESTRA[i]!.sin });
    const si = await request(lab).get(`/m/${i}`).set('x-sub', '1');
    expect(si.status, `${accion} debería conceder ${op}`).toBe(200);
    const no = await request(lab).get(`/m/${i}`).set('x-sub', '2');
    expect(no.status).toBe(403);
    expect(JSON.stringify(no.body)).not.toMatch(/no reconocida/);
  });

  it('con «Usuarios: ver» y sin «Cambiar la contraseña de otro usuario»: la lista 200 y el cambio ajeno 403 (router real)', async () => {
    fijar({ 1: ['accion.usuarios.ver', 'accion.perfil.cambiar_contrasena'], 2: ['accion.usuarios.ver', 'accion.usuarios.cambiar_contrasena'] });
    expect((await request(lab).get('/usuarios').set('x-sub', '1')).status).toBe(200);
    const ajena = await request(app).patch('/users/99/password').set('x-sub', '1').send({});
    expect(ajena.status).toBe(403);
    expect(filas()).toEqual(['PATCH usuarios.contrasena.cambiar_ajena 1']);
    // Control: con la acción pasa la guarda (y el cuerpo vacío da 400, sin tocar la base).
    expect((await request(app).patch('/users/99/password').set('x-sub', '2').send({})).status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('AC3 — Perfil por permiso (routers reales)', () => {
  it('sin «Ver mis datos», `GET /api/auth/perfil` → 403 y fila en la bitácora; con ella, 200 con los datos propios', async () => {
    fijar({ 1: ['accion.perfil.cambiar_contrasena'], 2: ['accion.perfil.ver_datos'] });
    const no = await request(app).get('/auth/perfil').set('x-sub', '1');
    expect(no.status).toBe(403);
    expect(filas()).toEqual(['GET perfil.datos.ver 1']);
    expect(selectMock).not.toHaveBeenCalled();
    selectMock.mockReturnValueOnce(chain([{ name: 'Ana', username: 'ana', email: 'ana@flito.test', rolNombre: 'Operación' }]));
    const si = await request(app).get('/auth/perfil').set('x-sub', '2');
    expect(si.status).toBe(200);
    expect(si.body).toEqual({ name: 'Ana', username: 'ana', email: 'ana@flito.test', rolNombre: 'Operación' });
  });

  it('sin «Cambiar mi contraseña», la propia → 403 y fila en la bitácora; con ella pasa la guarda (cuerpo vacío → 400)', async () => {
    fijar({ 1: ['accion.perfil.ver_datos'], 2: ['accion.perfil.cambiar_contrasena'] });
    const no = await request(app).patch('/users/1/password').set('x-sub', '1').send({ currentPassword: 'x', newPassword: 'Nueva#2026' });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'Sin permisos' });
    expect(filas()).toEqual(['PATCH perfil.contrasena.cambiar 1']);
    expect((await request(app).patch('/users/2/password').set('x-sub', '2').send({})).status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — Clientes: el transitorio partido por grupo de campos (router real)', () => {
  const CREAR = 'accion.clientes.crear_editar_clientes';
  const FISCAL = 'accion.clientes.datos_fiscales';

  it('POST con claves fiscales exige crear Y datos fiscales; sin claves fiscales, solo crear', async () => {
    fijar({ 1: [CREAR], 2: [CREAR, FISCAL], 3: [FISCAL] });
    expect((await request(app).post('/clients').set('x-sub', '1').send({ personType: 'X' })).status).toBe(403);
    expect((await request(app).post('/clients').set('x-sub', '1').send({})).status).toBe(400); // pasa la guarda; falta `name`
    expect((await request(app).post('/clients').set('x-sub', '2').send({ personType: 'X' })).status).toBe(400);
    expect((await request(app).post('/clients').set('x-sub', '3').send({})).status).toBe(403);
    expect(filas()).toEqual(['POST clients.clientes.datos_fiscales 1', 'POST clients.clientes.crear 3']);
  });

  it('PATCH solo con claves fiscales: basta «Datos fiscales»; con claves generales hace falta «Crear y editar clientes»', async () => {
    fijar({ 1: [FISCAL], 2: [CREAR] });
    expect((await request(app).patch('/clients/abc').set('x-sub', '1').send({ personType: 'X' })).status).toBe(400); // pasa; luego ID inválido
    expect((await request(app).patch('/clients/abc').set('x-sub', '1').send({ name: 'Otro' })).status).toBe(403);
    expect((await request(app).patch('/clients/abc').set('x-sub', '2').send({ name: 'Otro' })).status).toBe(400);
    expect((await request(app).patch('/clients/abc').set('x-sub', '2').send({ name: 'Otro', phoneNumber: '3001234567' })).status).toBe(403);
    expect(filas()).toEqual(['PATCH clients.clientes.editar 1', 'PATCH clients.clientes.datos_fiscales 2']);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — Compañía: `PATCH /companias/:id` partido por grupo de campos (router real)', () => {
  it('autogestión con su acción y sin «Crear y editar clientes»; «SOAT sin trámite» aparte; el resto con editar', async () => {
    fijar({ 1: ['accion.clientes.autogestion'], 2: ['accion.clientes.soat_sin_tramite'], 3: ['accion.clientes.crear_editar_clientes'] });
    const id = '/par/companias/abc';
    expect((await request(app).patch(id).set('x-sub', '1').send({ soatAutogestionable: true })).status).toBe(400); // pasa; ID inválido
    const r1 = await request(app).patch(id).set('x-sub', '1').send({ soatSinTramite: true });
    expect([r1.status, r1.body]).toEqual([403, { error: 'Sin permisos', grupo: 'sinTramite' }]);
    expect((await request(app).patch(id).set('x-sub', '2').send({ soatSinTramite: true, proveedorSoatSinTramiteId: null })).status).toBe(400);
    const r2 = await request(app).patch(id).set('x-sub', '2').send({ carpetaStorage: 'x' });
    expect([r2.status, r2.body]).toEqual([403, { error: 'Sin permisos', grupo: 'general' }]);
    expect((await request(app).patch(id).set('x-sub', '3').send({ carpetaStorage: 'x' })).status).toBe(400);
    const r3 = await request(app).patch(id).set('x-sub', '3').send({ logisticaAutogestionable: false });
    expect([r3.status, r3.body]).toEqual([403, { error: 'Sin permisos', grupo: 'autogestion' }]);
    expect(filas()).toEqual([
      'PATCH parametrizacion.companias.soat_sin_tramite 1',
      'PATCH parametrizacion.companias.editar 2',
      'PATCH parametrizacion.companias.autogestion 3',
    ]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un cuerpo sin ningún campo conocido → 400 (no se decide nada)', async () => {
    fijar({ 1: ['accion.clientes.crear_editar_clientes'] });
    expect((await request(app).patch('/par/companias/7').set('x-sub', '1').send({ otro: 1 })).status).toBe(400);
    expect(filas()).toEqual([]);
  });
});
