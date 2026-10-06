process.env.TZ = 'UTC';
// HU #13269 (Feature #13267) — `POST /api/flito/impuestos/:id/recibos/reemplazar-pago` con el router
// real, `testToken` y el MOTOR de permisos (calco de flito-recibos.carga-por-fase.routes.test.ts): el
// 403 sale de `exigirFuncion`, no de un stub. `db` es el mock keyed por tabla; la transacción corre
// sobre él. El servicio, la validación (OCR/placa/sello) y el outbox son los REALES: aquí se prueba que
// el reemplazo comparte los rechazos de la carga desde el impuesto (AC3) y que la función nace sin rol.

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

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { flitoImpuestos, flitoSoportes, flitoImpuestoEnviosFlit2 } = await import('../../src/db/schema.js');
const { DETALLE_CARGA_POR_FASE } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { MENSAJE_SIN_COMPROBANTE_VIGENTE } = await import('../../src/modules/flito-impuestos/flito-recibos.reemplazo.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_SOPORTES = getTableName(flitoSoportes);
const T_ENVIOS = getTableName(flitoImpuestoEnviosFlit2);

const CODIGO = 'impuestos.recibos.reemplazar';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const RUTA = `/api/flito/impuestos/${ID}/recibos/reemplazar-pago`;
const PDF = Buffer.from('%PDF-1.7 comprobante nuevo');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const lectura = (placa = 'QIU744') => ({
  [CampoImpuesto.PLACA]: campo(placa, 0.95), [CampoImpuesto.VALOR_TOTAL]: campo('350000', 0.95), [CampoImpuesto.SELLO_PAGADO]: campo('true', 0.95),
});
const filaAcceso = () => ({
  imp: { id: ID, tramiteId: 't1', estado: EstadoImpuesto.PAGADO, organismoCodigo: '05001', gestionOperaciones: false, liquidadoEn: null },
  dentroDeFrontera: true,
});
const candidato = () => ({
  impuestoId: ID, estado: EstadoImpuesto.PAGADO, organismoCodigo: '05001', tramiteIdFlit: 'FLIT-1', tramiteId: 't1',
  placa: 'QIU744', companiaId: 1, carpeta: null, valorLiquidado: '350000', diferenciaActiva: false, tolerancia: '0', liquidadoEn: new Date(),
});

/** Feliz: acceso → vigentes → hash libre → candidato → (tx) FOR UPDATE → vigentes → fila del envío. */
function armarReemplazo(envio: string | null = 'enviado', destino: 'flit1' | 'flit2' = 'flit2') {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso()])
    .selectOnce(T_SOPORTES, [{ id: 'sop-viejo' }])
    .selectOnce(T_SOPORTES, [])
    .selectOnce(T_IMPUESTOS, [candidato()])
    .selectOnce(T_IMPUESTOS, [{ estado: EstadoImpuesto.PAGADO }])
    .selectOnce(T_SOPORTES, [{ id: 'sop-viejo' }])
    .select(T_ENVIOS, envio ? [{ id: 'fila-1', estado: envio, destino }] : [])
    .insert(T_SOPORTES, [{ id: 'sop-nuevo' }]);
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
const auth = async (role: TestRole, sub = 7, funciones: string[] = [CODIGO]) =>
  `Bearer ${await testToken({ sub, username: 'u@flitsas.io', role, funciones })}`;
const post = (app: express.Express, bearer: string) => request(app).post(RUTA).set('Authorization', bearer);
const tablasActualizadas = () => kdb.update.mock.calls.map((c) => getTableName(c[0] as never));

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  extraerMock.mockReset(); uploadMock.mockReset();
  uploadMock.mockResolvedValue('flito/impuestos/recibos/nuevo.pdf');
  extraerMock.mockResolvedValue(lectura());
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

function nadaEscrito() {
  expect(kdb.transaction).not.toHaveBeenCalled();
  expect(kdb.update).not.toHaveBeenCalled();
  expect(kdb.insert).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
}

describe('AC7 — la función nace sin rol', () => {
  it('ningún rol de partida tiene impuestos.recibos.reemplazar (ni admin)', () => {
    for (const rol of ['admin', 'auditor', 'gestor_impuestos', 'financiera', 'proveedor', 'cliente'] as const) {
      expect(operacionesDePartida(rol)).not.toContain(CODIGO);
    }
  });
});

describe('AC2 — sin la función → 403 y nada cambia', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).post(RUTA).attach('archivo', PDF, 'r.pdf')).status).toBe(401);
  });

  it.each(['admin', 'gestor_impuestos'] as const)('%s sin la función → 403 del motor; nada leído ni escrito', async (rol) => {
    const app = await buildApp();
    const res = await post(app, await auth(rol, 11, [])).attach('archivo', PDF, 'r.pdf');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: CODIGO, motivo: 'sin_funcion' });
    expect(kdb.select).not.toHaveBeenCalled();
    expect(extraerMock).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it('sin la función y con un archivo NO permitido → 403 (no el 400 de multer): la guarda va antes que el archivo', async () => {
    const app = await buildApp();
    const res = await post(app, await auth('admin', 12, []))
      .attach('archivo', Buffer.from('hola'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: CODIGO, motivo: 'sin_funcion' });
    expect(res.body.codigo).toBeUndefined();
    expect(kdb.select).not.toHaveBeenCalled();
    expect(extraerMock).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it('los 403 no consumen el limitador (30): tras 31 rechazos, el mismo usuario ya con la función pasa', async () => {
    const app = await buildApp();
    const sinFuncion = await auth('admin', 13, []);
    for (let i = 0; i < 31; i++) {
      expect((await request(app).post(RUTA).set('Authorization', sinFuncion)).status).toBe(403);
    }
    const conFuncion = await auth('admin', 13);
    const r = await request(app).post(RUTA).set('Authorization', conFuncion);
    expect(r.status).toBe(400); // sin archivo: pasó el limitador (no 429)
    expect(r.body.codigo).toBe('archivo_invalido');
  });
});

