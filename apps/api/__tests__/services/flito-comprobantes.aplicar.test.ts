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
//   · AC7-M `esPago: true` de un HONORARIO sin valor leído aplicando en vez de 400 → «400 valor_requerido» cae (HU #12631).
//   · AC7-M2 aceptar `tramiteId ≠ sugerido` sin motivo → «400 datos_invalidos» cae.
//   · AC9-M quitar `esUuid` → «id = 'abc' → 404» recibe 500 (fallback) y cae.
//   · AC9-M2 `motivo: z.string()` → «motivo fuera de catálogo → 400» cae.
//   · AC9-M3 quitar el limitador o ponerlo detrás de multer → «orden de la pila de POST /» cae.
//
// HU #12630 (los dueños del pago; `flito-comprobantes.duenos.ts`). `marcarPagado` se espía en
// `flito-soat.service.js` (como `flito-revisiones.test.ts`) y `aplicarFacturaSoat` corre REAL; `conciliar`
// corre REAL y se afirma sobre las tablas que escribe; `registrarDesdeRevision` se espía en derechos y
// `derechoDeTramite` corre REAL contra el mock keyed.
//   · AC1-M `aplicarFacturaSoat` escribiendo `flito_soat.estado` sin `marcarPagado` → «SOAT: … marcarPagado con SoatCtx» cae
//     (espía no llamado y UPDATE sobre flito_soat).
//   · AC2-M sustituir `conciliar` por un UPDATE directo → «impuesto: … fila de flito_estado_historial» cae.
//   · AC3-M quitar `derechoDeTramite` previo → «derecho ya registrado → 409 ya_pagado» recibe 409 destino_no_admite
//     (o 400) y cae.
//   · AC4-M subir el hijo antes de la guarda `ya_pagado` → «ya pagado no deja objeto en S3» cae (espía uploadEntityDocument).
//   · AC5-M `valor` NULL al pagar → «valor como COPIA» cae.
//
// HU #12632 (auto-aplicación): `aplicar(..., { automatico: true })` es el MISMO camino con otra marca de fila.
//   · AC1-M `aplicadoPorId: ctx.userId` siempre (o `aplicadoAutomaticamente: false` fijo) → «automático: true / NULL / now» cae.
//   · AC1-M2 leer `automatico` del cuerpo HTTP → «la ruta ignora automatico en el body» cae.

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
// HU #12630: el dueño del SOAT se espía donde revisiones lo importa; el resto del módulo es real.
const marcarPagadoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, marcarPagado: marcarPagadoMock };
});
// El alta del derecho se espía (escribe en media docena de tablas); `derechoDeTramite` es real.
const registrarDerechoMock = vi.fn().mockResolvedValue('der-nuevo');
vi.mock('../../src/modules/flito-derechos/flito-derechos.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, registrarDesdeRevision: registrarDerechoMock };
});
const logLineas: unknown[] = [];
const logMock = { info: (...a: unknown[]) => logLineas.push(a), warn: (...a: unknown[]) => logLineas.push(a), error: (...a: unknown[]) => logLineas.push(a), debug: vi.fn(), child: () => logMock };
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const {
  flitoComprobantes, flitoSoportes, flitoTramites, flitoImpuestos, flitoDerechosTramite, flitoSoat, flitoEstadoHistorial, auditLogs,
  flitoLiquidaciones, flitoTarifasVigencias, flitoTramiteServiciosAdicionales,
} = await import('../../src/db/schema.js');
const { DerechoError } = await import('../../src/modules/flito-derechos/flito-derechos.service.js');
const { aplicar, aplicarSchema, repartirCampos, CARPETA_APLICADOS } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
const { ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');
const { CONCEPTOS_CON_DUENO, tieneDueno } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.duenos.js');
const expr = await import('../../src/modules/flito-comprobantes/flito-comprobantes.expr.js');
const { calcularDiferencia, esDuplicadoDocumental, INDICE_VALOR_DOCUMENTAL } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.honorarios.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const T_TRAM = getTableName(flitoTramites);
const T_IMP = getTableName(flitoImpuestos);
const T_DER = getTableName(flitoDerechosTramite);
const T_SOAT = getTableName(flitoSoat);
const T_HIST = getTableName(flitoEstadoHistorial);
const T_AUDIT = getTableName(auditLogs);
const T_LIQ = getTableName(flitoLiquidaciones);
const T_TAR = getTableName(flitoTarifasVigencias);
const T_SA = getTableName(flitoTramiteServiciosAdicionales);
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
  marcarPagadoMock.mockReset(); marcarPagadoMock.mockResolvedValue(undefined);
  registrarDerechoMock.mockReset(); registrarDerechoMock.mockResolvedValue('der-nuevo');
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

  it('el dispatcher cubre los seis conceptos: SOAT/impuesto/derecho tienen dueño; tramite_digital/logistica/servicios_adicionales son honorarios (HU #12631: ya no queda eslabón provisional)', async () => {
    const aplicarMod = await import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
    expect('aplicarPago' in aplicarMod).toBe(false);
    expect(expr.CONCEPTOS_HONORARIO).toEqual(['tramite_digital', 'logistica', 'servicios_adicionales']);
    for (const concepto of expr.CONCEPTOS_HONORARIO) expect(expr.esHonorario(concepto)).toBe(true);
    for (const concepto of CONCEPTOS_CON_DUENO) expect(expr.esHonorario(concepto)).toBe(false);
    expect(CONCEPTOS_CON_DUENO).toEqual(['soat', 'impuesto', 'derecho']);
    for (const concepto of CONCEPTOS_CON_DUENO) expect(tieneDueno(concepto)).toBe(true);
    for (const concepto of ['tramite_digital', 'logistica', 'servicios_adicionales'] as const) expect(tieneDueno(concepto)).toBe(false);
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

  it('AC7-M (HU #12631 AC2): esPago=true de un HONORARIO (tramite_digital / logistica / servicios_adicionales) SIN valorTotal leído → 400 valor_requerido sin tx, sin S3, sin escribir; ya no existe el 409 provisional', async () => {
    const app = await buildApp();
    for (const concepto of ['tramite_digital', 'logistica', 'servicios_adicionales']) {
      const sinValor = extraccion();
      sinValor[CampoComprobante.VALOR_TOTAL] = campo(null, 0);
      kdb.when.selectOnce(T_COMP, [cabecera({ extraccion: sinValor })]);
      const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(body({ concepto, esPago: true }));
      expect(res.status, concepto).toBe(400);
      expect(res.body).toMatchObject({ codigo: 'valor_requerido' });
      expect(res.body.codigo).not.toBe('destino_no_admite');
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

// ═════════════════ HU #12630 · pagos a través de sus dueños ════════════════════════════════════

describe('HU #12630 — POST /:id/aplicar con esPago=true: SOAT / impuesto / derecho a través de sus dueños', () => {
  const pago = (over: Record<string, unknown> = {}) => ({ tramiteId: T1, concepto: 'soat', esPago: true, ...over });
  /** El candidato que `candidatoPorImpuestoId` devuelve (el mock keyed entrega la fila entera a cualquier proyección sobre flito_impuestos). */
  const impuesto = (over: Record<string, unknown> = {}) => ({
    id: 'imp-1', estado: 'solicitado', impuestoId: 'imp-1', organismoCodigo: 'BOG', tramiteIdFlit: 'FLIT-ABC001', tramiteId: T1,
    placa: 'ABC123', companiaId: 1, carpeta: null, valorLiquidado: '412000', diferenciaActiva: false, tolerancia: '0', liquidadoEn: null, ...over,
  });
  const destinoSoat = () => ({ numeroPoliza: campo('POL-1', 0.6), valorTotal: campo('350000', 0.9) });
  const destinoImpuesto = () => ({ valorTotal: campo('412000', 0.95), numeroRecibo: campo('R-77', 0.9) });
  const destinoDerecho = () => ({ placa: campo('ABC123', 0.9), valor: campo('98000', 0.9) });

  /** Escenario de pago: cabecera, soporte, relectura FOR UPDATE, trámite (con el estado del destino), detalle. */
  function armarPago(cab: Record<string, unknown>, tram: Record<string, unknown>, extra: { imp?: unknown[]; der?: unknown[]; soat?: unknown[] } = {}) {
    kdb.when
      .selectOnce(T_COMP, [cabecera(cab)])
      .selectOnce(T_SOP, [soporte])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .select(T_TRAM, [tramite(tram)])
      .select(T_IMP, extra.imp ?? [impuesto()])
      .select(T_DER, extra.der ?? [])
      .select(T_SOAT, extra.soat ?? [{ id: 'soat-1', estado: 'solicitado' }])
      .selectOnce(T_COMP, [filaAplicada({ esPago: true, valor: '350000', concepto: (cab.concepto as string | undefined) ?? 'soat', paginas: (cab.paginas as number[] | null) ?? null })])
      .selectOnce(T_COMP, [{ extraccion: extraccion(), extraccionDestino: null }])
      .insert(T_SOP, [{ id: 'sop-hijo' }])
      .update(T_SOP, [{ id: 'sop-1' }])
      .update(T_COMP, [{ id: ID }]);
  }
  const sinEscrituras = () => {
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(recortarMock).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
    expect(marcarPagadoMock).not.toHaveBeenCalled();
    expect(registrarDerechoMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  };

  // ── AC1 · SOAT ──
  it('AC1 — SOAT solicitado: soporte atado (soat_id + tipo factura_soat) DENTRO de la tx y ANTES de marcarPagado; aplicarFacturaSoat REAL llama marcarPagado(soatId, extraccionDestino, SoatCtx { role, proveedorSoatId: null, companiaId: null }); flito_soat NO se escribe aquí (AC1-M); fila es_pago=true con valor copiado (AC5); audit «aplicado como pago»', async () => {
    const app = await buildApp();
    armarPago({ extraccionDestino: destinoSoat() }, { soatId: 'soat-1', soatEstado: 'solicitado' });
    const alPagar: { soportes: number; comprobantes: number } = { soportes: -1, comprobantes: -1 };
    marcarPagadoMock.mockImplementation(async () => { alPagar.soportes = espia.updatesEn(T_SOP).length; alPagar.comprobantes = espia.updatesEn(T_COMP).length; });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ motivo: 'Pago del SOAT según factura' }));
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('aplicado');
    expect(res.body.comprobante).toMatchObject({ id: ID, estado: 'aplicado', esPago: true, valor: 350000 });

    // Bloqueos en orden comprobante → trámite, en la ÚNICA tx del comprobante (la de aplicarFacturaSoat es la segunda llamada).
    expect(bloqueos.slice(0, 2).map((b) => b.tabla)).toEqual(['flito_comprobantes', 'flito_tramites']);
    expect(ligadoA(renderizar(bloqueos[1]!.condicion as never), '"flito_tramites"."id"')).toBe(T1);

    // El soporte aplicado lleva soat_id y tipo factura_soat (pagarEnTx de SOAT lo exige); el atado de aplicarFacturaSoat lo repite.
    const sops = espia.updatesEn(T_SOP);
    expect(sops[0]!.datos).toEqual({ tipo: 'factura_soat', soatId: 'soat-1' });
    expect(ligadoA(renderizar(sops[0]!.condiciones[0] as never), '"flito_soportes"."id"')).toBe('sop-1');
    expect(sops[1]!.datos).toEqual({ soatId: 'soat-1' });

    // AC1: marcarPagado, con el SoatCtx de revisiones, DESPUÉS de atar el soporte y cerrar la fila; y ningún UPDATE directo a flito_soat.
    expect(marcarPagadoMock).toHaveBeenCalledTimes(1);
    const [soatId, extr, ctx] = marcarPagadoMock.mock.calls[0]!;
    expect(soatId).toBe('soat-1');
    expect(extr).toMatchObject({ numeroPoliza: expect.objectContaining({ valor: 'POL-1' }), valorTotal: expect.objectContaining({ valor: '350000' }) });
    expect(ctx).toEqual({ userId: 7, username: 'u@flitsas.io', role: 'financiera', proveedorSoatId: null, companiaId: null });
    expect(alPagar.soportes).toBeGreaterThanOrEqual(1);
    expect(alPagar.comprobantes).toBe(1);
    expect(espia.updatesEn(T_SOAT)).toEqual([]);
    expect(espia.insertsEn(T_AUDIT).map((i) => i.datos.resource)).toContain('flito_soat');

    // AC5: la fila del comprobante: es_pago=true, valor COPIA del leído, motivo, cruce sugerido, soporte aplicado = el original.
    const [comp] = espia.updatesEn(T_COMP);
    expect(comp!.datos).toMatchObject({ estado: 'aplicado', esPago: true, valor: '350000', concepto: 'soat', cruce: 'placa', tramiteId: T1, soporteAplicadoId: 'sop-1', aplicadoPorId: 7, aplicadoMotivo: 'Pago del SOAT según factura' });
    expect(ligadoA(renderizar(comp!.condiciones[0] as never), '"flito_comprobantes"."estado"')).toBe('pendiente');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update', resource: 'flito_comprobante', resourceId: ID,
      detail: expect.stringMatching(/^Comprobante aplicado como pago de soat al trámite FLIT-ABC001 .*Motivo: Pago del SOAT según factura$/),
    }));
    for (const secreto of ['ABC123', 'POL-1', 'Sura', '350000']) expect(JSON.stringify(logLineas)).not.toContain(secreto);
  });

  it('AC1 — un SOAT sirve a N trámites: el comprobante queda atado al tramiteId elegido (cruce manual con motivo) y el pago al soatId del trámite', async () => {
    const app = await buildApp();
    armarPago({ tramiteId: T2, extraccionDestino: destinoSoat() }, { id: T1, soatId: 'soat-compartido', soatEstado: 'solicitado' });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ tramiteId: T1, motivo: 'Es el otro trámite del mismo SOAT' }));
    expect(res.status).toBe(200);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ tramiteId: T1, cruce: 'manual', esPago: true });
    expect(marcarPagadoMock.mock.calls[0]![0]).toBe('soat-compartido');
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'factura_soat', soatId: 'soat-compartido' });
  });

  it('AC1 — el dueño rechaza TRAS el commit (el SOAT dejó de estar solicitado entre la guarda y su tx) → el comprobante vuelve a pendiente (compensación) y 409 destino_no_admite con lo que dijo el dueño', async () => {
    const app = await buildApp();
    armarPago({ extraccionDestino: destinoSoat() }, { soatId: 'soat-1', soatEstado: 'solicitado' }, { soat: [{ id: 'soat-1', estado: 'pagado' }] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'destino_no_admite', detalle: 'Solo se puede conciliar un documento contra un SOAT en adquisición', puedeAdjuntar: false });
    expect(marcarPagadoMock).not.toHaveBeenCalled();
    const comps = espia.updatesEn(T_COMP);
    expect(comps).toHaveLength(2);
    expect(comps[1]!.datos).toMatchObject({ estado: 'pendiente', esPago: null, valor: null, soporteAplicadoId: null, aplicadoPorId: null, aplicadoEn: null });
    expect(ligadoA(renderizar(comps[1]!.condiciones[0] as never), '"flito_comprobantes"."estado"')).toBe('aplicado');
    expect(auditMock).not.toHaveBeenCalled();
  });

  // ── AC2 · impuesto ──
  it('AC2 — impuesto solicitado: conciliar REAL dentro de la tx → UPDATE flito_impuestos { estado pagado, valorPagado, marcadoPorDiferencia, pagadoEn = fecha_pago leída } + INSERT flito_estado_historial (AC2-M) + audit flito_impuesto; soporte con impuesto_id y tipo recibo_impuesto; valor = lo conciliado (AC5)', async () => {
    const app = await buildApp();
    armarPago({ extraccionDestino: destinoImpuesto(), tipoDocumento: 'recibo_impuesto' }, {});
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'impuesto' }));
    expect(res.status).toBe(200);

    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    const [imp] = espia.updatesEn(T_IMP);
    expect(imp!.datos).toMatchObject({ estado: 'pagado', valorPagado: '412000', marcadoPorDiferencia: false, motivoRechazo: null });
    expect(imp!.datos.pagadoEn).toEqual(new Date('2026-09-10T05:00:00.000Z')); // fecha_pago 2026-09-10 en Bogotá
    expect(ligadoA(renderizar(imp!.condiciones[0] as never), '"flito_impuestos"."id"')).toBe('imp-1');
    const [hist] = espia.insertsEn(T_HIST);
    expect(hist!.datos).toMatchObject({ concepto: 'impuesto', registroId: 'imp-1', estadoAnterior: 'solicitado', estadoNuevo: 'pagado', usuarioId: 7 });
    expect(espia.insertsEn(T_AUDIT).map((i) => i.datos.resource)).toContain('flito_impuesto');
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'recibo_impuesto', impuestoId: 'imp-1' });
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ esPago: true, valor: '412000', concepto: 'impuesto', soporteAplicadoId: 'sop-1' });
    // Orden dentro de la tx: el soporte antes del impuesto (conciliar nombra el soporte) y el comprobante al final.
    expect(espia.updates.map((u) => u.tabla)).toEqual([T_SOP, T_IMP, T_COMP]);
    expect(marcarPagadoMock).not.toHaveBeenCalled();
    expect(registrarDerechoMock).not.toHaveBeenCalled();
  });

  it('AC2 — tipoDocumento recibo_caja_impuesto → soporte recibo_caja_impuesto; sin fecha_pago leída → pagadoEn = ahora (TZ=UTC); marcado_por_diferencia por evaluarDiferencia (D-5) cuando la diferencia está activa', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-16T15:00:00Z') });
    try {
      const app = await buildApp();
      const e = extraccion(); e[CampoComprobante.FECHA_PAGO] = campo(null, 0); e[CampoComprobante.TIPO_DOCUMENTO] = campo('recibo_caja_impuesto', 0.95);
      armarPago({ extraccion: e, extraccionDestino: destinoImpuesto(), tipoDocumento: 'recibo_caja_impuesto' }, {},
        { imp: [impuesto({ valorLiquidado: '300000', diferenciaActiva: true, tolerancia: '1000' })] });
      const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'impuesto' }));
      expect(res.status).toBe(200);
      const [imp] = espia.updatesEn(T_IMP);
      expect(imp!.datos).toMatchObject({ estado: 'pagado', valorPagado: '412000', marcadoPorDiferencia: true });
      expect(imp!.datos.pagadoEn).toEqual(new Date('2026-09-16T15:00:00Z'));
      expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'recibo_caja_impuesto', impuestoId: 'imp-1' });
    } finally { vi.useRealTimers(); }
  });

  // ── AC3 · derecho ──
  it('AC3 — derecho: trámite aprobado sin derecho → registrarDesdeRevision(tramiteId, extraccionDestino, soporteAplicadoId, ctx con role) TRAS el commit del comprobante; el hijo del consolidado va con tipo derecho_tramite', async () => {
    const app = await buildApp();
    armarPago({ paginas: [2], concepto: 'derecho', extraccionDestino: destinoDerecho() }, { flitEstado: 'aprobado' });
    let alRegistrar = -1;
    registrarDerechoMock.mockImplementation(async () => { alRegistrar = espia.updatesEn(T_COMP).length; return 'der-nuevo'; });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'derecho' }));
    expect(res.status).toBe(200);
    expect(registrarDerechoMock).toHaveBeenCalledTimes(1);
    const [tramiteId, extr, soporteId, ctx] = registrarDerechoMock.mock.calls[0]!;
    expect(tramiteId).toBe(T1);
    expect(extr).toMatchObject({ placa: expect.objectContaining({ valor: 'ABC123' }) });
    expect(soporteId).toBe('sop-hijo');
    expect(ctx).toEqual({ userId: 7, username: 'u@flitsas.io', role: 'financiera' });
    expect(alRegistrar).toBe(1); // la fila del comprobante ya estaba cerrada (commit) cuando el dueño escribió
    expect(espia.insertsEn(T_SOP)[0]!.datos).toMatchObject({ tipo: 'derecho_tramite', storageKey: 'flito/comprobantes/tramites/hijo.pdf' });
    expect(espia.insertsEn(T_SOP)[0]!.datos).not.toHaveProperty('derechoId'); // derecho_id lo ata el dueño al registrar
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ esPago: true, valor: '350000', concepto: 'derecho', soporteAplicadoId: 'sop-hijo' });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: expect.stringContaining('aplicado como pago de derecho al trámite FLIT-ABC001') }));
  });

  it('AC3-M — derecho ya registrado: derechoDeTramite ANTES → 409 ya_pagado { detalle, puedeAdjuntar: true } sin S3, sin tx, sin llamar al dueño (que respondería 400 DerechoError)', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [cabecera({ paginas: [2], extraccionDestino: destinoDerecho() })])
      .select(T_DER, [{ id: 'der-1', tramiteId: T1 }]).select(T_TRAM, [tramite({ flitEstado: 'aprobado' })]);
    registrarDerechoMock.mockRejectedValue(new DerechoError(400, 'Ese trámite ya tiene registrado su derecho de tránsito'));
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'derecho' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), codigo: 'ya_pagado', detalle: 'Ese trámite ya tiene registrado su derecho de tránsito', puedeAdjuntar: true });
    sinEscrituras();
  });

  // ── AC4 · rechazos ──
  it.each([
    ['soat', { soatId: 'soat-1', soatEstado: 'pagado' }, {}, 'Ese SOAT ya está pagado'],
    ['impuesto', {}, { imp: [impuesto({ estado: 'pagado' })] }, 'Ese impuesto ya está pagado'],
  ] as const)('AC4-M — %s ya pagado, consolidado (paginas [2]) → 409 ya_pagado { puedeAdjuntar: true } y NO deja objeto en S3 ni abre tx', async (concepto, tram, extra, detalle) => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [cabecera({ paginas: [2] })]).select(T_TRAM, [tramite(tram)]).select(T_IMP, extra.imp ?? []).select(T_DER, []);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), codigo: 'ya_pagado', detalle, puedeAdjuntar: true });
    sinEscrituras();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it.each([
    ['soat', 'soat_id NULL', { soatId: null }, {}, false],
    ['soat', 'SOAT con_novedad', { soatId: 'soat-1', soatEstado: 'con_novedad' }, {}, true],
    ['soat', 'SOAT pendiente', { soatId: 'soat-1', soatEstado: 'pendiente' }, {}, true],
    ['impuesto', 'sin fila de impuesto', {}, { imp: [] }, false],
    ['impuesto', 'impuesto pendiente', {}, { imp: [impuesto({ estado: 'pendiente' })] }, true],
    ['impuesto', 'impuesto con_novedad', {}, { imp: [impuesto({ estado: 'con_novedad' })] }, true],
    ['derecho', 'trámite no aprobado', { flitEstado: 'en_revision' }, {}, true],
  ] as const)('AC4 — %s · %s → 409 destino_no_admite con puedeAdjuntar según haya destino que atar, sin S3 ni tx', async (concepto, _caso, tram, extra, puedeAdjuntar) => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [cabecera({ paginas: [2] })]).select(T_TRAM, [tramite(tram)]).select(T_IMP, extra.imp ?? []).select(T_DER, []);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'destino_no_admite', detalle: expect.any(String), puedeAdjuntar });
    sinEscrituras();
  });

  it('AC4 — la misma petición con esPago=false sobre un SOAT pagado se adjunta como documentación (camino de #12629): sin guarda, sin dueño, es_pago=false y valor NULL', async () => {
    const app = await buildApp();
    armarAplicar();
    kdb.when.select(T_TRAM, [tramite({ soatEstado: 'pagado' })]).select(T_SOAT, [{ id: 'soat-1', estado: 'pagado' }]);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ esPago: false }));
    expect(res.status).toBe(200);
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'documento_tramite', soatId: 'soat-1' });
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ esPago: false, valor: null });
    expect(marcarPagadoMock).not.toHaveBeenCalled();
    expect(espia.updatesEn(T_SOAT)).toEqual([]);
  });

  it('(R) carrera bajo el bloqueo: el destino se pagó entre la guarda previa y la tx → la guarda dentro de la tx responde 409 ya_pagado y NO escribe (el soporte ya subido a S3 queda huérfano, aceptado)', async () => {
    const app = await buildApp();
    let lecturas = 0;
    kdb.when.selectOnce(T_COMP, [cabecera({ paginas: [2], extraccionDestino: destinoSoat() })]).selectOnce(T_SOP, [soporte]).selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .select(T_TRAM, () => [tramite({ soatId: 'soat-1', soatEstado: ++lecturas >= 3 ? 'pagado' : 'solicitado' })]); // 1ª: guarda previa; 2ª: bloquearTramite; 3ª: guarda en tx
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('ya_pagado');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
    expect(marcarPagadoMock).not.toHaveBeenCalled();
  });

  // ── AC5 · valor como copia acotada ──
  it('AC5 — la copia es acotada: flito-liquidacion/ (HU #12654) y finanzas/ (HU #12653) leen flito_comprobantes SOLO por el leaf expr.ts, desde el service de liquidación y desde valores-documentales + el service de finanzas', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, basename } = await import('node:path');
    const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []; });
    const raiz = join(process.cwd(), 'src/modules');
    // Cada módulo entra por archivos NOMBRADOS y solo a través del leaf `flito-comprobantes.expr`
    // (subconsultas escalares; sin join, sin filtro propio por estado/es_pago): ningún otro archivo
    // nombra la tabla ni el módulo. La liquidación se conectó en la HU #12654 (un solo archivo).
    const PUEDEN: Record<string, string[]> = {
      'flito-liquidacion': ['flito-liquidacion.service.ts'],
      finanzas: ['finanzas.valores-documentales.ts', 'finanzas.service.ts'],
    };
    for (const [modulo, permitidos] of Object.entries(PUEDEN)) {
      const lista = archivos(join(raiz, modulo));
      expect(lista.length).toBeGreaterThan(0);
      for (const f of lista) {
        const texto = readFileSync(f, 'utf8');
        if (permitidos.includes(basename(f))) {
          expect(texto, f).toMatch(/flito-comprobantes\/flito-comprobantes\.expr\.js/);
          expect(texto, f).not.toMatch(/flito-comprobantes\.(service|aplicar|carga|auto|routes|honorarios|duenos)/);
          expect(texto, f).not.toMatch(/(leftJoin|innerJoin)\(flitoComprobantes/);
        } else {
          expect(texto, f).not.toMatch(/flito[-_]comprobantes/);
        }
      }
    }
  });
});

