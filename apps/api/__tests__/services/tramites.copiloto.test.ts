// EPIC TRAM-INNOV · B2 (Sprint D) — copiloto IA del checklist (HITL).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { computeChecklist } from '@operaciones/shared-types';

const { selectMock, anthropicMock } = vi.hoisted(() => ({ selectMock: vi.fn(), anthropicMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/modules/tramites/anthropic.js', () => ({ anthropicMessages: anthropicMock }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { sugerirChecklist, DISCLAIMER } from '../../src/modules/tramites/copiloto.js';

const checklist = computeChecklist('traspaso_standard', {}, [])!; // todos pendientes
const aiText = (obj: unknown) => ({ ok: true, data: { content: [{ type: 'text', text: JSON.stringify(obj) }] } });

beforeEach(() => { selectMock.mockReset(); anthropicMock.mockReset(); });

describe('B2 · sugerirChecklist', () => {
  it('IA no configurada/caída → propaga 503', async () => {
    anthropicMock.mockResolvedValue({ ok: false, status: 503, message: 'Servicio de IA no configurado.' });
    const r = await sugerirChecklist(checklist);
    expect(r).toEqual({ ok: false, status: 503, message: 'Servicio de IA no configurado.' });
  });

  it('éxito: filtra ids inexistentes/satisfechos y FUERZA el disclaimer', async () => {
    anthropicMock.mockResolvedValue(aiText({
      sugerencias: [
        { itemId: 'soat', mensaje: 'Solicita el SOAT vigente al comprador.', confianza: 0.9 },
        { itemId: 'NOEXISTE', mensaje: 'id alucinado', confianza: 0.8 },
      ],
      disclaimer: 'TEXTO MALICIOSO DEL MODELO',
    }));
    const r = await sugerirChecklist(checklist);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sugerencias).toHaveLength(1);
    expect(r.sugerencias[0].itemId).toBe('soat');
    expect(r.disclaimer).toBe(DISCLAIMER); // no se confía en el modelo
  });

  it('tolera fences markdown alrededor del JSON', async () => {
    anthropicMock.mockResolvedValue({ ok: true, data: { content: [{ type: 'text', text: '```json\n{"sugerencias":[{"itemId":"impronta","mensaje":"Pide la impronta","confianza":0.7}]}\n```' }] } });
    const r = await sugerirChecklist(checklist);
    expect(r.ok && r.sugerencias[0].itemId).toBe('impronta');
  });

  it('salida no-JSON → 502 (degradación, no crash)', async () => {
    anthropicMock.mockResolvedValue({ ok: true, data: { content: [{ type: 'text', text: 'lo siento, no puedo' }] } });
    const r = await sugerirChecklist(checklist);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Ruta
// ---------------------------------------------------------------------------
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('POST /api/tramites/:id/checklist/sugerir', () => {
  it('trámite sin tipología → 400', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipologiaCodigo: null, checklistEstado: null }]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/5/checklist/sugerir').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
    expect(anthropicMock).not.toHaveBeenCalled();
  });

  it('IA no configurada → 503 con code', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipologiaCodigo: 'traspaso_standard', checklistEstado: {} }]));
    selectMock.mockReturnValueOnce(chain([])); // docs
    anthropicMock.mockResolvedValue({ ok: false, status: 503, message: 'Servicio de IA no configurado.' });
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/5/checklist/sugerir').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ia_no_disponible');
  });

  it('éxito → 200 con sugerencias + disclaimer + hitl', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipologiaCodigo: 'traspaso_standard', checklistEstado: {} }]));
    selectMock.mockReturnValueOnce(chain([])); // docs
    anthropicMock.mockResolvedValue(aiText({ sugerencias: [{ itemId: 'soat', mensaje: 'Pide el SOAT', confianza: 0.8 }] }));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/5/checklist/sugerir').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(200);
    expect(r.body.hitl).toBe(true);
    expect(r.body.disclaimer).toBe(DISCLAIMER);
    expect(r.body.sugerencias[0].itemId).toBe('soat');
  });

  it('trámite no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/999/checklist/sugerir').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });
});
