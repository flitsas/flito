// Feature #14324 (HU #14332, #14333, #14334, #14335) — gestión de proveedores contra PostgreSQL de verdad.
//
// Todo dentro de una transacción con ROLLBACK (`base-en-tx.ts`), con 0290 y 0291 aplicadas DENTRO: la base local compartida
// puede no tenerlas. `db.transaction(fn)` abre un SAVEPOINT y lo revierte si `fn` lanza, para medir que un rechazo no deja
// nada escrito. Las carreras necesitan dos conexiones: se saltan si la base no tiene la 0291 aplicada de verdad.
// Sin TEST_DATABASE_URL se SALTA todo (el CI no levanta Postgres); las rutas se miden en `proveedores-gestion.routes.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, borrarAdminDePrueba, enTx, leerMigracion, sembrarAdminActivo, URL_BASE } from '../helpers/base-en-tx.js';
import { testToken } from '../helpers/auth.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Tx = postgres.TransactionSql;
const actual: { db: Db | null; tx: Tx | null; real: Db | null } = { db: null, tx: null, real: null };
let sp = 0;
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const fuente = (actual.real ?? actual.db) as unknown as Record<string | symbol, unknown>;
      if (!actual.real && prop === 'transaction') {
        return async (fn: (tx: unknown) => unknown) => {
          const nombre = `sp_hu14324_${++sp}`;
          await actual.tx!.unsafe(`SAVEPOINT ${nombre}`);
          try {
            const r = await fn(actual.db);
            await actual.tx!.unsafe(`RELEASE SAVEPOINT ${nombre}`);
            return r;
          } catch (e) {
            await actual.tx!.unsafe(`ROLLBACK TO SAVEPOINT ${nombre}`);
            throw e;
          }
        };
      }
      const v = fuente[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(fuente) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const P = '../../src/modules/flito-parametrizacion';
const servicio = await import(`${P}/flito-proveedores.service.js`);
const { crearProveedor, listarProveedores, detalleProveedor, selectorProveedores, proveedoresAsignablesAUsuario, conUnicidadTraducida,
  ProveedorDuplicadoError, ProveedorEditadoPorOtroError, ProveedorSinServicioError, DatosSoatInvalidosError, GeneralesIncompletosError,
  ProveedorNoEncontradoError } = servicio;
const { editarProveedor } = await import(`${P}/flito-proveedores-edicion.service.js`);
const { quitarServicio, ServicioNoQuitableError } = await import(`${P}/flito-proveedores-servicios.service.js`);
const { cambiarEstadoProveedor, impactoProveedor, EstadoProveedorCambiadoError } = await import(`${P}/flito-proveedores-estado.service.js`);
const { eliminarProveedor, ProveedorNoEliminableError } = await import(`${P}/flito-proveedores-eliminar.service.js`);
const { historialProveedor } = await import(`${P}/flito-proveedores-auditoria.js`);
const { ProveedorLogisticaAsignadoError } = await import(`${P}/flito-logistica-proveedor-compania.service.js`);
const { listarProveedoresLogistica } = await import(`${P}/flito-proveedores-logistica.service.js`);

const ACTOR = { userId: null, email: null, rol: null };
const SOAT = { estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24 };
let n = 0;

const generales = (o: Record<string, string> = {}) => {
  n += 1;
  return {
    nombre: `Mensajeria HU14324 ${n}`, nit: `${900100000 + n}`, telefono: '3001234567', correo: 'contacto.real@empresa.co',
    direccion: 'Calle 10 # 20-30', ciudad: 'Medellín', contacto: 'Ana Ruiz', ...o,
  };
};

async function conBase(fn: (tx: Tx) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      await tx.unsafe(leerMigracion('0290_flito_proveedores_padre.sql'));
      await tx.unsafe(leerMigracion('0291_flito_proveedores_logistica_unicidad_viva.sql'));
      await sembrarAdminActivo(tx);
      actual.tx = tx;
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx);
    });
  } finally {
    actual.db = null; actual.tx = null;
    await sql.end();
  }
}

async function rechazo(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('se esperaba un rechazo');
}

const crearCon = (servicios: string[], o: Record<string, string> = {}) =>
  crearProveedor({ generales: generales(o), servicios, ...(servicios.includes('soat') ? { soat: SOAT } : {}) }, ACTOR);

const compania = async (tx: Tx, nombre: string, o: { logistica?: string; soat?: string; autogestionable?: boolean } = {}) =>
  (await tx`INSERT INTO clients (name, flito_proveedor_logistica_id, flito_proveedor_soat_sin_tramite_id, logistica_autogestionable)
    VALUES (${nombre}, ${o.logistica ?? null}, ${o.soat ?? null}, ${o.autogestionable ?? false}) RETURNING id`)[0]!.id as number;

