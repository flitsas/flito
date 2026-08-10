// HU #11343 — registrar la corrección de una factura ya emitida: fronteras HTTP y servicio.
//
// Lo que se prueba aquí es QUIÉN entra, QUÉ se guarda y qué se rechaza. La decisión de admisibilidad
// vive en `siigo-correcciones.test.ts`, que la interroga sin base de datos.
//
// La matriz de roles se recorre entera a propósito: un `requireRole` mal escrito solo se nota
// probando el rol que NO debería pasar. El matiz de esta historia es que `auditor` LEE las
// correcciones y no las registra — auditar es mirar, y una corrección es una afirmación sobre un
// documento ante la DIAN.

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
const bitacoraMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: bitacoraMock,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const FACTURAS = 'siigo_facturas';
const CORRECCIONES = 'siigo_factura_correcciones';
const PUENTE = 'siigo_factura_tramites';

const FACTURA_ID = '11111111-2222-3333-4444-555555555555';
const TRAMITE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Una factura emitida y aceptada por la DIAN: tiene CUFE. Es el caso que hay que corregir. */
function factura(over: Record<string, unknown> = {}) {
  return {
    id: FACTURA_ID, loteId: 'lote-1', ambiente: 'pruebas', empresaEmisoraNit: null,
    idempotencyKey: 'LOTE001', siigoInvoiceId: 'inv-1', numero: 'FV-100',
    comprobanteNombre: null, cufe: 'cufe-abc', publicUrl: null, totalSiigo: '100.00',
    estado: 'emitida', enProcesoDesde: null, intentos: 1, errorCode: null, errorDetalle: null,
    enviadaEn: new Date('2026-08-09T15:00:00Z'),
    requiereRevision: false, revisionMotivo: null,
    createdAt: new Date('2026-08-09T15:00:00Z'), updatedAt: new Date('2026-08-09T15:00:00Z'),
    ...over,
  };
}

/** Fila de corrección tal como sale del `returning()` y del `SELECT` con join a users. */
function correccion(over: Record<string, unknown> = {}) {
  return {
    id: 'corr-1', facturaId: FACTURA_ID, tipo: 'otra', ejecutor: 'manual',
    documentoSiigo: 'NC-9001', motivo: 'Se corrigió el valor del derecho de tránsito',
    fechaCorreccion: '2026-08-10', registradoPor: 9,
    createdAt: new Date('2026-08-10T12:00:00Z'),
    ...over,
  };
}

/** Como devuelve el join `{ c, nombre }` de `correccionesDe()`. */
function correccionConNombre(over: Record<string, unknown> = {}) {
  return { c: correccion(over), nombre: 'Ana Ramírez' };
}

const CUERPO_VALIDO = {
  tipo: 'otra',
  documentoSiigo: 'NC-9001',
  motivo: 'Se corrigió el valor del derecho de tránsito',
};

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/correcciones.routes.js');
  app.use('/api/siigo/correcciones', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

/** Ni admin ni financiera. Ninguno registra una corrección (AC7). `auditor` incluido. */
const ROLES_SIN_ESCRITURA: TestRole[] = [
  'auditor', 'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  bitacoraMock.mockClear();
});

describe('AC7 — ninguna ruta de correcciones es pública', () => {
  it.each([
    ['get', `/api/siigo/correcciones/factura/${FACTURA_ID}`],
    ['post', `/api/siigo/correcciones/factura/${FACTURA_ID}`],
    ['get', `/api/siigo/correcciones/tramites?ids=${TRAMITE_ID}`],
  ])('%s %s sin token → 401', async (verbo, ruta) => {
    const app = await buildApp();
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo]!(ruta);
    expect(r.status).toBe(401);
  });
});

