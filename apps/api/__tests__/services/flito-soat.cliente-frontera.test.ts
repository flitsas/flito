// HU #11913 (Feature #11912) — la frontera del rol `cliente`: qué puede PEDIR y qué se le RESPONDE.
//
// Es la corrección del FAIL de `security-agent` sobre esta misma HU, y son tres cosas distintas que
// se prueban juntas porque las tres nacen del mismo hecho: `cliente` es el primer principal externo
// a FLIT, y hasta este PR «autenticado» significaba «empleado de la operación».
//
//   B1 · Negación por defecto. Un JWT `cliente` alcanzaba `GET /api/vehicles` (nombre y cédula del
//        propietario de TODAS las compañías, 500 por página), `POST /api/runt/consulta-persona` (el
//        RUNT de cualquier cédula colombiana) y siete rutas más, porque esos routers montan
//        `authMiddleware` sin `requireRole`. Ahora solo pasa lo que está en la allowlist.
//   B2 · Proyección por rol. El aislamiento por compañía (probado en
//        `flito-soat.cliente-aislamiento.test.ts`) decide QUÉ FILAS ve; esto decide QUÉ CAMPOS de
//        esas filas. La forma de la respuesta se diseñó para lectores internos.
//   B3 · Registro de acceso a PII (Ley 1581 art. 17, AGENTS.md §16): el módulo no llamaba a
//        `logPiiAccess` en ningún punto y entrega cédulas.
//
// ── Cómo se mide, que es la mitad del asunto ─────────────────────────────────────────────────────
//
// El mock `chain` del repo devuelve la fila ENTERA aunque el `select` pidiera menos, así que un test
// de «el campo no viene» puede pasar sin comprobar nada. Por eso los asertos de B2 se hacen sobre
// `Object.keys()` del objeto que la RUTA SERIALIZA —la respuesta HTTP—, con un mock que devuelve
// deliberadamente la fila completa con todos los campos internos rellenos: si la proyección
// desaparece, esos campos aparecen en la respuesta y el test cae. Comprobado con siete mutantes, uno
// por corrección: `sinCamposInternos` sin borrar nada, `guardiaCanalCliente` sustituido por `next()`,
// el patrón `:id` convertido en prefijo laxo, el `registrarAccesoSoat` de la cola quitado, el
// `omitirUsuario` del historial ignorado, el filtro por tipo de los soportes anulado y las facetas
// volviendo a consultar proveedores. Los siete mueren aquí.
//
// Y la contraparte, que es el requisito duro de esta corrección: los 11 roles internos no cambian de
// comportamiento. Cada afirmación de negación tiene su pareja de no-regresión con un rol interno.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    // `selectDistinct` comparte el espía con `select`: las facetas lo usan y el conteo de consultas
    // de esta prueba tiene que verlas todas.
    select: selectMock, selectDistinct: selectMock,
    insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([]),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** Igual que en `clients-listado.pii.test.ts`: se fija el CONTRATO del helper, no la forma del INSERT. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

/** Enlaces firmados: lo que importa aquí es QUÉ soportes salen, no cómo se firma su URL. */
vi.mock('../../src/services/storage.js', () => ({
  firmarDescargaEntidad: (key: string) => `/api/files?k=${key}`,
  uploadEntityDocument: vi.fn(),
  presignedGetEntityDocument: vi.fn(),
}));

/** El RUNT es una dependencia externa de pago: se afirma si se LLAMA, no lo que devuelve. */
const consultarPersonaRuntMock = vi.fn().mockResolvedValue({ ok: true, data: {} });
const consultarVehiculoRuntMock = vi.fn().mockResolvedValue({ ok: true, data: {} });
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarPersonaRunt: (...a: unknown[]) => consultarPersonaRuntMock(...a),
  consultarVehiculoRunt: (...a: unknown[]) => consultarVehiculoRuntMock(...a),
}));

const { RUTAS_PERMITIDAS_CLIENTE, rutaPermitidaParaCliente } =
  await import('../../src/shared/middleware/canal-cliente.js');
const { CAMPOS_PII_SOAT, RECURSO_SOAT } = await import('../../src/modules/flito-soat/flito-soat.pii.js');
const { AUTOR_INTERNO_ANONIMO } = await import('../../src/shared/historial/estado-historial.js');

beforeEach(() => {
  selectMock.mockReset();
  logPiiAccessMock.mockClear();
  consultarPersonaRuntMock.mockClear();
  consultarVehiculoRuntMock.mockClear();
});

