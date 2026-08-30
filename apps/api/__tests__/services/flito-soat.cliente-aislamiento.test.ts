// HU #11913 (Feature #11912) — el aislamiento por compañía del rol `cliente`, medido sobre el SQL
// que sale de verdad y no sobre lo que la ruta responde.
//
// **Por qué se mira el WHERE y no las filas devueltas.** Un test que solo afirme «el cliente ve lo
// de su compañía» pasa igual con un filtro que no existe: el mock devuelve lo que el mock quiera.
// El ADR-0008 lo dice con estas palabras —«hay que afirmar las tres»— y de ahí sale el trío de
// abajo: con compañía → la condición está en la consulta; sin compañía → no hay consulta; `admin` →
// exactamente el mismo WHERE que antes de la HU.
//
// El WHERE capturado se renderiza con el dialecto real de Drizzle (`PgDialect.sqlToQuery`), así que
// lo que se compara es el SQL que Postgres recibiría, con sus parámetros. Quitar la rama del cliente
// del servicio hace fallar estas pruebas; cambiar el mock, no.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { testToken } from '../helpers/auth.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  // `insert` devuelve un chain utilizable porque desde la HU #11913 la cola registra el acceso a PII
  // (`logPiiAccess`): con un `vi.fn()` pelado el helper falla, lo atrapa su propio catch —es
  // best-effort— y la salida de la suite se llena de ERROR que no son de esta prueba.
  db: {
    select: selectMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

/** Los WHERE que el servicio le pasó a Drizzle en esta prueba, en orden. */
const wheres: SQL[] = [];

/**
 * Chain de Drizzle que ESPÍA el `where(...)`. El helper compartido (`helpers/db.ts`) lo descarta,
 * y descartarlo es justo perder lo único que esta prueba tiene que mirar.
 */
function chainEspia(rows: unknown[]) {
  const t: Record<string, unknown> = {};
  const paso = () => t;
  for (const m of ['from', 'leftJoin', 'innerJoin', 'limit', 'offset', 'orderBy', 'groupBy', 'having', '$dynamic', 'for']) {
    t[m] = paso;
  }
  t.where = (w: SQL) => { wheres.push(w); return t; };
  t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
  t.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows).catch(rej);
  t.finally = (cb: () => void) => Promise.resolve(rows).finally(cb);
  return t;
}

const dialecto = new PgDialect();
const aSql = (w: SQL) => dialecto.sqlToQuery(w);

beforeEach(() => { selectMock.mockReset(); wheres.length = 0; });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string, sub = 1) => `Bearer ${await testToken({ sub, username: 'u', role: role as never })}`;

/** Encola: la lectura de `users` que hace `contextoSoat`, el conteo y la página. */
function colaVacia(companiaDelUsuario: number | null) {
  selectMock.mockImplementationOnce(() => chainEspia([{ c: companiaDelUsuario }])); // contextoSoat
  selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));              // conteo
  selectMock.mockImplementationOnce(() => chainEspia([]));                          // página
}

describe('cola SOAT — el trío de regresión del aislamiento por compañía (ADR-0008)', () => {
  it('cliente CON compañía → la consulta filtra por SU compania_id', async () => {
    colaVacia(7);
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });

    // Tres WHERE: el de `contextoSoat` leyendo `users` (el primero) y los dos de la cola. El conteo
    // Y la página tienen que llevar la condición — si solo la llevara la de filas, el total contaría
    // lo ajeno y nadie lo notaría.
    const deLaCola = wheres.slice(1);
    expect(deLaCola).toHaveLength(2);
    for (const w of deLaCola) {
      const { sql, params } = aSql(w);
      expect(sql).toContain('"flito_soat"."compania_id" =');
      expect(params).toContain(7);
    }
  });

  it('cliente SIN compañía → cola vacía y NI UNA consulta a la tabla (no «lo ve todo»)', async () => {
    colaVacia(null);
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });

    // La única consulta que corrió es la de `contextoSoat`. `condicionesCola` devolvió null y `cola`
    // salió antes de tocar `flito_soat`: el fallo por defecto es «no ve nada».
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(wheres).toHaveLength(1); // el WHERE de la lectura de `users`, no el de la cola
  });

  it('admin → el MISMO WHERE que antes de la HU: sin rastro de compania_id', async () => {
    // `contextoSoat` no consulta nada para un admin, así que la primera consulta ya es el conteo.
    selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));
    selectMock.mockImplementationOnce(() => chainEspia([]));
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);

    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      const { sql } = aSql(w);
      expect(sql).not.toContain('"flito_soat"."compania_id" =');
      expect(sql).not.toContain('"flito_soat"."proveedor_soat_id" =');
    }
  });

  it('el filtro de compañías del cliente se AÑADE al suyo (intersección), no lo sustituye', async () => {
    colaVacia(7);
    const r = await request(await buildApp()).get('/api/flito/soat?companias=99')
      .set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
    const { sql, params } = aSql(wheres[1]); // [0] es la lectura de `users` de `contextoSoat`
    // Su compañía sigue en el WHERE aunque haya pedido otra: pedir la 99 le devuelve vacío, no lo
    // de la 99.
    expect(params).toContain(7);
    expect(sql).toContain('"flito_soat"."compania_id" =');
  });
});

