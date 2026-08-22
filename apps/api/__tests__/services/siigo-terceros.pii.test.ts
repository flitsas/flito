// HU #11299 — la salida de datos personales hacia Siigo deja rastro (`accion: 'export'`).
//
// El hueco que cerró la re-auditoría: `POST /siigo/terceros/cliente/:clienteId` no es una lectura
// interna. `armarTercero` compone el cuerpo del `POST`/`PUT` a `/v1/customers` de SIIGO —un
// proveedor externo— con nombre, identificación, dirección, ubicación, teléfono y contacto del
// cliente, y la respuesta devuelve además la identificación en claro. El panel de Terceros la llama
// en bucle sobre la lista de no facturables, hasta 500 clientes.
//
// Lo que se demuestra:
//
//   1. **Sale registrado como `export`, no como `read`**: que el dato cruce la frontera del sistema
//      es justo lo que la columna `accion` existe para poder reconstruir.
//   2. **Los campos dependen del DESENLACE.** `sin_cambios` no hace ni una petición a Siigo y
//      `vinculado_existente` solo mandó la identificación: declarar ahí los doce campos diría que
//      salió una ficha entera que nunca salió.
//   3. **No lo cubre `audit()`**, y por eso se comprueba que se escriben LOS DOS: la bitácora anota
//      la operación de negocio, el registro de acceso anota qué datos personales salieron.
//   4. **Lo que falla no exporta nada**: 422 por ficha incompleta y 403 por permiso no registran.
//   5. **El rastro no copia la identificación** que la respuesta sí devuelve.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import 'express-async-errors';
import express from 'express';
import { type FaltanteCliente } from '@operaciones/shared-types';
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

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: vi.fn().mockResolvedValue(undefined),
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined),
}));

