// Certificado PDF — frontera HTTP de GET /api/flito/impuestos/:id/certificado (HU #11167).
//
// El CONTENIDO del documento se prueba en flito-impuestos.certificado-pdf.test.ts, sobre el
// constructor puro. Aquí se prueba lo que solo se puede afirmar desde la ruta: quién entra, qué
// código sale, y —lo importante de esta HU— las tres cosas que NO deben pasar al descargar.
//
// Esas tres negativas son el corazón de la historia y ninguna se ve mirando la respuesta:
//   · no se vuelve a consultar el RUNT (AC4), que en modo directo se cobra por consulta;
//   · no se persiste el PDF en `flito_soportes` ni en S3 (AC5);
//   · sí queda rastro en `audit_logs` (AC7).
// Un cambio que rompa cualquiera de las tres pasaría desapercibido sin estas pruebas: el usuario
// seguiría recibiendo su PDF igual de bonito.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { CampoCertificacion, ResultadoCampo } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// El RUNT entero. Que estos espías queden en cero ES la prueba de AC4.
const runtVehiculoMock = vi.fn();
const runtPersonaMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (...a: unknown[]) => runtVehiculoMock(...a),
  consultarPersonaRunt: (...a: unknown[]) => runtPersonaMock(...a),
}));

// S3. Que estos espías queden en cero es la mitad de AC5; la otra mitad la vigila `kdb.insert`.
const subirMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: (...a: unknown[]) => subirMock(...a),
  getEntityDocumentStream: vi.fn(),
  presignedGetEntityDocument: vi.fn(),
  statEntityDocument: vi.fn(),
  deleteEntityDocument: vi.fn(),
  firmarDescargaEntidad: vi.fn(),
  verificarDescargaEntidad: vi.fn(),
  ensureBucket: vi.fn(),
}));

const vigenteMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/certificacion.service.js', () => ({
  certificarImpuesto: vi.fn(),
  certificarLote: vi.fn(),
  certificacionVigente: vi.fn(),
  certificacionVigenteConAcceso: (...a: unknown[]) => vigenteMock(...a),
  ESTADOS_IMPUESTO_CERTIFICABLES: ['solicitado'],
}));

const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';

const CERTIFICACION = {
  id: 'a2f0e6d4-0000-4000-8000-000000000001',
  impuestoId: ID,
  placaConsultada: 'QIU744',
  documentoConsultado: '43902633',
  tipoDocPropietario: 'C',
  propietarioNombre: 'MARIA MUÑOZ PEÑA',
  campos: [
    { campo: CampoCertificacion.PLACA, resultado: ResultadoCampo.COINCIDE, bloqueante: true, valorFlito: 'QIU744', valorRunt: 'QIU744' },
    { campo: CampoCertificacion.VIN, resultado: ResultadoCampo.COINCIDE, bloqueante: true, valorFlito: '3KPFF51ABTE156687', valorRunt: '3KPFF51ABTE156687' },
  ],
  certificadoPorNombre: 'gestor@flit.io',
  createdAt: '2026-07-31T14:05:00.000Z',
};

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'gestor@flit.io', role })}`;

const get = async (role: TestRole) =>
  request(await buildApp()).get(`/api/flito/impuestos/${ID}/certificado`).set('Authorization', await auth(role));

beforeEach(() => {
  kdb.reset();
  vigenteMock.mockReset();
  auditMock.mockClear();
  runtVehiculoMock.mockReset();
  runtPersonaMock.mockReset();
  subirMock.mockReset();
});

describe('AC1 — descarga del certificado', () => {
  it('devuelve 200 con un PDF de verdad', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    const r = await get('gestor_impuestos');

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lo ofrece como descarga con la placa en el nombre del archivo', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    const r = await get('gestor_impuestos');

    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.headers['content-disposition']).toContain('certificado-runt-QIU744.pdf');
  });
});

describe('AC3 — impuesto sin certificación vigente', () => {
  it('devuelve 409 con un code propio y ningún PDF', async () => {
    vigenteMock.mockResolvedValue(null);

    const r = await get('gestor_impuestos');

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('sin_certificacion');
    expect(r.headers['content-type']).not.toContain('application/pdf');
  });

  it('un impuesto inaccesible es 404, no 409', async () => {
    // La diferencia no es cosmética: 409 le confirmaría al gestor que el registro existe fuera de su
    // organismo. La frontera se defiende con 404 en todo el módulo.
    const { ImpuestoError } = await import('../../src/modules/flito-impuestos/flito-factura-venta.service.js');
    vigenteMock.mockRejectedValue(new ImpuestoError(404, 'El impuesto no existe'));

    const r = await get('gestor_impuestos');

    expect(r.status).toBe(404);
  });
});

describe('AC4 — la descarga no vuelve a consultar el RUNT', () => {
  it('no llama al RUNT ni una vez', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    await get('gestor_impuestos');

    expect(runtVehiculoMock).not.toHaveBeenCalled();
    expect(runtPersonaMock).not.toHaveBeenCalled();
  });

  it('dos descargas seguidas siguen sin tocar el RUNT', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    await get('gestor_impuestos');
    await get('admin');

    expect(runtVehiculoMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — el certificado no se almacena', () => {
  it('no sube nada a S3', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    await get('gestor_impuestos');

    expect(subirMock).not.toHaveBeenCalled();
  });

  it('no inserta NADA en la base al descargar', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    await get('gestor_impuestos');

    // Más fuerte que comprobar solo `flito_soportes`: descargar un certificado es una lectura, y
    // cualquier escritura que aparezca aquí —un soporte, una marca de descarga, lo que sea— es un
    // efecto secundario que la HU no pidió. La auditoría no cuenta: pasa por `audit()`, mockeado.
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('AC7 — auditoría de la descarga', () => {
  it('registra la descarga con el impuesto y la certificación', async () => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    await get('gestor_impuestos');

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, entrada] = auditMock.mock.calls[0];
    expect(entrada).toMatchObject({ action: 'export', resource: 'flito_impuesto', resourceId: ID });
    expect(entrada.detail).toContain('QIU744');
    expect(entrada.detail).toContain(CERTIFICACION.id);
  });

  it('un 409 no deja rastro de descarga: no hubo descarga', async () => {
    vigenteMock.mockResolvedValue(null);

    await get('gestor_impuestos');

    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('permisos', () => {
  it('sin token es 401 y no se consulta nada', async () => {
    const r = await request(await buildApp()).get(`/api/flito/impuestos/${ID}/certificado`);

    expect(r.status).toBe(401);
    expect(vigenteMock).not.toHaveBeenCalled();
  });

  it('un auditor (solo lectura) recibe 403', async () => {
    const r = await get('auditor');

    expect(r.status).toBe(403);
    expect(vigenteMock).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['admin', 'gestor_impuestos'])('%s sí puede descargar', async (role) => {
    vigenteMock.mockResolvedValue(CERTIFICACION);

    const r = await get(role);

    expect(r.status).toBe(200);
  });
});
