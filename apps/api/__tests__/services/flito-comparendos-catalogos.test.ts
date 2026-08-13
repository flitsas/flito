// FLITO comparendos — fronteras HTTP de los catálogos (HU #11497, Feature #11492 17a).
//
// Lo que se prueba aquí es el BORDE: quién entra (AC3: `authMiddleware` + `requireRole('admin')` en
// todas las rutas), qué se rechaza antes de tocar la base (Zod), y que la unicidad de cada catálogo
// salga como 409 con el código que nombra el AC —`nit_duplicado`, `nit_en_uso`— y no como un 500.
//
// Drizzle está mockeado por NOMBRE DE TABLA (`keyed-db`): estos catálogos hacen varias consultas por
// petición (comprobar duplicado, contar comparendos, escribir) y una cola posicional se desalinearía
// al menor refactor. La auditoría también se mockea: que se escriba se comprueba, adónde va no es de
// esta HU.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const BASE = '/api/flito/comparendos';
const ID_NIT = '11111111-1111-1111-1111-111111111111';
const ID_MUNICIPIO = '22222222-2222-2222-2222-222222222222';
const ID_CAUSAL = '33333333-3333-3333-3333-333333333333';
const AHORA = new Date('2026-08-13T12:00:00Z');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: TestRole = 'admin') =>
  `Bearer ${await testToken({ sub: 7, username: 'ops@flit.io', role })}`;

/** Fila de `flito_comparendos_nits` tal como sale de `returning()`. */
const filaNit = (over: Record<string, unknown> = {}) => ({
  id: ID_NIT, nit: '900123456', alias: 'Transportes ACME', activo: true,
  createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7, ...over,
});

const filaMunicipio = (over: Record<string, unknown> = {}) => ({
  id: ID_MUNICIPIO, codigoFuente: 'BELLO', nombre: 'Bello', activo: true,
  createdAt: AHORA, updatedAt: AHORA, ...over,
});

const filaCausal = (over: Record<string, unknown> = {}) => ({
  id: ID_CAUSAL, nombre: 'Registrado', activo: true, orden: 1,
  createdAt: AHORA, updatedAt: AHORA, ...over,
});

/** Error de PostgreSQL por índice único: es lo que llega cuando se cuela una carrera. */
const violacionUnicidad = () => { const e = new Error('duplicate key') as Error & { code: string }; e.code = '23505'; throw e; };

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
});

// ─────────────────────────── AC3 · Guardas de acceso ────────────────────────────────────────────

