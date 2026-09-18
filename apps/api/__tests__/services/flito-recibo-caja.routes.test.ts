process.env.TZ = 'UTC';
// HU #12591 (Feature #12589) — `POST /api/flito/impuestos/:id/recibo-caja` con el router real,
// `testToken` y el MOTOR de permisos (calco de finanzas-servicios-adicionales.routes.test.ts): el 403
// del gestor sale de `exigirFuncion`, no de un stub. `db` es el mock keyed por tabla (cola-fases), así
// la transacción devuelve ids distintos por tabla (`sop-1` / `rev-1`).
//
// La app se monta SIN el fallback 400 genérico de otros specs: el error handler de aquí responde 500,
// de modo que un 400 solo puede venir del envoltorio de multer de la ruta (AC3: sin archivo, dos
// archivos, tipo no permitido). En producción `errorHandler.ts` no traduce `MulterError`.
//
// Mutante M-D: `exigirFuncion('impuestos.recibos.cargar')` en la ruta → «gestor → 403» deja de serlo
// (el gestor SÍ tiene esa función de partida) y `permisos-catalogo` cae por montaje ≠ foto.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { CampoImpuesto, EstadoImpuesto, TipoSoporte } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, operacionesDePartida, fuenteDePrueba, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) }));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const intentoDenegadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: intentoDenegadoMock, ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerReciboCaja: extraerMock };
});
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, uploadEntityDocument: uploadMock };
});

const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { fijarFuenteDePermisos, invalidarPermisosDe } = await import('../../src/shared/permisos-efectivos.js');
const { flitoImpuestos, flitoSoportes, flitoRevisiones, flitoCompradores, flitoImpuestoCertificaciones } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_REVISIONES = getTableName(flitoRevisiones);
const T_COMPRADORES = getTableName(flitoCompradores);
const T_CERT = getTableName(flitoImpuestoCertificaciones);

const CODIGO = 'impuestos.recibos.cargar_caja';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const RUTA = `/api/flito/impuestos/${ID}/recibo-caja`;
const LIQUIDADO_EN = new Date('2026-09-01T00:00:00Z');
const PDF = Buffer.from('%PDF-recibo-de-caja');

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const lectura = (valorTotal = campo('350000', 0.95)) => ({
  [CampoImpuesto.VALOR_TOTAL]: valorTotal, [CampoImpuesto.FECHA_PAGO]: campo('2026-09-10', 0.95), [CampoImpuesto.NUMERO_RECIBO]: campo('RC-778', 0.95),
});

const filaAcceso = (over: Record<string, unknown> = {}) => ({
  imp: { id: ID, tramiteId: 't1', estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '05001', gestionOperaciones: false, liquidadoEn: LIQUIDADO_EN, extraccion: null, extraccionFacturaVenta: null, pagadoEn: null, ...over },
  dentroDeFrontera: true,
});
const candidato = () => ({
  impuestoId: ID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '05001', tramiteIdFlit: 'FLIT-1', tramiteId: 't1',
  placa: 'QIU744', companiaId: 1, carpeta: null, valorLiquidado: '350000', diferenciaActiva: false, tolerancia: '0', liquidadoEn: LIQUIDADO_EN,
});

/** Escenario feliz: acceso → (hash libre) → candidato; la tx devuelve ids distintos por tabla. */
function armarCarga(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso(over)])
    .selectOnce(T_IMPUESTOS, [candidato()])
    .select(T_SOPORTES, [])
    .insert(T_SOPORTES, [{ id: 'sop-1' }])
    .insert(T_REVISIONES, [{ id: 'rev-1' }]);
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  // 500 a propósito: un 400 solo puede venir de la ruta.
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
const auth = async (role: TestRole, sub = 7) => `Bearer ${await testToken({ sub, username: 'u@flitsas.io', role })}`;

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear(); intentoDenegadoMock.mockClear();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/caja.pdf');
  extraerMock.mockResolvedValue(lectura());
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

function nadaLlamado() {
  expect(kdb.transaction).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(extraerMock).not.toHaveBeenCalled();
}

// ═════════════════ AC2 · la función es de admin; el gestor no la tiene ══════════════════════════