/**
 * Los routers REALES, montados en sus prefijos REALES.
 *
 * Los prefijos importan: el guarda compara `req.originalUrl` contra patrones absolutos, así que
 * montar el router de SOAT en otro sitio probaría otra cosa. Son los mismos de `app.ts`.
 */
async function buildApp() {
  const app = express();
  app.use(express.json());
  const [vehiculos, runt, soat] = await Promise.all([
    import('../../src/modules/vehicles/vehicles.routes.js'),
    import('../../src/modules/runt/runt.routes.js'),
    import('../../src/modules/flito-soat/flito-soat.routes.js'),
  ]);
  app.use('/api/vehicles', vehiculos.default);
  app.use('/api/runt', runt.default);
  app.use('/api/flito/soat', soat.default);
  return app;
}

const auth = async (role: string, sub = 1) => `Bearer ${await testToken({ sub, username: 'u', role: role as never })}`;

const SOAT_ID = '00000000-0000-0000-0000-0000000000aa';

/** Los 11 roles que YA existían. Ninguno puede cambiar de comportamiento por esta corrección. */
const ROLES_INTERNOS = [
  'admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota',
  'conductor', 'auditor', 'gestor_impuestos', 'mensajero', 'financiera',
] as const;

// ─────────────────────────── B1 · negación por defecto ──────────────────────────────────────────

describe('B1 — lo que el `cliente` NO puede pedir (y los internos sí siguen pudiendo)', () => {
  it('GET /api/vehicles → 403 para `cliente`, y la consulta ni se emite', async () => {
    const r = await request(await buildApp()).get('/api/vehicles?limit=500')
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(403);
    // El mismo cuerpo que `requireRole`: quien sondea no puede distinguir «no está en mi lista» de
    // «exige otro rol», y por tanto no puede usar la diferencia para mapear la API.
    expect(r.body).toEqual({ error: 'Sin permisos' });
    // Lo que de verdad se comprueba: el handler NUNCA corrió. Un 403 emitido después de leer el
    // padrón seguiría siendo una lectura del padrón.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('los 11 roles internos siguen entrando a GET /api/vehicles exactamente como antes', async () => {
    const app = await buildApp();
    for (const rol of ROLES_INTERNOS) {
      selectMock.mockReturnValue(chain([
        { id: 1, vin: 'VIN1', plate: 'ABC123', ownerName: 'PEDRO GÓMEZ', ownerDocument: '79345612' },
      ]));
      const r = await request(app).get('/api/vehicles').set('Authorization', await auth(rol));
      expect(r.status, `rol ${rol}`).toBe(200);
      expect(r.body[0].vin, `rol ${rol}`).toBe('VIN1');
    }
  });

  it('POST /api/runt/consulta-persona → 403 y el RUNT no se consulta (modelo de pago)', async () => {
    const r = await request(await buildApp()).post('/api/runt/consulta-persona')
      .set('Authorization', await auth('cliente'))
      .send({ documento: '79345612', tipoDocumento: 'CC' });

    expect(r.status).toBe(403);
    expect(consultarPersonaRuntMock).not.toHaveBeenCalled();
  });

  it('un rol interno SÍ consulta el RUNT: la corrección no toca esa puerta', async () => {
    const r = await request(await buildApp()).post('/api/runt/consulta-persona')
      .set('Authorization', await auth('admin'))
      .send({ documento: '79345612', tipoDocumento: 'CC' });

    expect(r.status).not.toBe(403);
    expect(consultarPersonaRuntMock).toHaveBeenCalledTimes(1);
  });

  it('las 9 mutaciones de flito-soat quedan negadas DOS veces (guarda + requireRole)', async () => {
    const app = await buildApp();
    const mutaciones: Array<[string, unknown]> = [
      ['/api/flito/soat/enviar', { ids: [SOAT_ID], gestionOperaciones: true }],
      [`/api/flito/soat/${SOAT_ID}/rechazar`, { motivo: 'x' }],
      [`/api/flito/soat/${SOAT_ID}/reactivar`, { motivo: 'x' }],
      [`/api/flito/soat/${SOAT_ID}/reversar`, { estadoDestino: 'pendiente', motivo: 'motivo' }],
      [`/api/flito/soat/${SOAT_ID}/proveedor`, { proveedorSoatId: SOAT_ID, motivo: 'x' }],
      [`/api/flito/soat/${SOAT_ID}/asumir-operaciones`, { motivo: 'motivo' }],
      [`/api/flito/soat/${SOAT_ID}/devolver-gestor`, { proveedorSoatId: SOAT_ID, motivo: 'motivo' }],
      [`/api/flito/soat/${SOAT_ID}/factura`, {}],
      ['/api/flito/soat/facturas', {}],
    ];
    for (const [ruta, cuerpo] of mutaciones) {
      const r = await request(app).post(ruta).set('Authorization', await auth('cliente')).send(cuerpo);
      expect(r.status, ruta).toBe(403);
      expect(selectMock, ruta).not.toHaveBeenCalled();
    }
  });
});

