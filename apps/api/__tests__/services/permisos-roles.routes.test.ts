// HU #12084 — Mantenimiento de roles y guardado del cuadro rol × función, por HTTP.
//
//   AC1 POST /roles: 201 y forma; Zod (código, tipoEnlace SIN default, `.strict()`); 409 por 23505;
//       400 con la lista de funciones inexistentes y sin INSERT; 400 código reservado.
//   AC2 PATCH /roles/:codigo: cambia `nombre`; `codigo`/`esSistema` → 400 por `.strict()`; `tipoEnlace`
//       con N>0 → 409; la caché del rol se invalida DESPUÉS del commit. HU #12875 (AC6): el tipo
//       interno/externo se retiró: `tipoPrincipal` en el cuerpo → 400, y ningún DTO lo devuelve.
//   AC3 DELETE /roles/:codigo: 409 «rol del sistema» sin DELETE; 409 con N; 204 con DELETE por código;
//       `borrable`/`motivoNoBorrable` del listado con el MISMO texto que el 409 (M10).
//   AC5 PUT /roles/:codigo/funciones: reescribe (DELETE + INSERT); igual conjunto → nada; aviso solo con
//       rol con enlace y función de un módulo que la frontera no le abre (RN-A1, HU #12875); vaciar el cuadro de `admin` con un solo admin → 409 (M1).
//   AC6 Cada operación deja su lote en `permisos_auditoria`: entidad, acción, campo, antes/después,
//       `rolAfectadoCodigo` y NUNCA `usuarioAfectadoId`; del actor su correo.
//
// Mock keyed (`createKeyedDb`) + espía: se afirma sobre lo ESCRITO (payload de INSERT/UPDATE, `where`
// de DELETE), no sobre lo que el mock devolvió. Lo que el mock no sabe (orden, `FOR UPDATE`, la
// cuenta real del invariante) vive en `permisos-anti-bloqueo.test.ts` y en `db/…concurrencia.test.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia, paramsDe } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const eventos: string[] = [];
const invalidarRolMock = vi.fn((codigo: string) => { eventos.push(`invalidar-rol:${codigo}`); });
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>();
  return { ...actual, invalidarPermisosDeRol: (codigo: string) => invalidarRolMock(codigo) };
});

const { default: permisosRoutes } = await import('../../src/modules/permisos/permisos.routes.js');

const espia = crearEspia(kdb);
/** DELETE capturados: el espía no los ve; se envuelve `kdb.delete` aquí. */
const borrados: { tabla: string; filtros: string[] }[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/permisos', permisosRoutes);
  return a;
}

const AHORA = new Date('2026-09-10T12:00:00Z');
const ROL = (extra: Record<string, unknown> = {}) => ({
  codigo: 'gestor_x', nombre: 'Gestor X', descripcion: null, tipoEnlace: 'ninguno', 
  esSistema: false, activo: true, createdAt: AHORA, updatedAt: AHORA, ...extra,
});
const ADMIN = ROL({ codigo: 'admin', nombre: 'Administrador', esSistema: true });
/** Lo que el invariante cuenta: alguien reúne las cuatro y ≥1 en cada una (con `n` para `usuariosDelRol`). */
// HU #13424: `todas` es la conjunción (quien reúne las cuatro); `f0..f3`, una por función.
const USERS_OK = { n: 0, todas: 1, f0: 1, f1: 1, f2: 1, f3: 1 };
const MENSAJE_409 = 'No se puede guardar: FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos.';
/** Las filas de `audit_logs` (AC8: el rechazo del seguro se registra ahí, fuera de la tx). */
const rechazos = () => espia.insertsEn('audit_logs').flatMap((m) => [m.datos].flat() as Record<string, unknown>[]);

const auditadas = () => espia.insertsEn('permisos_auditoria').flatMap((m) => m.datos as unknown as Record<string, unknown>[]);

