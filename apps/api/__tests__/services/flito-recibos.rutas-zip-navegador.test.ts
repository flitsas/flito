// HU #12056 (AC3/AC7) — el ZIP lo abre el NAVEGADOR y manda las entradas por tandas, así que la
// ruta de carpeta dentro del ZIP deja de ser un dato que solo el API conoce: viaja en el campo
// opcional `rutas` del multipart, uno por archivo y en el mismo orden.
//
// Lo que se vigila aquí es justo el fallo silencioso que este cambio puede provocar: que la marca
// de agua se deduzca del checkbox en vez de la carpeta y NADIE se entere (200, sin error, y
// mintiendo). Por eso el aserto no mira la respuesta —que no dice nada de la marca— sino el `tipo`
// con el que el soporte se PERSISTE: `recibo_impuesto_sin_marca` vs `recibo_impuesto`.
//
// Cubre: (a) rutas emparejadas → manda la carpeta, en las dos direcciones; (b) sin rutas → defecto
// del checkbox, como hoy; (c) cardinalidad desalineada → defecto, sin excepción; (d) ZIP subido al
// API → se sigue expandiendo dentro (AC7); (e) la ruta es texto del cliente y no llega ni al nombre
// del archivo ni al storage; (f) SOAT no usa rutas y las ignora sin fallar.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import JSZip from 'jszip';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { CampoImpuesto, CampoSoat } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const extraerMock = vi.fn();
const extraerSoatMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerReciboImpuesto: extraerMock, extraerFacturaSoat: extraerSoatMock };
});
const uploadMock = vi.fn().mockResolvedValue('flito/impuestos/recibos/k.pdf');
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));

/** Todo lo insertado dentro de la transacción: el mock `chain` no guarda los `values()` por su cuenta. */
let insertados: Record<string, unknown>[] = [];

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  extraerMock.mockReset(); extraerSoatMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/k.pdf');
  insertados = [];
});

const TIPO_CON_MARCA = 'recibo_impuesto';
const TIPO_SIN_MARCA = 'recibo_impuesto_sin_marca';

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const UUID = '00000000-0000-0000-0000-0000000000dd';
const candidato = {
  impuestoId: UUID, estado: 'solicitado', organismoCodigo: '08001', tramiteIdFlit: 'FLIT-1', tramiteId: 't1',
  placa: 'QTQ100', companiaId: 1, carpeta: null, valorLiquidado: '500000', diferenciaActiva: false, tolerancia: '0',
};
const reciboOk = {
  [CampoImpuesto.PLACA]: campo('QTQ100', 0.95),
  [CampoImpuesto.VALOR_TOTAL]: campo('634900', 0.95),
  // Presente a propósito: el número de recibo dispara la consulta CA-08 (2), que es la que la
  // secuencia de `selectMock` cuenta como segundo SELECT por archivo.
  [CampoImpuesto.NUMERO_RECIBO]: campo('R-1', 0.95),
};

/** `chain` con `values()` espiado: es la única forma de ver el `tipo` con el que se persiste. */
function chainCapturando(rows: unknown[]) {
  const c = chain(rows) as unknown as { values: (v: unknown) => unknown };
  const original = c.values;
  c.values = (v: unknown) => { insertados.push(v as Record<string, unknown>); return original(v); };
  return c as unknown as ReturnType<typeof chain>;
}

/** nombreArchivo → tipo del soporte persistido. */
function tiposPersistidos(): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of insertados) {
    if (typeof v?.nombreArchivo === 'string' && typeof v?.tipo === 'string') m.set(v.nombreArchivo, v.tipo);
  }
  return m;
}

async function buildApp(modulo: 'impuestos' | 'soat') {
  const app = express();
  app.use(express.json());
  const ruta = modulo === 'impuestos'
    ? '../../src/modules/flito-impuestos/flito-impuestos.routes.js'
    : '../../src/modules/flito-soat/flito-soat.routes.js';
  const { default: router } = await import(ruta);
  app.use(`/api/flito/${modulo}`, router);
  app.use((err: { code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message ?? String(err), code: err.code });
  });
  return app;
}
const auth = async () => `Bearer ${await testToken({ sub: 5, username: 'g@x.io', role: 'admin' })}`;
const pdf = (i: number) => Buffer.from(`%PDF-recibo-${i}`);

