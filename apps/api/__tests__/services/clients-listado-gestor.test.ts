// HU #12079 (Feature #12074) — la ficha de la compañía dice A QUÉ GESTOR despacha su canal «SOAT sin
// trámite», y si ese gestor está apagado.
//
// La HU #12078 dejó la columna `clients.flito_proveedor_soat_sin_tramite_id`, que es un uuid. Un
// uuid no se puede pintar, y resolverlo en el cliente exigiría el catálogo
// `GET /flito/parametrizacion/proveedores-soat`, que es `requireRole('admin','auditor')`:
// `financiera` ve esta pantalla y NO esa ruta. Así que el listado lo entrega ya RESUELTO
// —`{ id, nombre, activo }`, o `null`— por la misma puerta por la que ya sale `soatSinTramite`.
//
// ── Cómo está montada, y por qué así ─────────────────────────────────────────────────────────────
//
// **Sobre el cuerpo SÍ, y aquí eso no es una tautología.** El aviso de `clients.pii.ts` —el mock
// devuelve la fila que el test registró aunque la proyección pidiera menos— vale para afirmar QUÉ
// columnas salen de la base; por eso ese contrato se sigue midiendo sobre la PROYECCIÓN, más abajo.
// Lo que estos casos miden es distinto: la TRADUCCIÓN de tres columnas planas a un objeto o a
// `null`, que ocurre en `clienteListadoDto` y no en la base. Cambiar esa función pone rojo este
// archivo; cambiar el mock, no.
//
// **La forma de la unión se espía, no se supone.** El mock resuelve igual con `leftJoin` que con
// `innerJoin` que sin unión ninguna, así que «une por la izquierda y por la columna del canal» se
// afirma sobre la llamada y sobre el `ON` renderizado con `PgDialect`, que es lo único que el mock
// no regala.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const {
  CAMPOS_PII_LISTADO, COLUMNAS_LISTADO, COLUMNAS_LISTADO_CON_GESTOR, COLUMNAS_GESTOR_SIN_TRAMITE,
} = await import('../../src/modules/clients/clients.pii.js');

const GESTOR = '55555555-5555-4555-8555-555555555555';

/** Uniones registradas: tabla unida, tipo de unión y condición `ON` en crudo. */
const uniones: { tipo: 'leftJoin' | 'innerJoin'; tabla: unknown; on: unknown }[] = [];

beforeEach(() => {
  selectMock.mockReset();
  logPiiAccessMock.mockClear();
  uniones.length = 0;
});

/**
 * Un chain que además anota las uniones.
 *
 * `helpers/db.chain` las acepta y las ignora (`leftJoin: () => t`), que es lo que permite que un
 * `INNER JOIN` —con el que el padrón perdería a toda compañía sin gestor— pase el test funcional
 * sin despeinarse. Envolverlo aquí es lo que hace ese mutante visible.
 */
