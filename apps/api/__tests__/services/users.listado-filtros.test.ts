// Usuarios — filtros, paginación, descarga y resumen (HU #12172, Feature #12072).
//
// Este archivo NO usa el `chain()` de los helpers para el listado, y es deliberado: aquel ignora el
// `where`, el `limit` y el `orderBy`, así que un test escrito sobre él daría verde con un servidor
// que se pasa los filtros por alto —exactamente el defecto que esta HU corrige—. El mock de aquí
// RENDERIZA la condición que llegó a `.where()` y filtra las filas con ella: si el servidor no ata
// el filtro a la consulta, la condición no aparece y en la respuesta salen usuarios de otros roles.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { testToken } from '../helpers/auth.js';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

// `authMiddleware` y `requireRole` son los DE VERDAD: con unos de mentira, los 401/403 de la
// descarga no probarían nada.

type Fila = Record<string, unknown>;

const dialecto = new PgDialect();
const render = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = dialecto.sqlToQuery(cond as never);
  return { sql: q.sql, params: q.params as unknown[] };
};

/**
 * Evalúa el `WHERE` RENDERIZADO sobre las filas de mentira.
 *
 * No es un intérprete de SQL: reconoce las tres formas que este endpoint puede producir y aplica
 * cada una. Lo importante es de dónde sale la información — de la condición que el servidor le pasó
 * a drizzle, no de lo que el test quiso creer.
 */
function filtrarSegunSql(filas: Fila[], cond: unknown): Fila[] {
  if (cond === undefined || cond === null) return filas;
  const { sql, params } = render(cond);
  let out = filas;

  const rol = /"role" = \$(\d+)/.exec(sql);
  if (rol) out = out.filter((f) => f.role === params[Number(rol[1]) - 1]);

  const activo = /"active" = \$(\d+)/.exec(sql);
  if (activo) out = out.filter((f) => f.active === params[Number(activo[1]) - 1]);

  const like = /ilike \$(\d+)/.exec(sql);
  if (like) {
    const patron = String(params[Number(like[1]) - 1])
      .replace(/^%/, '').replace(/%$/, '')
      .replace(/\\([\\%_])/g, '$1')
      .toLowerCase();
    out = out.filter((f) => ['username', 'name', 'email']
      .some((k) => String(f[k] ?? '').toLowerCase().includes(patron)));
  }
  return out;
}

/** Deja de la fila solo las claves de la proyección: lo que no está en el `select` no sale. */
function proyectar(fila: Fila, sel: Fila): Fila {
  const out: Fila = {};
  for (const k of Object.keys(sel)) out[k] = fila[k] ?? null;
  return out;
}

interface Espia {
  whereSql: string;
  whereParams: unknown[];
  limite?: number;
  desplazamiento?: number;
  agrupadoPor: string[];
  /** Cuántas veces se ejecutó el `count(*)` del total. */
  conteos: number;
  /** Cuántas veces se pidieron nombres de compañía (tiene que ser 0 ó 1: nunca una por fila). */
  lecturasDeCompania: number;
  llamadas: number;
}

interface Escenario {
  filas: Fila[];
  organismos?: { userId: number; codigo: string }[];
  /** HU #12087: excepciones por usuario (`permisos_usuario_funcion`) que el listado pide en lote. */
  funciones?: { userId: number; codigo: string; efecto: string }[];
  companias?: { id: number; name: string }[];
  proveedores?: { id: string; nombre: string }[];
  grupos?: { role: string; active: boolean; total: number }[];
}

