// HU #11299 — registro de acceso a las listas de equivalencia de ciudad.
//
// El segundo frente del hallazgo de seguridad: además del informe de facturabilidad, la pantalla de
// Terceros abre `GET /clientes-ciudades/propuestas` y `/obsoletas`, y las dos devuelven el NOMBRE de
// cada cliente pendiente en una lista COMPLETA — sin paginar y sin tope, a diferencia del informe,
// que al menos está acotado a 500. En volumen es la lectura de identidades más grande del módulo, y
// hasta esta HU no dejaba ni una línea en `pii_access_log` (Ley 1581 art. 17, AGENTS.md §16).
//
// Lo que se demuestra:
//
//   1. **Las dos listas dejan rastro**, con recurso, acción, campos y cuántas filas se entregaron.
//   2. **Se declara lo que cada lista entrega, ni de más ni de menos**: nombre y ciudad —la
//      ubicación del titular es dato personal, AGENTS.md §14—, y en `/obsoletas` además el texto de
//      origen confirmado. La identificación NO sale por aquí, y decir que sí haría que «¿quién ha
//      leído documentos?» señalara a quien solo vio nombres.
//   3. **`/estado` no registra**: seis conteos, ni un identificador. El rastro es señal o no sirve.
//   4. **Un 403 y un fallo del servicio no registran**: nadie llegó a mirar nada.
//   5. **El rastro no copia lo leído**: el nombre del cliente no aparece en el motivo.
//   6. **La respuesta no cambió**: `{ total, data }` sigue igual.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

/** Ver la nota del mismo mock en `siigo-validador-cliente.pii.test.ts`: se fija el contrato, no el INSERT. */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const proponerMock = vi.fn();
const estadoMock = vi.fn();
const obsoletasMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.ciudades-mapeo.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js')>();
  return {
    ...actual,
    proponerEquivalencias: proponerMock,
    estadoMapeoCiudades: estadoMock,
    equivalenciasObsoletas: obsoletasMock,
  };
});

const {
  CAMPOS_PII_EQUIVALENCIA_OBSOLETA, CAMPOS_PII_PROPUESTA_CIUDAD, RECURSO_CLIENTE,
} = await import('../../src/modules/siigo/siigo.pii.js');
const { SiigoCiudadMapeoError } = await import('../../src/modules/siigo/siigo.ciudades-mapeo.service.js');

const BASE = '/api/siigo/clientes-ciudades';

/** Dos clientes pendientes, uno de ellos persona natural: `clients` mezcla naturales y jurídicas. */
const PENDIENTES = [
  {
    clienteId: 41, nombre: 'PEDRO ANTONIO GÓMEZ', ciudadTexto: 'BOGOTA D.C.',
    propuesta: { textoOrigen: 'BOGOTA D.C.', certeza: 'exacta', candidatas: [{ cityCode: '11001' }] },
  },
  {
    clienteId: 42, nombre: 'ACME S.A.S.', ciudadTexto: 'MEDELLIN',
    propuesta: { textoOrigen: 'MEDELLIN', certeza: 'exacta', candidatas: [{ cityCode: '05001' }] },
  },
];

const OBSOLETAS = [
  { clienteId: 41, nombre: 'PEDRO ANTONIO GÓMEZ', ciudadActual: 'CHIA', textoConfirmado: 'BOGOTA D.C.' },
];

