// Certificación de impuestos — frontera HTTP de POST /api/flito/impuestos/:id/certificar (HU #11165).
//
// Lo que se prueba aquí es el BORDE, no la lógica: quién entra (AC7) y que cada desenlace del
// servicio salga con su código HTTP y su `code` propio. Esto último importa más de lo que parece:
// tres de los cinco desenlaces comparten el 409, así que si el `code` no viaja la interfaz acabaría
// distinguiéndolos por el texto del mensaje — y ese texto es exactamente lo que cambia sin avisar.
//
// El servicio de certificación se mockea entero; sus reglas ya están cubiertas en
// flito-impuestos.certificacion.service.test.ts y el motor puro en certificacion-runt.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { MotivoNoElegible, ResultadoCertificacion } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const certificarMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/certificacion.service.js', () => ({
  certificarImpuesto: (...a: unknown[]) => certificarMock(...a),
  certificarLote: vi.fn(),
  certificacionVigente: vi.fn(),
  certificacionVigenteConAcceso: vi.fn(),
  ESTADOS_IMPUESTO_CERTIFICABLES: ['solicitado'],
}));

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'gestor@flit.io', role })}`;

const post = async (role: TestRole) =>
  request(await buildApp()).post(`/api/flito/impuestos/${ID}/certificar`).set('Authorization', await auth(role));

beforeEach(() => {
  kdb.reset();
  certificarMock.mockReset();
});

describe('AC7 — permisos', () => {
  it('un auditor (solo lectura) recibe 403 y no llega al servicio', async () => {
    const r = await post('auditor');

    expect(r.status).toBe(403);
    expect(certificarMock).not.toHaveBeenCalled();
  });

  it('sin token es 401', async () => {
    const r = await request(await buildApp()).post(`/api/flito/impuestos/${ID}/certificar`);

    expect(r.status).toBe(401);
    expect(certificarMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['admin', 'gestor_impuestos'])('%s sí puede certificar', async (role) => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.CERTIFICADO,
      certificacion: { id: 'cert-1', placaConsultada: 'QIU744' },
    });

    const r = await post(role);

    expect(r.status).toBe(200);
    expect(certificarMock).toHaveBeenCalled();
  });
});

describe('mapeo de desenlaces a HTTP', () => {
  it('AC1 — certificado → 200 con la certificación', async () => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.CERTIFICADO,
      certificacion: { id: 'cert-1', placaConsultada: 'QIU744', documentoConsultado: '43902633' },
    });

    const r = await post('admin');

    expect(r.status).toBe(200);
    expect(r.body.code).toBe(ResultadoCertificacion.CERTIFICADO);
    expect(r.body.certificacion.id).toBe('cert-1');
  });

  it('AC2 — con diferencias → 409 con el detalle campo a campo', async () => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.CON_DIFERENCIAS,
      campos: [{ campo: 'placa', resultado: 'difiere', bloqueante: true, valorFlito: 'QIU744', valorRunt: 'XYZ999' }],
      diferenciasBloqueantes: [{ campo: 'placa', resultado: 'difiere', bloqueante: true, valorFlito: 'QIU744', valorRunt: 'XYZ999' }],
    });

    const r = await post('admin');

    expect(r.status).toBe(409);
    expect(r.body.code).toBe(ResultadoCertificacion.CON_DIFERENCIAS);
    expect(r.body.diferenciasBloqueantes[0].valorRunt).toBe('XYZ999');
  });

  it('AC3 — RUNT caído → 502, no 409', async () => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.ERROR_SERVICIO,
      mensaje: 'El servicio RUNT no está disponible.',
    });

    const r = await post('admin');

    expect(r.status).toBe(502);
    expect(r.body.code).toBe(ResultadoCertificacion.ERROR_SERVICIO);
  });

  it('AC4/AC6 — no elegible → 409 con el motivo', async () => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.NO_ELEGIBLE,
      motivo: MotivoNoElegible.ESTADO_NO_ELEGIBLE,
      mensaje: 'Solo se certifican impuestos en estado Solicitado.',
    });

    const r = await post('admin');

    expect(r.status).toBe(409);
    expect(r.body.code).toBe(ResultadoCertificacion.NO_ELEGIBLE);
    expect(r.body.motivo).toBe(MotivoNoElegible.ESTADO_NO_ELEGIBLE);
  });

  it('AC5 — traspaso sincronizando → 409 con code propio', async () => {
    certificarMock.mockResolvedValue({
      resultado: ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION,
      mensaje: 'El traspaso aún está sincronizando con el RUNT (24-72 horas hábiles). Reintenta más tarde.',
    });

    const r = await post('admin');

    expect(r.status).toBe(409);
    expect(r.body.code).toBe(ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION);
  });

  it('los tres 409 se distinguen por `code`, no por el mensaje', async () => {
    const codes: string[] = [];
    for (const r of [
      { resultado: ResultadoCertificacion.CON_DIFERENCIAS, campos: [], diferenciasBloqueantes: [] },
      { resultado: ResultadoCertificacion.NO_ELEGIBLE, motivo: MotivoNoElegible.SIN_PLACA, mensaje: 'x' },
      { resultado: ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION, mensaje: 'y' },
    ]) {
      certificarMock.mockResolvedValue(r);
      const res = await post('admin');
      expect(res.status).toBe(409);
      codes.push(res.body.code);
    }

    expect(new Set(codes).size).toBe(3);
  });
});

describe('errores del servicio', () => {
  it('un impuesto inaccesible sale como 404, no como 403', async () => {
    const { ImpuestoError } = await import('../../src/modules/flito-impuestos/flito-factura-venta.service.js');
    certificarMock.mockRejectedValue(new ImpuestoError(404, 'El impuesto no existe'));

    const r = await post('admin');

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('El impuesto no existe');
  });
});