describe('B1 — lo que el `cliente` SÍ puede pedir: su única pantalla, entera', () => {
  /** Encola lo que la cola consulta: `contextoSoat`, el conteo, la página y los trámites. */
  const colaVacia = () => {
    selectMock.mockReturnValueOnce(chain([{ c: 7 }]));
    selectMock.mockReturnValueOnce(chain([{ total: 0 }]));
    selectMock.mockReturnValueOnce(chain([]));
  };

  it('GET /api/flito/soat → 200', async () => {
    colaVacia();
    const r = await request(await buildApp()).get('/api/flito/soat?estado=pagado')
      .set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
  });

  it('GET /api/flito/soat/facetas → 200', async () => {
    selectMock.mockReturnValueOnce(chain([{ c: 7 }]));
    selectMock.mockReturnValue(chain([]));
    const r = await request(await buildApp()).get('/api/flito/soat/facetas')
      .set('Authorization', await auth('cliente'));
    expect(r.status).toBe(200);
  });

  it('detalle, historial y soportes llegan al handler (404 del aislamiento, NUNCA 403 del guarda)', async () => {
    const app = await buildApp();
    for (const ruta of [`/api/flito/soat/${SOAT_ID}`, `/api/flito/soat/${SOAT_ID}/historial`, `/api/flito/soat/${SOAT_ID}/soportes`]) {
      selectMock.mockReset();
      selectMock.mockReturnValueOnce(chain([{ c: 7 }])); // contextoSoat
      selectMock.mockReturnValueOnce(chain([]));         // buscarConAcceso → no existe
      const r = await request(app).get(ruta).set('Authorization', await auth('cliente'));
      // 404 y no 403: la pertenencia la resuelve `buscarConAcceso`, y el guarda ya lo dejó pasar.
      expect(r.status, ruta).toBe(404);
    }
  });
});

describe('B1 — la allowlist, como función pura (el patrón, no el prefijo)', () => {
  it('un prefijo laxo `/api/flito/soat` NO abre las rutas de mutación del mismo router', () => {
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat/enviar')).toBe(false);
    expect(rutaPermitidaParaCliente('POST', `/api/flito/soat/${SOAT_ID}/factura`)).toBe(false);
    expect(rutaPermitidaParaCliente('POST', '/api/flito/soat')).toBe(false);
    // Y el patrón está anclado por los DOS extremos: sin el `$`, `/api/flito/soat` abriría
    // cualquier ruta que empiece igual —incluido un router hermano que se monte mañana.
    expect(rutaPermitidaParaCliente('GET', '/api/flito/soat-interno')).toBe(false);
    expect(rutaPermitidaParaCliente('GET', '/otra/api/flito/soat')).toBe(false);
  });

  it('`:id` casa UN segmento y no una cola entera', () => {
    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/${SOAT_ID}`)).toBe(true);
    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/${SOAT_ID}/historial`)).toBe(true);
    expect(rutaPermitidaParaCliente('GET', `/api/flito/soat/${SOAT_ID}/historial/algo-mas`)).toBe(false);
  });

  it('las nueve rutas que el auditor midió como alcanzables están fuera', () => {
    const auditadas: Array<[string, string]> = [
      ['GET', '/api/vehicles'],
      ['GET', '/api/vehicles/1HGCM82633A004352/historial'],
      ['GET', '/api/vehicles/1HGCM82633A004352/certificado'],
      ['POST', '/api/runt/consulta-persona'],
      ['POST', '/api/runt/consulta-vehiculo'],
      ['POST', '/api/runt/ocr-cedula'],
      ['POST', '/api/simit/consulta'],
      ['GET', '/api/fasecolda/buscar'],
      ['GET', '/api/mercadolibre/precio'],
    ];
    for (const [metodo, ruta] of auditadas) {
      expect(rutaPermitidaParaCliente(metodo, ruta), `${metodo} ${ruta}`).toBe(false);
    }
  });

  it('la sesión de la SPA entra entera: `/auth/me` y `/auth/logout` incluidos', () => {
    expect(rutaPermitidaParaCliente('GET', '/api/auth/me')).toBe(true);
    expect(rutaPermitidaParaCliente('POST', '/api/auth/logout')).toBe(true);
    // Y nada más de `auth`: el resto del router no se abre por vecindad.
    expect(rutaPermitidaParaCliente('POST', '/api/auth/login')).toBe(false);
    expect(rutaPermitidaParaCliente('GET', '/api/auth/logout')).toBe(false);
  });

  it('cada entrada declarada casa con su propio patrón (nadie escribe una que no aplica)', () => {
    for (const r of RUTAS_PERMITIDAS_CLIENTE) {
      const concreta = r.patron.replace(':id', SOAT_ID);
      expect(rutaPermitidaParaCliente(r.metodo, concreta), `${r.metodo} ${concreta}`).toBe(true);
    }
  });

  it('cada entrada de la lista lleva escrito su porqué (una lista sin motivo se infla sola)', () => {
    expect(RUTAS_PERMITIDAS_CLIENTE.length).toBeGreaterThan(0);
    for (const r of RUTAS_PERMITIDAS_CLIENTE) {
      expect(r.porque.trim().length, `${r.metodo} ${r.patron}`).toBeGreaterThan(20);
      expect(r.patron.startsWith('/api/'), r.patron).toBe(true);
    }
  });
});

