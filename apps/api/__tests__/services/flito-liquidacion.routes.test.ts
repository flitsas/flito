// HU #12374 — la ruta de liquidación distingue «no se puede sellar en este estado» (422) de «la
// petición es un error» (400). AC9: sellar con una fecha de aprobación sin vigencia de tarifa
// responde 422 nombrando la fecha, con el mismo cuerpo `{ error, faltantes }` de siempre, y no
// audita nada (no se creó liquidación). El 400 de `LiquidacionError` a secas sigue igual.
//
// El servicio va mockeado: lo que se prueba es el mapeo HTTP, no la resolución (esa vive en
// flito-liquidacion.test.ts y en db/tarifas-por-fecha.test.ts). Los permisos no se tocan (AC11):
// el token lleva el rol `financiera` y su reparto de partida.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));

const liquidarMock = vi.fn();
vi.mock('../../src/modules/flito-liquidacion/flito-liquidacion.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js')>();
  return { ...real, liquidar: liquidarMock, liquidacionDe: vi.fn(), calcular: vi.fn(), liquidarLote: vi.fn() };
});

const { LiquidacionBloqueadaError, LiquidacionError } =
  await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

const BASE = '/api/flito/liquidacion';
const TRAMITE = '11111111-1111-4111-8111-111111111111';
const FALTANTE = 'Tarifa de trámite digital no configurada para la compañía en la fecha de aprobación (2026-08-20)';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.routes.js');
  app.use(BASE, router);
  return app;
}

async function tokenFinanciera() {
  const token = `Bearer ${await testToken({ sub: 31, role: 'financiera' })}`;
  await registrarUsuarioDePrueba(31, {
    rol: 'financiera', tipoPrincipal: 'interno', allowedPages: [],
    funcionesDelRol: ['liquidacion.liquidacion.liquidar'], excepciones: [],
  });
  return token;
}

beforeEach(() => { liquidarMock.mockReset(); auditMock.mockClear(); });

describe('POST /:tramiteId/liquidar — 422 cuando el trámite no es procesable en este estado (AC9)', () => {
  it('LiquidacionBloqueadaError → 422 con { error, faltantes } que nombran la fecha, y sin auditar', async () => {
    liquidarMock.mockRejectedValue(new LiquidacionBloqueadaError('El trámite no puede liquidarse todavía', [FALTANTE]));
    const app = await buildApp();
    const r = await request(app).post(`${BASE}/${TRAMITE}/liquidar`).set('Authorization', await tokenFinanciera());
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'El trámite no puede liquidarse todavía', faltantes: [FALTANTE] });
    expect(r.body.faltantes[0]).toContain('2026-08-20');
    expect(auditMock).not.toHaveBeenCalled();
    expect(liquidarMock).toHaveBeenCalledWith(TRAMITE, 31);
  });

  it('LiquidacionError a secas (ya liquidado) sigue siendo 400 con el mismo cuerpo', async () => {
    liquidarMock.mockRejectedValue(new LiquidacionError('El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.'));
    const app = await buildApp();
    const r = await request(app).post(`${BASE}/${TRAMITE}/liquidar`).set('Authorization', await tokenFinanciera());
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.', faltantes: [] });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('sin token → 401, sin tocar el servicio (los permisos del módulo no cambian, AC11)', async () => {
    const app = await buildApp();
    const r = await request(app).post(`${BASE}/${TRAMITE}/liquidar`);
    expect(r.status).toBe(401);
    expect(liquidarMock).not.toHaveBeenCalled();
  });
});
