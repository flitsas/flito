// FLITO Logística. Verifica el dominio del modelo v2: la LT nace del ESCANEO del PDF417 (match
// placa+VIN contra un trámite aprobado → recogida/novedad/sin_match), novedad con motivo (RN-04),
// cierre de lote parcial vs completo (CA-08/09), firma del receptor obligatoria (RN-03) y las
// fronteras de rol de las rutas. Las funciones transaccionales corren sobre un `tx` mockeado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { EstadoDocumentoLogistica } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/key'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const ctx = { userId: 1, username: 'op', role: 'admin' };
const txObj = { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock };

// PDF417 de ejemplo (rawValue real de BarcodeDetector): licencia, C.C., propietario, dirección,
// foto JPEG (/9j/…), placa QOX858, VIN, chasis, motor, combustible.
const RAW = '10038156339 C.C. 1053786950 MUÑOZ GOMEZ EMMANUEL DAVID CLL 112 N 47A 08 MANIZALES 7 /9j/4AAQSkZJRgABAQEA QOX858 LRWYGCFJ0TC496126 LRWYGCFJ0TC496126 352026000097934 ELECTRICO';

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset().mockReturnValue(chain([]));
  updateMock.mockReset().mockReturnValue(chain([]));
  deleteMock.mockReset().mockReturnValue(chain([]));
  transactionMock.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txObj));
});

// ───────────────────────── escanearLt — match placa+VIN (CA-02/CA-03) ─────

describe('escanearLt — recogida por escaneo del PDF417', () => {
  const tramite = (over: Record<string, unknown> = {}) => ({
    tramiteId: 't1', idFlit: 'F1', organismoCodigo: '05001', companiaId: 5, companiaNit: '900',
    vehiculoId: 9, vin: 'LRWYGCFJ0TC496126', autogestionable: false, ...over,
  });

  it('sin trámite aprobado con esa placa → sin_match, no persiste', async () => {
    selectMock.mockReturnValueOnce(chain([])); // búsqueda del trámite: vacío
    const r = await svc.escanearLt(RAW, 'LT-001', {}, ctx);
    expect(r.resultado).toBe('sin_match');
    expect(r.placa).toBe('QOX858');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('placa+VIN coinciden → recogida + clasificación automática (CA-03)', async () => {
    selectMock.mockReturnValueOnce(chain([tramite()]));
    insertMock.mockReturnValueOnce(chain([{ id: 'd1' }])); // insert de la LT (creado)
    const r = await svc.escanearLt(RAW, 'LT-001', {}, ctx);
    expect(r.resultado).toBe('recogido');
    expect(r).toMatchObject({ placa: 'QOX858', vin: 'LRWYGCFJ0TC496126', idFlit: 'F1', numeroLicencia: '10038156339' });
    expect(updateMock).toHaveBeenCalled(); // transición a clasificado
  });

  it('placa coincide pero el VIN no → novedad con motivo (RN-04)', async () => {
    selectMock.mockReturnValueOnce(chain([tramite({ vin: 'LRWYGCFJ0TC499999' })]));
    insertMock.mockReturnValueOnce(chain([{ id: 'd1' }]));
    const r = await svc.escanearLt(RAW, null, {}, ctx);
    expect(r.resultado).toBe('novedad');
    expect(r.motivo).toMatch(/VIN/i);
  });

  it('código ilegible → error de negocio', async () => {
    await expect(svc.escanearLt('texto que no es una LT', null, {}, ctx)).rejects.toThrow(/no se pudo leer/i);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('parametrización por compañía (RN-05): compañía autogestionada → no_gestionable, no persiste', async () => {
    selectMock.mockReturnValueOnce(chain([tramite({ autogestionable: true })]));
    const r = await svc.escanearLt(RAW, 'LT-001', {}, ctx);
    expect(r.resultado).toBe('no_gestionable');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────── novedad — motivo obligatorio (RN-04) ─────

describe('registrarNovedad — motivo obligatorio', () => {
  it('rechaza sin motivo', async () => {
    await expect(svc.registrarNovedad('d1', '  ', ctx)).rejects.toThrow(/motivo/i);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('con motivo, pasa la LT a novedad', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'd1', estado: EstadoDocumentoLogistica.CLASIFICADO }]));
    await svc.registrarNovedad('d1', 'Licencia dañada', ctx);
    expect(updateMock).toHaveBeenCalled(); // set estado=novedad
    expect(insertMock).toHaveBeenCalled(); // evento
  });
});

// ───────────────────────── cerrarLote — parcial vs completo (CA-08/09) ─────

describe('cerrarLote — respeta la parametrización de entregas parciales', () => {
  const compania = (permiteParcial: boolean) => ({
    id: 5, nombre: 'ACME', permiteParcial, autogestionable: false, direccion: 'Calle 1', contactoNombre: 'ACME', contactoDoc: '900',
  });
  const docs = [
    { id: 'd1', estado: EstadoDocumentoLogistica.CLASIFICADO },
    { id: 'd2', estado: EstadoDocumentoLogistica.NOVEDAD },
  ];

  it('CA-09: "Solo completo" con pendientes → 409 e informa faltantes', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(false)]))
      .mockReturnValueOnce(chain(docs));
    await expect(svc.cerrarLote(5, ctx)).rejects.toMatchObject({ status: 409 });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('CA-08: "Permite parcial" genera el acta con las clasificadas y deja el resto', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(true)]))
      .mockReturnValueOnce(chain(docs))
      .mockReturnValueOnce(chain([{ id: 'prov1' }])); // proveedor logístico por defecto
    insertMock.mockReturnValueOnce(chain([{ id: 'acta1' }]));
    const r = await svc.cerrarLote(5, ctx);
    expect(r).toMatchObject({ actaId: 'acta1', documentos: 1 });
  });

  it('RN-05: compañía autogestionada → 409 (FLITO no gestiona su logística)', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...compania(true), autogestionable: true }]));
    await expect(svc.cerrarLote(5, ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('sin LT clasificadas → error (nada que cerrar)', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(true)]))
      .mockReturnValueOnce(chain([{ id: 'd2', estado: EstadoDocumentoLogistica.NOVEDAD }]));
    await expect(svc.cerrarLote(5, ctx)).rejects.toThrow(/clasificad/i);
  });
});