// ─────────────────────────── B2 · proyección por rol ────────────────────────────────────────────

/** Una fila COMPLETA, con todos los campos internos rellenos: el mock no esconde nada. */
const FILA_COLA = {
  id: SOAT_ID, vin: 'VIN0001', estado: 'pagado', proveedorSoatId: 'prov-uuid',
  gestionOperaciones: false, enviadoEn: new Date('2026-08-01T10:00:00Z'),
  pagadoEn: new Date('2026-08-05T10:00:00Z'), valorPagado: '412300', motivoRechazo: null,
  createdAt: new Date('2026-07-30T10:00:00Z'), placa: 'ABC123', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '2000', carroceria: 'CAMIONETA', tipoServicio: 'PARTICULAR',
  companiaNombre: 'ACME S.A.S.', organismoNombre: 'Chía', proveedorSoatNombre: 'SEGUROS XYZ',
  proveedorSlaHoras: 24, enviadoPorNombre: 'Ana Gómez',
};

/** Los cinco campos que la operación se queda para sí. */
const SOLO_INTERNOS = ['proveedorSoatId', 'proveedorSoatNombre', 'gestionOperaciones', 'enviadoPorNombre', 'valorPagado'];

function encolarCola(rolCliente: boolean) {
  if (rolCliente) selectMock.mockReturnValueOnce(chain([{ c: 7 }])); // contextoSoat
  selectMock.mockReturnValueOnce(chain([{ total: 1 }]));             // conteo
  selectMock.mockReturnValueOnce(chain([FILA_COLA]));                // página
  selectMock.mockReturnValueOnce(chain([]));                         // trámites (→ sin compradores)
}