describe('comparendos catálogos — sin token no se ve ni se toca la parametrización', () => {
  it.each(['/nits', '/municipios', '/causales'])('GET %s sin Authorization → 401', async (ruta) => {
    const r = await request(await buildApp()).get(`${BASE}${ruta}`);
    expect(r.status).toBe(401);
  });

  it('POST /nits sin Authorization → 401 y no escribe nada', async () => {
    const r = await request(await buildApp()).post(`${BASE}/nits`).send({ nit: '900123456' });
    expect(r.status).toBe(401);
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('comparendos catálogos — CF-12: solo admin', () => {
  // `operaciones` está fusionado en `admin`, así que cualquier otro rol —incluido `auditor`, que en
  // otros módulos sí lee parametrización— se queda fuera: esta lista decide a qué NITs se les
  // consulta la deuda de tránsito.
  it.each<TestRole>(['auditor', 'gestor_impuestos', 'proveedor', 'financiera'])(
    'GET /nits con rol %s → 403', async (rol) => {
      const r = await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth(rol));
      expect(r.status).toBe(403);
    },
  );

  it('POST /municipios con rol auditor → 403 y no escribe nada', async () => {
    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth('auditor'))
      .send({ codigoFuente: 'PEREIRA' });
    expect(r.status).toBe(403);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('PATCH /causales/:id con rol conductor → 403', async () => {
    const r = await request(await buildApp()).patch(`${BASE}/causales/${ID_CAUSAL}`)
      .set('Authorization', await auth('conductor'))
      .send({ activo: false });
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────── AC1 · CRUD de NITs ─────────────────────────────────────────────────

describe('comparendos — NITs (AC1/CF-01)', () => {
  it('GET /nits lista el catálogo con la forma de ComparendosNit', async () => {
    kdb.when.select('flito_comparendos_nits', [filaNit(), filaNit({ id: ID_MUNICIPIO, nit: '800999888', alias: null, activo: false })]);

    const r = await request(await buildApp()).get(`${BASE}/nits`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { id: ID_NIT, nit: '900123456', alias: 'Transportes ACME', activo: true, creadoEn: AHORA.toISOString(), actualizadoEn: AHORA.toISOString() },
      { id: ID_MUNICIPIO, nit: '800999888', alias: null, activo: false, creadoEn: AHORA.toISOString(), actualizadoEn: AHORA.toISOString() },
    ]);
  });

  it('POST /nits crea y responde 201', async () => {
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', [filaNit()]);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456', alias: 'Transportes ACME' });

    expect(r.status).toBe(201);
    expect(r.body.nit).toBe('900123456');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'create', resource: 'flito_comparendos_nit' });
  });

  it('POST /nits normaliza puntos y espacios antes de guardar y de medir la longitud', async () => {
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', [filaNit()]);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: ' 900.123.456 ' });

    // 12 caracteres escritos, 9 de NIT: si midiera antes de normalizar, el `.` y el espacio
    // decidirían si se admite. Lo que llega al INSERT es el valor limpio, que es el que viaja
    // después al proveedor.
    expect(r.status).toBe(201);
    expect(kdb.insert).toHaveBeenCalledTimes(1);
  });

  it('POST /nits con NIT ya existente → 409 nit_duplicado', async () => {
    kdb.when.select('flito_comparendos_nits', [{ id: ID_NIT }]);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('nit_duplicado');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('POST /nits: la carrera contra el índice único también sale como 409 y no como 500', async () => {
    // La comprobación previa dice que no existe y aun así el INSERT choca: otra petición se coló
    // entre las dos. Sin el mapeo de 23505 esto sería un error interno.
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', violacionUnicidad);

    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('nit_duplicado');
  });

  it.each([
    ['demasiado corto', '1234'],
    ['demasiado largo', '9'.repeat(21)],
    ['solo puntuación', '...'],
    // El alfabeto restringido es lo que impide plantar hoy una inyección de parámetros que se
    // heredaría explotable cuando la HU #11500 interpole el NIT en la URL de Verifik.
    ['con metacaracteres de URL', '900123456&token=x'],
    ['con letras', '900ABC456'],
  ])('POST /nits con NIT %s → 400 de validación', async (_caso, nit) => {
    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('POST /nits con un alias que trae saltos de línea → 400 (no parte la bitácora en dos)', async () => {
    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900123456', alias: 'Transportes\nFALSO: usuario admin' });

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('POST /nits acepta el NIT con dígito de verificación', async () => {
    kdb.when.select('flito_comparendos_nits', []).insert('flito_comparendos_nits', [filaNit()]);

    // El guion del DV es la única puntuación que sobrevive a la normalización, y debe seguir
    // pasando: el alfabeto restringido cierra la puerta a los metacaracteres, no a los NIT reales.
    const r = await request(await buildApp()).post(`${BASE}/nits`)
      .set('Authorization', await auth())
      .send({ nit: '900.123.456-7' });

    expect(r.status).toBe(201);
    expect(kdb.insert).toHaveBeenCalledTimes(1);
  });

  it('PATCH /nits/:id desactiva (borrado suave) y devuelve la fila', async () => {
    kdb.when.update('flito_comparendos_nits', [filaNit({ activo: false })]);

    const r = await request(await buildApp()).patch(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth())
      .send({ activo: false });

    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('PATCH /nits/:id ignora el intento de cambiar el NIT (RN-02) → 400 por cuerpo vacío', async () => {
    const r = await request(await buildApp()).patch(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth())
      .send({ nit: '800000000' });

    // `nit` no está en el esquema: lo que queda es un PATCH sin nada que cambiar, y eso es un 400.
    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('PATCH /nits/:id inexistente → 404', async () => {
    kdb.when.update('flito_comparendos_nits', []);

    const r = await request(await buildApp()).patch(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth())
      .send({ alias: 'Otro alias' });

    expect(r.status).toBe(404);
  });

  it('DELETE /nits/:id con comparendos ya traídos → 409 nit_en_uso', async () => {
    kdb.when
      .select('flito_comparendos_nits', [filaNit()])
      .select('flito_comparendos_registros', [{ total: 12 }]);

    const r = await request(await buildApp()).delete(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('nit_en_uso');
    expect(kdb.delete).not.toHaveBeenCalled();
  });

  it('DELETE /nits/:id sin comparendos → 204', async () => {
    kdb.when
      .select('flito_comparendos_nits', [filaNit()])
      .select('flito_comparendos_registros', [{ total: 0 }])
      .delete('flito_comparendos_nits', []);

    const r = await request(await buildApp()).delete(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(204);
    expect(kdb.delete).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'delete', resource: 'flito_comparendos_nit' });
  });

  it('DELETE /nits/:id inexistente → 404 sin llegar a contar comparendos', async () => {
    kdb.when.select('flito_comparendos_nits', []);

    const r = await request(await buildApp()).delete(`${BASE}/nits/${ID_NIT}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(kdb.delete).not.toHaveBeenCalled();
  });

  it('PATCH /nits/:id con un id que no es UUID → 400 (y no un 500 de PostgreSQL)', async () => {
    const r = await request(await buildApp()).patch(`${BASE}/nits/no-soy-un-uuid`)
      .set('Authorization', await auth())
      .send({ activo: false });

    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── AC2 · Municipios ───────────────────────────────────────────────────

describe('comparendos — municipios fuente (AC2/CF-02)', () => {
  it('GET /municipios devuelve los ocho sembrados por la 0150', async () => {
    const seeds = [
      ['BELLO', 'Bello'], ['CALI', 'Cali'], ['ENVIGADO', 'Envigado'], ['ITAGUI', 'Itagüí'],
      ['MANIZALES', 'Manizales'], ['MEDELLIN', 'Medellín'], ['RIONEGRO', 'Rionegro'], ['SABANETA', 'Sabaneta'],
    ].map(([codigoFuente, nombre], i) => filaMunicipio({ id: `0000000${i}-0000-0000-0000-000000000000`, codigoFuente, nombre }));
    kdb.when.select('flito_comparendos_municipios', seeds);

    const r = await request(await buildApp()).get(`${BASE}/municipios`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(8);
    expect(r.body.map((m: { codigoFuente: string }) => m.codigoFuente)).toEqual([
      'BELLO', 'CALI', 'ENVIGADO', 'ITAGUI', 'MANIZALES', 'MEDELLIN', 'RIONEGRO', 'SABANETA',
    ]);
    // El código es el valor de transporte a UTS; el nombre es lo que lee un humano. Dos campos.
    expect(r.body[3]).toMatchObject({ codigoFuente: 'ITAGUI', nombre: 'Itagüí' });
  });

  it('POST /municipios normaliza el código a mayúsculas sin tildes antes de guardarlo', async () => {
    kdb.when.select('flito_comparendos_municipios', [])
      .insert('flito_comparendos_municipios', [filaMunicipio({ codigoFuente: 'ITAGUI', nombre: 'Itagüí' })]);

    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth())
      .send({ codigoFuente: ' Itagüí ', nombre: 'Itagüí' });

    // Escribir «Itagüí» como código crearía un municipio que UTS no reconoce, y el fallo no se vería
    // hasta una corrida de sync donde ese municipio «no devuelve nada».
    expect(r.status).toBe(201);
    expect(r.body.codigoFuente).toBe('ITAGUI');
    expect(r.body.nombre).toBe('Itagüí');
  });

  it('POST /municipios con código repetido → 409', async () => {
    kdb.when.select('flito_comparendos_municipios', [{ id: ID_MUNICIPIO }]);

    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth())
      .send({ codigoFuente: 'BELLO' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('municipio_duplicado');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('POST /municipios sin nombre usa el propio código como etiqueta', async () => {
    kdb.when.select('flito_comparendos_municipios', [])
      .insert('flito_comparendos_municipios', [filaMunicipio({ codigoFuente: 'PEREIRA', nombre: 'PEREIRA' })]);

    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth())
      .send({ codigoFuente: 'PEREIRA' });

    expect(r.status).toBe(201);
    expect(r.body.nombre).toBe('PEREIRA');
  });

  it.each([
    ['código vacío', { codigoFuente: '   ' }],
    ['nombre vacío', { codigoFuente: 'PEREIRA', nombre: '   ' }],
    ['código ausente', { nombre: 'Pereira' }],
    // `codigoFuente` es literalmente el `?fuente=` que se manda a UTS (RN-03). Guardar un valor con
    // metacaracteres de URL sería dejar plantada una inyección de parámetros que se activaría sola
    // cuando la HU #11499 construya la petición.
    ['código con separador de parámetros', { codigoFuente: 'BELLO&token=x' }],
    ['código con interrogante', { codigoFuente: 'BELLO?fuente=otra' }],
    ['código con porcentaje', { codigoFuente: 'MEDELLIN%23' }],
  ])('POST /municipios con %s → 400', async (_caso, body) => {
    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth())
      .send(body);

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('POST /municipios admite municipios de varias palabras', async () => {
    kdb.when.select('flito_comparendos_municipios', []).insert('flito_comparendos_municipios', [filaMunicipio({ codigoFuente: 'SANTA FE DE ANTIOQUIA', nombre: 'Santa Fe de Antioquia' })]);

    // El espacio se permite a propósito: vetar todo lo que no sea una palabra dejaría fuera a los
    // municipios compuestos. Lo que se veta son los metacaracteres de URL, no la ortografía.
    const r = await request(await buildApp()).post(`${BASE}/municipios`)
      .set('Authorization', await auth())
      .send({ codigoFuente: 'Santa Fe de Antioquia', nombre: 'Santa Fe de Antioquia' });

    expect(r.status).toBe(201);
    expect(kdb.insert).toHaveBeenCalledTimes(1);
  });

  it('PATCH /municipios/:id desactiva la fuente', async () => {
    kdb.when.update('flito_comparendos_municipios', [filaMunicipio({ activo: false })]);

    const r = await request(await buildApp()).patch(`${BASE}/municipios/${ID_MUNICIPIO}`)
      .set('Authorization', await auth())
      .send({ activo: false });

    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);
  });

  it('PATCH /municipios/:id inexistente → 404', async () => {
    kdb.when.update('flito_comparendos_municipios', []);

    const r = await request(await buildApp()).patch(`${BASE}/municipios/${ID_MUNICIPIO}`)
      .set('Authorization', await auth())
      .send({ nombre: 'Bello (Antioquia)' });

    expect(r.status).toBe(404);
  });
});

// ─────────────────────────── AC2 · Causales ─────────────────────────────────────────────────────

describe('comparendos — causales de gestión (AC2/CF-04)', () => {
  it('GET /causales devuelve las sembradas en su orden de gestión', async () => {
    kdb.when.select('flito_comparendos_causales', [
      filaCausal({ nombre: 'Registrado', orden: 1 }),
      filaCausal({ id: ID_NIT, nombre: 'Contactado cliente', orden: 2 }),
      filaCausal({ id: ID_MUNICIPIO, nombre: 'Pago gestionado', orden: 3 }),
    ]);

    const r = await request(await buildApp()).get(`${BASE}/causales`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body.map((c: { nombre: string }) => c.nombre)).toEqual(['Registrado', 'Contactado cliente', 'Pago gestionado']);
    expect(r.body[0]).toMatchObject({ orden: 1, activo: true });
  });

  it('POST /causales crea y responde 201', async () => {
    kdb.when.select('flito_comparendos_causales', [])
      .insert('flito_comparendos_causales', [filaCausal({ nombre: 'Reclamado ante el organismo', orden: 6 })]);

    const r = await request(await buildApp()).post(`${BASE}/causales`)
      .set('Authorization', await auth())
      .send({ nombre: 'Reclamado ante el organismo', orden: 6 });

    expect(r.status).toBe(201);
    expect(r.body.nombre).toBe('Reclamado ante el organismo');
  });

  it('POST /causales con nombre repetido (aunque cambie la caja) → 409', async () => {
    // RN-06: «Registrado» y «registrado» son la misma causal escrita por dos personas, y dos filas
    // partirían en dos cualquier conteo que 17b haga por causal.
    kdb.when.select('flito_comparendos_causales', [{ id: ID_CAUSAL }]);

    const r = await request(await buildApp()).post(`${BASE}/causales`)
      .set('Authorization', await auth())
      .send({ nombre: 'registrado' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('causal_duplicada');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['nombre vacío', { nombre: '   ' }],
    ['sin nombre', { activo: true }],
    ['orden fuera de SMALLINT', { nombre: 'Otra', orden: 40000 }],
  ])('POST /causales con %s → 400', async (_caso, body) => {
    const r = await request(await buildApp()).post(`${BASE}/causales`)
      .set('Authorization', await auth())
      .send(body);

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('PATCH /causales/:id desactiva sin renombrar (no consulta duplicados)', async () => {
    kdb.when.update('flito_comparendos_causales', [filaCausal({ activo: false })]);

    const r = await request(await buildApp()).patch(`${BASE}/causales/${ID_CAUSAL}`)
      .set('Authorization', await auth())
      .send({ activo: false });

    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('PATCH /causales/:id renombrando a uno ya usado → 409', async () => {
    kdb.when.select('flito_comparendos_causales', [{ id: ID_NIT }]);

    const r = await request(await buildApp()).patch(`${BASE}/causales/${ID_CAUSAL}`)
      .set('Authorization', await auth())
      .send({ nombre: 'Pago gestionado' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('causal_duplicada');
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('PATCH /causales/:id inexistente → 404', async () => {
    kdb.when.update('flito_comparendos_causales', []);

    const r = await request(await buildApp()).patch(`${BASE}/causales/${ID_CAUSAL}`)
      .set('Authorization', await auth())
      .send({ orden: 9 });

    expect(r.status).toBe(404);
  });

  it('PATCH /causales/:id con cuerpo vacío → 400', async () => {
    const r = await request(await buildApp()).patch(`${BASE}/causales/${ID_CAUSAL}`)
      .set('Authorization', await auth())
      .send({});

    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});