// ───────────────────────── despachar — firma de Operaciones (entrega) ─────

describe('despachar — RN-03 (firma de quien entrega)', () => {
  it('rechaza el despacho sin la firma de Operaciones', async () => {
    await expect(svc.despachar('acta1', { mensajeroId: 9, firmaEntrega: '' }, ctx)).rejects.toThrow(/firma/i);
  });
});

// ───────────────────────── entregar — firma del receptor (RN-03) ─────

describe('entregar — RN-03', () => {
  it('rechaza la entrega sin firma del receptor', async () => {
    await expect(svc.entregar('acta1', { receptorNombre: 'Ana', receptorDocumento: '123' }, ctx)).rejects.toThrow(/firma/i);
  });
  it('rechaza la entrega sin datos del receptor', async () => {
    await expect(svc.entregar('acta1', { receptorNombre: '', receptorDocumento: '', firma: 'x' }, ctx)).rejects.toThrow(/receptor/i);
  });
});

// ───────────────────────── actaDetalle — filas del acta + bitácora (CA-13) ─────

describe('actaDetalle — arma cabecera, filas y bitácora', () => {
  it('devuelve la cabecera del acta con sus licencias y eventos', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ // cabecera
        id: 'acta1', companiaId: 5, companiaNombre: 'ACME', estado: 'despachada', mensajeroId: 9, mensajeroNombre: 'Msj',
        receptorNombre: null, entregadoEn: null, creadoEn: new Date('2026-07-21T08:00:00Z'), pdfStorageKey: 'k/acta.pdf',
        firmaEntregaKey: 'k/entrega.png', entregaNombre: 'Operaciones FLIT', firmaRecibeKey: null,
      }]))
      .mockReturnValueOnce(chain([{ id: 'd1', estado: 'despachado', placa: 'QOX858', secretaria: 'STT', propietario: 'EMMANUEL', numeroLicencia: '100', numeroLt: 'LT-1', idFlit: 'F1' }]))
      .mockReturnValueOnce(chain([{ id: 'e1', documentoId: 'd1', placa: 'QOX858', estadoAnterior: 'en_acta', estadoNuevo: 'despachado', actorNombre: 'Op', motivo: null, origen: 'usuario', creadoEn: new Date('2026-07-21T09:00:00Z') }]));
    const r = await svc.actaDetalle('acta1');
    expect(r.acta).toMatchObject({ id: 'acta1', estado: 'despachada', documentos: 1 });
    expect(r.tienePdf).toBe(true);
    expect(r.firmaEntrega).toBe(true);
    expect(r.firmaRecibe).toBe(false);
    expect(r.documentos[0]).toMatchObject({ placa: 'QOX858', numeroLt: 'LT-1', secretaria: 'STT' });
    expect(r.bitacora[0]).toMatchObject({ estadoNuevo: 'despachado', actorNombre: 'Op' });
  });

  it('acta inexistente → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(svc.actaDetalle('nope')).rejects.toMatchObject({ status: 404 });
  });
});