describe('B2 — la cola servida al `cliente` no lleva la trastienda de FLITO', () => {
  it('cliente: ni proveedor, ni SLA, ni valorPagado, ni el empleado que lo despachó', async () => {
    encolarCola(true);
    const r = await request(await buildApp()).get('/api/flito/soat')
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    const item = r.body.items[0];
    // Sobre las CLAVES del objeto serializado, no sobre lo que el mock devolvió: `chain` entrega la
    // fila entera aunque el `select` pidiera menos, así que un `toBeUndefined()` sobre un valor no
    // demostraría que la proyección existe.
    for (const campo of [...SOLO_INTERNOS, 'proveedorSlaHoras']) {
      expect(Object.keys(item), campo).not.toContain(campo);
    }
    // Y lo suyo sigue llegando: sin esto, «no ve nada» pasaría el test igual.
    expect(item).toMatchObject({ id: SOAT_ID, placa: 'ABC123', estado: 'pagado', companiaNombre: 'ACME S.A.S.' });
  });

  it('admin: la misma fila con TODO, como antes de la corrección (no-regresión)', async () => {
    encolarCola(false);
    const r = await request(await buildApp()).get('/api/flito/soat')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    const item = r.body.items[0];
    for (const campo of SOLO_INTERNOS) expect(Object.keys(item), campo).toContain(campo);
    expect(item.proveedorSoatNombre).toBe('SEGUROS XYZ');
    expect(item.valorPagado).toBe(412300);
    expect(item.enviadoPorNombre).toBe('Ana Gómez');
  });

  it('las facetas del `cliente` no listan proveedores, y esa consulta ni se emite', async () => {
    selectMock.mockReturnValueOnce(chain([{ c: 7 }]));  // contextoSoat
    selectMock.mockReturnValue(chain([]));              // compañías y organismos
    const r = await request(await buildApp()).get('/api/flito/soat/facetas')
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    expect(r.body.proveedores).toEqual([]);
    // `contextoSoat` + compañías + organismos. La cuarta sería la de proveedores: no se lee lo que
    // no se va a devolver.
    expect(selectMock).toHaveBeenCalledTimes(3);
  });
});

describe('B2 — el detalle y su volcado de OCR', () => {
  const encolarDetalle = (rolCliente: boolean, companiaId = 7) => {
    if (rolCliente) selectMock.mockReturnValueOnce(chain([{ c: 7 }]));
    selectMock.mockReturnValueOnce(chain([{
      soat: { id: SOAT_ID, companiaId, estado: 'pagado', proveedorSoatId: 'prov-uuid', gestionOperaciones: false, pagadoEn: new Date('2026-08-05T10:00:00Z'), extraccion: { valor: 412300, nitProveedor: '900123456' } },
      dentroDeFrontera: true,
    }]));
    selectMock.mockReturnValueOnce(chain([FILA_COLA])); // filas del detalle
    selectMock.mockReturnValueOnce(chain([]));          // trámites
  };

  it('cliente: sin campos internos y SIN `extraccion` (que es la factura de la aseguradora)', async () => {
    encolarDetalle(true);
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    for (const campo of [...SOLO_INTERNOS, 'extraccion']) {
      expect(Object.keys(r.body), campo).not.toContain(campo);
    }
    expect(r.body.pagadoEn).toBe('2026-08-05T10:00:00.000Z');
  });

  it('admin: el detalle completo, con `extraccion` (no-regresión)', async () => {
    encolarDetalle(false);
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.extraccion).toEqual({ valor: 412300, nitProveedor: '900123456' });
    expect(r.body.valorPagado).toBe(412300);
  });
});

describe('B2 — el historial no entrega nombres ni correos de empleados de FLIT', () => {
  const FILA_HISTORIAL = {
    id: 1, estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: 'Envío al gestor',
    origen: 'usuario', usuarioNombre: 'Ana Gómez', usuarioEmail: 'ana.gomez@flit.com.co',
    creadoEn: new Date('2026-08-01T10:00:00Z'),
  };

  const encolar = (rolCliente: boolean) => {
    if (rolCliente) selectMock.mockReturnValueOnce(chain([{ c: 7 }]));
    selectMock.mockReturnValueOnce(chain([{
      soat: { id: SOAT_ID, companiaId: 7, estado: 'pagado', gestionOperaciones: false, proveedorSoatId: null, pagadoEn: null, extraccion: null },
      dentroDeFrontera: true,
    }]));
    selectMock.mockReturnValueOnce(chain([FILA_COLA]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([FILA_HISTORIAL]));
  };

  it('cliente: el actor es la EMPRESA, no la persona; ni el nombre ni el correo salen', async () => {
    encolar(true);
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/historial`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    expect(r.body[0].usuario).toBe(AUTOR_INTERNO_ANONIMO);
    // El correo corporativo tampoco se cuela por ningún otro campo de la respuesta.
    expect(JSON.stringify(r.body)).not.toContain('ana.gomez@flit.com.co');
    expect(JSON.stringify(r.body)).not.toContain('Ana Gómez');
    // Y lo que sí es suyo sigue estando: qué pasó y por qué.
    expect(r.body[0]).toMatchObject({ estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: 'Envío al gestor' });
  });

  it('admin: sigue viendo quién movió cada estado (no-regresión)', async () => {
    encolar(false);
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/historial`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body[0].usuario).toBe('Ana Gómez');
  });
});