// ═════════════════ AC9 · deuda de #12611 cerrada en routes.ts ═══════════════════════════════════

// ═════════════════ HU #12631 · honorarios: fila documental ═════════════════════════════════════════

describe('HU #12631 — POST /:id/aplicar con esPago=true: fila documental de tramite_digital / logistica / servicios_adicionales', () => {
  const pago = (over: Record<string, unknown> = {}) => ({ tramiteId: T1, concepto: 'tramite_digital', esPago: true, ...over });
  const conValor = (valor: string) => { const e = extraccion(); e[CampoComprobante.VALOR_TOTAL] = campo(valor, 0.95); e[CampoComprobante.CONCEPTO] = campo('tramite_digital', 0.9); return e; };
  const APROBADO = new Date('2026-08-01T15:00:00Z');
  /** El trámite con lo que `tarifaDe` necesita: compañía, tipo y fecha de aprobación (el mock keyed entrega la fila entera). */
  const tramHonorario = (over: Record<string, unknown> = {}) => tramite({ companiaId: 1, tipoTramite: 'MATRICULA', fechaAprobacion: APROBADO, ...over });

  /** Escenario: cabecera con valor leído, soporte, relectura FOR UPDATE, trámite, liquidación (vacía), tarifa, servicios, detalle. */
  function armarHonorario(cab: Record<string, unknown>, extra: { liq?: unknown[] | (() => unknown[]); tarifa?: unknown[]; servicios?: unknown[]; tram?: Record<string, unknown> } = {}) {
    kdb.when
      .selectOnce(T_COMP, [cabecera({ extraccion: conValor('350000'), extraccionDestino: null, ...cab })])
      .selectOnce(T_SOP, [soporte])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .select(T_TRAM, [tramHonorario(extra.tram ?? {})])
      .select(T_LIQ, extra.liq ?? [])
      .select(T_TAR, extra.tarifa ?? [{ valor: '350000.00' }])
      .select(T_SA, extra.servicios ?? [{ total: null }])
      .selectOnce(T_COMP, [filaAplicada({ esPago: true, valor: '350000', concepto: (cab.concepto as string | undefined) ?? 'tramite_digital', tipoDocumento: 'comprobante_pago' })])
      .selectOnce(T_COMP, [{ extraccion: conValor('350000'), extraccionDestino: null }])
      .insert(T_SOP, [{ id: 'sop-hijo' }])
      .update(T_SOP, [{ id: 'sop-1' }])
      .update(T_COMP, [{ id: ID }]);
  }
  const cierre = () => espia.updatesEn(T_COMP)[0]!.datos;
  /** Todas las condiciones `where` de la petición, renderizadas a SQL (qué tablas se leyeron y con qué predicado). */
  const leido = () => espia.condicionesLeidas().map((c) => renderizar(c as never).sql).join('\n');

  // ── AC1 · tarifa de referencia y diferencia ──
  it('AC1 — tramite_digital con tarifa vigente igual al valor: fila aplicado es_pago=true, valor/fecha/número copiados, tarifa_referencia=valor, diferencia 0, NO marcado; soporte tipo comprobante_pago sin FK; tarifaDe con (companiaId, concepto, tipoTramite, fechaAprobacion)', async () => {
    const app = await buildApp();
    armarHonorario({});
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ motivo: 'Pago del trámite digital' }));
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('aplicado');
    expect(res.body.comprobante).toMatchObject({ id: ID, estado: 'aplicado', esPago: true });

    // Orden de bloqueo: comprobante → trámite, en la única tx.
    expect(bloqueos.map((b) => b.tabla)).toEqual(['flito_comprobantes', 'flito_tramites']);
    expect(bloqueos.every((b) => b.modo === 'update')).toBe(true);
    expect(ligadoA(renderizar(bloqueos[1]!.condicion as never), '"flito_tramites"."id"')).toBe(T1);

    // La fila documental.
    expect(cierre()).toMatchObject({
      estado: 'aplicado', esPago: true, concepto: 'tramite_digital', tramiteId: T1, valor: '350000',
      fechaDocumento: '2026-09-10', numeroDocumento: 'POL-1',
      tarifaReferencia: '350000.00', diferenciaTarifa: '0.00', marcadoPorDiferencia: false,
      aplicadoPorId: 7, aplicadoMotivo: 'Pago del trámite digital',
    });
    // El soporte que ve el trámite: tipo comprobante_pago, sin FK de destino (ni soat_id, ni impuesto_id, ni derecho_id).
    const sop = espia.updatesEn(T_SOP)[0]!.datos;
    expect(sop).toEqual({ tipo: 'comprobante_pago' });
    expect(espia.insertsEn(T_SOP)).toEqual([]);
    // La lectura del trámite PROYECTA compania_id / tipo_tramite / fecha_aprobacion (el mock keyed entrega la fila
    // entera aunque el select pida menos: sin esta afirmación, tarifaDe(undefined, …) pasaría verde).
    const proyecciones = kdb.select.mock.calls.map((c) => c[0] as Record<string, unknown> | undefined);
    expect(proyecciones.some((p) => p?.companiaId === flitoTramites.companiaId && p?.tipoTramite === flitoTramites.tipoTramite && p?.fechaAprobacion === flitoTramites.fechaAprobacion)).toBe(true);
    // tarifaDe con la llave exacta: compañía, concepto, tipo MATRICULA, y la vigencia (tstzrange) en la fecha de aprobación (no «ahora»).
    const tarifa = espia.condicionesLeidas().map((c) => renderizar(c as never)).find((q) => q.sql.includes('"flito_tarifas_vigencias"."compania_id"'))!;
    expect(tarifa).toBeDefined();
    expect(ligadoA(tarifa, '"flito_tarifas_vigencias"."compania_id"')).toBe(1);
    expect(ligadoA(tarifa, '"flito_tarifas_vigencias"."concepto"')).toBe('tramite_digital');
    expect(ligadoA(tarifa, '"flito_tarifas_vigencias"."tipo_tramite"')).toBe('MATRICULA');
    expect(tarifa.sql).toContain('tstzrange("flito_tarifas_vigencias"."vigente_desde", "flito_tarifas_vigencias"."vigente_hasta", \'[)\') @>');
    expect(tarifa.params).toContainEqual(APROBADO);
    expect(tarifa.sql).not.toContain('now()');
    // Nada de dueños: ni SOAT ni derecho ni impuesto.
    expect(marcarPagadoMock).not.toHaveBeenCalled();
    expect(registrarDerechoMock).not.toHaveBeenCalled();
    expect(espia.updatesEn(T_IMP)).toEqual([]);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(logLineas.some((l) => JSON.stringify(l).includes('aplicado como pago'))).toBe(true);
  });

  it('AC1 — logistica con tarifa distinta del valor: diferencia = valor − tarifa (≠ 0 → marcado, tolerancia 0); tarifaDe ignora el tipo (tipo_tramite IS NULL)', async () => {
    const app = await buildApp();
    armarHonorario({ concepto: 'logistica' }, { tarifa: [{ valor: '300000.00' }] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'logistica' }));
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ concepto: 'logistica', esPago: true, valor: '350000', tarifaReferencia: '300000.00', diferenciaTarifa: '50000.00', marcadoPorDiferencia: true });
    const tarifa = espia.condicionesLeidas().map((c) => renderizar(c as never)).find((q) => q.sql.includes('"flito_tarifas_vigencias"."compania_id"'))!;
    expect(ligadoA(tarifa, '"flito_tarifas_vigencias"."concepto"')).toBe('logistica');
    expect(tarifa.sql).toContain('"flito_tarifas_vigencias"."tipo_tramite" is null');
  });

  it('AC1-M — sin tarifa configurada (tarifaDe → no_configurada): tarifa_referencia NULL, diferencia = valor, y MARCADO aunque la diferencia sea 0 (valor 0)', async () => {
    const app = await buildApp();
    armarHonorario({ extraccion: conValor('0') }, { tarifa: [] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ esPago: true, valor: '0', tarifaReferencia: null, diferenciaTarifa: '0.00', marcadoPorDiferencia: true });
    // La regla pura: tarifa NULL ⇒ marcado, con diferencia 0 o no (el mutante «solo si |diferencia| > 0» cae aquí).
    expect(calcularDiferencia('0', null)).toEqual({ tarifaReferencia: null, diferenciaTarifa: '0.00', marcadoPorDiferencia: true });
    expect(calcularDiferencia('350000', null)).toEqual({ tarifaReferencia: null, diferenciaTarifa: '350000.00', marcadoPorDiferencia: true });
    expect(calcularDiferencia('350000', 350000)).toEqual({ tarifaReferencia: '350000.00', diferenciaTarifa: '0.00', marcadoPorDiferencia: false });
    expect(calcularDiferencia('349999.5', 350000)).toEqual({ tarifaReferencia: '350000.00', diferenciaTarifa: '-0.50', marcadoPorDiferencia: true });
  });

  it('AC1 — tramite_digital con tipo fuera del catálogo o compañía nula: «no configurada» → marcado (falla cerrado, no adivina)', async () => {
    const app = await buildApp();
    armarHonorario({}, { tram: { tipoTramite: 'RARO' } });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ tarifaReferencia: null, marcadoPorDiferencia: true });
    expect(leido()).not.toContain('"flito_tarifas_vigencias"');
  });

  it('AC1 — servicios_adicionales: tarifa_referencia = SUM(valor) de flito_tramite_servicios_adicionales del trámite (no tarifaDe); la fila se escribe igual (valor copiado, diferencia, marca)', async () => {
    const app = await buildApp();
    armarHonorario({ concepto: 'servicios_adicionales' }, { servicios: [{ total: '120000.00' }] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'servicios_adicionales' }));
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ concepto: 'servicios_adicionales', esPago: true, valor: '350000', tarifaReferencia: '120000.00', diferenciaTarifa: '230000.00', marcadoPorDiferencia: true });
    const sql = leido();
    expect(sql).toContain('"flito_tramite_servicios_adicionales"."tramite_id"');
    expect(sql).not.toContain('"flito_tarifas_vigencias"');
    const suma = espia.condicionesLeidas().map((c) => renderizar(c as never)).find((q) => q.sql.includes('"flito_tramite_servicios_adicionales"."tramite_id"'))!;
    expect(ligadoA(suma, '"flito_tramite_servicios_adicionales"."tramite_id"')).toBe(T1);
  });

  it('AC1 — servicios_adicionales sin servicios asignados: SUM = NULL → tarifa_referencia NULL y marcado', async () => {
    const app = await buildApp();
    armarHonorario({ concepto: 'servicios_adicionales' }, { servicios: [{ total: null }] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'servicios_adicionales' }));
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ tarifaReferencia: null, diferenciaTarifa: '350000.00', marcadoPorDiferencia: true });
  });

  it('AC1 — consolidado (paginas [2]): el hijo recortado se inserta con tipo comprobante_pago bajo el trámite y la fila lo referencia; el original no se toca', async () => {
    const app = await buildApp();
    armarHonorario({ paginas: [2] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledWith(CARPETA_APLICADOS, T1, expect.any(String), RECORTE, 'application/pdf');
    expect(espia.ultimoInsertEn(T_SOP)).toMatchObject({ tipo: 'comprobante_pago', storageKey: 'flito/comprobantes/tramites/hijo.pdf', subidoPorId: 7 });
    expect(espia.updatesEn(T_SOP)).toEqual([]);
    expect(cierre()).toMatchObject({ soporteAplicadoId: 'sop-hijo', esPago: true, tarifaReferencia: '350000.00' });
  });

  // ── AC2 · guardas dentro de la tx ──
  it('AC2 — trámite con fila en flito_liquidaciones → 409 tramite_liquidado { detalle: "Liquidación sellada" } evaluado DENTRO de la tx, tras los dos FOR UPDATE, y nada se escribe (mutante: quitar la guarda)', async () => {
    const app = await buildApp();
    let bloqueosAlLeerLiquidacion = -1;
    armarHonorario({}, { liq: () => { bloqueosAlLeerLiquidacion = bloqueos.length; return [{ id: 'liq-1' }]; } });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), codigo: 'tramite_liquidado', detalle: 'Liquidación sellada' });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(bloqueosAlLeerLiquidacion).toBe(2);
    expect(bloqueos.map((b) => b.tabla)).toEqual(['flito_comprobantes', 'flito_tramites']);
    const liq = espia.condicionesLeidas().map((c) => renderizar(c as never)).find((q) => q.sql.includes('"flito_liquidaciones"."tramite_id"'))!;
    expect(ligadoA(liq, '"flito_liquidaciones"."tramite_id"')).toBe(T1);
    expect(espia.updates).toEqual([]);
    expect(espia.inserts).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
    expect(leido()).not.toContain('"flito_tarifas_vigencias"');
  });

  it('AC2 — la guarda de liquidación es de los HONORARIOS: adjuntar documentación (esPago=false) de un trámite liquidado sigue aplicando (D3)', async () => {
    const app = await buildApp();
    armarHonorario({ tipoDocumento: 'documento_no_pago' }, { liq: [{ id: 'liq-1' }] });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ esPago: false }));
    expect(res.status).toBe(200);
    expect(cierre()).toMatchObject({ esPago: false, valor: null });
    expect(cierre()).not.toHaveProperty('tarifaReferencia');
    expect(leido()).not.toContain('"flito_liquidaciones"');
  });

  it('AC2-M — el 23505 del índice idx_flito_comprobantes_valor_documental se traduce a 409 valor_ya_documentado { comprobanteAnteriorId } buscando el anterior por (trámite, concepto, aplicado, es_pago) FUERA de la tx abortada (mutante: propagar el 23505 crudo → 500)', async () => {
    const app = await buildApp();
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "idx_flito_comprobantes_valor_documental"'), { code: '23505', constraint: INDICE_VALOR_DOCUMENTAL });
    // Sin las filas del detalle: la tercera lectura de flito_comprobantes es la búsqueda del anterior, fuera de la tx.
    kdb.when
      .selectOnce(T_COMP, [cabecera({ extraccion: conValor('350000'), extraccionDestino: null })])
      .selectOnce(T_SOP, [soporte])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .select(T_TRAM, [tramHonorario()])
      .select(T_LIQ, []).select(T_TAR, [{ valor: '350000.00' }])
      .update(T_SOP, [{ id: 'sop-1' }])
      .update(T_COMP, () => { throw pgError; })
      .selectOnce(T_COMP, [{ id: 'comp-anterior' }]);
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), codigo: 'valor_ya_documentado', comprobanteAnteriorId: 'comp-anterior' });
    expect(auditMock).not.toHaveBeenCalled();
    const anterior = espia.condicionesLeidas().map((c) => renderizar(c as never)).filter((q) => q.sql.includes('"flito_comprobantes"."concepto"')).at(-1)!;
    expect(anterior).toBeDefined();
    expect(ligadoA(anterior, '"flito_comprobantes"."tramite_id"')).toBe(T1);
    expect(ligadoA(anterior, '"flito_comprobantes"."concepto"')).toBe('tramite_digital');
    expect(ligadoA(anterior, '"flito_comprobantes"."estado"')).toBe('aplicado');
    expect(ligadoA(anterior, '"flito_comprobantes"."es_pago"')).toBe(true);
    // Solo ESE 23505: otro índice único, u otro código, se propaga tal cual.
    expect(esDuplicadoDocumental(pgError)).toBe(true);
    expect(esDuplicadoDocumental({ cause: pgError })).toBe(true);
    expect(esDuplicadoDocumental(Object.assign(new Error('x'), { code: '23505', constraint: 'otro_indice' }))).toBe(false);
    expect(esDuplicadoDocumental(Object.assign(new Error('x'), { code: '23503', constraint: INDICE_VALOR_DOCUMENTAL }))).toBe(false);
  });

  it('AC2-M — otro error en la tx (no el 23505 documental) NO se traduce: `aplicar` lo relanza tal cual y no busca ningún anterior', async () => {
    const otro = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    armarHonorario({});
    kdb.when.update(T_COMP, () => { throw otro; });
    await expect(aplicar(ID, pago(), { userId: 7, username: 'u@flitsas.io', role: 'financiera' })).rejects.toBe(otro);
    expect(espia.condicionesLeidas().map((c) => renderizar(c as never)).filter((q) => q.sql.includes('"flito_comprobantes"."es_pago"'))).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC2 — 400 valor_requerido ANTES de S3 (consolidado): sin valorTotal ni tras confirmar campos, no se recorta, no se sube, no hay tx; con el valor confirmado por la persona sí aplica', async () => {
    const app = await buildApp();
    const sinValor = extraccion();
    sinValor[CampoComprobante.VALOR_TOTAL] = campo(null, 0);
    kdb.when.selectOnce(T_COMP, [cabecera({ extraccion: sinValor, extraccionDestino: null, paginas: [2] })]);
    const r400 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago());
    expect(r400.status).toBe(400);
    expect(r400.body).toMatchObject({ codigo: 'valor_requerido' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(recortarMock).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);

    armarHonorario({ extraccion: sinValor, paginas: [2] });
    const r200 = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth())
      .send(pago({ campos: { [CampoComprobante.VALOR_TOTAL]: '350000' }, motivo: 'Valor tomado del documento' }));
    expect(r200.status).toBe(200);
    expect(cierre()).toMatchObject({ valor: '350000', tarifaReferencia: '350000.00', diferenciaTarifa: '0.00', marcadoPorDiferencia: false });
  });

  // ── AC3 · autogestión no bloquea ──
  it('AC3 — compañía con logistica_autogestionable=true: aplicar logistica con esPago=true → 200 aplicado; aplicar NO consulta la autogestión (ni clients.logistica_autogestionable ni flito_excepciones_autogestion) ni la convierte en 409 (mutante: no_gestionado → 409)', async () => {
    const app = await buildApp();
    kdb.when.select('clients', [{ id: 1, logisticaAutogestionable: true }]).select('flito_excepciones_autogestion', []);
    armarHonorario({ concepto: 'logistica' }, { tram: { logisticaAutogestionable: true } });
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send(pago({ concepto: 'logistica' }));
    expect(res.status).toBe(200);
    expect(res.body.resultado).toBe('aplicado');
    expect(cierre()).toMatchObject({ concepto: 'logistica', esPago: true, valor: '350000', tarifaReferencia: '350000.00', marcadoPorDiferencia: false });
    const sql = leido();
    expect(sql).not.toContain('logistica_autogestionable');
    expect(sql).not.toContain('flito_excepciones_autogestion');
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

});

