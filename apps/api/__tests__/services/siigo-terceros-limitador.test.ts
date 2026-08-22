// HU #11299 — el limitador va ANTES de la guarda en `POST /siigo/terceros/cliente/:clienteId`.
//
// Deuda de seguridad declarada en el PR #194. Con el orden anterior —`ESCRITURA, asegurarLimiter`—
// la guarda resolvía el 403 sin que el limitador llegara a contar la petición, y `exigirAccionSiigo`
// escribe una fila `permiso_denegado` en `siigo_operaciones` por cada intento. Esa tabla es
// append-only por disparador (HU #11251): lo que entra ahí no se borra ni se rectifica. Un
// autenticado cualquiera —con rol de consulta, sin permiso de emitir— podía meter así las ~500 filas
// que le permitiera `apiLimiter` cada quince minutos en una bitácora que nadie puede podar.
//
// Lo que se demuestra:
//
//   1. **El limitador cuenta también lo denegado**: el 403 sale con las cabeceras del límite, que
//      solo existen si el middleware llegó a ejecutarse.
//   2. **Y por tanto tiene tope**: agotada la ventana, el intento siguiente es 429 y NO escribe una
//      fila más en la bitácora WORM. Es la garantía de fondo, medida en la cuenta real de escrituras.
//   3. **No se debilitó el permiso**: el 403 lo sigue dando la misma guarda, el handler no se
//      ejecuta y quien sí puede emitir sigue pasando.
//
// La cuota se lleva por usuario (`userOrIpKey`), así que cada prueba usa su propio `sub`: quien
// insiste sin permiso se frena a sí mismo y no al que factura. Es también lo que hace que estas
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

vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: vi.fn().mockResolvedValue(undefined),
}));

/** La bitácora WORM: aquí es donde se cuentan las filas que un denegado puede provocar. */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: (...args: unknown[]) => registrarOperacionMock(...args),
}));

const asegurarMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.terceros.service.js', () => {
  class SiigoTerceroError extends Error {
    readonly codigo: string;
    constructor(codigo: string, message: string) {
      super(message);
      this.name = 'SiigoTerceroError';
      this.codigo = codigo;
    }
  }
  return {
    SiigoTerceroError,
    asegurarTercero: (...args: unknown[]) => asegurarMock(...args),
    vinculoDeCliente: vi.fn(),
    resumenTerceros: vi.fn(),
  };
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/terceros.routes.js');
  app.use('/api/siigo/terceros', router);
  return app;
}

const auth = async (role: TestRole, sub: number) =>
  `Bearer ${await testToken({ sub, username: `${role}-${sub}@flit.io`, role })}`;

/** Cuántas peticiones deja pasar `asegurarLimiter` por ventana. */
const MAX_VENTANA = 60;

beforeEach(() => {
  registrarOperacionMock.mockClear();
  asegurarMock.mockReset();
});

describe('el intento denegado se cuenta antes de escribirse', () => {
  it('el 403 sale con las cabeceras del límite: el limitador llegó a ejecutarse', async () => {
    // Con `ESCRITURA` delante, la respuesta se resolvía sin pasar por el limitador y estas
    // cabeceras no existían. Son la huella externa del orden.
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('auditor', 101));

    expect(r.status).toBe(403);
    expect(r.headers['x-ratelimit-limit']).toBe(String(MAX_VENTANA));
    expect(r.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
  });

  it('cada denegación consume cuota del que insiste', async () => {
    const app = await buildApp();
    const token = await auth('auditor', 102);

    const primera = await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', token);
    const segunda = await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', token);

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
    const token = await auth('auditor', 103);

    for (let i = 0; i < MAX_VENTANA; i += 1) {
      const r = await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', token);
      expect(r.status).toBe(403);
    }
    expect(registrarOperacionMock).toHaveBeenCalledTimes(MAX_VENTANA);

    const frenado = await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', token);

    expect(frenado.status).toBe(429);
    // Ni una más: el 429 se resuelve en el limitador, antes de la guarda que escribe.
    expect(registrarOperacionMock).toHaveBeenCalledTimes(MAX_VENTANA);
  });

  it('lo que se escribe sigue siendo el intento denegado, sin datos personales', async () => {
    const app = await buildApp();

    await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('auditor', 104));

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

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('auditor', 105));

    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ accion: 'emitir' });
    expect(asegurarMock).not.toHaveBeenCalled();
  });

  it('sin token sigue siendo 401: el limitador no autentica a nadie', async () => {
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41');

    expect(r.status).toBe(401);
    expect(asegurarMock).not.toHaveBeenCalled();
  });

  it('quien sí puede emitir pasa igual que antes', async () => {
    asegurarMock.mockResolvedValue({
      clienteId: 41, siigoCustomerId: 'c-9f2b', identificacion: '1036640908',
      sucursal: 0, desenlace: 'creado',
    });
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('financiera', 106));

    expect(r.status).toBe(200);
    expect(asegurarMock).toHaveBeenCalledWith(41);
  });
});
