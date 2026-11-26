/**
 * Épica #14707 (ADR-0049 §1 y §4) — predicado único del trámite muerto y guard de AVANCE (mecanismo T).
 *
 *   · `vigenciaTramite` (shared-types): muerto ⇔ `estado = 'anulado'`; sub-vigencia por `flit_estado`; `rechazado`
 *     y NULL son vigentes (D1). `vigenciaLiberaPagos`: solo anulado/abortado (D11).
 *   · `exigirTramiteVivo`: lee con `FOR SHARE` (choca con el UPDATE del sync, sin ventana) y lanza 409
 *     `TRAMITE_NO_VIGENTE` con la vigencia y el radicado — nunca placa ni VIN.
 *   · `exigirDocumentosVivos` sobre las columnas `COLUMNAS_TRAMITE_DE_DOCUMENTO` (logística, sin lectura extra),
 *     `exigirFilaTramiteViva` (la de `bloquearTramiteVivo`) y `exigirImpuestoVigentePorId` (I).
 *   · `errorHandler` global: `TramiteNoVigenteError` y el FL409 del trigger (también envuelto en `cause`, como lo
 *     deja Drizzle) → 409 con el cuerpo canónico, en vez de 500.
 *   · Fragmentos SQL `TRAMITE_MUERTO` / `TRAMITE_VIVO` / `SOAT_ABIERTO`.
 * Sin base: el ejecutor es un doble que registra el modo de bloqueo.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const vig = await import('../../src/shared/tramite-vigente.js');
const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
const { SOAT_ABIERTO } = await import('../../src/modules/flito-soat/flito-soat-actual.js');
const { vigenciaTramite, vigenciaLiberaPagos, CODIGO_TRAMITE_NO_VIGENTE } = await import('@operaciones/shared-types');

function ejecutor(filas: unknown[]) {
  const fors: unknown[][] = [];
  const c: Record<string, unknown> = {
    from: () => c, where: () => c, innerJoin: () => c, limit: () => c,
    for: (...a: unknown[]) => { fors.push(a); return c; },
    then: (ok: (v: unknown) => unknown) => Promise.resolve(filas).then(ok),
  };
  return { ex: { select: vi.fn(() => c) } as never, fors };
}

const dialecto = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialecto.sqlToQuery(q).sql;

describe('vigenciaTramite (shared-types, D1)', () => {
  it.each([
    ['anulado', 'Anulado', 'anulado'], ['anulado', 'Abortado', 'abortado'], ['anulado', ' revocado ', 'revocado'],
    ['anulado', null, 'anulado'], ['rechazado', 'Rechazado', 'vigente'], [null, 'Borrador', 'vigente'],
    ['asignado', 'Revocado', 'vigente'],
  ])('estado=%s flit=%s → %s', (estado, flit, esperado) => {
    expect(vigenciaTramite(estado, flit)).toBe(esperado);
  });
  it('D11: solo anulado y abortado liberan pagos', () => {
    expect(['anulado', 'abortado', 'revocado', 'vigente'].map((v) => vigenciaLiberaPagos(v as never))).toEqual([true, true, false, false]);
  });
});

describe('exigirTramiteVivo (mecanismo T)', () => {
  it('trámite muerto → 409 TRAMITE_NO_VIGENTE con vigencia y radicado, leído FOR SHARE', async () => {
    const { ex, fors } = ejecutor([{ estado: 'anulado', flitEstado: 'Abortado', idFlit: '1234567' }]);
    const p = vig.exigirTramiteVivo(ex, 't-1');
    await expect(p).rejects.toBeInstanceOf(vig.TramiteNoVigenteError);
    await expect(vig.exigirTramiteVivo(ex, 't-1')).rejects.toMatchObject({
      status: 409, code: CODIGO_TRAMITE_NO_VIGENTE, vigencia: 'abortado',
      message: 'El trámite 1234567 fue abortado en FLIT: en FLITO ya no admite acciones.',
    });
    expect(fors[0]).toEqual(['share']);
  });
  it('vivo (asignado, rechazado o NULL) o inexistente → pasa', async () => {
    for (const filas of [[{ estado: 'asignado', flitEstado: 'Asignado', idFlit: '1' }], [{ estado: 'rechazado', flitEstado: 'Rechazado', idFlit: '1' }],
      [{ estado: null, flitEstado: null, idFlit: '1' }], []]) {
      await expect(vig.exigirTramiteVivo(ejecutor(filas).ex, 't')).resolves.toBeUndefined();
    }
  });
  it('logística: un LT de un trámite muerto → 409; un LT sin trámite o vivo pasa; columnas por subconsulta', () => {
    expect(() => vig.exigirDocumentosVivos([{ tramiteEstado: 'asignado' }, { tramiteEstado: 'anulado', tramiteFlitEstado: 'Revocado', tramiteIdFlit: '77' }]))
      .toThrow(expect.objectContaining({ status: 409, vigencia: 'revocado', message: expect.stringContaining('77') }));
    expect(() => vig.exigirDocumentosVivos([{ tramiteEstado: null }, {}])).not.toThrow();
    expect(render(vig.COLUMNAS_TRAMITE_DE_DOCUMENTO.tramiteEstado)).toContain('FROM flito_tramites t WHERE t.id = "flito_logistica_documentos"."tramite_id"');
  });
  it('fila ya bloqueada (bloquearTramiteVivo): muerto → 409; sin estado (mock viejo) → pasa', () => {
    expect(() => vig.exigirFilaTramiteViva({ estado: 'anulado', flitEstado: 'Anulado', idFlit: '5' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => vig.exigirFilaTramiteViva({ idFlit: '5' })).not.toThrow();
  });
});

describe('guards de registro (mecanismos I y S)', () => {
  it('I: impuesto descartado → 409 con el texto del diseño §3.1; otro estado pasa', async () => {
    expect(() => vig.exigirImpuestoVigente({ estado: 'descartado', motivoDescarte: 'anulado' })).toThrow(
      expect.objectContaining({ status: 409, code: 'TRAMITE_NO_VIGENTE', message: 'Este impuesto se descartó porque su trámite ya no existe en FLITO.' }));
    expect(() => vig.exigirImpuestoVigente({ estado: 'pagado' })).not.toThrow();
    await expect(vig.exigirImpuestoVigentePorId('i-1', ejecutor([{ estado: 'descartado', motivoDescarte: 'abortado' }]).ex))
      .rejects.toMatchObject({ status: 409, vigencia: 'abortado' });
    await expect(vig.exigirImpuestoVigentePorId('i-1', ejecutor([]).ex)).resolves.toBeUndefined();
  });
});

describe('errorHandler global (Épica #14707)', () => {
  function app(lanzar: () => never) {
    const a = express();
    a.post('/api/flito/impuestos/:id/x', () => lanzar());
    a.post('/api/flito/soat/:id/x', () => lanzar());
    a.use(errorHandler);
    return a;
  }
  it('TramiteNoVigenteError → 409 con { error, code, vigencia }', async () => {
    const res = await request(app(() => { throw new vig.TramiteNoVigenteError('revocado', vig.mensajeTramiteNoVigente('999', 'revocado')); }))
      .post('/api/flito/soat/abc/x');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'El trámite 999 fue revocado en FLIT: en FLITO ya no admite acciones.', code: 'TRAMITE_NO_VIGENTE', vigencia: 'revocado' });
  });
  it('FL409 del trigger (directo o envuelto en `cause`) → 409, no 500', async () => {
    const directo = await request(app(() => { throw Object.assign(new Error('registro descartado'), { code: 'FL409' }); })).post('/api/flito/soat/abc/x');
    expect(directo.status).toBe(409);
    expect(directo.body).toEqual({ error: 'Este SOAT se descartó porque su trámite ya no existe en FLITO.', code: 'TRAMITE_NO_VIGENTE' });
    const envuelto = await request(app(() => { throw Object.assign(new Error('Failed query'), { cause: { code: 'FL409' } }); })).post('/api/flito/impuestos/abc/x');
    expect(envuelto.status).toBe(409);
    expect(envuelto.body.error).toBe('Este impuesto se descartó porque su trámite ya no existe en FLITO.');
  });
});

describe('fragmentos SQL', () => {
  it('TRAMITE_MUERTO / TRAMITE_VIVO / SOAT_ABIERTO', () => {
    expect(render(vig.TRAMITE_MUERTO())).toBe(`"flito_tramites"."estado" = 'anulado'`);
    expect(render(vig.TRAMITE_VIVO())).toBe(`"flito_tramites"."estado" IS DISTINCT FROM 'anulado'`);
    expect(render(SOAT_ABIERTO())).toBe(`"flito_soat"."estado" NOT IN ('pagado', 'descartado')`);
  });
});
