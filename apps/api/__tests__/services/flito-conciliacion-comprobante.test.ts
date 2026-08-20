// FLITO Conciliación — el comprobante del pago PSE (HU #11678, Feature #11623, CF-06).
//
// Lo que se prueba aquí es lo que solo se ve desde la ruta: quién puede subirlo y reemplazarlo, qué
// se rechaza en el borde, qué queda escrito y —sobre todo— que un rechazo no deje un archivo de
// 15 MB colgando en el almacenamiento.
//
// `checkMagicNumber` (→ `file-type`) NO se mockea: los adjuntos llevan bytes que de verdad son un
// PDF, o que de verdad NO lo son. Mockear el sniffer dejaría el test verde aunque la lista blanca
// estuviera mal enganchada, que es justo lo que el AC1 vino a cubrir.
//
// `firmarDescargaEntidad` tampoco: el AC2 pide un enlace FIRMADO y CADUCABLE, y con la firma
// mockeada la afirmación sería sobre una cadena inventada. Lo único mockeado del almacenamiento son
// las dos operaciones que hablan con MinIO.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const subirMock = vi.fn();
const borrarMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/storage.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  uploadEntityDocument: (...a: unknown[]) => subirMock(...a),
  deleteEntityDocument: (...a: unknown[]) => borrarMock(...a),
}));

const COMPANIA = 3;
const BOLETA_ID = 'b0000000-0000-4000-8000-000000000001';
const SOPORTE_ID = '5090000a-0000-4000-8000-000000000001';
const CLAVE = 'clientes/acme/conciliacion-comprobantes/b0000000/1_abc_comprobante.pdf';
const AHORA = new Date('2026-08-20T15:00:00Z');
const RUTA = `/api/flito/conciliacion/boletas/${BOLETA_ID}/comprobante`;

/** Bytes que `file-type` reconoce como un PDF real. */
const PDF_REAL = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)]);
/** Un `.exe`, un `.html` o cualquier cosa renombrada: pasa el `fileFilter`, muere en los bytes. */
const NO_ES_PDF = Buffer.from('<html><script>alert(1)</script></html>');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.routes.js');
  app.use('/api/flito/conciliacion', router);
  return app;
}

/**
 * Un usuario distinto por llamada: las rutas del comprobante llevan su propio `rateLimiter` por
 * usuario (20/min) con store en memoria, y un `sub` fijo haría que el test 21 recibiera un 429.
 */
