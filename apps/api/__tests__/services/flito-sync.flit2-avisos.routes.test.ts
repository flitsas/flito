// HU #13632 (Feature #13613) — `POST /api/flito/sync/flit2/avisos` sobre `createApp()` (supertest): montaje
// D1 (antes del json global, del apiLimiter y de `flit2Routes`), 404/429/413/401/400/200 y logs sin cuerpo ni
// firma. La agenda real se espía (no se lee nada) y se detiene tras cada test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const fuenteMock = vi.fn();
vi.mock('../../src/modules/flito-sync/flito-sync-interruptor.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), fuenteHabilitada: fuenteMock,
}));
const logs: { nivel: string; args: unknown[] }[] = [];
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  const espia = () => {
    const l: Record<string, unknown> = {};
    for (const nivel of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      l[nivel] = (...args: unknown[]) => { logs.push({ nivel, args }); };
    }
    l.child = () => l;
    return l;
  };
  return { ...real, loggerFor: espia };
});

const { createApp } = await import('../../src/app.js');
const { env } = await import('../../src/config/env.js');
const svc = await import('../../src/modules/flito-sync/flit2-avisos.service.js');

const RUTA = '/api/flito/sync/flit2/avisos';
const SECRETO = 's'.repeat(48);
const firmar = (cuerpo: string | Buffer, s = SECRETO) =>
  `sha256=${createHmac('sha256', Buffer.from(s, 'utf8')).update(cuerpo).digest('hex')}`;
const aviso = (p: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), tipo: 'tramite.cambio', id: randomUUID(), syncVersion: 4,
  fechaUltimoCambio: '2026-10-16T10:00:00-05:00', eliminado: false, tenantId: 't1', ...p,
});

let ipSeq = 1;
const nuevaIp = () => `203.0.113.${ipSeq++}`;

function enviar(app: ReturnType<typeof createApp>, cuerpo: string, opts: { firma?: string | null; tipo?: string; ip?: string } = {}) {
  let r = request(app).post(RUTA).set('Content-Type', opts.tipo ?? 'application/json; charset=utf-8')
    .set('X-Forwarded-For', opts.ip ?? nuevaIp()).set('X-Correlation-Id', randomUUID());
  const firma = opts.firma === undefined ? firmar(cuerpo) : opts.firma;
  if (firma !== null) r = r.set('X-Webhook-Signature', firma);
  return r.send(cuerpo);
}

let app: ReturnType<typeof createApp>;
let agendar: ReturnType<typeof vi.spyOn>;
let rechazo: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  env.FLIT2_AVISOS_HABILITADO = true;
  env.FLIT2_AVISOS_SECRETO = SECRETO;
  env.FLIT2_AVISOS_LIMITE_MIN = 3000;
  env.FLIT2_AVISOS_LIMITE_FALLIDOS_MIN = 120;
  env.FLIT2_SYNC_CRON = true;
  fuenteMock.mockReset().mockResolvedValue(true);
  logs.length = 0;
  agendar = vi.spyOn(svc.agendaAvisos, 'agendar');
  app = createApp();
});
afterEach(() => {
  agendar.mockRestore();
  rechazo?.mockRestore();
  svc.detenerAvisosFlit2();
  env.FLIT2_AVISOS_HABILITADO = false;
  env.FLIT2_AVISOS_SECRETO = undefined;
});

describe('AC1 — aviso válido', () => {
  it('200 agendado con application/json; charset=utf-8, sin token de sesión', async () => {
    const a = aviso();
    const res = await enviar(app, JSON.stringify(a));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estado: 'agendado' });
    expect(agendar).toHaveBeenCalledTimes(1);
    expect(agendar.mock.calls[0]![0]).toMatchObject({ id: a.id, syncVersion: 4 });
  });

  it('AC6: el mismo aviso otra vez → 200 duplicado, sin agendar', async () => {
    const cuerpo = JSON.stringify(aviso());
    await enviar(app, cuerpo);
    const res = await enviar(app, cuerpo);
    expect(res.body).toEqual({ estado: 'duplicado' });
    expect(agendar).toHaveBeenCalledTimes(1);
  });
});