function mockTxOk() {
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const txInsert = vi.fn().mockReturnValueOnce(chainCapturando([{ id: 'sop1' }])).mockReturnValue(chainCapturando([]));
    const txUpdate = vi.fn().mockReturnValue(chain([]));
    const txSelect = vi.fn().mockReturnValue(chain([{ n: 1 }]));
    return cb({ insert: txInsert, update: txUpdate, select: txSelect });
  });
}

function mockHashesLibresLuegoCandidato(n: number) {
  for (let i = 0; i < n; i++) selectMock.mockReturnValueOnce(chain([]));
  for (let i = 0; i < n; i++) {
    selectMock.mockReturnValueOnce(chain([candidato]));
    selectMock.mockReturnValueOnce(chain([]));
  }
}

interface OpcionesPost {
  /** Nombre de cada adjunto; el buffer se genera distinto por índice para que los hash no choquen. */
  nombres: string[];
  buffers?: Buffer[];
  sinMarca?: boolean;
  /** Valores del campo `rutas`, uno por `.field()`: uno solo llega como string, varios como array. */
  rutas?: string[];
}
async function postRecibos(opts: OpcionesPost) {
  const app = await buildApp('impuestos');
  let req = request(app).post('/api/flito/impuestos/recibos').set('Authorization', await auth());
  if (opts.sinMarca !== undefined) req = req.field('sinMarcaDeAgua', String(opts.sinMarca));
  for (const r of opts.rutas ?? []) req = req.field('rutas', r);
  opts.nombres.forEach((nombre, i) => { req = req.attach('archivos', opts.buffers?.[i] ?? pdf(i), nombre); });
  return req;
}

async function zipCon(entradas: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [ruta, contenido] of Object.entries(entradas)) zip.file(ruta, contenido);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('HU #12056 — la ruta del ZIP viaja en la tanda', () => {
  it('(a) rutas emparejadas: la carpeta manda sobre el checkbox apagado', async () => {
    mockHashesLibresLuegoCandidato(2);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({
      nombres: ['ABC123.pdf', 'ABC123-2.pdf'],
      sinMarca: false,
      rutas: ['SIN MARCA/ABC123.pdf', 'CON MARCA/ABC123-2.pdf'],
    });
    expect(r.status).toBe(200);
    const tipos = tiposPersistidos();
    // Sin leer `rutas` ambos caerían al defecto (false) y este primero sería `recibo_impuesto`.
    expect(tipos.get('ABC123.pdf')).toBe(TIPO_SIN_MARCA);
    expect(tipos.get('ABC123-2.pdf')).toBe(TIPO_CON_MARCA);
  });

  it('(a) una sola ruta (multer la entrega como string): la carpeta manda sobre el checkbox encendido', async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({ nombres: ['ABC123.pdf'], sinMarca: true, rutas: ['CON MARCA DE AGUA/ABC123.pdf'] });
    expect(r.status).toBe(200);
    // El checkbox dice «sin marca»; la carpeta dice lo contrario y es la que sabe.
    expect(tiposPersistidos().get('ABC123.pdf')).toBe(TIPO_CON_MARCA);
  });

  it('(b) sin `rutas`: manda el checkbox, exactamente como hoy', async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({ nombres: ['ABC123.pdf'], sinMarca: true });
    expect(r.status).toBe(200);
    expect(tiposPersistidos().get('ABC123.pdf')).toBe(TIPO_SIN_MARCA);
  });

  it('(c) menos rutas que archivos: defecto del checkbox para TODOS, sin excepción', async () => {
    mockHashesLibresLuegoCandidato(2);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({
      nombres: ['ABC123.pdf', 'ABC123-2.pdf'],
      sinMarca: true,
      rutas: ['CON MARCA/ABC123.pdf'],
    });
    expect(r.status).toBe(200);
    const tipos = tiposPersistidos();
    // Emparejar a medias sería peor: la única ruta NO se aplica al primer archivo.
    expect(tipos.get('ABC123.pdf')).toBe(TIPO_SIN_MARCA);
    expect(tipos.get('ABC123-2.pdf')).toBe(TIPO_SIN_MARCA);
  });

  it('(c) más rutas que archivos: defecto del checkbox, 200 y sin excepción', async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({
      nombres: ['ABC123.pdf'],
      sinMarca: false,
      rutas: ['SIN MARCA/ABC123.pdf', 'SIN MARCA/OTRO.pdf'],
    });
    expect(r.status).toBe(200);
    expect(tiposPersistidos().get('ABC123.pdf')).toBe(TIPO_CON_MARCA);
  });

  it('(d) AC7 — el ZIP subido al API se sigue expandiendo dentro y deduce por su propia carpeta', async () => {
    mockHashesLibresLuegoCandidato(2);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const zip = await zipCon({ 'SIN MARCA/ABC123.pdf': '%PDF-limpio', 'CON MARCA/ABC123-2.pdf': '%PDF-marcado' });
    const r = await postRecibos({ nombres: ['lote.zip'], buffers: [zip], sinMarca: false });
    expect(r.status).toBe(200);
    const tipos = tiposPersistidos();
    expect(tipos.get('ABC123.pdf')).toBe(TIPO_SIN_MARCA);
    expect(tipos.get('ABC123-2.pdf')).toBe(TIPO_CON_MARCA);
  });

  it('(d) AC7 — una `rutas` que acompañe al ZIP no pisa la carpeta de sus entradas', async () => {
    mockHashesLibresLuegoCandidato(2);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const zip = await zipCon({ 'SIN MARCA/ABC123.pdf': '%PDF-limpio', 'CON MARCA/ABC123-2.pdf': '%PDF-marcado' });
    // Cardinalidad correcta (1 ruta, 1 archivo) y aun así el ZIP manda: cada entrada trae la suya.
    const r = await postRecibos({ nombres: ['lote.zip'], buffers: [zip], sinMarca: false, rutas: ['CON MARCA/lote.zip'] });
    expect(r.status).toBe(200);
    const tipos = tiposPersistidos();
    expect(tipos.get('ABC123.pdf')).toBe(TIPO_SIN_MARCA);
    expect(tipos.get('ABC123-2.pdf')).toBe(TIPO_CON_MARCA);
  });

  it('(e) la ruta es texto del cliente: `../../etc/passwd` cae al defecto y no toca nombre ni storage', async () => {
    mockHashesLibresLuegoCandidato(1);
    extraerMock.mockResolvedValue(reciboOk);
    mockTxOk();
    const r = await postRecibos({ nombres: ['ABC123.pdf'], sinMarca: false, rutas: ['../../etc/passwd'] });
    expect(r.status).toBe(200);
    expect(tiposPersistidos().get('ABC123.pdf')).toBe(TIPO_CON_MARCA);
    // El nombre con el que se archiva sigue siendo el `originalname` de multer.
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][2]).toBe('ABC123.pdf');
    expect(JSON.stringify(uploadMock.mock.calls[0])).not.toContain('etc/passwd');
    expect(JSON.stringify(insertados)).not.toContain('etc/passwd');
    expect(JSON.stringify(r.body)).not.toContain('etc/passwd');
  });
});

