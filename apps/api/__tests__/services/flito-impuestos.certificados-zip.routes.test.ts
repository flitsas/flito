// ZIP de certificados RUNT — frontera HTTP de POST /api/flito/impuestos/certificados/zip (HU #13205).
//
// El ZIP se lee de verdad con JSZip. El lote de certificaciones se mockea (su frontera y su SQL se
// prueban en flito-impuestos.certificacion.service.test.ts); los PDF sí se generan con pdf-lib.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import JSZip from 'jszip';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole, neutralizarEnlaceDe } from '../helpers/auth.js';

// HU #12875: este fichero mide la regla del MÓDULO con roles de fábrica que la frontera por enlace
// cierra hasta la #13426 (decisión (b) del PO); su enlace se neutraliza aquí, a la vista. El cierre lo
// prueban `frontera-por-enlace.test.ts` y `frontera-enlace.centinela.test.ts`.
neutralizarEnlaceDe('gestor_impuestos', 'transito', 'proveedor');

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** Orden de los efectos observables: PII, audit y cabeceras. */
const orden: string[] = [];

const auditMock = vi.fn(async () => { orden.push('audit'); });
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: (...a: unknown[]) => auditMock(...(a as [])) }));

const logPiiMock = vi.fn(async () => { orden.push('pii'); });
vi.mock('../../src/shared/pii-audit.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logPiiAccess: (...a: unknown[]) => logPiiMock(...(a as [])),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// El RUNT entero: que quede en cero es la prueba de AC4.
const runtVehiculoMock = vi.fn();
const runtPersonaMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (...a: unknown[]) => runtVehiculoMock(...a),
  consultarPersonaRunt: (...a: unknown[]) => runtPersonaMock(...a),
}));

const loteMock = vi.fn();
vi.mock('../../src/modules/flito-impuestos/certificacion.service.js', () => ({
  certificarImpuesto: vi.fn(),
  certificarLote: vi.fn(),
  certificacionVigente: vi.fn(),
  certificacionVigenteConAcceso: vi.fn(),
  certificacionesVigentesLoteConAcceso: (...a: unknown[]) => loteMock(...a),
  ESTADOS_IMPUESTO_CERTIFICABLES: ['solicitado'],
}));

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cert = (impuestoId: string) => ({
  id: `a2f0e6d4-0000-4000-8000-${impuestoId.slice(-12)}`,
  impuestoId,
  placaConsultada: 'QIU744',
  documentoConsultado: '43902633',
  vinConsultado: null,
  tipoDocPropietario: 'C',
  propietarioNombre: 'MARIA MUÑOZ PEÑA',
  campos: [],
  certificadoPorNombre: 'gestor@flit.io',
  createdAt: '2026-07-31T14:05:00.000Z',
  registroRunt: {
    clasificacion: 'AUTOMOVIL', color: 'GRIS', cilindraje: '1598', tipoServicio: 'Particular',
    organismoTransito: 'STRIA MEDELLIN', estadoAutomotor: 'ACTIVO', fechaMatricula: '2015-03-10',
    numMotor: 'G4FGSU123456', numChasis: '3KPFF51ABTE156687', numSerie: null,
  },
});

const item = (id: string, placa: string | null, conCert = true) => ({
  impuestoId: id, placa, idFlit: `FL-${id.slice(-3)}`, createdAt: new Date('2026-09-01T00:00:00Z'), cert: conCert ? cert(id) : null,
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    const original = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: unknown) => { orden.push(`setHeader:${name}`); return original(name, value as string); }) as typeof res.setHeader;
    next();
  });
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}

/** Un usuario distinto por petición: el limitador es de módulo y cuenta por usuario. */
let sub = 1000;
const post = async (ids: unknown, role: TestRole = 'gestor_impuestos', usuario = ++sub) =>
  request(await buildApp()).post('/api/flito/impuestos/certificados/zip')
    .set('Authorization', `Bearer ${await testToken({ sub: usuario, username: 'gestor@flit.io', role })}`)
    .responseType('blob')
    .send({ ids });

const json = (r: request.Response) => JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, unknown>;

beforeEach(() => {
  kdb.reset();
  loteMock.mockReset();
  auditMock.mockClear();
  logPiiMock.mockClear();
  runtVehiculoMock.mockReset();
  runtPersonaMock.mockReset();
  orden.length = 0;
});

describe('AC1/AC2 — ZIP con un PDF por vehículo y omitidos.csv', () => {
  it('nombra por placa con desempate, SIN-PLACA-<idFlit>, e incluye omitidos.csv y la cabecera', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123'), item(U(2), 'ABC123'), item(U(3), null), item(U(4), 'QIU744', false)]);

    const r = await post([U(1), U(2), U(3), U(4), U(9)]);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/zip');
    expect(r.headers['content-disposition']).toMatch(/certificados-runt_\d{8}-\d{4}\.zip/);
    expect(r.headers['x-certificados-omitidos']).toBe('2');
    const zip = await JSZip.loadAsync(r.body as Buffer);
    expect(Object.keys(zip.files).sort()).toEqual(['ABC123-2.pdf', 'ABC123.pdf', 'SIN-PLACA-FL-003.pdf', 'omitidos.csv']);
    expect((await zip.file('ABC123.pdf')!.async('nodebuffer')).subarray(0, 4).toString()).toBe('%PDF');
    const csv = await zip.file('omitidos.csv')!.async('string');
    expect(csv).toContain('QIU744;sin certificación vigente');
    expect(csv).toContain(`${U(9)};no disponible`);
  });

  it('sin omitidos no hay CSV y la cabecera dice 0', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123')]);

    const r = await post([U(1)]);

    expect(r.status).toBe(200);
    expect(r.headers['x-certificados-omitidos']).toBe('0');
    const zip = await JSZip.loadAsync(r.body as Buffer);
    expect(Object.keys(zip.files)).toEqual(['ABC123.pdf']);
  });
});