function chainConUniones(filas: unknown[]) {
  const t = chain(filas) as unknown as Record<string, unknown>;
  for (const tipo of ['leftJoin', 'innerJoin'] as const) {
    t[tipo] = (tabla: unknown, on: unknown) => { uniones.push({ tipo, tabla, on }); return t; };
  }
  return t;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const auth = async (role: TestRole = 'admin') => `Bearer ${await testToken({ sub: 7, role })}`;

/**
 * Una fila del listado tal como la devuelve la consulta unida: las columnas de `clients` y, en
 * plano, las tres del proveedor unido. `null` en las tres = compañía sin gestor configurado.
 */
const fila = (over: Record<string, unknown> = {}) => ({
  id: 41, name: 'ACME S.A.S.', document: '900123456', documentType: 'NIT',
  phone: null, email: null, address: null, city: 'MEDELLIN',
  soatAutogestionable: false, soatSinTramite: true,
  impuestosAutogestionable: false, logisticaAutogestionable: false, logisticaPermiteParcial: false,
  personType: null, idType: null, checkDigit: null, fiscalResponsibilities: [],
  countryCode: null, stateCode: null, cityCode: null, commercialName: null, branchOffice: 0,
  contactFirstName: null, contactLastName: null, contactEmail: null,
  phoneIndicative: null, phoneNumber: null,
  gestorSinTramiteId: null, gestorSinTramiteNombre: null, gestorSinTramiteActivo: null,
  ...over,
});

/** Con gestor configurado y vigente. */
const conGestor = (over: Record<string, unknown> = {}) => fila({
  gestorSinTramiteId: GESTOR, gestorSinTramiteNombre: 'SEGUROS DEL ESTADO', gestorSinTramiteActivo: true,
  ...over,
});

async function listar(role: TestRole = 'admin', filas: unknown[] = [conGestor()]) {
  selectMock.mockReturnValueOnce(chainConUniones(filas));
  const app = await buildApp();
  return request(app).get('/api/clients').set('Authorization', await auth(role));
}

describe('el listado entrega el gestor por defecto RESUELTO', () => {
  it('nombre y estado, no el uuid a secas', async () => {
    const r = await listar();

    expect(r.status).toBe(200);
    expect(r.body[0].gestorSoatSinTramite).toEqual({
      id: GESTOR, nombre: 'SEGUROS DEL ESTADO', activo: true,
    });
    // Y NO el identificador crudo por su cuenta: un uuid sin catálogo con el que cruzarlo no es
    // información para nadie que pueda leer esta ruta, que es de lo que va la HU.
    expect(Object.keys(r.body[0])).not.toContain('flitoProveedorSoatSinTramiteId');
    expect(Object.keys(r.body[0])).not.toContain('proveedorSoatSinTramiteId');
  });

  it('**el gestor INACTIVO llega marcado**, ni se calla ni se borra', async () => {
    // El caso que la pantalla necesita para avisar: con el gestor apagado, el alta del canal cae en
    // la contingencia de Operaciones (HU #12078). Devolver `null` aquí —«como si no hubiera»— o
    // callar el `activo` dejaría a la compañía con el canal abierto, un nombre pintado y ninguna
    // pista de por qué sus solicitudes no le llegan a nadie.
    const r = await listar('admin', [conGestor({ gestorSinTramiteActivo: false })]);

    expect(r.body[0].gestorSoatSinTramite).toEqual({
      id: GESTOR, nombre: 'SEGUROS DEL ESTADO', activo: false,
    });
  });

  it('sin gestor configurado: `null`, y la compañía sigue estando en la lista', async () => {
    const r = await listar('admin', [fila()]);

    expect(r.body).toHaveLength(1);
    expect(r.body[0].gestorSoatSinTramite).toBeNull();
    // `null` limpio y no un objeto a medias: la pantalla no tiene que volver a interpretar nada.
    expect(r.body[0]).not.toHaveProperty('gestorSinTramiteId');
    expect(r.body[0]).not.toHaveProperty('gestorSinTramiteNombre');
    expect(r.body[0]).not.toHaveProperty('gestorSinTramiteActivo');
  });

  it('las columnas de `clients` que la ruta ya entregaba siguen saliendo igual', async () => {
    // Esto es una ampliación, no un rediseño de la respuesta: si el mapeo se llevara por delante el
    // resto de la fila, la tabla del padrón se quedaría vacía y esta HU sería una regresión.
    const r = await listar();

    expect(r.body[0]).toMatchObject({
      id: 41, name: 'ACME S.A.S.', document: '900123456', city: 'MEDELLIN', soatSinTramite: true,
    });
  });
});

describe('la unión: por la izquierda y por la columna del canal', () => {
  it('**`LEFT JOIN`, nunca `INNER`**', async () => {
    await listar();

    expect(uniones.map((u) => u.tipo)).toEqual(['leftJoin']);
  });

  it('une `flito_proveedores_soat` por `flito_proveedor_soat_sin_tramite_id`', async () => {
    await listar();

    const { sql } = new PgDialect().sqlToQuery(uniones[0].on as never);
    expect(sql).toContain('"flito_proveedores_soat"."id"');
    expect(sql).toContain('"clients"."flito_proveedor_soat_sin_tramite_id"');
  });
});

describe('la proyección se amplía NOMINALMENTE, y solo con eso', () => {
  it('las mismas columnas de `clients` más exactamente tres del proveedor', async () => {
    await listar();

    const pedidas = Object.keys(selectMock.mock.calls[0][0] as object);
    expect(pedidas).toEqual([
      ...Object.keys(COLUMNAS_LISTADO),
      'gestorSinTramiteId', 'gestorSinTramiteNombre', 'gestorSinTramiteActivo',
    ]);
    // Y las tres son de la tabla del proveedor, no columnas nuevas de `clients` coladas de rondón.
    expect(Object.values(COLUMNAS_GESTOR_SIN_TRAMITE).map((c) => c.name))
      .toEqual(['id', 'nombre', 'activo']);
  });

  it('la fila del cliente NO se amplía de vuelta a la fila entera', async () => {
    // La HU #12078 cerró cinco proyecciones justamente para que la columna nueva no saliera sola. La
    // manera fácil de resolver el nombre —quitar la proyección y volver a `select()` desnudo— es la
    // que este caso prohíbe: se nombran las que ella dejó fuera por personales o por internas.
    for (const fuera of [
      'notes', 'active', 'cityTextoOrigen', 'flitoCarpetaStorage', 'flitoToleranciaValorImpuesto',
      'personTypeOrigen', 'cityConfirmadaPor', 'cityConfirmadaEn', 'facturacionBloqueos', 'createdAt',
    ]) {
      expect(Object.keys(COLUMNAS_LISTADO_CON_GESTOR)).not.toContain(fuera);
    }
    // El uuid tampoco entra a la proyección: lo que se publica es el gestor resuelto, y la columna
    // cruda solo participa como llave del `ON`.
    expect(Object.keys(COLUMNAS_LISTADO_CON_GESTOR)).not.toContain('flitoProveedorSoatSinTramiteId');
  });

  it('**el registro de acceso no gana campos**: el gestor no es PII del titular', async () => {
    // `CAMPOS_PII_LISTADO` se deriva de `COLUMNAS_LISTADO` y tiene que seguir siendo la lista de
    // columnas DE `clients` que se entregan, porque `pii_access_log` se cruza con esa tabla.
    // Derivarla de la proyección unida metería `nombre` y `activo` del PROVEEDOR en la respuesta a
    // «¿quién ha leído datos de este cliente?», que es una pregunta sobre el titular.
    const r = await listar();

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    const registro = logPiiAccessMock.mock.calls[0][1] as { camposAccedidos: string[] };
    expect(registro.camposAccedidos).toEqual([...CAMPOS_PII_LISTADO]);
    for (const ajeno of ['nombre', 'activo']) {
      expect(registro.camposAccedidos).not.toContain(ajeno);
    }
    // Ni el nombre de la aseguradora acaba en el rastro de una lectura de datos personales.
    expect(JSON.stringify(registro)).not.toContain('SEGUROS DEL ESTADO');
  });
});

describe('quién lo ve', () => {
  // El punto entero de sacarlo por esta ruta: los tres roles que ya ven la ficha de la compañía lo
  // reciben resuelto, y ninguno de ellos necesita el catálogo de proveedores para leerlo.
  for (const role of ['admin', 'financiera', 'auditor'] as const) {
    it(`\`${role}\` recibe el gestor resuelto`, async () => {
      const r = await listar(role);

      expect(r.status).toBe(200);
      expect(r.body[0].gestorSoatSinTramite).toMatchObject({ nombre: 'SEGUROS DEL ESTADO' });
    });
  }

  it('y quien no veía la ficha sigue sin verla: `conductor` → 403 sin tocar la base', async () => {
    const app = await buildApp();

    const r = await request(app).get('/api/clients').set('Authorization', await auth('conductor'));

    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('el catálogo de proveedores NO se abre a nadie nuevo', () => {
  /**
   * La otra mitad de la decisión: el gestor viaja resuelto POR `GET /clients` precisamente para no
   * tener que darle a `financiera` la lista completa de gestores con sus umbrales de OCR y sus SLA.
   * Si alguien «simplificara» abriendo esa ruta, esta HU dejaría de tener sentido y nada más se
   * pondría rojo.
   */
  async function appParametrizacion() {
    const app = express();
    app.use(express.json());
    const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
    app.use('/api/flito/parametrizacion', router);
    return app;
  }

  it('`financiera` sigue recibiendo 403 en `GET /flito/parametrizacion/proveedores-soat`', async () => {
    const app = await appParametrizacion();

    const r = await request(app).get('/api/flito/parametrizacion/proveedores-soat')
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
