process.env.TZ = 'UTC';
// HU #13208 (Feature #12955) — `POST /api/flito/impuestos/:id/recibos` (carga por fase) con el router
// real, `testToken` y el MOTOR de permisos (calco de flito-recibo-caja.routes.test.ts): el 403 sale de
// `exigirFuncion`, no de un stub. `db` es el mock keyed por tabla.
//
// La app se monta SIN fallback 400: el error handler responde 500, así que un 400 solo puede venir de
// la ruta (AC10). En producción `errorHandler.ts` no traduce `MulterError`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { CampoImpuesto, CARGA_MASIVA_MAX_BYTES_ARCHIVO, EstadoImpuesto, TipoSoporte } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, operacionesDePartida, fuenteDePrueba, type TestRole } from '../helpers/auth.js';

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

const extraerMock = vi.fn();
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, extraerReciboImpuesto: extraerMock };
});
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, uploadEntityDocument: uploadMock };
});

const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { flitoImpuestos, flitoSoportes, flitoGestorOrganismos, organismosTransitoConfig } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_GESTOR_ORG = getTableName(flitoGestorOrganismos);
const T_ORGANISMOS = getTableName(organismosTransitoConfig);

const CODIGO = 'impuestos.recibos.cargar';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const RUTA = `/api/flito/impuestos/${ID}/recibos`;
const PDF = Buffer.from('%PDF-1.7 comprobante');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const lectura = (sello = campo('false', 0.95)) => ({
  [CampoImpuesto.PLACA]: campo('QIU744', 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('350000', 0.95), [CampoImpuesto.SELLO_PAGADO]: sello,
});

const filaAcceso = (over: Record<string, unknown> = {}) => ({
  imp: { id: ID, tramiteId: 't1', estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '05001', gestionOperaciones: false, liquidadoEn: null, ...over },
  dentroDeFrontera: true,
});
const candidato = (over: Record<string, unknown> = {}) => ({
  impuestoId: ID, estado: EstadoImpuesto.SOLICITADO, organismoCodigo: '05001', tramiteIdFlit: 'FLIT-1', tramiteId: 't1',
  placa: 'QIU744', companiaId: 1, carpeta: null, valorLiquidado: '350000', diferenciaActiva: false, tolerancia: '0', liquidadoEn: null, ...over,
});

/** Feliz: acceso → candidato → re-lectura FOR UPDATE; soportes vacíos (hash libre, fase libre). */
function armarCarga(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso(over)])
    .selectOnce(T_IMPUESTOS, [candidato()])
    .selectOnce(T_IMPUESTOS, [{ estado: EstadoImpuesto.SOLICITADO }])
    .select(T_SOPORTES, [])
    .insert(T_SOPORTES, [{ id: 'sop-1' }]);
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
// HU #12875: Impuestos está cerrado por la frontera al enlace organismos hasta #13426; aquí se mide la
// regla del módulo (por función/organismo), así que el gestor lleva el enlace neutralizado.
const auth = async (role: TestRole, sub = 7) => `Bearer ${await testToken({ sub, username: 'u@flitsas.io', role, tipoEnlace: role === 'gestor_impuestos' ? 'ninguno' : undefined })}`;
/** Sin `await` sobre el Test de supertest: es thenable y lo enviaría antes de adjuntar nada. */
const post = (app: express.Express, bearer: string) => request(app).post(RUTA).set('Authorization', bearer);

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/r.pdf');
  extraerMock.mockResolvedValue(lectura());
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

function nadaLlamado() {
  expect(kdb.transaction).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(extraerMock).not.toHaveBeenCalled();
}

// ═════════════════ AC7 · permiso ════════════════════════════════════════════════════════════════

describe('AC7 — acceso por `impuestos.recibos.cargar`', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).post(RUTA).field('fase', 'pago').attach('archivo', PDF, 'r.pdf')).status).toBe(401);
  });

  it('auditor (sin la función) → 403 del motor; nada consultado ni escrito', async () => {
    expect(operacionesDePartida('auditor')).not.toContain(CODIGO);
    const app = await buildApp();
    const res = await post(app, await auth('auditor')).field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: CODIGO, motivo: 'sin_funcion' });
    expect(kdb.select).not.toHaveBeenCalled();
    nadaLlamado();
  });
});