beforeEach(async () => {
  kdb.reset();
  espia.reiniciar();
  const deleteBase = kdb.delete.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.delete.mockImplementation((tbl: unknown) => {
    const c = deleteBase(tbl);
    const original = c.where as (v: unknown) => unknown;
    c.where = (cond: unknown) => { borrados.push({ tabla: getTableName(tbl as never), filtros: paramsDe(cond) }); return original(cond); };
    return c;
  });
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const r = await cb(kdb.db);
    eventos.push('commit');
    return r;
  });
  eventos.length = 0;
  borrados.length = 0;
  invalidarRolMock.mockClear();
});

const admin = async () => `Bearer ${await testToken({ role: 'admin', username: 'admin@flit.test' })}`;

describe('guardas: cada ruta exige su función; un rol sin ella recibe 403', () => {
  it('auditor → 403 en las seis rutas de roles y en GET /funciones (permisos.catalogo.ver)', async () => {
    const token = `Bearer ${await testToken({ role: 'auditor', sub: 2 })}`;
    const peticiones = [
      request(app()).get('/api/permisos/funciones').set('Authorization', token),
      request(app()).get('/api/permisos/roles').set('Authorization', token),
      request(app()).post('/api/permisos/roles').set('Authorization', token).send({}),
      request(app()).patch('/api/permisos/roles/x').set('Authorization', token).send({}),
      request(app()).delete('/api/permisos/roles/x').set('Authorization', token),
      request(app()).get('/api/permisos/roles/x/funciones').set('Authorization', token),
      request(app()).put('/api/permisos/roles/x/funciones').set('Authorization', token).send({ funciones: [] }),
    ];
    for (const p of peticiones) expect((await p).status).toBe(403);
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('sin token → 401', async () => {
    expect((await request(app()).get('/api/permisos/roles')).status).toBe(401);
  });
});

describe('AC1 — POST /roles', () => {
  const cuerpo = { codigo: 'gestor_x', nombre: ' Gestor X ', descripcion: 'Prueba', tipoEnlace: 'ninguno', funciones: ['soat.cola.ver', 'soat.cola.ver', 'pagina.dashboard'] };

  it('201 con la forma del listado, el rol y su cuadro escritos en la transacción, y el lote de auditoría', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }, { codigo: 'pagina.dashboard' }]);
    kdb.when.insert('permisos_roles', [ROL({ descripcion: 'Prueba' })]);
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin()).send(cuerpo);
    expect(r.status).toBe(201);
    expect(r.body.rol).toEqual({
      codigo: 'gestor_x', nombre: 'Gestor X', descripcion: 'Prueba', tipoEnlace: 'ninguno',
      esSistema: false, activo: true, usuarios: 0, borrable: true, motivoNoBorrable: null,
      createdAt: AHORA.toISOString(), updatedAt: AHORA.toISOString(),
    });
    // El rol: sin `esSistema` ni `activo` del cuerpo (nacen por defecto); `nombre` recortado.
    expect(espia.ultimoInsertEn('permisos_roles')).toEqual({ codigo: 'gestor_x', nombre: 'Gestor X', descripcion: 'Prueba', tipoEnlace: 'ninguno' });
    expect(r.body.rol).not.toHaveProperty('tipoPrincipal'); // AC6
    // El cuadro: duplicados plegados, orden por código.
    expect(espia.ultimoInsertEn('permisos_rol_funcion')).toEqual([
      { rolCodigo: 'gestor_x', funcionCodigo: 'pagina.dashboard' }, { rolCodigo: 'gestor_x', funcionCodigo: 'soat.cola.ver' },
    ]);
    expect(eventos).toEqual(['commit']);
    // AC6: un lote, cinco filas (cuatro del rol + el conjunto; HU #12875: el tipo retirado ya no se
    // audita), todas con `rolAfectadoCodigo` y sin titular.
    const filas = auditadas();
    expect(filas).toHaveLength(5);
    expect(new Set(filas.map((f) => f.loteId)).size).toBe(1);
    expect(filas.map((f) => [f.entidad, f.accion, f.campo, f.valorAntes, f.valorDespues])).toEqual([
      ['rol', 'crear', 'nombre', null, 'Gestor X'],
      ['rol', 'crear', 'descripcion', null, 'Prueba'],
      ['rol', 'crear', 'tipo_enlace', null, 'ninguno'],
      ['rol', 'crear', 'activo', null, true],
      ['rol_funcion', 'crear', 'conjunto', null, { conjunto: ['pagina.dashboard', 'soat.cola.ver'] }],
    ]);
    for (const f of filas) {
      expect(f).toMatchObject({ rolAfectadoCodigo: 'gestor_x', usuarioAfectadoId: null, usuarioAfectadoRol: null, actorEmail: 'admin@flit.test', actorUserId: 1, origen: 'usuario' });
    }
  });

  it('sin `funciones` ni `descripcion`: cuadro vacío, sin INSERT del cuadro ni fila de conjunto', async () => {
    kdb.when.insert('permisos_roles', [ROL()]);
    const { funciones: _f, descripcion: _d, ...sinFunciones } = cuerpo;
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin()).send(sinFunciones);
    expect(r.status).toBe(201);
    expect(espia.insertsEn('permisos_rol_funcion')).toHaveLength(0);
    expect(auditadas().map((f) => f.campo)).toEqual(['nombre', 'tipo_enlace', 'activo']);
  });

  it.each([
    ['código con mayúsculas o guiones', { ...cuerpo, codigo: 'Gestor-X' }],
    ['código de más de 40', { ...cuerpo, codigo: 'a'.repeat(41) }],
    ['tipoEnlace fuera del enum', { ...cuerpo, tipoEnlace: 'empresa' }],
    ['HU #12875 AC6 (TC-06a): el retirado `tipoPrincipal` en el cuerpo, aunque sea válido', { ...cuerpo, tipoPrincipal: 'externo' }],
    ['HU #12875 AC8 (TC-08c): el valor previo `proveedor_soat`', { ...cuerpo, tipoEnlace: 'proveedor_soat' }],
    ['tipoEnlace AUSENTE: no hay valor por defecto', (({ tipoEnlace: _t, ...resto }) => resto)(cuerpo)],
    ['nombre vacío', { ...cuerpo, nombre: '   ' }],
  ])('400 de Zod: %s — y no se consulta ni escribe nada', async (_n, body) => {
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin()).send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('409 si el código ya existe: lo dice la PK (23505), no una consulta previa', async () => {
    kdb.when.insert('permisos_roles', () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); });
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin()).send({ ...cuerpo, funciones: [] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Ya existe un rol con el código «gestor_x»' });
    expect(eventos).not.toContain('commit');
  });

  it('400 con la lista de funciones inexistentes; ni el rol ni el cuadro se escriben', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }]);
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin())
      .send({ ...cuerpo, funciones: ['soat.cola.ver', 'soat.inventada', 'otra.mas'] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Funciones inexistentes', funciones: ['otra.mas', 'soat.inventada'] });
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('400 «operaciones» está reservado (M11)', async () => {
    const r = await request(app()).post('/api/permisos/roles').set('Authorization', await admin()).send({ ...cuerpo, codigo: 'operaciones' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/«operaciones» está reservado/);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });
});

describe('AC2 — PATCH /roles/:codigo', () => {
  it('cambia el nombre: UPDATE por código, fila de auditoría antes→después, y la caché del rol se invalida DESPUÉS del commit', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [USERS_OK]);
    kdb.when.update('permisos_roles', [ROL({ nombre: 'Gestor Y' })]);
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ nombre: 'Gestor Y' });
    expect(r.status).toBe(200);
    expect(r.body.rol.nombre).toBe('Gestor Y');
    const [u] = espia.updatesEn('permisos_roles');
    expect(u.datos).toMatchObject({ nombre: 'Gestor Y' });
    expect(Object.keys(u.datos).sort()).toEqual(['nombre', 'updatedAt']);
    expect(u.filtros).toEqual(['gestor_x']);
    expect(auditadas().map((f) => [f.entidad, f.accion, f.campo, f.valorAntes, f.valorDespues, f.rolAfectadoCodigo]))
      .toEqual([['rol', 'editar', 'nombre', 'Gestor X', 'Gestor Y', 'gestor_x']]);
    expect(eventos).toEqual(['commit', 'invalidar-rol:gestor_x']);
  });

  it.each([
    ['codigo', { codigo: 'otro' }],
    ['esSistema', { esSistema: false }],
    ['funciones', { funciones: [] }],
  ])('`%s` en el cuerpo → 400 por .strict(): no es editable por esta ruta', async (_c, body) => {
    const r = await request(app()).patch('/api/permisos/roles/admin').set('Authorization', await admin()).send({ nombre: 'X', ...body });
    expect(r.status).toBe(400);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('el mismo valor en todos los campos → 400 «Sin cambios», sin UPDATE ni auditoría ni invalidación', async () => {
    kdb.when.select('permisos_roles', [ROL()]);
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ nombre: 'Gestor X', activo: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Sin cambios');
    expect(kdb.update).not.toHaveBeenCalled();
    expect(auditadas()).toHaveLength(0);
    expect(invalidarRolMock).not.toHaveBeenCalled();
  });

  it('404 si el rol no existe', async () => {
    const r = await request(app()).patch('/api/permisos/roles/nadie').set('Authorization', await admin()).send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('tipoEnlace con 3 usuarios asignados → 409 con el conteo y sin UPDATE', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 3 }]);
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ tipoEnlace: 'compania' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: '3 usuarios lo tienen asignado; el tipo de enlace se cambia sin usuarios', usuarios: 3 });
    expect(kdb.update).not.toHaveBeenCalled();
    expect(eventos).not.toContain('commit');
  });

  it('tipoEnlace con 0 usuarios → 200 y fila `tipo_enlace` ninguno→compania', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 0 }]);
    kdb.when.update('permisos_roles', [ROL({ tipoEnlace: 'compania' })]);
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ tipoEnlace: 'compania' });
    expect(r.status).toBe(200);
    expect(auditadas().map((f) => [f.campo, f.valorAntes, f.valorDespues])).toEqual([['tipo_enlace', 'ninguno', 'compania']]);
  });

  it('HU #12875 AC6 (TC-06b): PATCH con el retirado `tipoPrincipal` → 400 por `.strict()`, sin UPDATE, sin auditoría, sin invalidar', async () => {
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ tipoPrincipal: 'externo' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(auditadas()).toEqual([]);
    expect(invalidarRolMock).not.toHaveBeenCalled();
  });

  it('HU #12875 AC8 (TC-08c): tipoEnlace `proveedor` con 0 usuarios → 200 y fila `tipo_enlace` ninguno→proveedor; el DTO no lleva tipo', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 0 }]);
    kdb.when.update('permisos_roles', [ROL({ tipoEnlace: 'proveedor' })]);
    const r = await request(app()).patch('/api/permisos/roles/gestor_x').set('Authorization', await admin()).send({ tipoEnlace: 'proveedor' });
    expect(r.status).toBe(200);
    expect(auditadas().map((f) => [f.campo, f.valorAntes, f.valorDespues])).toEqual([['tipo_enlace', 'ninguno', 'proveedor']]);
    expect(r.body.rol).not.toHaveProperty('tipoPrincipal');
  });

  it('activo se puede cambiar incluso en admin (gobierna la asignación, no la autenticación)', async () => {
    kdb.when.select('permisos_roles', [ADMIN]).select('users', [USERS_OK]);
    kdb.when.update('permisos_roles', [{ ...ADMIN, activo: false }]);
    const r = await request(app()).patch('/api/permisos/roles/admin').set('Authorization', await admin()).send({ activo: false });
    expect(r.status).toBe(200);
    expect(auditadas().map((f) => [f.campo, f.valorAntes, f.valorDespues])).toEqual([['activo', true, false]]);
  });
});