const soatFila = async (tx: Tx, proveedor: string, estado: string) => {
  const c = await compania(tx, `Cia SOAT ${++n}`);
  const [v] = await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
  await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id)
    VALUES (${c}, ${v!.id}, ${'VINHU14324' + (++n)}, ${estado}::flito_soat_estado, ${proveedor})`;
};

const acta = async (tx: Tx, proveedor: string, estado: string) => {
  const c = await compania(tx, `Cia acta ${++n}`);
  return (await tx`INSERT INTO flito_logistica_actas (compania_id, estado, proveedor_logistica_id)
    VALUES (${c}, ${estado}::flito_logistica_acta_estado, ${proveedor}) RETURNING id, compania_id`)[0]! as { id: string; compania_id: number };
};

/** Licencia atribuida por su acta (hasta F4.1), con el acta ya terminada: solo cuenta el estado de la licencia. */
const licencia = async (tx: Tx, proveedor: string, estado: string) => {
  const a = await acta(tx, proveedor, 'entregada');
  const codigo = (await tx`INSERT INTO organismos_transito_config (codigo) VALUES ('99999') ON CONFLICT (codigo) DO UPDATE SET codigo = EXCLUDED.codigo RETURNING codigo`)[0]!.codigo as string;
  const [v] = await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
  await tx`INSERT INTO flito_logistica_documentos (tipo, estado, organismo_codigo, vehiculo_id, acta_id)
    VALUES ('licencia_transito', ${estado}::flito_logistica_doc_estado, ${codigo}, ${v!.id}, ${a.id})`;
};

const usuario = async (tx: Tx, proveedor: string) => {
  const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE tipo_enlace = 'proveedor' ORDER BY codigo LIMIT 1`;
  return (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id, active)
    VALUES (${'hu14324_' + (++n)}, 'X', 'h', ${rol!.codigo}, ${proveedor}, true) RETURNING id`)[0]!.id as number;
};

const padre = async (tx: Tx, id: string) => (await tx`SELECT * FROM flito_proveedores WHERE id = ${id}`)[0]!;
const perfilLog = async (tx: Tx, id: string) => (await tx`SELECT * FROM flito_proveedores_logistica WHERE id = ${id}`)[0];
const perfilSoat = async (tx: Tx, id: string) => (await tx`SELECT * FROM flito_proveedores_soat WHERE id = ${id}`)[0];
const conteoAud = async (tx: Tx, id: string) => Number((await tx`SELECT count(*)::int AS n FROM flito_proveedores_auditoria WHERE proveedor_id = ${id}`)[0]!.n);

describe.skipIf(!URL_BASE)('0291 — unicidad entre vigentes', () => {
  it('quita la restricción con cualquiera de sus dos nombres, es idempotente y sus índices solo cuentan a los vigentes', async () => {
    await conBase(async (tx) => {
      const unicidad = async () => (await tx`SELECT conname FROM pg_constraint WHERE conrelid = 'flito_proveedores_logistica'::regclass AND contype = 'u'`).map((f) => f.conname);
      expect(await unicidad()).toEqual([]);
      await tx`ALTER TABLE flito_proveedores_logistica ADD CONSTRAINT flito_proveedores_logistica_nombre_key UNIQUE (nombre)`;
      await tx.unsafe(leerMigracion('0291_flito_proveedores_logistica_unicidad_viva.sql'));
      expect(await unicidad()).toEqual([]);
      await tx`ALTER TABLE flito_proveedores_logistica ADD CONSTRAINT flito_proveedores_logistica_nombre_unique UNIQUE (nombre)`;
      await tx.unsafe(leerMigracion('0291_flito_proveedores_logistica_unicidad_viva.sql'));
      expect(await unicidad()).toEqual([]);

      const [viva] = await tx`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ('uq_flito_proveedores_logistica_nombre_vivo', 'uq_flito_proveedores_logistica_nit') AND indexdef LIKE '%deleted_at IS NULL%'`;
      expect(viva!.n).toBe(2);
    });
  });
});

describe.skipIf(!URL_BASE)('HU #14332 — crear, editar y listar', () => {
  it('AC1: una identidad con un perfil por servicio; los datos de SOAT quedan solo en su perfil', async () => {
    await conBase(async (tx) => {
      const ambos = await crearCon(['soat', 'logistica']);
      expect(ambos.servicios).toEqual(['soat', 'logistica']);
      expect(ambos.datosCompletos).toBe(true);
      const log = await perfilLog(tx, ambos.id);
      expect(log).toMatchObject({ nit: expect.any(String), telefono: '3001234567', contacto: 'Ana Ruiz', deleted_at: null });
      expect(log).not.toHaveProperty('umbral_ocr');
      expect(await perfilSoat(tx, ambos.id)).toMatchObject({ estrategia: 'portal', sla_horas: 24 });
      expect(await padre(tx, ambos.id)).not.toHaveProperty('umbral_ocr');

      const soloSoat = await crearCon(['soat']);
      expect(soloSoat.servicios).toEqual(['soat']);
      expect(await perfilLog(tx, soloSoat.id)).toBeUndefined();
      const soloLog = await crearCon(['logistica']);
      expect(soloLog.servicios).toEqual(['logistica']);
      expect(await perfilSoat(tx, soloLog.id)).toBeUndefined();
    });
  });

  it('AC2: sin servicios → 422 y no se crea nada', async () => {
    await conBase(async (tx) => {
      const g = generales();
      expect(await rechazo(crearProveedor({ generales: g, servicios: [] }, ACTOR))).toBeInstanceOf(ProveedorSinServicioError);
      expect((await tx`SELECT count(*)::int AS n FROM flito_proveedores WHERE nombre = ${g.nombre}`)[0]!.n).toBe(0);
    });
  });

  it('AC4: datos de SOAT sin el servicio se rechazan al crear y al editar; no se guarda nada', async () => {
    await conBase(async (tx) => {
      const g = generales();
      const e = await rechazo(crearProveedor({ generales: g, servicios: ['logistica'], soat: SOAT }, ACTOR));
      expect(e).toBeInstanceOf(DatosSoatInvalidosError);
      expect((await tx`SELECT count(*)::int AS n FROM flito_proveedores WHERE nombre = ${g.nombre}`)[0]!.n).toBe(0);
      const log = await crearCon(['logistica']);
      expect(await rechazo(editarProveedor(log.id, { versionEsperada: log.version, soat: { umbralOcr: 0.5 } }, ACTOR)))
        .toBeInstanceOf(DatosSoatInvalidosError);
      expect(await perfilSoat(tx, log.id)).toBeUndefined();
    });
  });

  it('AC5: NIT con o sin dígito de verificación y nombre con mayúsculas o espacios responden 409; los de un eliminado quedan libres', async () => {
    await conBase(async () => {
      const uno = await crearCon(['logistica'], { nombre: 'Mensajería Uno HU14324', nit: '900123456' });
      const repetido = (o: Record<string, string>) => crearProveedor({ generales: generales(o), servicios: ['logistica'] }, ACTOR);

      let e = await rechazo(repetido({ nit: '900123456' }));
      expect(e).toBeInstanceOf(ProveedorDuplicadoError);
      expect(e.message).toBe('Ya existe un proveedor con ese NIT: Mensajería Uno HU14324');
      e = await rechazo(repetido({ nit: '900123456-7' }));
      expect(e.message).toBe('Ya existe un proveedor con ese NIT: Mensajería Uno HU14324');
      e = await rechazo(repetido({ nombre: '  mensajería   UNO hu14324 ' }));
      expect(e.message).toBe('Ya existe un proveedor con ese nombre: Mensajería Uno HU14324');

      const otro = await crearCon(['logistica']);
      e = await rechazo(editarProveedor(otro.id, { versionEsperada: otro.version, generales: generales({ nit: '900123456-7' }) }, ACTOR));
      expect(e.message).toBe('Ya existe un proveedor con ese NIT: Mensajería Uno HU14324');

      const inactivo = await cambiarEstadoProveedor(uno.id, { activo: false, versionEsperada: uno.version }, ACTOR);
      expect(inactivo.item.activo).toBe(false);
      await eliminarProveedor(uno.id, ACTOR);
      const libre = await repetido({ nombre: 'Mensajería Uno HU14324', nit: '900123456-7' });
      expect(libre.nombre).toBe('Mensajería Uno HU14324');
    });
  });

  it('un 23505 se traduce a 409 sin leer el DETAIL ni copiarlo', async () => {
    await conBase(async () => {
      const crudo = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'uq_flito_proveedores_nit_vivo', detail: 'Key (nit)=(900999999) already exists.' });
      const e = await rechazo(conUnicidadTraducida({ nit: '900999999', nombre: 'X' }, () => Promise.reject(crudo)));
      expect(e).toBeInstanceOf(ProveedorDuplicadoError);
      expect(e.message).not.toContain('900999999');
      expect(JSON.stringify(e)).not.toContain('900999999');
      expect(e).not.toHaveProperty('cause');
    });
  });

  it('un 23505 envuelto por Drizzle en `cause` también se traduce, con cualquiera de los nombres de la restricción', async () => {
    await conBase(async () => {
      for (const restriccion of ['flito_proveedores_logistica_nombre_key', 'flito_proveedores_logistica_nombre_unique', 'uq_flito_proveedores_nombre_vivo']) {
        const crudo = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('dup'), { code: '23505', constraint_name: restriccion }) });
        const e = await rechazo(conUnicidadTraducida({ nit: '900888888', nombre: 'Nombre HU14324' }, () => Promise.reject(crudo)));
        expect(e).toBeInstanceOf(ProveedorDuplicadoError);
        expect((e as unknown as { campo: string }).campo).toBe('nombre');
      }
      const otro = Object.assign(new Error('otro'), { code: '23503' });
      expect(await rechazo(conUnicidadTraducida({ nit: '1', nombre: 'X' }, () => Promise.reject(otro)))).toBe(otro);
    });
  });

  it('AC6: un proveedor migrado edita solo SOAT sin que se le exijan datos generales (el bloque completo se mide en routes)', async () => {
    await conBase(async (tx) => {
      const [fila] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('Migrado HU14324') RETURNING id`;
      const id = fila!.id as string;
      const [item] = (await listarProveedores({})).filter((p: { id: string }) => p.id === id);
      expect(item.datosCompletos).toBe(false);
      const editado = await editarProveedor(id, { versionEsperada: item.version, soat: { umbralOcr: 0.65 } }, ACTOR);
      expect(editado.version).toBeGreaterThan(item.version);
      expect(Number((await perfilSoat(tx, id))!.umbral_ocr)).toBe(0.65);
    });
  });

  it('AC7: el segundo con la versión anterior recibe 409 PROVEEDOR_EDITADO_POR_OTRO y no guarda', async () => {
    await conBase(async (tx) => {
      const p = await crearCon(['logistica']);
      const g1 = generales({ nit: p.nit!, nombre: p.nombre, ciudad: 'Cali' });
      const g2 = generales({ nit: p.nit!, nombre: p.nombre, ciudad: 'Bogotá' });
      await editarProveedor(p.id, { versionEsperada: p.version, generales: g1 }, ACTOR);
      const e = await rechazo(editarProveedor(p.id, { versionEsperada: p.version, generales: g2 }, ACTOR));
      expect(e).toBeInstanceOf(ProveedorEditadoPorOtroError);
      expect((e as unknown as { code: string }).code).toBe('PROVEEDOR_EDITADO_POR_OTRO');
      expect(e.message).toBe('Otro usuario cambió este proveedor. Recarga para ver sus datos');
      expect((await padre(tx, p.id)).ciudad).toBe('Cali');
    });
  });

  it('AC8: la lista trae lo acordado, filtra por servicio y estado, sin datos personales; umbral y ANS solo con SOAT', async () => {
    await conBase(async () => {
      const s = await crearCon(['soat']);
      const l = await crearCon(['logistica']);
      const a = await crearCon(['soat', 'logistica']);
      const ids = (lista: { id: string }[]) => lista.map((p) => p.id);

      const conSoat = await listarProveedores({ servicio: 'soat' });
      expect(ids(conSoat)).toEqual(expect.arrayContaining([s.id, a.id]));
      expect(ids(conSoat)).not.toContain(l.id);
      const conLog = await listarProveedores({ servicio: 'logistica' });
      expect(ids(conLog)).toEqual(expect.arrayContaining([l.id, a.id]));
      expect(ids(conLog)).not.toContain(s.id);

      await cambiarEstadoProveedor(s.id, { activo: false, versionEsperada: s.version }, ACTOR);
      expect(ids(await listarProveedores({ activo: false }))).toContain(s.id);
      expect(ids(await listarProveedores({ activo: true }))).not.toContain(s.id);

      const fila = (await listarProveedores()).find((p: { id: string }) => p.id === a.id);
      expect(Object.keys(fila).sort()).toEqual(['activo', 'companiasPorServicio', 'datosCompletos', 'id', 'nit', 'nombre', 'servicios', 'slaHoras', 'umbralOcr', 'version'].sort());
      expect(fila).toMatchObject({ umbralOcr: 0.8, slaHoras: 24, companiasPorServicio: { soat: 0, logistica: 0 } });
      const filaLog = (await listarProveedores()).find((p: { id: string }) => p.id === l.id);
      expect(filaLog).toMatchObject({ umbralOcr: null, slaHoras: null });
      expect(JSON.stringify(await listarProveedores())).not.toMatch(/3001234567|contacto\.real@empresa\.co|Calle 10|Ana Ruiz/);
    });
  });

  it('AC8: GET /proveedores-soat solo devuelve proveedores con el perfil de SOAT vigente', async () => {
    await conBase(async () => {
      const a = await crearCon(['soat', 'logistica']);
      await quitarServicio(a.id, 'soat', ACTOR);
      const b = await crearCon(['soat']);
      const app = express(); app.use(express.json());
      app.use('/p', (await import(`${P}/flito-parametrizacion.routes.js`)).default);
      const token = await testToken({ sub: 1, role: 'admin', funciones: ['parametrizacion.proveedores.listar'] });
      const r = await request(app).get('/p/proveedores-soat').set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
      const ids = r.body.map((p: { id: string }) => p.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(a.id);
    });
  });

  it('AC9: el detalle trae los datos generales y la configuración de SOAT; un eliminado responde 404', async () => {
    await conBase(async () => {
      const a = await crearCon(['soat', 'logistica']);
      const d = await detalleProveedor(a.id);
      expect(d).toMatchObject({ telefono: '3001234567', correo: 'contacto.real@empresa.co', ciudad: 'Medellín', contacto: 'Ana Ruiz', soat: { estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24 } });
      const { item } = await cambiarEstadoProveedor(a.id, { activo: false, versionEsperada: a.version }, ACTOR);
      expect(item.activo).toBe(false);
      await eliminarProveedor(a.id, ACTOR);
      expect(await rechazo(detalleProveedor(a.id))).toBeInstanceOf(ProveedorNoEncontradoError);
    });
  });

  it('selector: solo activos y vigentes con ese servicio; asignables a usuario, con cualquier servicio', async () => {
    await conBase(async () => {
      const s = await crearCon(['soat']);
      const l = await crearCon(['logistica']);
      const inactivo = await crearCon(['soat', 'logistica']);
      await cambiarEstadoProveedor(inactivo.id, { activo: false, versionEsperada: inactivo.version }, ACTOR);
      const eliminado = await crearCon(['soat', 'logistica']);
      const idsDe = async () => ({
        soat: (await selectorProveedores('soat')).map((p: { id: string }) => p.id),
        logistica: (await selectorProveedores('logistica')).map((p: { id: string }) => p.id),
        asignables: (await proveedoresAsignablesAUsuario()).map((p: { id: string }) => p.id),
      });
      // Control: vigente sale en los tres, así su ausencia de abajo la causa la baja y no el escenario.
      const antes = await idsDe();
      for (const lista of [antes.soat, antes.logistica, antes.asignables]) expect(lista).toContain(eliminado.id);
      await cambiarEstadoProveedor(eliminado.id, { activo: false, versionEsperada: eliminado.version }, ACTOR);
      await eliminarProveedor(eliminado.id, ACTOR);

      const { soat, logistica, asignables } = await idsDe();
      expect(soat).toContain(s.id);
      expect(soat).not.toContain(l.id);
      expect(soat).not.toContain(inactivo.id);
      expect(soat).not.toContain(eliminado.id);
      expect(logistica).toContain(l.id);
      expect(logistica).not.toContain(s.id);
      expect(logistica).not.toContain(inactivo.id);
      expect(logistica).not.toContain(eliminado.id);
      expect(asignables).toEqual(expect.arrayContaining([s.id, l.id]));
      expect(asignables).not.toContain(inactivo.id);
      expect(asignables).not.toContain(eliminado.id);
    });
  });
});