// ═════════════════ AC1/AC6 · 200 de admin y del gestor de su organismo; 404 fuera ════════════════

describe('AC1/AC6 — frontera', () => {
  it('admin, fase liquidación → 200 liquidado + audit `upload` con la fase, el resultado y el soporte', async () => {
    const app = await buildApp();
    armarCarga();
    const res = await post(app, await auth('admin')).field('fase', 'liquidacion').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'liquidado', soporteId: 'sop-1', valorLiquidado: '350000' });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      action: 'upload', resource: 'flito_impuesto', resourceId: ID, detail: 'Carga por fase (liquidacion): liquidado. Soporte sop-1.',
    });
  });

  it('gestor con la función y el impuesto de SU organismo → 200 (AC6)', async () => {
    expect(operacionesDePartida('gestor_impuestos')).toContain(CODIGO);
    const app = await buildApp();
    kdb.when.select(T_GESTOR_ORG, [{ codigo: '05001' }]).select(T_ORGANISMOS, [{ codigo: '05001', u: null }]);
    armarCarga();
    const res = await post(app, await auth('gestor_impuestos', 31)).field('fase', 'liquidacion').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('liquidado');
  });

  it('gestor con un impuesto de OTRO organismo → 404 no_encontrado; sin OCR ni escritura (AC6)', async () => {
    const app = await buildApp();
    kdb.when.select(T_GESTOR_ORG, [{ codigo: '11001' }]);
    armarCarga();
    const res = await post(app, await auth('gestor_impuestos', 32)).field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'El impuesto no existe', codigo: 'no_encontrado' });
    nadaLlamado();
  });

  it('id que no es uuid → 404 (no un 22P02 convertido en 500); nada consultado', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/flito/impuestos/no-es-uuid/recibos').set('Authorization', await auth('admin'))
      .field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(404);
    expect(res.body.codigo).toBe('no_encontrado');
    expect(kdb.select).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC8 · estado ═════════════════════════════════════════════════════════════════

describe('AC8 — estado no permitido', () => {
  it('pendiente → 409 estado_no_permitido con el estado en el mensaje; sin OCR', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso({ estado: EstadoImpuesto.PENDIENTE })]);
    const res = await post(app, await auth('admin')).field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('estado_no_permitido');
    nadaLlamado();
  });
});

// ═════════════════ AC10 · validación del archivo y de la fase ═══════════════════════════════════