describe('AC7 — corregir exige permiso', () => {
  it.each(['admin', 'financiera'] as TestRole[])('%s registra → 201', async (role) => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []).insert(CORRECCIONES, [correccion()]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth(role)).send(CUERPO_VALIDO);

    expect(r.status).toBe(201);
  });

  it.each(ROLES_SIN_ESCRITURA)('%s no registra → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth(role)).send(CUERPO_VALIDO);

    expect(r.status).toBe(403);
    // Y no llega a la base: la guarda va ANTES del handler, no dentro.
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('auditor y financiera SÍ consultan qué admite la factura', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []);
    const app = await buildApp();

    for (const role of ['auditor', 'financiera'] as TestRole[]) {
      const r = await request(app).get(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
        .set('Authorization', await auth(role));
      expect(r.status).toBe(200);
      expect(r.body.evaluacion.puedeCorregirse).toBe(true);
    }
  });

  it('un rol sin lectura tampoco consulta', async () => {
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });

  it('toda corrección registrada queda atribuida a quien la registró', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []).insert(CORRECCIONES, [correccion()]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('financiera')).send(CUERPO_VALIDO);

    expect(r.body.registradoPor).toBe(9);
    const [, entrada] = auditMock.mock.calls.at(-1)!;
    expect(entrada.action).toBe('create');
    expect(entrada.resource).toBe('siigo_factura_correcciones');
    expect(entrada.detail).toContain('NC-9001');
  });
});

