// Feature #14325 (HU #14338, #14339, #14340, #14341; ADR-0039 §6.1 y §6.2) — De punta a punta contra PostgreSQL de verdad, con
// las rutas, la frontera y el resolutor REALES: lo único doble es Redis. Exige la base al día (incluida la 0294) y confirma
// de verdad para medir la invalidación tras el commit y las carreras: hay que usar una base temporal recién migrada.
// Sin TEST_DATABASE_URL se SALTA (el CI no levanta Postgres); la frontera también se mide en `frontera-proveedor-servicio.test.ts`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../src/db/schema.js';
import { URL_BASE } from '../helpers/base-en-tx.js';
import { conCadena } from '../helpers/auth.js';

const real = vi.hoisted(() => ({ db: null as unknown as Record<string | symbol, unknown> }));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const v = real.db[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real.db) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { conAlcance } = await import('../../src/shared/middleware/frontera-enlace.js');
const { default: usersRoutes } = await import('../../src/modules/users/users.routes.js');
const { default: authRoutes } = await import('../../src/modules/auth/auth.routes.js');
const { default: proveedoresRoutes } = await import('../../src/modules/flito-parametrizacion/flito-proveedores.routes.js');
const { default: parametrizacionRoutes } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
const { default: soatRoutes } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
const { crearProveedor } = await import('../../src/modules/flito-parametrizacion/flito-proveedores.service.js');
const { editarProveedor } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-edicion.service.js');
const { exigirProveedorSoatUsable, ProveedorSoatNoUsableError } = await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const { exigirProveedorLogisticaUsable } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');

type DbReal = ReturnType<typeof drizzle<typeof schema>>;
const CORRIDA = Date.now() % 1_000_000; // La base se puede reutilizar: nombres, usuarios y NIT no chocan entre corridas.
const PREFIJO = `zzf3${CORRIDA}`;
const CLAVE = 'Clave#Prueba1';
const ACTOR = { userId: null, email: null, rol: null };

const FUNCIONES_GESTION = [
  'usuarios.usuario.listar', 'usuarios.usuario.crear', 'usuarios.usuario.editar', 'usuarios.usuario.activar',
  'usuarios.usuario.baja', 'usuarios.usuario.reactivar', 'usuarios.sesiones.invalidar',
];
const CERRADAS = ['usuarios.usuario.exportar', 'usuarios.usuario.ver_resumen', 'usuarios.auditoria.ver', 'usuarios.auditoria.filtrar'];
const FUNCIONES_SOAT = ['pagina.flito_soat', 'soat.cola.ver'];

let n = 0;
const generales = () => {
  n += 1;
  return {
    nombre: `${PREFIJO} Proveedor ${n}`, nit: `9${String(CORRIDA).padStart(6, '0')}${String(n).padStart(2, '0')}`, telefono: '3001234567', correo: 'contacto@empresa.co',
    direccion: 'Calle 10 # 20-30', ciudad: 'Medellín', contacto: 'Ana Ruiz',
  };
};