describe('AC10 — el archivo y la fase: 400 traducido, sin el error crudo', () => {
  it.each([
    ['sin archivo', (r: request.Test) => r.field('fase', 'pago')],
    ['dos archivos', (r: request.Test) => r.field('fase', 'pago').attach('archivo', PDF, 'a.pdf').attach('archivo', PDF, 'b.pdf')],
    ['text/plain', (r: request.Test) => r.field('fase', 'pago').attach('archivo', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' })],
    ['zip', (r: request.Test) => r.field('fase', 'pago').attach('archivo', Buffer.from('PK'), { filename: 'a.zip', contentType: 'application/zip' })],
    ['un .html renombrado a .pdf (los bytes no dicen PDF)', (r: request.Test) => r.field('fase', 'pago').attach('archivo', Buffer.from('<html><script>x</script></html>'), { filename: 'a.pdf', contentType: 'application/pdf' })],
    ['un PNG declarado como PDF', (r: request.Test) => r.field('fase', 'pago').attach('archivo', PNG, { filename: 'a.pdf', contentType: 'application/pdf' })],
    ['otro campo', (r: request.Test) => r.field('fase', 'pago').attach('soporte', PDF, 'a.pdf')],
  ])('%s → 400 archivo_invalido desde la ruta; nada consultado', async (_n, armar) => {
    const app = await buildApp();
    const res = await armar(post(app, await auth('admin')));
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).not.toMatch(/text\/plain|MulterError|LIMIT_/);
    expect(kdb.select).not.toHaveBeenCalled();
    nadaLlamado();
  });

  it('más de 15 MB → 400 archivo_invalido con el motivo traducido', async () => {
    const app = await buildApp();
    const grande = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(CARGA_MASIVA_MAX_BYTES_ARCHIVO)]);
    const res = await post(app, await auth('admin')).field('fase', 'pago').attach('archivo', grande, 'g.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'El archivo supera el tamaño máximo permitido (15 MB)', codigo: 'archivo_invalido' });
    nadaLlamado();
  });

  it.each([['ausente', null], ['desconocida', 'reintegro']])('fase %s → 400 fase_invalida antes de consultar', async (_n, fase) => {
    const app = await buildApp();
    const req = post(app, await auth('admin'));
    const res = await (fase ? req.field('fase', fase) : req).attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('fase_invalida');
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('un PNG real declarado como PNG pasa la comprobación de bytes', async () => {
    const app = await buildApp();
    armarCarga();
    const res = await post(app, await auth('admin')).field('fase', 'liquidacion').attach('archivo', PNG, { filename: 'r.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
  });
});

// ═════════════════ Resultados sin escritura y 503 ═══════════════════════════════════════════════

describe('resultados sin escritura (200 + resultado) y OCR caído (503)', () => {
  it('fase pago con sello en contra → 200 fase_no_coincide; sin storage ni transacción', async () => {
    const app = await buildApp();
    armarCarga();
    const res = await post(app, await auth('admin')).field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('fase_no_coincide');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(String(auditMock.mock.calls[0]![1].detail)).toBe('Carga por fase (pago): fase_no_coincide.');
  });

  it('fase ya cargada → 200 duplicado sin OCR', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso()]).selectOnce(T_SOPORTES, []).selectOnce(T_SOPORTES, [{ n: 1 }]);
    const res = await post(app, await auth('admin')).field('fase', 'liquidacion').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('duplicado');
    nadaLlamado();
  });

  it('OCR no disponible → 503 `{ error }` sin stack; sin storage ni tx', async () => {
    const app = await buildApp();
    armarCarga();
    extraerMock.mockRejectedValueOnce(new OcrNoDisponibleError(503, 'El servicio de OCR no está disponible'));
    const res = await post(app, await auth('admin')).field('fase', 'pago').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'El servicio de OCR no está disponible' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('el soporte guardado es del tipo de la fase y lleva el MIME que dicen los bytes', async () => {
    const app = await buildApp();
    armarCarga();
    const capturados: Record<string, unknown>[] = [];
    kdb.when.insert(T_SOPORTES, (() => [{ id: 'sop-1' }]) as never);
    const orig = kdb.insert.getMockImplementation();
    kdb.insert.mockImplementation((tbl: unknown) => {
      const c = orig!(tbl) as Record<string, unknown>;
      if (getTableName(tbl as never) === T_SOPORTES) c.values = (v: Record<string, unknown>) => { capturados.push(v); return c; };
      return c;
    });
    const res = await post(app, await auth('admin')).field('fase', 'liquidacion').attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(200);
    expect(capturados[0]).toMatchObject({ tipo: TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA, contentType: 'application/pdf' });
  });
});

// ═════════════════ Limitador (AGENTS §18) ═══════════════════════════════════════════════════════

describe('limitador propio delante de multer: 60 por usuario', () => {
  it('la petición 61 del mismo usuario → 429', async () => {
    const app = await buildApp();
    const bearer = await auth('admin', 99);
    for (let i = 0; i < 60; i++) {
      const r = await request(app).post(RUTA).set('Authorization', bearer).field('fase', 'pago');
      expect(r.status).toBe(400); // sin archivo: pasó el limitador
    }
    const r = await request(app).post(RUTA).set('Authorization', bearer).field('fase', 'pago');
    expect(r.status).toBe(429);
  });
});
