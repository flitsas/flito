// HU #12092 (Feature #12073) — `POST /api/flito/soat/cliente/factura/lectura`: el canal Cliente lee
// con OCR el COMPRADOR de la factura de venta que acaba de adjuntar.
//
// ── Cómo está montada, y por qué así ─────────────────────────────────────────────────────────────
//
// **La API sube por su router real y por `authMiddleware` real**, igual que la suite del alta. Eso
// mantiene vivo el guarda de negación por defecto (`RUTAS_PERMITIDAS_CLIENTE`) en cada petición: si
// alguien borra la entrada que esta HU inscribe en la allowlist, todo este archivo se pone en 403 —
// que es exactamente la señal que se quiere, porque el 403 lo daría la API real.
//
// **Se mide lo que el endpoint NO hace tanto como lo que hace.** El AC6 dice «no se persiste ni se
// archiva nada», y eso no se demuestra afirmando sobre el cuerpo de la respuesta: se demuestra con
// el espía de drizzle (cero INSERT en cualquier tabla) y con `uploadEntityDocument` sin llamar.
//
// **Cada test usa un `sub` distinto.** El limitador del canal es por usuario y su ventana es de 15
// minutos; con un `sub` compartido, los últimos tests del archivo empezarían a dar 429 sin que nadie
// entendiera por qué. El bloque del AC6 usa esa misma propiedad para comprobar el freno.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

// El fallback local (`OCR_LOCAL=1`) no lanza y devolvería los catorce campos vacíos: sería un 200
// que no mide nada. Aquí se ejercita la ruta de Anthropic, mockeada.
process.env.OCR_STUB = '0';
process.env.OCR_LOCAL = '0';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const anthropicMock = vi.fn();
const uploadMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const piiMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: uploadMock }));
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));

const COMPANIA = 7;
const SOAT_PROPIO = '11111111-1111-4111-8111-111111111111';
const SOAT_AJENO = '22222222-2222-4222-8222-222222222222';
const RUTA = '/api/flito/soat/cliente/factura/lectura';

/** PDF de verdad: `file-type` reconoce el `%PDF-` de los primeros bytes, no la extensión. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
/** Un ejecutable de Windows con nombre y `Content-Type` de PDF. */
const EXE_DISFRAZADO = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);

/** Lo que el modelo devuelve: una factura a nombre de una persona natural, todo nítido. */
const COMPRADOR_NATURAL = {
  placa: { valor: 'JNH38H', confianza: 'alta' },
  vin: { valor: '9FKRG2222T2042405', confianza: 'alta' },
  numeroFactura: { valor: 'FE-1234', confianza: 'alta' },
  fechaFactura: { valor: '2026-03-04', confianza: 'alta' },
  valorVehiculo: { valor: '85.000.000', confianza: 'alta' },
  nombres: { valor: 'Juana María', confianza: 'alta' },
  apellidos: { valor: 'Pérez Gómez', confianza: 'alta' },
  razonSocial: { valor: null, confianza: null },
  tipoDocumento: { valor: 'CC', confianza: 'alta' },
  numeroDocumento: { valor: '1.020.304.050', confianza: 'alta' },
  direccion: { valor: 'CALLE 1 # 2-3', confianza: 'alta' },
  municipio: { valor: 'FUNZA', confianza: 'alta' },
  departamento: { valor: 'CUNDINAMARCA', confianza: 'alta' },
  celular: { valor: '300 123 4567', confianza: 'alta' },
};

const respuestaModelo = (obj: Record<string, unknown>) =>
  ({ ok: true as const, data: { content: [{ text: JSON.stringify(obj) }] } });

let sub = 500;
const siguienteUsuario = () => ++sub;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (role: string, id: number) =>
  `Bearer ${await testToken({ sub: id, username: 'cliente@empresa.co', role: role as never })}`;

/**
 * El escenario por defecto: compañía 7 con el canal ENCENDIDO y una solicitud propia en
 * `pendiente_revision`. `flito_soat` viene con la forma que `buscarConAcceso` proyecta
 * (`{ soat, dentroDeFrontera }`).
 */
function escenario(over: Partial<Record<string, unknown[]>> = {}) {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{ id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme' }],
    flito_soat: [{
      soat: { id: SOAT_PROPIO, companiaId: COMPANIA, estado: 'rechazada', origen: 'cliente' },
      dentroDeFrontera: true,
    }],
    ...(over as Record<string, unknown[]>),
  });
}

