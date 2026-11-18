// Contrato `ia-consumo` v1 (ADR-0045), B3/B4/B7 — el cliente central y cada llamada migrada a él, de punta a
// punta: `requestWithRetry` REAL sobre una red simulada (`node:https` mockeado). Se verifica (a) que cada
// llamador ve lo mismo que veía antes y (b) la fila que queda en el registro (sumidero en memoria).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';

type Paso =
  | { status: number; body: unknown }
  | { tipo: 'timeout' }
  | { tipo: 'red' };

const red = vi.hoisted(() => {
  const guion: unknown[] = [];
  const peticiones: Array<{ opts: { hostname?: string; headers?: Record<string, string> }; body: string }> = [];
  function request(opts: { hostname?: string; headers?: Record<string, string> }, cb: (res: unknown) => void) {
    const paso = (guion.shift() ?? { status: 200, body: { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' } }) as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
    const req = new EE() as EventEmitter & Record<string, unknown>;
    let alTimeout: (() => void) | null = null;
    let cuerpo = '';
    req.setTimeout = (_ms: number, f: () => void) => { alTimeout = f; };
    req.destroy = (err: Error) => { setImmediate(() => req.emit('error', err)); };
    req.write = (c: string | Buffer) => { cuerpo += c.toString(); };
    req.end = () => {
      peticiones.push({ opts, body: cuerpo });
      setImmediate(() => {
        if (paso.tipo === 'timeout') { alTimeout?.(); return; }
        if (paso.tipo === 'red') { req.emit('error', new Error('ECONNRESET')); return; }
        const res = new EE() as EventEmitter & { statusCode?: number };
        res.statusCode = paso.status as number;
        cb(res);
        res.emit('data', Buffer.from(typeof paso.body === 'string' ? paso.body : JSON.stringify(paso.body)));
        res.emit('end');
      });
    };
    return req;
  }
  return { guion, peticiones, request };
});

vi.mock('node:https', () => ({ default: { request: red.request }, request: red.request }));
vi.mock('https', () => ({ default: { request: red.request }, request: red.request }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/middleware/exigir-funcion.js', () => ({
  exigirFuncion: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
// Auth simulada que hace lo mismo que la real al terminar: abrir el ámbito de IA con el usuario.
vi.mock('../../src/shared/middleware/auth.js', async () => {
  const { ejecutarConUsuarioIa } = await import('../../src/shared/ia-consumo/contexto.js');
  return {
    authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 7, username: 'ana', role: 'admin', transitoCodigo: '05001' };
      ejecutarConUsuarioIa(req as never, next);
    },
    requireRole: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  };
});
const descargaMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/googleDrive.js', () => ({ downloadFile: descargaMock }));
const textoLocalMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/flito-ocr/flito-ocr-local.js', () => ({
  textoDocumento: (...a: unknown[]) => textoLocalMock(...a),
  camposDesdeTexto: () => ({}),
}));
const httpsJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/integraciones/http.js', () => ({ httpsJson: httpsJsonMock }));

const { env } = await import('../../src/config/env.js');
const { configurarSumideroIaParaTests, vaciarConsumoIa } = await import('../../src/shared/ia-consumo/escritor.js');
const { conContextoIa, procesoIa } = await import('../../src/shared/ia-consumo/index.js');
const { anthropicMessages, anthropicMensajesCrudo } = await import('../../src/modules/tramites/anthropic.js');

type Fila = Record<string, unknown>;
let filas: Fila[] = [];
let bdCaida = false;

const ok = (texto: string, extra: Record<string, unknown> = {}): Paso => ({
  status: 200,
  body: {
    id: 'msg_x', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: texto }],
    usage: { input_tokens: 100, output_tokens: 10 }, ...extra,
  },
});
const encolar = (...p: Paso[]) => { red.guion.push(...p); };
async function registrado(): Promise<Fila[]> { await vaciarConsumoIa(); return filas; }