describe('AC3 — DELETE /roles/:codigo y el listado', () => {
  it('rol del sistema → 409 «rol del sistema» aunque N = 0, sin DELETE (M9)', async () => {
    kdb.when.select('permisos_roles', [ADMIN]).select('users', [{ n: 0 }]);
    const r = await request(app()).delete('/api/permisos/roles/admin').set('Authorization', await admin());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'rol del sistema', usuarios: 0 });
    expect(borrados).toEqual([]);
    expect(eventos).not.toContain('commit');
  });

  it('3 usuarios asignados → 409 con el conteo en el mensaje y en `usuarios`, sin DELETE', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 3 }]);
    const r = await request(app()).delete('/api/permisos/roles/gestor_x').set('Authorization', await admin());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: '3 usuarios lo tienen asignado; reasígnalos primero', usuarios: 3 });
    expect(borrados).toEqual([]);
  });

  it('N = 0 → 204: DELETE por código dentro del invariante, cinco filas `borrar` con valorDespues null, invalidación tras el commit', async () => {
    kdb.when.select('permisos_roles', [ROL({ descripcion: 'D' })]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', [{ codigo: 'soat.cola.ver' }, { codigo: 'pagina.dashboard' }]);
    const r = await request(app()).delete('/api/permisos/roles/gestor_x').set('Authorization', await admin());
    expect(r.status).toBe(204);
    expect(borrados).toEqual([{ tabla: 'permisos_roles', filtros: ['gestor_x'] }]);
    const filas = auditadas();
    expect(filas).toHaveLength(5);
    expect(filas.every((f) => f.accion === 'borrar' && f.valorDespues === null && f.rolAfectadoCodigo === 'gestor_x' && f.usuarioAfectadoId === null)).toBe(true);
    expect(filas.map((f) => [f.entidad, f.campo, f.valorAntes])).toEqual([
      ['rol', 'nombre', 'Gestor X'], ['rol', 'descripcion', 'D'], ['rol', 'tipo_enlace', 'ninguno'],
      ['rol', 'activo', true],
      ['rol_funcion', 'conjunto', { conjunto: ['pagina.dashboard', 'soat.cola.ver'] }],
    ]);
    expect(eventos).toEqual(['commit', 'invalidar-rol:gestor_x']);
  });

  it('404 si no existe', async () => {
    const r = await request(app()).delete('/api/permisos/roles/nadie').set('Authorization', await admin());
    expect(r.status).toBe(404);
  });

  it('un 23503 que llegue a pesar del conteo (alta concurrente) responde el mismo 409 con N releído', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 0, todas: 1, f0: 1, f1: 1, f2: 1, f3: 1 }]);
    kdb.when.delete('permisos_roles', () => { throw Object.assign(new Error('fk'), { code: '23503' }); });
    // En orden de ejecución: el lock de la población P (primero, db-review), el conteo del rol dentro, y el N releído fuera.
    kdb.when.selectOnce('users', [{ id: 1 }]).selectOnce('users', [{ n: 0 }]).selectOnce('users', [{ n: 1 }]);
    const r = await request(app()).delete('/api/permisos/roles/gestor_x').set('Authorization', await admin());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/1 usuarios lo tienen asignado; reasígnalos primero/);
    expect(eventos).not.toContain('commit');
  });

  it('GET /roles: es_sistema primero, `usuarios` cuenta todos (activos o no), y borrable/motivoNoBorrable con el MISMO texto que el 409 (M10)', async () => {
    kdb.when.select('permisos_roles', [ADMIN, ROL(), ROL({ codigo: 'sin_uso' })])
      .select('users', [{ role: 'admin', n: 2 }, { role: 'gestor_x', n: 3 }]);
    const r = await request(app()).get('/api/permisos/roles').set('Authorization', await admin());
    expect(r.status).toBe(200);
    for (const rol of r.body.roles) expect(rol).not.toHaveProperty('tipoPrincipal'); // HU #12875 AC6 (TC-06c)
    expect(r.body.roles.map((x: { codigo: string; usuarios: number; borrable: boolean; motivoNoBorrable: string | null }) =>
      [x.codigo, x.usuarios, x.borrable, x.motivoNoBorrable])).toEqual([
      ['admin', 2, false, 'rol del sistema'],
      ['gestor_x', 3, false, '3 usuarios lo tienen asignado; reasígnalos primero'],
      ['sin_uso', 0, true, null],
    ]);
    // El mismo texto que el DELETE responde: una sola función lo produce.
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 3 }]);
    const d = await request(app()).delete('/api/permisos/roles/gestor_x').set('Authorization', await admin());
    expect(d.body.error).toBe(r.body.roles[1].motivoNoBorrable);
    // Sin PII: aunque la tabla users tenga nombres, aquí no viaja ninguno.
    expect(JSON.stringify(r.body)).not.toMatch(/username|email/);
  });
});