/** Ver la nota del mismo mock en `siigo-validador-cliente.pii.test.ts`: se fija el contrato. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const asegurarMock = vi.fn();
const vinculoMock = vi.fn();
const resumenMock = vi.fn();
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
    resumenTerceros: (...args: unknown[]) => resumenMock(...args),
  };
});

const { ClienteNoFacturableError } = await import(
  '../../src/modules/siigo/siigo.validador-cliente.service.js'
);
const {
  CAMPOS_PII_IDENTIFICACION, CAMPOS_PII_TERCERO_EXPORTADO, RECURSO_CLIENTE,
} = await import('../../src/modules/siigo/siigo.pii.js');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/terceros.routes.js');
  app.use('/api/siigo/terceros', router);
  app.use((_e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: 'Error interno del servidor' });
  });
  return app;
}

const auth = async (role: TestRole, sub = 5) =>
  `Bearer ${await testToken({ sub, username: `${role}@flit.io`, role })}`;

const RESULTADO = {
  clienteId: 41,
  siigoCustomerId: 'c-9f2b',
  identificacion: '1036640908',
  sucursal: 0,
  desenlace: 'creado' as const,
};

const FALTANTES: FaltanteCliente[] = [
  { motivo: 'tipo_persona_sin_clasificar', detalle: 'Falta clasificar el tipo de persona.', campo: 'personType' },
];

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lo que sale hacia Siigo se registra como `export`', () => {
  it('crear un tercero declara los campos de la ficha que viajaron fuera', async () => {
    asegurarMock.mockResolvedValue(RESULTADO);
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      // `read` sería mentira: el dato no se quedó en casa.
      accion: 'export',
      camposAccedidos: [...CAMPOS_PII_TERCERO_EXPORTADO],
      resourceId: 41,
    });
    expect(ultimoAcceso().motivo).toContain('desenlace="creado"');
    // Doce columnas de `clients`, no las claves del JSON de Siigo: el log se cruza con la tabla.
    expect(CAMPOS_PII_TERCERO_EXPORTADO).toContain('contact_email');
    expect(CAMPOS_PII_TERCERO_EXPORTADO).toContain('address');
  });

  it('actualizar declara lo mismo: el `PUT` manda la ficha entera', async () => {
    asegurarMock.mockResolvedValue({ ...RESULTADO, desenlace: 'actualizado' });
    const app = await buildApp();

    await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', await auth('admin'));

    expect(ultimoAcceso()).toMatchObject({
      accion: 'export',
      camposAccedidos: [...CAMPOS_PII_TERCERO_EXPORTADO],
    });
  });

  for (const desenlace of ['sin_cambios', 'vinculado_existente'] as const) {
    it(`\`${desenlace}\` declara solo la identificación, que es lo único que salió`, async () => {
      asegurarMock.mockResolvedValue({ ...RESULTADO, desenlace });
      const app = await buildApp();

      await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', await auth('admin'));

      expect(ultimoAcceso()).toMatchObject({
        accion: 'export',
        camposAccedidos: [...CAMPOS_PII_IDENTIFICACION],
        resourceId: 41,
      });
      expect(ultimoAcceso().motivo).toContain(`desenlace="${desenlace}"`);
    });
  }

  it('se escriben LOS DOS: la bitácora de negocio y el registro de acceso', async () => {
    // No es redundancia. `audit()` responde «quién creó un tercero»; esto responde «qué datos
    // personales salieron y de quién». Cuando un titular pregunte a quién se le entregaron sus
    // datos, la respuesta está en la segunda tabla.
    asegurarMock.mockResolvedValue(RESULTADO);
    const app = await buildApp();

    await request(app).post('/api/siigo/terceros/cliente/41').set('Authorization', await auth('admin'));

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
  });

  it('el rastro no copia la identificación que la respuesta sí devuelve', async () => {
    asegurarMock.mockResolvedValue(RESULTADO);
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    // La respuesta la lleva —el panel la muestra— y eso no cambia con esta HU...
    expect(r.body.identificacion).toBe('1036640908');
    // ...pero el registro de acceso no la copia: nombres de columna y el id del cliente.
    expect(JSON.stringify(ultimoAcceso())).not.toContain('1036640908');
  });
});

describe('lo que no llegó a salir no se registra', () => {
  it('un cliente con la ficha incompleta (422) no exporta nada', async () => {
    asegurarMock.mockRejectedValue(new ClienteNoFacturableError(41, FALTANTES));
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(422);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('un rol sin permiso de operación (403) no exporta nada', async () => {
    const app = await buildApp();

    const r = await request(app).post('/api/siigo/terceros/cliente/41')
      .set('Authorization', await auth('conductor'));

    expect(r.status).toBe(403);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    expect(asegurarMock).not.toHaveBeenCalled();
  });
});

describe('el conteo del AC3 no registra acceso, y es una decisión escrita', () => {
  it('`GET /resumen` no escribe en `pii_access_log`: devuelve dos enteros', async () => {
    // No es un olvido simétrico al de `GET /cliente/:id` —aquel SÍ entrega `identificacion` y está
    // inventariado como deuda—. Este no proyecta ni una columna personal ni un `clients.id`:
    // registrar aquí escribiría una fila de «acceso a datos personales» cada vez que alguien abre
    // el panel, sin que nadie hubiera mirado a nadie. Es el criterio de `CAMPOS_PII_RESUMEN`: un
    // registro que exagera es tan inservible como uno que falta.
    resumenMock.mockResolvedValue({ totalClientes: 294, conTercero: 181 });
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/terceros/resumen')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('la respuesta no lleva ninguna identidad que registrar', async () => {
    resumenMock.mockResolvedValue({ totalClientes: 294, conTercero: 181 });
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/terceros/resumen')
      .set('Authorization', await auth('admin'));

    // La prueba de que la premisa anterior es cierta y no una afirmación del comentario: el cuerpo
    // son dos números. Si mañana alguien le añade `clientes: [...]`, esto se pone rojo y la
    // decisión de no registrar tiene que revisarse.
    expect(Object.values(r.body).every((v) => typeof v === 'number')).toBe(true);
    expect(Object.keys(r.body)).toEqual(['totalClientes', 'conTercero']);
  });
});
