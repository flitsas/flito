process.env.TZ = 'UTC';
// HU #12611 (Feature #12605, Épica #12245) — Las cinco rutas de `/api/flito/comprobantes` con el router
// real, `testToken` y el MOTOR de permisos (calco de flito-recibo-caja.routes.test.ts): el 403 sale de
// `exigirFuncion`, no de un stub. `db` es el mock keyed por tabla; el listado y el detalle se afirman
// sobre SQL RENDERIZADO (el mock ignora `where` y `orderBy`, memoria del proyecto).
//
// La app se monta SIN el fallback 400 genérico: el error handler de aquí responde 500, así que un 400
// solo puede venir del envoltorio de multer o del Zod de la ruta.
//
// Mutantes nombrados:
//   · AC1-M `exigirFuncion('impuestos.cola.ver')` en GET / → «auditor → 403» deja de serlo y el cierre
//     de reconducción cae (montaje ≠ foto).
//   · AC2-M3 quitar `limits.files` → «6 archivos → 400 sin escribir» cae.
//   · AC6-M1 (mutante (7) del diseño) devolver `extraccion` en el listado → «forma del DTO» cae.
//   · AC6-M2 quitar un filtro de `condicionesListado` → su `it` de SQL renderizado cae.
//   · AC6-M3 cambiar el orden → «created_at DESC, nombre, paginas[0]» cae.
//   · AC7-M `nivelDe(0)` → 'baja' → «confianza 0 → nivel null» cae.
//   · AC8-M quitar `Cache-Control: no-store` → cae; `?aplicado=1` sin hijo → 404.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { CampoComprobante, CARGA_MASIVA_MAX_BYTES_ARCHIVO, MotivoPendienteComprobante } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { renderizar, ligadoA } from '../helpers/sql-ligado.js';
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

const uploadMock = vi.fn();
const presignMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock, presignedGetEntityDocument: presignMock, getEntityDocumentStream: vi.fn(),
}));
const particionarMock = vi.fn();
const leerMock = vi.fn();
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: particionarMock, leerSubDocumento: leerMock }));

const { fijarFuenteDePermisos, invalidarPermisosDe } = await import('../../src/shared/permisos-efectivos.js');
const { flitoComprobantes, flitoSoportes } = await import('../../src/db/schema.js');
const { condicionesListado, ordenListado, PROYECCION_LISTA, nivelDe } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const BASE = '/api/flito/comprobantes';
const LOTE = '9c1d4d5e-3b7a-4c2e-9f0a-1b2c3d4e5f60';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const PDF = Buffer.from('%PDF-1.4\n%comprobante\n');
const TEXTO = Buffer.from('no soy un pdf');