// ═════════════════ HU #12632 · aplicar con { automatico: true } ═════════════════════════════════

describe('HU #12632 — aplicar(id, body, ctx, { automatico: true }): la marca automática de la fila', () => {
  const APROBADO = new Date('2026-08-01T15:00:00Z');
  const conValor = () => { const e = extraccion(); e[CampoComprobante.VALOR_TOTAL] = campo('350000', 0.95); e[CampoComprobante.CONCEPTO] = campo('tramite_digital', 0.95); e[CampoComprobante.ES_COMPROBANTE_PAGO] = campo('true', 0.95); return e; };
  /** Honorario (sin dueño): el camino más corto que cierra como pago. */
  function armarHonorario() {
    kdb.when
      .selectOnce(T_COMP, [cabecera({ extraccion: conValor(), extraccionDestino: null, cruce: 'id_flit' })])
      .selectOnce(T_SOP, [soporte])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .select(T_TRAM, [tramite({ companiaId: 1, tipoTramite: 'MATRICULA', fechaAprobacion: APROBADO })])
      .select(T_LIQ, [])
      .select(T_TAR, [{ valor: '350000.00' }])
      .select(T_SA, [{ total: null }])
      .selectOnce(T_COMP, [filaAplicada({ esPago: true, valor: '350000', concepto: 'tramite_digital', cruce: 'id_flit', aplicadoAutomaticamente: true, aplicadoPorNombre: null })])
      .selectOnce(T_COMP, [{ extraccion: conValor(), extraccionDestino: null }])
      .update(T_SOP, [{ id: 'sop-1' }])
      .update(T_COMP, [{ id: ID }]);
  }
  const ctx = { userId: 7, username: 'u@flitsas.io', role: 'financiera' };
  const body = { tramiteId: T1, concepto: 'tramite_digital', esPago: true, campos: {} };

  it('AC1-M — automático: aplicado_automaticamente=true, aplicado_por_id NULL, aplicado_en = now (TZ=UTC, reloj fijo); mismo cierre (estado, trámite, concepto, cruce sugerido, valor, soporte) y el ctx real firma el soporte', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-17T15:00:00Z') });
    try {
      armarHonorario();
      const dto = await aplicar(ID, body, ctx, { automatico: true });
      expect(dto).toMatchObject({ id: ID, estado: 'aplicado', aplicadoAutomaticamente: true });
      const [comp] = espia.updatesEn(T_COMP);
      expect(comp!.datos).toMatchObject({
        estado: 'aplicado', esPago: true, valor: '350000', tramiteId: T1, concepto: 'tramite_digital', cruce: 'id_flit', soporteAplicadoId: 'sop-1',
        aplicadoAutomaticamente: true, aplicadoPorId: null, aplicadoMotivo: null, motivoPendiente: null, detallePendiente: null,
      });
      expect(comp!.datos.aplicadoEn).toEqual(new Date('2026-09-17T15:00:00Z'));
      // La misma guarda de estado y los mismos bloqueos que el camino manual.
      const q = renderizar(comp!.condiciones[0] as never);
      expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
      expect(ligadoA(q, '"flito_comprobantes"."estado"')).toBe('pendiente');
      expect(bloqueos.map((b) => b.tabla)).toEqual(['flito_comprobantes', 'flito_tramites']);
      expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ tipo: 'comprobante_pago' });
      expect(logLineas.some((l) => JSON.stringify(l).includes('"automatico":true'))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('sin opciones (manual): aplicado_automaticamente=false y aplicado_por_id = la persona', async () => {
    armarHonorario();
    await aplicar(ID, body, ctx);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ aplicadoAutomaticamente: false, aplicadoPorId: 7 });
  });

  it('AC1-M2 — la ruta ignora `automatico` en el cuerpo: por HTTP siempre es manual', async () => {
    const app = await buildApp();
    armarHonorario();
    const res = await request(app).post(`${BASE}/${ID}/aplicar`).set('Authorization', await auth()).send({ ...body, automatico: true, motivo: 'Pago del trámite digital' });
    expect(res.status).toBe(200);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ aplicadoAutomaticamente: false, aplicadoPorId: 7 });
  });
});

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

