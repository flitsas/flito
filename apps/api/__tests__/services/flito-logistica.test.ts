// FLITO Logística (Fase 1). Verifica las reglas de negocio del dominio por documento: alta desde FLIT
// con RN-05 (autogestión), recogida + clasificación automática (CA-02/03), cierre de lote parcial vs
// completo (CA-08/09), novedad con motivo obligatorio (RN-04) y las fronteras de rol de las rutas.
// Las funciones transaccionales corren sobre un `tx` mockeado que reutiliza los mismos mocks que `db`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { EstadoDocumentoLogistica, TipoDocumentoLogistica } from '@operaciones/shared-types';

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

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const ctx = { userId: 1, username: 'op', role: 'admin' };
const txObj = { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock };

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset().mockReturnValue(chain([]));
  updateMock.mockReset().mockReturnValue(chain([]));
  deleteMock.mockReset().mockReturnValue(chain([]));
  transactionMock.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txObj));
});

// ───────────────────────── registrarDocumentosDesdeFlit — RN-05 + idempotencia ─────

describe('registrarDocumentosDesdeFlit — alta desde FLIT', () => {
  it('RN-05: si la compañía autogestiona logística, no crea nada', async () => {
    const n = await svc.registrarDocumentosDesdeFlit(txObj as never, {
      tramiteId: 't1', organismoCodigo: '05001', companiaId: 5, companiaNit: '900', vehiculoId: 9,
      logisticaAutogestionable: true,
      documentos: [{ tipo: TipoDocumentoLogistica.LICENCIA_TRANSITO }, { tipo: TipoDocumentoLogistica.PLACA }],
    });
    expect(n).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('crea los documentos nuevos y cuenta solo los insertados (idempotente por conflicto)', async () => {
    // doc1 se inserta (returning [{id}]), su evento; doc2 choca (onConflictDoNothing → returning []).
    insertMock
      .mockReturnValueOnce(chain([{ id: 'd1' }])) // doc1
      .mockReturnValueOnce(chain([]))             // evento doc1
      .mockReturnValueOnce(chain([]));            // doc2 (conflicto, sin returning)
    const n = await svc.registrarDocumentosDesdeFlit(txObj as never, {
      tramiteId: 't1', organismoCodigo: '05001', companiaId: 5, companiaNit: '900', vehiculoId: 9,
      logisticaAutogestionable: false,
      documentos: [{ tipo: TipoDocumentoLogistica.LICENCIA_TRANSITO }, { tipo: TipoDocumentoLogistica.PLACA }],
    });
    expect(n).toBe(1);
  });
});

// ───────────────────────── recoger — CA-02 + clasificación automática CA-03 ─────

describe('recoger — verifica y clasifica automáticamente', () => {
  it('generado → recogido → clasificado asignando la empresa del trámite', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ id: 'd1', estado: EstadoDocumentoLogistica.GENERADO, tramiteId: 't1' }])) // cargarDocumentos
      .mockReturnValueOnce(chain([{ companiaId: 5, companiaNit: '900' }]));                                    // trámite (empresa destino)
    const r = await svc.recoger(['d1'], {}, ctx);
    expect(r).toMatchObject({ recogidos: 1, clasificados: 1, omitidos: 0 });
  });

  it('omite los que no están en generado (no re-transiciona)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'd1', estado: EstadoDocumentoLogistica.ENTREGADO, tramiteId: 't1' }]));
    const r = await svc.recoger(['d1'], {}, ctx);
    expect(r).toMatchObject({ recogidos: 0, clasificados: 0, omitidos: 1 });
  });
});

// ───────────────────────── novedad — motivo obligatorio (RN-04) ─────

describe('registrarNovedad — motivo obligatorio', () => {
  it('rechaza sin motivo', async () => {
    await expect(svc.registrarNovedad('d1', '  ', ctx)).rejects.toThrow(/motivo/i);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('con motivo, pasa el documento a novedad', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'd1', estado: EstadoDocumentoLogistica.GENERADO, tramiteId: 't1' }]));
    await svc.registrarNovedad('d1', 'Faltante en el organismo', ctx);
    expect(updateMock).toHaveBeenCalled(); // set estado=novedad
    expect(insertMock).toHaveBeenCalled(); // evento
  });
});

// ───────────────────────── cerrarLote — parcial vs completo (CA-08/09) ─────