describe('AC5 — GET y PUT /roles/:codigo/funciones', () => {
  it('GET: el cuadro ordenado con el ENLACE del rol (HU #12875, sin el tipo retirado); 404 si no existe', async () => {
    kdb.when.select('permisos_roles', [{ codigo: 'gestor_x', tipoEnlace: 'ninguno' }])
      .select('permisos_rol_funcion', [{ codigo: 'soat.cola.ver' }, { codigo: 'pagina.dashboard' }]);
    const r = await request(app()).get('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin());
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('tipoPrincipal'); // AC6 (TC-06c)
    expect(r.body).toEqual({ codigo: 'gestor_x', tipoEnlace: 'ninguno', funciones: ['soat.cola.ver', 'pagina.dashboard'] });
    kdb.when.select('permisos_roles', []);
    expect((await request(app()).get('/api/permisos/roles/nadie/funciones').set('Authorization', await admin())).status).toBe(404);
  });

  it('PUT reescribe: DELETE del cuadro + INSERT del conjunto completo, diff en la respuesta y en la auditoría, invalidación tras el commit', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }, { codigo: 'soat.solicitud.enviar' }])
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', [{ codigo: 'pagina.dashboard' }, { codigo: 'soat.cola.ver' }]);
    const r = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin())
      .send({ funciones: ['soat.solicitud.enviar', 'soat.cola.ver', 'soat.cola.ver'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      codigo: 'gestor_x', funciones: ['soat.cola.ver', 'soat.solicitud.enviar'],
      concedidas: ['soat.solicitud.enviar'], revocadas: ['pagina.dashboard'], aviso: null,
    });
    expect(borrados).toEqual([{ tabla: 'permisos_rol_funcion', filtros: ['gestor_x'] }]);
    expect(espia.ultimoInsertEn('permisos_rol_funcion')).toEqual([
      { rolCodigo: 'gestor_x', funcionCodigo: 'soat.cola.ver' }, { rolCodigo: 'gestor_x', funcionCodigo: 'soat.solicitud.enviar' },
    ]);
    expect(auditadas().map((f) => [f.entidad, f.accion, f.campo, f.valorAntes, f.valorDespues, f.rolAfectadoCodigo, f.usuarioAfectadoId])).toEqual([[
      'rol_funcion', 'editar', 'conjunto',
      { conjunto: ['pagina.dashboard', 'soat.cola.ver'] },
      { conjunto: ['soat.cola.ver', 'soat.solicitud.enviar'], concedidas: ['soat.solicitud.enviar'], revocadas: ['pagina.dashboard'] },
      'gestor_x', null,
    ]]);
    expect(eventos).toEqual(['commit', 'invalidar-rol:gestor_x']);
  });

  it('PUT con el mismo conjunto (otro orden): sin DELETE, sin INSERT, sin auditoría; 200 con diff vacío', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'a.b.c' }, { codigo: 'd.e.f' }])
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', [{ codigo: 'a.b.c' }, { codigo: 'd.e.f' }]);
    const r = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin()).send({ funciones: ['d.e.f', 'a.b.c'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ funciones: ['a.b.c', 'd.e.f'], concedidas: [], revocadas: [] });
    expect(borrados).toEqual([]);
    expect(espia.insertsEn('permisos_rol_funcion')).toHaveLength(0);
    expect(auditadas()).toHaveLength(0);
  });

  it('PUT con un código inválido → 400 con la lista; transaccional: no se abre transacción ni se escribe nada', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }]);
    const r = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin())
      .send({ funciones: ['soat.cola.ver', 'soat.no.existe'] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Funciones inexistentes', funciones: ['soat.no.existe'] });
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(borrados).toEqual([]);
    expect(invalidarRolMock).not.toHaveBeenCalled();
  });

  it('PUT: 404 si el rol no existe; 400 si el cuerpo no trae `funciones`', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'a.b.c' }]).select('permisos_roles', []).select('users', [USERS_OK]);
    expect((await request(app()).put('/api/permisos/roles/nadie/funciones').set('Authorization', await admin()).send({ funciones: ['a.b.c'] })).status).toBe(404);
    expect((await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin()).send({})).status).toBe(400);
  });

  it('RN-A1 (HU #12875): rol con enlace compañía y funciones de módulos que la frontera no le abre → se guarda igual y AVISA cuáles (M12)', async () => {
    // HU #13426 abrió Impuestos a compañía: el módulo que sigue cerrado para ella es Derechos.
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }, { codigo: 'derechos.cola.ver' }, { codigo: 'pagina.flito_soat' }])
      .select('permisos_roles', [{ tipoEnlace: 'compania' }]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', []);
    const r = await request(app()).put('/api/permisos/roles/cliente/funciones').set('Authorization', await admin())
      .send({ funciones: ['soat.cola.ver', 'derechos.cola.ver', 'pagina.flito_soat'] });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toEqual({
      tipo: 'fuera_del_enlace',
      tipoEnlace: 'compania',
      mensaje: 'El rol tiene enlace: la frontera solo le abre los módulos de ese enlace y estas funciones no tendrán efecto por HTTP',
      funciones: ['derechos.cola.ver'],
    });
    // Se guardó completo: las tres, no solo las alcanzables.
    expect(espia.ultimoInsertEn('permisos_rol_funcion')).toHaveLength(3);
  });

  it('RN-A1: enlace compañía SOLO con funciones de SOAT (y páginas) → sin aviso; enlace `ninguno` con cualquier cosa → sin aviso; organismos con SOAT → aviso', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }, { codigo: 'soat.solicitud.enviar' }, { codigo: 'pagina.flito_soat' }])
      .select('users', [USERS_OK]).select('permisos_rol_funcion', []);
    kdb.when.select('permisos_roles', [{ tipoEnlace: 'compania' }]);
    const a = await request(app()).put('/api/permisos/roles/cliente/funciones').set('Authorization', await admin()).send({ funciones: ['soat.cola.ver', 'soat.solicitud.enviar', 'pagina.flito_soat'] });
    expect(a.body.aviso).toBeNull();
    kdb.when.select('permisos_roles', [{ tipoEnlace: 'ninguno' }]);
    const b = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin()).send({ funciones: ['soat.solicitud.enviar'] });
    expect(b.body.aviso).toBeNull();
    kdb.when.select('permisos_roles', [{ tipoEnlace: 'organismos_transito' }]);
    const c = await request(app()).put('/api/permisos/roles/transito_x/funciones').set('Authorization', await admin()).send({ funciones: ['soat.cola.ver'] });
    expect(c.body.aviso).toMatchObject({ tipo: 'fuera_del_enlace', tipoEnlace: 'organismos_transito', funciones: ['soat.cola.ver'] });
  });

  it('AC4/M1: vaciar el cuadro de `admin` cuando nadie más administra → 409 del invariante, sin commit ni invalidación', async () => {
    kdb.when.select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [{ n: 2, todas: 0, f0: 1, f1: 1, f2: 1, f3: 0 }])
      .select('permisos_rol_funcion', [{ codigo: 'permisos.cuadro.guardar' }]);
    const r = await request(app()).put('/api/permisos/roles/admin/funciones').set('Authorization', await admin()).send({ funciones: [] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE_409, funcion: 'permisos.cuadro.guardar' });
    // La escritura ocurrió dentro de la transacción (y la transacción no confirmó).
    expect(borrados).toEqual([{ tabla: 'permisos_rol_funcion', filtros: ['admin'] }]);
    expect(eventos).not.toContain('commit');
    expect(invalidarRolMock).not.toHaveBeenCalled();
  });
});