describe('AC3 — todos omitidos', () => {
  it('409 en JSON con codigo y la lista, sin ZIP', async () => {
    loteMock.mockResolvedValue([item(U(1), 'QIU744', false)]);

    const r = await post([U(1), U(2)]);

    expect(r.status).toBe(409);
    expect(r.headers['content-type']).not.toContain('application/zip');
    const cuerpo = json(r);
    expect(cuerpo.codigo).toBe('zip_sin_certificados');
    expect(cuerpo.omitidos).toEqual([
      { identificador: 'QIU744', causa: 'sin_certificacion_vigente' },
      { identificador: U(2), causa: 'no_disponible' },
    ]);
    expect(auditMock).not.toHaveBeenCalled();
    expect(logPiiMock).toHaveBeenCalledTimes(1);
    expect((logPiiMock.mock.calls[0] as unknown[])[1]).toMatchObject({ camposAccedidos: ['placa'] });
    expect(String(((logPiiMock.mock.calls[0] as unknown[])[1] as { motivo: string }).motivo)).toContain('resultado=todos_omitidos');
  });
});

describe('AC4 — sin RUNT y sin guardar nada', () => {
  it('no consulta el RUNT ni inserta ni actualiza en la base', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123')]);

    const r = await post([U(1)]);

    expect(r.status).toBe(200);
    expect(runtVehiculoMock).not.toHaveBeenCalled();
    expect(runtPersonaMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('AC5 — tope de registros', () => {
  it('301 ids → 400 con el tope en el mensaje, sin contexto ni lote', async () => {
    const { getTableName } = await import('drizzle-orm');
    const { flitoGestorOrganismos } = await import('../../src/db/schema.js');
    // `contextoImpuesto` de un gestor lee sus organismos: ese SELECT es la primera consulta de la ruta.
    kdb.when.select(getTableName(flitoGestorOrganismos), () => { orden.push('ctx'); return []; });
    const ids = Array.from({ length: 301 }, (_, i) => U(i + 1));

    const r = await post(ids, 'gestor_impuestos');

    expect(r.status).toBe(400);
    expect(json(r).codigo).toBe('zip_demasiados_registros');
    expect(String(json(r).error)).toContain('300');
    expect(loteMock).not.toHaveBeenCalled();
    expect(orden).not.toContain('ctx');

    // Control positivo: con 300 ids el mismo gestor SÍ pasa por el contexto.
    loteMock.mockResolvedValue([]);
    await post(ids.slice(0, 300), 'gestor_impuestos');
    expect(orden).toContain('ctx');
  });
});

describe('AC6 — límite de frecuencia', () => {
  it('la 6.ª petición del mismo usuario en el minuto es 429', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123')]);
    const usuario = 777;
    for (let i = 0; i < 5; i++) expect((await post([U(1)], 'gestor_impuestos', usuario)).status).toBe(200);

    const r = await post([U(1)], 'gestor_impuestos', usuario);

    expect(r.status).toBe(429);
  });
});

describe('AC7 — sin permiso', () => {
  it('un auditor (sin impuestos.certificado.descargar) recibe 403 y no se registra nada', async () => {
    const r = await post([U(1)], 'auditor');

    expect(r.status).toBe(403);
    expect(loteMock).not.toHaveBeenCalled();
    expect(logPiiMock).not.toHaveBeenCalled();
  });
});

describe('AC8 — auditoría PII antes del primer byte', () => {
  it('registra PII con archivo zip_certificados_runt y filas = incluidos, antes de audit y de cualquier cabecera', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123'), item(U(2), 'QIU744'), item(U(3), 'XYZ999', false)]);

    const r = await post([U(1), U(2), U(3), U(4)]);

    expect(r.status).toBe(200);
    expect(logPiiMock).toHaveBeenCalledTimes(1);
    const acceso = (logPiiMock.mock.calls[0] as unknown[])[1] as { accion: string; camposAccedidos: string[]; motivo: string };
    expect(acceso.accion).toBe('export');
    const { CAMPOS_PII_ZIP_CERTIFICADOS } = await import('../../src/modules/flito-impuestos/flito-impuestos.pii.js');
    expect(acceso.camposAccedidos).toEqual([...CAMPOS_PII_ZIP_CERTIFICADOS]);
    expect(acceso.camposAccedidos).toContain('num_motor');
    expect(acceso.motivo).toContain('archivo=zip_certificados_runt');
    expect(acceso.motivo).toContain('filas=2');
    const primeraCabecera = orden.findIndex((o) => o.startsWith('setHeader:Content-Type') || o.startsWith('setHeader:content-type'));
    expect(orden.indexOf('pii')).toBeGreaterThanOrEqual(0);
    expect(orden.indexOf('pii')).toBeLessThan(orden.indexOf('audit'));
    expect(orden.indexOf('audit')).toBeLessThan(primeraCabecera);
  });

  it('audit_logs lleva los conteos y ninguna placa ni id', async () => {
    loteMock.mockResolvedValue([item(U(1), 'ABC123'), item(U(3), 'XYZ999', false)]);

    await post([U(1), U(3), U(4)]);

    const detalle = String(((auditMock.mock.calls[0] as unknown[])[1] as { detail: string }).detail);
    expect(detalle).toContain('1 incluido(s), 2 omitido(s)');
    expect(detalle).toContain('sin certificación vigente: 1, no disponible: 1');
    for (const secreto of ['ABC123', 'XYZ999', U(1), U(4), 'FL-']) expect(detalle).not.toContain(secreto);
  });
});