const campo = (valor: string | null, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
const lectura = () => ({
  extraccion: {
    [CampoComprobante.TIPO_DOCUMENTO]: campo('factura_soat', 0.95), [CampoComprobante.ES_COMPROBANTE_PAGO]: campo('true', 0.95),
    [CampoComprobante.CONCEPTO]: campo('soat', 0.95), [CampoComprobante.PLACA]: campo('ABC123', 0.9), [CampoComprobante.VIN]: campo(null, 0),
    [CampoComprobante.ID_FLIT]: campo('FLIT-1', 0.7), [CampoComprobante.VALOR_TOTAL]: campo('350000', 0.95),
    [CampoComprobante.FECHA_PAGO]: campo('2026-09-10', 0.95), [CampoComprobante.NUMERO_DOCUMENTO]: campo('POL-1', 0.95), [CampoComprobante.EMISOR]: campo('Sura', 0.9),
  },
  tipoDestino: 'factura_soat' as const,
  extraccionDestino: null,
});

/** Una fila del listado tal como la devolvería la consulta (con `extraccion` de más, para el mutante (7)). */
const filaLista = (over: Record<string, unknown> = {}) => ({
  id: ID, loteId: LOTE, estado: 'pendiente', motivoPendiente: 'leido', detallePendiente: null, tipoDocumento: 'factura_soat', esPago: true,
  concepto: 'soat', tramiteId: null, tramiteIdFlit: null, tramitePlaca: null, cruce: null, placaLeida: 'ABC123', vinLeido: null, idFlitLeido: 'FLIT-1',
  valor: '350000.00', fechaDocumento: '2026-09-10', numeroDocumento: 'POL-1', emisor: 'Sura', marcadoPorDiferencia: false, diferenciaTarifa: null,
  diferenciaAceptadaEn: null, paginas: [2, 3], archivoNombre: 'lote.pdf', archivoContentType: 'application/pdf',
  createdAt: new Date('2026-09-15T12:00:00Z'), aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
  subidoPorNombre: 'fin@flitsas.io', aplicadoPorNombre: null, descartadoPorNombre: null,
  extraccion: lectura().extraccion, extraccionDestino: null,
  ...over,
});

const espia = crearEspia(kdb);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
  app.use(BASE, router);
  // 500 a propósito: un 400 solo puede venir de la ruta.
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
const auth = async (role: TestRole, sub = 7) => `Bearer ${await testToken({ sub, username: 'u@flitsas.io', role })}`;

let nComp = 0;
beforeEach(() => {
  kdb.reset(); espia.reiniciar(); nComp = 0;
  auditMock.mockClear(); intentoDenegadoMock.mockClear();
  uploadMock.mockReset(); presignMock.mockReset(); particionarMock.mockReset(); leerMock.mockReset();
  uploadMock.mockResolvedValue('flito/comprobantes/lote/x.pdf');
  presignMock.mockResolvedValue('https://s3.local/firmada?X-Amz-Expires=300');
  particionarMock.mockImplementation(async (a: { buffer: Buffer; nombre: string; contentType: string }) =>
    ({ documentos: [{ buffer: a.buffer, contentType: a.contentType, paginas: null, nombre: a.nombre }], paginasNoLeidas: [], metodo: 'unico' }));
  leerMock.mockResolvedValue(lectura());
  kdb.when.select(T_SOP, []).select(T_COMP, []).insert(T_SOP, [{ id: 'sop-1' }]).insert(T_COMP, () => [{ id: `c-${++nComp}` }]);
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

function nadaEscrito() {
  expect(kdb.transaction).not.toHaveBeenCalled();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(espia.inserts).toEqual([]);
}

// ═════════════════ AC1 · las cinco rutas con su función; admin y financiera de partida ══════════

describe('AC1 — cada ruta exige su función del motor; el reparto de partida es admin + financiera', () => {
  const RUTAS: [string, (r: request.SuperTest<request.Test>) => request.Test, string][] = [
    ['comprobantes.lote.cargar', (r) => r.post(BASE).field('loteId', LOTE).attach('archivos', PDF, 'a.pdf'), 'POST /'],
    ['comprobantes.cola.ver', (r) => r.get(BASE), 'GET /'],
    ['comprobantes.comprobante.ver', (r) => r.get(`${BASE}/${ID}`), 'GET /:id'],
    ['comprobantes.archivo.descargar', (r) => r.get(`${BASE}/${ID}/archivo`), 'GET /:id/archivo'],
    ['comprobantes.comprobante.releer', (r) => r.post(`${BASE}/${ID}/releer`), 'POST /:id/releer'],
  ];

  it.each(RUTAS)('%s: sin token → 401; auditor (sin la función) → 403 del motor sin tocar la base', async (codigo, pedir) => {
    const app = await buildApp();
    expect((await pedir(request(app))).status).toBe(401);
    expect(operacionesDePartida('auditor')).not.toContain(codigo);
    const res = await pedir(request(app)).set('Authorization', await auth('auditor'));
    expect(res.status).toBe(403);
    // `sin_modulo`: el auditor no tiene NINGUNA función de `comprobantes`, y el motor lo dice antes de mirar la función.
    expect(res.body).toMatchObject({ funcion: codigo, motivo: 'sin_modulo' });
    expect(kdb.select).not.toHaveBeenCalled();
    nadaEscrito();
  });

  it.each(RUTAS)('%s: un usuario con las otras cuatro pero sin ESTA → 403 sin_funcion (cada ruta exige la suya)', async (codigo, pedir) => {
    const app = await buildApp();
    const otras = RUTAS.map(([c]) => c).filter((c) => c !== codigo);
    // El bearer PRIMERO (`testToken` re-fija la fuente de prueba); luego la fuente propia. Y la caché de
    // permisos dura 60 s y el sub 11 se reutiliza entre casos: se invalida antes de cada uno.
    const bearer = await auth('financiera', 11);
    invalidarPermisosDe(11);
    fijarFuenteDePermisos(async (sub) => (sub === 11 ? { rol: 'financiera', tipoPrincipal: 'interno' as const, funcionesDelRol: otras, excepciones: [] } : null));
    const res = await pedir(request(app)).set('Authorization', bearer);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ funcion: codigo, motivo: 'sin_funcion' });
    nadaEscrito();
  });

  it('admin y financiera tienen las cinco de partida; auditor, gestor_impuestos y proveedor ninguna', () => {
    for (const [codigo] of RUTAS) {
      expect(operacionesDePartida('admin')).toContain(codigo);
      expect(operacionesDePartida('financiera')).toContain(codigo);
      for (const rol of ['auditor', 'gestor_impuestos', 'proveedor', 'cliente']) expect(operacionesDePartida(rol), `${rol} ${codigo}`).not.toContain(codigo);
    }
  });

  it('financiera pasa la guarda de GET / → 200', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ total: 0 }]).selectOnce(T_COMP, []);
    const res = await request(app).get(BASE).set('Authorization', await auth('financiera'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });
});

