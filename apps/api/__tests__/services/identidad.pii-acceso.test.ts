// Feature #14284 (HU #14285 AC1, AC3, AC5, AC6; HU #14286 AC5 y AC6) — lo que cada lectura de
// validación de identidad deja en `pii_access_log`. `logPiiAccess` no se mockea: se mira lo que llega
// al INSERT. El fallo cerrado está en `tramites-identidad-fotos.test.ts`, que monta `errorHandler`.
import 'express-async-errors';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const m = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const logs: unknown[][] = [];
  const rec = (...a: unknown[]) => { logs.push(a); };
  const logger: Record<string, unknown> = { trace: rec, debug: rec, info: rec, warn: rec, error: rec, fatal: rec };
  logger.child = () => logger;
  return {
    logs, logger, selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), getPhotoMock: vi.fn(),
    uploadPhotoMock: vi.fn(), anthropicMock: vi.fn(),
  };
});

vi.mock('../../src/shared/logger.js', () => ({ logger: m.logger, loggerFor: () => m.logger }));
vi.mock('../../src/db/client.js', () => ({
  db: { select: m.selectMock, insert: m.insertMock, update: m.updateMock, delete: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/services/storage.js', () => ({
  uploadPhoto: m.uploadPhotoMock,
  getPhoto: m.getPhotoMock,
  ensureBucket: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: m.anthropicMock }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() }, createTransport: vi.fn() }));
vi.mock('express-rate-limit', () => ({ default: () => (_q: unknown, _s: unknown, next: () => void) => next() }));

const { default: router } = await import('../../src/modules/tramites/identidad.routes.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');

type Fila = Record<string, unknown>;
const filas: Fila[] = [];
const eventos: string[] = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_q: Request, res: Response, next: NextFunction) => {
    const original = res.writeHead.bind(res) as (...a: unknown[]) => Response;
    res.writeHead = ((...a: unknown[]) => { eventos.push('respuesta'); return original(...a); }) as typeof res.writeHead;
    next();
  });
  app.use('/api/validacion-identidad', router);
  app.use(errorHandler);
  return app;
}

const validacion = {
  id: 41, tramiteId: 5, nombre: 'Persona Prueba', tipoDoc: 'CC', documento: '998877', email: 'p@correo.test',
  estado: 'aprobado', score: 90, fotoRostro: null, fotoCedulaFrontal: null, fotoCedulaReverso: null,
  detalle: {}, validadoAt: null, ipAddress: null, ciudadGeo: null, lat: null, lng: null, userAgent: null,
  token: null, intentos: 1, enviadoAt: null, placa: 'ABC123', vehiculoInfo: null,
};

const adminAuth = async () => `Bearer ${await testToken({ sub: 77, role: 'admin' })}`;
// `tipoEnlace: 'ninguno'`: se mide la función requerida, no la frontera, que cierra este módulo al enlace de fábrica de `proveedor`.
const proveedorAuth = async () => `Bearer ${await testToken({ sub: 78, role: 'proveedor', tipoEnlace: 'ninguno' })}`;
const FOTOS = ['foto_rostro', 'foto_cedula_frontal', 'foto_cedula_reverso'];
const DOCUMENTOS = [...FOTOS, 'nombre', 'tipo_doc', 'documento', 'detalle', 'ip_address', 'ciudad_geo', 'lat', 'lng'];

function sinValoresPersonales(fila: Fila) {
  const volcado = JSON.stringify(fila);
  for (const valor of ['Persona Prueba', '998877', 'p@correo.test', 'ABC123']) expect(volcado).not.toContain(valor);
}

beforeEach(() => {
  filas.length = 0;
  eventos.length = 0;
  m.logs.length = 0;
  m.selectMock.mockReset();
  m.updateMock.mockReset();
  m.insertMock.mockReset();
  m.anthropicMock.mockReset();
  m.uploadPhotoMock.mockReset();
  // El INSERT tarda de verdad: si la ruta no lo espera, la respuesta sale antes en `eventos`.
  m.insertMock.mockImplementation(() => ({
    values: async (v: Fila) => {
      await new Promise((r) => setTimeout(r, 15));
      eventos.push('insert');
      filas.push(v);
    },
  }));
});

describe('GET /documentos/:tramiteId', () => {
  it('escribe la fila con usuario, recurso y campos, sin valores, antes de responder', async () => {
    m.selectMock.mockReturnValueOnce(chain([validacion]));

    const r = await request(buildApp()).get('/api/validacion-identidad/documentos/5').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body.documentos[0].nombre).toBe('Persona Prueba');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      userId: 77, userRole: 'admin', resourceTipo: 'validacion_identidad', resourceId: 5, accion: 'decrypt',
      camposAccedidos: DOCUMENTOS, motivo: 'filas=1',
    });
    sinValoresPersonales(filas[0]);
    expect(eventos).toEqual(['insert', 'respuesta']);
  });

  it('sin registros responde 200 y no escribe fila', async () => {
    m.selectMock.mockReturnValueOnce(chain([]));

    const r = await request(buildApp()).get('/api/validacion-identidad/documentos/5').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body.documentos).toEqual([]);
    expect(m.insertMock).not.toHaveBeenCalled();
  });

  it('sin la función responde 403 y no registra lectura', async () => {
    const r = await request(buildApp()).get('/api/validacion-identidad/documentos/5').set('Authorization', await proveedorAuth());

    expect(r.status).toBe(403);
    expect(m.selectMock).not.toHaveBeenCalled();
    expect(m.insertMock).not.toHaveBeenCalled();
  });
});

