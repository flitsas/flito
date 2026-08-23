// HU #11340 — el limitador va ANTES de la guarda en las rutas de la bandeja de fallidos.
//
// Cuarta aparición del mismo defecto (`terceros.routes.ts`, `envio-correo.routes.ts` y
// `facturacion.routes.ts` lo pagaron antes, en la HU #11299). Con la guarda delante, el 403 se
// resuelve sin que el limitador llegue a contar la petición, y `exigirAccionSiigo` escribe una fila
// `permiso_denegado` en `siigo_operaciones` por cada intento. Esa tabla es append-only por
// disparador desde la migración `0126`: lo que entra ahí no se borra ni se rectifica, así que un
// autenticado cualquiera —con rol de consulta, sin permiso de operación— podía meterle las ~500
// filas que le permitiera `apiLimiter` cada quince minutos en una bitácora que nadie puede podar.
//
// Router nuevo = ocasión nueva de repetirlo. Por eso esta prueba nace con la ruta y no después.
//
// La cuota se lleva por USUARIO (`userOrIpKey`), así que cada prueba usa su propio `sub`: quien
// insiste sin permiso se frena a sí mismo y no a quien opera la bandeja de verdad.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import 'express-async-errors';
import express from 'express';
import { testToken, type TestRole } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: vi.fn().mockResolvedValue(undefined),
}));

/** La bitácora WORM: aquí es donde se cuentan las filas que un denegado puede provocar. */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: (...args: unknown[]) => registrarOperacionMock(...args),
  consultarBitacora: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/modules/siigo/siigo.bandeja.service.js', () => ({
  consultarBandeja: vi.fn().mockResolvedValue({
    ambiente: 'pruebas', items: [], limite: 50, offset: 0, hayMas: false,
  }),
  resumenBandeja: vi.fn().mockResolvedValue({
    ambiente: 'pruebas', total: 0,
    porFuente: { emision: 0, dian: 0, correo: 0 },
    porResponsable: { operacion: 0, contabilidad: 0, soporte: 0, automatico: 0 },
    porCodigo: [],
  }),
  descartesVigentes: vi.fn(), guiaDelCaso: vi.fn(), HITO_DESCARTE: 'marcada_fallido_definitivo',
}));

const reintentarMock = vi.fn().mockResolvedValue({
  ambiente: 'pruebas', items: [],
  resumen: { total: 0, encolados: 0, yaEstaban: 0, descartados: 0, porResultado: {} },
});
vi.mock('../../src/modules/siigo/siigo.bandeja-acciones.service.js', () => ({
  reintentarEmision: (...a: unknown[]) => reintentarMock(...a),
  reenviarCorreo: vi.fn(),
  descartarCaso: vi.fn(),
  reactivarCaso: vi.fn(),
  SiigoBandejaError: class SiigoBandejaError extends Error {
    codigo: string;

    constructor(codigo: string, mensaje: string) { super(mensaje); this.codigo = codigo; }
  },
}));

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/bandeja.routes.js');
  app.use('/api/siigo/bandeja', router);
  return app;
}

const auth = async (role: TestRole, sub: number) =>
  `Bearer ${await testToken({ sub, username: `${role}-${sub}@flit.io`, role })}`;

const RUTA = '/api/siigo/bandeja/reintentar';
const FACTURA = 'ffffffff-1111-4111-8111-ffffffffffff';
const CUERPO = { facturaIds: [FACTURA] };

/** Cuántas peticiones deja pasar `accionLimiter` por ventana (un minuto). */
const MAX_VENTANA = 20;

const filasDenegadas = () => registrarOperacionMock.mock.calls
  .map((c) => c[0] as { operacion: string })
  .filter((r) => r.operacion === 'permiso_denegado');

beforeEach(() => {
  registrarOperacionMock.mockClear();
  reintentarMock.mockClear();
});

describe('el intento denegado se cuenta ANTES de escribirse en la bitácora WORM', () => {
  it('el 403 sale con las cabeceras del límite: son la huella externa del orden', async () => {
    // Con la guarda delante, la respuesta se resolvía sin pasar por el limitador y estas cabeceras
    // no existían. Es lo único observable desde fuera que distingue los dos órdenes.
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('auditor', 401)).send(CUERPO);

    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ accion: 'reintentar' });
    expect(r.headers['x-ratelimit-limit']).toBe(String(MAX_VENTANA));
    expect(r.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
  });

  it('agotada la ventana, el siguiente intento es 429 y NO deja fila en la bitácora', async () => {
    // La garantía de fondo, y la única que se mide en escrituras: `siigo_operaciones` no acepta
    // UPDATE ni DELETE, así que el techo del ataque es literalmente el techo de la tabla.
    const app = await buildApp();
    const token = await auth('auditor', 402);

    for (let i = 0; i < MAX_VENTANA; i += 1) {
      expect((await request(app).post(RUTA).set('Authorization', token).send(CUERPO)).status)
        .toBe(403);
    }
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);

    const frenado = await request(app).post(RUTA).set('Authorization', token).send(CUERPO);
    expect(frenado.status).toBe(429);
    // Ni una fila más: el 429 se resuelve sin llegar a la guarda.
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);
  });

  it('el freno de un usuario no frena al que sí opera la bandeja', async () => {
    const app = await buildApp();
    const abusador = await auth('auditor', 403);
    for (let i = 0; i < MAX_VENTANA + 5; i += 1) {
      await request(app).post(RUTA).set('Authorization', abusador).send(CUERPO);
    }

    const legitimo = await request(app).post(RUTA)
      .set('Authorization', await auth('admin', 404)).send(CUERPO);

    expect(legitimo.status).toBe(202);
    expect(reintentarMock).toHaveBeenCalledTimes(1);
  });

  it('el reenvío de correo tiene su PROPIO cubo: agotar acciones no bloquea el correo', async () => {
    // Son limitadores distintos porque protegen cosas distintas: uno, la cola; el otro, la cuota de
    // peticiones a Siigo y el buzón del cliente. Compartir cubo haría que reintentar emisiones
    // —que no gasta ni una petición— dejara sin reenvíos a quien los necesita.
    const app = await buildApp();
    const token = await auth('auditor', 405);
    for (let i = 0; i < MAX_VENTANA + 2; i += 1) {
      await request(app).post(RUTA).set('Authorization', token).send(CUERPO);
    }

    const correo = await request(app).post('/api/siigo/bandeja/reenviar-correo')
      .set('Authorization', token).send(CUERPO);

    // 403 y no 429: la petición llegó hasta la guarda, así que su cubo estaba intacto.
    expect(correo.status).toBe(403);
  });
});
