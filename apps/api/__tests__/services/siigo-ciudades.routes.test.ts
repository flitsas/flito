// HU #11293 — rutas del catálogo de ubicaciones (AC2, AC6, Feature #11241).
//
// Este módulo es el único de Siigo que NO habla con Siigo: el catálogo sale de un archivo del repo.
// Por eso aquí no hay que demostrar que una petición rechazada no gastó cuota —no hay cuota— sino
// que la lectura está abierta a quien llena el formulario del cliente y la escritura no.

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

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const cargarCiudadesMock = vi.fn();
const resumenCiudadesMock = vi.fn();
const listarPaisesMock = vi.fn();
const listarDepartamentosMock = vi.fn();
const listarCiudadesMock = vi.fn();
const buscarCiudadesMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.ciudades.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.ciudades.service.js')>();
  return {
    ...actual,
    cargarCiudades: cargarCiudadesMock,
    resumenCiudades: resumenCiudadesMock,
    listarPaises: listarPaisesMock,
    listarDepartamentos: listarDepartamentosMock,
    listarCiudades: listarCiudadesMock,
    buscarCiudades: buscarCiudadesMock,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  resumenCiudadesMock.mockResolvedValue({ cargado: true, total: 4605, activas: 4605, version: '2026-08-06', cargadoEn: null });
  listarPaisesMock.mockResolvedValue([{ codigo: 'Co', nombre: 'Colombia' }]);
  listarDepartamentosMock.mockResolvedValue([{ codigo: '11', nombre: 'Bogotá D.C' }]);
  listarCiudadesMock.mockResolvedValue([{ codigo: '11001', nombre: 'Bogotá' }]);
  buscarCiudadesMock.mockResolvedValue([{ cityCode: '05001', cityName: 'Medellín' }]);
  cargarCiudadesMock.mockResolvedValue({
    version: '2026-08-06', origen: 'https://x', descargadoEn: '2026-08-06',
    total: 4605, insertadas: 4605, actualizadas: 0, inactivadas: 0, reactivadas: 0, duracionMs: 900,
  });
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/ciudades.routes.js');
  app.use('/api/siigo/ciudades', router);
  return app;
}

const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, role })}`;

/** Ni una sola escritura pudo ocurrir si la carga no se invocó. */
function nadieCargo() {
  expect(cargarCiudadesMock).not.toHaveBeenCalled();
}

describe('AC6 — lectura abierta, escritura restringida', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/ciudades/paises')).status).toBe(401);
  });

  for (const rol of ['admin', 'auditor', 'financiera']) {
    it(`${rol} puede leer el catálogo para llenar el formulario`, async () => {
      const app = await buildApp();
      const r = await request(app).get('/api/siigo/ciudades/paises').set('Authorization', await auth(rol));
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([{ codigo: 'Co', nombre: 'Colombia' }]);
    });
  }

  it('un rol ajeno a clientes no lo lee', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/paises').set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });

  for (const rol of ['auditor', 'financiera', 'conductor']) {
    it(`${rol} NO puede disparar la carga`, async () => {
      const app = await buildApp();
      const r = await request(app).post('/api/siigo/ciudades/cargar').set('Authorization', await auth(rol));
      expect(r.status).toBe(403);
      nadieCargo();
    });
  }

  it('admin carga y queda auditado', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/ciudades/cargar').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 4605, insertadas: 4605, version: '2026-08-06' });
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'siigo_ciudades' }),
    );
  });

  it('un archivo roto responde 422 diciendo qué pasa, no 500', async () => {
    const { SiigoCiudadesError } = await import('../../src/modules/siigo/siigo.ciudades.service.js');
    cargarCiudadesMock.mockRejectedValueOnce(
      new SiigoCiudadesError('archivo_invalido', 'El catálogo declara 4605 ciudades y trae 12.'),
    );
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/ciudades/cargar').set('Authorization', await auth('admin'));
    expect(r.status).toBe(422);
    // El archivo es nuestro: su mensaje no lleva nada de un tercero y dice qué hay que arreglar.
    expect(r.body.error).toMatch(/declara 4605 ciudades y trae 12/);
    expect(r.body.codigo).toBe('archivo_invalido');
  });
});

describe('AC1 y AC2 — estado y consulta en cascada', () => {
  it('el estado dice si está cargado, cuántas y de qué versión', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cargado: true, total: 4605, version: '2026-08-06' });
  });

  it('sin cargar lo dice explícitamente, en vez de devolver una lista vacía', async () => {
    // «Vacío» y «nunca cargado» se arreglan de forma distinta: el primero es un archivo roto y el
    // segundo, un paso que falta. Una pantalla que solo ve una lista vacía no los distingue.
    resumenCiudadesMock.mockResolvedValueOnce({ cargado: false, total: 0, activas: 0, version: null, cargadoEn: null });
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades').set('Authorization', await auth('admin'));
    expect(r.body.cargado).toBe(false);
  });

  it('los departamentos se piden por país', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/Co/departamentos').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(listarDepartamentosMock).toHaveBeenCalledWith('Co');
  });

  it('las ciudades se piden por país y departamento', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/Co/11/ciudades').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(listarCiudadesMock).toHaveBeenCalledWith('Co', '11');
  });

  it('la búsqueda pasa el texto y el país al servicio', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/buscar?q=medellin&pais=Co').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(buscarCiudadesMock).toHaveBeenCalledWith('medellin', 'Co');
  });

  it('«buscar» no se confunde con un código de país', async () => {
    // Va declarada antes que /:pais/departamentos. Si el orden se invierte, esta prueba lo caza.
    const app = await buildApp();
    await request(app).get('/api/siigo/ciudades/buscar?q=cali').set('Authorization', await auth('admin'));
    expect(buscarCiudadesMock).toHaveBeenCalled();
    expect(listarDepartamentosMock).not.toHaveBeenCalled();
  });

  it('una búsqueda de una sola letra se rechaza', async () => {
    // Escribir «a» devolvería medio catálogo sin que nadie lo esté buscando de verdad.
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/buscar?q=a').set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(buscarCiudadesMock).not.toHaveBeenCalled();
  });

  it('un país de más de dos letras se rechaza', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/ciudades/COL/departamentos').set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
    expect(listarDepartamentosMock).not.toHaveBeenCalled();
  });
});