describe('AC3 — se registra lo que se hizo por fuera', () => {
  it('guarda tipo, documento, motivo, fecha y quién', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []).insert(CORRECCIONES, [correccion()]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ ...CUERPO_VALIDO, tipo: 'otra', fechaCorreccion: '2026-08-10' });

    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      tipo: 'otra', documentoSiigo: 'NC-9001', fechaCorreccion: '2026-08-10',
      motivo: 'Se corrigió el valor del derecho de tránsito', registradoPor: 9,
    });
  });

  it('el ejecutor es siempre manual, aunque el cuerpo intente decir otra cosa', async () => {
    // Es el único ejecutor que hoy existe. El automático es la HU #11344, bloqueada: si alguna vez
    // se pudiera declarar por el cuerpo de la petición, cualquiera podría afirmar que FLITO ejecutó
    // contra Siigo algo que nadie ejecutó.
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []).insert(CORRECCIONES, [correccion()]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ ...CUERPO_VALIDO, ejecutor: 'automatico' });

    expect(r.status).toBe(201);
    expect(r.body.ejecutor).toBe('manual');
  });

  it('el motivo es obligatorio, y «error» no es un motivo', async () => {
    const app = await buildApp();
    for (const motivo of [undefined, '', 'error', '   ']) {
      const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
        .set('Authorization', await auth('admin'))
        .send({ ...CUERPO_VALIDO, motivo });
      expect(r.status).toBe(400);
      expect(kdb.insert).not.toHaveBeenCalled();
    }
  });

  it('sin identificador del documento en Siigo no se registra', async () => {
    // Una corrección que no se puede ir a verificar en Siigo es un rumor, y esta historia existe
    // justamente para que el trámite deje de mentir.
    const app = await buildApp();
    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ ...CUERPO_VALIDO, documentoSiigo: '  ' });
    expect(r.status).toBe(400);
  });

  it('una fecha en el futuro se rechaza', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []);
    const app = await buildApp();
    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ ...CUERPO_VALIDO, fechaCorreccion: '2099-01-01' });
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('datos');
  });

  it('queda también en la bitácora inalterable de Siigo', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []).insert(CORRECCIONES, [correccion()]);
    const app = await buildApp();

    await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin')).send(CUERPO_VALIDO);

    const registro = bitacoraMock.mock.calls.at(-1)![0];
    expect(registro).toMatchObject({
      operacion: 'registrar_correccion', entidadTipo: 'factura', entidadId: FACTURA_ID,
      resultado: 'ok', codigo: 'otra', createdBy: 9,
    });
    // El motivo lo escribe una persona en texto libre y la bitácora es WORM: un dato personal
    // escrito ahí ya no se puede rectificar ni suprimir (Ley 1581, art. 8).
    expect(registro.mensaje).not.toContain('derecho de tránsito');
  });

  it('el mismo documento no se registra dos veces contra la misma factura', async () => {
    // En una tabla que prohíbe DELETE, la fila duplicada de un doble clic se queda para siempre.
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, [correccionConNombre()]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin')).send(CUERPO_VALIDO);

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('duplicada');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('si la carrera gana el otro, la violación del UNIQUE se traduce, no revienta', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []);
    kdb.insert.mockImplementation(() => {
      const run = () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
      const chain: Record<string, unknown> = {};
      for (const m of ['values', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin')).send(CUERPO_VALIDO);

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('duplicada');
  });
});

describe('AC6 — no se corrige lo que no llegó a existir', () => {
  it.each([
    ['fallida', factura({ estado: 'fallida' })],
    ['en proceso', factura({ estado: 'en_proceso', siigoInvoiceId: null, cufe: null })],
  ])('una factura %s se rechaza explicando que no hay documento', async (_caso, f) => {
    kdb.when.select(FACTURAS, [f]).select(CORRECCIONES, []);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin')).send(CUERPO_VALIDO);

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('no_corregible');
    expect(r.body.error).toContain('No hay documento que corregir');
    // Y se indica la vía: reintentar o marcarla como fallida definitiva.
    expect(r.body.error).toContain('reintentar');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('un tipo que la factura no admite se rechaza con el motivo de la exclusión', async () => {
    // La factura tiene CUFE: Siigo no permite anularla. El rechazo lleva el porqué.
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, []);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'))
      .send({ ...CUERPO_VALIDO, tipo: 'anulacion' });

    expect(r.status).toBe(409);
    expect(r.body.error).toContain('CUFE');
  });

  it('una factura que no existe da 404 y no 500', async () => {
    kdb.when.select(FACTURAS, []);
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
  });

  it('un identificador que no es UUID se rechaza antes de tocar la base', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/correcciones/factura/no-es-uuid')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
  });
});

describe('AC4 — una factura corregida deja de parecer pendiente', () => {
  it('el trámite figura como corregido, con el tipo y el documento', async () => {
    kdb.when.select(PUENTE, [{
      tramiteId: TRAMITE_ID, facturaId: FACTURA_ID, tipo: 'otra',
      documentoSiigo: 'NC-9001', fechaCorreccion: '2026-08-10',
      createdAt: new Date('2026-08-10T12:00:00Z'),
    }]);
    const app = await buildApp();

    const r = await request(app).get(`/api/siigo/correcciones/tramites?ids=${TRAMITE_ID}`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({
      tramiteId: TRAMITE_ID, corregida: true, tipo: 'otra', documentoSiigo: 'NC-9001',
    });
  });

  it('un trámite con factura y sin corrección NO figura como corregido', async () => {
    kdb.when.select(PUENTE, [{
      tramiteId: TRAMITE_ID, facturaId: FACTURA_ID, tipo: null,
      documentoSiigo: null, fechaCorreccion: null, createdAt: null,
    }]);
    const app = await buildApp();

    const r = await request(app).get(`/api/siigo/correcciones/tramites?ids=${TRAMITE_ID}`)
      .set('Authorization', await auth('financiera'));

    expect(r.body.data[0]).toMatchObject({ corregida: false, tipo: null });
  });

  it('un trámite desconocido sale igualmente en la respuesta', async () => {
    // Devolver una lista más corta que la pedida obliga a quien pregunta a adivinar cuál falta, y
    // «no lo conozco» no es lo mismo que «no está corregido».
    kdb.when.select(PUENTE, []);
    const app = await buildApp();

    const r = await request(app).get(`/api/siigo/correcciones/tramites?ids=${TRAMITE_ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ tramiteId: TRAMITE_ID, corregida: false, facturaId: null });
  });

  it('la consulta en lote tiene techo: no es un escaneo disfrazado', async () => {
    const muchos = Array.from({ length: 201 }, () => TRAMITE_ID).join(',');
    const app = await buildApp();
    const r = await request(app).get(`/api/siigo/correcciones/tramites?ids=${muchos}`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });

  it('la consulta de la factura devuelve su historial y la factura sigue intacta', async () => {
    kdb.when.select(FACTURAS, [factura()]).select(CORRECCIONES, [correccionConNombre()]);
    const app = await buildApp();

    const r = await request(app).get(`/api/siigo/correcciones/factura/${FACTURA_ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.body.estado).toBe('emitida');
    expect(r.body.numero).toBe('FV-100');
    expect(r.body.correcciones).toHaveLength(1);
    expect(r.body.correcciones[0].registradoPorNombre).toBe('Ana Ramírez');
    expect(r.body.evaluacion.yaCorregida).toBe(true);
    // No hay UPDATE en ninguna parte del flujo: la factura original no se toca.
    expect(kdb.update).not.toHaveBeenCalled();
  });
});