// ─────────── HU #13424 (ADR-0022) — `admin` editable y el seguro por conjunción ───────────
describe('HU #13424 — admin editable (AC1), conjunción en el cuadro (AC3), borrar rol (AC5) y bitácora del rechazo (AC8)', () => {
  it('AC1: quitarle a `admin` una función no crítica → 200 y la caché del rol se invalida DESPUÉS del commit (≤ 60 s)', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'pagina.users' }, { codigo: 'usuarios.usuario.editar' }, { codigo: 'pagina.roles_permisos' }, { codigo: 'permisos.cuadro.guardar' }])
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', [{ codigo: 'pagina.users' }, { codigo: 'usuarios.usuario.editar' }, { codigo: 'pagina.roles_permisos' }, { codigo: 'permisos.cuadro.guardar' }, { codigo: 'soat.cola.ver' }]);
    const cuatro = ['pagina.users', 'usuarios.usuario.editar', 'pagina.roles_permisos', 'permisos.cuadro.guardar'];
    const r = await request(app()).put('/api/permisos/roles/admin/funciones').set('Authorization', await admin()).send({ funciones: cuatro });
    expect(r.status).toBe(200);
    // Se reescribe el cuadro de `admin` como el de cualquier rol: sin `soat.cola.ver`.
    expect(borrados).toEqual([{ tabla: 'permisos_rol_funcion', filtros: ['admin'] }]);
    expect((espia.ultimoInsertEn('permisos_rol_funcion') as unknown as Record<string, unknown>[]).map((f) => f.funcionCodigo)).toEqual([...cuatro].sort());
    expect(eventos).toEqual(['commit', 'invalidar-rol:admin']);
    expect(rechazos()).toEqual([]);
  });

  it('AC3: cada función tiene titular por separado pero nadie reúne las cuatro → 409, nada confirmado, rechazo registrado', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }])
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [{ n: 0, todas: 0, f0: 1, f1: 1, f2: 1, f3: 1 }])
      .select('permisos_rol_funcion', [{ codigo: 'pagina.roles_permisos' }, { codigo: 'soat.cola.ver' }]);
    const r = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin()).send({ funciones: ['soat.cola.ver'] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE_409, funcion: 'pagina.users' });
    expect(eventos).not.toContain('commit');
    expect(invalidarRolMock).not.toHaveBeenCalled();
    // AC8: actor (id opaco + su correo, RN-A10), rol afectado y resultado; ni un dato del titular.
    const [fila] = rechazos();
    expect(fila).toMatchObject({
      action: 'update', resource: 'permisos_rol', resourceId: 'gestor_x',
      detail: 'resultado=rechazado_anti_bloqueo operacion=guardar_cuadro objetivo=rol:gestor_x funcion=pagina.users',
      userEmail: 'admin@flit.test',
    });
    expect(rechazos()).toHaveLength(1);
  });

  it('AC5: borrar un rol (sin usuarios asignados) cuando nadie más reuniría las cuatro → 409 sin DELETE confirmado y rechazo registrado', async () => {
    kdb.when.select('permisos_roles', [ROL()]).select('users', [{ n: 0, todas: 0, f0: 0, f1: 0, f2: 0, f3: 0 }])
      .select('permisos_rol_funcion', []);
    const r = await request(app()).delete('/api/permisos/roles/gestor_x').set('Authorization', await admin());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: MENSAJE_409, funcion: 'pagina.users' });
    expect(eventos).not.toContain('commit');
    expect(invalidarRolMock).not.toHaveBeenCalled();
    expect(rechazos().map((f) => [f.action, f.resource, f.resourceId, f.detail])).toEqual([
      ['delete', 'permisos_rol', 'gestor_x', 'resultado=rechazado_anti_bloqueo operacion=borrar_rol objetivo=rol:gestor_x funcion=pagina.users'],
    ]);
  });

  it('AC6: con otro usuario que reúne las cuatro, el mismo PUT pasa y no se registra rechazo', async () => {
    kdb.when.select('permisos_funciones', [{ codigo: 'soat.cola.ver' }])
      .select('permisos_roles', [{ tipoEnlace: 'ninguno' }]).select('users', [USERS_OK])
      .select('permisos_rol_funcion', [{ codigo: 'pagina.roles_permisos' }]);
    const r = await request(app()).put('/api/permisos/roles/gestor_x/funciones').set('Authorization', await admin()).send({ funciones: ['soat.cola.ver'] });
    expect(r.status).toBe(200);
    expect(eventos).toEqual(['commit', 'invalidar-rol:gestor_x']);
    expect(rechazos()).toEqual([]);
  });
});