function instalarBd(esc: Escenario): Espia {
  const espia: Espia = {
    whereSql: '', whereParams: [], agrupadoPor: [], conteos: 0, lecturasDeCompania: 0, llamadas: 0,
  };

  const constructor = (sel: Fila, resolver: (cond: unknown, lim?: number, off?: number) => unknown[]) => {
    let cond: unknown;
    let limite: number | undefined;
    let desplazamiento: number | undefined;
    const t: Record<string, unknown> = {
      from: () => t,
      where: (c: unknown) => { cond = c; return t; },
      orderBy: () => t,
      groupBy: (...cols: unknown[]) => {
        espia.agrupadoPor = cols.map((c) => String((c as { name?: string }).name ?? '?'));
        return t;
      },
      limit: (n: number) => { limite = n; espia.limite = n; return t; },
      offset: (n: number) => { desplazamiento = n; espia.desplazamiento = n; return t; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          if (cond !== undefined && cond !== null) {
            const r = render(cond);
            espia.whereSql = r.sql;
            espia.whereParams = r.params;
          }
          return Promise.resolve(resolver(cond, limite, desplazamiento)).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    void sel;
    return t;
  };

  selectMock.mockImplementation((sel: Fila) => {
    espia.llamadas++;
    const claves = Object.keys(sel ?? {}).sort().join(',');

    if (claves === 'codigo,userId') return chain(esc.organismos ?? []);
    // HU #12087: `funcionesDeVarios` — misma forma que organismos (lote por `user_id`), sin pasar por
    // el constructor del listado: si cae ahí, pisa `whereSql`/`whereParams` con el `inArray` y rompe
    // los asertos del filtro de rol/activo.
    if (claves === 'codigo,efecto,userId') return chain(esc.funciones ?? []);
    if (claves === 'id,name') { espia.lecturasDeCompania++; return chain(esc.companias ?? []); }
    if (claves === 'id,nombre') return chain(esc.proveedores ?? []);

    // El `count(*)::int` del total.
    if (claves === 'total') {
      espia.conteos++;
      return constructor(sel, (cond) => [{ total: filtrarSegunSql(esc.filas, cond).length }]);
    }

    // El `GROUP BY role, active` del resumen.
    if (claves === 'active,role,total') {
      return constructor(sel, () => (esc.grupos ?? []) as unknown as Fila[]);
    }

    // El listado: filtra por el WHERE real, y luego pagina.
    return constructor(sel, (cond, limite, desplazamiento) => {
      const filtradas = filtrarSegunSql(esc.filas, cond);
      const desde = desplazamiento ?? 0;
      const trozo = limite === undefined ? filtradas.slice(desde) : filtradas.slice(desde, desde + limite);
      return trozo.map((f) => proyectar(f, sel));
    });
  });

  return espia;
}

const PROVEEDOR = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ORG_A = '05001';
const ORG_B = '11001';

const FILAS: Fila[] = [
  { id: 1, username: 'admin_juan', name: 'Juan Admin', email: 'juan@flit.io', role: 'admin', active: true, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null, createdAt: new Date('2026-01-02T10:00:00Z') },
  { id: 2, username: 'gestora', name: 'Gestora Perez', email: 'gestora@flit.io', role: 'gestor_impuestos', active: true, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null, createdAt: new Date('2026-02-03T10:00:00Z') },
  { id: 3, username: 'prov_ana', name: 'Ana Proveedora', email: 'ana@x.com', role: 'proveedor', active: false, allowedPages: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: PROVEEDOR, createdAt: new Date('2026-03-04T10:00:00Z') },
  { id: 4, username: 'cliente_zeta', name: 'Zeta Cliente', email: 'zeta@x.com', role: 'cliente', active: true, allowedPages: [], transitoCodigo: null, companiaId: 7, flitoProveedorSoatId: null, createdAt: new Date('2026-04-05T10:00:00Z') },
];

const ESCENARIO: Escenario = {
  filas: FILAS,
  organismos: [{ userId: 2, codigo: ORG_B }, { userId: 2, codigo: ORG_A }],
  companias: [{ id: 7, name: 'Transportes Zeta S.A.S.' }],
  proveedores: [{ id: PROVEEDOR, nombre: 'Seguros Del Estado' }],
};

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/users/users.routes.js');
  app.use('/api/users', router);
  return app;
}

const cabecera = async (role: 'admin' | 'proveedor' = 'admin') => `Bearer ${await testToken({ sub: 1, role })}`;

beforeEach(() => {
  selectMock.mockReset();
  auditMock.mockClear();
});

// ── El listado ───────────────────────────────────────────────────────────────────────────────────

describe('GET /api/users — filtros (HU #12172)', () => {
  it('TC-12172-01: `?rol=` deja SOLO usuarios de ese rol, y el rol viaja en el WHERE', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?rol=gestor_impuestos')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body.map((u: Fila) => u.username)).toEqual(['gestora']);
    // El filtro está atado a la CONSULTA, no aplicado en memoria después de traerlo todo.
    expect(espia.whereSql).toMatch(/"role" = \$\d+/);
    expect(espia.whereParams).toContain('gestor_impuestos');
  });

  it('TC-12172-02: un `rol` que no existe es 400 de validación, no una lista vacía', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?rol=operaciones')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Filtros inválidos');
    // Ni siquiera se consulta: el 400 sale antes de tocar la base.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('TC-12172-03: `?activo=false` deja solo los inactivos', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?activo=false')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body.map((u: Fila) => u.username)).toEqual(['prov_ana']);
    expect(espia.whereParams).toContain(false);
  });

  it('TC-12172-04: `?q=` busca en username, nombre Y correo', async () => {
    instalarBd(ESCENARIO);
    const app = await buildApp();
    const auth = await cabecera();

    const porUsuario = await request(app).get('/api/users?q=prov_ana').set('Authorization', auth);
    const porNombre = await request(app).get('/api/users?q=perez').set('Authorization', auth);
    const porCorreo = await request(app).get('/api/users?q=zeta@x.com').set('Authorization', auth);

    expect(porUsuario.body.map((u: Fila) => u.username)).toEqual(['prov_ana']);
    expect(porNombre.body.map((u: Fila) => u.username)).toEqual(['gestora']);
    expect(porCorreo.body.map((u: Fila) => u.username)).toEqual(['cliente_zeta']);
  });

  it('TC-12172-05: `?q=%` no lista a todo el mundo — los comodines van escapados', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?q=%25').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    // Un `%` sin escapar sería `%%%`: casaría con las cuatro filas.
  });

  it('TC-12172-06: los filtros se combinan (rol + estado)', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?rol=proveedor&activo=true')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // el único proveedor está inactivo
  });

  it('TC-12172-07: `?q=` vacío no es un error — es «sin filtro»', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?q=').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(4);
    expect(espia.whereSql).toBe('');
  });
});

