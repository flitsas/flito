process.env.TZ = 'UTC';
// HU #12629 (Feature #12606, Épica #12245) — `POST /:id/descartar` (AC6), el esqueleto de
// `POST /:id/aplicar` con adjuntar documentación (AC7) y la deuda de #12611 cerrada en routes.ts
// (AC9: `:id` no-UUID → 404, `motivo` como enum, `comprobantesCargaLimiter` delante de multer).
//
// `db` es el mock keyed por tabla y `db.transaction` ejecuta el callback contra el MISMO mock
// (`cb(db)`): las escrituras de la tx quedan en el espía. El mock ignora `where` y `for`, así que
// el FOR UPDATE y las condiciones se afirman sobre SQL RENDERIZADO: un espía local intercepta
// `.for('update')` con la condición que lo acompaña, y `renderizar` la traduce a SQL + parámetros.
//
// Mutantes nombrados (los del diseño y los del AC):
//   · (1) quitar `bloquearTramite` / el `.for('update')` → «FOR UPDATE sobre flito_tramites» cae.
//   · (R) quitar `bloquearComprobantePendiente` (la relectura FOR UPDATE del comprobante dentro de la
//     tx) → «carrera: … → 409 ya_resuelto y CERO escrituras en flito_soportes» cae (aplicar y descartar).
//   · (3) reescribir el tipo del soporte compartido cuando paginas ≠ null → «consolidado: INSERT del hijo, cero UPDATE del original» cae.
//   · (6) esPago=false escribiendo `valor` → «valor NULL» cae.
//   · AC6-M `descartado = true` siempre → «consolidado compartido: el soporte NO se libera» cae.
//   · AC7-M `esPago: true` aplicando en vez de 409 → «pago → 409 destino_no_admite + puedeAdjuntar» cae.
//   · AC7-M2 aceptar `tramiteId ≠ sugerido` sin motivo → «400 datos_invalidos» cae.
//   · AC9-M quitar `esUuid` → «id = 'abc' → 404» recibe 500 (fallback) y cae.
//   · AC9-M2 `motivo: z.string()` → «motivo fuera de catálogo → 400» cae.
//   · AC9-M3 quitar el limitador o ponerlo detrás de multer → «orden de la pila de POST /» cae.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'node:stream';
import { getTableName } from 'drizzle-orm';
import { CampoComprobante } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar, ligadoA } from '../helpers/sql-ligado.js';
import { testToken, fuenteDePrueba, operacionesDePartida } from '../helpers/auth.js';

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
const uploadMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock, presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: streamMock,
}));
const recortarMock = vi.fn();
vi.mock('../../src/shared/pdf/separar-paginas.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, recortarPaginas: recortarMock };
});
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: vi.fn(), leerSubDocumento: vi.fn() }));
const logLineas: unknown[] = [];
const logMock = { info: (...a: unknown[]) => logLineas.push(a), warn: (...a: unknown[]) => logLineas.push(a), error: (...a: unknown[]) => logLineas.push(a), debug: vi.fn(), child: () => logMock };
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const { flitoComprobantes, flitoSoportes, flitoTramites, flitoImpuestos, flitoDerechosTramite } = await import('../../src/db/schema.js');
const { aplicarSchema, repartirCampos, aplicarPago, CARPETA_APLICADOS } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
const { ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const T_TRAM = getTableName(flitoTramites);
const T_IMP = getTableName(flitoImpuestos);
const T_DER = getTableName(flitoDerechosTramite);
const BASE = '/api/flito/comprobantes';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const LOTE = '9c1d4d5e-3b7a-4c2e-9f0a-1b2c3d4e5f60';
const T1 = '5a3c4c2e-0f9b-4e6e-9a1d-2c3b4a5d6e7f';
const T2 = '6b4d5d3f-1a0c-4f7f-8b2e-3d4c5b6e7f80';
const PDF = Buffer.from('%PDF-1.4\n%consolidado\n%pagina-2\n');
const RECORTE = Buffer.from('%PDF-1.4\n%solo-p2\n');

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const extraccion = () => ({
  [CampoComprobante.TIPO_DOCUMENTO]: campo('documento_no_pago', 0.95), [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('false', 0.95),
  [CampoComprobante.CONCEPTO]: campo('soat', 0.95), [CampoComprobante.PLACA]: campo('ABC123', 0.9), [CampoComprobante.VIN]: campo(null, 0),
  [CampoComprobante.ID_FLIT]: campo('FLIT-ABC001', 0.7), [CampoComprobante.VALOR_TOTAL]: campo('350000', 0.5),
  [CampoComprobante.FECHA_PAGO]: campo('2026-09-10', 0.95), [CampoComprobante.NUMERO_DOCUMENTO]: campo('POL-1', 0.5), [CampoComprobante.EMISOR]: campo('Sura', 0.9),
});

/** La fila que `aplicar`/`descartar` leen primero. */
const cabecera = (over: Record<string, unknown> = {}) => ({
  id: ID, estado: 'pendiente', soporteId: 'sop-1', paginas: null, tramiteId: T1, cruce: 'placa', tipoDocumento: 'documento_no_pago',
  extraccion: extraccion(), extraccionDestino: { numeroPoliza: campo('POL-1', 0.6) }, ...over,
});
const soporte = { id: 'sop-1', storageKey: 'flito/comprobantes/lote/x.pdf', nombreArchivo: 'lote.pdf', contentType: 'application/pdf' };
const tramite = (over: Record<string, unknown> = {}) => ({ id: T1, idFlit: 'FLIT-ABC001', soatId: 'soat-1', ...over });
/** Fila del listado tras aplicar (para el `detalle` de la respuesta). */
const filaAplicada = (over: Record<string, unknown> = {}) => ({
  id: ID, loteId: LOTE, estado: 'aplicado', motivoPendiente: null, detallePendiente: null, tipoDocumento: 'documento_no_pago', esPago: false,
  concepto: 'soat', tramiteId: T1, tramiteIdFlit: 'FLIT-ABC001', tramitePlaca: 'ABC123', cruce: 'placa', placaLeida: 'ABC123', vinLeido: null, idFlitLeido: 'FLIT-ABC001',
  valor: null, fechaDocumento: '2026-09-10', numeroDocumento: 'POL-1', emisor: 'Sura', marcadoPorDiferencia: false, diferenciaTarifa: null,
  diferenciaAceptadaEn: null, paginas: null, archivoNombre: 'lote.pdf', archivoContentType: 'application/pdf',
  createdAt: new Date('2026-09-15T12:00:00Z'), aplicadoEn: new Date('2026-09-16T12:00:00Z'), aplicadoAutomaticamente: false, descartadoEn: null,
  subidoPorNombre: 'fin@flitsas.io', aplicadoPorNombre: 'u@flitsas.io', descartadoPorNombre: null, ...over,
});

const espia = crearEspia(kdb);

/** Espía de `.for(...)`: qué tabla se bloqueó, con qué modo y bajo qué condición (el mock keyed lo ignora). */
const bloqueos: { tabla: string; modo: string; condicion: unknown }[] = [];
function espiarFor() {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const c = base(...args);
    let tabla = ''; let condicion: unknown;
    const from = c.from as (t: unknown) => unknown;
    c.from = (t: unknown) => { try { tabla = getTableName(t as never); } catch { tabla = '?'; } return from(t); };
    const where = c.where as (w: unknown) => unknown;
    c.where = (w: unknown) => { condicion = w; return where(w); };
    c.for = (modo: string) => { bloqueos.push({ tabla, modo, condicion }); return c; };
    return c;
  });
}

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
const auth = async (role: 'admin' | 'financiera' | 'auditor' = 'financiera') => `Bearer ${await testToken({ sub: 7, username: 'u@flitsas.io', role })}`;

