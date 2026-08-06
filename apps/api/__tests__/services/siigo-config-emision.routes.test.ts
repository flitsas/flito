// Siigo — configuración de emisión: fronteras HTTP (HU #11284, AC7).
//
// Lo que se prueba aquí es QUIÉN entra y qué queda en la auditoría. La lógica de validación contra
// los catálogos vive en siigo-config-emision.test.ts.
//
// La matriz de roles se recorre entera a propósito: un `requireRole` mal escrito solo se nota
// probando el rol que NO debería pasar. El matiz de esta HU es que `financiera` y `auditor` LEEN la
// parametrización de emisión pero no la guardan.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';
import type { SiigoCatalogoElemento, SiigoTipoCatalogo } from '@operaciones/shared-types';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const catalogos: Partial<Record<SiigoTipoCatalogo, SiigoCatalogoElemento[]>> = {};
vi.mock('../../src/modules/siigo/siigo.catalogos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.catalogos.service.js')>();
  return {
    ...real,
    leerCatalogo: vi.fn(async (tipo: SiigoTipoCatalogo) => ({
      tipo,
      etiqueta: tipo,
      ambiente: 'pruebas',
      sincronizadoEn: '2026-08-06T09:00:00Z',
      elementos: catalogos[tipo] ?? [],
    })),
  };
});

const TABLA = 'siigo_config_emision';