describe('GET /api/users — paginación y X-Total-Count (HU #12172)', () => {
  it('TC-12172-08: la página trae su trozo y la cabecera el TOTAL de coincidencias', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?pagina=2&porPagina=2')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    // Sigue siendo un ARRAY PLANO: el contrato viejo no se rompe.
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((u: Fila) => u.username)).toEqual(['prov_ana', 'cliente_zeta']);
    expect(espia.limite).toBe(2);
    expect(espia.desplazamiento).toBe(2);
    expect(r.headers['x-total-count']).toBe('4');
  });

  it('TC-12172-09: el total de la cabecera cuenta lo FILTRADO, no la tabla', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users?activo=true&porPagina=1')
      .set('Authorization', await cabecera());

    expect(r.body).toHaveLength(1);
    expect(r.headers['x-total-count']).toBe('3');
  });

  it('TC-12172-10: sin parámetros, el comportamiento es el de siempre (sin LIMIT y sin count extra)', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(4);
    expect(espia.limite).toBeUndefined();
    expect(espia.desplazamiento).toBeUndefined();
    // Ni una consulta de más sobre el camino que usan los consumidores de siempre.
    expect(espia.conteos).toBe(0);
    expect(r.headers['x-total-count']).toBe('4');
    // El listado + organismos + funciones (HU #12087) de TODA la página: dos consultas de lote, no
    // una por fila.
    expect(espia.llamadas).toBe(3);
  });
});

describe('GET /api/users — la auditoría deja de mentir (HU #12172, punto 4)', () => {
  it('TC-12172-11: listar se audita como `view`; `export` queda para la descarga real', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users').set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    const acciones = auditMock.mock.calls.map((c) => (c[1] as { action: string }).action);
    expect(acciones).toEqual(['view']);
    // Lo que este test defiende: un listado NO genera archivo, así que no puede registrarse como
    // una exportación. Volver a `'export'` aquí lo pone rojo.
    expect(acciones).not.toContain('export');
    expect((auditMock.mock.calls[0][1] as { resource: string }).resource).toBe('user');
  });
});

// ── La descarga ──────────────────────────────────────────────────────────────────────────────────