/** El escenario base de aplicar: cabecera pendiente, soporte, trámite, y el detalle final. */
function armarAplicar(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_COMP, [cabecera(over)])
    .selectOnce(T_SOP, [soporte])
    .selectOnce(T_COMP, [{ estado: 'pendiente' }]) // relectura FOR UPDATE dentro de la tx
    .select(T_TRAM, [tramite()])
    .select(T_IMP, [{ id: 'imp-1' }])
    .select(T_DER, [{ id: 'der-1' }])
    .selectOnce(T_COMP, [filaAplicada({ paginas: over.paginas ?? null })])
    .selectOnce(T_COMP, [{ extraccion: extraccion(), extraccionDestino: null }])
    .insert(T_SOP, [{ id: 'sop-hijo' }])
    .update(T_SOP, [{ id: 'sop-1' }])
    .update(T_COMP, [{ id: ID }]);
}

beforeEach(() => {
  kdb.reset(); espia.reiniciar(); espiarFor(); bloqueos.length = 0; logLineas.length = 0;
  auditMock.mockClear(); streamMock.mockReset(); uploadMock.mockReset(); recortarMock.mockReset();
  streamMock.mockImplementation(async () => Readable.from([PDF]));
  recortarMock.mockResolvedValue(RECORTE);
  uploadMock.mockResolvedValue('flito/comprobantes/tramites/hijo.pdf');
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

// ═════════════════ AC6 · descartar ══════════════════════════════════════════════════════════════

describe('AC6 — POST /:id/descartar', () => {
  it('exige comprobantes.comprobante.descartar (auditor → 403); motivo 5..500 (400 datos_invalidos sin tocar la base)', async () => {
    const app = await buildApp();
    expect(operacionesDePartida('financiera')).toContain('comprobantes.comprobante.descartar');
    expect((await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth('auditor')).send({ motivo: 'no corresponde' })).status).toBe(403);
    for (const body of [{}, { motivo: 'no' }, { motivo: 'x'.repeat(501) }]) {
      const res = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.codigo).toBe('datos_invalidos');
    }
    expect(kdb.select).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
  });

  it('archivo de un solo documento: estado=descartado con la pareja quién+cuándo y el motivo, el soporte se libera (descartado=true) y audit resource flito_comprobante', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ id: ID, estado: 'pendiente', soporteId: 'sop-1' }]).selectOnce(T_COMP, [{ estado: 'pendiente' }]).selectOnce(T_COMP, [{ n: 0 }]).update(T_COMP, [{ id: ID }]).update(T_SOP, [{ id: 'sop-1' }]);
    const res = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send({ motivo: '  Es de otro cliente  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    const [comp] = espia.updatesEn(T_COMP);
    expect(comp!.datos).toMatchObject({ estado: 'descartado', descartadoPorId: 7, descartadoMotivo: 'Es de otro cliente', motivoPendiente: null, detallePendiente: null });
    expect(comp!.datos.descartadoEn).toBeInstanceOf(Date);
    // El UPDATE está condicionado a id + pendiente (una carrera no descarta dos veces).
    const q = renderizar(comp!.condiciones[0] as never);
    expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
    expect(ligadoA(q, '"flito_comprobantes"."estado"')).toBe('pendiente');
    // Nadie más comparte el soporte → se libera el hash.
    const [sop] = espia.updatesEn(T_SOP);
    expect(sop!.datos).toEqual({ descartado: true });
    expect(ligadoA(renderizar(sop!.condiciones[0] as never), '"flito_soportes"."id"')).toBe('sop-1');
    // La cuenta de vivos preguntó por el soporte, excluyendo este comprobante y los descartados.
    const cuenta = renderizar(espia.condicionesLeidas().at(-1) as never);
    expect(ligadoA(cuenta, '"flito_comprobantes"."soporte_id"')).toBe('sop-1');
    expect(cuenta.sql).toContain('"flito_comprobantes"."id" <> $');
    expect(cuenta.sql).toContain('"flito_comprobantes"."estado" <> $');
    expect(cuenta.params).toContain('descartado');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'delete', resource: 'flito_comprobante', resourceId: ID }));
  });

  it('AC6-M: consolidado compartido con otro comprobante vivo → el comprobante se descarta pero flito_soportes.descartado NO se toca', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ id: ID, estado: 'pendiente', soporteId: 'sop-cons' }]).selectOnce(T_COMP, [{ estado: 'pendiente' }]).selectOnce(T_COMP, [{ n: 1 }]).update(T_COMP, [{ id: ID }]);
    const res = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send({ motivo: 'página repetida' });
    expect(res.status).toBe(200);
    expect(espia.updatesEn(T_COMP)).toHaveLength(1);
    expect(espia.updatesEn(T_SOP)).toEqual([]);
  });

  it('no pendiente (aplicado / descartado) → 409 ya_resuelto sin escribir; inexistente → 404', async () => {
    const app = await buildApp();
    for (const estado of ['aplicado', 'descartado']) {
      kdb.when.selectOnce(T_COMP, [{ id: ID, estado, soporteId: 'sop-1' }]);
      const res = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send({ motivo: 'no corresponde' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'El comprobante ya no está pendiente', codigo: 'ya_resuelto' });
    }
    const r404 = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send({ motivo: 'no corresponde' });
    expect(r404.status).toBe(404);
    expect(r404.body.codigo).toBe('no_encontrado');
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('(R) carrera: dejó de estar pendiente entre la lectura y la tx → la relectura FOR UPDATE dentro de la tx responde 409 ya_resuelto y no escribe ni en flito_comprobantes ni en flito_soportes', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ id: ID, estado: 'pendiente', soporteId: 'sop-1' }]).selectOnce(T_COMP, [{ estado: 'aplicado' }]).selectOnce(T_COMP, [{ n: 0 }])
      .update(T_COMP, [{ id: ID }]).update(T_SOP, [{ id: 'sop-1' }]);
    const res = await request(app).post(`${BASE}/${ID}/descartar`).set('Authorization', await auth()).send({ motivo: 'no corresponde' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'El comprobante ya no está pendiente', codigo: 'ya_resuelto' });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(bloqueos).toHaveLength(1);
    expect(bloqueos[0]).toMatchObject({ tabla: 'flito_comprobantes', modo: 'update' });
    expect(ligadoA(renderizar(bloqueos[0]!.condicion as never), '"flito_comprobantes"."id"')).toBe(ID);
    expect(espia.updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC7 · aplicar (esqueleto) ═══════════════════════════════════════════════════

describe('AC7 — aplicarSchema y repartirCampos', () => {
  it('tramiteId uuid, concepto del catálogo, esPago boolean, campos ≤ 200 (default {}), motivo 5..500; campos ⇒ motivo; SIN aceptarDiferencia; un solo tramiteId (D11)', () => {
    const ok = aplicarSchema.safeParse({ tramiteId: T1, concepto: 'soat', esPago: false });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.campos).toEqual({});
    expect(aplicarSchema.safeParse({ tramiteId: 'abc', concepto: 'soat', esPago: false }).success).toBe(false);
    expect(aplicarSchema.safeParse({ tramiteId: [T1, T2], concepto: 'soat', esPago: false }).success).toBe(false);
    expect(aplicarSchema.safeParse({ tramiteId: T1, concepto: 'gmf', esPago: false }).success).toBe(false);
    expect(aplicarSchema.safeParse({ tramiteId: T1, concepto: 'soat', esPago: 'no' }).success).toBe(false);
    expect(aplicarSchema.safeParse({ tramiteId: T1, concepto: 'soat', esPago: false, campos: { placa: 'x'.repeat(201) }, motivo: 'corrijo la placa' }).success).toBe(false);
    const sinMotivo = aplicarSchema.safeParse({ tramiteId: T1, concepto: 'soat', esPago: false, campos: { placa: 'ABC124' } });
    expect(sinMotivo.success).toBe(false);
    expect(!sinMotivo.success && sinMotivo.error.issues[0]!.path).toEqual(['motivo']);
    expect(aplicarSchema.safeParse({ tramiteId: T1, concepto: 'soat', esPago: false, motivo: 'abcd' }).success).toBe(false);
    expect('aceptarDiferencia' in aplicarSchema._def.schema.shape).toBe(false);
    expect(Object.keys(aplicarSchema._def.schema.shape).sort()).toEqual(['campos', 'concepto', 'esPago', 'motivo', 'tramiteId']);
  });

  it('repartirCampos: universales a extraccion, destino.* a extraccionDestino sin prefijo; clave desconocida → 400', () => {
    expect(repartirCampos({ placa: 'ABC124', 'destino.numeroPoliza': 'POL-9' })).toEqual({ universales: { placa: 'ABC124' }, destino: { numeroPoliza: 'POL-9' } });
    expect(() => repartirCampos({ propietario: 'x' })).toThrow(ComprobanteError);
    expect(() => repartirCampos({ 'destino.': 'x' })).toThrow(ComprobanteError);
  });

  it('aplicarPago: el eslabón declarado — 409 destino_no_admite, detalle fijo, puedeAdjuntar: true, para cualquier concepto', () => {
    for (const concepto of ['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales'] as const) {
      try { aplicarPago(concepto); expect.unreachable(); } catch (e) {
        expect(e).toBeInstanceOf(ComprobanteError);
        expect((e as InstanceType<typeof ComprobanteError>).cuerpo()).toMatchObject({ codigo: 'destino_no_admite', detalle: 'Los pagos se aplican en la siguiente entrega', puedeAdjuntar: true });
        expect((e as InstanceType<typeof ComprobanteError>).status).toBe(409);
      }
    }
  });
});