beforeEach(() => {
  vi.clearAllMocks();
  estadoMock.mockResolvedValue({
    total: 100, conCodigo: 40, pendientes: 60, proponibles: 45, ambiguos: 5, sinEquivalencia: 10,
  });
  proponerMock.mockResolvedValue(PENDIENTES);
  obsoletasMock.mockResolvedValue(OBSOLETAS);
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/ciudades-mapeo.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: string = 'admin') => `Bearer ${await testToken({ sub: 7, role })}`;

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('AGENTS.md §16 — las listas de equivalencia dejan rastro', () => {
  it('/propuestas registra recurso, acción, campos y cuántos nombres entregó', async () => {
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/propuestas?pais=Co`).set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      // Nombre y ciudad: `ciudadTexto` es `clients.city`. La identificación no sale por aquí.
      camposAccedidos: ['name', 'city'],
      resourceId: null,
    });
    // La ruta no acepta `limit`: quien la llama se lleva todos los pendientes que haya, y `filas` es
    // lo único que deja constancia de cuántos fueron.
    expect(ultimoAcceso().motivo).toContain('filas=2');
    expect(ultimoAcceso().motivo).toContain('pais=Co');
  });

  it('/obsoletas registra igual, con su propio conteo', async () => {
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/obsoletas`).set('Authorization', await auth('financiera'));

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_CLIENTE,
      accion: 'search',
      // Una ubicación más: esta lista compara la ciudad de hoy con la que se confirmó.
      camposAccedidos: ['name', 'city', 'city_texto_origen'],
      resourceId: null,
    });
    expect(ultimoAcceso().motivo).toContain('filas=1');
  });

  it('las listas de campos declaran la ubicación, que también es dato del titular', async () => {
    // Sub-declararlas fue el hallazgo de la re-auditoría: las dos respuestas traen la ciudad del
    // cliente y el log decía que solo se habían leído nombres.
    expect(CAMPOS_PII_PROPUESTA_CIUDAD).toEqual(['name', 'city']);
    expect(CAMPOS_PII_EQUIVALENCIA_OBSOLETA).toEqual(['name', 'city', 'city_texto_origen']);
  });

  it('el rastro no copia el nombre que se leyó', async () => {
    const app = await buildApp();

    await request(app).get(`${BASE}/propuestas`).set('Authorization', await auth());

    const escrito = JSON.stringify(ultimoAcceso());
    expect(escrito).not.toContain('PEDRO');
    expect(escrito).not.toContain('ACME');
    expect(escrito).not.toContain('BOGOTA');
    // Lo que sí lleva son los nombres de COLUMNA.
    expect(escrito).toContain('name');
    expect(escrito).toContain('city');
  });
});

describe('lo que NO registra', () => {
  it('/estado no deja rastro: devuelve conteos, ni un identificador', async () => {
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/estado`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('un rol sin lectura (403) no deja rastro en ninguna de las dos', async () => {
    const app = await buildApp();

    for (const ruta of ['propuestas', 'obsoletas']) {
      const r = await request(app).get(`${BASE}/${ruta}`).set('Authorization', await auth('conductor'));
      expect(r.status).toBe(403);
    }
    expect(logPiiAccessMock).not.toHaveBeenCalled();
    expect(proponerMock).not.toHaveBeenCalled();
  });

  it('si el servicio falla no se entregó nada, así que no se registra acceso', async () => {
    proponerMock.mockRejectedValue(new SiigoCiudadMapeoError('catalogo_vacio', 'No hay catálogo de ciudades cargado.'));
    const app = await buildApp();

    const r = await request(app).get(`${BASE}/propuestas`).set('Authorization', await auth());

    expect(r.status).toBe(409);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});

describe('la auditoría no cambia lo que las rutas devuelven', () => {
  it('/propuestas y /obsoletas conservan `total` y `data`', async () => {
    const app = await buildApp();

    const propuestas = await request(app).get(`${BASE}/propuestas`).set('Authorization', await auth());
    expect(propuestas.body.total).toBe(2);
    expect(propuestas.body.data).toHaveLength(2);
    expect(propuestas.body.data[0]).toMatchObject({ clienteId: 41, nombre: 'PEDRO ANTONIO GÓMEZ' });

    const obsoletas = await request(app).get(`${BASE}/obsoletas`).set('Authorization', await auth());
    expect(obsoletas.body.total).toBe(1);
    expect(obsoletas.body.data[0]).toMatchObject({ clienteId: 41, ciudadActual: 'CHIA' });
  });
});
