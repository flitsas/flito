// HU #11299 — el limitador va ANTES de la guarda en `POST /siigo/envios/factura/:facturaId`.
//
// Es la misma vulnerabilidad que ya se cerró en `terceros.routes.ts` y que la segunda auditoría
// encontró viva en esta ruta hermana. Con el orden anterior —`ESCRITURA, envioLimiter`— la guarda
// resolvía el 403 sin que el limitador llegara a contar la petición, y `exigirAccionSiigo` escribe
// una fila `permiso_denegado` en `siigo_operaciones` por cada intento. Esa tabla es append-only por
// disparador (HU #11251): lo que entra ahí no se borra ni se rectifica. Un autenticado cualquiera
// —con rol de consulta, sin `reenviar_correo`— podía meter así las ~500 filas que le permitiera
// `apiLimiter` cada quince minutos en una bitácora que nadie puede podar.
//
// Lo que se demuestra, en el mismo orden que en `siigo-terceros-limitador.test.ts` porque es el
// mismo defecto y conviene que se lean igual:
//
//   1. **El limitador cuenta también lo denegado**: el 403 sale con las cabeceras del límite, que
//      solo existen si el middleware llegó a ejecutarse.
//   2. **Y por tanto tiene tope**: agotada la ventana, el intento siguiente es 429 y NO escribe una
//      fila más en la bitácora WORM. Es la garantía de fondo, medida en la cuenta real de
//      escrituras.
//   3. **No se debilitó el permiso**: el 403 lo sigue dando la misma guarda, el handler no se
//      ejecuta y quien sí puede reenviar sigue pasando.
//   4. **El 429 deja rastro** (`frenoConRastro`), que es lo que impide que la inversión convierta a
//      un actor persistente en invisible.
//
// La cuota se lleva por usuario (`userOrIpKey`), así que cada prueba usa su propio `sub`: quien
// insiste sin permiso se frena a sí mismo y no al que reenvía. Es también lo que hace que estas
// pruebas no se estorben entre sí compartiendo el almacén en memoria del limitador.

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

/** La bitácora WORM: aquí es donde se cuentan las filas que un denegado puede provocar. */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: (...args: unknown[]) => registrarOperacionMock(...args),
}));

const enviarMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.envio-correo.service.js', () => {
  class SiigoEnvioError extends Error {
    readonly codigo: string;

    constructor(codigo: string, message: string) {
      super(message);
      this.name = 'SiigoEnvioError';
      this.codigo = codigo;
    }
  }
  return {
    SiigoEnvioError,
    enviarFacturaPorCorreo: (...args: unknown[]) => enviarMock(...args),
    resumenEnvios: vi.fn().mockResolvedValue({ envios: [] }),
  };
});

const { rateLimitBloqueadoTotal } = await import('../../src/shared/metrics.js');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/envio-correo.routes.js');
  app.use('/api/siigo/envios', router);
  return app;
}

const auth = async (role: TestRole, sub: number) =>
  `Bearer ${await testToken({ sub, username: `${role}-${sub}@flit.io`, role })}`;

const FACTURA = '11111111-2222-3333-4444-555555555555';
const RUTA = `/api/siigo/envios/factura/${FACTURA}`;

/** Cuántas peticiones deja pasar `envioLimiter` por ventana. */
const MAX_VENTANA = 30;

/** Cuánto lleva contado el freno de ESTE limitador. La métrica es acumulativa y global. */
async function frenosContados(): Promise<number> {
  const metrica = await rateLimitBloqueadoTotal.get();
  return metrica.values
    .find((v) => v.labels.limitador === 'siigo-envio-correo')?.value ?? 0;
}

beforeEach(() => {
  registrarOperacionMock.mockClear();
  enviarMock.mockReset();
});