// ═════════════════ AC2 · la carga por HTTP ═══════════════════════════════════════════════════════

describe('AC2 — POST / multipart archivos[] (1..5) + loteId', () => {
  it('200 ResultadoCargaComprobantes con aplicados: [] y audit con cuentas (sin contenido)', async () => {
    const app = await buildApp();
    const res = await request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', LOTE).attach('archivos', PDF, 'pol.pdf');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ aplicados: [], duplicados: [], fallidos: [], documentos: 1 });
    expect(res.body.pendientes).toEqual([expect.objectContaining({ archivo: 'pol.pdf', comprobanteId: 'c-1', motivo: MotivoPendienteComprobante.LEIDO })]);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'upload', resource: 'flito_comprobante_lote', resourceId: LOTE }));
    expect(JSON.stringify(auditMock.mock.calls[0]![1])).not.toContain('ABC123');
  });

  it('AC2-M3: 6 archivos → 400 archivo_invalido sin escribir nada', async () => {
    const app = await buildApp();
    let r = request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', LOTE);
    for (let i = 0; i < 6; i++) r = r.attach('archivos', PDF, `a${i}.pdf`);
    const res = await r;
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    nadaEscrito();
  });

  it('un archivo de más de 15 MiB → 400 archivo_invalido sin escribir nada', async () => {
    const app = await buildApp();
    const grande = Buffer.concat([PDF, Buffer.alloc(CARGA_MASIVA_MAX_BYTES_ARCHIVO)]);
    const res = await request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', LOTE).attach('archivos', grande, 'grande.pdf');
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    nadaEscrito();
  });

  it('loteId que no es uuid → 400 datos_invalidos; sin archivos → 400 archivo_invalido', async () => {
    const app = await buildApp();
    const r1 = await request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', 'lote-1').attach('archivos', PDF, 'a.pdf');
    expect(r1.status).toBe(400);
    expect(r1.body.codigo).toBe('datos_invalidos');
    const r2 = await request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', LOTE);
    expect(r2.status).toBe(400);
    expect(r2.body.codigo).toBe('archivo_invalido');
    nadaEscrito();
  });

  it('un .pdf que es texto plano (MIME application/pdf declarado) → 200 con ese archivo en fallidos y el otro persistido', async () => {
    const app = await buildApp();
    const res = await request(app).post(BASE).set('Authorization', await auth('financiera')).field('loteId', LOTE)
      .attach('archivos', TEXTO, { filename: 'falso.pdf', contentType: 'application/pdf' })
      .attach('archivos', PDF, 'real.pdf');
    expect(res.status).toBe(200);
    expect(res.body.fallidos).toEqual([expect.objectContaining({ archivo: 'falso.pdf', detalle: 'No es PDF ni imagen admitida' })]);
    expect(res.body.pendientes.map((p: { archivo: string }) => p.archivo)).toEqual(['real.pdf']);
    expect(espia.insertsEn(T_SOP)).toHaveLength(1);
  });

  it('OCR caído en toda la tanda → 200 (nunca 500), todo persistido con ocr_no_disponible', async () => {
    const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    leerMock.mockRejectedValue(new OcrNoDisponibleError(503, 'caído'));
    const app = await buildApp();
    const res = await request(app).post(BASE).set('Authorization', await auth('admin')).field('loteId', LOTE)
      .attach('archivos', PDF, 'a.pdf').attach('archivos', Buffer.from('%PDF-1.5\n%b\n'), 'b.pdf');
    expect(res.status).toBe(200);
    expect(res.body.pendientes).toHaveLength(2);
    for (const p of res.body.pendientes) expect(p).toMatchObject({ motivo: 'ocr_no_disponible', detalle: 'Sin lectura (OCR no disponible)' });
    expect(espia.insertsEn(T_COMP)).toHaveLength(2);
  });
});

