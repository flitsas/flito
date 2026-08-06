// Siigo — mapeo de conceptos: fronteras HTTP (HU #11282, AC8).
//
// Lo que se prueba aquí es QUIÉN entra y qué queda en la auditoría. La lógica de la confirmación
// frágil y de la precedencia por tipo de trámite vive en siigo-mapeo-conceptos.test.ts; aquí
// drizzle y la auditoría están mockeados.
//
// La matriz de roles se recorre entera a propósito: un `requireRole` mal escrito solo se nota
// probando el rol que NO debería pasar, y el matiz de esta HU es justo ese —`financiera` firma la
// confirmación pero no edita el mapeo—.

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

const TABLA = 'siigo_mapeo_conceptos';
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function fila(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    ambiente: 'pruebas',
    concepto: 'logistica',
    tipoTramite: null,
    codigoProducto: 'LOG-1',
    nombreProducto: 'Logística FLIT',
    clasificacionTributaria: 'gravado',
    impuestos: [{ id: 13156 }],
    unidadMedida: '94',
    ingresoParaTerceros: false,
    facturaLineaPropia: true,
    lineaPropiaPendiente: false,
    confirmadoContabilidad: false,
    confirmadoPorId: null,
    confirmadoEn: null,
    confirmacionRevertidaEn: null,
    confirmacionRevertidaPor: null,
    activo: true,
    notas: null,
    createdAt: new Date('2026-08-05T10:00:00Z'),
    createdBy: null,
    updatedAt: new Date('2026-08-05T10:00:00Z'),
    updatedBy: null,
    ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/mapeo-conceptos.routes.js');
  app.use('/api/siigo/mapeo-conceptos', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

/** Todos los roles que NO son admin ni financiera. Ninguno escribe nada (AC8). */
const ROLES_SIN_ESCRITURA: TestRole[] = [
  'auditor', 'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => { kdb.reset(); auditMock.mockClear(); });

describe('AC8 — ninguna ruta del mapeo es pública', () => {
  it.each([
    ['get', '/api/siigo/mapeo-conceptos'],
    ['get', `/api/siigo/mapeo-conceptos/${ID}`],
    ['post', '/api/siigo/mapeo-conceptos'],
    ['patch', `/api/siigo/mapeo-conceptos/${ID}`],
    ['post', `/api/siigo/mapeo-conceptos/${ID}/confirmar`],
    ['delete', `/api/siigo/mapeo-conceptos/${ID}`],
  ])('%s %s sin token → 401', async (verbo, ruta) => {
    const app = await buildApp();
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo](ruta);
    expect(r.status).toBe(401);
  });
});

describe('AC8 — editar el mapeo es solo del rol de administración', () => {
  it('admin edita → 200', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, [fila({ codigoProducto: 'LOG-2' })]);
    const app = await buildApp();

    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'LOG-2' });

    expect(r.status).toBe(200);
    expect(r.body.codigoProducto).toBe('LOG-2');
  });

  it('financiera NO edita el mapeo, aunque sí pueda confirmarlo → 403', async () => {
    const app = await buildApp();
    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('financiera'))
      .send({ codigoProducto: 'LOG-2' });

    expect(r.status).toBe(403);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it.each(ROLES_SIN_ESCRITURA)('%s no edita → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth(role))
      .send({ codigoProducto: 'LOG-2' });

    expect(r.status).toBe(403);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it.each(ROLES_SIN_ESCRITURA)('%s tampoco crea una configuración por tipo de trámite → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/mapeo-conceptos')
      .set('Authorization', await auth(role))
      .send({ concepto: 'logistica', tipoTramite: 'TRASPASO' });

    expect(r.status).toBe(403);
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('AC8 — la confirmación de contabilidad la aplican admin y financiera', () => {
  it.each<TestRole>(['admin', 'financiera'])('%s confirma → 200', async (role) => {
    kdb.when.select(TABLA, [fila()])
      .update(TABLA, [fila({ confirmadoContabilidad: true, confirmadoPorId: 9, confirmadoEn: new Date() })]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/mapeo-conceptos/${ID}/confirmar`)
      .set('Authorization', await auth(role));

    expect(r.status).toBe(200);
    expect(r.body.confirmadoContabilidad).toBe(true);
    expect(r.body.confirmadoPorId).toBe(9);
  });

  it.each(ROLES_SIN_ESCRITURA)('%s no confirma → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).post(`/api/siigo/mapeo-conceptos/${ID}/confirmar`)
      .set('Authorization', await auth(role));

    expect(r.status).toBe(403);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('auditor lee el mapeo pero no lo escribe', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const lectura = await request(app).get('/api/siigo/mapeo-conceptos')
      .set('Authorization', await auth('auditor'));
    expect(lectura.status).toBe(200);
    expect(lectura.body.data).toHaveLength(1);

    const escritura = await request(app).delete(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('auditor'));
    expect(escritura.status).toBe(403);
  });

  it('un rol sin lectura tampoco entra al listado', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/mapeo-conceptos')
      .set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });
});

describe('AC8 — todo cambio queda en la auditoría con usuario, momento y valor anterior', () => {
  it('la edición audita el estado ANTERIOR además del nuevo', async () => {
    kdb.when.select(TABLA, [fila({ codigoProducto: 'LOG-1' })])
      .update(TABLA, [fila({ codigoProducto: 'LOG-2' })]);
    const app = await buildApp();

    await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'LOG-2' });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [req, entrada] = auditMock.mock.calls[0];
    expect(entrada).toMatchObject({ action: 'update', resource: 'siigo_mapeo_concepto', resourceId: ID });
    expect(entrada.detail).toContain('Antes:');
    expect(entrada.detail).toContain('producto=LOG-1');
    expect(entrada.detail).toContain('Después:');
    expect(entrada.detail).toContain('producto=LOG-2');
    // El usuario y el momento los pone `audit()` a partir de la petición; aquí basta con que la
    // petición autenticada sea la que llega.
    expect(req.user.sub).toBe(9);
  });

  it('cuando el cambio tumba la confirmación, la auditoría dice qué campo la tumbó', async () => {
    kdb.when.select(TABLA, [fila({
      confirmadoContabilidad: true, confirmadoPorId: 5, confirmadoEn: new Date('2026-08-01T09:00:00Z'),
    })]).update(TABLA, [fila({ confirmadoContabilidad: false })]);
    const app = await buildApp();

    await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ clasificacionTributaria: 'exento' });

    expect(auditMock.mock.calls[0][1].detail).toContain('Confirmación revertida');
    expect(auditMock.mock.calls[0][1].detail).toContain('clasificacionTributaria');
  });

  it('la confirmación también se audita', async () => {
    kdb.when.select(TABLA, [fila()])
      .update(TABLA, [fila({ confirmadoContabilidad: true, confirmadoPorId: 9, confirmadoEn: new Date() })]);
    const app = await buildApp();

    await request(app).post(`/api/siigo/mapeo-conceptos/${ID}/confirmar`)
      .set('Authorization', await auth('financiera'));

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].detail).toContain('Confirmación de contabilidad');
  });

  it('lo que se audita no lleva PII ni SQL: solo campos del mapeo', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, [fila({ codigoProducto: 'LOG-2' })]);
    const app = await buildApp();

    await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'LOG-2' });

    const detail: string = auditMock.mock.calls[0][1].detail;
    expect(detail).not.toMatch(/select |insert |update |where /i);
    expect(detail).not.toMatch(/\bcedula\b|\bdocumento\b|\bplaca\b/i);
  });

  it('un 403 no deja rastro de auditoría porque no hubo cambio que auditar', async () => {
    const app = await buildApp();
    await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('auditor'))
      .send({ codigoProducto: 'X' });

    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('Bordes del borde HTTP', () => {
  it('el ambiente viaja en la query y se devuelve explícito, nunca «todos»', async () => {
    kdb.when.select(TABLA, [fila({ ambiente: 'produccion' })]);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/mapeo-conceptos?ambiente=produccion')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.ambiente).toBe('produccion');
  });

  it('un ambiente inventado cae al del entorno en vez de mezclar empresas de Siigo', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/mapeo-conceptos?ambiente=marte')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(['pruebas', 'produccion']).toContain(r.body.ambiente);
  });

  it('un id que no es UUID se rechaza en el borde → 400', async () => {
    const app = await buildApp();
    const r = await request(app).patch('/api/siigo/mapeo-conceptos/no-es-uuid')
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'X' });

    expect(r.status).toBe(400);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('un código de producto con espacios se rechaza con Zod, antes de tocar la base', async () => {
    const app = await buildApp();
    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'LOG 2' });

    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('una clasificación tributaria inventada se rechaza con Zod', async () => {
    const app = await buildApp();
    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ clasificacionTributaria: 'semi-gravado' });

    expect(r.status).toBe(400);
  });

  it('un concepto que no es facturable se rechaza al crear', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/mapeo-conceptos')
      .set('Authorization', await auth('admin'))
      .send({ concepto: 'peaje', tipoTramite: 'TRASPASO' });

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('editar un mapeo inexistente → 404 con mensaje de negocio, no un 500', async () => {
    kdb.when.select(TABLA, []);
    const app = await buildApp();

    const r = await request(app).patch(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'))
      .send({ codigoProducto: 'LOG-2' });

    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ codigo: 'no_existe' });
  });

  it('confirmar sin código de producto → 400 explicando por qué', async () => {
    kdb.when.select(TABLA, [fila({ codigoProducto: null })]);
    const app = await buildApp();

    const r = await request(app).post(`/api/siigo/mapeo-conceptos/${ID}/confirmar`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/código de producto/i);
  });

  it('borrar la configuración genérica → 409, no un borrado silencioso', async () => {
    kdb.when.select(TABLA, [fila({ tipoTramite: null })]);
    const app = await buildApp();

    const r = await request(app).delete(`/api/siigo/mapeo-conceptos/${ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(409);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('GET /estado resume lo que falta para poder facturar', async () => {
    kdb.when.select(TABLA, [fila({ confirmadoContabilidad: true, confirmadoPorId: 5, confirmadoEn: new Date() })]);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/mapeo-conceptos/estado')
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body.completo).toBe(false);
    expect(r.body.conceptosPendientes.length).toBeGreaterThan(0);
  });
});
