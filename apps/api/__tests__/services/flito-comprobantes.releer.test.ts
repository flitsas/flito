process.env.TZ = 'UTC';
// HU #12611 (Feature #12605, Épica #12245) — AC9: `POST /:id/releer` sobre un pendiente con
// `ocr_no_disponible`: descarga el soporte, reconstruye el sub-documento (con `recortarPaginas` si
// tiene `paginas`, o el archivo entero), repite `leerSubDocumento`, REESCRIBE la fila (nunca inserta)
// y responde el detalle. 503 si el OCR sigue caído, con la fila intacta (`updated_at` incluido);
// 409 `ya_resuelto` / `sin_relectura`.
//
// Router real + motor de permisos (calco de flito-comprobantes.routes.test.ts). Mutantes nombrados:
//   · AC9-M1 insertar en vez de actualizar → «nunca crea filas» (espía: cero INSERT, un UPDATE).
//   · AC9-M2 actualizar `updated_at` antes de leer → «503 y la fila no cambia» (cero UPDATE).
//   · AC9-M3 releer sin comprobar el motivo → «pendiente con otro motivo → 409 sin_relectura».
//   · AC9-M4 ignorar `paginas` → «consolidado: recorta las páginas de la fila».

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'node:stream';
import { getTableName } from 'drizzle-orm';
import { CampoComprobante, MotivoPendienteComprobante } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar, ligadoA } from '../helpers/sql-ligado.js';
import { testToken, fuenteDePrueba, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) }));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const streamMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn(), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: streamMock,
}));
const recortarMock = vi.fn();
vi.mock('../../src/shared/pdf/separar-paginas.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, recortarPaginas: recortarMock };
});
const leerMock = vi.fn();
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: vi.fn(), leerSubDocumento: leerMock }));

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { flitoComprobantes, flitoSoportes, flitoTramites } = await import('../../src/db/schema.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const T_TRAM = getTableName(flitoTramites);
/** HU #12629: la relectura también cruza; este trámite es el que la placa XYZ789 alcanza (id_flit y vin van vacíos en la lectura). */
const TRAMITE = '5a3c4c2e-0f9b-4e6e-9a1d-2c3b4a5d6e7f';
const candidato = () => ({
  tramiteId: TRAMITE, idFlit: 'FLIT-XYZ', placa: 'XYZ789', vin: null, tipoTramite: 'TRASPASO', empresa: 'Acme', flitEstado: 'Aprobado',
  soatId: null, soatEstado: null, impuestoEstado: 'solicitado', derechoId: null, liquidacionId: null,
  docTramiteDigital: false, docLogistica: false, docServiciosAdicionales: false, createdAt: new Date('2026-09-01T00:00:00Z'),
});
const BASE = '/api/flito/comprobantes';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const RUTA = `${BASE}/${ID}/releer`;
const PDF = Buffer.from('%PDF-1.4\n%consolidado-entero\n');
const RECORTE = Buffer.from('%PDF-1.4\n%solo-las-paginas-2-3\n');

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const lecturaCompleta = () => ({
  extraccion: {
    [CampoComprobante.TIPO_DOCUMENTO]: campo('recibo_impuesto', 0.95), [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('true', 0.95),
    [CampoComprobante.CONCEPTO]: campo('impuesto', 0.95), [CampoComprobante.PLACA]: campo('XYZ789', 0.9), [CampoComprobante.VIN]: campo(null, 0),
    [CampoComprobante.ID_FLIT]: campo(null, 0), [CampoComprobante.VALOR_TOTAL]: campo('120000', 0.95),
    [CampoComprobante.FECHA_PAGO]: campo('2026-09-12', 0.95), [CampoComprobante.NUMERO_DOCUMENTO]: campo('R-9', 0.95), [CampoComprobante.EMISOR]: campo('Gobernación', 0.9),
  },
  tipoDestino: 'recibo_impuesto' as const,
  extraccionDestino: { numeroRecibo: campo('R-9', 0.95) },
});

const cabecera = (over: Record<string, unknown> = {}) => ({
  id: ID, estado: 'pendiente', motivoPendiente: MotivoPendienteComprobante.OCR_NO_DISPONIBLE, soporteId: 'sop-1', paginas: null, ...over,
});
const soporte = { storageKey: 'flito/comprobantes/lote/x.pdf', nombreArchivo: 'lote.pdf', contentType: 'application/pdf' };
/** La fila del detalle tras releer, como la devolvería la consulta. */
const filaDetalle = (over: Record<string, unknown> = {}) => ({
  id: ID, loteId: '9c1d4d5e-3b7a-4c2e-9f0a-1b2c3d4e5f60', estado: 'pendiente', motivoPendiente: 'leido', detallePendiente: null,
  tipoDocumento: 'recibo_impuesto', esPago: true, concepto: 'impuesto', tramiteId: null, tramiteIdFlit: null, tramitePlaca: null, cruce: null,
  placaLeida: 'XYZ789', vinLeido: null, idFlitLeido: null, valor: '120000.00', fechaDocumento: '2026-09-12', numeroDocumento: 'R-9', emisor: 'Gobernación',
  marcadoPorDiferencia: false, diferenciaTarifa: null, diferenciaAceptadaEn: null, paginas: null, archivoNombre: 'lote.pdf', archivoContentType: 'application/pdf',
  createdAt: new Date('2026-09-15T12:00:00Z'), aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
  subidoPorNombre: 'fin@flitsas.io', aplicadoPorNombre: null, descartadoPorNombre: null, ...over,
});

const espia = crearEspia(kdb);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
  app.use(BASE, router);
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
const auth = async (role: TestRole = 'financiera') => `Bearer ${await testToken({ sub: 7, username: 'u@flitsas.io', role })}`;

/** Escenario feliz: cabecera pendiente/ocr_no_disponible → soporte → (update) → detalle (fila + lectura). */
function armar(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_COMP, [cabecera(over)])
    .selectOnce(T_SOP, [soporte])
    .selectOnce(T_COMP, [filaDetalle()])
    .selectOnce(T_COMP, [{ extraccion: lecturaCompleta().extraccion, extraccionDestino: lecturaCompleta().extraccionDestino }])
    .select(T_TRAM, [candidato()])
    .update(T_COMP, [{ id: ID }]);
}

beforeEach(() => {
  kdb.reset(); espia.reiniciar(); auditMock.mockClear();
  streamMock.mockReset(); recortarMock.mockReset(); leerMock.mockReset();
  streamMock.mockImplementation(async () => Readable.from([PDF.subarray(0, 10), PDF.subarray(10)]));
  recortarMock.mockResolvedValue(RECORTE);
  leerMock.mockResolvedValue(lecturaCompleta());
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

describe('AC9 — POST /:id/releer', () => {
  it('archivo entero (paginas null): descarga el soporte, relee, reescribe la fila (AC9-M1: un UPDATE, cero INSERT) y responde 200 ComprobanteDetalleDto', async () => {
    const app = await buildApp();
    armar();
    const res = await request(app).post(RUTA).set('Authorization', await auth());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ id: ID, motivoPendiente: 'leido', placaLeida: 'XYZ789', candidatos: [expect.objectContaining({ tramiteId: TRAMITE, idFlit: 'FLIT-XYZ' })] });
    expect(res.body.campos).toHaveLength(11); // 10 universales + destino.numeroRecibo
    expect(res.body).not.toHaveProperty('extraccion');

    expect(streamMock).toHaveBeenCalledWith('flito/comprobantes/lote/x.pdf');
    expect(recortarMock).not.toHaveBeenCalled();
    expect(leerMock).toHaveBeenCalledTimes(1);
    expect(leerMock.mock.calls[0]![0]).toEqual({ buffer: PDF, contentType: 'application/pdf', paginas: null, nombre: 'lote.pdf' });

    expect(espia.inserts).toEqual([]);
    expect(kdb.transaction).not.toHaveBeenCalled();
    const updates = espia.updatesEn(T_COMP);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.datos).toMatchObject({
      extraccion: lecturaCompleta().extraccion, extraccionDestino: { numeroRecibo: campo('R-9', 0.95) },
      motivoPendiente: MotivoPendienteComprobante.LEIDO, detallePendiente: null,
      tipoDocumento: 'recibo_impuesto', esPago: true, concepto: 'impuesto', placaLeida: 'XYZ789', valor: '120000', fechaDocumento: '2026-09-12',
      // HU #12629: la relectura cruza de nuevo y deja la sugerencia (único por placa).
      tramiteId: TRAMITE, cruce: 'placa',
    });
    expect(updates[0]!.datos.updatedAt).toBeInstanceOf(Date);
    // Sin tocar estado ni nada de la aplicación: la sugerencia no aplica.
    for (const k of ['estado', 'aplicadoEn', 'aplicadoPorId', 'soporteId', 'paginas', 'loteId']) expect(updates[0]!.datos[k]).toBeUndefined();
    const q = renderizar(updates[0]!.condiciones[0] as never);
    expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', resource: 'flito_comprobante', resourceId: ID }));
  });

  it('AC9-M4: consolidado (paginas [2,3]) → recorta esas páginas del soporte y lee el recorte con `paginas`', async () => {
    const app = await buildApp();
    armar({ paginas: [2, 3] });
    const res = await request(app).post(RUTA).set('Authorization', await auth());
    expect(res.status).toBe(200);
    expect(recortarMock).toHaveBeenCalledWith(PDF, [2, 3]);
    expect(leerMock.mock.calls[0]![0]).toEqual({ buffer: RECORTE, contentType: 'application/pdf', paginas: [2, 3], nombre: 'lote.pdf' });
  });

  it('el motivo se recalcula según AC5: relectura sin llave → sin_llave_de_cruce', async () => {
    const app = await buildApp();
    armar();
    leerMock.mockResolvedValue({ ...lecturaCompleta(), extraccion: { ...lecturaCompleta().extraccion, placa: campo(null, 0) } });
    const res = await request(app).post(RUTA).set('Authorization', await auth());
    expect(res.status).toBe(200);
    expect(espia.updatesEn(T_COMP)[0]!.datos.motivoPendiente).toBe(MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE);
  });

  it('AC9-M2: el OCR sigue caído → 503 ocr_no_disponible y la fila no cambia (cero UPDATE, cero INSERT; updated_at incluido)', async () => {
    const app = await buildApp();
    armar();
    leerMock.mockRejectedValue(new OcrNoDisponibleError(503, 'caído'));
    const res = await request(app).post(RUTA).set('Authorization', await auth());
    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe('ocr_no_disponible');
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('no pendiente (aplicado / descartado) → 409 ya_resuelto sin descargar ni leer', async () => {
    const app = await buildApp();
    for (const estado of ['aplicado', 'descartado']) {
      kdb.when.selectOnce(T_COMP, [cabecera({ estado, motivoPendiente: null })]);
      const res = await request(app).post(RUTA).set('Authorization', await auth());
      expect(res.status, estado).toBe(409);
      expect(res.body.codigo).toBe('ya_resuelto');
    }
    expect(streamMock).not.toHaveBeenCalled();
    expect(leerMock).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
  });

  it('AC9-M3: pendiente con otro motivo (leido, sin_llave_de_cruce, tipo_no_identificado) → 409 sin_relectura sin descargar ni leer', async () => {
    const app = await buildApp();
    for (const motivo of ['leido', 'sin_llave_de_cruce', 'tipo_no_identificado', 'confianza_insuficiente']) {
      kdb.when.selectOnce(T_COMP, [cabecera({ motivoPendiente: motivo })]);
      const res = await request(app).post(RUTA).set('Authorization', await auth());
      expect(res.status, motivo).toBe(409);
      expect(res.body.codigo).toBe('sin_relectura');
    }
    expect(streamMock).not.toHaveBeenCalled();
    expect(leerMock).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
  });

  it('inexistente → 404 no_encontrado; auditor → 403 del motor', async () => {
    const app = await buildApp();
    expect((await request(app).post(RUTA).set('Authorization', await auth())).status).toBe(404);
    const r403 = await request(app).post(RUTA).set('Authorization', await auth('auditor'));
    expect(r403.status).toBe(403);
    expect(r403.body.funcion).toBe('comprobantes.comprobante.releer');
  });
});
