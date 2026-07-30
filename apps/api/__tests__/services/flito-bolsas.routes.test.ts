// FLITO Bolsas — fronteras HTTP de /api/flito/bolsas (HU #11121).
//
// La bolsa es dinero: lo que se prueba aquí es QUIÉN entra (AC3), qué se rechaza en el borde antes
// de tocar el libro, que un cliente sin bolsa sea un 404 con mensaje y no un 500, y que un
// comprobante subido no quede huérfano si la recarga no cuaja. El cálculo del saldo vive en
// flito-bolsas.test.ts; aquí drizzle, el almacenamiento y la auditoría están mockeados.
//
// El olfateo de magic-number (`checkMagicNumber` → librería `file-type`) NO se mockea: los adjuntos
// llevan bytes que de verdad son PDF o PNG. Mockear el sniffer dejaría el test verde aunque la
// allowlist estuviera mal enganchada, que es justo lo que la auditoría vino a cubrir; y con bytes
// reales el test también documenta qué se acepta.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

// El comprobante no viaja a MinIO de verdad: lo que importa es que la ruta lo exija, lo archive
// antes de mover el saldo y lo borre si el movimiento no llega a asentarse.
const uploadMock = vi.fn().mockResolvedValue('clientes/acme/bolsas-recargas/comprobante.pdf');
const deleteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  deleteEntityDocument: deleteMock,
  firmarDescargaEntidad: vi.fn().mockReturnValue('/api/files?key=k'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('https://s3/k'),
}));

const COMPANIA = 3;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const MOV_ID = '22222222-2222-2222-2222-222222222222';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const AHORA = new Date('2026-03-04T15:00:00Z');
const STORAGE_KEY = 'clientes/acme/bolsas-recargas/comprobante.pdf';

/** Bytes que `file-type` reconoce como PDF real, no solo un nombre acabado en .pdf. */
const PDF_REAL = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)]);
/**
 * PNG de 1x1 completo (firma + IHDR + IDAT + IEND). La firma de 8 bytes suelta no basta:
 * `file-type` necesita la cabecera IHDR para reconocerlo, igual que cualquier visor.
 */
