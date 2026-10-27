// HU #14110 (Feature C1 #14091, ADR-0030) — confirmar la recogida con UN acta de organismo multicompañía y
// UNA firma; la cédula del firmante va cifrada, se muestra enmascarada y solo se revela con función propia,
// rateLimiter y registro de acceso PII. Doubles de BD/almacenamiento; las rutas usan authMiddleware y
// exigirFuncion de verdad sobre el double de permisos de `helpers/auth.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain, chainReject } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn();
const piiMock = vi.fn();
const logLlamadas: unknown[][] = [];
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig<typeof import('../../src/shared/logger.js')>();
  const espia = { info: (...a: unknown[]) => logLlamadas.push(a), warn: (...a: unknown[]) => logLlamadas.push(a), error: (...a: unknown[]) => logLlamadas.push(a), debug: (...a: unknown[]) => logLlamadas.push(a) };
  return { ...real, loggerFor: () => espia };
});

const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
const { imagenDesdeDataUrl, mimeReal, FIRMA_MAX_BYTES } = await import('../../src/modules/flito-logistica/flito-logistica.imagen.js');
const { protegerDocumento, revelarDocumento, enmascarar } = await import('../../src/modules/flito-logistica/flito-logistica.cifrado.js');
const { extrasDeActa } = await import('../../src/modules/flito-logistica/flito-logistica.firmante.js');
const { flitoLogisticaActas, flitoLogisticaActaFirmas, flitoLogisticaActaLineas, flitoLogisticaIdempotencia } = await import('../../src/db/schema.js');

const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64');
const JPG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString('base64');
const FIRMA = `data:image/png;base64,${PNG_B64}`;
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const ACTA = '33333333-3333-4333-8333-333333333333';
const FIRMA_ID = '44444444-4444-4444-8444-444444444444';
const NOMBRE = 'Funcionaria Secreta Reservada';
const CEDULA = '1036640908';
const cuerpo = (over: Record<string, unknown> = {}) => ({
  organismoCodigo: '11001', documentoIds: [D1, D2], firmante: { nombre: NOMBRE, documento: CEDULA, firma: FIRMA }, ...over,
});
const DOCS = [
  { id: D1, estado: 'recogido', organismoCodigo: '11001', companiaId: 5 },
  { id: D2, estado: 'clasificado', organismoCodigo: '11001', companiaId: 6 },
];

type Insercion = { tabla: unknown; valores: unknown };
let inserciones: Insercion[];
let sets: unknown[];

/** select de la tx en orden: documentos, [propias], líneas de organismo ya existentes. */
function tx(opts: { docs?: unknown[]; propias?: unknown[]; yaEn?: unknown[]; falla23505?: boolean } = {}) {
  selectMock.mockReturnValueOnce(chain(opts.docs ?? DOCS));
  if (opts.propias) selectMock.mockReturnValueOnce(chain(opts.propias));
  selectMock.mockReturnValueOnce(chain(opts.yaEn ?? []));
  insertMock.mockImplementation((tabla: unknown) => ({
    values: (valores: unknown) => {
      inserciones.push({ tabla, valores });
      if (tabla === flitoLogisticaActas) return opts.falla23505 ? chainReject(Object.assign(new Error('dup'), { code: '23505' })) : chain([{ id: ACTA }]);
      return chain([]);
    },
  }));
}

async function post(ruta: string, body: unknown, token: string, headers: Record<string, string> = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/flito/logistica', logisticaRoutes);
  let r = request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body as object);
}
const admin = () => testToken({ role: 'admin', sub: 1 });
const mensajero = () => testToken({ role: 'mensajero', sub: 9 });
const adminRevela = () => testToken({ role: 'admin', sub: 1, funciones: ['logistica.actas.ver_documento_firmante'] });

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); uploadMock.mockReset().mockResolvedValue('storage/firma-key');
  auditMock.mockReset().mockResolvedValue(undefined); piiMock.mockReset().mockResolvedValue(undefined);
  logLlamadas.length = 0; inserciones = []; sets = [];
  updateMock.mockReset().mockImplementation(() => ({ set: (v: unknown) => { sets.push(v); return chain([]); } }));
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({ select: selectMock, insert: insertMock, update: updateMock }));
});