// ═════════════════ AC6 · la cola ═══════════════════════════════════════════════════════════════

describe('AC6 — GET / (cola)', () => {
  it('AC6-M1: forma del DTO — trae archivo, paginas, llaves, autorías y NUNCA extraccion/extraccionDestino; la proyección tampoco las pide', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ total: 1 }]).selectOnce(T_COMP, [filaLista()]);
    const res = await request(app).get(BASE).set('Authorization', await auth('financiera'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const item = res.body.items[0];
    expect(item).toEqual({
      id: ID, loteId: LOTE, estado: 'pendiente', motivoPendiente: 'leido', detallePendiente: null, tipoDocumento: 'factura_soat', esPago: true,
      concepto: 'soat', tramite: null, cruce: null, placaLeida: 'ABC123', vinLeido: null, idFlitLeido: 'FLIT-1', valor: 350000,
      fechaDocumento: '2026-09-10', numeroDocumento: 'POL-1', emisor: 'Sura', marcadoPorDiferencia: false, diferenciaTarifa: null,
      diferenciaAceptada: false, paginas: [2, 3], archivo: { nombre: 'lote.pdf', contentType: 'application/pdf' },
      createdAt: '2026-09-15T12:00:00.000Z', aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
      subidoPorNombre: 'fin@flitsas.io', aplicadoPorNombre: null, descartadoPorNombre: null,
    });
    expect(item).not.toHaveProperty('extraccion');
    expect(item).not.toHaveProperty('extraccionDestino');
    expect(Object.keys(PROYECCION_LISTA)).not.toContain('extraccion');
    expect(Object.keys(PROYECCION_LISTA)).not.toContain('extraccionDestino');
  });

  it('pageSize por defecto 50, tope 200 (201 → 400), page mínimo 1', async () => {
    const app = await buildApp();
    kdb.when.select(T_COMP, [{ total: 0 }]);
    expect((await request(app).get(`${BASE}?pageSize=200&page=2`).set('Authorization', await auth('admin'))).body).toMatchObject({ page: 2, pageSize: 200 });
    expect((await request(app).get(`${BASE}?pageSize=201`).set('Authorization', await auth('admin'))).status).toBe(400);
    expect((await request(app).get(`${BASE}?page=0`).set('Authorization', await auth('admin'))).status).toBe(400);
    expect((await request(app).get(`${BASE}?estado=roto`).set('Authorization', await auth('admin'))).status).toBe(400);
  });

  it('AC6-M2: los filtros se afirman sobre SQL renderizado (predicado exportado Y el where que la consulta usó)', async () => {
    const f = { estado: 'pendiente' as const, concepto: 'soat' as const, motivo: 'leido', loteId: LOTE, tramiteId: ID, page: 1, pageSize: 50 };
    const q = renderizar(condicionesListado(f)!);
    expect(ligadoA(q, '"flito_comprobantes"."estado"')).toBe('pendiente');
    expect(ligadoA(q, '"flito_comprobantes"."concepto"')).toBe('soat');
    expect(ligadoA(q, '"flito_comprobantes"."motivo_pendiente"')).toBe('leido');
    expect(ligadoA(q, '"flito_comprobantes"."lote_id"')).toBe(LOTE);
    expect(ligadoA(q, '"flito_comprobantes"."tramite_id"')).toBe(ID);
    expect(condicionesListado({ page: 1, pageSize: 50 })).toBeUndefined();
    // Ningún literal repetido como parámetro (Bug #12058).
    expect(new Set(q.params).size).toBe(q.params.length);

    // Y la consulta real ató ese predicado: el where del conteo y el del listado llevan los mismos valores.
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ total: 0 }]).selectOnce(T_COMP, []);
    await request(app).get(`${BASE}?estado=pendiente&concepto=soat&motivo=leido&loteId=${LOTE}`).set('Authorization', await auth('admin'));
    const leidas = espia.condicionesLeidas();
    expect(leidas).toHaveLength(2);
    for (const cond of leidas) {
      const r = renderizar(cond as never);
      expect(ligadoA(r, '"flito_comprobantes"."estado"')).toBe('pendiente');
      expect(ligadoA(r, '"flito_comprobantes"."concepto"')).toBe('soat');
      expect(ligadoA(r, '"flito_comprobantes"."motivo_pendiente"')).toBe('leido');
      expect(ligadoA(r, '"flito_comprobantes"."lote_id"')).toBe(LOTE);
    }
  });

  it('AC6-M3: orden created_at DESC, luego nombre de archivo, luego paginas[0] (SQL renderizado)', () => {
    const sqls = ordenListado().map((o) => renderizar(o).sql);
    expect(sqls).toEqual([
      '"flito_comprobantes"."created_at" desc',
      '"flito_soportes"."nombre_archivo" asc',
      '("flito_comprobantes"."paginas"->>0)::int ASC NULLS FIRST',
    ]);
  });
});