beforeEach(() => {
  red.guion.length = 0;
  red.peticiones.length = 0;
  filas = [];
  bdCaida = false;
  env.IA_CONSUMO_LOG = true;
  env.ANTHROPIC_API_KEY = 'llave-de-prueba';
  configurarSumideroIaParaTests({
    async insertar(f) { if (bdCaida) throw new Error('bd caída'); filas.push(...(f as Fila[])); },
    async actualizar(id, cambios) { const f = filas.find((x) => x.id === id); if (f) Object.assign(f, cambios); },
    async cargarTarifas() {
      return [{ proveedor: 'anthropic', modelo: 'claude-haiku-4-5', vigenteDesde: '2026-01-01', entrada: 1, salida: 5, cacheLectura: 0.1, cacheEscritura: 1.25 }];
    },
  });
});
afterEach(() => {
  env.IA_CONSUMO_LOG = false;
  env.ANTHROPIC_API_KEY = undefined;
  configurarSumideroIaParaTests(null);
});

const payload = { model: 'claude-haiku-4-5-20251001', max_tokens: 50, messages: [{ role: 'user', content: 'hola' }] };

describe('B3 · anthropicMessages registra cada intento sin cambiar su resultado', () => {
  it('éxito: una fila con tokens, costo y el contexto abierto por quien llama', async () => {
    encolar(ok('{"a":1}'));
    const r = await conContextoIa({ ...procesoIa('ocr_documento'), usuarioId: '3', placa: 'abc123' }, () => anthropicMessages(payload, 'ocr'));
    expect(r.ok).toBe(true);
    const [f] = await registrado();
    expect(f).toMatchObject({
      resultado: 'exito', httpStatus: 200, intento: 1, pasada: 1, tokensEntrada: 100, tokensSalida: 10,
      costoUsdEstimado: '0.000150', modulo: 'tramites', proceso: 'ocr_documento', placa: 'ABC123', usuarioId: '3',
      origen: 'usuario', modeloSolicitado: 'claude-haiku-4-5-20251001', idRespuestaProveedor: 'msg_x', proveedor: 'anthropic',
    });
    expect(r.ok && r.consumoId).toBe(f!.id);
  });

  it('429 y luego 200: dos filas (intento 1 rate_limit, intento 2 exito) con el mismo correlacion_id', async () => {
    encolar({ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'lento' } } }, ok('{}'));
    const r = await conContextoIa(procesoIa('ocr_documento'), () => anthropicMessages(payload, 'ocr'));
    expect(r.ok).toBe(true);
    const f = await registrado();
    expect(f.map((x) => [x.intento, x.resultado, x.httpStatus])).toEqual([[1, 'rate_limit', 429], [2, 'exito', 200]]);
    expect(f[0]!.correlacionId).toBe(f[1]!.correlacionId);
    expect(f[0]!.errorCodigo).toBe('rate_limit_error');
  });

  it('5xx en los dos intentos: {ok:false, 503} igual que antes y dos filas error_proveedor', async () => {
    encolar({ status: 529, body: { error: { type: 'overloaded_error' } } }, { status: 500, body: 'no json' });
    const r = await anthropicMessages(payload, 'ocr');
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((await registrado()).map((x) => x.resultado)).toEqual(['error_proveedor', 'error_proveedor']);
  });

  it('timeout en los dos intentos: mensaje de timeout y filas timeout con http_status 0', async () => {
    encolar({ tipo: 'timeout' }, { tipo: 'timeout' });
    const r = await anthropicMessages(payload, 'ocr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/tardó demasiado/);
    expect((await registrado()).map((x) => [x.resultado, x.httpStatus])).toEqual([['timeout', 0], ['timeout', 0]]);
  });

  it('error de red: fila «red»', async () => {
    encolar({ tipo: 'red' }, { tipo: 'red' });
    await anthropicMessages(payload, 'ocr');
    expect((await registrado())[0]).toMatchObject({ resultado: 'red', httpStatus: 0 });
  });

  it('la BD está caída: la llamada devuelve exactamente lo mismo y nada lanza', async () => {
    bdCaida = true;
    encolar(ok('{"a":1}'));
    const r = await anthropicMessages(payload, 'ocr');
    expect(r).toMatchObject({ ok: true, data: { content: [{ text: '{"a":1}' }] } });
    await expect(vaciarConsumoIa()).resolves.toBeUndefined();
  });

  it('sin llave: no sale a la red, devuelve el 503 de siempre y deja una fila no_configurado', async () => {
    env.ANTHROPIC_API_KEY = undefined;
    const r = await anthropicMessages(payload, 'checklist');
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(red.peticiones).toHaveLength(0);
    expect((await registrado())[0]).toMatchObject({ resultado: 'no_configurado', errorCodigo: 'sin_api_key', tipoTarea: 'chat' });
  });

  it('nunca guarda el base64 ni la llave en la fila', async () => {
    encolar(ok('{}'));
    const data = Buffer.from('imagen secreta').toString('base64');
    await anthropicMessages({ ...payload, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] }] }, 'ocr');
    const fila = JSON.stringify(await registrado());
    expect(fila).not.toContain(data);
    expect(fila).not.toContain('llave-de-prueba');
    expect(filas[0]).toMatchObject({ archivoMime: 'image/jpeg', archivoBytes: Buffer.byteLength('imagen secreta') });
  });
});