describe('filtros que el `cliente` no puede APLICAR — el oráculo de `gestion` y `proveedores`', () => {
  // Segunda ronda de seguridad (ALTO/MEDIO): quitar un campo del DTO no basta si queda un filtro que
  // particiona la cola por ese campo. `?gestion=operaciones` y `?gestion=proveedor` reconstruyen
  // `gestionOperaciones` fila a fila con dos peticiones, y `?proveedores=<uuid>` hace lo mismo con
  // `proveedorSoatId`. Se mide sobre el SQL —igual que el aislamiento— porque el oráculo ES la
  // consulta: comparar las filas devueltas dependería del mock y no probaría nada.

  /** El SQL de los dos WHERE de la cola (conteo y página) para este rol y esta query. */
  async function sqlDeLaCola(rol: 'cliente' | 'admin' | 'proveedor', query: string) {
    selectMock.mockReset(); wheres.length = 0;
    // `contextoSoat` consulta `users` para `cliente` y `proveedor`; para `admin` no consulta nada.
    if (rol !== 'admin') selectMock.mockImplementationOnce(() => chainEspia([{ c: 7, p: 'prov-1' }]));
    selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));
    selectMock.mockImplementationOnce(() => chainEspia([]));
    await request(await buildApp()).get(`/api/flito/soat${query}`).set('Authorization', await auth(rol));
    return (rol === 'admin' ? wheres : wheres.slice(1)).map(aSql);
  }

  it('cliente: pedir `?gestion=…` produce EXACTAMENTE la misma consulta que no pedirlo', async () => {
    const sinFiltro = await sqlDeLaCola('cliente', '');
    const conOperaciones = await sqlDeLaCola('cliente', '?gestion=operaciones');
    const conProveedor = await sqlDeLaCola('cliente', '?gestion=proveedor');

    // Idéntico SQL y parámetros: no hay diferencia observable, así que no hay oráculo. Es más fuerte
    // que «no contiene la columna»: un filtro colado por otra vía también rompería esta igualdad.
    expect(conOperaciones).toEqual(sinFiltro);
    expect(conProveedor).toEqual(sinFiltro);
    for (const { sql } of conOperaciones) expect(sql).not.toContain('"flito_soat"."gestion_operaciones"');
  });

  it('cliente: `?proveedores=<uuid>` tampoco entra en la consulta (ni el uuid en los parámetros)', async () => {
    const sinFiltro = await sqlDeLaCola('cliente', '');
    const conProveedores = await sqlDeLaCola('cliente', '?proveedores=11111111-1111-1111-1111-111111111111');

    expect(conProveedores).toEqual(sinFiltro);
    for (const { sql, params } of conProveedores) {
      expect(sql).not.toContain('"flito_soat"."proveedor_soat_id"');
      expect(params).not.toContain('11111111-1111-1111-1111-111111111111');
    }
  });

  it('admin: los dos filtros siguen funcionando igual que antes (no-regresión)', async () => {
    const conGestion = await sqlDeLaCola('admin', '?gestion=operaciones');
    expect(conGestion[0].sql).toContain('"flito_soat"."gestion_operaciones"');

    const conProveedores = await sqlDeLaCola('admin', '?proveedores=11111111-1111-1111-1111-111111111111');
    expect(conProveedores[0].sql).toContain('"flito_soat"."proveedor_soat_id"');
    expect(conProveedores[0].params).toContain('11111111-1111-1111-1111-111111111111');
  });

  it('gestor: sigue pudiendo pedirlos (para él son ruido, no una fuga) — no-regresión', async () => {
    const conGestion = await sqlDeLaCola('proveedor', '?gestion=operaciones');
    // Su frontera (`gestion_operaciones = false`) y el filtro pedido conviven, como siempre: el
    // resultado es vacío, que es lo que ya pasaba antes de esta corrección.
    expect(conGestion[0].sql).toContain('"flito_soat"."gestion_operaciones"');
  });

  it('los filtros que SÍ puede aplicar siguen llegando a la consulta', async () => {
    // La contraparte obligatoria: si el saneo se pasara de largo, el cliente perdería su pantalla.
    // `estado` y `pagadoDesde` particionan por campos que su propia fila ya lleva.
    const conEstado = await sqlDeLaCola('cliente', '?estado=pagado&pagadoDesde=2026-08-01');
    expect(conEstado[0].sql).toContain('"flito_soat"."estado"');
    expect(conEstado[0].sql).toContain('"flito_soat"."pagado_en"');
    expect(conEstado[0].params).toContain('pagado');
  });
});