describe('AC7 — POST /:id/aplicar', () => {
  const body = (over: Record<string, unknown> = {}) => ({ tramiteId: T1, concepto: 'soat', esPago: false, ...over });

  it('exige comprobantes.comprobante.aplicar (auditor → 403)', async () => {
    const app = await buildApp();
    expect(operacionesDePartida('financiera')).toContain('comprobantes.comprobante.aplicar');
    expect(operacionesDePartida('admin')).toContain('comprobantes.comprobante.aplicar');
    expect((await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth('auditor')).send(body())).status).toBe(403);
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('orden: 404 no_encontrado antes que nada; 409 ya_resuelto antes que el 400 de Zod; luego 400 datos_invalidos — todo sin tx', async () => {
    const app = await buildApp();
    const r404 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send({ nada: true });
    expect(r404.status).toBe(404);
    kdb.when.selectOnce(T_COMP, [cabecera({ estado: 'aplicado' })]);
    const r409 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send({ nada: true });
    expect(r409.status).toBe(409);
    expect(r409.body.codigo).toBe('ya_resuelto');
    kdb.when.selectOnce(T_COMP, [cabecera()]);
    const r400 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send({ nada: true });
    expect(r400.status).toBe(400);
    expect(r400.body.codigo).toBe('datos_invalidos');
    // AC7-M2: trámite distinto del sugerido sin motivo → 400 (cruce manual exige motivo).
    kdb.when.selectOnce(T_COMP, [cabecera()]);
    const rManual = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ tramiteId: T2 }));
    expect(rManual.status).toBe(400);
    expect(rManual.body.codigo).toBe('datos_invalidos');
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC7-M: esPago=true (cualquier concepto) → 409 destino_no_admite { detalle, puedeAdjuntar: true } sin tx, sin S3, sin escribir', async () => {
    const app = await buildApp();
    for (const concepto of ['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales']) {
      kdb.when.selectOnce(T_COMP, [cabecera()]);
      const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ concepto, esPago: true }));
      expect(res.status, concepto).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String), codigo: 'destino_no_admite', detalle: 'Los pagos se aplican en la siguiente entrega', puedeAdjuntar: true });
    }
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(recortarMock).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
  });

  it('esPago=false, archivo entero (paginas null): tx con FOR UPDATE sobre el trámite; soporte original reescrito (documento_tramite + soat_id); fila aplicado con es_pago=false y VALOR NULL; audit; 200 { resultado, comprobante }', async () => {
    const app = await buildApp();
    armarAplicar();
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.resultado).toBe('aplicado');
    expect(res.body.comprobante).toMatchObject({ id: ID, estado: 'aplicado', esPago: false, valor: null, tramite: { id: T1, idFlit: 'FLIT-ABC001' }, candidatos: [] });
    expect(res.body.comprobante).not.toHaveProperty('extraccion');

    // (1) FOR UPDATE sobre flito_tramites por el tramiteId, DENTRO de la tx (SQL renderizado, no el mock).
    // (R) Antes, FOR UPDATE sobre el propio comprobante por id: orden de bloqueo comprobante → trámite.
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(bloqueos).toHaveLength(2);
    expect(bloqueos[0]).toMatchObject({ tabla: 'flito_comprobantes', modo: 'update' });
    expect(ligadoA(renderizar(bloqueos[0]!.condicion as never), '"flito_comprobantes"."id"')).toBe(ID);
    expect(bloqueos[1]).toMatchObject({ tabla: 'flito_tramites', modo: 'update' });
    expect(ligadoA(renderizar(bloqueos[1]!.condicion as never), '"flito_tramites"."id"')).toBe(T1);

    // Sin recorte ni subida: el archivo entero ES el documento.
    expect(streamMock).not.toHaveBeenCalled();
    expect(recortarMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(espia.insertsEn(T_SOP)).toEqual([]);
    const [sop] = espia.updatesEn(T_SOP);
    expect(sop!.datos).toEqual({ tipo: 'documento_tramite', soatId: 'soat-1' });
    expect(ligadoA(renderizar(sop!.condiciones[0] as never), '"flito_soportes"."id"')).toBe('sop-1');

    // (6) La fila: aplicado, documentación, valor NULL, cruce el sugerido, pareja + motivo, soporte aplicado = el original.
    const [comp] = espia.updatesEn(T_COMP);
    expect(comp!.datos).toMatchObject({
      estado: 'aplicado', esPago: false, valor: null, tramiteId: T1, concepto: 'soat', cruce: 'placa', soporteAplicadoId: 'sop-1',
      aplicadoPorId: 7, aplicadoAutomaticamente: false, aplicadoMotivo: null, motivoPendiente: null, detallePendiente: null,
    });
    expect(comp!.datos.aplicadoEn).toBeInstanceOf(Date);
    expect(comp!.datos.extraccion).toEqual(extraccion()); // sin campos confirmados, la extracción no cambia
    const q = renderizar(comp!.condiciones[0] as never);
    expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
    expect(ligadoA(q, '"flito_comprobantes"."estado"')).toBe('pendiente');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', resource: 'flito_comprobante', resourceId: ID }));
    // Ningún log con contenido leído.
    for (const secreto of ['ABC123', 'POL-1', 'Sura', '350000']) expect(JSON.stringify(logLineas)).not.toContain(secreto);
  });

  it('(3) consolidado (paginas [2]): recorte + upload ANTES de la tx, INSERT del hijo dentro con la FK del destino, el original compartido NO se reescribe; soporte_aplicado_id = hijo', async () => {
    const app = await buildApp();
    armarAplicar({ paginas: [2] });
    const orden: string[] = [];
    uploadMock.mockImplementation(async () => { orden.push('upload'); return 'flito/comprobantes/tramites/hijo.pdf'; });
    kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => { orden.push('tx'); return cb(kdb.db); });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ concepto: 'impuesto' }));
    expect(res.status).toBe(200);
    expect(orden).toEqual(['upload', 'tx']);
    expect(streamMock).toHaveBeenCalledWith('flito/comprobantes/lote/x.pdf');
    expect(recortarMock).toHaveBeenCalledWith(PDF, [2]);
    expect(uploadMock).toHaveBeenCalledWith(CARPETA_APLICADOS, T1, 'lote - pág 2.pdf', RECORTE, 'application/pdf');

    expect(espia.updatesEn(T_SOP)).toEqual([]);
    const [hijo] = espia.insertsEn(T_SOP);
    expect(hijo!.datos).toMatchObject({
      tipo: 'documento_tramite', nombreArchivo: 'lote - pág 2.pdf', contentType: 'application/pdf', storageKey: 'flito/comprobantes/tramites/hijo.pdf',
      tamanoBytes: RECORTE.length, subidoPorId: 7, subidoPorNombre: 'u@flitsas.io', impuestoId: 'imp-1',
    });
    expect(hijo!.datos.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hijo!.datos).not.toHaveProperty('soatId');
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ soporteAplicadoId: 'sop-hijo', concepto: 'impuesto', esPago: false, valor: null });
    expect(bloqueos).toHaveLength(2);
  });

  it('cruce manual (tramiteId ≠ sugerido) con motivo → cruce=manual y aplicado_motivo; derecho lleva derecho_id; honorario sin FK', async () => {
    const app = await buildApp();
    armarAplicar();
    const r1 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ tramiteId: T2, concepto: 'derecho', motivo: 'El OCR leyó otra placa' }));
    expect(r1.status).toBe(200);
    expect(ligadoA(renderizar(bloqueos[1]!.condicion as never), '"flito_tramites"."id"')).toBe(T2); // [0] es el comprobante
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'documento_tramite', derechoId: 'der-1' });
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ cruce: 'manual', aplicadoMotivo: 'El OCR leyó otra placa', tramiteId: T1 }); // tramiteId = el bloqueado (T1 según el mock del trámite)

    espia.reiniciar(); espiarFor(); bloqueos.length = 0;
    armarAplicar({ tramiteId: null, cruce: null });
    const r2 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ concepto: 'logistica', motivo: 'Sin sugerencia: lo asocio yo' }));
    expect(r2.status).toBe(200);
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'documento_tramite' });
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ cruce: 'manual', concepto: 'logistica' });
  });

  it('campos confirmados pasan por `confirmar` de revisiones (confianza 1, confirmadoPor = userId); los universales a extraccion y los destino.* a extraccion_destino', async () => {
    const app = await buildApp();
    armarAplicar();
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth())
      .send(body({ campos: { numeroDocumento: 'POL-778', 'destino.numeroPoliza': 'POL-778' }, motivo: 'Confirmo el número contra el PDF' }));
    expect(res.status).toBe(200);
    const datos = espia.updatesEn(T_COMP)[0]!.datos as { extraccion: Record<string, unknown>; extraccionDestino: Record<string, unknown>; numeroDocumento: string };
    expect(datos.extraccion.numeroDocumento).toMatchObject({ valor: 'POL-778', confianza: 1, confiable: true, confirmadoPor: '7' });
    expect(datos.extraccion.placa).toEqual(campo('ABC123', 0.9)); // lo no tocado conserva su confianza
    expect(datos.extraccionDestino.numeroPoliza).toMatchObject({ valor: 'POL-778', confianza: 1, confirmadoPor: '7' });
    expect(datos.numeroDocumento).toBe('POL-778'); // la columna plana se rederiva de la extracción confirmada
    expect(datos).toMatchObject({ aplicadoMotivo: 'Confirmo el número contra el PDF', valor: null });
  });

  it('trámite inexistente al bloquear → 404 no_encontrado (la tx no escribe nada)', async () => {
    const app = await buildApp();
    armarAplicar();
    kdb.when.select(T_TRAM, []);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ tramiteId: T2, motivo: 'Lo asocio a mano' }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'El trámite no existe', codigo: 'no_encontrado' });
    expect(espia.updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('(R) carrera: el comprobante dejó de estar pendiente entre la lectura y la tx → 409 ya_resuelto, CERO escrituras en flito_soportes y flito_comprobantes, sin bloquear el trámite ni audit ni log «adjuntado»', async () => {
    const app = await buildApp();
    // Como armarAplicar({ paginas: [2] }) —con hijo: la carrera que más duele es la que insertaría el soporte
    // hacia otro destino— pero la relectura FOR UPDATE dentro de la tx devuelve `aplicado`: otro aplicar ganó.
    // El resto del escenario queda armado para que, sin la guarda, el flujo escriba de verdad (y el test caiga).
    kdb.when
      .selectOnce(T_COMP, [cabecera({ paginas: [2] })])
      .selectOnce(T_SOP, [soporte])
      .selectOnce(T_COMP, [{ estado: 'aplicado' }])
      .select(T_TRAM, [tramite()]).select(T_IMP, [{ id: 'imp-1' }])
      .selectOnce(T_COMP, [filaAplicada({ paginas: [2] })]).selectOnce(T_COMP, [{ extraccion: extraccion(), extraccionDestino: null }])
      .insert(T_SOP, [{ id: 'sop-hijo' }]).update(T_COMP, [{ id: ID }]);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ tramiteId: T2, motivo: 'Lo asocio a mano' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'El comprobante ya no está pendiente', codigo: 'ya_resuelto' });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    // (3) La relectura lleva FOR UPDATE y va por `flito_comprobantes.id = $`; es el ÚNICO bloqueo: el trámite no se toca.
    expect(bloqueos).toHaveLength(1);
    expect(bloqueos[0]).toMatchObject({ tabla: 'flito_comprobantes', modo: 'update' });
    const q = renderizar(bloqueos[0]!.condicion as never);
    expect(q.sql).toContain('"flito_comprobantes"."id" = $');
    expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
    expect(espia.insertsEn(T_SOP)).toEqual([]);
    expect(espia.updatesEn(T_SOP)).toEqual([]);
    expect(espia.updatesEn(T_COMP)).toEqual([]);
    expect(espia.updates).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
    expect(JSON.stringify(logLineas)).not.toContain('adjuntado');
  });
});