describe('el intento denegado se cuenta antes de escribirse', () => {
  it('el 403 sale con las cabeceras del límite: el limitador llegó a ejecutarse', async () => {
    // Con `ESCRITURA` delante, la respuesta se resolvía sin pasar por el limitador y estas
    // cabeceras no existían. Son la huella externa del orden.
    const app = await buildApp();

    const r = await request(app).post(RUTA).set('Authorization', await auth('auditor', 201));

    expect(r.status).toBe(403);
    expect(r.headers['x-ratelimit-limit']).toBe(String(MAX_VENTANA));
    expect(r.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
  });

  it('cada denegación consume cuota del que insiste', async () => {
    const app = await buildApp();
    const token = await auth('auditor', 202);

    const primera = await request(app).post(RUTA).set('Authorization', token);
    const segunda = await request(app).post(RUTA).set('Authorization', token);

    expect([primera.status, segunda.status]).toEqual([403, 403]);
    // Los valores exactos, no una resta entre dos cabeceras que podrían faltar las dos: sin
    // limitador `Number(undefined)` es `NaN` en los dos lados y una comparación relativa pasaría.
    expect(primera.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
    expect(segunda.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 2));
  });

  it('agotada la ventana, el siguiente intento es 429 y no deja fila en la bitácora WORM', async () => {
    // La garantía de fondo, y la única que se mide en escrituras: `siigo_operaciones` no acepta
    // UPDATE ni DELETE, así que el techo del ataque es literalmente el techo de la tabla.
    const app = await buildApp();
    const token = await auth('auditor', 203);

    for (let i = 0; i < MAX_VENTANA; i += 1) {
      const r = await request(app).post(RUTA).set('Authorization', token);
      expect(r.status).toBe(403);
    }
    expect(registrarOperacionMock).toHaveBeenCalledTimes(MAX_VENTANA);

    const frenado = await request(app).post(RUTA).set('Authorization', token);

    expect(frenado.status).toBe(429);
    // Ni una más: el 429 se resuelve en el limitador, antes de la guarda que escribe.
    expect(registrarOperacionMock).toHaveBeenCalledTimes(MAX_VENTANA);
  });

  it('lo que se escribe sigue siendo el intento denegado, sin datos personales', async () => {
    const app = await buildApp();

    await request(app).post(RUTA).set('Authorization', await auth('auditor', 204));

    expect(registrarOperacionMock).toHaveBeenCalledTimes(1);
    expect(registrarOperacionMock.mock.calls[0][0]).toMatchObject({
      operacion: 'permiso_denegado',
      statusHttp: 403,
      codigo: 'PERMISO_DENEGADO',
    });
  });
});

describe('el orden no debilita la guarda', () => {
  it('el rol sin permiso sigue recibiendo 403 y el handler no se ejecuta', async () => {
    const app = await buildApp();

    const r = await request(app).post(RUTA).set('Authorization', await auth('auditor', 205));

    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ accion: 'reenviar_correo' });
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('sin token sigue siendo 401: el limitador no autentica a nadie', async () => {
    const app = await buildApp();

    const r = await request(app).post(RUTA);

    expect(r.status).toBe(401);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('quien sí puede reenviar pasa igual que antes', async () => {
    enviarMock.mockResolvedValue({
      id: 'acta-1', facturaId: FACTURA, origen: 'reenvio', resultado: 'enviado',
      destinatarios: [{ correo: 'pagos@cliente.test', origen: 'compania' }],
    });
    const app = await buildApp();

    const r = await request(app).post(RUTA).set('Authorization', await auth('financiera', 206));

    expect(r.status).toBe(200);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it('el cuerpo inválido sigue dando 400: el limitador no valida nada', async () => {
    // Va después de la guarda y del limitador, y así se queda: el 400 sale del handler.
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('financiera', 207))
      .send({ destinatarios: ['no-es-un-correo'] });

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});

describe('el 429 no es un punto ciego', () => {
  it('el freno cuenta un punto en `rate_limit_bloqueado_total` con SU limitador', async () => {
    // Sin esto, la corrección de arriba convierte al que insiste en invisible a partir del intento
    // 31: deja de escribir en la bitácora —que es lo que se buscaba— y no aparecía en ningún otro
    // sitio. La etiqueta prueba además que el `handler` está cableado en ESTE limitador y no en
    // otro.
    const app = await buildApp();
    const token = await auth('auditor', 208);
    const antes = await frenosContados();

    for (let i = 0; i < MAX_VENTANA + 1; i += 1) {
      await request(app).post(RUTA).set('Authorization', token);
    }

    expect(await frenosContados()).toBe(antes + 1);
  });
});