describe('AC7 — imagen: MIME REAL y tamaño', () => {
  it('acepta un PNG y un JPEG reales (con o sin prefijo dataURL)', () => {
    expect(imagenDesdeDataUrl(FIRMA).mime).toBe('image/png');
    expect(imagenDesdeDataUrl(`data:image/jpeg;base64,${JPG_B64}`).mime).toBe('image/jpeg');
    expect(imagenDesdeDataUrl(PNG_B64).mime).toBe('image/png');
    expect(mimeReal(Buffer.from('<html>'))).toBeNull();
  });
  it('rechaza: contenido no imagen con MIME png declarado, MIME declarado distinto del real, no-base64 y exceso de tamaño', () => {
    const html = `data:image/png;base64,${Buffer.from('<html><script>x</script></html>').toString('base64')}`;
    expect(() => imagenDesdeDataUrl(html)).toThrow(/PNG o JPEG/);
    expect(() => imagenDesdeDataUrl(`data:image/jpeg;base64,${PNG_B64}`)).toThrow(/tipo declarado/);
    expect(() => imagenDesdeDataUrl('data:image/png;base64,@@@@')).toThrow(/imagen válida/);
    const grande = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(FIRMA_MAX_BYTES + 10)]).toString('base64');
    expect(() => imagenDesdeDataUrl(`data:image/png;base64,${grande}`)).toThrow(/tamaño/);
  });
});

describe('AC4 — cédula cifrada, últimos 4 y máscara', () => {
  it('cifra con el helper de campo (no queda en claro), recupera el valor y liga el cifrado a la firma', () => {
    const p = protegerDocumento('1.036.640.908', FIRMA_ID);
    expect(p.cifrado).not.toContain(CEDULA);
    expect(p.ultimos).toBe('0908');
    expect(revelarDocumento(p.cifrado, FIRMA_ID)).toBe(CEDULA);
    expect(() => revelarDocumento(p.cifrado, D1)).toThrow(); // otra fila: la AAD no cuadra
    expect(enmascarar('0908')).toBe('••••0908');
  });
  it('el detalle del acta solo expone los últimos 4 dígitos', async () => {
    const p = protegerDocumento(CEDULA, FIRMA_ID);
    selectMock.mockReturnValueOnce(chain([{ punto: 'organismo', organismoCodigo: '11001' }]))
      .mockReturnValueOnce(chain([{ id: FIRMA_ID, rol: 'entrega', nombre: NOMBRE, ultimos: p.ultimos, firmadoEn: new Date('2026-10-27T10:00:00Z') }]))
      .mockReturnValueOnce(chain([{ documentoId: D1, companiaId: 5 }, { documentoId: D2, companiaId: 6 }]));
    const extras = await extrasDeActa(ACTA);
    expect(extras.firmas[0].documentoEnmascarado).toBe('••••0908');
    const json = JSON.stringify(extras);
    expect(json).not.toContain(CEDULA);
    expect(json).not.toContain(p.cifrado);
    expect(extras.lineas).toHaveLength(2);
  });
});

describe('AC4 — GET /actas/:id del acta de organismo', () => {
  it('responde con las firmas (solo ••••1234) y las líneas por compañía; jamás la cédula completa ni el cifrado', async () => {
    const p = protegerDocumento(CEDULA, FIRMA_ID);
    const cab = {
      id: ACTA, companiaId: null, companiaNombre: null, estado: 'entregada', mensajeroId: 9, mensajeroNombre: 'Mensajero', receptorNombre: null,
      entregadoEn: new Date('2026-10-27T10:00:00Z'), creadoEn: new Date('2026-10-27T10:00:00Z'), pdfStorageKey: null,
      firmaEntregaKey: null, entregaNombre: null, firmaRecibeKey: null, punto: 'organismo',
    };
    selectMock.mockReturnValueOnce(chain([cab])).mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ punto: 'organismo', organismoCodigo: '11001' }]))
      .mockReturnValueOnce(chain([{ id: FIRMA_ID, rol: 'entrega', nombre: NOMBRE, ultimos: p.ultimos, firmadoEn: new Date('2026-10-27T10:00:00Z') }]))
      .mockReturnValueOnce(chain([{ documentoId: D1, companiaId: 5 }]));
    const app = express();
    app.use(express.json());
    app.use('/api/flito/logistica', logisticaRoutes);
    const r = await request(app).get(`/api/flito/logistica/actas/${ACTA}`).set('Authorization', `Bearer ${await admin()}`);
    expect(r.status).toBe(200);
    expect(r.body.punto).toBe('organismo');
    expect(r.body.firmas[0].documentoEnmascarado).toBe('••••0908');
    expect(r.body.lineas).toEqual([{ documentoId: D1, companiaId: 5 }]);
    expect(JSON.stringify(r.body)).not.toContain(CEDULA);
    expect(JSON.stringify(r.body)).not.toContain(p.cifrado);
  });
});

