// TRAM-INNOV A4 — notificaciones de estado (WhatsApp/email, opt-in, degradación).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { testToken } from '../helpers/auth.js';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn().mockResolvedValue([]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { renderPlantilla, sendWhatsAppVia, notifConfig, notifyEstado, whatsappEnabled } from '../../src/modules/tramites/notificaciones.js';

beforeEach(() => { selectMock.mockReset(); });

describe('A4 · plantillas y proveedor', () => {
  it('renderPlantilla incluye la placa', () => {
    const m = renderPlantilla('placa_asignada', 'ABC123');
    expect(m.titulo).toMatch(/placa/i);
    expect(m.cuerpo).toContain('ABC123');
  });

  it('sendWhatsAppVia arma el payload Meta Cloud API correcto (mock proveedor)', async () => {
    let capturedUrl = ''; let capturedInit: any = null;
    const fetchMock = vi.fn(async (url: string, init: any) => { capturedUrl = url; capturedInit = init; return { ok: true }; });
    const ok = await sendWhatsAppVia('TKN', '12345', '+573001112233', 'Hola', fetchMock as any);
    expect(ok).toBe(true);
    expect(capturedUrl).toContain('/12345/messages');
    expect(capturedInit.headers.Authorization).toBe('Bearer TKN');
    const body = JSON.parse(capturedInit.body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+573001112233');
    expect(body.text.body).toBe('Hola');
  });

  it('sendWhatsAppVia → false si el proveedor responde no-ok o lanza', async () => {
    expect(await sendWhatsAppVia('t', 'p', 'x', 'y', (async () => ({ ok: false })) as any)).toBe(false);
    expect(await sendWhatsAppVia('t', 'p', 'x', 'y', (async () => { throw new Error('net'); }) as any)).toBe(false);
  });
});

describe('A4 · degradación sin configuración', () => {
  it('en entorno de test no hay WhatsApp ni SMTP', () => {
    expect(whatsappEnabled()).toBe(false);
    expect(notifConfig()).toEqual({ whatsapp: false, email: false });
  });

  it('notifyEstado sin canal → degradado y NO toca BD (no consume mocks, no 500)', async () => {
    const r = await notifyEstado(5, 'enviado_transito');
    expect(r).toEqual({ enviados: 0, canal: 'ninguno', degradado: true });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/tramites/notif-config', () => {
  it('devuelve capacidades (false/false en test)', async () => {
    const app = express();
    app.use(express.json());
    const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
    app.use('/api/tramites', router);
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(app).get('/api/tramites/notif-config').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ whatsapp: false, email: false });
  });
});
