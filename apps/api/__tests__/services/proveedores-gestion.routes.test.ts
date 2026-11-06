// Feature #14324 (HU #14332, #14333, #14334, #14335) — rutas de `/api/flito/parametrizacion/proveedores`.
// Servicios mockeados: permiso, validación, mapeo HTTP, cabeceras y bitácora. Corre en CI, sin base. Las reglas contra
// PostgreSQL están en `db/proveedores-gestion.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => ({
  listar: vi.fn(), selector: vi.fn(), asignables: vi.fn(), detalle: vi.fn(), crear: vi.fn(), existe: vi.fn(), editar: vi.fn(), quitar: vi.fn(),
  impacto: vi.fn(), estado: vi.fn(), eliminar: vi.fn(), historial: vi.fn(), audit: vi.fn(), pii: vi.fn(),
  sesion: vi.fn(), permisos: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/shared/pii-audit.js', async (o) => ({ ...(await o<typeof import('../../src/shared/pii-audit.js')>()), logPiiAccess: m.pii }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/auth.js', async (o) => ({ ...(await o<typeof import('../../src/shared/middleware/auth.js')>()), invalidateSessionCacheFor: m.sesion }));
vi.mock('../../src/shared/permisos-efectivos.js', async (o) => ({ ...(await o<typeof import('../../src/shared/permisos-efectivos.js')>()), invalidarPermisosDe: m.permisos }));

const DIR = '../../src/modules/flito-parametrizacion';
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores.service.js', async (o) => ({
  ...(await o<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores.service.js')>()),
  listarProveedores: m.listar, selectorProveedores: m.selector, proveedoresAsignablesAUsuario: m.asignables,
  detalleProveedor: m.detalle, crearProveedor: m.crear, existeProveedor: m.existe,
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-edicion.service.js', () => ({ editarProveedor: m.editar }));
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-servicios.service.js', async (o) => ({
  ...(await o<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores-servicios.service.js')>()), quitarServicio: m.quitar,
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js', async (o) => ({
  ...(await o<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js')>()), impactoProveedor: m.impacto, cambiarEstadoProveedor: m.estado,
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js', async (o) => ({
  ...(await o<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores-eliminar.service.js')>()), eliminarProveedor: m.eliminar,
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-proveedores-auditoria.js', async (o) => ({
  ...(await o<typeof import('../../src/modules/flito-parametrizacion/flito-proveedores-auditoria.js')>()), historialProveedor: m.historial,
}));

const svc = await import(`${DIR}/flito-proveedores.service.js`);
const { ServicioNoQuitableError } = await import(`${DIR}/flito-proveedores-servicios.service.js`);
const { ProveedorLogisticaAsignadoError } = await import(`${DIR}/flito-logistica-proveedor-compania.service.js`);
const { ProveedorNoEliminableError } = await import(`${DIR}/flito-proveedores-eliminar.service.js`);
const { EstadoProveedorCambiadoError } = await import(`${DIR}/flito-proveedores-estado.service.js`);
const { BloqueoAdministracionError } = await import('../../src/shared/permisos-anti-bloqueo.js');
const { valorAuditable } = await import(`${DIR}/flito-proveedores-auditoria.js`);

const ID = 'c0000000-0000-4000-8000-000000014324';
const BASE = '/api/flito/parametrizacion/proveedores';
const GENERALES = {
  nombre: 'Mensajería Uno', nit: '900.123.456-7', telefono: '3001234567', correo: 'a@empresa.co',
  direccion: 'Calle 1', ciudad: 'Cali', contacto: 'Ana Ruiz',
};
const SOAT = { estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24 };
const ITEM = { id: ID, nombre: 'Mensajería Uno', nit: '900123456-7', servicios: ['logistica'], activo: true, companiasPorServicio: {}, datosCompletos: true, umbralOcr: null, slaHoras: null, version: 2 };

async function app() {
  const a = express(); a.use(express.json());
  a.use(BASE, (await import(`${DIR}/flito-proveedores.routes.js`)).default);
  return a;
}
const con = (...funciones: string[]) => testToken({ sub: 1, role: 'admin', funciones }).then((t) => `Bearer ${t}`);
const LISTAR = 'parametrizacion.proveedores.listar';
const CREAR = 'parametrizacion.proveedores.crear';
const EDITAR = 'parametrizacion.proveedores.editar';
const ESTADO = 'parametrizacion.proveedores.estado';
const ELIMINAR = 'parametrizacion.proveedores.eliminar';
const HISTORIAL = 'parametrizacion.proveedores.historial';

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.audit.mockResolvedValue(undefined); m.pii.mockResolvedValue(undefined); m.existe.mockResolvedValue(true);
});