describe('B4 · anthropicMensajesCrudo (contrato del https.request de antes)', () => {
  it('devuelve el cuerpo de cualquier status, un solo intento por defecto, y el timeout pedido', async () => {
    encolar({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'x' } } });
    const r = await anthropicMensajesCrudo(payload, 'ocr', { timeoutMs: 120_000 });
    expect(r.statusCode).toBe(401);
    expect(r.cuerpo.error.type).toBe('authentication_error');
    expect(red.peticiones).toHaveLength(1);
    expect((await registrado())[0]).toMatchObject({ resultado: 'error_proveedor', httpStatus: 401 });
  });

  it('cuerpo no JSON → el texto tal cual; red → rechaza (como antes)', async () => {
    encolar({ status: 502, body: '<html>bad gateway</html>' }, { tipo: 'red' });
    expect((await anthropicMensajesCrudo(payload, 'ocr')).cuerpo).toBe('<html>bad gateway</html>');
    await expect(anthropicMensajesCrudo(payload, 'ocr')).rejects.toThrow();
  });
});

describe('B4 · llamadas migradas', () => {
  it('vehículos POST /vehicles/ocr (PNG): misma respuesta, Haiku de env, 120 s, y el usuario llega pese a multer', async () => {
    const { default: router } = await import('../../src/modules/vehicles/ocr.routes.js');
    const app = express().use(express.json()).use('/vehicles', router);
    encolar(ok(JSON.stringify([{ placa: 'ABC123', avaluoComercial: '1000' }])));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);
    const res = await request(app).post('/vehicles/ocr').attach('file', png, 'f.png');
    expect(res.status).toBe(200);
    expect(res.body.vehicles[0]).toMatchObject({ placa: 'ABC123', avaluoComercial: 1000 });
    expect(JSON.parse(red.peticiones[0]!.body)).toMatchObject({ model: env.ANTHROPIC_MODEL_HAIKU, max_tokens: 8000 });
    expect((await registrado())[0]).toMatchObject({
      modulo: 'vehiculos', proceso: 'ocr_vehiculo', usuarioId: '7', usuarioLogin: 'ana', tenantId: '05001', origen: 'usuario',
    });
  });

  it('vehículos: error del proveedor → 500 con el mensaje (como antes)', async () => {
    const { default: router } = await import('../../src/modules/vehicles/ocr.routes.js');
    const app = express().use(express.json()).use('/vehicles', router);
    encolar({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'imagen inválida' } } });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);
    const res = await request(app).post('/vehicles/ocr').attach('file', png, 'f.png');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('imagen inválida');
    expect((await registrado())[0]).toMatchObject({ resultado: 'rechazado', httpStatus: 400 });
  });

  it('pipeline de declaraciones: Haiku → Sonnet con pasada 2, mismo correlacion_id y placa anotada', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const dudoso = JSON.stringify({ placa: { valor: 'QTP482', confianza: 'baja' }, _documentType: 'individual' });
    encolar(ok(dudoso), ok(JSON.stringify({ placa: { valor: 'QTP482', confianza: 'alta' }, _documentType: 'individual' })));
    const { extractSinglePage } = await import('../../src/modules/vehicles/ocr.pipeline.js');
    const r = await extractSinglePage(doc, 0);
    expect(r?._model).toBe(env.ANTHROPIC_MODEL_SONNET);
    const f = await registrado();
    expect(f.map((x) => [x.proceso, x.pasada, x.placa])).toEqual([
      ['ocr_declaracion_impuesto', 1, 'QTP482'], ['ocr_declaracion_impuesto', 2, 'QTP482'],
    ]);
    expect(f[0]!.correlacionId).toBe(f[1]!.correlacionId);
  });

  it('Drive: una fila por página, placa de la cuenta leída, mismo correlacion_id; 60 s y Haiku de env', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage(); doc.addPage();
    descargaMock.mockResolvedValue({ buffer: Buffer.from(await doc.save()), name: 'lote.pdf', mimeType: 'application/pdf' });
    encolar(ok(JSON.stringify({ placa: 'abc-123', valorTotal: 50000 })), ok('no es json'));
    const { analizarPdfDeDrive } = await import('../../src/modules/drive/procesador.service.js');
    const r = await analizarPdfDeDrive('file-1');
    expect(r.cuentas.map((c) => c.placa)).toEqual(['ABC123']);
    const f = (await registrado()).sort((a, b) => Number((a.metadatos as { pagina: number }).pagina) - Number((b.metadatos as { pagina: number }).pagina));
    expect(f.map((x) => [x.proceso, x.placa, x.resultado, x.entidadId])).toEqual([
      ['ocr_pagina_drive', 'ABC123', 'exito', 'file-1'], ['ocr_pagina_drive', null, 'respuesta_invalida', 'file-1'],
    ]);
    expect(f[0]!.correlacionId).toBe(f[1]!.correlacionId);
    expect(JSON.parse(red.peticiones[0]!.body).model).toBe(env.ANTHROPIC_MODEL_HAIKU);
  });

  it('RUNT POST /runt/ocr-cedula: misma respuesta, Sonnet de env, fila ocr_cedula del usuario', async () => {
    const { default: router } = await import('../../src/modules/runt/runt.routes.js');
    const app = express().use(express.json({ limit: '10mb' })).use('/runt', router);
    encolar(ok('{"documentNumber":"123"}'));
    const res = await request(app).post('/runt/ocr-cedula').send({ image: 'A'.repeat(200), lado: 'frontal' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, lado: 'frontal', data: { documentNumber: '123' } });
    expect(JSON.parse(red.peticiones[0]!.body).model).toBe(env.ANTHROPIC_MODEL_SONNET);
    expect((await registrado())[0]).toMatchObject({ modulo: 'runt', proceso: 'ocr_cedula', tipoTarea: 'ocr', usuarioId: '7' });
  });

  it('RUNT ocr-cedula con timeout → 500 (como antes) y fila timeout', async () => {
    const { default: router } = await import('../../src/modules/runt/runt.routes.js');
    const app = express().use(express.json({ limit: '10mb' })).use('/runt', router);
    encolar({ tipo: 'timeout' });
    const res = await request(app).post('/runt/ocr-cedula').send({ image: 'A'.repeat(200), lado: 'reverso' });
    expect(res.status).toBe(500);
    expect((await registrado())[0]).toMatchObject({ resultado: 'timeout', proceso: 'ocr_cedula' });
  });

  it('captcha RUNT: conserva su bucle (overloaded → reintenta) con intento 1..n, misma correlación y la placa', async () => {
    httpsJsonMock.mockImplementation(async (metodo: string, url: string) => {
      if (url.includes('libre-captcha/generar')) return { status: 200, data: { imagen: 'data:image/png;base64,AAAA', id: 'c1' }, headers: {} };
      if (metodo === 'POST' && url.endsWith('/auth')) return { status: 200, data: { codigoResultado: 'OK', infoVehiculo: { placa: 'JNH38H' }, token: null }, headers: {} };
      return { status: 200, data: null, headers: {} };
    });
    encolar({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } }, ok('AbC9'));
    const { consultarVehiculoRuntDirect } = await import('../../src/modules/runt/runt-direct.service.js');
    const r = await consultarVehiculoRuntDirect('jnh38h', undefined, '1020304050');
    expect(r.ok).toBe(true);
    const f = (await registrado()).filter((x) => x.proceso === 'captcha');
    expect(f.map((x) => [x.intento, x.resultado, x.placa])).toEqual([[1, 'error_proveedor', 'JNH38H'], [2, 'exito', 'JNH38H']]);
    expect(f[0]!.correlacionId).toBe(f[1]!.correlacionId);
    expect(JSON.parse(red.peticiones[0]!.body).max_tokens).toBe(16);
  }, 15_000);

  it('salud de modelos: max_tokens 1 cuenta como éxito, origen sistema, mismo reporte de siempre', async () => {
    encolar(ok('', { stop_reason: 'max_tokens' }), { status: 404, body: { type: 'error', error: { type: 'not_found_error' } } }, ok('', { stop_reason: 'max_tokens' }));
    const { runAnthropicHealthCheckOnce } = await import('../../src/modules/ai/anthropic-health.js');
    const rep = await runAnthropicHealthCheckOnce();
    expect(rep.status).toBe('degraded');
    expect(rep.models[1]).toMatchObject({ status: 'error', statusCode: 404, errorType: 'not_found_error' });
    const f = await registrado();
    expect(f.map((x) => [x.resultado, x.origen, x.modulo, x.tipoTarea])).toEqual([
      ['exito', 'sistema', 'sistema', 'salud'], ['error_proveedor', 'sistema', 'sistema', 'salud'], ['exito', 'sistema', 'sistema', 'salud'],
    ]);
  });

  it('Dr. Flit: misma forma de resultado, sin reintentos, fila chat de dr_flit', async () => {
    encolar(ok('{"x":1}', { usage: { input_tokens: 5, output_tokens: 7 } }));
    const { llamarMensajesIa } = await import('../../src/modules/flito-dr-flit/dr-flit-ia.client.js');
    const r = await conContextoIa(procesoIa('chat'), () => llamarMensajesIa({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [] }, { timeoutMs: 5000 }));
    expect(r).toEqual({ ok: true, texto: '{"x":1}', stopReason: 'end_turn', tokensEntrada: 5, tokensSalida: 7 });
    encolar({ tipo: 'timeout' });
    const t = await llamarMensajesIa({ model: 'm', messages: [] }, { timeoutMs: 5000 });
    expect(t).toEqual({ ok: false, motivo: 'ia-timeout', statusCode: null, errorType: 'timeout' });
    expect(red.peticiones).toHaveLength(2);
    expect((await registrado())[0]).toMatchObject({ modulo: 'dr_flit', proceso: 'chat', tipoTarea: 'chat' });
  });
});

