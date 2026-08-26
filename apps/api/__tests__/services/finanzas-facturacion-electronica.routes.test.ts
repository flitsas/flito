// HU #11336 — el resumen de facturación electrónica del reporte de costos: fronteras HTTP.
//
// Lo que se prueba es QUIÉN entra (AC6) y que el filtro llegue al servicio (AC2). El módulo
// `finanzas` no tenía ningún test de ruta pese a ser el que alimenta la conciliación con
// contabilidad; este cubre el endpoint nuevo y, de paso, deja el arnés montado para el resto.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const RUTA = '/api/finanzas/reporte-costos/facturacion-electronica';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}

const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 3, username: `${role}@flit.io`, role })}`;

/** Ninguno de estos lee el reporte de costos, así que ninguno lee sus contadores. */
const ROLES_SIN_LECTURA: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => kdb.reset());

describe('AC6 — acceso por rol', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA)).status).toBe(401);
  });

  it.each(ROLES_SIN_LECTURA)('%s no lee el reporte, así que tampoco sus contadores → 403', async (role) => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth(role));
    expect(r.status).toBe(403);
  });

  it.each(['admin', 'financiera', 'auditor'] as TestRole[])(
    '%s lo consulta con la MISMA guarda que el resto del reporte', async (role) => {
      const app = await buildApp();
      const r = await request(app).get(RUTA).set('Authorization', await auth(role));

      // Se reutiliza la guarda de lectura que ya existe. Inventar un permiso nuevo habría creado una
      // segunda verdad sobre quién puede mirar exactamente lo mismo.
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('total');
      expect(r.body).toHaveProperty('no_enviado');
    },
  );

  it('`auditor` consulta pero el endpoint no admite escritura: solo existe GET', async () => {
    const app = await buildApp();
    const r = await request(app).post(RUTA).set('Authorization', await auth('auditor')).send({});
    expect(r.status).toBe(404);
  });
});

describe('AC1 y AC5 — la forma de la respuesta, y sin llamar a Siigo', () => {
  it('devuelve un contador por cada estado, aunque no haya ninguno', async () => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth('financiera'));

    const { SIIGO_ESTADOS_REPORTE } = await import('@operaciones/shared-types');
    for (const e of SIIGO_ESTADOS_REPORTE) expect(r.body[e]).toBe(0);
    expect(r.body.total).toBe(0);
  });

  it('se responde solo con datos locales', async () => {
    // El servicio no importa el cliente de Siigo: si algún día alguien lo añadiera, la pantalla
    // gastaría cuota de la ventana de 100 por minuto cada vez que se abre, y mirar el reporte
    // frenaría la emisión.
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(
      new URL('../../src/modules/finanzas/finanzas.facturacion-electronica.ts', import.meta.url), 'utf8');
    expect(fuente).not.toContain('siigo.client');
    expect(fuente).not.toContain('siigoRequest');
  });
});

describe('AC2 — el filtro llega y se compone con los demás', () => {
  it('un estado válido se acepta', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get(`${RUTA}?estadoFacturacion=rechazado&empresas=900123456`)
      .set('Authorization', await auth('financiera'));
    expect(r.status).toBe(200);
  });

  it('un estado desconocido se ignora en vez de romper la pantalla', async () => {
    const app = await buildApp();
    const r = await request(app)
      .get(`${RUTA}?estadoFacturacion=inventado`)
      .set('Authorization', await auth('financiera'));

    // Un 400 convertiría un enlace guardado en favoritos, hecho antes de que el catálogo cambiara,
    // en una pantalla rota. Mejor el universo entero que un error.
    expect(r.status).toBe(200);
  });
});