describe('cerrarLote — respeta la parametrización de entregas parciales', () => {
  const compania = (permiteParcial: boolean) => ({
    id: 5, nombre: 'ACME', permiteParcial, direccion: 'Calle 1', contactoNombre: 'ACME', contactoDoc: '900',
  });
  const docs = [
    { id: 'd1', estado: EstadoDocumentoLogistica.CLASIFICADO },
    { id: 'd2', estado: EstadoDocumentoLogistica.NOVEDAD },
  ];

  it('CA-09: "Solo completo" con pendientes → 409 e informa faltantes', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(false)])) // compañía
      .mockReturnValueOnce(chain(docs));             // documentos de la empresa
    await expect(svc.cerrarLote(5, ctx)).rejects.toMatchObject({ status: 409 });
    expect(insertMock).not.toHaveBeenCalled(); // no se generó acta
  });

  it('CA-08: "Permite parcial" genera el acta con los clasificados y deja el resto', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(true)]))
      .mockReturnValueOnce(chain(docs))
      .mockReturnValueOnce(chain([{ id: 'prov1' }])); // proveedor logístico por defecto
    insertMock.mockReturnValueOnce(chain([{ id: 'acta1' }])); // acta
    const r = await svc.cerrarLote(5, ctx);
    expect(r).toMatchObject({ actaId: 'acta1', documentos: 1 }); // solo el clasificado
  });

  it('sin documentos clasificados → error (nada que cerrar)', async () => {
    selectMock
      .mockReturnValueOnce(chain([compania(true)]))
      .mockReturnValueOnce(chain([{ id: 'd2', estado: EstadoDocumentoLogistica.NOVEDAD }]));
    await expect(svc.cerrarLote(5, ctx)).rejects.toThrow(/clasificados/i);
  });
});

// ───────────────────────── actaDetalle — documentos + bitácora (CA-13) ─────

describe('actaDetalle — arma cabecera, documentos y bitácora', () => {
  it('devuelve la cabecera del acta con sus documentos y eventos', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ // cabecera
        id: 'acta1', companiaId: 5, companiaNombre: 'ACME', estado: 'despachada', mensajeroId: 9, mensajeroNombre: 'Msj',
        receptorNombre: null, entregadoEn: null, creadoEn: new Date('2026-07-21T08:00:00Z'), pdfStorageKey: 'k/acta.pdf',
      }]))
      .mockReturnValueOnce(chain([{ id: 'd1', tipo: 'placa', estado: 'despachado', placa: 'ABC123', vin: 'V1', idFlit: 'F1' }])) // documentos
      .mockReturnValueOnce(chain([{ id: 'e1', documentoId: 'd1', placa: 'ABC123', estadoAnterior: 'en_acta', estadoNuevo: 'despachado', actorNombre: 'Op', motivo: null, origen: 'usuario', creadoEn: new Date('2026-07-21T09:00:00Z') }])); // eventos
    const r = await svc.actaDetalle('acta1');
    expect(r.acta).toMatchObject({ id: 'acta1', estado: 'despachada', documentos: 1 });
    expect(r.tienePdf).toBe(true);
    expect(r.documentos[0]).toMatchObject({ tipoLabel: 'Placa', placa: 'ABC123' });
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
    selectMock.mockReturnValue(chain([])); // count + rows + actas
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).get('/api/flito/logistica').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('auditor NO puede recoger (403: no es rol de campo)', async () => {
    const token = await testToken({ role: 'auditor' });
    const res = await request(app).post('/api/flito/logistica/recoger')
      .set('Authorization', `Bearer ${token}`).send({ documentoIds: [UUID] });
    expect(res.status).toBe(403);
  });

  it('mensajero SÍ puede recoger (rol de campo)', async () => {
    selectMock.mockReturnValue(chain([])); // recoger sobre lista vacía
    const token = await testToken({ role: 'mensajero' });
    const res = await request(app).post('/api/flito/logistica/recoger')
      .set('Authorization', `Bearer ${token}`).send({ documentoIds: [UUID] });
    expect(res.status).toBe(200);
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

  it('novedad sin motivo → 400', async () => {
    const token = await testToken({ role: 'admin' });
    const res = await request(app).post(`/api/flito/logistica/documentos/${UUID}/novedad`)
      .set('Authorization', `Bearer ${token}`).send({ motivo: '' });
    expect(res.status).toBe(400);
  });
});