function elemento(
  codigo: string, nombre: string, activo = true, atributos: Record<string, unknown> | null = null,
): SiigoCatalogoElemento {
  return {
    codigo, nombre, descripcion: null, activo, atributos,
    sincronizadoEn: '2026-08-06T09:00:00Z',
  };
}

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    ambiente: 'pruebas',
    documentoTipoCodigo: '1',
    vendedorCodigo: '35071',
    formaPagoCodigo: '5636',
    centroCostoCodigo: null,
    plazoVencimientoDias: 0,
    estrategiaNumeracion: 'siigo',
    notas: null,
    vigente: true,
    createdAt: new Date('2026-08-06T10:00:00Z'),
    createdBy: 9,
    updatedAt: new Date('2026-08-06T10:00:00Z'),
    updatedBy: 9,
    ...over,
  };
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/config-emision.routes.js');
  app.use('/api/siigo/config-emision', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 9, username: `${role}@flit.io`, role })}`;

/** Todos los roles que NO son admin. Ninguno guarda la configuración de emisión (AC7). */
const ROLES_SIN_ESCRITURA: TestRole[] = [
  'auditor', 'financiera', 'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

/** INSERT que devuelve la fila creada, como hace `returning()` dentro de la transacción. */
function insertDevuelve(f: Record<string, unknown>) {
  kdb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const run = () => Promise.resolve([f]);
    for (const m of ['values', 'returning']) chain[m] = () => chain;
    chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
    chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
    chain.finally = (cb: () => void) => run().finally(cb);
    return chain;
  });
}

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  for (const k of Object.keys(catalogos)) delete catalogos[k as SiigoTipoCatalogo];
  catalogos.document_type = [elemento('1', 'Factura de venta', true, { tipo: 'FV', centroCostoObligatorio: false })];
  catalogos.user = [elemento('35071', 'Ana Ramírez')];
  catalogos.payment_type = [elemento('5636', 'Contado', true, { manejaVencimiento: false })];
  catalogos.cost_center = [elemento('25732', 'Principal')];
});

describe('AC7 — ninguna ruta de la configuración de emisión es pública', () => {
  it.each([
    ['get', '/api/siigo/config-emision'],
    ['get', '/api/siigo/config-emision/estado'],
    ['get', '/api/siigo/config-emision/historial'],
    ['put', '/api/siigo/config-emision'],
  ])('%s %s sin token → 401', async (verbo, ruta) => {
    const app = await buildApp();
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo](ruta);
    expect(r.status).toBe(401);
  });
});

describe('AC7 — guardar la configuración es solo del rol de administración', () => {
  it('admin guarda → 200', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, []);
    insertDevuelve(fila({ plazoVencimientoDias: 30 }));
    const app = await buildApp();

    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ plazoVencimientoDias: 30 });

    expect(r.status).toBe(200);
  });

  it.each(ROLES_SIN_ESCRITURA)('%s no guarda → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth(role))
      .send({ plazoVencimientoDias: 30 });

    expect(r.status).toBe(403);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('auditor y financiera SÍ leen la parametrización', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    for (const role of ['auditor', 'financiera'] as TestRole[]) {
      const r = await request(app).get('/api/siigo/config-emision')
        .set('Authorization', await auth(role));
      expect(r.status).toBe(200);
      expect(r.body.config.vendedorCodigo).toBe('35071');
    }
  });

  it('un rol sin lectura tampoco consulta el estado', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/config-emision/estado')
      .set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });
});

describe('AC7 — toda modificación aceptada queda auditada', () => {
  it('la auditoría lleva el valor anterior y el nuevo', async () => {
    kdb.when.select(TABLA, [fila()]).update(TABLA, []);
    insertDevuelve(fila({ plazoVencimientoDias: 30 }));
    const app = await buildApp();

    await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ plazoVencimientoDias: 30 });

    const detalle = auditMock.mock.calls.at(-1)![1].detail as string;
    expect(detalle).toContain('Antes:');
    expect(detalle).toContain('Después:');
    expect(detalle).toContain('plazoDias=30');
  });

  it('el alta se distingue de una edición en la auditoría', async () => {
    kdb.when.select(TABLA, []);
    insertDevuelve(fila());
    const app = await buildApp();

    await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ documentoTipoCodigo: '1', vendedorCodigo: '35071', formaPagoCodigo: '5636' });

    const detalle = auditMock.mock.calls.at(-1)![1].detail as string;
    expect(detalle).toMatch(/Alta de configuración/);
  });

  it('un rechazo NO se audita: solo las modificaciones aceptadas', async () => {
    kdb.when.select(TABLA, []);
    const app = await buildApp();

    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ vendedorCodigo: 'NO-EXISTE' });

    expect(r.status).toBe(400);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('Fronteras del cuerpo y de los estados', () => {
  it('un plazo fuera de rango lo para Zod antes del servicio', async () => {
    const app = await buildApp();
    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ plazoVencimientoDias: 999 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('una estrategia de numeración desconocida la para Zod (AC5)', async () => {
    const app = await buildApp();
    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ estrategiaNumeracion: 'flito' });

    expect(r.status).toBe(400);
  });

  it('el catálogo sin sincronizar responde 409, no 400: falta un paso previo', async () => {
    catalogos.user = [];
    kdb.when.select(TABLA, []);
    const app = await buildApp();

    const r = await request(app).put('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'))
      .send({ vendedorCodigo: '35071' });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('catalogo');
    expect(r.body.campo).toBe('vendedor');
  });

  it('sin configuración guardada devuelve 200 con null, no 404', async () => {
    // «Nadie la ha configurado» es una respuesta legítima de la parametrización, no un recurso
    // ausente: la pantalla necesita distinguirlo de «está y le falta un campo».
    kdb.when.select(TABLA, []);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.config).toBeNull();
  });

  it('el ambiente sale de la petición y por defecto es el del entorno', async () => {
    kdb.when.select(TABLA, [fila({ ambiente: 'produccion' })]);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/config-emision?ambiente=produccion')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(r.body.ambiente).toBe('produccion');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('Regresión — el ambiente mal escrito no cae al del servidor', () => {
  it.each([
    ['get', '/api/siigo/config-emision?ambiente=prubas'],
    ['get', '/api/siigo/config-emision/estado?ambiente=PRODUCCION'],
    ['get', '/api/siigo/config-emision/historial?ambiente=todos'],
  ])('%s con un ambiente inválido → 400', async (verbo, ruta) => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verbo](ruta)
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(400);
  });

  it('un ambiente inválido en el PUT NO reescribe el ambiente por defecto', async () => {
    // Fallar abierto aquí significaría que un `?ambiente=prubas`, escrito para tocar pruebas,
    // reescribe en silencio la parametrización con la que se emite ante la DIAN.
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const r = await request(app).put('/api/siigo/config-emision?ambiente=prubas')
      .set('Authorization', await auth('admin'))
      .send({ plazoVencimientoDias: 30 });

    expect(r.status).toBe(400);
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('sin `?ambiente=` se usa el del entorno, que sigue siendo válido', async () => {
    kdb.when.select(TABLA, [fila()]);
    const app = await buildApp();

    const r = await request(app).get('/api/siigo/config-emision')
      .set('Authorization', await auth('admin'));

    expect(r.status).toBe(200);
    expect(['pruebas', 'produccion']).toContain(r.body.ambiente);
  });
});