describe('B5/B7 · flito-ocr: proceso, pasada 2, placa del nombre y respaldo Tesseract', () => {
  it('factura SOAT dudosa → Haiku + Sonnet, pasada 1 y 2, placa del nombre, huella del archivo', async () => {
    const dudoso = JSON.stringify({ placa: { valor: 'ABC123', confianza: 'media' } });
    encolar(ok(dudoso), ok(dudoso));
    const { extraerFacturaSoat } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    await extraerFacturaSoat({ nombreArchivo: 'ABC123_soat.pdf', contentType: 'application/pdf', contenido: Buffer.from('%PDF-1.4'), umbral: 0.85 });
    const f = await registrado();
    expect(f.map((x) => [x.modulo, x.proceso, x.pasada, x.placa])).toEqual([
      ['soat', 'ocr_factura_soat', 1, 'ABC123'], ['soat', 'ocr_factura_soat', 2, 'ABC123'],
    ]);
    expect(f[0]!.archivoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f[0]!.correlacionId).toBe(f[1]!.correlacionId);
  });

  it('JSON no interpretable → la fila se anota como respuesta_invalida', async () => {
    encolar(ok('esto no es json'), ok('tampoco'));
    const { extraerReciboCaja } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    await extraerReciboCaja({ nombreArchivo: 'r.pdf', contentType: 'application/pdf', contenido: Buffer.from('%PDF'), umbral: 0.85 });
    expect((await registrado())[0]).toMatchObject({ proceso: 'ocr_recibo_caja', resultado: 'respuesta_invalida', errorCodigo: 'json_no_parseable' });
  });

  it('sin API key → respaldo local: fila proveedor tesseract, 0 tokens, costo NULL', async () => {
    env.ANTHROPIC_API_KEY = undefined;
    textoLocalMock.mockResolvedValue('texto');
    const { extraerReciboImpuesto } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    await extraerReciboImpuesto({ nombreArchivo: 'XYZ987.pdf', contentType: 'application/pdf', contenido: Buffer.from('%PDF'), umbral: 0.85 });
    expect((await registrado())[0]).toMatchObject({
      proveedor: 'tesseract', resultado: 'exito', tokensEntrada: 0, costoUsdEstimado: null, proceso: 'ocr_recibo_impuesto', placa: 'XYZ987',
      metadatos: { motivo: 'sin_api_key', caracteres: 5 },
    });
  });
});