/** `POST /cliente/factura/lectura` con el adjunto y los campos que se le pasen. */
function lectura(
  app: express.Express,
  token: string,
  opciones: { campos?: Record<string, string>; archivo?: Buffer; nombre?: string; mime?: string; sinArchivo?: boolean } = {},
) {
  const req = request(app).post(RUTA).set('Authorization', token);
  for (const [k, v] of Object.entries(opciones.campos ?? {})) req.field(k, v);
  if (opciones.sinArchivo) return req;
  return req.attach('facturaVenta', opciones.archivo ?? PDF, {
    filename: opciones.nombre ?? 'factura.pdf',
    contentType: opciones.mime ?? 'application/pdf',
  });
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  anthropicMock.mockReset().mockResolvedValue(respuestaModelo(COMPRADOR_NATURAL));
  uploadMock.mockReset().mockResolvedValue('no-deberia-llamarse');
  auditMock.mockClear();
  piiMock.mockClear();
});

// ───────────────────── AC6 — el endpoint del canal ───────────────────────────

describe('AC6 — la lectura devuelve la extracción y NO persiste ni archiva nada', () => {
  it('**200 con los catorce campos, cada uno `{valor, confianza, confiable}`**', async () => {
    escenario();

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(200);
    const { CampoFacturaVenta } = await import('@operaciones/shared-types');
    expect(Object.keys(r.body.extraccion).sort()).toEqual([...Object.values(CampoFacturaVenta)].sort());
    // Normalizados por el extractor (AC5), no ecos del modelo.
    expect(r.body.extraccion.numeroDocumento).toEqual({ valor: '1020304050', confianza: 0.95, confiable: true });
    expect(r.body.extraccion.celular.valor).toBe('3001234567');
    expect(r.body.extraccion.nombres.valor).toBe('Juana María');
    expect(r.body.extraccion.razonSocial).toEqual({ valor: null, confianza: 0, confiable: false });
  });

  it('**cero INSERT en cualquier tabla, cero subida a storage, cero `audit()`**', async () => {
    escenario();

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(200);

    // El AC6 en su literalidad: «recibe la extracción y NO se persiste ni se archiva nada».
    for (const tabla of ['flito_soat', 'flito_soportes', 'flito_compradores', 'flito_soat_solicitud', 'vehicles', 'audit_logs']) {
      expect(espia.insertsEn(tabla), tabla).toHaveLength(0);
    }
    expect(uploadMock).not.toHaveBeenCalled();
    // `audit()` responde «quién CAMBIÓ qué», y aquí no cambió nada. El rastro va a `pii_access_log`.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('la respuesta va ENVUELTA en `{ extraccion }`, no plana', async () => {
    escenario();
    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.body).toHaveProperty('extraccion');
    expect(r.body.placa).toBeUndefined();
  });

  it('**el rate limit del canal va DELANTE de la carga del archivo** (orden de middlewares)', async () => {
    // El AC6 lo pide explícitamente. No se mide con un 429 —que llegaría igual en las dos
    // ordenaciones— sino sobre la pila REAL de la ruta: si alguien mueve `upload.single` delante del
    // limitador «para poder mirar el cuerpo», el freno pasaría a actuar DESPUÉS de que el proceso
    // haya cargado 15 MB en memoria, que es justo lo que el limitador existe para evitar.
    const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
    const capa = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown; name: string }> } }> })
      .stack.find((l) => l.route?.path === '/cliente/factura/lectura');
    expect(capa, 'la ruta no está montada en el router del canal').toBeDefined();

    const { soatClienteLimiter } = await import('../../src/shared/middleware/rateLimiter.js');
    const handlers = capa!.route!.stack;
    const iLimitador = handlers.findIndex((h) => h.handle === soatClienteLimiter);
    // Multer no exporta su middleware: se identifica por nombre, que es como se identifica en
    // cualquier stack de Express.
    const iMulter = handlers.findIndex((h) => h.name === 'multerMiddleware');

    expect(iLimitador, 'el limitador del canal no está en la ruta').toBeGreaterThanOrEqual(0);
    expect(iMulter, 'multer no está en la ruta').toBeGreaterThanOrEqual(0);
    expect(iLimitador).toBeLessThan(iMulter);
  });

  it('el limitador frena al usuario que insiste, y solo a ese usuario', async () => {
    escenario({ clients: [{ id: COMPANIA, sinTramite: false, carpeta: null }] });
    const app = await buildApp();
    const insistente = await auth('cliente', siguienteUsuario());

    let ultimo = 0;
    for (let i = 0; i < 21; i++) ultimo = (await lectura(app, insistente)).status;
    expect(ultimo).toBe(429);

    // Otro usuario de la misma compañía —misma IP en el test— sigue pasando: la llave es el `sub`.
    expect((await lectura(app, await auth('cliente', siguienteUsuario()))).status).toBe(403);
  });

  it('**el OCR caído responde 503 y no 500**: el formulario puede seguir a mano', async () => {
    escenario();
    // Los cuatro caminos de fallo de `anthropicMessages` devuelven 503, y `pasada` lo lanza como
    // `OcrNoDisponibleError`. Sin la rama en `manejarError`, ese error se re-lanzaba al handler
    // global de Express y salía como 500 — este aserto es lo único que lo distingue.
    anthropicMock.mockResolvedValue({ ok: false, status: 503, message: 'OCR no disponible' });

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(503);
    expect(typeof r.body.error).toBe('string');
    // Un 503 no accedió a los datos de nadie: no se escribe la línea del artículo 17.
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('**un ejecutable renombrado a .pdf → 400 `archivo_no_pdf`, y no sale de la red**', async () => {
    escenario();

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      archivo: EXE_DISFRAZADO, nombre: 'factura.pdf', mime: 'application/pdf',
    });

    expect(r.status).toBe(400);
    expect(r.body.codigo).toBe('archivo_no_pdf');
    // La guarda corre ANTES del OCR: no se le manda un binario cualquiera al encargado externo.
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('sin adjunto → 400, y sin llamar al modelo', async () => {
    escenario();
    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), { sinArchivo: true });
    expect(r.status).toBe(400);
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('`solicitudId` que no es un uuid → 400 y no se lee nada', async () => {
    escenario();
    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { solicitudId: 'no-es-uuid' },
    });
    expect(r.status).toBe(400);
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('el flag «SOAT sin trámite» APAGADO → 403 `canal_desactivado`, sin quemar una llamada al modelo', async () => {
    // La guarda más barata va primera, igual que en el alta: una compañía sin el canal abierto no
    // puede gastar llamadas a un modelo de pago con PDFs de 15 MB.
    escenario({ clients: [{ id: COMPANIA, sinTramite: false, carpeta: null }] });

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('canal_desactivado');
    expect(anthropicMock).not.toHaveBeenCalled();
  });
});