describe.skipIf(!URL_BASE)('Feature #14325 — frontera por servicio, login y atadura de usuarios', () => {
  let sql: postgres.Sql;
  let app: express.Express;
  let adminId = 0;
  let hash = '';

  const nuevoProveedor = async (servicios: ('soat' | 'logistica')[]): Promise<{ id: string; version: number; nombre: string }> => {
    const c = await crearProveedor({ generales: generales(), servicios }, ACTOR);
    return { id: c.id, version: c.version, nombre: c.nombre };
  };
  const version = async (id: string) => (await sql`SELECT version FROM flito_proveedores WHERE id = ${id}`)[0]!.version as number;

  const rolDe = async (codigo: string, enlace: string, funciones: string[]) => {
    await sql`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace, activo) VALUES (${codigo}, ${codigo}, ${enlace}, true) ON CONFLICT (codigo) DO NOTHING`;
    for (const f of conCadena(funciones)) {
      // Una operación absorbida por el árbol no tiene fila propia: se tiene por su acción, que `conCadena` ya trajo.
      await sql`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
        SELECT ${codigo}, codigo FROM permisos_funciones WHERE codigo = ${f} ON CONFLICT DO NOTHING`;
    }
  };

  /** El usuario directo en la base. Con `vieja` lo crea como la imagen anterior, escribiendo solo la columna de SOAT. */
  const usuario = async (rol: string, proveedor: string | null, o: { vieja?: boolean } = {}): Promise<number> => {
    n += 1;
    const nombre = `${PREFIJO}_u${n}`;
    const [f] = o.vieja
      ? await sql`INSERT INTO users (username, name, password_hash, role, flito_proveedor_soat_id) VALUES (${nombre}, ${nombre}, ${hash}, ${rol}, ${proveedor}) RETURNING id`
      : await sql`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id) VALUES (${nombre}, ${nombre}, ${hash}, ${rol}, ${proveedor}) RETURNING id`;
    return f!.id as number;
  };
  const usernameDe = async (id: number) => (await sql`SELECT username FROM users WHERE id = ${id}`)[0]!.username as string;
  const columnas = async (id: number) => (await sql`SELECT flito_proveedor_id AS nueva, flito_proveedor_soat_id AS vieja, role, name, active, deleted_at FROM users WHERE id = ${id}`)[0]!;

  const bearer = async (id: number) => {
    await new Promise((r) => setTimeout(r, 1100)); // `iat` en segundos: una sesión invalidada en este segundo también caería.
    const token = await new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(id))
      .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    return `Bearer ${token}`;
  };
  const login = async (id: number) => request(app).post('/api/auth/login').send({ username: await usernameDe(id), password: CLAVE });
  const altaBody = (o: Record<string, unknown> = {}) => {
    n += 1;
    return { username: `${PREFIJO}_n${n}`, name: `Nuevo ${n}`, password: CLAVE, ...o };
  };

  beforeAll(async () => {
    process.env.AUTH_SKIP_SESSION_INVAL_CHECK = ''; // `setup.ts` lo apaga: aquí se mide de verdad que la sesión cae.
    sql = postgres(URL_BASE!, { max: 12, onnotice: () => {} });
    real.db = drizzle(sql, { schema }) as unknown as Record<string | symbol, unknown>;
    hash = await argon2.hash(CLAVE);
    adminId = (await sql`INSERT INTO users (username, name, password_hash, role) VALUES (${`${PREFIJO}_admin`}, 'Admin', ${hash}, 'admin') RETURNING id`)[0]!.id as number;
    await rolDe('zzf3_gestor', 'proveedor', [...FUNCIONES_GESTION, ...CERRADAS, ...FUNCIONES_SOAT, 'pagina.users', 'pagina.flito_logistica']);
    await rolDe('zzf3_mensajero', 'proveedor', []);
    await rolDe('zzf3_sin_soat', 'proveedor', ['pagina.users', 'usuarios.usuario.listar']);
    await rolDe('zzf3_cia', 'compania', ['usuarios.usuario.listar']);
    await rolDe('zzf3_ops', 'ninguno', [...FUNCIONES_GESTION]);
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/users', usersRoutes); // Sin `conAlcance`, como en `app.ts`: cerrado a todo enlace.
    app.use('/api/flito/parametrizacion/proveedores', proveedoresRoutes);
    app.use('/api/flito/parametrizacion', parametrizacionRoutes);
    app.use('/api/flito/soat', conAlcance('soat', soatRoutes));
    app.use('/api/flito/logistica', conAlcance('logistica', logisticaRoutes));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => { process.env.AUTH_SKIP_SESSION_INVAL_CHECK = '1'; await sql?.end(); });

  describe('HU #14338 — frontera por servicio', () => {
    it('AC1: proveedor solo de Logística con rol con SOAT → 403 «Sin permisos» y SOAT fuera de sus páginas', async () => {
      const p = await nuevoProveedor(['logistica']);
      const u = await usuario('zzf3_gestor', p.id);
      const auth = await bearer(u);
      const r = await request(app).get('/api/flito/soat').set('Authorization', auth);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'Sin permisos' });
      const me = await request(app).get('/api/auth/me').set('Authorization', auth);
      expect(me.status).toBe(200);
      expect(me.body.user?.allowedPages ?? me.body.allowedPages).not.toContain('flito_soat');
    }, 30_000);

    it('AC2: presta SOAT, rol sin permiso de SOAT → fuera del menú y 403', async () => {
      const p = await nuevoProveedor(['soat']);
      const auth = await bearer(await usuario('zzf3_sin_soat', p.id));
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(403);
      const me = await request(app).get('/api/auth/me').set('Authorization', auth);
      expect(me.body.user?.allowedPages ?? me.body.allowedPages).not.toContain('flito_soat');
    }, 30_000);

    // ADR-0040 (0298): el rol `proveedor` trae Logística; un proveedor mixto la ve en el menú. Los viajes adicionales siguen cerrados (D3).
    it('AC3: mixto → SOAT sí; Usuarios cerrado; Logística en el menú (ADR-0040) y viajes adicionales cerrados', async () => {
      const p = await nuevoProveedor(['soat', 'logistica']);
      const auth = await bearer(await usuario('zzf3_gestor', p.id));
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(200);
      expect((await request(app).get('/api/flito/logistica/viajes').set('Authorization', auth)).status).toBe(403);
      const me = await request(app).get('/api/auth/me').set('Authorization', auth);
      const paginas = me.body.user?.allowedPages ?? me.body.allowedPages;
      expect(paginas).toContain('flito_soat');
      expect(paginas).not.toContain('users'); // Cerrada: la gestión por el proveedor salió de esta épica.
      expect(paginas).toContain('flito_logistica');
    }, 30_000);

    it('AC5: usuario existente creado con la columna vieja → mismo menú y su cola de SOAT, sin la ajena', async () => {
      const [p, otro] = [await nuevoProveedor(['soat']), await nuevoProveedor(['soat'])];
      const u = await usuario('zzf3_gestor', p.id, { vieja: true });
      expect((await columnas(u)).nueva).toBe(p.id);
      const cia = (await sql`INSERT INTO clients (name, soat_autogestionable) VALUES (${`${PREFIJO} Cia ${n}`}, false) RETURNING id`)[0]!.id as number;
      const veh = async () => (await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
      const propia = (await sql`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id) VALUES (${cia}, ${await veh()}, ${`VIN${CORRIDA}A${n}`}, 'solicitado', ${p.id}) RETURNING id`)[0]!.id;
      const ajena = (await sql`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id) VALUES (${cia}, ${await veh()}, ${`VIN${CORRIDA}B${n}`}, 'solicitado', ${otro.id}) RETURNING id`)[0]!.id;
      const auth = await bearer(u);
      const r = await request(app).get('/api/flito/soat').set('Authorization', auth);
      expect(r.status).toBe(200);
      const ids = r.body.items.map((f: { id: string }) => f.id);
      expect(ids).toContain(propia);
      expect(ids).not.toContain(ajena);
    }, 30_000);

    it('AC6 y decisión del humano: quitar SOAT a un mixto → sesión viva 403 sin esperar la caché; el login sigue, sin el módulo', async () => {
      const p = await nuevoProveedor(['soat', 'logistica']);
      const u = await usuario('zzf3_gestor', p.id);
      const auth = await bearer(u);
      const admin = await bearer(adminId);
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(200); // deja la foto en caché

      const q = await request(app).delete(`/api/flito/parametrizacion/proveedores/${p.id}/servicios/soat`).set('Authorization', admin);
      expect(q.status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(403);
      expect((await request(app).get('/api/auth/me').set('Authorization', auth)).status).toBe(200); // no cierra sesión

      const l = await login(u);
      expect(l.status).toBe(200);
      expect(l.body.user.allowedPages).not.toContain('flito_soat');
      // El mismo corte con PATCH /:id, el otro camino que quita servicios.
      const p2 = await nuevoProveedor(['soat', 'logistica']);
      const a2 = await bearer(await usuario('zzf3_gestor', p2.id));
      expect((await request(app).get('/api/flito/soat').set('Authorization', a2)).status).toBe(200);
      const e = await request(app).patch(`/api/flito/parametrizacion/proveedores/${p2.id}`).set('Authorization', admin)
        .send({ versionEsperada: p2.version, servicios: ['logistica'] });
      expect(e.status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', a2)).status).toBe(403);
    }, 40_000);
  });

  describe('HU #14340 — corte de acceso', () => {
    it('AC1 y AC5: proveedor inactivo de SOAT, Logística o ambos → login rechazado; el de Logística no tiene columna vieja', async () => {
      const admin = await bearer(adminId);
      for (const servicios of [['soat'], ['logistica'], ['soat', 'logistica']] as ('soat' | 'logistica')[][]) {
        const p = await nuevoProveedor(servicios);
        const u = await usuario('zzf3_mensajero', p.id);
        if (!servicios.includes('soat')) expect((await columnas(u)).vieja).toBeNull();
        expect((await login(u)).status).toBe(200);
        const e = await request(app).patch(`/api/flito/parametrizacion/proveedores/${p.id}/estado`).set('Authorization', admin)
          .send({ activo: false, versionEsperada: await version(p.id) });
        expect(e.status).toBe(200);
        const l = await login(u);
        expect(l.status).toBe(403);
        expect(l.body.token).toBeUndefined();
      }
    }, 40_000);

    it('AC2, AC3 y AC4: la sesión abierta cae; el otro proveedor sigue; al reactivar entra con sus módulos', async () => {
      const admin = await bearer(adminId);
      const [p, otro] = [await nuevoProveedor(['soat']), await nuevoProveedor(['soat'])];
      const [u, v] = [await usuario('zzf3_gestor', p.id), await usuario('zzf3_gestor', otro.id)];
      const [au, av] = [await bearer(u), await bearer(v)];
      expect((await request(app).get('/api/flito/soat').set('Authorization', au)).status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', av)).status).toBe(200);

      expect((await request(app).patch(`/api/flito/parametrizacion/proveedores/${p.id}/estado`).set('Authorization', admin)
        .send({ activo: false, versionEsperada: await version(p.id) })).status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', au)).status).toBe(401);
      expect((await request(app).get('/api/flito/soat').set('Authorization', av)).status).toBe(200);

      expect((await request(app).patch(`/api/flito/parametrizacion/proveedores/${p.id}/estado`).set('Authorization', admin)
        .send({ activo: true, versionEsperada: await version(p.id) })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 1100)); // `iat` en segundos: un token del mismo segundo de la invalidación también cae.
      const l = await login(u);
      expect(l.status).toBe(200);
      expect(l.body.user.allowedPages).toContain('flito_soat');
      expect((await request(app).get('/api/flito/soat').set('Authorization', `Bearer ${l.body.token}`)).status).toBe(200);
    }, 40_000);
  });

  describe('HU #14339 — asignación por servicio', () => {
    const compania = async () => (await sql`INSERT INTO clients (name) VALUES (${`${PREFIJO} Cia ${++n}`}) RETURNING id`)[0]!.id as number;
    const asignar = async (admin: string, id: number, cuerpo: Record<string, unknown>) =>
      request(app).patch(`/api/flito/parametrizacion/companias/${id}`).set('Authorization', admin).send(cuerpo);

    it('AC3 y AC4: inactivo, eliminado o sin el servicio → rechazado y la compañía queda igual', async () => {
      const admin = await bearer(adminId);
      const c = await compania();
      const soloL = await nuevoProveedor(['logistica']);
      const soloS = await nuevoProveedor(['soat']);
      const inactivo = await nuevoProveedor(['soat', 'logistica']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${inactivo.id}`;
      const eliminado = await nuevoProveedor(['soat', 'logistica']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${eliminado.id}`;
      await sql`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${eliminado.id}`;

      for (const id of [soloL.id, inactivo.id, eliminado.id]) expect((await asignar(admin, c, { proveedorSoatSinTramiteId: id })).status, id).toBe(400);
      for (const id of [soloS.id, inactivo.id, eliminado.id]) expect((await asignar(admin, c, { proveedorLogisticaId: id })).status, id).toBe(422);
      const [f] = await sql`SELECT flito_proveedor_soat_sin_tramite_id AS s, flito_proveedor_logistica_id AS l FROM clients WHERE id = ${c}`;
      expect(f).toEqual({ s: null, l: null });
      expect((await asignar(admin, c, { proveedorSoatSinTramiteId: soloS.id, proveedorLogisticaId: soloL.id })).status).toBe(200);
    }, 30_000);

    it('AC5: `exigirProveedorSoatUsable` rechaza inactivo, eliminado y sin SOAT; acepta el vigente', async () => {
      const soloL = await nuevoProveedor(['logistica']);
      const vigente = await nuevoProveedor(['soat']);
      const inactivo = await nuevoProveedor(['soat']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${inactivo.id}`;
      const eliminado = await nuevoProveedor(['soat']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${eliminado.id}`;
      await sql`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${eliminado.id}`;
      const db = real.db as unknown as { transaction: <T>(f: (tx: never) => Promise<T>) => Promise<T> };
      await expect(db.transaction((tx) => exigirProveedorSoatUsable(tx, soloL.id))).rejects.toBeInstanceOf(ProveedorSoatNoUsableError);
      await expect(db.transaction((tx) => exigirProveedorSoatUsable(tx, inactivo.id))).rejects.toBeInstanceOf(ProveedorSoatNoUsableError);
      const rechazoEliminado = db.transaction((tx) => exigirProveedorSoatUsable(tx, eliminado.id));
      await expect(rechazoEliminado).rejects.toBeInstanceOf(ProveedorSoatNoUsableError);
      // Se rechaza por eliminado, no por estar inactivo: el motivo distingue qué rama lo paró.
      await expect(rechazoEliminado).rejects.toMatchObject({ motivo: 'no_existe' });
      await expect(db.transaction((tx) => exigirProveedorSoatUsable(tx, vigente.id))).resolves.toBeUndefined();
    });

    it('AC5: cambiar y devolver rechazan al inactivo, al eliminado y al que no da SOAT con 409, sin tocar la asignación; el vigente pasa', async () => {
      const admin = await bearer(adminId);
      const cia = await compania();
      const actual = await nuevoProveedor(['soat']);
      const vigente = await nuevoProveedor(['soat']);
      const soloL = await nuevoProveedor(['logistica']);
      const inactivo = await nuevoProveedor(['soat']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${inactivo.id}`;
      const eliminado = await nuevoProveedor(['soat']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${eliminado.id}`;
      await sql`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${eliminado.id}`;
      const soat = async (letra: string, estado: string, gestionOperaciones: boolean) => {
        const veh = (await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
        return (await sql`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id, gestion_operaciones)
          VALUES (${cia}, ${veh}, ${`VIN${CORRIDA}${letra}${n}`}, ${estado}, ${actual.id}, ${gestionOperaciones}) RETURNING id`)[0]!.id as string;
      };
      const operaciones = [
        { ruta: 'proveedor', id: await soat('F', 'pendiente', false), motivo: 'cambio de convenio' },
        { ruta: 'devolver-gestor', id: await soat('G', 'solicitado', true), motivo: 'ya puede retomarlo' },
      ];
      for (const { ruta, id, motivo } of operaciones) {
        const operar = (proveedorSoatId: string) => request(app).post(`/api/flito/soat/${id}/${ruta}`)
          .set('Authorization', admin).send({ proveedorSoatId, motivo });
        const asignado = async () => (await sql`SELECT proveedor_soat_id AS p FROM flito_soat WHERE id = ${id}`)[0]!.p as string;
        for (const [caso, proveedor, error] of [
          ['inactivo', inactivo, `El gestor ${inactivo.nombre} está inactivo: elige otro gestor.`],
          ['eliminado', eliminado, 'El gestor seleccionado no existe o fue eliminado.'],
          ['solo Logística', soloL, 'El gestor seleccionado no existe o fue eliminado.'],
        ] as const) {
          const r = await operar(proveedor.id);
          expect(r.status, `${ruta} ${caso}`).toBe(409);
          expect(r.body, `${ruta} ${caso}`).toEqual({ error });
          expect(await asignado(), `${ruta} ${caso}`).toBe(actual.id);
        }
        expect((await operar(vigente.id)).status, ruta).toBe(200);
        expect(await asignado(), ruta).toBe(vigente.id);
      }
    }, 30_000);

    it('AC6: asignado solo en Logística de una compañía con SOAT apagado → no ve ni gestiona sus SOAT', async () => {
      const p = await nuevoProveedor(['soat', 'logistica']);
      const apagado = await compania();
      await sql`UPDATE clients SET flito_proveedor_logistica_id = ${p.id}, soat_autogestionable = true WHERE id = ${apagado}`;
      const encendida = await compania();
      await sql`UPDATE clients SET flito_proveedor_logistica_id = ${p.id}, soat_autogestionable = false WHERE id = ${encendida}`;
      const control = await compania();
      await sql`UPDATE clients SET soat_autogestionable = false WHERE id = ${control}`;
      const fila = async (cia: number, letra: string, proveedor: string | null) => {
        const veh = (await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`)[0]!.id as number;
        return (await sql`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id)
          VALUES (${cia}, ${veh}, ${`VIN${CORRIDA}${letra}${n}`}, 'solicitado', ${proveedor}) RETURNING id`)[0]!.id as string;
      };
      const [enApagado, sinEnviar, propio] = [await fila(apagado, 'C', null), await fila(encendida, 'D', null), await fila(control, 'E', p.id)];
      const auth = await bearer(await usuario('zzf3_gestor', p.id));
      const lista = await request(app).get('/api/flito/soat').set('Authorization', auth);
      expect(lista.status).toBe(200);
      const ids = lista.body.items.map((f: { id: string }) => f.id);
      expect(ids).toContain(propio); // control: lo enviado a él sí lo ve, así que el vacío no pasa por casualidad
      expect(ids).not.toContain(enApagado);
      expect(ids).not.toContain(sinEnviar);
      expect((await request(app).get(`/api/flito/soat/${enApagado}`).set('Authorization', auth)).status).toBe(404);
    }, 30_000);

    it('AC7: retiro y asignación a la vez, en los dos órdenes → ninguna compañía con un proveedor sin ese servicio, y sin deadlock', async () => {
      const db = real.db as unknown as { transaction: <T>(f: (tx: never) => Promise<T>) => Promise<T> };
      for (const orden of ['retiro-primero', 'asignacion-primero'] as const) {
        const p = await nuevoProveedor(['soat', 'logistica']);
        const c = await compania();
        const asignacion = (espera: number) => db.transaction(async (tx) => {
          await exigirProveedorSoatUsable(tx, p.id);
          await exigirProveedorLogisticaUsable(tx, p.id);
          await new Promise((r) => setTimeout(r, espera));
          const t = tx as unknown as DbReal;
          await t.update(schema.clients).set({ flitoProveedorLogisticaId: p.id }).where(eq(schema.clients.id, c));
        });
        const retiro = () => editarProveedor(p.id, { versionEsperada: p.version, servicios: ['soat'] }, ACTOR);
        const pares = orden === 'retiro-primero'
          ? await Promise.allSettled([retiro(), (async () => { await new Promise((r) => setTimeout(r, 15)); return asignacion(0); })()])
          : await Promise.allSettled([(async () => { await new Promise((r) => setTimeout(r, 40)); return retiro(); })(), asignacion(250)]);
        const fallos = pares.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
        expect(fallos.length, orden).toBe(1); // uno de los dos pierde, y con el motivo de negocio
        expect(String(fallos[0]!.reason?.code ?? '')).not.toBe('40P01');
        const [f] = await sql`SELECT flito_proveedor_logistica_id AS l FROM clients WHERE id = ${c}`;
        const [perfil] = await sql`SELECT deleted_at FROM flito_proveedores_logistica WHERE id = ${p.id}`;
        expect(f!.l !== null && perfil!.deleted_at !== null, orden).toBe(false);
      }
    }, 30_000);
  });

  describe('HU #14341 — atar usuarios por Operaciones', () => {
    const alta = async (cuerpo: Record<string, unknown>) => request(app).post('/api/users').set('Authorization', await bearer(adminId)).send(altaBody(cuerpo));

    it('AC1: solo Logística → columna nueva y vieja vacía. AC2: con SOAT → las dos con el mismo valor', async () => {
      const [l, s] = [await nuevoProveedor(['logistica']), await nuevoProveedor(['soat'])];
      const a = await alta({ role: 'zzf3_mensajero', flitoProveedorId: l.id });
      expect(a.status).toBe(201);
      expect(a.body.flitoProveedorId).toBe(l.id);
      expect(a.body.flitoProveedorSoatId).toBeNull();
      const b = await alta({ role: 'zzf3_mensajero', flitoProveedorId: s.id });
      expect(b.status).toBe(201);
      const c = await columnas(b.body.id);
      expect(c.nueva).toBe(s.id);
      expect(c.vieja).toBe(s.id);
    }, 30_000);

    it('AC3: sin proveedor al crear o al editar → 400 y no se guarda', async () => {
      const r = await alta({ role: 'zzf3_mensajero' });
      expect(r.status).toBe(400);
      const p = await nuevoProveedor(['logistica']);
      const u = await usuario('zzf3_mensajero', p.id);
      const e = await request(app).patch(`/api/users/${u}`).set('Authorization', await bearer(adminId)).send({ flitoProveedorId: null });
      expect(e.status).toBe(400);
      expect((await columnas(u)).nueva).toBe(p.id);
    }, 30_000);

    it('AC4: inexistente, inactivo o eliminado → rechazado y no se guarda', async () => {
      const inactivo = await nuevoProveedor(['soat']);
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${inactivo.id}`;
      const eliminado = await nuevoProveedor(['logistica']);
      await sql`UPDATE flito_proveedores SET deleted_at = now() WHERE id = ${eliminado.id}`;
      for (const id of [inactivo.id, eliminado.id, 'f0000000-0000-4000-8000-0000000fffff']) {
        const cuerpo = altaBody({ role: 'zzf3_mensajero', flitoProveedorId: id });
        const r = await request(app).post('/api/users').set('Authorization', await bearer(adminId)).send(cuerpo);
        expect(r.status, id).toBe(400);
        expect((await sql`SELECT 1 FROM users WHERE username = ${cuerpo.username as string}`).length).toBe(0);
      }
    }, 30_000);

    it('AC5: existente con la columna vieja → la lista conserva proveedor y nombre; editar otro campo no lo toca ni con el proveedor inactivo', async () => {
      const p = await nuevoProveedor(['soat']);
      const u = await usuario('zzf3_mensajero', p.id, { vieja: true });
      await sql`UPDATE flito_proveedores SET activo = false WHERE id = ${p.id}`;
      const admin = await bearer(adminId);
      const lista = await request(app).get('/api/users').query({ q: await usernameDe(u) }).set('Authorization', admin);
      expect(lista.status).toBe(200);
      expect(lista.body[0]).toMatchObject({ id: u, flitoProveedorId: p.id, flitoProveedorSoatId: p.id, proveedorNombre: p.nombre });
      const e = await request(app).patch(`/api/users/${u}`).set('Authorization', admin).send({ name: 'Otro nombre' });
      expect(e.status).toBe(200);
      const c = await columnas(u);
      expect([c.nueva, c.vieja]).toEqual([p.id, p.id]);
    }, 30_000);

    it('AC6: solo `flitoProveedorSoatId` → es su proveedor; con los dos distintos → 400', async () => {
      const [p, q] = [await nuevoProveedor(['logistica']), await nuevoProveedor(['soat'])];
      const a = await alta({ role: 'zzf3_mensajero', flitoProveedorSoatId: p.id });
      expect(a.status).toBe(201);
      const c = await columnas(a.body.id);
      expect([c.nueva, c.vieja]).toEqual([p.id, null]);
      const b = await alta({ role: 'zzf3_mensajero', flitoProveedorSoatId: p.id, flitoProveedorId: q.id });
      expect(b.status).toBe(400);
      const e = await request(app).patch(`/api/users/${a.body.id}`).set('Authorization', await bearer(adminId)).send({ flitoProveedorSoatId: q.id });
      expect(e.status).toBe(200);
      const d = await columnas(a.body.id);
      expect([d.nueva, d.vieja]).toEqual([q.id, q.id]);
    }, 30_000);

    it('AC7: cambiar el proveedor invalida la sesión; al volver a entrar opera con el nuevo', async () => {
      const [p, q] = [await nuevoProveedor(['logistica']), await nuevoProveedor(['soat'])];
      const u = await usuario('zzf3_gestor', p.id);
      const auth = await bearer(u);
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(403);
      const e = await request(app).patch(`/api/users/${u}`).set('Authorization', await bearer(adminId)).send({ flitoProveedorId: q.id });
      expect(e.status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', auth)).status).toBe(401);
      await new Promise((r) => setTimeout(r, 1100));
      const l = await login(u);
      expect(l.status).toBe(200);
      expect((await request(app).get('/api/flito/soat').set('Authorization', `Bearer ${l.body.token}`)).status).toBe(200);
      const [fila] = await sql`SELECT valor_despues AS v FROM permisos_auditoria WHERE usuario_afectado_id = ${u} AND campo = 'flito_proveedor_id' ORDER BY created_at DESC LIMIT 1`;
      expect(JSON.stringify(fila!.v)).toContain(q.id);
    }, 30_000);
  });

  it('#14343 fuera de la épica: `/api/users` sigue cerrado al enlace proveedor, también al crear', async () => {
    const p = await nuevoProveedor(['soat']);
    const auth = await bearer(await usuario('zzf3_gestor', p.id));
    expect((await request(app).get('/api/users').set('Authorization', auth)).status).toBe(403);
    expect((await request(app).post('/api/users').set('Authorization', auth).send(altaBody({ role: 'zzf3_mensajero' }))).status).toBe(403);
  }, 30_000);
});