describe('frontera de autogestión — la tercera condición del canal Cliente', () => {
  it('lo que nació del canal Cliente entra en la cola aunque la compañía autogestione', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([{ total: 0 }]));
    selectMock.mockImplementationOnce(() => chainEspia([]));
    await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));

    const q = renderizar(wheres[0]);
    // Sin esta condición, una compañía con «autogestiona SOAT» y «SOAT sin trámite» encendidos a la
    // vez —combinación válida y esperada— radicaría solicitudes que no vería nadie.
    //
    // El valor va como PARÁMETRO ENLAZADO y no inline desde la HU #11915, que sustituyó el literal
    // crudo por la constante `ORIGEN_CLIENTE` —hasta entonces la frase del docblock prometía que un
    // `grep ORIGEN_CLIENTE` encontraba esta frontera, y era falsa—.
    //
    // La aserción es POSICIONAL desde la #11916. Antes eran dos líneas sueltas —`sql` contiene
    // `"origen" =` y `params` contiene `'cliente'`— que son ciertas a la vez aunque la comparación
    // ligue OTRO valor a esa columna: `toContain` mira el conjunto de parámetros, no el que
    // corresponde al `$N` de esta comparación. `ligadoA` lee el marcador y va a su posición.
    expect(ligadoA(q, '"flito_soat"."origen"')).toBe('cliente');
    // Y las dos que ya estaban siguen ahí: es un OR que se AÑADE, no un reemplazo.
    expect(q.sql).toContain('"clients"."soat_autogestionable"');
    expect(q.sql).toContain('"flito_soat"."excepcion_autogestion"');
  });
});

describe('buscarConAcceso — 404-no-403 por compañía (detalle, historial, soportes, descarga)', () => {
  const filaDe = (companiaId: number) => ({
    soat: {
      id: '00000000-0000-0000-0000-0000000000aa', companiaId, estado: 'pagado',
      proveedorSoatId: null, gestionOperaciones: false, origen: 'tramite',
    },
    dentroDeFrontera: true,
  });

  const ctx = (role: string, companiaId: number | null) => ({
    userId: 1, username: 'u', role, proveedorSoatId: null, companiaId,
  });

  it('cliente pidiendo un SOAT de OTRA compañía → null (la ruta lo sirve como 404)', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([filaDe(9)]));
    const { buscarConAcceso } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    expect(await buscarConAcceso('00000000-0000-0000-0000-0000000000aa', ctx('cliente', 7))).toBeNull();
  });

  it('cliente pidiendo un SOAT de LA SUYA → lo obtiene', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([filaDe(7)]));
    const { buscarConAcceso } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const soat = await buscarConAcceso('00000000-0000-0000-0000-0000000000aa', ctx('cliente', 7));
    expect(soat?.companiaId).toBe(7);
  });

  it('cliente SIN compañía → null aunque el SOAT exista y esté dentro de la frontera', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([filaDe(7)]));
    const { buscarConAcceso } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    expect(await buscarConAcceso('00000000-0000-0000-0000-0000000000aa', ctx('cliente', null))).toBeNull();
  });

  it('admin → lo obtiene igual que antes de la HU, sea de la compañía que sea', async () => {
    selectMock.mockImplementationOnce(() => chainEspia([filaDe(9)]));
    const { buscarConAcceso } = await import('../../src/modules/flito-soat/flito-soat.service.js');
    const soat = await buscarConAcceso('00000000-0000-0000-0000-0000000000aa', ctx('admin', null));
    expect(soat?.companiaId).toBe(9);
  });
});

describe('RBAC — el `cliente` lee y no muta', () => {
  it('GET / → 200 (entra en LECTURA)', async () => {
    colaVacia(7);
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
  });

  it('POST /enviar → 403 (no es Operaciones)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth('cliente'))
      .send({ ids: ['00000000-0000-0000-0000-000000000001'], gestionOperaciones: true });
    expect(r.status).toBe(403);
  });

  it('POST /:id/rechazar → 403 (tampoco es gestor)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/rechazar')
      .set('Authorization', await auth('cliente')).send({ motivo: 'x' });
    expect(r.status).toBe(403);
  });
});