describe('B2 — los soportes de origen interno no se sirven al `cliente`', () => {
  const SOPORTE_INTERNO = {
    id: 'sop-1', tipo: 'factura_soat', nombreArchivo: 'factura-aseguradora.pdf',
    storageKey: 'flito/soat/factura.pdf', subidoEn: new Date('2026-08-05T10:00:00Z'),
  };

  const encolar = (rolCliente: boolean) => {
    if (rolCliente) selectMock.mockReturnValueOnce(chain([{ c: 7 }]));
    selectMock.mockReturnValueOnce(chain([{
      soat: { id: SOAT_ID, companiaId: 7, estado: 'pagado', gestionOperaciones: false, proveedorSoatId: null, pagadoEn: null, extraccion: null },
      dentroDeFrontera: true,
    }]));
    selectMock.mockReturnValueOnce(chain([FILA_COLA]));
    selectMock.mockReturnValueOnce(chain([]));
  };

  it('cliente: lista vacía, y la consulta de soportes ni se emite', async () => {
    encolar(true);
    // Encoladas A PROPÓSITO y nunca consumidas: si el filtro por tipo desapareciera, la consulta se
    // emitiría y el `cliente` recibiría la factura de la aseguradora. Así el mutante cae en el
    // aserto, no en un timeout por falta de mock.
    selectMock.mockReturnValueOnce(chain([SOPORTE_INTERNO]));
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('cliente'));

    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    // contextoSoat + buscarConAcceso + detalle + trámites. Ninguna más: la factura de la aseguradora
    // no se lee para descartarla después.
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('admin: sigue recibiendo la factura de la aseguradora con su enlace firmado (no-regresión)', async () => {
    encolar(false);
    selectMock.mockReturnValueOnce(chain([SOPORTE_INTERNO])); // porRegistro
    selectMock.mockReturnValueOnce(chain([]));                // comprobante PSE de la boleta
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}/soportes`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'factura-aseguradora.pdf' });
  });
});

// ─────────────────────────── B3 · registro de acceso a PII ──────────────────────────────────────

describe('B3 — leer SOAT deja rastro (Ley 1581 art. 17, AGENTS.md §16)', () => {
  const ultimo = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

  it('la cola registra `search` con los campos entregados y cuántas filas salieron', async () => {
    encolarCola(false);
    await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));

    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimo()).toMatchObject({
      resourceTipo: RECURSO_SOAT, accion: 'search', camposAccedidos: [...CAMPOS_PII_SOAT],
    });
    expect(ultimo().motivo).toContain('filas=1');
  });

  it('el detalle registra `read` y el uuid del SOAT — nunca la placa ni la cédula', async () => {
    selectMock.mockReturnValueOnce(chain([{
      soat: { id: SOAT_ID, companiaId: 7, estado: 'pagado', gestionOperaciones: false, proveedorSoatId: null, pagadoEn: null, extraccion: null },
      dentroDeFrontera: true,
    }]));
    selectMock.mockReturnValueOnce(chain([FILA_COLA]));
    selectMock.mockReturnValueOnce(chain([]));
    await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}`).set('Authorization', await auth('admin'));

    expect(ultimo()).toMatchObject({ resourceTipo: RECURSO_SOAT, accion: 'read' });
    expect(ultimo().motivo).toContain(SOAT_ID);
    // El motivo es texto que se guarda: meter ahí la placa sería registrar el dato que se protege.
    expect(ultimo().motivo).not.toContain('ABC123');
    expect(ultimo().camposAccedidos).toEqual([...CAMPOS_PII_SOAT]);
  });

  it('un SOAT que no existe (o fuera de la frontera) NO registra acceso: nadie miró nada', async () => {
    selectMock.mockReturnValueOnce(chain([])); // buscarConAcceso → null
    const r = await request(await buildApp()).get(`/api/flito/soat/${SOAT_ID}`)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('un 403 tampoco registra: el guarda corta antes de que haya lectura', async () => {
    await request(await buildApp()).get('/api/vehicles').set('Authorization', await auth('cliente'));
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('el rastro declara NOMBRES DE COLUMNA, nunca los valores leídos', async () => {
    encolarCola(false);
    await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));

    const campos = ultimo().camposAccedidos as string[];
    for (const valor of ['ABC123', 'VIN0001', 'ACME S.A.S.', 'Ana Gómez']) {
      expect(campos.join(' '), valor).not.toContain(valor);
    }
    expect(campos).toContain('numero_documento');
  });
});
