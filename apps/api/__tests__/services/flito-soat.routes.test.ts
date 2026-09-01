import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: 1, username: 'u', role: role as never })}`;

describe('flito-soat — RBAC', () => {
  it('sin token → 401', async () => {
    expect((await request(await buildApp()).get('/api/flito/soat')).status).toBe(401);
  });
  it('gestor_impuestos → 403 (no participa en SOAT)', async () => {
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('gestor_impuestos'));
    expect(r.status).toBe(403);
  });
  it('auditor → lectura 200 (solo lectura)', async () => {
    // La cola pagina desde la HU #10984: son dos consultas, el conteo y la página.
    selectMock.mockReturnValueOnce(chain([{ total: 0 }])); // conteo
    selectMock.mockReturnValueOnce(chain([]));             // página vacía
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });
  it('auditor → POST /enviar 403 (escritura)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/enviar').set('Authorization', await auth('auditor')).send({ ids: ['00000000-0000-0000-0000-000000000001'] });
    expect(r.status).toBe(403);
  });
  it('proveedor (gestor) → POST /:id/reactivar 403 (solo operaciones)', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('proveedor')).send({ motivo: 'x' });
    expect(r.status).toBe(403);
  });
});

// ───────────── AC2: la API DEVUELVE los tres datos técnicos del vehículo (HU #11906) ─────────
//
// El E2E de la pantalla no acredita esto: mockea la respuesta HTTP, así que pasaría igual con una
// API que no los devolviera. Aquí se comprueba contra el servicio real.

/**
 * Chain que RESPETA la proyección: de cada fila devuelve solo las claves que el `select({...})`
 * pidió, igual que PostgreSQL. Con el chain normal el mock inventa columnas que la consulta nunca
 * trajo, y el test seguiría verde aunque `cola()` dejara de pedirlas.
 */
function chainProyectado(proyeccion: Record<string, unknown>, filas: Record<string, unknown>[]) {
  const claves = Object.keys(proyeccion);
  return chain(filas.map((f) => Object.fromEntries(claves.map((k) => [k, k in f ? f[k] : null]))));
}

/** Fila de la cola tal como sale del join `flito_soat` × `vehicles` × … */
const filaCola = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-0000000000aa', vin: '9FKRG2222T2042405', estado: 'pendiente',
  proveedorSoatId: null, gestionOperaciones: false, enviadoEn: null, pagadoEn: null,
  valorPagado: null, motivoRechazo: null, createdAt: new Date('2026-08-01T12:00:00.000Z'),
  placa: 'JNH38H', marca: 'MAZDA', linea: 'CX-30',
  cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
  companiaNombre: 'FLIT SAS', organismoNombre: 'FUNZA', proveedorSoatNombre: null,
  proveedorSlaHoras: null, enviadoPorNombre: null,
  ...over,
});

/** Encola conteo + página (proyectada) + los trámites del SOAT que consulta `ensamblarCola`. */
function colaCon(fila: Record<string, unknown>) {
  selectMock.mockImplementationOnce(() => chain([{ total: 1 }]));
  selectMock.mockImplementationOnce((p: Record<string, unknown>) => chainProyectado(p, [fila]));
  selectMock.mockImplementationOnce(() => chain([])); // trámites del SOAT: ninguno
}

describe('flito-soat — la cola devuelve los datos técnicos del vehículo (AC2)', () => {
  it('**GET /api/flito/soat → cilindraje, carrocería y tipo de servicio con el valor de la fila**', async () => {
    colaCon(filaCola());
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    // Con el VALOR, no solo la clave: un `null` en los tres pasaría una aserción de existencia.
    expect(r.body.items[0]).toMatchObject({
      cilindraje: '1598', carroceria: 'DOBLE CABINA CON PLATON', tipoServicio: 'Particular',
    });
  });

  it('lo que FLIT no trajo viaja como `null` (el «—» lo pinta la pantalla, no el backend)', async () => {
    colaCon(filaCola({ cilindraje: null, carroceria: null, tipoServicio: null }));
    const r = await request(await buildApp()).get('/api/flito/soat').set('Authorization', await auth('admin'));
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    for (const k of ['cilindraje', 'carroceria', 'tipoServicio']) {
      expect(Object.keys(item), `${k} tiene que venir en la respuesta`).toContain(k);
      expect(item[k]).toBeNull();
    }
  });
});

describe('flito-soat — validaciones y errores', () => {
  it('enviar con ids vacío → 400', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/enviar').set('Authorization', await auth('admin')).send({ ids: [] });
    expect(r.status).toBe(400);
  });
  it('reversar con motivo < 5 → 400', async () => {
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reversar')
      .set('Authorization', await auth('admin')).send({ estadoDestino: 'pendiente', motivo: 'x' });
    expect(r.status).toBe(400);
  });
  it('reactivar un SOAT inexistente → 404 (SoatError)', async () => {
    selectMock.mockReturnValueOnce(chain([])); // no existe
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('admin')).send({ motivo: 'corregido' });
    expect(r.status).toBe(404);
  });
  it('reactivar un SOAT que no está Rechazado → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 'x', estado: 'pagado' }]));
    const r = await request(await buildApp()).post('/api/flito/soat/00000000-0000-0000-0000-000000000001/reactivar')
      .set('Authorization', await auth('admin')).send({ motivo: 'corregido' });
    expect(r.status).toBe(400);
  });
});
