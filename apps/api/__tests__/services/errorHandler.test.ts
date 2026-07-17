import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from '../../src/shared/middleware/errorHandler.js';

function mockReqRes() {
  const req = { method: 'PATCH', path: '/api/pesv/diagnostico/7/items/1', headers: {} } as unknown as Request;
  const res = {} as Response & { statusCode?: number; body?: any };
  res.status = vi.fn().mockImplementation((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn().mockImplementation((b: any) => { res.body = b; return res; });
  (res as any).headersSent = false;
  return { req, res };
}

describe('PESV-02 · errorHandler mapea errores del guard PESV', () => {
  it('P0001 + "WORM:" → 409 diagnóstico cerrado', () => {
    const { req, res } = mockReqRes();
    errorHandler({ code: 'P0001', message: 'WORM: diagnostico 7 cerrado, items inmutables' }, req, res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/WORM/i);
  });

  it('23514 + "rubrica" → 422 scorePct fuera de rúbrica', () => {
    const { req, res } = mockReqRes();
    errorHandler({ code: '23514', message: 'rubrica: score_pct=85 no permitido (valores válidos: 0, 50, 75, 100)' }, req, res, vi.fn());
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatch(/rúbrica|rubrica/i);
  });

  it('camino feliz no aplica: otro error de Postgres (23505) → 500 genérico', () => {
    const { req, res } = mockReqRes();
    errorHandler({ code: '23505', message: 'duplicate key value violates unique constraint' }, req, res, vi.fn());
    expect(res.statusCode).toBe(500);
  });

  it('P0001 con mensaje NO WORM → 500 (no se mis-mapea)', () => {
    const { req, res } = mockReqRes();
    errorHandler({ code: 'P0001', message: 'alguna otra excepción' }, req, res, vi.fn());
    expect(res.statusCode).toBe(500);
  });

  it('error genérico sin code → 500', () => {
    const { req, res } = mockReqRes();
    errorHandler(new Error('boom'), req, res, vi.fn());
    expect(res.statusCode).toBe(500);
  });
});