describe('POST /recogidas/confirmar', () => {
  it('AC1/AC4/AC5 — LT de dos compañías: UNA acta de organismo, UNA firma cifrada, líneas por compañía y pendiente=false', async () => {
    tx({ propias: [{ id: D1 }, { id: D2 }] });
    const r = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ actaId: ACTA, documentos: 2, companias: [5, 6] });
    const de = (t: unknown) => inserciones.filter((i) => i.tabla === t);
    expect(de(flitoLogisticaActas)).toHaveLength(1);
    expect(de(flitoLogisticaActas)[0].valores).toMatchObject({ punto: 'organismo', companiaId: null, organismoCodigo: '11001' });
    expect(de(flitoLogisticaActaFirmas)).toHaveLength(1);
    const firma = de(flitoLogisticaActaFirmas)[0].valores as Record<string, unknown>;
    expect(firma.documentoUltimos).toBe('0908');
    expect(String(firma.documentoCifrado)).not.toContain(CEDULA);
    expect(revelarDocumento(String(firma.documentoCifrado), String(firma.id))).toBe(CEDULA);
    expect(de(flitoLogisticaActaLineas)[0].valores).toEqual([
      { actaId: ACTA, documentoId: D1, punto: 'organismo', companiaId: 5 },
      { actaId: ACTA, documentoId: D2, punto: 'organismo', companiaId: 6 },
    ]);
    expect(sets).toContainEqual(expect.objectContaining({ actaOrganismoPendiente: false }));
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('AC2 — LT que ya está en un acta de organismo → 409 LT_YA_EN_ACTA_ORGANISMO', async () => {
    tx({ propias: [{ id: D1 }, { id: D2 }], yaEn: [{ id: D2 }] });
    const r = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('LT_YA_EN_ACTA_ORGANISMO');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('carrera: el índice único residual (23505) también es 409 LT_YA_EN_ACTA_ORGANISMO', async () => {
    tx({ propias: [{ id: D1 }, { id: D2 }], falla23505: true });
    const r = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('LT_YA_EN_ACTA_ORGANISMO');
  });

  it.each([
    ['sin nombre', { nombre: '', documento: CEDULA, firma: FIRMA }],
    ['sin cédula', { nombre: NOMBRE, documento: '', firma: FIRMA }],
    ['sin firma', { nombre: NOMBRE, documento: CEDULA, firma: '' }],
    ['sin firmante', undefined],
  ])('AC3 — firmante incompleto (%s) → 422 sin tocar BD ni almacenamiento', async (_n, firmante) => {
    const r = await post('/recogidas/confirmar', cuerpo({ firmante }), await mensajero());
    expect(r.status).toBe(422);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('AC7 — firma con MIME falso o contenido que no es imagen → 422 antes de la transacción y del almacenamiento', async () => {
    const html = `data:image/png;base64,${Buffer.from('<html>no soy png</html>').toString('base64')}`;
    const r = await post('/recogidas/confirmar', cuerpo({ firmante: { nombre: NOMBRE, documento: CEDULA, firma: html } }), await mensajero());
    expect(r.status).toBe(422);
    expect(r.body.codigo).toBe('FIRMA_INVALIDA');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('AC7 — ni logs, ni auditoría, ni la respuesta llevan nombre, cédula ni firma', async () => {
    tx({ propias: [{ id: D1 }, { id: D2 }] });
    const r = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
    for (const volcado of [JSON.stringify(auditMock.mock.calls.map((c) => c[1])), JSON.stringify(logLlamadas), JSON.stringify(r.body)]) {
      expect(volcado).not.toContain(NOMBRE);
      expect(volcado).not.toContain(CEDULA);
      expect(volcado).not.toContain(PNG_B64);
    }
    const eventos = inserciones.filter((i) => Array.isArray(i.valores) && (i.valores as Array<{ tipo?: string }>)[0]?.tipo === 'acta_organismo');
    expect(eventos).toHaveLength(1);
    expect(JSON.stringify(eventos.map((e) => e.valores))).not.toContain(CEDULA);
  });

  it('un mensajero sin operar_ajenas no confirma LT que recogió otro → 403 LT_AJENA', async () => {
    tx({ propias: [{ id: D1 }] });
    const r = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('LT_AJENA');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('con operar_ajenas no exige que las haya recogido él (no consulta los eventos)', async () => {
    tx();
    const token = await testToken({ role: 'mensajero', sub: 9, funciones: ['logistica.actas.operar_ajenas'] });
    const r = await post('/recogidas/confirmar', cuerpo(), token);
    expect(r.status).toBe(200);
  });

  it('LT de otro organismo → 422 LT_DE_OTRO_ORGANISMO; LT inexistente → 422 LT_NO_ENCONTRADA', async () => {
    tx({ docs: [{ ...DOCS[0], organismoCodigo: '05001' }, DOCS[1]] });
    const a = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(a.status).toBe(422);
    expect(a.body.codigo).toBe('LT_DE_OTRO_ORGANISMO');
    selectMock.mockReset();
    tx({ docs: [DOCS[0]] });
    const b = await post('/recogidas/confirmar', cuerpo(), await mensajero());
    expect(b.status).toBe(422);
    expect(b.body.codigo).toBe('LT_NO_ENCONTRADA');
  });

  it('exige sesión y la función del paso de campo: sin ella 403 (rol sin acceso)', async () => {
    const r = await post('/recogidas/confirmar', cuerpo(), await testToken({ role: 'cliente', sub: 77 }));
    expect([401, 403]).toContain(r.status);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('AC8 — la misma clave de idempotencia devuelve la respuesta guardada sin duplicar; la clave va prefijada usuario:ruta', async () => {
    // Primera vez: la búsqueda no halla nada y la respuesta se guarda con la clave prefijada.
    selectMock.mockReturnValueOnce(chain([]));
    tx({ propias: [{ id: D1 }, { id: D2 }] });
    const token = await mensajero();
    const primera = await post('/recogidas/confirmar', cuerpo(), token, { 'Idempotency-Key': 'abc-1' });
    expect(primera.status).toBe(200);
    const guardada = inserciones.find((i) => i.tabla === flitoLogisticaIdempotencia)!.valores as { idempotencyKey: string; status: number; response: unknown };
    expect(guardada.idempotencyKey).toBe('9:recogidas/confirmar:abc-1');
    expect(guardada.response).toEqual(primera.body);
    // Reenvío: la búsqueda devuelve lo guardado; no se abre transacción ni se sube otra firma.
    transactionMock.mockClear(); uploadMock.mockClear(); inserciones.length = 0;
    selectMock.mockReset().mockReturnValueOnce(chain([{ status: guardada.status, response: guardada.response }]));
    const segunda = await post('/recogidas/confirmar', cuerpo(), token, { 'Idempotency-Key': 'abc-1' });
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(inserciones).toHaveLength(0);
  });
});

describe('AC6 — revelar la cédula del firmante', () => {
  const ruta = `/actas/${ACTA}/firmas/${FIRMA_ID}/documento`;
  it('con la función: devuelve la cédula completa, sin caché, y registra el acceso PII con el uuid en `motivo`', async () => {
    const p = protegerDocumento(CEDULA, FIRMA_ID);
    selectMock.mockReturnValueOnce(chain([{ id: FIRMA_ID, cifrado: p.cifrado }]));
    const r = await post(ruta, {}, await adminRevela());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ documento: CEDULA });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [, opts] = piiMock.mock.calls[0];
    expect(opts).toMatchObject({ resourceTipo: 'flito_logistica_acta_firma', accion: 'read', camposAccedidos: ['documento'] });
    expect(opts.resourceId).toBeUndefined();
    expect(opts.motivo).toContain(ACTA);
    expect(opts.motivo).toContain(FIRMA_ID);
    expect(opts.motivo).not.toContain(CEDULA);
  });
  it('sin la función → 403 y no se consulta ni se registra nada', async () => {
    const r = await post(ruta, {}, await mensajero());
    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(piiMock).not.toHaveBeenCalled();
  });
  it('firma inexistente, de otra acta o ya purgada → 404 y NO registra acceso (no se reveló nada)', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: FIRMA_ID, cifrado: null }]));
    const r = await post(ruta, {}, await adminRevela());
    expect(r.status).toBe(404);
    expect(piiMock).not.toHaveBeenCalled();
  });
});