// ───────────────────── Quién puede entrar ────────────────────────────────────

describe('la ruta es del `cliente` y está inscrita en la allowlist del canal', () => {
  it('**la entrada existe en `RUTAS_PERMITIDAS_CLIENTE`, con su método y su `porque`**', async () => {
    const { RUTAS_PERMITIDAS_CLIENTE, rutaPermitidaParaCliente } =
      await import('../../src/shared/middleware/canal-cliente.js');

    expect(rutaPermitidaParaCliente('POST', RUTA)).toBe(true);
    const entrada = RUTAS_PERMITIDAS_CLIENTE.find((r) => r.patron === RUTA);
    expect(entrada?.metodo).toBe('POST');
    expect(entrada!.porque.length).toBeGreaterThan(40);
  });

  it('la allowlist NO abre de más: ni el GET de esa ruta ni un hermano inventado', async () => {
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');
    expect(rutaPermitidaParaCliente('GET', RUTA)).toBe(false);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente/factura')).toBe(false);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/cliente/factura/lectura/extra')).toBe(false);
  });

  it('**un `admin` recibe 403**: radicar y leer la factura del titular es del canal, no de Operaciones', async () => {
    escenario();
    const r = await lectura(await buildApp(), await auth('admin', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('un `gestor` recibe el MISMO 403, indistinguible del anterior', async () => {
    escenario();
    const r = await lectura(await buildApp(), await auth('gestor', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos' });
  });

  it('sin token → 401', async () => {
    escenario();
    const r = await request(await buildApp()).post(RUTA).attach('facturaVenta', PDF, 'factura.pdf');
    expect(r.status).toBe(401);
  });

  it('un `cliente` SIN compañía no lee (la tercera capa del aislamiento)', async () => {
    escenario({ users: [{ c: null, s: null }] });
    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));
    expect(r.status).toBe(403);
    expect(r.body.codigo).toBe('sin_compania');
  });
});

// ───────────────────── AC7 — PII hacia el encargado externo ──────────────────

describe('AC7 — queda escrito quién leyó, cuándo y sobre qué solicitud; y nada más', () => {
  it('**escribe UNA línea en `pii_access_log` con las once columnas que la respuesta entrega**', async () => {
    escenario();

    await lectura(await buildApp(), await auth('cliente', siguienteUsuario()));

    expect(piiMock).toHaveBeenCalledTimes(1);
    const entrada = piiMock.mock.calls[0][1];
    expect(entrada).toMatchObject({ resourceTipo: 'flito_soat', accion: 'read', resourceId: null });
    // Lista EXACTA, no `length`: la ruta responde la extracción sin proyectar, así que `placa` y
    // `vin` salen en cada 200 y el registro del art. 17 tiene que declararlas. Quitar una de aquí
    // sin quitarla de la respuesta es subdeclarar lo divulgado.
    expect([...entrada.camposAccedidos].sort()).toEqual([
      'apellidos', 'celular', 'departamento', 'direccion', 'municipio',
      'nombres', 'numero_documento', 'placa', 'razon_social', 'tipo_documento', 'vin',
    ]);
  });

  it('**con `solicitudId` el motivo lo dice; sin él, dice que no lo hay**', async () => {
    escenario();
    const app = await buildApp();

    await lectura(app, await auth('cliente', siguienteUsuario()), { campos: { solicitudId: SOAT_PROPIO } });
    expect(piiMock.mock.calls[0][1].motivo).toContain(SOAT_PROPIO);

    piiMock.mockClear();
    await lectura(app, await auth('cliente', siguienteUsuario()));
    const sinSolicitud = piiMock.mock.calls[0][1].motivo;
    expect(sinSolicitud).not.toContain(SOAT_PROPIO);
    expect(sinSolicitud).toMatch(/sin solicitud/i);
  });

  it('**ningún valor leído del comprador entra en el motivo del registro**', async () => {
    escenario();

    await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { solicitudId: SOAT_PROPIO },
    });

    const motivo: string = piiMock.mock.calls[0][1].motivo;
    for (const valor of ['Juana', 'Pérez', '1020304050', '1.020.304.050', '3001234567', 'CALLE 1', 'JNH38H', '9FKRG2222T2042405']) {
      expect(motivo, valor).not.toContain(valor);
    }
    // Y cabe en `pii_access_log.motivo`, que es varchar(200).
    expect(motivo.length).toBeLessThanOrEqual(200);
  });

  it('**ningún dato personal viaja en la URL**: `solicitudId` va en el cuerpo del multipart', async () => {
    escenario();
    const { rutaPermitidaParaCliente } = await import('../../src/shared/middleware/canal-cliente.js');

    // El patrón inscrito no tiene ningún `:param`: no hay dónde meter un identificador.
    expect(RUTA).not.toContain(':');
    // Y la variante con el uuid en la ruta no está abierta, así que nadie puede «simplificar» el
    // cliente moviéndolo allí sin tocar la allowlist.
    expect(rutaPermitidaParaCliente('POST', `${RUTA}/${SOAT_PROPIO}`)).toBe(false);

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { solicitudId: SOAT_PROPIO },
    });
    expect(r.status).toBe(200);
  });

  it('**`solicitudId` de otra compañía → 404 (no 403) y NO se llama al OCR**', async () => {
    // Si no se comprobara antes de leer, cualquier cliente podría estampar en el registro del
    // artículo 17 el uuid de una solicitud ajena: el rastro que la ley exige apuntaría al caso
    // equivocado. 404 y no 403 por el contrato de `buscarConAcceso`: un 403 ya confirma que el id
    // existe.
    escenario({
      flito_soat: [{
        soat: { id: SOAT_AJENO, companiaId: 99, estado: 'rechazada', origen: 'cliente' },
        dentroDeFrontera: true,
      }],
    });

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { solicitudId: SOAT_AJENO },
    });

    expect(r.status).toBe(404);
    expect(anthropicMock).not.toHaveBeenCalled();
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('`solicitudId` que no existe → el mismo 404, indistinguible del ajeno', async () => {
    escenario({ flito_soat: [] });

    const r = await lectura(await buildApp(), await auth('cliente', siguienteUsuario()), {
      campos: { solicitudId: SOAT_AJENO },
    });

    expect(r.status).toBe(404);
    expect(anthropicMock).not.toHaveBeenCalled();
  });
});