// ═════════════════ AC7 · el detalle ═════════════════════════════════════════════════════════════

describe('AC7 — GET /:id', () => {
  it('ComprobanteDetalleDto con campos[] (10 universales + los del destino con prefijo), nivel del servidor, candidatos: [] y Cache-Control: no-store', async () => {
    const app = await buildApp();
    const ext = { ...lectura().extraccion, [CampoComprobante.VIN]: campo(null, 0), [CampoComprobante.ID_FLIT]: campo('FLIT-1', 0.7), [CampoComprobante.EMISOR]: campo('Sura', 0.3) };
    kdb.when.selectOnce(T_COMP, [filaLista()]).selectOnce(T_COMP, [{ extraccion: ext, extraccionDestino: { numeroPoliza: campo('POL-1', 0.95) } }]);
    const res = await request(app).get(`${BASE}/${ID}`).set('Authorization', await auth('financiera'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.candidatos).toEqual([]);
    expect(res.body.tramite).toBeNull();
    expect(res.body).not.toHaveProperty('extraccion');
    const campos = res.body.campos as { campo: string; nivel: string | null; confianza: number; valor: string | null }[];
    expect(campos.map((c) => c.campo)).toEqual([
      'tipoDocumento', 'esComprobantePago', 'concepto', 'placa', 'vin', 'idFlit', 'valorTotal', 'fechaPago', 'numeroDocumento', 'emisor', 'destino.numeroPoliza',
    ]);
    const nivel = (campo: string) => campos.find((c) => c.campo === campo)!.nivel;
    expect(nivel('tipoDocumento')).toBe('alta');   // 0.95 ≥ umbral 0.85
    expect(nivel('placa')).toBe('alta');           // 0.9
    expect(nivel('idFlit')).toBe('media');         // 0.7
    expect(nivel('emisor')).toBe('baja');          // 0.3
    expect(nivel('vin')).toBeNull();               // 0 → null (AC7-M)
    expect(nivel('destino.numeroPoliza')).toBe('alta');
    expect(campos.find((c) => c.campo === 'vin')).toMatchObject({ valor: null, confianza: 0, confiable: false, nivel: null });
  });

  it('AC7-M: nivelDe — ≥ umbral alta; ≥ 0.6 media; > 0 baja; 0 → null (nunca «baja»)', () => {
    expect(nivelDe(0.85, 0.85)).toBe('alta');
    expect(nivelDe(0.849, 0.85)).toBe('media');
    expect(nivelDe(0.6, 0.85)).toBe('media');
    expect(nivelDe(0.59, 0.85)).toBe('baja');
    expect(nivelDe(0.01, 0.85)).toBe('baja');
    expect(nivelDe(0, 0.85)).toBeNull();
    // El umbral manda: con 0.95 de umbral, 0.9 ya no es alta.
    expect(nivelDe(0.9, 0.95)).toBe('media');
  });

  it('sin OCR (extraccion {}) los 10 campos salen con confianza 0 y nivel null', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [filaLista({ motivoPendiente: 'ocr_no_disponible' })]).selectOnce(T_COMP, [{ extraccion: {}, extraccionDestino: null }]);
    const res = await request(app).get(`${BASE}/${ID}`).set('Authorization', await auth('financiera'));
    expect(res.body.campos).toHaveLength(10);
    for (const c of res.body.campos) expect(c).toMatchObject({ valor: null, confianza: 0, confiable: false, nivel: null });
  });

  it('404 no_encontrado si no existe', async () => {
    const app = await buildApp();
    const res = await request(app).get(`${BASE}/${ID}`).set('Authorization', await auth('financiera'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'El comprobante no existe', codigo: 'no_encontrado' });
  });
});

