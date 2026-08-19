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

/** Clave de idempotencia por defecto de los tests; el encabezado es obligatorio en toda recarga. */
const IDEM = 'idem-0001';

/**
 * POST de recarga con comprobante válido. `campos` sobreescribe o añade campos del formulario;
 * `clave` permite reenviar con la misma (replay) o probar encabezados inválidos.
 */
function postRecarga(
  app: express.Express,
  token: string,
  campos: Record<string, string> = {},
  clave: string | null = IDEM,
  compania: number = COMPANIA,
) {
  const req = request(app).post(`/api/flito/bolsas/${compania}/recargas`).set('Authorization', token);
  if (clave !== null) req.set('Idempotency-Key', clave);
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

/**
 * Fila del LIBRO tal como la devuelve `movimientosDe`, que hace `leftJoin` con los trámites para
 * traer el id de FLIT: la proyección anida el movimiento en `m` y saca el `idFlit` al lado.
 */
const filaLibro = (m: Record<string, unknown> = filaMovimiento, idFlit: string | null = null) => ({ m, idFlit });

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
      .set('Idempotency-Key', IDEM)
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
    kdb.when.select('flito_bolsa_movimientos', [filaLibro(filaMovimiento, 'FLIT-1')]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/movimientos`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: MOV_ID, tipo: 'entrada', origen: 'recarga', valor: 500000 });
    // El libro enseña el id de FLIT, que es como Operaciones nombra el trámite, no el UUID.
    expect(r.body[0].idFlit).toBe('FLIT-1');
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
    kdb.when.select('flito_bolsa_movimientos', [filaLibro()]);
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
    // en el mismo origen que la app. El rechazo sale como 400 con el motivo —no como el 500
    // genérico del error handler—, porque quien sube un comprobante equivocado necesita saber qué
    // pasó.
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .set('Idempotency-Key', IDEM)
      .field('valor', '500000')
      .attach('soporte', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Tipo de archivo no permitido: text/html');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('mime permitido pero contenido que no lo es → 400 por magic-number', async () => {
    // El content-type lo declara el cliente y es falsificable: un ejecutable renombrado a .pdf
    // reporta application/pdf y pasaría el fileFilter. Lo que manda son los bytes.
    kdb.when.select('clients', [filaCliente]);
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/recargas`)
      .set('Authorization', await auth('admin'))
      .set('Idempotency-Key', IDEM)
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
      .set('Idempotency-Key', IDEM)
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
      .set('Idempotency-Key', IDEM)
      .field('valor', '500000')
      .attach('soporte', PNG_REAL, { filename: 'comprobante.png', contentType: 'image/png' });

    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────── POST: recarga válida ────────────────────────────

describe('POST /:companiaId/recargas — el encabezado Idempotency-Key es obligatorio', () => {
  it('sin encabezado → 400, y el comprobante no llega al almacenamiento', async () => {
    // Se exige en vez de aceptarlo opcional porque un opcional solo protege a quien lo manda, y
    // aquí lo que hay que proteger es el saldo del cliente.
    const r = await postRecarga(await buildApp(), await auth('admin'), {}, null);

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta el encabezado Idempotency-Key');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('encabezado en blanco → 400: una clave de espacios no identifica nada', async () => {
    // Los espacios se pierden por el camino y el encabezado llega como cadena vacía, así que este
    // caso cubre una rama distinta a la de arriba: presente pero sin contenido.
    const r = await postRecarga(await buildApp(), await auth('admin'), {}, '   ');

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta el encabezado Idempotency-Key');
  });

  it('clave de más de 120 caracteres → 400', async () => {
    // El prefijo y el id de compañía tienen que caber junto a ella en varchar(200); truncarla en
    // silencio haría que dos claves distintas se leyeran como la misma.
    const r = await postRecarga(await buildApp(), await auth('admin'), {}, 'k'.repeat(121));

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta el encabezado Idempotency-Key');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('clave de exactamente 120 caracteres sí pasa: el tope no se come el caso legal', async () => {
    escenarioRecargaOk();
    const r = await postRecarga(await buildApp(), await auth('admin'), {}, 'k'.repeat(120));
    expect(r.status).toBe(201);
  });
});

describe('POST /:companiaId/recargas — reenvío con la misma clave', () => {
  /** El movimiento ya asentado que encuentra el pre-chequeo del servicio. */
  function yaAsentada(): void {
    kdb.when
      .select('clients', [filaCliente])
      .select('flito_bolsa_movimientos', [filaMovimiento]);
  }

  it('replay → 200 (no 201) con duplicado: true y el movimiento original', async () => {
    // Un doble clic no puede acreditar el dinero dos veces; y el 200 le dice al cliente que su
    // recarga ya estaba registrada, en vez de hacerle creer que acaba de crear otra.
    yaAsentada();
    const r = await postRecarga(await buildApp(), await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body.duplicado).toBe(true);
    expect(r.body.movimiento.id).toBe(MOV_ID);
    expect(r.body.saldo).toBe(500000);
  });

  it('el comprobante que subió el reenvío se borra: el original conserva el suyo', async () => {
    // Sin esto, cada reintento dejaría una copia del archivo en el almacenamiento sin ninguna
    // fila que la referencie.
    yaAsentada();
    await postRecarga(await buildApp(), await auth('admin'));

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('el replay no se audita: no ocurrió ningún movimiento de dinero', async () => {
    yaAsentada();
    await postRecarga(await buildApp(), await auth('admin'));
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('POST /:companiaId/recargas — recarga válida', () => {
  it('con valor y soporte → 201 con el movimiento y el saldo nuevo', async () => {
    escenarioRecargaOk();
    const r = await postRecarga(await buildApp(), await auth('financiera'), {
      fecha: '2026-03-04', observacion: 'Transferencia Bancolombia',
    });

    expect(r.status).toBe(201);
    expect(r.body.saldo).toBe(500000);
    // Recarga nueva: el cliente distingue por este flag si acaba de crear algo o si le devolvieron
    // lo que ya existía.
    expect(r.body.duplicado).toBe(false);
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

// ─────────────────────────── Cierre mensual (HU #11126) ─────────────────────

/** Periodo 'YYYY-MM' desplazado n meses respecto al de hoy. Nunca literales: el tiempo pasa. */
function periodoDesplazado(n: number): string {
  const hoy = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [anio, mes] = hoy.slice(0, 7).split('-').map(Number);
  const total = anio * 12 + (mes - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const MES_PASADO = periodoDesplazado(-1);

const filaCierre = {
  id: 'cccccccc-1111-1111-1111-111111111111', bolsaId: BOLSA_ID, companiaId: COMPANIA,
  periodo: MES_PASADO, saldoInicial: '0', totalEntradas: '500000', totalSalidas: '320000',
  saldoFinal: '180000', movimientos: 12, observaciones: 'Conciliado',
  cerradoPorId: 9, cerradoPorNombre: 'financiera@flit.io', cerradoEn: AHORA,
};

/** Lo que necesita un cierre feliz: bolsa, ningún cierre previo y los totales del periodo. */
function escenarioCierreOk(): void {
  kdb.when
    .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '180000' }])
    .select('flito_bolsa_cierres', [])
    .select('flito_bolsa_movimientos', [{ entradas: '500000', salidas: '320000', movimientos: 12 }])
    .insert('flito_bolsa_cierres', [filaCierre]);
}

describe('cierres — AC3 de acceso: siguen siendo cosa de Administración y Financiera', () => {
  it('rol transito → 403 al listar y al cerrar', async () => {
    const app = await buildApp();
    const token = await auth('transito');

    const lista = await request(app).get(`/api/flito/bolsas/${COMPANIA}/cierres`).set('Authorization', token);
    const cierre = await request(app).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', token).send({ periodo: MES_PASADO });

    expect([lista.status, cierre.status]).toEqual([403, 403]);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('rol financiera SÍ lista los cierres del cliente', async () => {
    kdb.when.select('flito_bolsa_cierres', [filaCierre]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ periodo: MES_PASADO, saldoFinal: 180000, movimientos: 12 });
  });
});

describe('POST /:companiaId/cierres — validación y cierre', () => {
  it('sin periodo en el cuerpo → 400', async () => {
    const r = await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('admin')).send({});

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('periodo con formato inválido → 400 con el mensaje del formato', async () => {
    const r = await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('admin')).send({ periodo: '2026-13' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El periodo debe tener la forma AAAA-MM');
  });

  it('cierre válido → 201 con el reporte sellado', async () => {
    escenarioCierreOk();
    const r = await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('financiera'))
      .send({ periodo: MES_PASADO, observaciones: 'Conciliado' });

    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      periodo: MES_PASADO, totalEntradas: 500000, totalSalidas: 320000, saldoFinal: 180000,
      movimientos: 12, cerradoPorNombre: 'financiera@flit.io',
    });
  });

  it('el cierre queda en la auditoría: es un documento irreversible', async () => {
    // No hay endpoint para reabrir un periodo, así que quién lo cerró y con qué cifras es lo único
    // que queda para reconstruir la decisión.
    escenarioCierreOk();
    await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('financiera')).send({ periodo: MES_PASADO });

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toMatchObject({
      action: 'create', resource: 'flito_bolsa_cierre', resourceId: filaCierre.id,
    });
  });

  it('periodo ya cerrado → 409 y sin auditoría', async () => {
    kdb.when
      .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '180000' }])
      .select('flito_bolsa_cierres', [{ id: filaCierre.id }]);

    const r = await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('admin')).send({ periodo: MES_PASADO });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('El periodo ya está cerrado');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('el mes en curso → 400 con el motivo, no un 500', async () => {
    const r = await request(await buildApp()).post(`/api/flito/bolsas/${COMPANIA}/cierres`)
      .set('Authorization', await auth('admin')).send({ periodo: periodoDesplazado(0) });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El periodo en curso no ha terminado: solo se cierra un mes ya cumplido');
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

// ───────────── Movimientos manuales y correcciones (HU #11123) ───────────────

const MOV_MANUAL_ID = 'dddddddd-1111-1111-1111-111111111111';

/** Movimiento manual ya asentado, tal como lo devuelve el SELECT por id. */
const filaMovimientoManual = {
  id: MOV_MANUAL_ID, bolsaId: BOLSA_ID, companiaId: COMPANIA, tipo: 'salida', origen: 'manual',
  concepto: 'impuesto', organismoCodigo: '11001', tramiteId: null,
  valor: '100000', saldoResultante: '900000', periodo: '2026-07', fecha: '2026-07-20',
  observacion: 'Pago en ventanilla', soporteId: SOPORTE_ID,
  registradoPorId: 9, registradoPorNombre: 'financiera@flit.io',
  llaveIdempotencia: null, corrigeMovimientoId: null, createdAt: AHORA,
};

/** POST multipart de movimiento manual con evidencia válida. */
function postManual(app: express.Express, token: string, campos: Record<string, string> = {}) {
  const req = request(app).post(`/api/flito/bolsas/${COMPANIA}/movimientos-manuales`).set('Authorization', token);
  const base = { tipo: 'entrada', valor: '250000', motivo: 'Devolución del organismo' };
  for (const [k, v] of Object.entries({ ...base, ...campos })) req.field(k, v);
  return req.attach('soporte', PDF_REAL, { filename: 'evidencia.pdf', contentType: 'application/pdf' });
}

/** Todo lo que necesita un movimiento manual feliz. */
function escenarioManualOk(): void {
  kdb.when
    .select('clients', [filaCliente])
    .select('flito_bolsa_cierres', [])
    .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '1000000' }])
    .insert('flito_soportes', [{ id: SOPORTE_ID }])
    .insert('flito_bolsa_movimientos', [{ ...filaMovimientoManual, tipo: 'entrada', valor: '250000', saldoResultante: '1250000' }])
    .update('flito_bolsas', []);
}

describe('POST /:companiaId/movimientos-manuales — contingencia de Financiera', () => {
  it('rol transito → 403 y el archivo ni se sube', async () => {
    const r = await postManual(await buildApp(), await auth('transito'));
    expect(r.status).toBe(403);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('sin evidencia adjunta → 400', async () => {
    // Un movimiento de dinero que decide una persona sin dejar respaldo no es auditable.
    const r = await request(await buildApp())
      .post(`/api/flito/bolsas/${COMPANIA}/movimientos-manuales`)
      .set('Authorization', await auth('admin'))
      .field('tipo', 'entrada').field('valor', '250000').field('motivo', 'Devolución del organismo');

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Adjunta la evidencia del movimiento');
  });

  it('motivo demasiado corto → 400 con el mensaje de negocio', async () => {
    const r = await postManual(await buildApp(), await auth('admin'), { motivo: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Indica el motivo del movimiento');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('tipo distinto de entrada o salida → 400', async () => {
    const r = await postManual(await buildApp(), await auth('admin'), { tipo: 'ajuste' });
    expect(r.status).toBe(400);
  });

  it('valor no positivo → 400', async () => {
    const r = await postManual(await buildApp(), await auth('admin'), { valor: '0' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor del movimiento debe ser mayor que cero');
  });

  it('válido → 201 con el movimiento y el saldo, y queda auditado', async () => {
    escenarioManualOk();
    const r = await postManual(await buildApp(), await auth('financiera'));

    expect(r.status).toBe(201);
    expect(r.body.movimiento).toMatchObject({ origen: 'manual', tipo: 'entrada', valor: 250000 });
    expect(r.body.saldo).toBe(1250000);
    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'create', resource: 'flito_bolsa_movimiento' });
  });

  it('periodo cerrado → 409 y se borra la evidencia ya subida', async () => {
    // El rechazo ocurre después de archivar el adjunto; sin la compensación quedaría un huérfano.
    kdb.when
      .select('clients', [filaCliente])
      .select('flito_bolsa_cierres', [{ id: 'cierre-1', periodo: '2026-06' }]);

    const r = await postManual(await buildApp(), await auth('admin'), { fecha: '2026-06-15' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('No se pueden registrar ni editar movimientos de un periodo cerrado');
    expect(deleteMock).toHaveBeenCalledWith(STORAGE_KEY);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('POST /:companiaId/movimientos/:movimientoId/correccion', () => {
  const url = `/api/flito/bolsas/${COMPANIA}/movimientos/${MOV_MANUAL_ID}/correccion`;

  it('rol transito → 403', async () => {
    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('transito')).send({ valor: 150000, motivo: 'Error de digitación' });
    expect(r.status).toBe(403);
  });

  it('motivo corto → 400', async () => {
    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('admin')).send({ valor: 150000, motivo: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Indica el motivo del movimiento');
  });

  it('valor corregido no positivo → 400', async () => {
    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('admin')).send({ valor: 0, motivo: 'Error de digitación' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El valor corregido debe ser mayor que cero');
  });

  it('corregir un movimiento automático → 409', async () => {
    kdb.when.select('flito_bolsa_movimientos', [{ ...filaMovimientoManual, origen: 'automatico' }]);
    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('admin')).send({ valor: 150000, motivo: 'Error de digitación' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Un movimiento automático no se edita: corrígelo con un ajuste manual');
  });

  it('movimiento inexistente → 404', async () => {
    kdb.when.select('flito_bolsa_movimientos', []);
    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('admin')).send({ valor: 150000, motivo: 'Error de digitación' });
    expect(r.status).toBe(404);
  });

  it('válido → 201 con la corrección y auditoría de actualización', async () => {
    kdb.when
      .selectOnce('flito_bolsa_movimientos', [filaMovimientoManual])
      .select('flito_bolsa_cierres', [])
      .select('flito_bolsas', [{ id: BOLSA_ID, saldo: '1000000' }])
      .insert('flito_bolsa_movimientos', [{
        ...filaMovimientoManual, id: 'mov-correccion', valor: '50000', saldoResultante: '950000',
        corrigeMovimientoId: MOV_MANUAL_ID,
      }])
      .update('flito_bolsas', []);

    const r = await request(await buildApp()).post(url)
      .set('Authorization', await auth('financiera')).send({ valor: 150000, motivo: 'Error de digitación' });

    expect(r.status).toBe(201);
    expect(r.body.correccion).toMatchObject({ id: 'mov-correccion', valor: 50000 });
    expect(r.body.saldo).toBe(950000);
    // Se audita como `update` aunque el asiento sea nuevo: para el negocio es la edición de otro.
    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'update', resource: 'flito_bolsa_movimiento' });
  });
});

// ───────── Extracto, bolsa simbólica y pagos al organismo (HU #11124) ────────

describe('GET /:companiaId/extracto', () => {
  it('rol transito → 403', async () => {
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/extracto`)
      .set('Authorization', await auth('transito'));
    expect(r.status).toBe(403);
  });

  it('periodo mal formado → 400', async () => {
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/extracto?periodo=2026-13`)
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Filtros inválidos');
  });

  it('válido → 200 con los desgloses', async () => {
    kdb.when
      .selectOnce('flito_bolsa_movimientos', [{ entradas: '800000', salidas: '300000' }])
      .selectOnce('flito_bolsa_movimientos', [{ clave: '05001', entradas: '0', salidas: '300000', movimientos: 3 }])
      .selectOnce('flito_bolsa_movimientos', [{ clave: null, entradas: '800000', salidas: '0', movimientos: 1 }])
      .select('flito_bolsas', [filaBolsa]);

    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}/extracto`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ companiaId: COMPANIA, totalEntradas: 800000, totalSalidas: 300000 });
    expect(r.body.porConcepto[0].clave).toBe('sin_asignar');
  });
});

describe('GET /soportes/:soporteId — abrir el comprobante de un movimiento', () => {
  it('rol transito → 403', async () => {
    // Ruta propia y no la de derechos: aquella está abierta a `auditor`, y los soportes de bolsas
    // los reserva el Feature a Administración y Financiera.
    const r = await request(await buildApp()).get(`/api/flito/bolsas/soportes/${SOPORTE_ID}`)
      .set('Authorization', await auth('transito'));
    expect(r.status).toBe(403);
  });

  it('→ 200 con la URL firmada y el nombre del archivo', async () => {
    kdb.when.select('flito_soportes', [{
      storageKey: 'clientes/acme/bolsas-recargas/comprobante.pdf',
      nombreArchivo: 'comprobante.pdf',
      contentType: 'application/pdf',
    }]);

    const r = await request(await buildApp()).get(`/api/flito/bolsas/soportes/${SOPORTE_ID}`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      url: '/api/files?key=k', nombreArchivo: 'comprobante.pdf', contentType: 'application/pdf',
    });
  });

  it('soporte inexistente → 404 con mensaje, no una URL firmada de nada', async () => {
    kdb.when.select('flito_soportes', []);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/soportes/${SOPORTE_ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(404);
    expect(r.body.error).toBe('El soporte no existe');
  });
});

// ─────────────── Nivel de riesgo y alertas (HU #11125) ───────────────────────

describe('bolsa con nivel de riesgo', () => {
  it('GET /:companiaId ahora trae nivel y porcentaje', async () => {
    // La pantalla no recalcula el nivel: lo pinta tal cual viene.
    kdb.when.select('flito_bolsas', [{ ...filaBolsa, saldo: '80000', ultimaRecargaValor: '800000' }]);
    const r = await request(await buildApp()).get(`/api/flito/bolsas/${COMPANIA}`)
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ saldo: 80000, nivel: 'critico', porcentaje: 10 });
  });

  it('GET /riesgo y GET /alertas con rol transito → 403', async () => {
    const app = await buildApp();
    const token = await auth('transito');
    const riesgo = await request(app).get('/api/flito/bolsas/riesgo').set('Authorization', token);
    const alertas = await request(app).get('/api/flito/bolsas/alertas').set('Authorization', token);

    expect([riesgo.status, alertas.status]).toEqual([403, 403]);
  });

  it('GET /riesgo → 200 con las bolsas ordenadas por urgencia', async () => {
    kdb.when.select('flito_bolsas', [
      { id: 'b1', companiaId: 1, companiaNombre: 'Normal', saldo: '500000', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA },
      { id: 'b2', companiaId: 2, companiaNombre: 'Agotada', saldo: '0', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA },
    ]);
    const r = await request(await buildApp()).get('/api/flito/bolsas/riesgo').set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.map((b: { nivel: string }) => b.nivel)).toEqual(['agotada', 'normal']);
  });

  it('GET /riesgo?periodo=2026-13 → 400: el periodo es contable, no texto libre', async () => {
    const r = await request(await buildApp()).get('/api/flito/bolsas/riesgo?periodo=2026-13')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Filtros inválidos');
  });

  it('GET /riesgo?periodo=YYYY-MM → 200 con los totales del mes en cada tarjeta', async () => {
    kdb.when
      .select('flito_bolsas', [
        { id: 'b1', companiaId: 1, companiaNombre: 'ACME', saldo: '500000', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA },
      ])
      .select('flito_bolsa_movimientos', [{ companiaId: 1, entradas: '800000', salidas: '300000' }]);

    const r = await request(await buildApp()).get('/api/flito/bolsas/riesgo?periodo=2026-06')
      .set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ companiaId: 1, entradasPeriodo: 800000, salidasPeriodo: 300000 });
  });

  it('GET /alertas → 200 con saldo y conciliación', async () => {
    kdb.when
      .select('flito_bolsas', [{ id: 'b1', companiaId: 1, companiaNombre: 'ACME', saldo: '0', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA }])
      .select('flito_derechos_pendientes', [{ n: 2 }])
      .select('flito_bolsa_movimientos', [{ n: 1 }]);
    const r = await request(await buildApp()).get('/api/flito/bolsas/alertas').set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.saldo).toHaveLength(1);
    expect(r.body.conciliacion).toEqual({ soportesSinTramite: 2, movimientosSinSoporte: 1 });
  });
});

// ─────────────────────────── Orden de declaración ────────────────────────────

/**
 * Rutas del router en el ORDEN en que Express las evalúa.
 *
 * Se mira la pila del router y no la respuesta HTTP porque el orden es la regla que hay que
 * proteger, y una ruta mal colocada no falla: la atrapa el parámetro y responde otra cosa. Es la
 * clase de error que solo se ve en producción cuando una pantalla aparece vacía.
 */
async function rutasDeclaradas(): Promise<string[]> {
  const { default: router } = await import('../../src/modules/flito-bolsas/flito-bolsas.routes.js');
  const capas = (router as unknown as { stack: { route?: { path: string } }[] }).stack;
  return capas.filter((capa) => capa.route !== undefined).map((capa) => capa.route!.path);
}

describe('orden de las rutas — un segmento fijo nunca puede quedar bajo /:companiaId', () => {
  it('ninguna ruta de un solo segmento fijo se declara después del parámetro', async () => {
    // Regla general y no una comprobación de estas dos: quien mañana añada `/tablero` o `/cierres`
    // al final del archivo se lleva el mismo aviso, que es justo cuando se comete el error.
    const rutas = await rutasDeclaradas();
    const posicionDelParametro = rutas.indexOf('/:companiaId');
    expect(posicionDelParametro).toBeGreaterThan(-1);

    const deUnSegmentoFijo = rutas.filter((p) => /^\/[^/:]+$/.test(p));
    const tardias = deUnSegmentoFijo.filter((p) => rutas.indexOf(p) > posicionDelParametro);

    // Si esto falla, las rutas listadas son inalcanzables: Express casa su segmento con
    // `:companiaId` y devuelven «Compañía inválida» en vez de lo suyo. Se arregla subiéndolas por
    // encima de `router.get('/:companiaId', …)`.
    expect(tardias).toEqual([]);
  });

  it('las tres rutas fijas de hoy siguen ahí, y por delante del parámetro', async () => {
    // El test de arriba pasaría en vacío si alguien renombrara o borrara las rutas; esto ancla
    // cuáles son las que dependen del orden.
    const rutas = await rutasDeclaradas();
    const antesDelParametro = rutas.slice(0, rutas.indexOf('/:companiaId'));

    expect(antesDelParametro).toEqual(expect.arrayContaining(['/consolidado', '/riesgo', '/alertas']));
  });

  it('las rutas de bolsa de tránsito con parámetro no necesitan ir antes: las salvan sus segmentos', async () => {
    // Documenta por qué esas sí pueden vivir más abajo, para que nadie «arregle» lo que no está roto
    // moviéndolas y se lleve por delante el orden de las otras.
    //
    // `/transito` a secas (un solo segmento fijo) SÍ depende del orden y lo cubre el test de arriba.
    // Las que llevan `:bolsaId` no: `/:companiaId` solo captura rutas de un segmento, y las de dos
    // no chocan porque las que ya existen con esa forma tienen su segundo segmento literal
    // (`/:companiaId/movimientos`, `/:companiaId/extracto`…), no un parámetro.
    const rutas = await rutasDeclaradas();
    const conParametro = rutas.filter((r) => r.startsWith('/transito/'));

    expect(conParametro).toEqual(expect.arrayContaining([
      '/transito/:bolsaId',
      '/transito/:bolsaId/movimientos',
      '/transito/:bolsaId/cargas',
    ]));
    expect(conParametro.every((r) => r.split('/').filter(Boolean).length >= 2)).toBe(true);
  });
});