describe('AC2 — acceso por función `impuestos.recibos.cargar_caja`', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).post(RUTA).attach('archivo', PDF, 'caja.pdf')).status).toBe(401);
  });

  it('gestor_impuestos (que SÍ tiene impuestos.recibos.cargar de partida) → 403 del motor; nada se consulta ni escribe (M-D)', async () => {
    expect(operacionesDePartida('gestor_impuestos')).toContain('impuestos.recibos.cargar');
    expect(operacionesDePartida('gestor_impuestos')).not.toContain(CODIGO);
    const app = await buildApp();
    const res = await request(app).post(RUTA).set('Authorization', await auth('gestor_impuestos')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: CODIGO, motivo: 'sin_funcion' });
    expect(typeof res.body.error).toBe('string');
    expect(kdb.select).not.toHaveBeenCalled();
    nadaLlamado();
  });

  it('auditor → 403; admin de partida (sin `funciones` a mano) pasa la guarda → 200', async () => {
    const app = await buildApp();
    const r403 = await request(app).post(RUTA).set('Authorization', await auth('auditor')).attach('archivo', PDF, 'caja.pdf');
    expect(r403.status).toBe(403);
    expect(r403.body.funcion).toBe(CODIGO);

    armarCarga();
    const r200 = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(r200.status).toBe(200);
    expect(r200.body.resultado).toBe('pagado');
  });

  it('admin al que se le quita la función: sigue entrando mientras dura la caché y recibe 403 al invalidarla', async () => {
    const app = await buildApp();
    const bearer = await auth('admin', 9);
    // Fuente propia y MUTABLE: quitar la función después no vacía la caché (a diferencia de re-registrar).
    const filas = { rol: 'admin', tipoPrincipal: 'interno' as const, funcionesDelRol: [...operacionesDePartida('admin')], excepciones: [] };
    fijarFuenteDePermisos(async (sub) => (sub === 9 ? filas : null));

    armarCarga();
    expect((await request(app).post(RUTA).set('Authorization', bearer).attach('archivo', PDF, 'caja.pdf')).status).toBe(200);

    filas.funcionesDelRol = filas.funcionesDelRol.filter((c) => c !== CODIGO);
    armarCarga();
    expect((await request(app).post(RUTA).set('Authorization', bearer).attach('archivo', PDF, 'caja.pdf')).status).toBe(200);

    invalidarPermisosDe(9);
    const res = await request(app).post(RUTA).set('Authorization', bearer).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: CODIGO, motivo: 'sin_funcion' });
  });
});

// ═════════════════ AC3 · 400 del envoltorio de multer; 404/409 con `codigo` ═════════════════════

describe('AC3 — el archivo y las precondiciones', () => {
  it.each([
    ['sin archivo', (r: request.Test) => r],
    ['dos archivos', (r: request.Test) => r.attach('archivo', PDF, 'a.pdf').attach('archivo', PDF, 'b.pdf')],
    ['text/plain', (r: request.Test) => r.attach('archivo', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' })],
    ['zip (el `upload` de la masiva lo acepta; aquí no)', (r: request.Test) => r.attach('archivo', Buffer.from('PK'), { filename: 'a.zip', contentType: 'application/zip' })],
    ['otro campo', (r: request.Test) => r.attach('soporte', PDF, 'a.pdf')],
  ])('%s → 400 archivo_invalido desde la ruta (no del fallback) y nada consultado', async (_n, armar) => {
    const app = await buildApp();
    const res = await armar(request(app).post(RUTA).set('Authorization', await auth('admin')));
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).not.toContain('text/plain');
    expect(kdb.select).not.toHaveBeenCalled();
    nadaLlamado();
  });

  it('id inexistente → 404 con `codigo`', async () => {
    const app = await buildApp();
    kdb.when.select(T_IMPUESTOS, []);
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'El impuesto no existe', codigo: 'no_encontrado' });
    nadaLlamado();
  });

  it('sin liquidación → 409 con el cuerpo exacto y `codigo` (handleError no lo emitiría)', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso({ liquidadoEn: null })]);
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación', codigo: 'sin_liquidacion' });
    nadaLlamado();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('pagado → 409 estado_no_permitido con el estado en el mensaje', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso({ estado: EstadoImpuesto.PAGADO })]);
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('estado_no_permitido');
    expect(res.body.error).toContain('"Pagado"');
    nadaLlamado();
  });

  it('AC6: mismo archivo ya cargado → 409 duplicado', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso()]).select(T_SOPORTES, [{ impuestoId: 'otro' }]);
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'duplicado' });
    nadaLlamado();
  });
});