describe('AC2 — firma', () => {
  it.each([
    ['ausente', null],
    ['mal formada', 'sha256=zz'],
    ['en mayúsculas', null as unknown as string],
    ['de otro cuerpo', 'otro'],
  ])('%s → 401 sin detalle y sin agendar', async (caso, f) => {
    const cuerpo = JSON.stringify(aviso());
    const firma = caso === 'en mayúsculas' ? firmar(cuerpo).toUpperCase().replace('SHA256=', 'sha256=')
      : f === 'otro' ? firmar(`${cuerpo} `) : f;
    rechazo = vi.spyOn(svc, 'anotarRechazo');
    const res = await enviar(app, cuerpo, { firma });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'no_autorizado' });
    expect(agendar).not.toHaveBeenCalled();
  });

  it('un byte cambiado del cuerpo firmado → 401', async () => {
    const cuerpo = JSON.stringify(aviso({ syncVersion: 4 }));
    const res = await enviar(app, cuerpo.replace('"syncVersion":4', '"syncVersion":5'), { firma: firmar(cuerpo) });
    expect(res.status).toBe(401);
  });

  it('Content-Type no JSON (cuerpo sin parsear) → 401, nunca se re-serializa', async () => {
    const cuerpo = JSON.stringify(aviso());
    const res = await enviar(app, cuerpo, { tipo: 'text/plain' });
    expect(res.status).toBe(401);
  });

  it('el log del rechazo no lleva cuerpo, firma ni secreto', async () => {
    const cuerpo = JSON.stringify(aviso());
    const firma = firmar(`${cuerpo}x`);
    await enviar(app, cuerpo, { firma });
    const warn = logs.find((l) => l.nivel === 'warn' && String(l.args[1]).includes('firma'));
    expect(warn).toBeDefined();
    const texto = JSON.stringify(logs.map((l) => l.args));
    expect(texto).not.toContain(firma.slice(7));
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain(cuerpo);
    expect(warn!.args[0]).toMatchObject({ motivo: 'incorrecta' });
  });
});

describe('AC3 — deshabilitado', () => {
  it.each([
    ['HABILITADO distinto de true', () => { env.FLIT2_AVISOS_HABILITADO = false; }],
    ['sin secreto', () => { env.FLIT2_AVISOS_SECRETO = undefined; }],
    ['secreto de 31 caracteres', () => { env.FLIT2_AVISOS_SECRETO = 'x'.repeat(31); }],
  ])('%s → 404 (no el 401 de flit2Routes), sin agendar', async (_c, preparar) => {
    preparar();
    const res = await enviar(app, JSON.stringify(aviso()));
    expect(res.status).toBe(404);
    expect(res.text).toContain(`Cannot POST ${RUTA}`);
    expect(agendar).not.toHaveBeenCalled();
  });

  it('otro método sobre la ruta habilitada → 404, tampoco cae en flit2Routes', async () => {
    const res = await request(app).get(RUTA);
    expect(res.status).toBe(404);
  });
});

describe('AC4 — esquema y tipo', () => {
  it.each([
    ['JSON roto', '{"eventId":'],
    ['sin eventId', JSON.stringify({ ...aviso(), eventId: undefined })],
    ['syncVersion negativa', JSON.stringify(aviso({ syncVersion: -1 }))],
    ['fecha sin zona', JSON.stringify(aviso({ fechaUltimoCambio: '2026-10-16T10:00:00' }))],
    ['id que no es uuid', JSON.stringify(aviso({ id: 'abc' }))],
  ])('%s con firma válida → 400 sin detalle', async (_c, cuerpo) => {
    const res = await enviar(app, cuerpo);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'aviso_invalido' });
    expect(agendar).not.toHaveBeenCalled();
  });

  it('tipo distinto de tramite.cambio → 200 ignorado', async () => {
    const res = await enviar(app, JSON.stringify(aviso({ tipo: 'tramite.otro' })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estado: 'ignorado' });
    expect(agendar).not.toHaveBeenCalled();
  });

  it('cuerpo de más de 16 kB → 413', async () => {
    const cuerpo = JSON.stringify(aviso({ relleno: 'x'.repeat(17 * 1024) }));
    const res = await enviar(app, cuerpo);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'aviso_demasiado_grande' });
  });
});