describe('AC1 — con la función: reemplaza y reprograma el envío', () => {
  it('200 reemplazado; descarta y reprograma en la tx; el nuevo es recibo de pago; audit con ids', async () => {
    const app = await buildApp();
    armarReemplazo('enviado');
    const capturados: Record<string, unknown>[] = [];
    const orig = kdb.insert.getMockImplementation();
    kdb.insert.mockImplementation((tbl: unknown) => {
      const c = orig!(tbl) as Record<string, unknown>;
      if (getTableName(tbl as never) === T_SOPORTES) {
        const values = c.values as (v: unknown) => unknown;
        c.values = (v: Record<string, unknown>) => { capturados.push(v); return values(v); };
      }
      return c;
    });
    const res = await post(app, await auth('admin')).attach('archivo', PDF, 'nuevo.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resultado: 'reemplazado', soporteId: 'sop-nuevo', soportesDescartados: ['sop-viejo'],
      envioFlit2: { reenviado: true }, envio: { destino: 'flit2', reenviado: true },
    });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(tablasActualizadas()).toEqual([T_SOPORTES, T_ENVIOS]);
    expect(capturados[0]).toMatchObject({ tipo: TipoSoporte.RECIBO_IMPUESTO, contentType: 'application/pdf', impuestoId: ID });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toEqual({
      action: 'upload', resource: 'flito_impuesto', resourceId: ID,
      detail: 'Reemplazo del comprobante de pago: soporte(s) sop-viejo → sop-nuevo. Envío a FLIT 2: reprogramado.',
    });
  });

  it('HU #13311 AC1: trámite FLIT 1 con envío enviado → 200; `envio` dice destino flit1 reprogramado; `envioFlit2` no_flit2; audit FLIT 1', async () => {
    const app = await buildApp();
    armarReemplazo('enviado', 'flit1');
    const res = await post(app, await auth('admin')).attach('archivo', PDF, 'nuevo.pdf');
    expect(res.status).toBe(200);
    expect(res.body.envio).toEqual({ destino: 'flit1', reenviado: true });
    expect(res.body.envioFlit2).toEqual({ reenviado: false, motivo: 'no_flit2' });
    expect(tablasActualizadas()).toEqual([T_SOPORTES, T_ENVIOS]);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      detail: 'Reemplazo del comprobante de pago: soporte(s) sop-viejo → sop-nuevo. Envío a FLIT 1: reprogramado.',
    });
  });

  it('AC6: envío en ya_cargado_gestor → 200 reemplazado en FLITO; el outbox NO se toca', async () => {
    const app = await buildApp();
    armarReemplazo('ya_cargado_gestor');
    const res = await post(app, await auth('admin')).attach('archivo', PDF, 'nuevo.pdf');
    expect(res.status).toBe(200);
    expect(res.body.envioFlit2).toEqual({ reenviado: false, motivo: 'ya_cargado_gestor' });
    expect(tablasActualizadas()).toEqual([T_SOPORTES]);
  });

  it('un PNG real declarado como PNG pasa la comprobación de bytes', async () => {
    const app = await buildApp();
    armarReemplazo();
    const res = await post(app, await auth('admin')).attach('archivo', PNG, { filename: 'r.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('reemplazado');
  });
});

describe('AC3 — mismos rechazos que la carga desde el impuesto; el anterior sigue vigente', () => {
  it.each([
    ['text/plain', (r: request.Test) => r.attach('archivo', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' }), 'Tipo de archivo no permitido: solo PDF, JPEG o PNG'],
    ['un PNG declarado como PDF', (r: request.Test) => r.attach('archivo', PNG, { filename: 'a.pdf', contentType: 'application/pdf' }), 'El contenido del archivo no corresponde a un PDF, JPEG o PNG'],
    ['sin archivo', (r: request.Test) => r, 'No se adjuntó ningún archivo'],
  ])('%s → 400 archivo_invalido con el texto de la carga; nada leído', async (_n, armar, error) => {
    const app = await buildApp();
    const res = await armar(post(app, await auth('admin')));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, codigo: 'archivo_invalido' });
    expect(kdb.select).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it('más de 15 MB → 400 archivo_invalido con el motivo traducido', async () => {
    const app = await buildApp();
    const grande = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(CARGA_MASIVA_MAX_BYTES_ARCHIVO)]);
    const res = await post(app, await auth('admin')).attach('archivo', grande, 'g.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'El archivo supera el tamaño máximo permitido (15 MB)', codigo: 'archivo_invalido' });
    nadaEscrito();
  });

  it('placa leída con confianza y distinta → 200 placa_no_coincide (texto de la carga); sin tx, sin storage, sin envío', async () => {
    const app = await buildApp();
    armarReemplazo();
    extraerMock.mockResolvedValue(lectura('ABC123'));
    const res = await post(app, await auth('admin')).attach('archivo', PDF, 'nuevo.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'placa_no_coincide', detalle: DETALLE_CARGA_POR_FASE.PLACA_DISTINTA });
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — sin comprobante de pago vigente', () => {
  it('409 sin_comprobante_vigente que remite a la carga normal; sin OCR ni escritura', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_IMPUESTOS, [filaAcceso()]).selectOnce(T_SOPORTES, []);
    const res = await post(app, await auth('admin')).attach('archivo', PDF, 'nuevo.pdf');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: MENSAJE_SIN_COMPROBANTE_VIGENTE, codigo: 'sin_comprobante_vigente' });
    expect(extraerMock).not.toHaveBeenCalled();
    nadaEscrito();
  });
});