// ───────────────────────── rutas — fronteras de rol ─────

describe('rutas — lectura admin/auditor; campo admin/mensajero; operaciones solo admin', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/flito/logistica', logisticaRoutes);
  const UUID = '00000000-0000-0000-0000-000000000001';

  it('auditor lee el listado (200)', async () => {
    selectMock.mockReturnValue(chain([]));
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).get('/api/flito/logistica').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('auditor NO puede escanear (403: no es rol de campo)', async () => {
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).post('/api/flito/logistica/escanear')
      .set('Authorization', `Bearer ${token}`).send({ rawValue: RAW });
    expect(res.status).toBe(403);
  });

  it('mensajero SÍ puede escanear (rol de campo)', async () => {
    selectMock.mockReturnValue(chain([])); // búsqueda de trámite vacía → sin_match
    const token = await testToken({ role: 'mensajero' });
    const res = await request(app).post('/api/flito/logistica/escanear')
      .set('Authorization', `Bearer ${token}`).send({ rawValue: RAW });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resultado: 'sin_match' });
  });

  it('mensajero NO puede cerrar lote (solo Operaciones) → 403', async () => {
    const token = await testToken({ role: 'mensajero' });
    const res = await request(app).post('/api/flito/logistica/cerrar-lote')
      .set('Authorization', `Bearer ${token}`).send({ companiaId: 5 });
    expect(res.status).toBe(403);
  });

  it('admin con body inválido en cerrar-lote → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post('/api/flito/logistica/cerrar-lote')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('despachar sin firma de entrega → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post(`/api/flito/logistica/actas/${UUID}/despachar`)
      .set('Authorization', `Bearer ${token}`).send({ mensajeroId: 9 });
    expect(res.status).toBe(400);
  });

  it('novedad sin motivo → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post(`/api/flito/logistica/documentos/${UUID}/novedad`)
      .set('Authorization', `Bearer ${token}`).send({ motivo: '' });
    expect(res.status).toBe(400);
  });

  it('mensajero ve su ruta (GET /mi-ruta → 200)', async () => {
    selectMock.mockReturnValue(chain([])); // actas vacías
    const token = await testToken({ role: 'mensajero' });
    const res = await request(app).get('/api/flito/logistica/mi-ruta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entregas: [] });
  });

  it('auditor NO accede a la ruta del mensajero (403: no es rol de campo)', async () => {
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).get('/api/flito/logistica/mi-ruta').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('idempotencia (RN-06): un reenvío con la misma clave devuelve la respuesta guardada sin re-ejecutar', async () => {
    selectMock.mockReturnValueOnce(chain([{ status: 200, response: { resultado: 'recogido', placa: 'QOX858' } }]));
    const token = await testToken({ role: 'mensajero' });
    const res = await request(app).post('/api/flito/logistica/escanear')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'k-repetida')
      .send({ rawValue: RAW });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resultado: 'recogido', placa: 'QOX858' });
  });
});