// ═════════════════ AC8 · abrir el archivo ═══════════════════════════════════════════════════════

describe('AC8 — GET /:id/archivo', () => {
  it('302 a la URL prefirmada de 300 s del soporte_id con Cache-Control: no-store', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ soporteId: 'sop-1', soporteAplicadoId: null }]).selectOnce(T_SOP, [{ storageKey: 'flito/comprobantes/lote/x.pdf' }]);
    const res = await request(app).get(`${BASE}/${ID}/archivo`).set('Authorization', await auth('financiera'));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://s3.local/firmada?X-Amz-Expires=300');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(presignMock).toHaveBeenCalledWith('flito/comprobantes/lote/x.pdf', 300);
    // Preguntó por el soporte correcto (SQL renderizado del segundo SELECT).
    const q = renderizar(espia.condicionesLeidas()[1] as never);
    expect(ligadoA(q, '"flito_soportes"."id"')).toBe('sop-1');
  });

  it('AC8-M: ?aplicado=1 sin soporte_aplicado_id → 404; con él, firma el hijo', async () => {
    const app = await buildApp();
    kdb.when.selectOnce(T_COMP, [{ soporteId: 'sop-1', soporteAplicadoId: null }]);
    const r404 = await request(app).get(`${BASE}/${ID}/archivo?aplicado=1`).set('Authorization', await auth('financiera'));
    expect(r404.status).toBe(404);
    expect(r404.body.codigo).toBe('no_encontrado');
    expect(presignMock).not.toHaveBeenCalled();

    kdb.when.selectOnce(T_COMP, [{ soporteId: 'sop-1', soporteAplicadoId: 'sop-hijo' }]).selectOnce(T_SOP, [{ storageKey: 'flito/comprobantes/hijo.pdf' }]);
    const r302 = await request(app).get(`${BASE}/${ID}/archivo?aplicado=1`).set('Authorization', await auth('financiera'));
    expect(r302.status).toBe(302);
    const q = renderizar(espia.condicionesLeidas().at(-1) as never);
    expect(ligadoA(q, '"flito_soportes"."id"')).toBe('sop-hijo');
  });

  it('comprobante inexistente → 404 sin firmar nada', async () => {
    const app = await buildApp();
    const res = await request(app).get(`${BASE}/${ID}/archivo`).set('Authorization', await auth('admin'));
    expect(res.status).toBe(404);
    expect(presignMock).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC6 (cierre) · el módulo no escribe en ningún destino ═════════════════════════

describe('AC6 — ninguna ruta del módulo escribe en los destinos ni en el reporte (grep del fuente)', () => {
  it('cero insert(/update( sobre flito_soat, flito_impuestos, flito_derechos_tramite, flito_tarifas, flito_liquidaciones o finanzas; cero requireRole(', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '../../src/modules/flito-comprobantes');
    const fuentes = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(fuentes.length).toBeGreaterThanOrEqual(4); // ocr, service, carga, routes
    const todo = fuentes.join('\n');
    for (const tabla of ['flitoSoat', 'flitoImpuestos', 'flitoDerechosTramite', 'flitoTarifas', 'flitoLiquidaciones']) {
      expect(todo, tabla).not.toMatch(new RegExp(`(insert|update|delete)\\(${tabla}\\b`));
      expect(todo, tabla).not.toMatch(new RegExp(`\\b${tabla}\\b`));
    }
    expect(todo).not.toMatch(/modules\/finanzas\//);
    expect(todo).not.toMatch(/requireRole\(/);
    // Lo único que se escribe: el soporte y el comprobante (carga) y el comprobante (releer).
    // Solo los builders de drizzle (`db.`/`tx.`): `createHash().update(buf)` no es una escritura.
    const escrituras = [...todo.matchAll(/\b(?:db|tx)\.(insert|update|delete)\((\w+)\)/g)].map((m) => `${m[1]}(${m[2]})`).sort();
    expect([...new Set(escrituras)]).toEqual(['insert(flitoComprobantes)', 'insert(flitoSoportes)', 'update(flitoComprobantes)']);
  });
});
