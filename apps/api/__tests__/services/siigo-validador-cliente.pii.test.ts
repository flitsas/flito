// HU #11299 — registro de acceso a las fichas de cliente del informe de facturabilidad.
//
// El hallazgo que cierran estas pruebas: `GET /siigo/clientes/validacion/detalle` devuelve nombre e
// identificación —cédula de personas naturales, NIT de jurídicas— de hasta 500 clientes por llamada,
// y el módulo `siigo/` entero no escribía una sola línea en `pii_access_log` (Ley 1581 art. 17,
// AGENTS.md §16). El permiso ya estaba bien; lo que no se podía era reconstruir QUIÉN leyó el
// padrón.
//
// Lo que se demuestra, y por qué cada cosa:
//
//   1. **Leer deja rastro**, en las tres rutas de lectura, con recurso, acción y campos. Sin esto,
//      mañana alguien quita la línea y nada se pone rojo — que es exactamente cómo llegamos aquí.
//   2. **Cada ruta declara lo que ELLA entrega.** El resumen devuelve conteos y va con la lista de
//      campos VACÍA: un log que dijera que ahí se leyeron documentos haría inservible la consulta
//      «¿quién ha leído documentos?».
//   3. **El rastro no es un segundo almacén de identidades**: registra nombres de campo y el id del
//      cliente, nunca los valores leídos, y un filtro personal —el día que exista— va enmascarado.
//   4. **Un 404 y un 403 no registran acceso**: nadie miró los datos de nadie.
//   5. **La respuesta no cambió.** Añadir auditoría no puede alterar el DTO; el veredicto sigue
//      saliendo con `nombre` y `documento` en claro, que es lo que el panel pinta hoy.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

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

/**
 * Se mockea `logPiiAccess` en vez de mirar el INSERT sobre `pii_access_log`.
 *
 * Lo que este módulo tiene que garantizar es QUÉ le pasa al helper compartido —recurso, acción,
 * campos, motivo—, no cómo ese helper escribe la fila: eso es asunto de `shared/pii-audit.ts` y
 * tiene sus propias pruebas.
 */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const {
  CAMPOS_PII_RESUMEN, CAMPOS_PII_VEREDICTO, RECURSO_CLIENTE, registrarAccesoCliente,
} = await import('../../src/modules/siigo/siigo.pii.js');

beforeEach(() => {
  selectMock.mockReset();
  logPiiAccessMock.mockClear();
});

const BASE = '/api/siigo/clientes';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/validador-cliente.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: 'admin' | 'auditor' | 'financiera' | 'conductor' = 'admin') =>
  `Bearer ${await testToken({ sub: 7, role })}`;

/** Un cliente al que le falta la dirección: no facturable, así que sale en el informe por defecto. */
const cliente = (over: Record<string, unknown> = {}) => ({
  id: 41, name: 'PEDRO ANTONIO GÓMEZ', document: '79345612', personType: 'Person', idType: '13',
  fiscalResponsibilities: ['R-99-PN'], address: null, countryCode: 'Co', stateCode: '11',
  cityCode: '11001', phoneIndicative: '57', phoneNumber: '3001234567',
  contactFirstName: 'Pedro', contactLastName: 'Gómez', facturacionBloqueos: [], ...over,
});

/** `select()` del servicio: `.from().where().orderBy()` o `.from().where().limit()`. */
function cartera(filas: unknown[]) {
  selectMock.mockReturnValue(chain(filas));
}

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('AGENTS.md §16 — toda lectura de fichas de cliente deja rastro', () => {
  it('el detalle registra recurso, acción, campos y cuántas fichas entregó', async () => {
    cartera([cliente(), cliente({ id: 42, name: 'ACME S.A.S.', document: '900123456' })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      camposAccedidos: ['name', 'document'],
      // Un listado no apunta a una ficha: apunta a un tramo del padrón.
      resourceId: null,
    });
    expect(ultimoAcceso().motivo).toContain('filas=2');
  });

  it('la ficha puntual registra `read` y el id del cliente en `resource_id`', async () => {
    cartera([cliente()]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/41/validacion`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'read',
      camposAccedidos: ['name', 'document'],
      // `pii_access_log.resource_id` es `integer` y `clients.id` también: aquí sí cabe.
      resourceId: 41,
    });
  });

  it('el resumen registra el barrido SIN declarar campos que no entrega', async () => {
    // Devuelve conteos por motivo, ni un nombre ni una identificación. Declarar `document` aquí
    // haría que «¿quién ha leído documentos?» devolviera a todo el que abrió el panel.
    cartera([cliente(), cliente({ id: 42 })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      camposAccedidos: [],
    });
    expect(ultimoAcceso().motivo).toContain('evaluados=2');
    expect(CAMPOS_PII_RESUMEN).toEqual([]);
    expect(CAMPOS_PII_VEREDICTO).toEqual(['name', 'document']);
  });
});

describe('el rastro no puede convertirse en un segundo almacén de identidades', () => {
  it('ni el motivo ni los campos llevan el nombre o el documento leídos', async () => {
    cartera([cliente()]);
    const app = await buildApp();

    await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth());

    const escrito = JSON.stringify(ultimoAcceso());
    expect(escrito).not.toContain('79345612');
    expect(escrito).not.toContain('PEDRO');
    // Lo que sí lleva son NOMBRES de columna, que es lo que hace consultable el log.
    expect(escrito).toContain('document');
  });

  it('un filtro por identidad —el día que exista— va enmascarado al motivo', async () => {
    // El router de hoy no acepta ninguno: solo `motivo`, `incluirFacturables`, `limit` y `offset`.
    // Se ejerce el contrato directamente porque lo que se protege es el camino, no el endpoint de
    // hoy: un `?documento=` añadido mañana entraría por aquí sin tocar este archivo.
    const req = { headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } } as never;
    await registrarAccesoCliente(req, {
      accion: 'search',
      campos: CAMPOS_PII_VEREDICTO,
      filtros: { documento: '79345612', motivo: 'direccion_faltante' },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('79345612');
    // La CLAVE se conserva: saber que alguien buscó «por documento» es lo que hace útil el registro.
    expect(motivo).toContain('documento=79***612');
    expect(motivo).toContain('motivo=direccion_faltante');
    expect(motivo.length).toBeLessThanOrEqual(200);
  });
});

describe('lo que NO se registra', () => {
  it('un cliente que no existe (404) no deja registro de acceso', async () => {
    cartera([]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/999/validacion`).set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('un rol sin lectura (403) no deja registro de acceso', async () => {
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth('conductor'));

    expect(r.status).toBe(403);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('la auditoría no cambia lo que las rutas devuelven', () => {
  it('el veredicto sigue saliendo con `nombre` y `documento` en claro', async () => {
    // El tipo lo dice desde esta HU sin rodeos: no hay enmascarado en ninguna capa. Si algún día lo
    // hay, será una decisión de producto y esta prueba tendrá que cambiar a propósito, no de rebote.
    cartera([cliente()]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/41/validacion`).set('Authorization', await auth());

    expect(r.body).toMatchObject({
      clienteId: 41, nombre: 'PEDRO ANTONIO GÓMEZ', documento: '79345612', facturable: false,
    });
  });

  it('el detalle conserva `data` y `total`', async () => {
    cartera([cliente(), cliente({ id: 42 })]);
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/validacion/detalle`).set('Authorization', await auth());

    expect(r.body.total).toBe(2);
    expect(r.body.data).toHaveLength(2);
  });
});