describe('AC8 — fuente apagada', () => {
  it('FLIT2_SYNC_CRON apagado → 200 fuente_apagada sin agendar', async () => {
    env.FLIT2_SYNC_CRON = false;
    const res = await enviar(app, JSON.stringify(aviso()));
    expect(res.body).toEqual({ estado: 'fuente_apagada' });
    expect(agendar).not.toHaveBeenCalled();
  });
  it('interruptor flit2 apagado → 200 fuente_apagada sin agendar', async () => {
    fuenteMock.mockResolvedValue(false);
    const res = await enviar(app, JSON.stringify(aviso()));
    expect(res.body).toEqual({ estado: 'fuente_apagada' });
    expect(agendar).not.toHaveBeenCalled();
  });
});

describe('AC9 — limitador en dos niveles por IP real (antes del HMAC)', () => {
  it('fallidos: 120 firmas inválidas pasan (401); la 121 y las siguientes, aun firmadas bien, → 429', async () => {
    const ip = nuevaIp();
    for (let i = 0; i < 120; i++) {
      expect((await enviar(app, JSON.stringify(aviso()), { ip, firma: 'sha256=malo' })).status).toBe(401);
    }
    rechazo = vi.spyOn(svc, 'anotarRechazo');
    const r121 = await enviar(app, JSON.stringify(aviso()), { ip, firma: 'sha256=malo' });
    expect(r121.status).toBe(429);
    expect(r121.body).toEqual({ error: 'Demasiadas solicitudes' });
    const valido = await enviar(app, JSON.stringify(aviso()), { ip });
    expect(valido.status).toBe(429);
    expect(agendar).not.toHaveBeenCalled();
    // Otra IP no comparte el cupo.
    expect((await enviar(app, JSON.stringify(aviso()))).status).toBe(200);
  }, 60_000);

  it('los 400 también cuentan como fallidos', async () => {
    env.FLIT2_AVISOS_LIMITE_FALLIDOS_MIN = 2;
    const ip = nuevaIp();
    expect((await enviar(app, '{"x":1}', { ip })).status).toBe(400);
    expect((await enviar(app, '{"x":1}', { ip })).status).toBe(400);
    expect((await enviar(app, JSON.stringify(aviso()), { ip })).status).toBe(429);
  });

  it('200 avisos válidos seguidos desde una IP (más que el cupo de fallidos) → ninguno 429', async () => {
    const ip = nuevaIp();
    const estados = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = await enviar(app, JSON.stringify(aviso({ tipo: i % 2 ? 'tramite.otro' : 'tramite.cambio' })), { ip });
      estados.add(r.status);
    }
    expect([...estados]).toEqual([200]);
  }, 60_000);

  it('tope general: cuenta todas las peticiones, válidas incluidas', async () => {
    env.FLIT2_AVISOS_LIMITE_MIN = 5;
    const ip = nuevaIp();
    for (let i = 0; i < 5; i++) expect((await enviar(app, JSON.stringify(aviso()), { ip })).status).toBe(200);
    const res = await enviar(app, JSON.stringify(aviso()), { ip });
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeDefined();
  });

  it('el aviso no consume el apiLimiter global: 520 peticiones no cierran /api a esa IP', async () => {
    env.FLIT2_AVISOS_LIMITE_FALLIDOS_MIN = 10_000;
    const ip = nuevaIp();
    for (let i = 0; i < 520; i++) await enviar(app, '{}', { ip, firma: null });
    const res = await request(app).get('/api/flito/sync/flit2/estado').set('X-Forwarded-For', ip);
    expect(res.status).toBe(401);
  }, 60_000);
});
