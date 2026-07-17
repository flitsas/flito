// TRAM-INNOV A3 — portal de participantes (magic link) + Ley 1581.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
// OPS-02b r4: mock KEYED por tabla.
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const { insert: insertMock, update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  // Proxy lazy → evita TDZ (portal.js se importa estáticamente y carga db/client).
  db: new Proxy({} as Record<string, unknown>, { get: (_t, prop) => Reflect.get(kdb.db as Record<string, unknown>, prop) }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { crearInvitaciones, getPortalView, aceptarDeclaracion, authorizeUpload, PORTAL_TOKEN_RE, CONSENT_VERSION } from '../../src/modules/tramites/portal.js';

const future = new Date(Date.now() + 3600_000);
const fakeReq: any = { headers: { 'user-agent': 'jest', 'x-forwarded-for': '1.2.3.4' }, ip: '1.2.3.4' };

beforeEach(() => {
  kdb.reset();
  insertMock.mockReturnValue(chain([{ id: 1, tipo: 'otro', originalName: 'f.pdf' }]));
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
});

describe('A3 · portal (servicio)', () => {
  it('crearInvitaciones genera enlaces con token url-safe; trámite inexistente → null', async () => {
    kdb.when.selectOnce('tramites_digitales', []); // trámite no existe
    expect(await crearInvitaciones(9, [{ rol: 'comprador' }], { userId: 1 })).toBeNull();

    kdb.when.selectOnce('tramites_digitales', [{ id: 5 }]); // existe
    const links = await crearInvitaciones(5, [{ rol: 'comprador', email: 'a@b.co' }, { rol: 'vendedor' }], { userId: 1, role: 'admin' });
    expect(links).toHaveLength(2);
    const raw = links![0].url.split('/').pop()!;
    expect(PORTAL_TOKEN_RE.test(raw)).toBe(true);
    expect(links![0].url).toContain('/tramite/portal/');
  });

  it('getPortalView sin consentimiento → lista paso de aceptación', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'comprador', consent1581At: null, completedAt: null, expiresAt: future }]);
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador', placa: 'ABC123', vehiculo: { marca: 'Mazda', linea: 'CX-30' } }]);
    const view = await getPortalView('a'.repeat(32), fakeReq);
    expect(view).not.toBeNull();
    expect(view!.consentDado).toBe(false);
    expect(view!.consentVersion).toBe(CONSENT_VERSION);
    expect(view!.pasosPendientes.join(' ')).toMatch(/Ley 1581/i);
  });

  it('token inválido (regex) → getPortalView null', async () => {
    expect(await getPortalView('short', fakeReq)).toBeNull();
  });

  it('aceptarDeclaracion registra consentimiento', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'comprador', consent1581At: null, completedAt: null, expiresAt: future }]);
    const r = await aceptarDeclaracion('a'.repeat(32), fakeReq);
    expect(r.ok).toBe(true);
    expect(updateMock).toHaveBeenCalled();
  });

  it('authorizeUpload exige consentimiento previo', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'comprador', consent1581At: null, completedAt: null, expiresAt: future }]);
    const r = await authorizeUpload('a'.repeat(32));
    expect(r).toEqual({ ok: false, code: 'sin_consentimiento' });
  });

  it('authorizeUpload OK con consentimiento', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'mandatario', consent1581At: new Date(), completedAt: null, expiresAt: future }]);
    const r = await authorizeUpload('a'.repeat(32));
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
async function buildPublicApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/portal.public.routes.js');
  app.use('/api/tramite-portal', router);
  return app;
}
async function buildTramitesApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('Portal público (sin auth)', () => {
  it('GET /:token inválido → 404 genérico', async () => {
    const app = await buildPublicApp();
    const r = await request(app).get('/api/tramite-portal/short');
    expect(r.status).toBe(404);
  });

  it('GET /:token válido → vista mínima', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'comprador', consent1581At: null, completedAt: null, expiresAt: future }]);
    kdb.when.selectOnce('tramites_digitales', [{ estado: 'borrador', placa: 'ABC123', vehiculo: { marca: 'Mazda', linea: 'CX-30' } }]);
    const app = await buildPublicApp();
    const r = await request(app).get(`/api/tramite-portal/${'a'.repeat(32)}`);
    expect(r.status).toBe(200);
    expect(r.body.rol).toBe('comprador');
    expect(r.body.tramite.placa).toBe('ABC123');
  });

  it('POST /:token/documentos sin consentimiento → 403', async () => {
    kdb.when.selectOnce('tramite_participantes', [{ id: 1, tramiteId: 5, rol: 'comprador', consent1581At: null, completedAt: null, expiresAt: future }]);
    const app = await buildPublicApp();
    const r = await request(app).post(`/api/tramite-portal/${'a'.repeat(32)}/documentos`).field('tipo', 'soat').attach('file', Buffer.from('PDFDATA'), 'soat.pdf');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/tramites/:id/invitar (authed)', () => {
  it('rol inválido → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).post('/api/tramites/5/invitar').set('Authorization', `Bearer ${token}`).send({ participantes: [{ rol: 'hacker' }] });
    expect(r.status).toBe(400);
  });

  it('genera links por rol → 201', async () => {
    kdb.when.selectOnce('tramites_digitales', [{ id: 5 }]); // trámite existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildTramitesApp();
    const r = await request(app).post('/api/tramites/5/invitar').set('Authorization', `Bearer ${token}`)
      .send({ participantes: [{ rol: 'comprador', email: 'a@b.co', whatsappOptIn: true }] });
    expect(r.status).toBe(201);
    expect(r.body.links).toHaveLength(1);
    expect(r.body.links[0].url).toContain('/tramite/portal/');
  });
});
