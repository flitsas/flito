// LAFT F5 · dashboard.routes — KPIs consolidados con fixtures.
//
// OPS-02b: migrado a mock KEYED por tabla. El handler corre 8 agregados en
// `Promise.all`; antes el test encolaba 8 `mockReturnValueOnce` en ESE orden
// exacto (frágil ante reordenamientos). Ahora cada agregado se enruta por su
// tabla (`kdb.when.scenario(...)`) → el orden deja de importar.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { laftDashboardScenario, laftDashboardVacio } from '../fixtures/laft/scenarios.js';
import { adminAuth, testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));

let app: any;
beforeEach(async () => {
  kdb.reset();
  // execute() — F3 (mig 0064): tablas laft_cash_txn y laft_rte_reportes ausentes
  // simulan 42P01. El resto resuelve trivial.
  kdb.execute.mockImplementation((q: any) => {
    let s = '';
    try { s = JSON.stringify(q ?? ''); } catch { s = String(q ?? ''); }
    if (s.includes('laft_cash_txn') || s.includes('laft_rte_reportes')) {
      return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    }
    return Promise.resolve([{ '?column?': 1 }]);
  });
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('LAFT F5 · /laft/dashboard [keyed]', () => {
  it('admin obtiene KPIs consolidados → 200', async () => {
    // Keyed por tabla: el orden de los 8 SELECT del Promise.all es irrelevante.
    kdb.when.scenario(laftDashboardScenario());
    const r = await request(app).get('/api/laft/dashboard').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.oficialCumplimientoOk).toBe(true);
    expect(r.body.contrapartesActivas).toBe(25);
    expect(r.body.contrapartesAlto).toBe(3);
    expect(r.body.empleadosKycVencidos).toBe(2);
    expect(r.body.manualVigente.version).toBe(3);
    expect(r.body.capacitacionesAnioActual.porcentajeAsistencia).toBe(80);
    // F3 (cash + rte) deben ser 0/null porque tablas no existen
    expect(r.body.cashBreachUltimoMes).toBe(0);
    expect(r.body.rteUltimoMesGenerado).toBeNull();
  });

  it('auditor (read-only) accede al dashboard → 200', async () => {
    // Sin registro → toda tabla resuelve [] (oficial no configurado → ok=false).
    const tok = await testToken({ role: 'auditor', sub: 9 });
    const r = await request(app).get('/api/laft/dashboard').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(r.body.oficialCumplimientoOk).toBe(false);
  });

  it('proveedor → 403', async () => {
    const tok = await testToken({ role: 'proveedor', sub: 9 });
    const r = await request(app).get('/api/laft/dashboard').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(403);
  });

  it('sin auth → 401', async () => {
    const r = await request(app).get('/api/laft/dashboard');
    expect(r.status).toBe(401);
  });

  it('queries individuales que fallan caen a fallback (no rompen)', async () => {
    // Keyed: marcamos por tabla cuáles lanzan; el resto en cero. Sin depender del orden.
    kdb.when.scenario(laftDashboardVacio());
    kdb.when.selectThrow('laft_manual_versions', new Error('manual table missing'));
    kdb.when.selectThrow('laft_employees_kyc', new Error('kyc missing'));
    const r = await request(app).get('/api/laft/dashboard').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.manualVigente).toBeNull();
    expect(r.body.empleadosKycVencidos).toBe(0);
  });
});
