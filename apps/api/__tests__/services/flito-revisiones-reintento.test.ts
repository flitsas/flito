// Bug #14569 (punto 9) — Reintentar la lectura OCR desde la cola de revisión:
// `POST /api/flito/revisiones/:id/reintentar-lectura`.
//
// Doble de drizzle que responde por tabla y CAPTURA cada `update(...).set(...)`; el OCR, el
// almacenamiento y el audit son dobles. Las aserciones son sobre lo que se escribiría en
// `flito_revisiones` (extracción, confianza, placa, motivo) y sobre lo que NO se toca (resolver,
// otras tablas), no sobre las filas que el propio test devuelve.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

interface Update { tabla: string; set: Record<string, unknown> }

const h = vi.hoisted(() => ({
  updates: [] as Update[],
  selects: [] as string[],
  revision: null as Record<string, unknown> | null,
  soat: [] as unknown[],
  actualizadas: 1,
}));

vi.mock('../../src/db/client.js', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = () => {
    let tabla = '';
    const t: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) t[m] = () => t;
    t.from = (tb: Parameters<typeof getTableName>[0]) => { tabla = getTableName(tb); h.selects.push(tabla); return t; };
    t.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(() => {
      if (tabla === 'flito_revisiones') return h.revision ? [h.revision] : [];
      if (tabla === 'flito_soat') return h.soat;
      return [];
    }).then(res, rej);
    return t;
  };
  const update = (tb: Parameters<typeof getTableName>[0]) => {
    const u: Update = { tabla: getTableName(tb), set: {} };
    const t: Record<string, unknown> = {};
    t.set = (s: Record<string, unknown>) => { u.set = s; h.updates.push(u); return t; };
    t.where = () => t;
    t.returning = () => Promise.resolve(Array.from({ length: h.actualizadas }, () => ({ id: 'x' })));
    return t;
  };
  const db = { select, update, insert: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() };
  return { db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', async () => {
  const { Readable } = await import('node:stream');
  return {
    presignedGetEntityDocument: vi.fn(),
    getEntityDocumentStream: vi.fn(async () => Readable.from([Buffer.from('%PDF-1.4 soporte')])),
  };
});
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => ({
  ...(await orig<typeof import('../../src/modules/flito-ocr/flito-ocr.service.js')>()),
  extraerFacturaSoat: vi.fn(), extraerReciboImpuesto: vi.fn(), extraerReciboCaja: vi.fn(),
  extraerFacturaVenta: vi.fn(), extraerDerechoTramite: vi.fn(),
}));
vi.mock('../../src/modules/flito-revisiones/flito-revisiones.service.js', async (orig) => ({
  ...(await orig<typeof import('../../src/modules/flito-revisiones/flito-revisiones.service.js')>()),
  obtenerItem: vi.fn(async (id: string) => ({ id, resuelto: false, registroActual: null })),
  resolver: vi.fn(),
}));

const ocr = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const servicio = await import('../../src/modules/flito-revisiones/flito-revisiones.service.js');
const storage = await import('../../src/services/storage.js');
const { audit } = await import('../../src/shared/middleware/audit.js');
const { default: revisionesRoutes } = await import('../../src/modules/flito-revisiones/flito-revisiones.routes.js');

const app = express();
app.use(express.json());
app.use('/api/flito/revisiones', revisionesRoutes);

const REV = '00000000-0000-0000-0000-0000000000a1';
const SOAT = '00000000-0000-0000-0000-0000000000b2';
const URL = `/api/flito/revisiones/${REV}/reintentar-lectura`;

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });

// Cada prueba usa un `sub` propio para no gastar el contador del limitador (10 / 15 min por usuario).
let sub = 9200;
const tokenAdmin = () => testToken({ sub: ++sub, role: 'admin' });
const post = async (body: unknown = {}, token?: string) =>
  request(app).post(URL).set('Authorization', `Bearer ${token ?? await tokenAdmin()}`).send(body as object);

function revision(modulo: string, extra: Record<string, unknown> = {}): void {
  h.revision = {
    modulo, resuelto: false, registroId: SOAT, placaSugerida: 'OLD123',
    storageKey: 'compania/soat/facturas/x.pdf', nombreArchivo: 'factura.pdf', contentType: 'application/pdf',
    tipo: modulo === 'soat' ? 'factura_soat' : 'recibo_impuesto', ...extra,
  };
}