/** Las filas de datos del libro, sin la cabecera, como arrays de valores. */
async function leerLibro(cuerpo: Buffer): Promise<{ cabeceras: string[]; filas: unknown[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(cuerpo as unknown as ArrayBuffer);
  const hoja = wb.worksheets[0];
  const filas: unknown[][] = [];
  let cabeceras: string[] = [];
  hoja.eachRow((row, n) => {
    const valores = (row.values as unknown[]).slice(1);
    if (n === 1) cabeceras = valores.map((v) => String(v));
    else filas.push(valores);
  });
  return { cabeceras, filas };
}

describe('GET /api/users/export — descarga (HU #12172)', () => {
  it('TC-12172-12: sin token → 401', async () => {
    instalarBd(ESCENARIO);
    const r = await request(await buildApp()).get('/api/users/export');
    expect(r.status).toBe(401);
  });

  it('TC-12172-13: con sesión pero SIN permiso de administración → 403', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users/export')
      .set('Authorization', await cabecera('proveedor'));

    expect(r.status).toBe(403);
    // La tabla de usuarios no sale en un archivo para quien no la puede ver en pantalla.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('TC-12172-14: admin → .xlsx con las columnas del AC y una fila por usuario', async () => {
    instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users/export')
      .set('Authorization', await cabecera()).responseType('blob');

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toContain('usuarios.xlsx');

    const { cabeceras, filas } = await leerLibro(r.body as Buffer);
    expect(cabeceras).toEqual(['Usuario', 'Nombre', 'Correo', 'Rol', 'Estado', 'Ámbito', 'Fecha de creación']);
    expect(filas).toHaveLength(4);
    expect(filas.map((f) => f[0])).toEqual(['admin_juan', 'gestora', 'prov_ana', 'cliente_zeta']);
    // Estado legible, no un booleano crudo.
    expect(filas[2][4]).toBe('Inactivo');
    expect(filas[0][4]).toBe('Activo');
    // Ámbito: los organismos del gestor, el nombre de la compañía del cliente y el del proveedor.
    expect(filas[1][5]).toBe(`${ORG_A}, ${ORG_B}`);
    expect(filas[2][5]).toBe('Seguros Del Estado');
    expect(filas[3][5]).toBe('Transportes Zeta S.A.S.');
    // Rol en la etiqueta que el admin lee, no el código.
    expect(filas[0][3]).toBe('Administrador');
  });

  it('TC-12172-15: la descarga RESPETA los filtros — baja lo que se está viendo', async () => {
    const espia = instalarBd(ESCENARIO);

    const r = await request(await buildApp()).get('/api/users/export?rol=gestor_impuestos')
      .set('Authorization', await cabecera()).responseType('blob');

    expect(r.status).toBe(200);
    const { filas } = await leerLibro(r.body as Buffer);
    expect(filas).toHaveLength(1);
    expect(filas[0][0]).toBe('gestora');
    expect(espia.whereSql).toMatch(/"role" = \$\d+/);
  });

  it('TC-12172-16: la descarga se audita como `export` y el detalle dice cuántas filas', async () => {
    instalarBd(ESCENARIO);

    await request(await buildApp()).get('/api/users/export')
      .set('Authorization', await cabecera()).responseType('blob');

    const entrada = auditMock.mock.calls[0][1] as { action: string; resource: string; detail: string };
    expect(entrada.action).toBe('export');
    expect(entrada.resource).toBe('user');
    expect(entrada.detail).toContain('(4)');
  });

  it('TC-12172-17: los nombres de ámbito se leen por LOTE, no una consulta por fila', async () => {
    const espia = instalarBd(ESCENARIO);

    await request(await buildApp()).get('/api/users/export')
      .set('Authorization', await cabecera()).responseType('blob');

    // Cuatro usuarios, una sola lectura de compañías (y ninguna si no hubiera clientes).
    expect(espia.lecturasDeCompania).toBe(1);
  });
});

// ── El resumen ───────────────────────────────────────────────────────────────────────────────────

describe('GET /api/users/resumen — conteo por rol y estado (HU #12172)', () => {
  const GRUPOS = [
    { role: 'admin', active: true, total: 2 },
    { role: 'admin', active: false, total: 1 },
    { role: 'gestor_impuestos', active: true, total: 3 },
    { role: 'cliente', active: false, total: 4 },
  ];

  it('TC-12172-18: sin permiso de administración → 403', async () => {
    instalarBd({ ...ESCENARIO, grupos: GRUPOS });

    const r = await request(await buildApp()).get('/api/users/resumen')
      .set('Authorization', await cabecera('proveedor'));

    expect(r.status).toBe(403);
  });

  it('TC-12172-19: devuelve porRol/activos/inactivos con UNA sola consulta agrupada', async () => {
    const espia = instalarBd({ ...ESCENARIO, grupos: GRUPOS });

    const r = await request(await buildApp()).get('/api/users/resumen')
      .set('Authorization', await cabecera());

    expect(r.status).toBe(200);
    expect(r.body.porRol.admin).toBe(3);
    expect(r.body.porRol.gestor_impuestos).toBe(3);
    expect(r.body.porRol.cliente).toBe(4);
    expect(r.body.activos).toBe(5);
    expect(r.body.inactivos).toBe(5);
    // Una consulta, no una por rol.
    expect(espia.llamadas).toBe(1);
    // Agrupada por las DOS columnas, que es lo que permite sacar las tres cifras del mismo barrido.
    expect(espia.agrupadoPor).toEqual(['role', 'active']);
  });

  it('TC-12172-20: los roles sin usuarios salen en 0, no ausentes', async () => {
    instalarBd({ ...ESCENARIO, grupos: GRUPOS });

    const r = await request(await buildApp()).get('/api/users/resumen')
      .set('Authorization', await cabecera());

    expect(r.body.porRol.mensajero).toBe(0);
    expect(r.body.porRol.financiera).toBe(0);
    // El catálogo completo: el front pinta la fila del rol aunque hoy no tenga a nadie.
    expect(Object.keys(r.body.porRol)).toHaveLength(12);
  });

  it('TC-12172-21: el resumen se audita como `view`', async () => {
    instalarBd({ ...ESCENARIO, grupos: GRUPOS });

    await request(await buildApp()).get('/api/users/resumen').set('Authorization', await cabecera());

    expect((auditMock.mock.calls[0][1] as { action: string }).action).toBe('view');
  });
});
