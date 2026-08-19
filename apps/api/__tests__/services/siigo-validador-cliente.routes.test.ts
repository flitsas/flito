// HU #11296 — rutas del informe de clientes no facturables (AC5, AC6, AC7).
//
// Dos cosas que estas pruebas cuidan y que no son obvias:
//   · el informe es de LECTURA: no puede haber forma de modificar un cliente desde aquí (AC7);
//   · la evaluación NO llama a Siigo (AC6) — es un informe que se consulta a menudo y gastar cuota
//     de la ventana que comparte con las facturas sería absurdo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: updateMock, delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/validador-cliente.routes.js');
  app.use('/api/siigo/clientes', router);
  return app;
}

const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, role })}`;

const COMPLETO = {
  id: 1, name: 'ACME S.A.S.', document: '900123456', personType: 'Company', idType: '31',
  fiscalResponsibilities: ['R-99-PN'], address: 'Calle 1', countryCode: 'Co', stateCode: '11',
  cityCode: '11001', phoneIndicative: '57', phoneNumber: '3001234567',
  contactFirstName: 'Ana', contactLastName: 'Ramírez', facturacionBloqueos: [],
};
const SIN_DIRECCION = { ...COMPLETO, id: 2, name: 'Sin dirección', address: null };
const SIN_CLASIFICAR = { ...COMPLETO, id: 3, name: 'Sin clasificar', personType: null };

/** `select()` del servicio: `.from().where().orderBy()` o `.from().where()`. */
function cartera(filas: unknown[]) {
  selectMock.mockReturnValue(chain(filas));
}

describe('AC7 — acceso por rol', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/clientes/validacion')).status).toBe(401);
  });

  for (const rol of ['admin', 'auditor', 'financiera']) {
    it(`${rol} consulta el informe`, async () => {
      cartera([COMPLETO]);
      const app = await buildApp();
      const r = await request(app).get('/api/siigo/clientes/validacion').set('Authorization', await auth(rol));
      expect(r.status).toBe(200);
    });
  }

  it('un rol sin lectura sobre clientes no entra', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/validacion').set('Authorization', await auth('conductor'));
    expect(r.status).toBe(403);
  });

  it('el informe no ofrece NINGUNA forma de modificar un cliente', async () => {
    // Quien corrige lo hace por la ruta de clientes, con su guarda y su auditoría. Un informe que
    // además edita es una segunda puerta a los mismos datos con permisos distintos.
    const fuente = readFileSync(
      path.resolve(process.cwd(), 'src/modules/siigo/validador-cliente.routes.ts'), 'utf8',
    );
    expect(fuente).not.toMatch(/router\.(patch|put|delete)\(/);
    // El único POST es el recálculo de duplicados, que no edita datos del cliente.
    expect(fuente.match(/router\.post\(/g) ?? []).toHaveLength(1);
  });

  it('recalcular duplicados es solo de admin', async () => {
    const app = await buildApp();
    for (const rol of ['auditor', 'financiera']) {
      const r = await request(app).post('/api/siigo/clientes/validacion/recalcular-duplicados')
        .set('Authorization', await auth(rol));
      expect(r.status).toBe(403);
    }
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('AC5 — total y detalle', () => {
  it('el resumen cuenta facturables, no facturables y pendientes de clasificación', async () => {
    cartera([COMPLETO, SIN_DIRECCION, SIN_CLASIFICAR]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/validacion').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      total: 3, facturables: 1, noFacturables: 2, pendientesClasificacion: 1,
    });
  });

  it('el resumen ordena los motivos por cuántos clientes arrastran', async () => {
    // Es lo que decide por dónde empezar: si 400 no tienen contacto y 3 no tienen tipo de persona,
    // el trabajo grande es capturar contactos.
    cartera([SIN_DIRECCION, { ...SIN_DIRECCION, id: 4 }, SIN_CLASIFICAR]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/validacion').set('Authorization', await auth('admin'));
    const motivos = r.body.porMotivo as { motivo: string; clientes: number }[];
    expect(motivos[0]!.clientes).toBeGreaterThanOrEqual(motivos[motivos.length - 1]!.clientes);
    expect(motivos.find((m) => m.motivo === 'direccion_faltante')!.clientes).toBe(2);
  });

  it('el detalle devuelve solo los NO facturables por defecto', async () => {
    cartera([COMPLETO, SIN_DIRECCION]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/validacion/detalle').set('Authorization', await auth('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.data[0].clienteId).toBe(2);
  });

  it('se puede filtrar por motivo', async () => {
    cartera([SIN_DIRECCION, SIN_CLASIFICAR]);
    const app = await buildApp();
    const r = await request(app)
      .get('/api/siigo/clientes/validacion/detalle?motivo=direccion_faltante')
      .set('Authorization', await auth('admin'));
    expect(r.body.total).toBe(1);
    expect(r.body.data[0].clienteId).toBe(2);
  });

  it('un motivo que no existe se rechaza señalando el campo', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get('/api/siigo/clientes/validacion/detalle?motivo=lo_que_sea')
      .set('Authorization', await auth('admin'));
    expect(r.status).toBe(400);
  });

  it('el detalle de un cliente puntual', async () => {
    cartera([SIN_DIRECCION]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/2/validacion').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body.faltantes.map((f: { motivo: string }) => f.motivo)).toContain('direccion_faltante');
  });

  it('un cliente que no existe → 404', async () => {
    cartera([]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/999/validacion').set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
  });

  it('«validacion» no se confunde con un identificador de cliente', async () => {
    // Las rutas fijas van declaradas antes que /:id. Si el orden se invierte, esto lo caza.
    cartera([COMPLETO]);
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/clientes/validacion').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('porMotivo');
  });
});

describe('AC6 — la evaluación no llama a Siigo', () => {
  it('el servicio no importa el cliente de Siigo ni la resiliencia', async () => {
    const fuente = readFileSync(
      path.resolve(process.cwd(), 'src/modules/siigo/siigo.validador-cliente.service.ts'), 'utf8',
    );
    expect(fuente).not.toMatch(/siigo\.client|siigo\.token|siigo\.resiliencia|fetch\(/);
  });
});