describe('HU #12056 — SOAT ignora `rutas` sin fallar', () => {
  const UUID_SOAT = '00000000-0000-0000-0000-000000000001';
  const datosCarga = [{ soatId: UUID_SOAT, vin: '9BWZZZ377VT004251', estado: 'solicitado', placa: 'QTQ100', companiaId: 1, carpeta: null, umbralOcr: null }];
  const extraccionCruza = {
    [CampoSoat.PLACA]: campo('QTQ100', 0.95), [CampoSoat.VIN]: campo('9BWZZZ377VT004251', 0.95),
    [CampoSoat.NUMERO_POLIZA]: campo('FLIT-1', 0.95), [CampoSoat.VALOR_TOTAL]: campo('250000', 0.95),
    [CampoSoat.ASEGURADORA]: campo('SURA', 0.95),
  };

  it('POST /soat/facturas con `rutas` → 200 y la factura se procesa igual', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValue(chain(datosCarga));
    extraerSoatMock.mockResolvedValue(extraccionCruza);
    uploadMock.mockResolvedValue('flito/soat/facturas/k.pdf');
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const txSelect = vi.fn().mockReturnValue(chain([{ n: 1 }]));
      const txUpdate = vi.fn().mockReturnValue(chain([]));
      const txInsert = vi.fn().mockReturnValueOnce(chain([{ id: 'sop-nuevo' }])).mockReturnValue(chain([]));
      return cb({ select: txSelect, update: txUpdate, insert: txInsert });
    });
    const app = await buildApp('soat');
    const r = await request(app).post('/api/flito/soat/facturas').set('Authorization', await auth())
      .field('rutas', 'SIN MARCA/ABC123.pdf')
      .attach('archivos', pdf(0), 'ABC123.pdf');
    expect(r.status).toBe(200);
    expect(r.body.pagados).toHaveLength(1);
  });
});