describe.skipIf(!URL_BASE)('HU #14333 — agregar y quitar servicios', () => {
  it('AC1: agregar SOAT conserva el identificador, con o sin sus datos (decisión del hilo: son opcionales)', async () => {
    await conBase(async (tx) => {
      const l = await crearCon(['logistica']);
      const r = await editarProveedor(l.id, { versionEsperada: l.version, servicios: ['logistica', 'soat'], soat: SOAT }, ACTOR);
      expect(r).toMatchObject({ id: l.id, servicios: ['soat', 'logistica'] });
      expect(await perfilSoat(tx, l.id)).toMatchObject({ id: l.id, estrategia: 'portal', sla_horas: 24 });

      const m = await crearCon(['logistica']);
      const sinDatos = await editarProveedor(m.id, { versionEsperada: m.version, servicios: ['logistica', 'soat'] }, ACTOR);
      expect(sinDatos).toMatchObject({ id: m.id, servicios: ['soat', 'logistica'], umbralOcr: null, slaHoras: null });
      expect(await perfilSoat(tx, m.id)).toMatchObject({ estrategia: 'portal', umbral_ocr: null, sla_horas: null });
    });
  });

  it('crear con SOAT sin sus datos toma los valores por defecto; al volver a dar SOAT se conservan los que tenía', async () => {
    await conBase(async (tx) => {
      const s = await crearProveedor({ generales: generales(), servicios: ['soat'] }, ACTOR);
      expect(s).toMatchObject({ servicios: ['soat'], umbralOcr: null, slaHoras: null });
      expect((await perfilSoat(tx, s.id))!.estrategia).toBe('portal');

      const a = await crearCon(['soat', 'logistica']);
      const q = await quitarServicio(a.id, 'soat', ACTOR);
      const r = await editarProveedor(a.id, { versionEsperada: q.version, servicios: ['soat', 'logistica'] }, ACTOR);
      expect(r).toMatchObject({ umbralOcr: 0.8, slaHoras: 24 });
    });
  });

  it('PATCH puede limpiar la estrategia con cadena vacía, y queda en la auditoría', async () => {
    await conBase(async (tx) => {
      const s = await crearCon(['soat']);
      await editarProveedor(s.id, { versionEsperada: s.version, soat: { estrategia: '' } }, ACTOR);
      expect((await perfilSoat(tx, s.id))!.estrategia).toBe('');
      const [f] = await tx`SELECT valor_antes, valor_despues FROM flito_proveedores_auditoria WHERE proveedor_id = ${s.id} AND accion = 'editar'`;
      expect(f).toEqual({ valor_antes: 'portal', valor_despues: '' });
    });
  });

  it('agregar un servicio cuenta como editar: exige los datos generales, incluido el NIT, y los acepta en la misma petición', async () => {
    await conBase(async (tx) => {
      const [fila] = await tx`INSERT INTO flito_proveedores_soat (nombre) VALUES ('Antiguo HU14324') RETURNING id`;
      const id = fila!.id as string;
      const version = (await padre(tx, id)).version as number;
      const e = await rechazo(editarProveedor(id, { versionEsperada: version, servicios: ['soat', 'logistica'] }, ACTOR));
      expect(e).toBeInstanceOf(GeneralesIncompletosError);
      expect((e as unknown as { campos: string[] }).campos).toEqual(['nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto']);
      expect(await perfilLog(tx, id)).toBeUndefined();

      const g = generales({ nombre: 'Antiguo HU14324' });
      const r = await editarProveedor(id, { versionEsperada: version, generales: g, servicios: ['soat', 'logistica'] }, ACTOR);
      expect(r.servicios).toEqual(['soat', 'logistica']);
      expect(await perfilLog(tx, id)).toMatchObject({ nit: g.nit, telefono: g.telefono });
    });
  });

  describe('cambiar el único servicio', () => {
    const SENTIDOS: readonly ['soat' | 'logistica', 'soat' | 'logistica'][] = [['soat', 'logistica'], ['logistica', 'soat']];

    it.each(SENTIDOS)('%s → %s: padre vigente, datos intactos, versión +1 y ningún perfil huérfano', async (de, a) => {
      await conBase(async (tx) => {
        const p = await crearCon([de]);
        const antes = await padre(tx, p.id);
        const r = await editarProveedor(p.id, { versionEsperada: p.version, servicios: [a] }, ACTOR);
        expect(r).toMatchObject({ id: p.id, servicios: [a], version: p.version + 1 });

        const despues = await padre(tx, p.id);
        expect(despues.deleted_at).toBeNull();
        for (const c of ['nombre', 'nit', 'telefono', 'correo', 'direccion', 'ciudad', 'contacto', 'activo']) expect(despues[c]).toEqual(antes[c]);
        expect(despues.version).toBe(p.version + 1);
        const vista = await tx`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${p.id}`;
        expect(vista.map((v) => v.servicio)).toEqual([a]);

        const log = await perfilLog(tx, p.id);
        const soat = await perfilSoat(tx, p.id);
        if (a === 'logistica') {
          expect(log).toMatchObject({ deleted_at: null, nit: p.nit, telefono: '3001234567', contacto: 'Ana Ruiz', nombre: p.nombre });
          expect(soat!.deleted_at).not.toBeNull();
        } else {
          expect(soat).toMatchObject({ deleted_at: null, nombre: p.nombre });
          expect(log).toMatchObject({ nit: null, telefono: null, contacto: null });
          expect(log!.deleted_at).not.toBeNull();
        }
        const aud = await tx`SELECT accion, valor_antes, valor_despues FROM flito_proveedores_auditoria WHERE proveedor_id = ${p.id} AND campo = 'servicio' AND accion <> 'crear' ORDER BY created_at, accion`;
        expect(aud).toEqual(expect.arrayContaining([
          { accion: 'servicio_quitado', valor_antes: de, valor_despues: null },
          { accion: 'servicio_agregado', valor_antes: null, valor_despues: a },
        ]));
      });
    });

    it.each(SENTIDOS)('%s → %s: los bloqueos del servicio saliente siguen aplicando y no cambia nada', async (de, a) => {
      await conBase(async (tx) => {
        const p = await crearCon([de]);
        await compania(tx, `Cia cambio ${++n}`, de === 'soat' ? { soat: p.id } : { logistica: p.id });
        const e = await rechazo(editarProveedor(p.id, { versionEsperada: p.version, servicios: [a] }, ACTOR));
        expect(e).toBeInstanceOf(ServicioNoQuitableError);
        expect((await padre(tx, p.id)).version).toBe(p.version);
        const vista = await tx`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${p.id}`;
        expect(vista.map((v) => v.servicio)).toEqual([de]);
      });
    });

    it('el perfil entrante toma los datos ya guardados: los de la misma petición y no una copia obsoleta del perfil retirado', async () => {
      await conBase(async (tx) => {
        const p = await crearCon(['soat', 'logistica']);
        const sinLog = await quitarServicio(p.id, 'logistica', ACTOR);
        const g = generales({ nombre: `Renombrado ${++n}`, telefono: '3119998877', contacto: 'Otra Persona' });
        const r = await editarProveedor(p.id, { versionEsperada: sinLog.version, generales: g, servicios: ['logistica'] }, ACTOR);
        expect(r.servicios).toEqual(['logistica']);
        expect(await perfilLog(tx, p.id)).toMatchObject({ deleted_at: null, nombre: g.nombre, nit: g.nit, telefono: '3119998877', contacto: 'Otra Persona' });

        const q = await padre(tx, p.id);
        const g2 = generales({ nombre: `Renombrado ${++n}`, nit: g.nit, telefono: '3220001122' });
        await editarProveedor(p.id, { versionEsperada: q.version as number, generales: g2, servicios: ['soat'] }, ACTOR);
        expect(await perfilSoat(tx, p.id)).toMatchObject({ deleted_at: null, nombre: g2.nombre, estrategia: 'portal', sla_horas: 24 });
        expect(await perfilLog(tx, p.id)).toMatchObject({ nit: null, telefono: null, contacto: null });
        expect(await padre(tx, p.id)).toMatchObject({ deleted_at: null, telefono: '3220001122', nit: g.nit });
      });
    });
  });

  it('PATCH con servicios aplica datos y servicios juntos: un bloqueo no deja nada escrito', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await compania(tx, 'Cia bloqueo', { soat: a.id });
      const g = generales({ nit: a.nit!, nombre: a.nombre, ciudad: 'Cali' });
      const e = await rechazo(editarProveedor(a.id, { versionEsperada: a.version, generales: g, servicios: ['logistica'] }, ACTOR));
      expect(e).toBeInstanceOf(ServicioNoQuitableError);
      expect((await padre(tx, a.id)).ciudad).toBe('Medellín');
      expect((await padre(tx, a.id)).version).toBe(a.version);
      expect((await perfilSoat(tx, a.id))!.deleted_at).toBeNull();
    });
  });

  it('AC2: volver a dar un servicio retirado reactiva el perfil con el mismo identificador', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      const sinLog = await quitarServicio(a.id, 'logistica', ACTOR);
      const log = await perfilLog(tx, a.id);
      expect(log!.deleted_at).not.toBeNull();
      const r = await editarProveedor(a.id, { versionEsperada: sinLog.version, servicios: ['soat', 'logistica'] }, ACTOR);
      expect(r.servicios).toEqual(['soat', 'logistica']);
      const filas = await tx`SELECT deleted_at, nit, telefono, contacto FROM flito_proveedores_logistica WHERE id = ${a.id}`;
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ deleted_at: null, nit: a.nit, telefono: '3001234567', contacto: 'Ana Ruiz' });
    });
  });

  it('AC3: quitar SOAT conserva Logística, deja baja lógica y los SOAT históricos siguen leyendo su estrategia', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await soatFila(tx, a.id, 'pagado');
      const r = await quitarServicio(a.id, 'soat', ACTOR);
      expect(r.servicios).toEqual(['logistica']);
      expect((await perfilSoat(tx, a.id))!.deleted_at).not.toBeNull();
      const [h] = await tx`SELECT p.estrategia FROM flito_soat s JOIN flito_proveedores_soat p ON p.id = s.proveedor_soat_id WHERE s.proveedor_soat_id = ${a.id}`;
      expect(h!.estrategia).toBe('portal');
      expect((await padre(tx, a.id)).deleted_at).toBeNull();
    });
  });

  it('AC4: quitar el último servicio responde 422 y lo conserva, aunque también tenga bloqueos', async () => {
    await conBase(async (tx) => {
      const s = await crearCon(['soat']);
      await compania(tx, 'Cia ultimo', { soat: s.id });
      const e = await rechazo(quitarServicio(s.id, 'soat', ACTOR));
      expect(e).toBeInstanceOf(ProveedorSinServicioError);
      expect(e.message).toBe('Marque al menos un servicio');
      expect((await perfilSoat(tx, s.id))!.deleted_at).toBeNull();
      const v = (await padre(tx, s.id)).version as number;
      expect(await rechazo(editarProveedor(s.id, { versionEsperada: v, servicios: [] }, ACTOR))).toBeInstanceOf(ProveedorSinServicioError);
    });
  });

  describe('AC5: bloqueos de SOAT', () => {
    const casos: [string, (tx: Tx, id: string) => Promise<unknown>, string, string][] = [
      ['compañías', (tx, id) => compania(tx, 'Cia soat', { soat: id }), 'No puede quitar SOAT: 1 compañía asignada', 'companias'],
      ['SOAT en curso', (tx, id) => soatFila(tx, id, 'solicitado'), 'No puede quitar SOAT: 1 SOAT en curso', 'soat_en_curso'],
      ['reglas', (tx, id) => tx`INSERT INTO flito_reglas_proveedor_soat (ambito, proveedor_soat_id, prioridad) VALUES ('global', ${id}, 30)`, 'No puede quitar SOAT: 1 regla de enrutamiento', 'reglas'],
    ];
    it.each(casos)('%s', async (_n, sembrar, mensaje, motivo) => {
      await conBase(async (tx) => {
        const a = await crearCon(['soat', 'logistica']);
        await sembrar(tx, a.id);
        const e = await rechazo(quitarServicio(a.id, 'soat', ACTOR)) as Error & { bloqueos: { motivo: string; cantidad: number }[] };
        expect(e).toBeInstanceOf(ServicioNoQuitableError);
        expect(e.message).toBe(mensaje);
        expect(e.bloqueos).toEqual([expect.objectContaining({ motivo, cantidad: 1 })]);
        expect((await perfilSoat(tx, a.id))!.deleted_at).toBeNull();
      });
    });
  });

  describe('AC6: bloqueos de Logística', () => {
    const casos: [string, (tx: Tx, id: string) => Promise<unknown>, RegExp][] = [
      ['compañía con logística encendida', (tx, id) => compania(tx, 'Cia log', { logistica: id }), /^No puede quitar Logística: 1 compañía asignada$/],
      ['compañía con logística apagada', (tx, id) => compania(tx, 'Cia apagada', { logistica: id, autogestionable: true }), /^No puede quitar Logística: 1 compañía asignada$/],
      ['acta generada', (tx, id) => acta(tx, id, 'generada'), /1 acta generada o despachada/],
      ['acta despachada', (tx, id) => acta(tx, id, 'despachada'), /1 acta generada o despachada/],
      ['licencia en acta', (tx, id) => licencia(tx, id, 'en_acta'), /1 licencia no entregada/],
      ['licencia con novedad', (tx, id) => licencia(tx, id, 'novedad'), /1 licencia no entregada/],
    ];
    it.each(casos)('%s', async (_n, sembrar, mensaje) => {
      await conBase(async (tx) => {
        const a = await crearCon(['soat', 'logistica']);
        await sembrar(tx, a.id);
        const e = await rechazo(quitarServicio(a.id, 'logistica', ACTOR));
        expect(e).toBeInstanceOf(ServicioNoQuitableError);
        expect(e.message).toMatch(mensaje);
        expect((await perfilLog(tx, a.id))!.deleted_at).toBeNull();
      });
    });
  });

  it.each(['entregado', 'devuelto'])('regla 4: una licencia %s cuenta como terminada y no bloquea quitar Logística', async (estado) => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await licencia(tx, a.id, estado);
      expect((await quitarServicio(a.id, 'logistica', ACTOR)).servicios).toEqual(['soat']);
    });
  });

  it('AC7: con todos sus SOAT pagados, sin compañías ni reglas, se quita sin error', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await soatFila(tx, a.id, 'pagado');
      expect((await quitarServicio(a.id, 'soat', ACTOR)).servicios).toEqual(['logistica']);
    });
  });

  it('un perfil de Logística retirado no recibe datos personales al editar el padre, y no se los pasa', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      const sin = await quitarServicio(a.id, 'logistica', ACTOR);
      expect(await perfilLog(tx, a.id)).toMatchObject({ nit: null, telefono: null, contacto: null });
      expect(await padre(tx, a.id)).toMatchObject({ nit: a.nit, telefono: '3001234567', contacto: 'Ana Ruiz' });

      const g = generales({ nit: a.nit!, nombre: a.nombre, telefono: '3119998877', contacto: 'Otra Persona' });
      await editarProveedor(a.id, { versionEsperada: sin.version, generales: g }, ACTOR);
      expect(await perfilLog(tx, a.id)).toMatchObject({ nit: null, telefono: null, contacto: null });

      await tx`UPDATE flito_proveedores_logistica SET telefono = '3000000000' WHERE id = ${a.id}`;
      expect((await padre(tx, a.id)).telefono).toBe('3119998877');
    });
  });
});