let siguienteUsuario = 500;
const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: (siguienteUsuario += 1), username: 'financiera@flit.io', role })}`;

function filaBoleta(over: Record<string, unknown> = {}) {
  return { estado: 'conciliada', companiaId: COMPANIA, ...over };
}

function filaSoporte(over: Record<string, unknown> = {}) {
  return {
    id: SOPORTE_ID,
    nombreArchivo: 'comprobante-pse.pdf',
    contentType: 'application/pdf',
    storageKey: CLAVE,
    tamanoBytes: 73,
    subidoEn: AHORA,
    subidoPorNombre: 'financiera@flit.io',
    ...over,
  };
}

/** Boleta conciliada, todavía sin comprobante, y el cliente con su carpeta configurada. */
function escenarioSubidaOk(): void {
  kdb.when
    .select('flito_conciliacion_boletas', [filaBoleta()])
    .select('flito_soportes', [])
    .select('clients', [{ id: COMPANIA, document: '900123456', flitoCarpetaStorage: 'clientes/acme' }])
    .insert('flito_soportes', [filaSoporte()]);
  subirMock.mockResolvedValue(CLAVE);
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  auditMock.mockClear();
  piiMock.mockClear();
  subirMock.mockReset();
  borrarMock.mockClear();
});

// ─────────────────── AC5: quién puede subirlo y reemplazarlo ─────────────────

describe('AC5 — proveedor y auditor no tocan el comprobante', () => {
  const prohibidos: TestRole[] = ['proveedor', 'auditor', 'transito', 'gestor_impuestos', 'conductor'];

  for (const rol of prohibidos) {
    it(`403 para ${rol} en POST, PUT y GET`, async () => {
      const app = await buildApp();
      const token = await auth(rol);

      const post = await request(app).post(RUTA).set('Authorization', token)
        .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });
      const put = await request(app).put(RUTA).set('Authorization', token)
        .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });
      const get = await request(app).get(RUTA).set('Authorization', token);

      expect([post.status, put.status, get.status]).toEqual([403, 403, 403]);
      // Y el 403 se decide ANTES de tocar el almacenamiento: si no, un rol sin permiso podría
      // llenar el bucket con archivos que nunca se van a registrar.
      expect(subirMock).not.toHaveBeenCalled();
    });
  }

  it('sin token → 401 en las tres', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA)).status).toBe(401);
    expect((await request(app).post(RUTA)).status).toBe(401);
    expect((await request(app).put(RUTA)).status).toBe(401);
  });
});

// ─────────────────── AC1: la subida ─────────────────────────────────────────

describe('AC1 — POST /boletas/:id/comprobante', () => {
  it('financiera sube el PDF: 201, con tipo comprobante_pse y colgado de la boleta', async () => {
    escenarioSubidaOk();

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'comprobante-pse.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(201);
    const escrito = espia.ultimoInsertEn('flito_soportes');
    expect(escrito).toMatchObject({
      tipo: 'comprobante_pse',
      conciliacionBoletaId: BOLETA_ID,
      contentType: 'application/pdf',
      storageKey: CLAVE,
    });
    // El hash es el del archivo, no un uuid nuevo: es lo que permite reconocer un duplicado.
    expect(escrito.hash).toMatch(/^[a-f0-9]{64}$/);
    // Y NO cuelga de ningún SOAT ni de ninguna factura: el CHECK de exclusividad lo exige.
    expect(escrito.soatId ?? null).toBeNull();
    expect(escrito.siigoFacturaId ?? null).toBeNull();
  });

  it('admin también: el CF-08 son los dos roles, no solo financiera', async () => {
    escenarioSubidaOk();
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('admin'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
  });

  it('el archivo va a la carpeta del CLIENTE de la boleta, no a una carpeta común', async () => {
    escenarioSubidaOk();
    await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(subirMock).toHaveBeenCalledWith(
      'clientes/acme/conciliacion-comprobantes', BOLETA_ID, 'c.pdf', expect.anything(), 'application/pdf',
    );
  });

  it('la respuesta trae el enlace firmado, nunca la clave del almacenamiento', async () => {
    escenarioSubidaOk();
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.body.url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
    expect(JSON.stringify(r.body)).not.toContain('storageKey');
  });

  it('AC5 — la subida autorizada queda auditada, y el detalle no repite el nombre del archivo', async () => {
    escenarioSubidaOk();
    await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'comprobante-ABC123.pdf', contentType: 'application/pdf' });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, entrada] = auditMock.mock.calls[0];
    expect(entrada).toMatchObject({
      action: 'create', resource: 'flito_conciliacion_boleta', resourceId: BOLETA_ID,
    });
    // El nombre lo escribe el cliente y puede traer una placa dentro: no se copia a la bitácora.
    expect(entrada.detail).not.toContain('ABC123');
    expect(entrada.detail).toContain('Comprobante PSE adjuntado');
  });

  it('un .exe renombrado a .pdf → 400 por los BYTES, y SIN objeto en el almacenamiento', async () => {
    escenarioSubidaOk();

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', NO_ES_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_invalido');
    // Lo que importa del AC1: el rechazo ocurre ANTES de subir, así que no hay nada que borrar.
    expect(subirMock).not.toHaveBeenCalled();
    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
  });

  it('un MIME fuera de la lista blanca → 400 con motivo NUESTRO, sin hacerle eco al cliente', async () => {
    escenarioSubidaOk();

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.docx', contentType: 'application/msword' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El comprobante tiene que ser PDF, JPG o PNG.');
    // El MIME que declaró el cliente no vuelve en la respuesta: es una cadena ajena.
    expect(r.body.error).not.toContain('msword');
    expect(subirMock).not.toHaveBeenCalled();
  });

  it('sin archivo → 400 y no un 500 del error handler', async () => {
    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'));
    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_invalido');
  });

  it('si el registro falla DESPUÉS de subir, el objeto se borra: nada huérfano', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [])
      .select('clients', [{ id: COMPANIA, document: '900123456', flitoCarpetaStorage: 'clientes/acme' }]);
    subirMock.mockResolvedValue(CLAVE);
    // El índice único parcial gana la carrera con otra subida simultánea.
    kdb.insert.mockImplementation(() => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('comprobante_ya_existe');
    expect(borrarMock).toHaveBeenCalledWith(CLAVE);
  });

  it('la boleta que ya tiene comprobante → 409 y ni siquiera se sube el nuevo', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [filaSoporte()]);

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('comprobante_ya_existe');
    expect(subirMock).not.toHaveBeenCalled();
    expect(borrarMock).not.toHaveBeenCalled();
  });

  it('boleta CARGADA → 409 boleta_no_conciliada: el comprobante documenta un pago ya asentado', async () => {
    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'cargada' })]);

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('boleta_no_conciliada');
    expect(subirMock).not.toHaveBeenCalled();
  });

  it('boleta DESCARTADA → 409 con su propio código', async () => {
    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'descartada' })]);

    const r = await request(await buildApp()).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('boleta_descartada');
  });

  it('boleta inexistente → 404, y un id que no es uuid también', async () => {
    kdb.when.select('flito_conciliacion_boletas', []);
    const app = await buildApp();

    const noExiste = await request(app).post(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });
    const malFormado = await request(app)
      .post('/api/flito/conciliacion/boletas/no-soy-uuid/comprobante')
      .set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(noExiste.status).toBe(404);
    expect(malFormado.status).toBe(404);
    expect(subirMock).not.toHaveBeenCalled();
  });
});

// ─────────────────── Reemplazar ─────────────────────────────────────────────

describe('PUT /boletas/:id/comprobante — reemplazar', () => {
  it('descarta el anterior y sube el nuevo, en una sola transacción', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [filaSoporte({ id: 'viejo-0000-4000-8000-000000000001' })])
      .select('clients', [{ id: COMPANIA, document: '900123456', flitoCarpetaStorage: 'clientes/acme' }])
      .update('flito_soportes', [])
      .insert('flito_soportes', [filaSoporte()]);
    subirMock.mockResolvedValue(CLAVE);

    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'el-bueno.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(200);
    // El anterior se DESCARTA, no se borra: sigue siendo la prueba de lo que se adjuntó antes.
    expect(espia.updatesEn('flito_soportes')[0].datos).toEqual({ descartado: true });
    expect(espia.insertsEn('flito_soportes')).toHaveLength(1);
    // Y su archivo tampoco se borra del almacenamiento: eso sería destruir evidencia.
    expect(borrarMock).not.toHaveBeenCalled();
  });

  it('reemplazar sin comprobante previo también vale: crea el primero, sin 404 inútil', async () => {
    escenarioSubidaOk();
    const r = await request(await buildApp()).put(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(200);
    expect(espia.updatesEn('flito_soportes')).toHaveLength(0);
  });

  it('el reemplazo queda auditado como update, no como create', async () => {
    escenarioSubidaOk();
    await request(await buildApp()).put(RUTA).set('Authorization', await auth('financiera'))
      .attach('archivo', PDF_REAL, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'update' });
  });
});

// ─────────────────── AC2: verlo desde la boleta ─────────────────────────────

describe('AC2 — el comprobante en el detalle de la boleta y su descarga', () => {
  it('GET /comprobante devuelve una firma FRESCA, con caducidad', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [filaSoporte()]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      nombreArchivo: 'comprobante-pse.pdf', contentType: 'application/pdf',
    });
    expect(r.body.url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
    // La clave del almacenamiento va DENTRO del token firmado, no como campo propio de la respuesta.
    expect(r.body.storageKey).toBeUndefined();
  });

  it('la caducidad es real: el `exp` es futuro y va firmado junto a la clave', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [filaSoporte()]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth('admin'));
    const { verificarDescargaEntidad } = await import('../../src/services/storage.js');
    const params = new URLSearchParams(r.body.url.split('?')[1]);

    expect(Number(params.get('exp'))).toBeGreaterThan(Date.now());
    expect(verificarDescargaEntidad(params.get('key')!, params.get('exp')!, params.get('sig')!)).toBe(true);
    // Y una clave distinta con la misma firma NO pasa: el token está atado al archivo.
    expect(verificarDescargaEntidad('otra/clave', params.get('exp')!, params.get('sig')!)).toBe(false);
  });

  it('boleta sin comprobante → 404 con su código, no una URL de nada', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', []);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('comprobante_no_existe');
  });

  it('el detalle de la boleta trae el comprobante con su enlace firmado', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [{
        b: {
          id: BOLETA_ID, referencia: 'BOL-000123', companiaId: COMPANIA, concepto: 'soat',
          estado: 'conciliada', archivoNombre: 'REPORTE.xlsx', filas: 1, totalDeclarado: '740800.00',
          totalCruzado: '740800.00', fechaPago: '2026-08-13', cargadaPorNombre: 'fin@flit.io',
          conciliadaEn: AHORA, conciliadaPorNombre: 'fin@flit.io', createdAt: AHORA,
        },
        companiaNombre: 'ACME S.A.S.',
      }])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soportes', [filaSoporte()])
      .select('flito_soat', [])
      .select('flito_bolsa_movimientos', []);

    const r = await request(await buildApp())
      .get(`/api/flito/conciliacion/boletas/${BOLETA_ID}`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body.comprobante).toMatchObject({
      id: SOPORTE_ID, nombreArchivo: 'comprobante-pse.pdf', contentType: 'application/pdf',
      tamanoBytes: 73, subidoPorNombre: 'financiera@flit.io',
    });
    expect(r.body.comprobante.url).toMatch(/^\/api\/files\?key=.*&exp=\d+&sig=[a-f0-9]{64}$/);
  });

  it('boleta sin comprobante → el detalle trae `null`, no el campo ausente', async () => {
    // La ficha decide entre sus tres momentos con este valor: un `undefined` la dejaría sin saber
    // si es «todavía no hay» o «el backend no me lo mandó».
    kdb.when
      .select('flito_conciliacion_boletas', [{
        b: {
          id: BOLETA_ID, referencia: 'BOL-000123', companiaId: COMPANIA, concepto: 'soat',
          estado: 'cargada', archivoNombre: 'R.xlsx', filas: 1, totalDeclarado: '1.00',
          totalCruzado: null, fechaPago: '2026-08-13', cargadaPorNombre: 'fin@flit.io',
          conciliadaEn: null, conciliadaPorNombre: null, createdAt: AHORA,
        },
        companiaNombre: 'ACME S.A.S.',
      }])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soportes', []);

    const r = await request(await buildApp())
      .get(`/api/flito/conciliacion/boletas/${BOLETA_ID}`)
      .set('Authorization', await auth('financiera'));

    expect(r.body.comprobante).toBeNull();
  });
});

// ─────────────────── PII: el rastro de los rechazos que entregan el cuadre ───

describe('el rastro de PII no depende de acordarse en cada catch', () => {
  const RUTA_SERVICIO = '../../src/modules/flito-conciliacion/flito-conciliacion.service.js';
  const RUTA_ROUTER = '../../src/modules/flito-conciliacion/flito-conciliacion.routes.js';

  it('un rechazo que DEVUELVE el cuadre queda registrado, venga del handler que venga', async () => {
    // Observación del gate de la HU #11677, resuelta aquí: `registrarAccesoDelRechazo` colgaba del
    // catch de `conciliar` y de ningún otro. Un 409 que devuelve hasta 500 pólizas y placas es una
    // lectura de datos personales aunque su código HTTP diga que algo salió mal, y la garantía no
    // puede depender de que quien añada el próximo rechazo se acuerde.
    //
    // Se prueba sobre el DETALLE —un handler que antes NO registraba en su catch— empujándole un
    // error con la forma que dispara el registro. Es la única manera de afirmar la regla sin
    // esperar a que exista un segundo rechazo con cuadre en el cuerpo.
    vi.resetModules();
    const real = await vi.importActual<typeof import(
      '../../src/modules/flito-conciliacion/flito-conciliacion.service.js'
    )>(RUTA_SERVICIO);
    vi.doMock(RUTA_SERVICIO, () => ({
      ...real,
      detalleBoleta: vi.fn().mockRejectedValue(new real.ConciliacionError(
        409, 'boleta_incompleta', 'Alguna línea dejó de cuadrar.',
        { boleta: { referencia: 'BOL-000123', lineas: [{ id: 'l1' }, { id: 'l2' }] } },
      )),
    }));

    try {
      const app = express();
      app.use(express.json());
      const { default: router } = await import(RUTA_ROUTER);
      app.use('/api/flito/conciliacion', router);

      const r = await request(app).get(`/api/flito/conciliacion/boletas/${BOLETA_ID}`)
        .set('Authorization', await auth('financiera'));

      expect(r.status).toBe(409);
      expect(piiMock).toHaveBeenCalledTimes(1);
      expect(piiMock.mock.calls[0][1]).toMatchObject({
        resourceTipo: 'flito_conciliacion_boleta',
        accion: 'read',
        camposAccedidos: ['numero_poliza', 'placa'],
      });
      // La referencia, no el uuid ni ninguna póliza: es lo que cabe en `motivo` y no es PII.
      expect(piiMock.mock.calls[0][1].motivo).toContain('BOL-000123');
      expect(piiMock.mock.calls[0][1].motivo).toContain('2 líneas');
    } finally {
      vi.doUnmock(RUTA_SERVICIO);
      vi.resetModules();
    }
  });

  it('un rechazo SIN cuadre en el cuerpo no registra nada: no hubo datos personales que ver', async () => {
    // El helper decide por la FORMA del cuerpo y no por el código. Un 409 que solo dice «esta boleta
    // ya se concilió» no entrega ni una placa, y anotarlo como lectura de PII ensuciaría el log que
    // existe para responder «¿quién vio mis datos?».
    kdb.when.select('flito_conciliacion_boletas', [{
      id: BOLETA_ID, referencia: 'BOL-000123', companiaId: COMPANIA, concepto: 'soat',
      estado: 'conciliada', archivoNombre: 'R.xlsx', filas: 1, totalDeclarado: '1.00',
      totalCruzado: null, fechaPago: '2026-08-13', cargadaPorNombre: 'f@f.io',
      conciliadaEn: AHORA, conciliadaPorNombre: 'f@f.io', createdAt: AHORA,
    }]);

    const r = await request(await buildApp())
      .post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/recruzar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('boleta_ya_conciliada');
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('las tres rutas del comprobante no registran acceso a PII: no entregan ni póliza ni placa', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_soportes', [filaSoporte()]);

    await request(await buildApp()).get(RUTA).set('Authorization', await auth('financiera'));

    expect(piiMock).not.toHaveBeenCalled();
  });
});