// ═════════════════ HU #12654 · POST /:id/diferencia/aceptar (AC6) ═════════════════════════════════
//
// Aceptar la diferencia es CONSTANCIA, no dinero: escribe SOLO `diferencia_aceptada_por_id/en/motivo`
// en la fila del comprobante dentro de una tx con `FOR UPDATE` del comprobante; no toca valor, tarifa
// de referencia, diferencia ni marca; no lee ni escribe `flito_liquidaciones` (se permite con el
// trámite sellado) ni bloquea el trámite.
//
// Mutantes nombrados:
//   · AC6-M1 aceptar sin comprobar `marcado_por_diferencia` → «sin marca ⇒ 409» cae.
//   · AC6-M2 segunda aceptación devolviendo 200 → «ya aceptada ⇒ 409» cae (fuera y bajo el bloqueo).
//   · AC6-M3 ruta sin `exigirFuncion('comprobantes.diferencia.aceptar')` → «auditor → 403» y el cierre
//     de reconducción (260 montajes) caen.
//   · AC6-M4 quitar el `.for('update')` de la relectura → «tx + FOR UPDATE sobre flito_comprobantes» cae.
//   · AC6-M5 escribir `valor`/`diferenciaTarifa`/`marcadoPorDiferencia` en el UPDATE → «no toca valor…» cae.
//   · AC4-M  leer `flito_liquidaciones` o bloquear el trámite para rechazar el sellado → «sellada no cambia» cae.