describe.skipIf(!URL_BASE)('HU #14334 — inactivar y eliminar', () => {
  it('AC1: solo Logística con compañías → 409 con la cantidad y sigue activo', async () => {
    await conBase(async (tx) => {
      const l = await crearCon(['logistica']);
      await compania(tx, 'Cia uno', { logistica: l.id });
      await compania(tx, 'Cia dos', { logistica: l.id });
      const e = await rechazo(cambiarEstadoProveedor(l.id, { activo: false, versionEsperada: l.version }, ACTOR));
      expect(e).toBeInstanceOf(ProveedorLogisticaAsignadoError);
      expect(e.message).toContain('2 compañías');
      expect(e.message).toContain('Asigne otro proveedor primero.');
      expect((await padre(tx, l.id)).activo).toBe(true);
    });
  });

  it('AC2: con ambos servicios sigue la regla de Logística; con compañías solo de SOAT se inactiva', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await compania(tx, 'Cia log', { logistica: a.id });
      expect(await rechazo(cambiarEstadoProveedor(a.id, { activo: false, versionEsperada: a.version }, ACTOR))).toBeInstanceOf(ProveedorLogisticaAsignadoError);
      const b = await crearCon(['soat', 'logistica']);
      await compania(tx, 'Cia soat', { soat: b.id });
      expect((await cambiarEstadoProveedor(b.id, { activo: false, versionEsperada: b.version }, ACTOR)).item.activo).toBe(false);
    });
  });

  it('reactivar funciona aunque tenga compañías de Logística', async () => {
    await conBase(async (tx) => {
      const l = await crearCon(['logistica']);
      const { item } = await cambiarEstadoProveedor(l.id, { activo: false, versionEsperada: l.version }, ACTOR);
      await compania(tx, 'Cia reactivar', { logistica: l.id });
      expect((await cambiarEstadoProveedor(l.id, { activo: true, versionEsperada: item.version }, ACTOR)).item.activo).toBe(true);
    });
  });

  it('AC3: solo SOAT con compañías queda inactivo sin error, e invalida las sesiones de sus usuarios', async () => {
    await conBase(async (tx) => {
      const s = await crearCon(['soat']);
      await compania(tx, 'Cia', { soat: s.id });
      const u = await usuario(tx, s.id);
      const r = await cambiarEstadoProveedor(s.id, { activo: false, versionEsperada: s.version }, ACTOR);
      expect(r.item.activo).toBe(false);
      expect(r.usuariosInvalidados).toEqual([u]);
      expect((await tx`SELECT session_invalidated_at IS NOT NULL AS i, active FROM users WHERE id = ${u}`)[0]).toEqual({ i: true, active: true });
      expect((await perfilSoat(tx, s.id))!.activo).toBe(false);
    });
  });

  it('AC4: el estado con la versión anterior responde 409 y no cambia', async () => {
    await conBase(async (tx) => {
      const p = await crearCon(['logistica']);
      await editarProveedor(p.id, { versionEsperada: p.version, generales: generales({ nit: p.nit!, nombre: p.nombre, ciudad: 'Cali' }) }, ACTOR);
      const e = await rechazo(cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR));
      expect(e).toBeInstanceOf(ProveedorEditadoPorOtroError);
      expect((await padre(tx, p.id)).activo).toBe(true);
    });
  });

  it('AC5: el impacto trae los bloqueos por servicio y las sesiones afectadas', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      await compania(tx, 'Cia log', { logistica: a.id });
      await tx`INSERT INTO flito_reglas_proveedor_soat (ambito, proveedor_soat_id, prioridad) VALUES ('global', ${a.id}, 30)`;
      await usuario(tx, a.id);
      const i = await impactoProveedor(a.id);
      expect(i.sesionesAfectadas).toBe(1);
      expect(i.bloqueosPorServicio.soat).toEqual([expect.objectContaining({ motivo: 'reglas', cantidad: 1 })]);
      expect(i.bloqueosPorServicio.logistica).toEqual([expect.objectContaining({ motivo: 'companias', cantidad: 1 })]);
      expect(i.puedeInactivar).toBe(false);
      expect(i.puedeEliminar).toBe(false);
    });
  });

  it('AC6: baja lógica de padre y perfiles, sin datos personales, con nombre y NIT libres y usuarios inactivos', async () => {
    await conBase(async (tx) => {
      const a = await crearCon(['soat', 'logistica']);
      const u = await usuario(tx, a.id);
      const { item } = await cambiarEstadoProveedor(a.id, { activo: false, versionEsperada: a.version }, ACTOR);
      const r = await eliminarProveedor(a.id, ACTOR);
      expect(r).toMatchObject({ id: a.id, nombre: a.nombre, usuariosDesactivados: [u] });
      const p = await padre(tx, a.id);
      expect(p.deleted_at).not.toBeNull();
      expect(p).toMatchObject({ nit: null, telefono: null, correo: null, direccion: null, contacto: null, nombre: a.nombre });
      expect(p.version).toBeGreaterThan(item.version);
      expect(await perfilLog(tx, a.id)).toMatchObject({ nit: null, telefono: null, contacto: null });
      expect((await perfilLog(tx, a.id))!.deleted_at).not.toBeNull();
      expect((await perfilSoat(tx, a.id))!.deleted_at).not.toBeNull();
      expect((await tx`SELECT active, session_invalidated_at IS NOT NULL AS i FROM users WHERE id = ${u}`)[0]).toEqual({ active: false, i: true });
      expect((await crearCon(['logistica'], { nombre: a.nombre, nit: a.nit! })).nombre).toBe(a.nombre);
    });
  });

  it('una escritura sobre un perfil de baja no le devuelve datos personales al padre eliminado', async () => {
    await conBase(async (tx) => {
      const l = await crearCon(['logistica']);
      await cambiarEstadoProveedor(l.id, { activo: false, versionEsperada: l.version }, ACTOR);
      await eliminarProveedor(l.id, ACTOR);
      await tx`UPDATE flito_proveedores_logistica SET telefono = '3000000000', nit = '900777777' WHERE id = ${l.id}`;
      expect(await padre(tx, l.id)).toMatchObject({ telefono: null, nit: null });
    });
  });

  it('AC7: activo, o con un bloqueo de cualquier servicio → 409 con el motivo y no cambia nada', async () => {
    await conBase(async (tx) => {
      const activo = await crearCon(['logistica']);
      let e = await rechazo(eliminarProveedor(activo.id, ACTOR));
      expect(e).toBeInstanceOf(ProveedorNoEliminableError);
      expect(e.message).toBe('Primero debe desactivarlo.');
      expect((await padre(tx, activo.id)).deleted_at).toBeNull();

      const conReglas = await crearCon(['soat', 'logistica']);
      await cambiarEstadoProveedor(conReglas.id, { activo: false, versionEsperada: conReglas.version }, ACTOR);
      await tx`INSERT INTO flito_reglas_proveedor_soat (ambito, proveedor_soat_id, prioridad) VALUES ('global', ${conReglas.id}, 30)`;
      e = await rechazo(eliminarProveedor(conReglas.id, ACTOR));
      expect(e.message).toBe('No se puede eliminar. SOAT: 1 regla de enrutamiento.');
      expect((await padre(tx, conReglas.id)).nit).toBe(conReglas.nit);

      const conActa = await crearCon(['logistica']);
      await cambiarEstadoProveedor(conActa.id, { activo: false, versionEsperada: conActa.version }, ACTOR);
      await acta(tx, conActa.id, 'despachada');
      e = await rechazo(eliminarProveedor(conActa.id, ACTOR));
      expect(e.message).toBe('No se puede eliminar. Logística: 1 acta generada o despachada.');
    });
  });

  it('AC8: un proveedor de Logística sin historia y otro con actas terminadas conservan la fila', async () => {
    await conBase(async (tx) => {
      for (const conActaTerminada of [false, true]) {
        const l = await crearCon(['logistica']);
        await cambiarEstadoProveedor(l.id, { activo: false, versionEsperada: l.version }, ACTOR);
        if (conActaTerminada) await acta(tx, l.id, 'entregada');
        await eliminarProveedor(l.id, ACTOR);
        expect((await perfilLog(tx, l.id))!.deleted_at).not.toBeNull();
        expect((await padre(tx, l.id)).deleted_at).not.toBeNull();
      }
      const modulo = await import(`${P}/flito-proveedores-logistica-gestion.service.js`);
      expect(modulo).not.toHaveProperty('eliminarProveedorLogistica');
    });
  });

  it('un perfil de Logística de baja no se lista ni se puede asignar a una compañía', async () => {
    await conBase(async () => {
      const { exigirProveedorLogisticaUsable, ProveedorLogisticaNoUsableError } = await import(`${P}/flito-logistica-proveedor-compania.service.js`);
      const a = await crearCon(['soat', 'logistica']);
      await quitarServicio(a.id, 'logistica', ACTOR);
      expect((await listarProveedoresLogistica()).map((p: { id: string }) => p.id)).not.toContain(a.id);
      expect(await rechazo(exigirProveedorLogisticaUsable(actual.db, a.id))).toBeInstanceOf(ProveedorLogisticaNoUsableError);
    });
  });
});

