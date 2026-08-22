// Siigo — frontera HTTP de «asegurar el tercero» (HU #11299, AC4 y AC6).
//
// Lo que se prueba aquí y NO en siigo-terceros.test.ts: la TRADUCCIÓN del fallo a una respuesta.
// El servicio ya tiene su prueba de que relanza `ClienteNoFacturableError` sin envolverla; lo que
// faltaba —y era el defecto— es que este router la tradujera. Al no hacerlo, el motivo de fallo más
// frecuente (le faltan datos fiscales al cliente) salía como 500 «Error interno del servidor», que
// le dice al operador «se rompió el sistema» cuando lo que pasa es «a este cliente le falta el tipo
// de persona»: la primera frase manda a buscar a soporte, la segunda a la ficha del cliente.
//
// Las tres cosas que estas pruebas sostienen:
//   · el estado es 4xx y es 422 —no 409, que en este mismo router significa otra cosa—;
//   · el cuerpo lleva los faltantes UNO POR UNO, con la misma forma que el informe del validador;
//   · el cuerpo nombra CAMPOS y nunca sus valores, aunque el error de origen traiga de más.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
// Igual que `app.ts`, y no es decorativo: sin este parche Express 4 no reenvía el rechazo de un
// handler `async` al manejador de errores y la petición se queda colgada. Con él, lo que el router
// no traduzca sale como el 500 de producción — que es el síntoma exacto que esta HU corrige.
import 'express-async-errors';
import express from 'express';
import { MOTIVOS_NO_FACTURABLE, type FaltanteCliente } from '@operaciones/shared-types';
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

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

/**
 * El registro de salida de PII hacia Siigo (HU #11299) se neutraliza aquí y se prueba en
 * `siigo-terceros.pii.test.ts`, que es su sitio. Sin el mock, el `db.insert` de arriba —un `vi.fn()`
 * que devuelve `undefined`— hace fallar el INSERT de `pii_access_log`; no rompe nada, porque
 * `logPiiAccess` es best-effort, y por eso mismo dejaría un ERROR de ruido en una suite que mira la
 * traducción de errores HTTP.
 */
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: vi.fn().mockResolvedValue(undefined),
}));

// El servicio se sustituye entero: aquí no se prueba qué hace `asegurarTercero`, sino qué hace el
// router con lo que salga de él. `SiigoTerceroError` se redefine en el mock para que el `instanceof`
// del router y el que lanza la prueba sean la MISMA clase.
const asegurarMock = vi.fn();
const vinculoMock = vi.fn();
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
    vinculoDeCliente: (...args: unknown[]) => vinculoMock(...args),
  };
});

// El validador NO se mockea: `ClienteNoFacturableError` tiene que ser la clase real, que es
// justamente lo que el router recibe en producción.
const { ClienteNoFacturableError } = await import(
  '../../src/modules/siigo/siigo.validador-cliente.service.js'
);
const { SiigoTerceroError } = await import('../../src/modules/siigo/siigo.terceros.service.js');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/terceros.routes.js');
  app.use('/api/siigo/terceros', router);
  // Manejador genérico equivalente al de la app: si algo se escapa del `catch` del router, sale 500,
  // que es exactamente el síntoma que esta HU corrige.
  app.use((_e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: 'Error interno del servidor' });
  });
  return app;
}

const auth = async (role: TestRole, sub = 5) =>
  `Bearer ${await testToken({ sub, username: `${role}@flit.io`, role })}`;

/** Lo que el validador produce para un cliente al que le faltan tres cosas. */
const FALTANTES: FaltanteCliente[] = [
  { motivo: 'tipo_persona_sin_clasificar', detalle: MOTIVOS_NO_FACTURABLE.tipo_persona_sin_clasificar, campo: 'personType' },
  { motivo: 'direccion_faltante', detalle: MOTIVOS_NO_FACTURABLE.direccion_faltante, campo: 'address' },
  { motivo: 'telefono_faltante', detalle: MOTIVOS_NO_FACTURABLE.telefono_faltante, campo: 'phoneNumber' },
];

beforeEach(() => {
  asegurarMock.mockReset();
  vinculoMock.mockReset();
  auditMock.mockClear();
});