const RUTAS: readonly ['get' | 'post' | 'patch' | 'delete', string, string][] = [
  ['get', '', LISTAR], ['get', '/selector?servicio=soat', LISTAR], ['get', '/asignables-usuario', LISTAR], ['get', `/${ID}`, LISTAR],
  ['post', '', CREAR], ['patch', `/${ID}`, EDITAR], ['delete', `/${ID}/servicios/soat`, EDITAR], ['get', `/${ID}/impacto`, ESTADO],
  ['patch', `/${ID}/estado`, ESTADO], ['delete', `/${ID}`, ELIMINAR], ['get', `/${ID}/historial`, HISTORIAL],
];

describe('HU #14332 AC10 — cerrada a enlaces y a quien no tiene la función', () => {
  it.each(RUTAS)('%s %s con enlace proveedor → 403 Sin permisos', async (metodo, ruta, funcion) => {
    const t = await testToken({ sub: 77, role: 'proveedor', funciones: [funcion] });
    const r = await request(await app())[metodo](BASE + ruta).set('Authorization', `Bearer ${t}`).send({});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
  });
  it.each(['transito', 'cliente'] as const)('enlace %s → 403 Sin permisos', async (role) => {
    const t = await testToken({ sub: 78, role, funciones: [LISTAR], ...(role === 'transito' ? { transitoCodigo: '05001' } : {}) });
    const r = await request(await app()).get(BASE).set('Authorization', `Bearer ${t}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
  });
  it.each(RUTAS)('%s %s sin la función → 403 y el servicio no se consulta', async (metodo, ruta) => {
    const t = await testToken({ sub: 2, role: 'financiera', funciones: ['clients.clientes.ver'] });
    const r = await request(await app())[metodo](BASE + ruta).set('Authorization', `Bearer ${t}`).send({});
    expect(r.status).toBe(403);
    for (const f of [m.listar, m.crear, m.editar, m.quitar, m.eliminar, m.historial, m.impacto, m.estado]) expect(f).not.toHaveBeenCalled();
  });
  it('sin token → 401', async () => {
    expect((await request(await app()).get(BASE)).status).toBe(401);
  });
  it('app.ts monta el router sin conAlcance y antes del general', () => {
    const fuente = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    expect(fuente).toContain("app.use('/api/flito/parametrizacion/proveedores', flitoProveedoresRoutes);");
    expect(fuente.indexOf('flitoProveedoresRoutes);')).toBeLessThan(fuente.indexOf("app.use('/api/flito/parametrizacion', flitoParametrizacionRoutes)"));
  });
});

describe('HU #14334 — las rutas viejas de escritura y el listado unificado ya no existen', () => {
  const VIEJAS: readonly ['get' | 'post' | 'patch' | 'delete', string][] = [
    ['get', '/proveedores'],
    ['post', '/proveedores-soat'], ['patch', `/proveedores-soat/${ID}`], ['patch', `/proveedores-soat/${ID}/estado`], ['delete', `/proveedores-soat/${ID}`],
    ['post', '/proveedores-logistica'], ['patch', `/proveedores-logistica/${ID}`], ['patch', `/proveedores-logistica/${ID}/estado`], ['delete', `/proveedores-logistica/${ID}`],
  ];
  it.each(VIEJAS)('%s %s → 404', async (metodo, ruta) => {
    const a = express(); a.use(express.json());
    const PAR = '/api/flito/parametrizacion';
    a.use(`${PAR}/proveedores-logistica`, (await import(`${DIR}/flito-proveedores-logistica.routes.js`)).default);
    a.use(PAR, (await import(`${DIR}/flito-parametrizacion.routes.js`)).default);
    const t = await con(LISTAR, CREAR, EDITAR, ESTADO, ELIMINAR);
    expect((await request(a)[metodo](PAR + ruta).set('Authorization', t).send({})).status).toBe(404);
  });
});

describe('HU #14332 — POST /', () => {
  it('AC1: 201, normaliza el NIT y deja en la bitácora solo id y nombre (#14335 AC4)', async () => {
    m.crear.mockResolvedValue(ITEM);
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios: ['soat', 'logistica'], soat: SOAT });
    expect(r.status).toBe(201);
    expect(m.crear.mock.calls[0]![0]).toEqual({ generales: { ...GENERALES, nit: '900123456-7' }, servicios: ['soat', 'logistica'], soat: SOAT });
    const entrada = m.audit.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'create', resource: 'flito_proveedor', resourceId: ID, detail: `Proveedor Mensajería Uno (${ID})` });
    expect(JSON.stringify(entrada)).not.toMatch(/3001234567|a@empresa|Calle 1|Ana Ruiz/);
  });
  it.each([[undefined], [[]]])('AC2: servicios %j → 422 Marque al menos un servicio y no se crea', async (servicios) => {
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Marque al menos un servicio');
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('AC3: indica todos los campos que faltan, y un texto en blanco cuenta como faltante', async () => {
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR))
      .send({ generales: { nombre: 'X', nit: '900123456', telefono: '   ' }, servicios: ['logistica'] });
    expect(r.status).toBe(422);
    expect(r.body.campos).toEqual(['telefono', 'correo', 'direccion', 'ciudad', 'contacto']);
    expect(m.crear).not.toHaveBeenCalled();
  });
  it.each(Object.keys(GENERALES))('AC3: sin %s → 422 con ese campo', async (campo) => {
    const { [campo as keyof typeof GENERALES]: _fuera, ...resto } = GENERALES;
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: resto, servicios: ['logistica'] });
    expect(r.status).toBe(422);
    expect(r.body.campos).toEqual([campo]);
  });
  it('AC4: datos de SOAT fuera de su bloque se rechazan', async () => {
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios: ['logistica'], umbralOcr: 0.5 });
    expect(r.status).toBe(422);
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('los datos de SOAT son opcionales: sin ellos, o solo con parte, llega al servicio', async () => {
    m.crear.mockResolvedValue(ITEM);
    const t = await con(CREAR);
    expect((await request(await app()).post(BASE).set('Authorization', t).send({ generales: GENERALES, servicios: ['soat'] })).status).toBe(201);
    expect(m.crear.mock.calls[0]![0]).not.toHaveProperty('soat');
    expect((await request(await app()).post(BASE).set('Authorization', t).send({ generales: GENERALES, servicios: ['soat'], soat: { slaHoras: 24 } })).status).toBe(201);
    expect(m.crear.mock.calls[1]![0].soat).toEqual({ slaHoras: 24 });
    expect((await request(await app()).post(BASE).set('Authorization', t).send({ generales: GENERALES, servicios: ['soat'], soat: { umbralOcr: 2 } })).status).toBe(422);
  });
  it('PATCH admite estrategia vacía para limpiarla', async () => {
    m.editar.mockResolvedValue(ITEM);
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, soat: { estrategia: '' } });
    expect(r.status).toBe(200);
    expect(m.editar.mock.calls[0]![1].soat).toEqual({ estrategia: '' });
  });
  it('AC4: el error del servicio se traduce a 422', async () => {
    m.crear.mockRejectedValue(new svc.DatosSoatInvalidosError(svc.MENSAJE_SOAT_SIN_SERVICIO));
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios: ['logistica'], soat: SOAT });
    expect(r.status).toBe(422);
  });
  it.each([['900-12', 'demasiado corto'], ['ABC123456', 'con letras'], ['   ', 'en blanco']])('AC3: NIT %j (%s) → 422 con el campo', async (nit) => {
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: { ...GENERALES, nit }, servicios: ['logistica'] });
    expect(r.status).toBe(422);
    expect(r.body.campos).toEqual(['nit']);
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('POST no recibe activo: todo proveedor nace activo', async () => {
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios: ['logistica'], activo: false });
    expect(r.status).toBe(422);
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('AC5: el 409 trae el nombre del otro y no toca la bitácora', async () => {
    m.crear.mockRejectedValue(new svc.ProveedorDuplicadoError('Ya existe un proveedor con ese NIT: Mensajería Uno', 'nit'));
    const r = await request(await app()).post(BASE).set('Authorization', await con(CREAR)).send({ generales: GENERALES, servicios: ['logistica'] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Ya existe un proveedor con ese NIT: Mensajería Uno', campo: 'nit' });
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('HU #14332 — PATCH /:id', () => {
  it('AC7: sin versionEsperada se rechaza', async () => {
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ generales: GENERALES });
    expect(r.status).toBe(422);
    expect(m.editar).not.toHaveBeenCalled();
  });
  it('AC7: la versión anterior → 409 PROVEEDOR_EDITADO_POR_OTRO', async () => {
    m.editar.mockRejectedValue(new svc.ProveedorEditadoPorOtroError());
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, soat: { umbralOcr: 0.5 } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Otro usuario cambió este proveedor. Recarga para ver sus datos', code: 'PROVEEDOR_EDITADO_POR_OTRO' });
  });
  it('AC6: editar solo SOAT no exige datos generales', async () => {
    m.editar.mockResolvedValue(ITEM);
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, soat: { umbralOcr: 0.5 } });
    expect(r.status).toBe(200);
    expect(m.editar.mock.calls[0]!.slice(0, 2)).toEqual([ID, { versionEsperada: 1, soat: { umbralOcr: 0.5 } }]);
  });
  it('AC6: editar el bloque exige todos los campos: 422 con los que faltan', async () => {
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, generales: { nombre: 'Nuevo' } });
    expect(r.status).toBe(422);
    expect(r.body.campos).toEqual(['nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto']);
    expect(m.editar).not.toHaveBeenCalled();
  });
  it('el estado no se cambia por aquí: `activo` en el cuerpo → 422 sin escribir (antes HU #13958 AC5)', async () => {
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, activo: false });
    expect(r.status).toBe(422);
    expect(m.editar).not.toHaveBeenCalled();
  });
  it('datos y servicios van en la misma llamada', async () => {
    m.editar.mockResolvedValue(ITEM);
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 3, generales: GENERALES, servicios: ['soat'], soat: SOAT });
    expect(r.status).toBe(200);
    expect(m.editar).toHaveBeenCalledTimes(1);
    expect(m.editar.mock.calls[0]![1]).toEqual({ versionEsperada: 3, generales: { ...GENERALES, nit: '900123456-7' }, servicios: ['soat'], soat: SOAT });
  });
  it('agregar un servicio sin datos generales → 422 con los campos (decisión del humano)', async () => {
    m.editar.mockRejectedValue(new svc.GeneralesIncompletosError(['nit', 'correo']));
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, servicios: ['soat', 'logistica'] });
    expect(r.status).toBe(422);
    expect(r.body.campos).toEqual(['nit', 'correo']);
  });
  it('servicios vacío → 422 con el mensaje de la épica; servicio desconocido → 422', async () => {
    let r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, servicios: [] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Marque al menos un servicio');
    r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, servicios: ['grua'] });
    expect(r.status).toBe(422);
    expect(m.editar).not.toHaveBeenCalled();
  });
  it('id no uuid → 400; inexistente → 404', async () => {
    const t = await con(EDITAR);
    expect((await request(await app()).patch(`${BASE}/xx`).set('Authorization', t).send({ versionEsperada: 1 })).status).toBe(400);
    m.editar.mockRejectedValue(new svc.ProveedorNoEncontradoError());
    expect((await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', t).send({ versionEsperada: 1 })).status).toBe(404);
  });
});

describe('HU #14332 — lecturas', () => {
  it('AC8: lista con filtro por servicio y estado; filtro desconocido → 400', async () => {
    m.listar.mockResolvedValue([ITEM]);
    const t = await con(LISTAR);
    const r = await request(await app()).get(`${BASE}?servicio=soat&activo=false`).set('Authorization', t);
    expect(r.status).toBe(200);
    expect(m.listar).toHaveBeenCalledWith({ servicio: 'soat', activo: false });
    expect((await request(await app()).get(`${BASE}?servicio=grua`).set('Authorization', t)).status).toBe(400);
  });
  it('AC9: detalle con logPiiAccess y Cache-Control: no-store', async () => {
    m.detalle.mockResolvedValue({ ...ITEM, telefono: '3001234567' });
    const r = await request(await app()).get(`${BASE}/${ID}`).set('Authorization', await con(LISTAR));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(m.pii).toHaveBeenCalledTimes(1);
    expect(m.pii.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_proveedor', accion: 'read', camposAccedidos: expect.arrayContaining(['telefono', 'correo', 'direccion', 'contacto']) });
  });
  it('un inexistente no registra acceso a PII', async () => {
    m.detalle.mockRejectedValue(new svc.ProveedorNoEncontradoError());
    expect((await request(await app()).get(`${BASE}/${ID}`).set('Authorization', await con(LISTAR))).status).toBe(404);
    expect(m.pii).not.toHaveBeenCalled();
  });
  it('selector exige el servicio', async () => {
    const t = await con(LISTAR);
    expect((await request(await app()).get(`${BASE}/selector`).set('Authorization', t)).status).toBe(400);
    m.selector.mockResolvedValue([{ id: ID, nombre: 'X' }]);
    expect((await request(await app()).get(`${BASE}/selector?servicio=logistica`).set('Authorization', t)).body).toEqual([{ id: ID, nombre: 'X' }]);
  });
});

describe('HU #14333 — DELETE /:id/servicios/:servicio', () => {
  it('AC5: 409 con el texto compuesto y las cantidades por motivo', async () => {
    const bloqueos = [{ motivo: 'companias', cantidad: 2, texto: '2 compañías asignadas' }];
    m.quitar.mockRejectedValue(new ServicioNoQuitableError('soat', '2 compañías asignadas', bloqueos));
    const r = await request(await app()).delete(`${BASE}/${ID}/servicios/soat`).set('Authorization', await con(EDITAR));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'No puede quitar SOAT: 2 compañías asignadas', servicio: 'soat', bloqueos });
  });
  it('AC4: último servicio → 422', async () => {
    m.quitar.mockRejectedValue(new svc.ProveedorSinServicioError());
    const r = await request(await app()).delete(`${BASE}/${ID}/servicios/logistica`).set('Authorization', await con(EDITAR));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Marque al menos un servicio');
  });
  it('servicio desconocido → 400; éxito audita solo id y nombre', async () => {
    const t = await con(EDITAR);
    expect((await request(await app()).delete(`${BASE}/${ID}/servicios/grua`).set('Authorization', t)).status).toBe(400);
    m.quitar.mockResolvedValue(ITEM);
    expect((await request(await app()).delete(`${BASE}/${ID}/servicios/soat`).set('Authorization', t)).status).toBe(200);
    expect(m.audit.mock.calls[0]![1].detail).toBe(`Proveedor Mensajería Uno (${ID})`);
  });
});

describe('HU #14334 — estado, impacto y eliminar', () => {
  it('AC1: 409 con las compañías', async () => {
    m.estado.mockRejectedValue(new ProveedorLogisticaAsignadoError(['A', 'B']));
    const r = await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', await con(ESTADO)).send({ activo: false, versionEsperada: 1 });
    expect(r.status).toBe(409);
    expect(r.body.companias).toEqual(['A', 'B']);
    expect(r.body.error).toContain('2 compañías');
    expect(r.body.error).toContain('Asigne otro proveedor primero.');
  });
  it('AC4: sin versión se rechaza; versión anterior → 409 con el código', async () => {
    const t = await con(ESTADO);
    expect((await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', t).send({ activo: false })).status).toBe(422);
    m.estado.mockRejectedValue(new svc.ProveedorEditadoPorOtroError());
    const r = await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', t).send({ activo: false, versionEsperada: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PROVEEDOR_EDITADO_POR_OTRO');
  });
  it('inactivar limpia la caché de sesión y de permisos de sus usuarios', async () => {
    m.estado.mockResolvedValue({ item: ITEM, usuariosInvalidados: [5, 6] });
    const r = await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', await con(ESTADO)).send({ activo: false, versionEsperada: 1 });
    expect(r.status).toBe(200);
    expect(m.sesion.mock.calls.map((c) => c[0])).toEqual([5, 6]);
    expect(m.permisos.mock.calls.map((c) => c[0])).toEqual([5, 6]);
  });
  it('AC5: impacto', async () => {
    m.impacto.mockResolvedValue({ activo: true, sesionesAfectadas: 3 });
    const r = await request(await app()).get(`${BASE}/${ID}/impacto`).set('Authorization', await con(ESTADO));
    expect(r.body).toMatchObject({ sesionesAfectadas: 3 });
  });
  it('AC6: eliminar limpia cachés y audita solo id y nombre', async () => {
    m.eliminar.mockResolvedValue({ id: ID, nombre: 'Uno', usuariosDesactivados: [9] });
    const r = await request(await app()).delete(`${BASE}/${ID}`).set('Authorization', await con(ELIMINAR));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, eliminado: true });
    expect(m.sesion).toHaveBeenCalledWith(9);
    expect(m.audit.mock.calls[0]![1]).toMatchObject({ action: 'delete', detail: `Proveedor Uno (${ID})` });
  });
  it('otro lo eliminó mientras se esperaba el bloqueo → 409; inexistente → 404; seguro anti-bloqueo → 409 con `funcion`; id no uuid → 400', async () => {
    const t = await con(ELIMINAR);
    m.eliminar.mockRejectedValueOnce(new EstadoProveedorCambiadoError());
    const carrera = await request(await app()).delete(`${BASE}/${ID}`).set('Authorization', t);
    expect(carrera.status).toBe(409);
    expect(carrera.body.error).toBe('Otro administrador ya cambió su estado');
    m.eliminar.mockRejectedValueOnce(new svc.ProveedorNoEncontradoError());
    expect((await request(await app()).delete(`${BASE}/${ID}`).set('Authorization', t)).status).toBe(404);
    m.eliminar.mockRejectedValueOnce(new BloqueoAdministracionError('usuarios.usuario.editar'));
    const bloqueo = await request(await app()).delete(`${BASE}/${ID}`).set('Authorization', t);
    expect(bloqueo.status).toBe(409);
    expect(bloqueo.body.funcion).toBe('usuarios.usuario.editar');
    expect(m.audit).not.toHaveBeenCalled();
    m.eliminar.mockClear();
    expect((await request(await app()).delete(`${BASE}/xx`).set('Authorization', t)).status).toBe(400);
    expect(m.eliminar).not.toHaveBeenCalled();
  });
  it('estado: inexistente → 404; id no uuid → 400; `activoEsperado` ya no se acepta', async () => {
    const t = await con(ESTADO);
    m.estado.mockRejectedValueOnce(new svc.ProveedorNoEncontradoError());
    expect((await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', t).send({ activo: false, versionEsperada: 1 })).status).toBe(404);
    expect((await request(await app()).patch(`${BASE}/xx/estado`).set('Authorization', t).send({ activo: false, versionEsperada: 1 })).status).toBe(400);
    expect((await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', t).send({ activo: false, versionEsperada: 1, activoEsperado: true })).status).toBe(422);
  });
  it('AC7: con bloqueos → 409 con el motivo', async () => {
    m.eliminar.mockRejectedValue(new ProveedorNoEliminableError('Primero debe desactivarlo.'));
    const r = await request(await app()).delete(`${BASE}/${ID}`).set('Authorization', await con(ELIMINAR));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Primero debe desactivarlo.');
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe('HU #14334 — motivo de no inactivar', () => {
  it('en usted, con hasta 3 nombres y «y N más»; el total y la lista completa se conservan', () => {
    const e = new ProveedorLogisticaAsignadoError(['A', 'B', 'C', 'D', 'E']);
    expect(e.message).toBe('No se puede inactivar: está asignado a 5 compañías (A, B, C y 2 más). Asigne otro proveedor primero.');
    expect(e.companias).toHaveLength(5);
    expect(new ProveedorLogisticaAsignadoError(['A', 'B', 'C']).message).toContain('(A, B, C)');
  });
});

describe('HU #14335 AC4 — el detalle de audit() solo lleva identificador y nombre', () => {
  const SIN_PII = /3001234567|a@empresa|Calle 1|Ana Ruiz|900\.?123/;
  it('PATCH /:id', async () => {
    m.editar.mockResolvedValue(ITEM);
    const r = await request(await app()).patch(`${BASE}/${ID}`).set('Authorization', await con(EDITAR)).send({ versionEsperada: 1, generales: GENERALES });
    expect(r.status).toBe(200);
    const entrada = m.audit.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'update', resource: 'flito_proveedor', resourceId: ID, detail: `Proveedor Mensajería Uno (${ID})` });
    expect(JSON.stringify(entrada)).not.toMatch(SIN_PII);
  });
  it('PATCH /:id/estado', async () => {
    m.estado.mockResolvedValue({ item: ITEM, usuariosInvalidados: [] });
    const r = await request(await app()).patch(`${BASE}/${ID}/estado`).set('Authorization', await con(ESTADO)).send({ activo: false, versionEsperada: 1 });
    expect(r.status).toBe(200);
    const entrada = m.audit.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'update', resource: 'flito_proveedor', resourceId: ID, detail: `Proveedor Mensajería Uno (${ID})` });
    expect(JSON.stringify(entrada)).not.toMatch(SIN_PII);
  });
});

describe('HU #14335 — historial y máscaras', () => {
  it('AC6: con la función, 200 y no-store', async () => {
    m.historial.mockResolvedValue([{ id: 'a', accion: 'crear' }]);
    const r = await request(await app()).get(`${BASE}/${ID}/historial`).set('Authorization', await con(HISTORIAL));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual([{ id: 'a', accion: 'crear' }]);
  });
  it('un proveedor inexistente → 404', async () => {
    m.existe.mockResolvedValue(false);
    expect((await request(await app()).get(`${BASE}/${ID}/historial`).set('Authorization', await con(HISTORIAL))).status).toBe(404);
  });
  it('AC7: la 0292 siembra la función solo a admin y auditor', () => {
    const s = readFileSync(new URL('../../src/db/migrations/0292_flito_proveedores_permiso_historial.sql', import.meta.url), 'utf8');
    expect(s).toContain("('admin', 'parametrizacion.proveedores.historial')");
    expect(s).toContain("('auditor', 'parametrizacion.proveedores.historial')");
    expect(s).not.toMatch(/'(proveedor|financiera|mensajero)'/);
  });
  it('AC3: ningún valor de los campos enmascarados sale en claro; nombre y ciudad sí', () => {
    const casos: [string, string][] = [['telefono', '3001234567'], ['correo', 'persona.real@empresa.co'], ['direccion', 'Calle 10 # 20-30'], ['contacto', 'Ana Ruiz'], ['nit', '900123456-7']];
    for (const [campo, valor] of casos) {
      const m2 = valorAuditable(campo as 'telefono', valor);
      expect(m2).not.toBe(valor);
      expect(m2).not.toContain(valor);
    }
    expect(valorAuditable('correo', 'persona.real@empresa.co')).not.toContain('persona.real');
    expect(valorAuditable('ciudad', 'Cali')).toBe('Cali');
    expect(valorAuditable('telefono', null)).toBeNull();
    expect(valorAuditable('telefono', '4441234')).toBe('*****34');
  });
});