describe.skipIf(!URL_BASE)('HU #14335 — auditoría', () => {
  it('AC1: al crear y al editar, una fila por campo cambiado con quién, antes y después', async () => {
    await conBase(async (tx) => {
      const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE tipo_enlace = 'ninguno' ORDER BY codigo LIMIT 1`;
      const actorId = (await tx`INSERT INTO users (username, name, password_hash, role) VALUES ('hu14324_actor', 'Actor', 'h', ${rol!.codigo}) RETURNING id`)[0]!.id as number;
      const actor = { userId: actorId, email: null, rol: null };
      const p = await crearProveedor({ generales: generales({ ciudad: 'Cali' }), servicios: ['logistica'] }, actor);
      const alta = await tx`SELECT campo, valor_antes, valor_despues, actor_id FROM flito_proveedores_auditoria WHERE proveedor_id = ${p.id} AND accion = 'crear'`;
      expect(alta.map((f) => f.campo).sort()).toEqual(['ciudad', 'contacto', 'correo', 'direccion', 'nit', 'nombre', 'telefono']);
      expect(alta.find((f) => f.campo === 'ciudad')).toMatchObject({ valor_antes: null, valor_despues: 'Cali', actor_id: actorId });

      const g = generales({ nit: p.nit!, nombre: p.nombre, ciudad: 'Pasto' });
      await editarProveedor(p.id, { versionEsperada: p.version, generales: g }, actor);
      const cambio = await tx`SELECT campo, valor_antes, valor_despues FROM flito_proveedores_auditoria WHERE proveedor_id = ${p.id} AND accion = 'editar'`;
      expect(cambio).toEqual([{ campo: 'ciudad', valor_antes: 'Cali', valor_despues: 'Pasto' }]);
      const [cuando] = await tx`SELECT created_at IS NOT NULL AS tiene FROM flito_proveedores_auditoria WHERE proveedor_id = ${p.id} LIMIT 1`;
      expect(cuando!.tiene).toBe(true);
    });
  });

  it('AC2: servicios, estado y baja dejan su acción, con el actor real', async () => {
    await conBase(async (tx) => {
      const [rol] = await tx`SELECT codigo FROM permisos_roles WHERE tipo_enlace = 'ninguno' ORDER BY codigo LIMIT 1`;
      const actorId = (await tx`INSERT INTO users (username, name, password_hash, role) VALUES ('hu14324_actor_ac2', 'Actor', 'h', ${rol!.codigo}) RETURNING id`)[0]!.id as number;
      const actor = { userId: actorId, email: null, rol: null };
      const a = await crearProveedor({ generales: generales(), servicios: ['soat', 'logistica'], soat: SOAT }, actor);
      const q = await quitarServicio(a.id, 'soat', actor);
      const r = await editarProveedor(a.id, { versionEsperada: q.version, servicios: ['soat', 'logistica'], soat: SOAT }, actor);
      const des = await cambiarEstadoProveedor(a.id, { activo: false, versionEsperada: r.version }, actor);
      const act = await cambiarEstadoProveedor(a.id, { activo: true, versionEsperada: des.item.version }, actor);
      await cambiarEstadoProveedor(a.id, { activo: false, versionEsperada: act.item.version }, actor);
      await eliminarProveedor(a.id, actor);
      const filas = await tx`SELECT DISTINCT accion, actor_id, created_at IS NOT NULL AS con_fecha FROM flito_proveedores_auditoria WHERE proveedor_id = ${a.id} ORDER BY accion`;
      expect(filas).toEqual(['activar', 'crear', 'desactivar', 'eliminar', 'servicio_agregado', 'servicio_quitado']
        .map((accion) => ({ accion, actor_id: actorId, con_fecha: true })));
    });
  });

  it('AC3: un teléfono migrado de cualquier longitud no queda en claro en `valor_antes`', async () => {
    await conBase(async (tx) => {
      for (const [telefono, mascara] of [['4441234', '*****34'], ['31055512', '******12'], ['12345', '***45'], ['Tel. 444 12 34', '*****34'], ['sin numero', '']] as const) {
        const nombre = `Migrado tel HU14324 ${++n}`;
        const [fila] = await tx`INSERT INTO flito_proveedores_logistica (nombre, telefono) VALUES (${nombre}, ${telefono}) RETURNING id`;
        const id = fila!.id as string;
        const { version } = await padre(tx, id);
        await editarProveedor(id, { versionEsperada: version as number, generales: generales({ nombre }) }, ACTOR);
        const [f] = await tx`SELECT valor_antes, valor_despues FROM flito_proveedores_auditoria WHERE proveedor_id = ${id} AND campo = 'telefono'`;
        expect(f).toEqual({ valor_antes: mascara, valor_despues: '300***4567' });
      }
    });
  });

  it('AC3: en la fila los valores de teléfono, correo, dirección, contacto y NIT están enmascarados, antes y después', async () => {
    await conBase(async (tx) => {
      const claro = { nit: '900654321', telefono: '3001112233', correo: 'persona.real@empresa.co', direccion: 'Carrera 45 # 67-89', contacto: 'Beatriz Londoño' };
      const nuevo = { telefono: '3114445566', correo: 'otra.persona@empresa.co', direccion: 'Avenida 80 # 12-34', contacto: 'Carlos Pérez', nit: '900654321-1' };
      const p = await crearProveedor({ generales: generales(claro), servicios: ['logistica'] }, ACTOR);
      await editarProveedor(p.id, { versionEsperada: p.version, generales: { ...generales({ nombre: p.nombre }), ...nuevo } }, ACTOR);
      const filas = await tx`SELECT * FROM flito_proveedores_auditoria WHERE proveedor_id = ${p.id}`;
      const crudo = JSON.stringify(filas);
      for (const v of [...Object.values(claro), ...Object.values(nuevo)]) expect(crudo).not.toContain(v);
      const edicion = filas.filter((f) => f.accion === 'editar');
      expect(edicion.map((f) => f.campo).sort()).toEqual(['ciudad', 'contacto', 'correo', 'direccion', 'nit', 'telefono'].filter((c) => c !== 'ciudad').sort());
      expect(edicion.find((f) => f.campo === 'telefono')).toMatchObject({ valor_antes: '300***2233', valor_despues: '311***5566' });
      expect(edicion.find((f) => f.campo === 'contacto')).toMatchObject({ valor_antes: 'B. L.', valor_despues: 'C. P.' });
    });
  });

  it('AC5: si falla el registro de auditoría la transacción se revierte y el proveedor queda como estaba', async () => {
    await conBase(async (tx) => {
      const p = await crearCon(['logistica']);
      await tx.unsafe(`CREATE FUNCTION pg_temp.falla_aud() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'auditoria caida'; END $f$;
        CREATE TRIGGER falla_aud BEFORE INSERT ON flito_proveedores_auditoria FOR EACH ROW EXECUTE FUNCTION pg_temp.falla_aud()`);
      const g = generales({ nit: p.nit!, nombre: p.nombre, ciudad: 'Tunja' });
      const fallo = await rechazo(editarProveedor(p.id, { versionEsperada: p.version, generales: g }, ACTOR)) as Error & { cause?: Error };
      expect(fallo.cause?.message).toContain('auditoria caida');
      const fila = await padre(tx, p.id);
      expect(fila).toMatchObject({ ciudad: 'Medellín', version: p.version });
      await rechazo(cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR));
      expect((await padre(tx, p.id)).activo).toBe(true);
      const nombre = generales().nombre;
      await rechazo(crearProveedor({ generales: generales({ nombre }), servicios: ['logistica'] }, ACTOR));
      expect((await tx`SELECT count(*)::int AS n FROM flito_proveedores WHERE nombre = ${nombre}`)[0]!.n).toBe(0);
    });
  });

  it('AC6: el historial trae lo auditado con las máscaras, también de un proveedor eliminado', async () => {
    await conBase(async (tx) => {
      const p = await crearCon(['logistica'], { telefono: '3001112233' });
      await cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR);
      await eliminarProveedor(p.id, ACTOR);
      const h = await historialProveedor(p.id);
      expect(h).toHaveLength(await conteoAud(tx, p.id));
      expect(h.map((f: { accion: string }) => f.accion)).toEqual(expect.arrayContaining(['crear', 'desactivar', 'eliminar']));
      expect(JSON.stringify(h)).not.toContain('3001112233');
      expect(h.find((f: { campo: string | null }) => f.campo === 'telefono')).toMatchObject({ valorDespues: '300***2233', actorId: null, fecha: expect.any(String) });
    });
  });
});

/** Las carreras necesitan conexiones reales: solo donde la 0291 está aplicada de verdad. Limpia lo que confirma. */
async function conConexionesReales(fn: (sql: postgres.Sql) => Promise<void>, limpiar: (sql: postgres.Sql) => Promise<void>, ctx: { skip: () => void }) {
  const sql = postgres(URL_BASE!, { max: 4, onnotice: () => {} });
  try {
    const [f] = await sql`SELECT to_regclass('flito_proveedores') IS NOT NULL AS hay,
      EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_flito_proveedores_logistica_nombre_vivo') AS tiene_0290`;
    if (!f!.hay || !f!.tiene_0290) { ctx.skip(); return; }
    await sembrarAdminActivo(sql);
    actual.real = drizzle(sql, { schema });
    await fn(sql);
  } finally {
    actual.real = null;
    await limpiar(sql);
    await borrarAdminDePrueba(sql);
    await sql.end();
  }
}

const borrarProveedores = async (sql: postgres.Sql, ids: string[]) => {
  if (ids.length === 0) return;
  await sql`DELETE FROM flito_proveedores_auditoria WHERE proveedor_id IN ${sql(ids)}`;
  await sql`DELETE FROM flito_proveedores_soat WHERE id IN ${sql(ids)}`;
  await sql`DELETE FROM flito_proveedores_logistica WHERE id IN ${sql(ids)}`;
  await sql`DELETE FROM flito_proveedores WHERE id IN ${sql(ids)}`;
};

describe.skipIf(!URL_BASE)('carreras (conexiones reales)', () => {
  it('HU #14333 AC8: dos retiros simultáneos de servicios distintos: uno termina y el otro recibe 422; conserva un servicio', async (ctx) => {
    const ids: string[] = [];
    await conConexionesReales(async (sql) => {
      const p = await crearCon(['soat', 'logistica']);
      ids.push(p.id);
      const r = await Promise.allSettled([quitarServicio(p.id, 'soat', ACTOR), quitarServicio(p.id, 'logistica', ACTOR)]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const ko = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
      expect(ko).toHaveLength(1);
      expect(ko[0]!.reason).toBeInstanceOf(ProveedorSinServicioError);
      expect(ko[0]!.reason.message).toBe('Marque al menos un servicio');
      const [v] = await sql`SELECT count(*)::int AS n FROM flito_proveedor_servicios_v WHERE proveedor_id = ${p.id}`;
      expect(v!.n).toBe(1);
    }, (sql) => borrarProveedores(sql, ids), ctx);
  });

  it('dos altas con el mismo NIT: una gana y la otra recibe 409 sin el NIT en el error', async (ctx) => {
    const nit = `9${String(Date.now()).slice(-8)}`;
    await conConexionesReales(async () => {
      const r = await Promise.allSettled([
        crearProveedor({ generales: generales({ nit }), servicios: ['logistica'] }, ACTOR),
        crearProveedor({ generales: generales({ nit }), servicios: ['logistica'] }, ACTOR),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const ko = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')!;
      expect(ko.reason).toBeInstanceOf(ProveedorDuplicadoError);
      expect(ko.reason.message).not.toContain(nit);
    }, async (sql) => {
      const filas = await sql`SELECT id FROM flito_proveedores WHERE nit = ${nit}`;
      await borrarProveedores(sql, filas.map((f) => f.id as string));
    }, ctx);
  });

  it('dos bajas simultáneas: una elimina y la otra recibe 409', async (ctx) => {
    const ids: string[] = [];
    await conConexionesReales(async (sql) => {
      const p = await crearCon(['soat', 'logistica']);
      ids.push(p.id);
      await cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR);
      const r = await Promise.allSettled([eliminarProveedor(p.id, ACTOR), eliminarProveedor(p.id, ACTOR)]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(r.find((x): x is PromiseRejectedResult => x.status === 'rejected')!.reason).toBeInstanceOf(EstadoProveedorCambiadoError);
      const [f] = await sql`SELECT deleted_at IS NOT NULL AS baja, nit, telefono FROM flito_proveedores WHERE id = ${p.id}`;
      expect(f).toEqual({ baja: true, nit: null, telefono: null });
    }, (sql) => borrarProveedores(sql, ids), ctx);
  });

  describe('RN-PLOGC-3: inactivar contra una asignación en curso', () => {
    const preparar = async (sql: postgres.Sql, ids: string[], companias: number[]) => {
      const p = await crearCon(['logistica']);
      ids.push(p.id);
      const [c] = await sql`INSERT INTO clients (name) VALUES (${`Cia carrera HU14324 ${++n}`}) RETURNING id`;
      companias.push(c!.id as number);
      return { p, compania: c!.id as number };
    };
    const limpiar = async (sql: postgres.Sql, ids: string[], companias: number[]) => {
      if (companias.length > 0) await sql`DELETE FROM clients WHERE id IN ${sql(companias)}`;
      await borrarProveedores(sql, ids);
    };

    it('la asignación toma el perfil primero: inactivar espera, ve la compañía y responde 409', async (ctx) => {
      const ids: string[] = []; const companias: number[] = [];
      await conConexionesReales(async (sql) => {
        const { p, compania: c } = await preparar(sql, ids, companias);
        let soltar!: () => void;
        const liberar = new Promise<void>((r) => { soltar = r; });
        let tomado!: () => void;
        const asignacionTomada = new Promise<void>((r) => { tomado = r; });
        const asignar = sql.begin(async (tx) => {
          await tx`SELECT activo FROM flito_proveedores_logistica WHERE id = ${p.id} AND deleted_at IS NULL FOR SHARE`;
          await tx`UPDATE clients SET flito_proveedor_logistica_id = ${p.id} WHERE id = ${c}`;
          tomado();
          await liberar;
        });
        await asignacionTomada;
        const inactivar = cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR);
        await new Promise((r) => { setTimeout(r, 300); });
        soltar();
        await asignar;
        expect(await rechazo(inactivar)).toBeInstanceOf(ProveedorLogisticaAsignadoError);
        const [f] = await sql`SELECT activo FROM flito_proveedores WHERE id = ${p.id}`;
        expect(f!.activo).toBe(true);
      }, (sql) => limpiar(sql, ids, companias), ctx);
    });

    it('la inactivación toma el perfil primero: la asignación espera, relee y se rechaza', async (ctx) => {
      const { exigirProveedorLogisticaUsable, ProveedorLogisticaNoUsableError } = await import(`${P}/flito-logistica-proveedor-compania.service.js`);
      const ids: string[] = []; const companias: number[] = [];
      await conConexionesReales(async (sql) => {
        const { p, compania: c } = await preparar(sql, ids, companias);
        // La auditoría es lo último que escribe la inactivación: bloquear su tabla la retiene ya con los perfiles tomados.
        let soltar!: () => void;
        const liberar = new Promise<void>((r) => { soltar = r; });
        let tomado!: () => void;
        const auditoriaTomada = new Promise<void>((r) => { tomado = r; });
        const retencion = sql.begin(async (tx) => {
          await tx`LOCK TABLE flito_proveedores_auditoria IN ACCESS EXCLUSIVE MODE`;
          tomado();
          await liberar;
        });
        await auditoriaTomada;
        const inactivar = cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR);
        await new Promise((r) => { setTimeout(r, 300); });
        const asignar = actual.real!.transaction(async (tx) => {
          await exigirProveedorLogisticaUsable(tx, p.id);
          await tx.update(schema.clients).set({ flitoProveedorLogisticaId: p.id }).where(eq(schema.clients.id, c));
        });
        await new Promise((r) => { setTimeout(r, 300); });
        soltar();
        await retencion;
        expect((await inactivar).item.activo).toBe(false);
        expect(await rechazo(asignar)).toBeInstanceOf(ProveedorLogisticaNoUsableError);
        const [f] = await sql`SELECT flito_proveedor_logistica_id AS proveedor FROM clients WHERE id = ${c}`;
        expect(f!.proveedor).toBeNull();
      }, (sql) => limpiar(sql, ids, companias), ctx);
    });
  });

  describe('orden canónico de bloqueos, con un proveedor con ambos servicios: sin 40P01', () => {
    const CASOS: readonly [string, (p: { id: string; version: number }) => Promise<unknown>][] = [
      ['inactivar', (p) => cambiarEstadoProveedor(p.id, { activo: false, versionEsperada: p.version }, ACTOR)],
      ['quitar Logística por PATCH', (p) => editarProveedor(p.id, { versionEsperada: p.version, servicios: ['soat'] }, ACTOR)],
      ['quitar Logística por DELETE', (p) => quitarServicio(p.id, 'logistica', ACTOR)],
      ['quitar SOAT por PATCH', (p) => editarProveedor(p.id, { versionEsperada: p.version, servicios: ['logistica'] }, ACTOR)],
    ];
    it.for(CASOS)('%s, mientras una asignación retiene SOAT y luego pide Logística', async ([, escribir], ctx) => {
      const ids: string[] = [];
      await conConexionesReales(async (sql) => {
        const p = await crearCon(['soat', 'logistica']);
        ids.push(p.id);
        let tomado!: () => void;
        const soatTomado = new Promise<void>((r) => { tomado = r; });
        let continuar!: () => void;
        const seguir = new Promise<void>((r) => { continuar = r; });
        const asignacion = sql.begin(async (tx) => {
          await tx`SELECT activo FROM flito_proveedores_soat WHERE id = ${p.id} FOR SHARE`;
          tomado();
          await seguir;
          await tx`SELECT activo FROM flito_proveedores_logistica WHERE id = ${p.id} FOR SHARE`;
        });
        await soatTomado;
        const escritura = escribir(p);
        await new Promise((r) => { setTimeout(r, 300); });
        continuar();
        const [a, b] = await Promise.allSettled([asignacion, escritura]);
        expect(a.status === 'rejected' ? (a.reason as { code?: string }).code : 'ok').toBe('ok');
        expect(b.status === 'rejected' ? String((b.reason as { cause?: { code?: string } }).cause?.code ?? b.reason) : 'ok').toBe('ok');
      }, (sql) => borrarProveedores(sql, ids), ctx);
    });
  });
});