describe('AC6 — un cliente con la ficha incompleta se explica, no se cae', () => {
  it('devuelve 422 y no el 500 del manejador genérico', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(422);
    expect(r.body.error).not.toMatch(/Error interno del servidor/);
  });

  it('el cuerpo se identifica con un código propio y con el cliente', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.codigo).toBe('cliente_no_facturable');
    expect(r.body.clienteId).toBe(41);
  });

  it('no se audita como creación: no se creó ningún tercero', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', await auth('admin'));
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('AC4 — la pantalla puede nombrar los faltantes uno por uno', () => {
  it('viene la lista completa, no un «datos incompletos»', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.faltantes).toHaveLength(3);
    expect(r.body.faltantes.map((f: FaltanteCliente) => f.motivo)).toEqual([
      'tipo_persona_sin_clasificar', 'direccion_faltante', 'telefono_faltante',
    ]);
  });

  it('cada faltante trae motivo, detalle y campo — la misma forma del informe del validador', async () => {
    // Dos rutas del mismo módulo describiendo el mismo concepto de dos maneras es una deuda que
    // termina pagando el front. `GET /api/siigo/clientes/:id/validacion` devuelve `FaltanteCliente[]`
    // y este 422 devuelve exactamente eso, para que la lista se pinte con el mismo componente.
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.faltantes[1]).toEqual({
      motivo: 'direccion_faltante',
      detalle: MOTIVOS_NO_FACTURABLE.direccion_faltante,
      campo: 'address',
    });
  });

  it('el mensaje también enumera lo que falta, por si la pantalla solo pinta el texto', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.error).toContain(MOTIVOS_NO_FACTURABLE.direccion_faltante);
    expect(r.body.error).toContain(MOTIVOS_NO_FACTURABLE.telefono_faltante);
  });
});

describe('Ley 1581 — se nombran los campos, nunca sus valores', () => {
  it('un detalle contaminado con datos de la ficha no se reenvía', async () => {
    // El validador de hoy compone `detalle` desde catálogos estáticos, pero eso es una propiedad de
    // su código, no del contrato: si alguien mete el nombre o el NIT en el texto para depurar, el
    // dato acabaría en el navegador y en el log del proxy. El saneado del router lo impide.
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, [
      {
        motivo: 'direccion_faltante',
        detalle: 'Falta la dirección de ACME S.A.S. (NIT 900123456), correo tesoreria@acme.co',
        campo: 'address',
      },
    ]));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    const cuerpo = JSON.stringify(r.body);
    expect(cuerpo).not.toMatch(/900123456|ACME|acme\.co/);
    expect(r.body.faltantes[0].detalle).toBe(MOTIVOS_NO_FACTURABLE.direccion_faltante);
  });

  it('un `campo` que no es una columna del cliente se descarta', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, [
      { motivo: 'identificacion_faltante', detalle: 'x', campo: '900123456' },
    ]));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.faltantes[0]).toEqual({
      motivo: 'identificacion_faltante',
      detalle: MOTIVOS_NO_FACTURABLE.identificacion_faltante,
    });
    expect(JSON.stringify(r.body)).not.toContain('900123456');
  });

  it('un motivo fuera del catálogo no viaja: su texto es de origen desconocido', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, [
      { motivo: 'lo_que_sea' as never, detalle: 'Cliente Pepito Pérez, cédula 79123456', campo: 'name' },
      { motivo: 'direccion_faltante', detalle: MOTIVOS_NO_FACTURABLE.direccion_faltante, campo: 'address' },
    ]));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.body.faltantes).toHaveLength(1);
    expect(r.body.faltantes[0].motivo).toBe('direccion_faltante');
    expect(JSON.stringify(r.body)).not.toMatch(/Pepito|79123456/);
  });

  it('sin faltantes publicables sigue habiendo un 422 con un mensaje que sirve', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, [
      { motivo: 'lo_que_sea' as never, detalle: 'algo', campo: 'x' },
    ]));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(422);
    expect(r.body.faltantes).toEqual([]);
    expect(r.body.error).toMatch(/informe de clientes no facturables/);
  });
});

describe('La traducción que ya existía no se movió', () => {
  it('un cliente que no existe sigue siendo 404', async () => {
    asegurarMock.mockRejectedValue(new SiigoTerceroError('cliente_no_existe', 'El cliente no existe.'));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
  });

  it('el choque con OTRO cliente sigue siendo 409, y por eso el 422 informa de algo distinto', async () => {
    // 409 = hay que mirar otro registro o escalar. 422 = hay que corregir ESTE cliente. Fundirlos
    // volvería a perder, más discretamente, la información que esta HU recupera.
    asegurarMock.mockRejectedValue(new SiigoTerceroError(
      'siigo_rechazo', 'Otro cliente de FLITO ya está vinculado a esa identificación y sucursal.',
    ));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('siigo_rechazo');
  });

  it('el camino feliz sigue respondiendo 200 y auditando el desenlace', async () => {
    asegurarMock.mockResolvedValue({
      clienteId: 41, siigoCustomerId: 'abc', identificacion: '900123456', sucursal: 0,
      desenlace: 'creado',
    });
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('un identificador inválido se rechaza antes de llamar al servicio', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/abc')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(asegurarMock).not.toHaveBeenCalled();
  });
});

describe('La guarda sigue delante del 422', () => {
  it('sin token no se llega a saber si al cliente le faltan datos', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41');
    expect(r.status).toBe(401);
    expect(asegurarMock).not.toHaveBeenCalled();
  });

  it('un rol de consulta recibe 403 y no la lista de faltantes', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
    expect(r.body).not.toHaveProperty('faltantes');
    expect(asegurarMock).not.toHaveBeenCalled();
  });
});