const PNG_REAL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-bolsas/flito-bolsas.routes.js');
  app.use('/api/flito/bolsas', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: 'financiera@flit.io', role })}`;

/** POST de recarga con comprobante válido; `campos` sobreescribe o añade campos del formulario. */
function postRecarga(app: express.Express, token: string, campos: Record<string, string> = {}) {
  const req = request(app).post(`/api/flito/bolsas/${COMPANIA}/recargas`).set('Authorization', token);
  for (const [k, v] of Object.entries({ valor: '500000', ...campos })) req.field(k, v);
  return req.attach('soporte', PDF_REAL, { filename: 'comprobante.pdf', contentType: 'application/pdf' });
}

/** Fila de flito_bolsas tal como la devuelve el join con clients. */
const filaBolsa = {
  id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
  saldo: '150000.00', ultimaRecargaValor: '500000.00', ultimaRecargaEn: AHORA,
};

/** Movimiento ya asentado, como sale de `returning()`. */
const filaMovimiento = {
  id: MOV_ID, bolsaId: BOLSA_ID, companiaId: COMPANIA, tipo: 'entrada', origen: 'recarga',
  concepto: null, organismoCodigo: null, tramiteId: null,
  valor: '500000', saldoResultante: '500000', periodo: '2026-03', fecha: '2026-03-04',
  observacion: null, soporteId: SOPORTE_ID, registradoPorId: 9, registradoPorNombre: 'financiera@flit.io',
  llaveIdempotencia: null, createdAt: AHORA,
};

const filaCliente = { id: COMPANIA, document: '900123456', flitoCarpetaStorage: 'clientes/acme' };

/** Todo lo que necesita una recarga feliz: cliente, bolsa, soporte y movimiento. */
function escenarioRecargaOk(): void {
  kdb.when
    .select('clients', [filaCliente])
    .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }])
    .insert('flito_soportes', [{ id: SOPORTE_ID }])
    .insert('flito_bolsa_movimientos', [filaMovimiento])
    .update('flito_bolsas', []);
}

beforeEach(() => {
  kdb.reset();
  uploadMock.mockClear();
  deleteMock.mockClear();
  auditMock.mockClear();
});

// ─────────────────────────── Autenticación ───────────────────────────────────

describe('bolsas — sin token no se ve ni se mueve dinero', () => {
  it('GET /:companiaId sin Authorization → 401', async () => {
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}`);
    expect(r.status).toBe(401);
  });

  it('POST de recarga sin Authorization → 401 (y nada se archiva)', async () => {
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .field('valor', '500000')
      .attach('soporte', PDF_REAL, { filename: 'comprobante.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(401);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── AC3: solo Admin y Financiera ────────────────────

describe('bolsas — AC3: la bolsa solo la ven y la mueven Administración y Financiera', () => {
  it('rol transito → 403 en la bolsa, en los movimientos y en la recarga', async () => {
    // El Feature es explícito: ningún otro rol accede a los movimientos crudos. El consolidado
    // para los demás llega como reporte en una HU posterior, no por estos endpoints.
    const app = await buildApp();
    const token = await auth('transito');

    const bolsa = await request(app).get(`/api/flito/bolsas/${COMPANIA}`).set('Authorization', token);
    const movs = await request(app).get(`/api/flito/bolsas/${COMPANIA}/movimientos`).set('Authorization', token);
    const recarga = await postRecarga(app, token);

    expect([bolsa.status, movs.status, recarga.status]).toEqual([403, 403, 403]);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('el consolidado tampoco es público entre roles: transito → 403', async () => {
    // Es el saldo prepago de TODOS los clientes: filtrarlo por un endpoint agregado sería la
    // misma fuga por otra puerta.
    kdb.when.select('flito_bolsas', [{ clientes: 4, saldoTotal: '1200000.00' }]);
    const r = await request(await buildApp()).get('/api/flito/bolsas/consolidado').set('Authorization', await auth('transito'));
    expect(r.status).toBe(403);
  });

  it('auditor, que sí lee otros módulos, tampoco entra a la bolsa', async () => {
    kdb.when.select('flito_bolsas', [filaBolsa]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}`).set('Authorization', await auth('auditor'));
    expect(r.status).toBe(403);
  });

  it('rol financiera SÍ ve la bolsa de su cliente', async () => {
    kdb.when.select('flito_bolsas', [filaBolsa]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: BOLSA_ID, companiaNombre: 'ACME S.A.S.', saldo: 150000 });
  });

  it('rol financiera SÍ lee el libro de movimientos', async () => {
    kdb.when.select('flito_bolsa_movimientos', [filaMovimiento]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/movimientos`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: MOV_ID, tipo: 'entrada', origen: 'recarga', valor: 500000 });
  });
});

// ─────────────────────────── GET de la bolsa ─────────────────────────────────

describe('GET /:companiaId — leer la bolsa', () => {
  it('cliente sin bolsa → 404 con mensaje, no un 500', async () => {
    // Que un cliente no tenga bolsa es lo normal antes de su primera recarga: la UI necesita
    // distinguir «aún no tiene» de «se cayó el servicio».
    kdb.when.select('flito_bolsas', []);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}`).set('Authorization', await auth('admin'));

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('El cliente aún no tiene bolsa');
  });

  it('id de compañía que no es un número → 400', async () => {
    const r = await request(await buildApp()).get('/api/flito/bolsas/abc').set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Compañía inválida');
  });
});

// ─────────────────────────── GET de movimientos ──────────────────────────────

describe('GET /:companiaId/movimientos — filtros', () => {
  it('periodo mal formado → 400 (no se consulta el libro con basura)', async () => {
    const r = await request(await buildApp())
      .get(`/api/flito/bolsas/${COMPANIA}/movimientos?periodo=marzo-2026`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Filtros inválidos');
    expect(kdb.select).not.toHaveBeenCalled();
  });

  it('mes 13 tampoco pasa: el periodo es contable, no texto libre', async () => {
    const r = await request(await buildApp())
      .get(`/api/flito/bolsas/${COMPANIA}/movimientos?periodo=2026-13`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });

  it('periodo bien formado → 200', async () => {
    kdb.when.select('flito_bolsa_movimientos', [filaMovimiento]);
    const r = await request(await buildApp())
      .get(`/api/flito/bolsas/${COMPANIA}/movimientos?periodo=2026-03`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body[0].periodo).toBe('2026-03');
  });
});

// ─────────────────────────── POST: validación del borde ──────────────────────

describe('POST /:companiaId/recargas — validación del borde', () => {
  it('sin archivo adjunto → 400: una entrada de dinero sin comprobante no es auditable', async () => {
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .field('valor', '500000');

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Adjunta el soporte de la recarga');
  });

  it('valor 0 → 400 con el mismo mensaje que da el servicio (AC4)', async () => {
    // El borde y el dominio dicen lo mismo a propósito: quien recarga no debería ver dos textos
    // distintos según por dónde se cortó la validación.
    const r = await postRecarga(await buildApp(), await auth('admin'), { valor: '0' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor de la recarga debe ser mayor que cero');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('valor negativo → 400 y el comprobante ni se sube', async () => {
    const r = await postRecarga(await buildApp(), await auth('admin'), { valor: '-500000' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor de la recarga debe ser mayor que cero');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('valor no numérico → 400 con el mensaje de negocio, no con la jerga de zod', async () => {
    // Antes salía «Expected number, received nan», que es lo que acababa leyendo el operador.
    const r = await postRecarga(await buildApp(), await auth('admin'), { valor: 'quinientos mil' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor de la recarga debe ser mayor que cero');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('valor por encima del techo de la columna → 400, no un 500 de Postgres', async () => {
    kdb.when.select('clients', [filaCliente]).select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }]);
    const r = await postRecarga(await buildApp(), await auth('admin'), { valor: '1000000000000' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor de la recarga excede el máximo admitido');
  });

  it('fecha imposible de calendario → 400 (el regex sola no basta)', async () => {
    kdb.when.select('clients', [filaCliente]).select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }]);
    const r = await postRecarga(await buildApp(), await auth('admin'), { fecha: '2026-02-31' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('La fecha del movimiento no es válida');
  });

  it('fecha futura → 400', async () => {
    kdb.when.select('clients', [filaCliente]).select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }]);
    const r = await postRecarga(await buildApp(), await auth('admin'), { fecha: '2099-01-01' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('La fecha del movimiento no puede ser futura');
  });

  it('compañía inexistente al archivar el comprobante → 404', async () => {
    kdb.when.select('clients', []);
    const r = await postRecarga(await buildApp(), await auth('admin'));

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('La compañía no existe');
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── POST: tipo de archivo ───────────────────────────

describe('POST /:companiaId/recargas — solo PDF, JPG o PNG', () => {
  it('mime fuera de la lista blanca → lo corta multer y el archivo no llega al almacenamiento', async () => {
    // Un .html subido como tal se descargaría después con ese mismo content-type: XSS almacenado
    // en el mismo origen que la app. El fileFilter responde con un error genérico, así que el
    // status depende del errorHandler que monte la app (aquí, el de Express por defecto); lo que
    // esta prueba fija es que NO se archiva nada.
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .field('valor', '500000')
      .attach('soporte', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });

    expect([400, 500]).toContain(r.status);
    expect(r.status).not.toBe(201);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('mime permitido pero contenido que no lo es → 400 por magic-number', async () => {
    // El content-type lo declara el cliente y es falsificable: un ejecutable renombrado a .pdf
    // reporta application/pdf y pasaría el fileFilter. Lo que manda son los bytes.
    kdb.when.select('clients', [filaCliente]);
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .field('valor', '500000')
      .attach('soporte', Buffer.from('MZ esto no es un PDF, es cualquier cosa'), { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Contenido de archivo no permitido/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('contenido válido pero declarado como otro tipo → 400 por discrepancia', async () => {
    // Un PNG real anunciado como PDF (o al revés) se guardaría con un content-type que no le
    // corresponde y se serviría mal al descargarlo.
    kdb.when.select('clients', [filaCliente]);
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .field('valor', '500000')
      .attach('soporte', PNG_REAL, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no coincide con el contenido real/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('una imagen del soporte bancario sí se admite: no todo comprobante es PDF', async () => {
    escenarioRecargaOk();
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('financiera'))
      .field('valor', '500000')
      .attach('soporte', PNG_REAL, { filename: 'comprobante.png', contentType: 'image/png' });

    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────── POST: recarga válida ────────────────────────────

describe('POST /:companiaId/recargas — recarga válida', () => {
  it('con valor y soporte → 201 con el movimiento y el saldo nuevo', async () => {
    escenarioRecargaOk();
    const r = await postRecarga(await buildApp(), await auth('financiera'), {
      fecha: '2026-03-04', observacion: 'Transferencia Bancolombia',
    });

    expect(r.status).toBe(201);
    expect(r.body.saldo).toBe(500000);
    expect(r.body.movimiento).toMatchObject({
      id: MOV_ID, tipo: 'entrada', origen: 'recarga', valor: 500000, soporteId: SOPORTE_ID,
    });
  });

  it('el comprobante se archiva bajo la carpeta del cliente', async () => {
    escenarioRecargaOk();
    const r = await postRecarga(await buildApp(), await auth('admin'));

    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    // Se archiva en la subcarpeta de recargas: el soporte tiene que poder encontrarse después
    // sin pasar por la BD.
    expect(uploadMock.mock.calls[0][0]).toBe('clientes/acme/bolsas-recargas');
    // Si la recarga cuajó, no se borra nada.
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('la recarga queda en la auditoría: quién metió dinero y cuánto', async () => {
    escenarioRecargaOk();
    await postRecarga(await buildApp(), await auth('financiera'));

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toMatchObject({
      action: 'create', resource: 'flito_bolsa_movimiento', resourceId: MOV_ID,
    });
  });

  it('sin bolsa previa la ruta responde igual: la crea el servicio (AC2)', async () => {
    kdb.when
      .select('clients', [filaCliente])
      // Primera lectura vacía; tras el INSERT de la bolsa, la relectura ya la encuentra.
      .selectOnce('flito_bolsas', [])
      .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }])
      .insert('flito_soportes', [{ id: SOPORTE_ID }])
      .insert('flito_bolsa_movimientos', [filaMovimiento])
      .update('flito_bolsas', []);

    const r = await postRecarga(await buildApp(), await auth('admin'));

    expect(r.status).toBe(201);
    expect(r.body.saldo).toBe(500000);
  });
});

// ─────────────────────────── Compensación de storage ─────────────────────────

describe('POST /:companiaId/recargas — si la recarga no cuaja, el archivo no se queda', () => {
  it('la validación del servicio falla después de subir → se borra el objeto', async () => {
    // La fecha se valida dentro del servicio, o sea DESPUÉS de que el comprobante ya está en el
    // almacenamiento. Sin la compensación quedaría un archivo de hasta 15 MB por cada intento
    // fallido, sin ninguna fila que lo referencie.
    kdb.when.select('clients', [filaCliente]).select('flito_bolsas', [{ id: BOLSA_ID, saldo: '0' }]);
    const r = await postRecarga(await buildApp(), await auth('admin'), { fecha: '2026-02-31' });

    expect(r.status).toBe(400);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(STORAGE_KEY);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('si la bolsa no se puede abrir (carrera) → 409 y también se borra', async () => {
    kdb.when.select('clients', [filaCliente]).select('flito_bolsas', []);
    const r = await postRecarga(await buildApp(), await auth('admin'));

    expect(r.status).toBe(409);
    expect(deleteMock).toHaveBeenCalledWith(STORAGE_KEY);
  });
});

// ─────────────────────────── Consolidado ─────────────────────────────────────

describe('GET /consolidado — no se confunde con un id de compañía', () => {
  it('devuelve el agregado, no un 400 por "consolidado" inválido', async () => {
    kdb.when.select('flito_bolsas', [{ clientes: 4, saldoTotal: '1200000.00' }]);
    const r = await request(await buildApp()).get('/api/flito/bolsas/consolidado').set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ clientes: 4, saldoTotal: 1200000 });
  });
});