// ═════════════════ AC4/AC5 · los dos 200 y el 503 ═══════════════════════════════════════════════

describe('AC4/AC5 — cuerpo del contrato', () => {
  it('pagado: { resultado, valorPagado, pagadoEn ISO (fecha del recibo, Bogotá), marcadoPorDiferencia, soporteId } + audit con el valor', async () => {
    const app = await buildApp();
    armarCarga();
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin', 5)).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'pagado', valorPagado: '350000', pagadoEn: '2026-09-10T05:00:00.000Z', marcadoPorDiferencia: false, soporteId: 'sop-1' });
    expect(extraerMock).toHaveBeenCalledTimes(1);
    expect(extraerMock.mock.calls[0]![0]).toMatchObject({ nombreArchivo: 'caja.pdf', contentType: 'application/pdf', contenido: PDF });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ action: 'upload', resource: 'flito_impuesto', resourceId: ID });
    expect(String(auditMock.mock.calls[0]![1].detail)).toContain('350000');
    expect(String(auditMock.mock.calls[0]![1].detail)).toContain('recibo_caja_impuesto');
  });

  it('en_revision: { resultado, soporteId, revisionId } con ids distintos por tabla', async () => {
    const app = await buildApp();
    armarCarga();
    extraerMock.mockResolvedValue(lectura(campo('350000', 0.6)));
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'en_revision', soporteId: 'sop-1', revisionId: 'rev-1' });
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('OCR no disponible → 503 controlado `{ error }` sin stack; sin storage ni tx', async () => {
    const app = await buildApp();
    armarCarga();
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'El servicio de OCR no está disponible'));
    const res = await request(app).post(RUTA).set('Authorization', await auth('admin')).attach('archivo', PDF, 'caja.pdf');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'El servicio de OCR no está disponible' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC7 · GET /:id/soportes lista el recibo de caja ══════════════════════════════

describe('AC7 — GET /:id/soportes lista el recibo de caja junto a la liquidación (regresión: sin filtro por tipo)', () => {
  it('del más reciente al más antiguo, con enlace firmado y Cache-Control no-store', async () => {
    const app = await buildApp();
    const filaCola = {
      id: ID, tramiteId: 't1', idFlit: 'FLIT-1001', tipoTramite: 'traspaso', fechaAprobacion: null, fechaCreacion: null, marca: 'KIA', linea: 'K3',
      estado: 'solicitado', organismoCodigo: '05001', valorLiquidado: '350000', valorPagado: null, marcadoPorDiferencia: false,
      facturaVentaFlitId: null, enviadoEn: null, pagadoEn: null, liquidadoEn: LIQUIDADO_EN, motivoRechazo: null,
      createdAt: new Date('2026-08-01T12:00:00Z'), placa: 'QIU744', vin: 'VIN1', companiaNombre: 'Norte', organismoNombre: 'STT',
      organismoSla: 24, enviadoPorNombre: null, tipoTitularFlit: 'cc',
    };
    kdb.when
      .selectOnce(T_IMPUESTOS, [filaAcceso()])
      .selectOnce(T_IMPUESTOS, [filaCola])
      .select(T_COMPRADORES, []).select(T_CERT, [])
      .select(T_SOPORTES, [
        { id: 's-liq', impuestoId: ID, tipo: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, nombreArchivo: 'liq.pdf', storageKey: 'k/liq.pdf', subidoEn: new Date('2026-09-01T10:00:00Z'), descartado: false },
        { id: 's-caja', impuestoId: ID, tipo: TipoSoporte.RECIBO_CAJA_IMPUESTO, nombreArchivo: 'caja.pdf', storageKey: 'k/caja.pdf', subidoEn: new Date('2026-09-10T10:00:00Z'), descartado: false },
      ]);

    const res = await request(app).get(`/api/flito/impuestos/${ID}/soportes`).set('Authorization', await auth('admin'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.map((s: { tipo: string }) => s.tipo)).toEqual(['recibo_caja_impuesto', 'recibo_impuesto_sin_marca_agua']);
    expect(res.body[0]).toMatchObject({ id: 's-caja', origen: 'impuesto', nombreArchivo: 'caja.pdf' });
    expect(res.body[0].url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[0-9a-f]{64}$/);
  });
});