beforeEach(() => {
  h.updates.length = 0;
  h.selects.length = 0;
  h.revision = null;
  h.soat = [];
  h.actualizadas = 1;
  vi.mocked(audit).mockClear();
  vi.mocked(servicio.resolver).mockClear();
  for (const f of ['extraerFacturaSoat', 'extraerReciboImpuesto', 'extraerReciboCaja', 'extraerFacturaVenta', 'extraerDerechoTramite'] as const) {
    vi.mocked(ocr[f]).mockReset();
  }
});

describe('fronteras', () => {
  it('sin token → 401', async () => {
    const r = await request(app).post(URL).send({});
    expect(r.status).toBe(401);
  });

  it('auditor (sin revisiones.revision.resolver) → 403, sin leer ni escribir', async () => {
    revision('soat');
    const r = await post({}, await testToken({ sub: 9190, role: 'auditor' }));
    expect(r.status).toBe(403);
    expect(h.selects).toEqual([]);
    expect(ocr.extraerFacturaSoat).not.toHaveBeenCalled();
  });

  it(':id sin forma de uuid → 404 sin consultar', async () => {
    const r = await request(app).post('/api/flito/revisiones/no-es-uuid/reintentar-lectura')
      .set('Authorization', `Bearer ${await tokenAdmin()}`).send({});
    expect(r.status).toBe(404);
    expect(h.selects).toEqual([]);
  });

  it('revisión inexistente → 404', async () => {
    const r = await post();
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('La revisión no existe');
  });

  it('revisión resuelta → 409 y el OCR no se llama', async () => {
    revision('soat', { resuelto: true });
    const r = await post();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('La revisión ya está resuelta');
    expect(ocr.extraerFacturaSoat).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('body con claves → 400 (.strict de {})', async () => {
    revision('soat');
    const r = await post({ campos: { placa: 'X' } });
    expect(r.status).toBe(400);
    expect(h.updates).toEqual([]);
  });
});

describe('200: reemplaza la extracción y la revisión sigue abierta', () => {
  it('SOAT: extractor de factura SOAT con el umbral del proveedor; actualiza extracción, confianza y placa; no resuelve', async () => {
    revision('soat');
    h.soat = [{ vin: 'VIN00000000000001', placa: 'ABC123', umbralOcr: '0.70' }];
    vi.mocked(ocr.extraerFacturaSoat).mockResolvedValue({
      placa: campo('ABC123', 0.95), vin: campo('VIN00000000000001', 0.95), numeroPoliza: campo(null, 0),
    } as never);

    const r = await post();

    expect(r.status).toBe(200);
    expect(r.body.sinLectura).toBe(false);
    expect(r.body.camposLeidos).toBe(2);
    expect(r.body.revision).toMatchObject({ id: REV, resuelto: false });
    expect(vi.mocked(ocr.extraerFacturaSoat).mock.calls[0][0]).toMatchObject({ umbral: 0.7, nombreArchivo: 'factura.pdf' });
    expect(vi.mocked(ocr.extraerFacturaSoat).mock.calls[0][0].contenido.toString()).toBe('%PDF-1.4 soporte');
    expect(ocr.extraerReciboImpuesto).not.toHaveBeenCalled();

    expect(h.updates).toHaveLength(1);
    const [u] = h.updates;
    expect(u.tabla).toBe('flito_revisiones');
    expect(u.set.extraccion).toMatchObject({ placa: { valor: 'ABC123', confianza: 0.95 } });
    expect(u.set.placaSugerida).toBe('ABC123');
    // Sigue abierta: nada de resuelto/resueltoPor en el set, y la vía de resolver no se toca.
    expect(u.set).not.toHaveProperty('resuelto');
    expect(u.set).not.toHaveProperty('resueltoPorId');
    expect(servicio.resolver).not.toHaveBeenCalled();
    // Faltan campos requeridos (póliza, valor) → el veredicto sigue sin aprobar y el motivo se recalcula.
    expect(u.set.motivo).toBe('confianza_insuficiente');
  });

  it('Impuestos (recibo de pago): extractor de recibo de impuesto, no el de SOAT; placa sugerida intacta', async () => {
    revision('impuestos');
    vi.mocked(ocr.extraerReciboImpuesto).mockResolvedValue({ placa: campo('ABC123', 0.95), valorTotal: campo('150000', 0.6) } as never);

    const r = await post();

    expect(r.status).toBe(200);
    expect(ocr.extraerReciboImpuesto).toHaveBeenCalledTimes(1);
    expect(ocr.extraerReciboCaja).not.toHaveBeenCalled();
    expect(ocr.extraerFacturaSoat).not.toHaveBeenCalled();
    const [u] = h.updates;
    expect(u.set.extraccion).toMatchObject({ valorTotal: { valor: '150000', confianza: 0.6 } });
    expect(u.set.placaSugerida).toBe('OLD123');
    expect(u.set.motivo).toBe('confianza_insuficiente');
    expect(u.set.detalle).toContain('valorTotal');
  });

  it('Impuestos (recibo de caja): extractor de recibo de caja', async () => {
    revision('impuestos', { tipo: 'recibo_caja_impuesto' });
    vi.mocked(ocr.extraerReciboCaja).mockResolvedValue({ valorTotal: campo('90000', 0.95) } as never);

    const r = await post();

    expect(r.status).toBe(200);
    expect(ocr.extraerReciboCaja).toHaveBeenCalledTimes(1);
    expect(ocr.extraerReciboImpuesto).not.toHaveBeenCalled();
    // Ahora aprueba, pero la revisión sigue abierta y conserva su motivo original.
    expect(h.updates[0].set).not.toHaveProperty('motivo');
    expect(h.updates[0].set).not.toHaveProperty('resuelto');
  });

  it('Factura de venta: solo persiste los campos de esta cola, nunca los del comprador', async () => {
    revision('factura_venta');
    vi.mocked(ocr.extraerFacturaVenta).mockResolvedValue({
      placa: campo('ABC123', 0.95), vin: campo('VIN1', 0.95), numeroDocumento: campo('1234567890', 0.95), nombres: campo('ANA', 0.95),
    } as never);

    const r = await post();

    expect(r.status).toBe(200);
    const ext = h.updates[0].set.extraccion as Record<string, unknown>;
    expect(Object.keys(ext).sort()).toEqual(['placa', 'vin']);
  });

  it('audit sin valores leídos en el detalle', async () => {
    revision('soat');
    h.soat = [{ vin: 'VIN00000000000001', placa: 'ABC123', umbralOcr: null }];
    vi.mocked(ocr.extraerFacturaSoat).mockResolvedValue({ placa: campo('ABC123', 0.95), vin: campo('VIN00000000000001', 0.95) } as never);

    await post();

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0][1] as { action: string; resource: string; resourceId: string; detail: string };
    expect(entrada).toMatchObject({ action: 'update', resource: 'flito_revision', resourceId: REV });
    expect(entrada.detail).toBe('Reintento de lectura OCR (soat): 2 campos leídos');
    expect(entrada.detail).not.toContain('ABC123');
    expect(entrada.detail).not.toContain('VIN0000');
  });

  it('la resolvieron mientras el OCR leía (update sin filas) → 409', async () => {
    revision('impuestos');
    h.actualizadas = 0;
    vi.mocked(ocr.extraerReciboImpuesto).mockResolvedValue({ placa: campo('ABC123', 0.95) } as never);
    const r = await post();
    expect(r.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('fallos sin tocar la revisión', () => {
  it('OCR no disponible → 503 con mensaje claro y sin update', async () => {
    revision('soat');
    vi.mocked(ocr.extraerFacturaSoat).mockRejectedValue(new ocr.OcrNoDisponibleError(503, 'sin API key'));

    const r = await post();

    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/lector de documentos no está disponible/);
    expect(h.updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('el soporte no se puede abrir del almacenamiento → 503 y sin llamar al OCR', async () => {
    revision('soat');
    vi.mocked(storage.getEntityDocumentStream).mockRejectedValueOnce(new Error('NoSuchKey'));

    const r = await post();

    expect(r.status).toBe(503);
    expect(ocr.extraerFacturaSoat).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('lectura vacía → 200 sinLectura y NO sobrescribe la extracción', async () => {
    revision('impuestos');
    vi.mocked(ocr.extraerReciboImpuesto).mockResolvedValue({ placa: campo(null, 0), valorTotal: campo(null, 0) } as never);

    const r = await post();

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sinLectura: true, camposLeidos: 0, revision: { id: REV } });
    expect(h.updates).toEqual([]);
    expect(vi.mocked(audit).mock.calls[0][1]).toMatchObject({ detail: 'Reintento de lectura OCR (impuestos): ningún campo leído, revisión sin cambios' });
  });
});

describe('limitador montado', () => {
  it('el 11.º intento del mismo usuario en la ventana → 429', async () => {
    const token = await testToken({ sub: 9999, role: 'admin' });
    const estados: number[] = [];
    for (let i = 0; i < 11; i++) estados.push((await post({}, token)).status);
    expect(estados.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(estados[10]).toBe(429);
  });
});