// ═════════════════ AC9 · deuda de #12611 cerrada en routes.ts ═══════════════════════════════════

describe('AC9 — :id no-UUID → 404; motivo como enum; limitador delante de multer', () => {
  it('AC9-M: id = "abc" → 404 no_encontrado en GET /:id, GET /:id/archivo, POST /:id/releer, POST /:id/aplicar y POST /:id/descartar, sin tocar la base', async () => {
    const app = await buildApp();
    const pedir = (r: request.SuperTest<request.Test>) => [
      r.get(`${BASE}/abc`), r.get(`${BASE}/abc/archivo`), r.post(`${BASE}/abc/releer`),
      r.post(`${BASE}/abc/aplicar`).send({ tramiteId: T1, concepto: 'soat', esPago: false }), r.post(`${BASE}/abc/descartar`).send({ motivo: 'no corresponde' }),
    ];
    for (const req of pedir(request(app))) {
      const res = await req.set('Authorization', await auth('admin'));
      expect(res.status, req.url).toBe(404);
      expect(res.body).toEqual({ error: 'El comprobante no existe', codigo: 'no_encontrado' });
    }
    // También el uuid «casi»: 35 caracteres. Y el de 32 hex sin guiones sí pasa (lo acepta la columna).
    expect((await request(app).get(`${BASE}/${ID.slice(0, -1)}`).set('Authorization', await auth('admin'))).status).toBe(404);
    expect(kdb.select).not.toHaveBeenCalled();
    kdb.when.selectOnce(T_COMP, [filaAplicada()]).selectOnce(T_COMP, [{ extraccion: {}, extraccionDestino: null }]);
    expect((await request(app).get(`${BASE}/${ID.replace(/-/g, '')}`).set('Authorization', await auth('admin'))).status).toBe(200);
  });

  it('AC9-M2: motivo del listado es z.enum(MOTIVOS_PENDIENTE_COMPROBANTE): fuera de catálogo → 400; dentro → filtra', async () => {
    const app = await buildApp();
    expect((await request(app).get(`${BASE}?motivo=cualquiera`).set('Authorization', await auth())).status).toBe(400);
    expect((await request(app).get(`${BASE}?motivo=leidoo`).set('Authorization', await auth())).status).toBe(400);
    kdb.when.selectOnce(T_COMP, [{ total: 0 }]).selectOnce(T_COMP, []);
    expect((await request(app).get(`${BASE}?motivo=cruce_ambiguo`).set('Authorization', await auth())).status).toBe(200);
    expect(ligadoA(renderizar(espia.condicionesLeidas()[0] as never), '"flito_comprobantes"."motivo_pendiente"')).toBe('cruce_ambiguo');
  });

  it('AC9-M3: POST / lleva comprobantesCargaLimiter (por usuario, calco de soatLecturaFacturaLimiter, con frenoConRastro) entre exigirFuncion y multer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const rutas = readFileSync(join(import.meta.dirname, '../../src/modules/flito-comprobantes/flito-comprobantes.routes.ts'), 'utf8');
    expect(rutas).toMatch(/router\.post\('\/', exigirFuncion\('comprobantes\.lote\.cargar'\), comprobantesCargaLimiter, recibirArchivos,/);
    const limiter = readFileSync(join(import.meta.dirname, '../../src/shared/middleware/rateLimiter.ts'), 'utf8');
    const bloque = limiter.slice(limiter.indexOf('export const comprobantesCargaLimiter'));
    expect(bloque).toMatch(/keyGenerator: userOrIpKey\('comprobantes-carga:'\)/);
    expect(bloque).toMatch(/handler: frenoConRastro\('comprobantes-carga'\)/);
    expect(bloque).toMatch(/store: makeStore\('rl:comprobantes-carga:'\)/);
    expect(bloque).toMatch(/windowMs: 15 \* 60 \* 1000/);
    // Y en vivo: la pila de POST / tiene el limitador ANTES del envoltorio de multer.
    const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
    const capa = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] } }[] }).stack
      .find((l) => l.route?.path === '/' && l.route.methods.post)!.route!;
    const nombres = capa.stack.map((s) => s.name);
    expect(nombres.indexOf('recibirArchivos')).toBeGreaterThan(0);
    expect(nombres.slice(0, nombres.indexOf('recibirArchivos'))).toHaveLength(2); // exigirFuncion + el limitador
  });
});