describe('HU #12654 — POST /:id/diferencia/aceptar', () => {
  const pendiente = (over: Record<string, unknown> = {}) => ({ estado: 'aplicado', esPago: true, marcadoPorDiferencia: true, diferenciaAceptadaEn: null, ...over });
  const MOTIVO = 'Pactado con el cliente por correo';
  const aceptar = async (app: express.Express, body: unknown, role: 'admin' | 'financiera' | 'auditor' = 'financiera') =>
    request(app).post(`${BASE}/${ID}/diferencia/aceptar`).set('Authorization', await auth(role)).send(body);

  it('exige comprobantes.diferencia.aceptar (auditor → 403; admin y financiera la tienen de partida); motivo ausente, <5 o >500 → 400 datos_invalidos sin tocar la base', async () => {
    const app = await buildApp();
    expect(operacionesDePartida('financiera')).toContain('comprobantes.diferencia.aceptar');
    expect(operacionesDePartida('admin')).toContain('comprobantes.diferencia.aceptar');
    expect(operacionesDePartida('auditor')).not.toContain('comprobantes.diferencia.aceptar');
    expect((await aceptar(app, { motivo: MOTIVO }, 'auditor')).status).toBe(403);
    for (const body of [{}, { motivo: 'abcd' }, { motivo: '   ab   ' }, { motivo: 'x'.repeat(501) }]) {
      const res = await aceptar(app, body);
      expect(res.status, JSON.stringify(body).slice(0, 30)).toBe(400);
      expect(res.body.codigo).toBe('datos_invalidos');
    }
    expect(kdb.select).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
  });

  it('200 { ok: true }: tx con FOR UPDATE del comprobante; UPDATE de SOLO por_id/en/motivo(trim) condicionado a id + sin aceptar; valor, tarifa_referencia, diferencia_tarifa y marca intactos; audit', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [pendiente()]).selectOnce(T_COMP, [pendiente()]).update(T_COMP, [{ id: ID }]);
    const res = await aceptar(app, { motivo: `  ${MOTIVO}  ` }, 'admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    // El bloqueo: FOR UPDATE sobre flito_comprobantes por id, y NINGUNO sobre el trámite.
    expect(bloqueos.map((b) => [b.tabla, b.modo])).toEqual([[T_COMP, 'update']]);
    expect(ligadoA(renderizar(bloqueos[0]!.condicion as never), '"flito_comprobantes"."id"')).toBe(ID);
    // El UPDATE: exactamente las tres columnas de la constancia (+ updated_at).
    expect(espia.updatesEn(T_COMP)).toHaveLength(1);
    const [u] = espia.updatesEn(T_COMP);
    expect(Object.keys(u!.datos).sort()).toEqual(['diferenciaAceptadaEn', 'diferenciaAceptadaMotivo', 'diferenciaAceptadaPorId', 'updatedAt']);
    expect(u!.datos).toMatchObject({ diferenciaAceptadaPorId: 7, diferenciaAceptadaMotivo: MOTIVO });
    expect(u!.datos.diferenciaAceptadaEn).toBeInstanceOf(Date);
    for (const k of ['valor', 'tarifaReferencia', 'diferenciaTarifa', 'marcadoPorDiferencia', 'estado', 'esPago']) expect(u!.datos).not.toHaveProperty(k);
    const q = renderizar(u!.condiciones[0] as never);
    expect(ligadoA(q, '"flito_comprobantes"."id"')).toBe(ID);
    expect(q.sql).toContain('"flito_comprobantes"."diferencia_aceptada_en" is null');
    // Nada en flito_liquidaciones ni en el trámite: ni lectura ni escritura.
    expect(espia.updatesEn(T_LIQ)).toEqual([]);
    expect(espia.insertsEn(T_LIQ)).toEqual([]);
    const leidas = espia.condicionesLeidas().map((c) => renderizar(c as never).sql).join('\n');
    expect(leidas).not.toContain('flito_liquidaciones');
    expect(leidas).not.toContain('flito_tramites');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update', resource: 'flito_comprobante', resourceId: ID, detail: `Diferencia aceptada: ${MOTIVO}` }));
  });

  it('AC4 — sellada no cambia: con el trámite liquidado se acepta igual (solo escribe en flito_comprobantes; ninguna consulta a flito_liquidaciones)', async () => {
    const app = await buildApp();
    // Si el código leyera la liquidación para rechazar, este `select` respondería «sellada» y el 200 caería.
    kdb.when.selectOnce(T_COMP, [pendiente()]).selectOnce(T_COMP, [pendiente()]).select(T_LIQ, [{ id: 'liq-1' }]).update(T_COMP, [{ id: ID }]);
    const res = await aceptar(app, { motivo: MOTIVO });
    expect(res.status).toBe(200);
    expect(kdb.select.mock.calls.length).toBe(2);
    expect(espia.updatesEn(T_LIQ)).toEqual([]);
    expect(espia.updatesEn(T_COMP)).toHaveLength(1);
  });

  it('inexistente → 404 sin tx; no aplicado como pago (pendiente / es_pago=false) → 409 sin_diferencia; sin marca → 409 (AC6-M1); ya aceptada → 409 (AC6-M2); nada se escribe', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, []);
    const r404 = await aceptar(app, { motivo: MOTIVO });
    expect(r404.status).toBe(404);
    expect(r404.body.codigo).toBe('no_encontrado');
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ estado: 'pendiente', esPago: null }, 'no está aplicado como pago'],
      [{ estado: 'aplicado', esPago: false }, 'no está aplicado como pago'],
      [{ marcadoPorDiferencia: false }, 'no está marcado por diferencia'],
      [{ diferenciaAceptadaEn: new Date('2026-09-16T10:00:00Z') }, 'ya fue aceptada'],
    ];
    for (const [over, detalle] of casos) {
      kdb.when.selectOnce(T_COMP, [pendiente(over)]);
      const res = await aceptar(app, { motivo: MOTIVO });
      expect(res.status, JSON.stringify(over)).toBe(409);
      expect(res.body).toMatchObject({ codigo: 'sin_diferencia', detalle: expect.stringContaining(detalle) });
    }
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(espia.updates).toEqual([]);
  });

  it('(R) carrera: pendiente fuera de la tx pero ya aceptada bajo el FOR UPDATE → 409 sin_diferencia y CERO escrituras (la constancia no se reescribe)', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [pendiente()]).selectOnce(T_COMP, [pendiente({ diferenciaAceptadaEn: new Date() })]).update(T_COMP, [{ id: ID }]);
    const res = await aceptar(app, { motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('sin_diferencia');
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(bloqueos.map((b) => [b.tabla, b.modo])).toEqual([[T_COMP, 'update']]);
    expect(espia.updates).toEqual([]);
  });

  it('AC9: id no-UUID → 404 sin tocar la base', async () => {
    const app = await buildApp();
    const res = await request(app).post(`${BASE}/abc/diferencia/aceptar`).set('Authorization', await auth()).send({ motivo: MOTIVO });
    expect(res.status).toBe(404);
    expect(kdb.select).not.toHaveBeenCalled();
  });
});