describe('POST /certificado/:tramiteId', () => {
  it('escribe la fila antes de responder y entrega el PDF', async () => {
    m.selectMock.mockReturnValue(chain([validacion]));

    const r = await request(buildApp()).post('/api/validacion-identidad/certificado/5').set('Authorization', await adminAuth()).send({});

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      userId: 77, resourceTipo: 'certificado_identidad', resourceId: 5, accion: 'export',
      camposAccedidos: [...DOCUMENTOS, 'email', 'placa', 'user_agent'], motivo: 'filas=1',
    });
    sinValoresPersonales(filas[0]);
    expect(eventos).toEqual(['insert', 'respuesta']);
  });

  it('sin la función responde 403 y no registra lectura', async () => {
    const r = await request(buildApp()).post('/api/validacion-identidad/certificado/5').set('Authorization', await proveedorAuth()).send({});

    expect(r.status).toBe(403);
    expect(m.insertMock).not.toHaveBeenCalled();
  });
});

describe('GET /estado/:tramiteId', () => {
  it('escribe una fila por lectura, antes de responder', async () => {
    m.selectMock.mockReturnValue(chain([validacion, { ...validacion, id: 42 }]));
    const auth = await adminAuth();

    const r = await request(buildApp()).get('/api/validacion-identidad/estado/5').set('Authorization', auth);
    expect(eventos).toEqual(['insert', 'respuesta']);
    await request(buildApp()).get('/api/validacion-identidad/estado/5').set('Authorization', auth);

    expect(r.status).toBe(200);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({
      resourceTipo: 'validacion_identidad', resourceId: 5, accion: 'read',
      camposAccedidos: ['nombre', 'documento', 'email'], motivo: 'filas=2',
    });
    sinValoresPersonales(filas[0]);
  });

  it('si no se puede escribir, la lectura sigue y el fallo queda en el log', async () => {
    m.selectMock.mockReturnValueOnce(chain([validacion]));
    m.insertMock.mockImplementation(() => ({ values: () => Promise.reject(new Error('caida')) }));

    const r = await request(buildApp()).get('/api/validacion-identidad/estado/5').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body.validaciones).toHaveLength(1);
    expect(JSON.stringify(m.logs)).toContain('fallo escribiendo pii_access_log');
  });

  it('sin registros responde 200 y no escribe fila', async () => {
    m.selectMock.mockReturnValueOnce(chain([]));

    const r = await request(buildApp()).get('/api/validacion-identidad/estado/5').set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(m.insertMock).not.toHaveBeenCalled();
  });
});

describe('GET /sse', () => {
  it('el evento lleva exactamente tipo, tramiteId y estado: no el nombre', async () => {
    m.updateMock.mockImplementationOnce(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }));
    m.updateMock.mockImplementationOnce(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...validacion, documento: '998877' }]) }) }) }));
    m.updateMock.mockImplementation(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }));
    m.uploadPhotoMock.mockResolvedValue('validaciones/5/foto.jpg');
    m.anthropicMock.mockResolvedValueOnce({
      ok: true,
      data: { content: [{ text: JSON.stringify({
        resultado_general: { aprobado: true, score_total: 95 },
        documento_ocr: { numero: '998877', es_documento_oficial: true, documento_integro: true, frente_y_reverso_coherentes: true, documento_es_foto_fisica: true },
        liveness: { rostro_visible: true, es_persona_real: true },
        comparacion_facial: { score: 90 },
      }) }] },
    });
    const auth = await adminAuth();
    const servidor = buildApp().listen(0);
    try {
      await new Promise((r) => servidor.once('listening', r));
      const { port } = servidor.address() as AddressInfo;
      const respuesta = await new Promise<http.IncomingMessage>((resolver, rechazar) => {
        http.get({ port, path: '/api/validacion-identidad/sse', headers: { Authorization: auth } }, resolver).on('error', rechazar);
      });
      let recibido = '';
      respuesta.on('data', (trozo: Buffer) => { recibido += trozo.toString(); });

      const completar = await request(servidor).post('/api/validacion-identidad/completar/tok')
        .send({ fotoRostro: 'x', fotoCedula: 'x', fotoCedulaReverso: 'x' });
      expect(completar.status).toBe(200);

      await vi.waitFor(() => { expect(recibido).toContain('validacion_completada'); });
      const linea = recibido.split('\n').find((l) => l.includes('validacion_completada')) ?? '';
      const evento = JSON.parse(linea.replace(/^data: /, '')) as Fila;
      expect(Object.keys(evento).sort()).toEqual(['estado', 'tipo', 'tramiteId']);
      expect(evento.tramiteId).toBe(5);
      expect(recibido).not.toContain('Persona Prueba');
      respuesta.destroy();
    } finally {
      servidor.closeAllConnections();
      await new Promise((r) => servidor.close(r));
    }
  });
});
