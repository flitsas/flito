/**
 * Gestor del trámite (nombreGestor / correoGestor), FLIT 1 y FLIT 2.
 *   · FLIT 1: `aTramite` los lleva al puerto (con/sin), descarta lo que no cabe en la columna (sin loguear el valor).
 *   · Semántica del sync: la fuente que NO los trae no pisa con null lo guardado y no cuenta como cambio;
 *     un valor nuevo sí actualiza.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const { aTramite, MAX_GESTOR } = await import('../../src/modules/flito-sync/flit-http.adapter.js');
const { gestorSiViene, tramiteCambia } = await import('../../src/modules/flito-sync/solo-si-cambia.js');

const item = (over: Record<string, unknown> = {}) => ({
  Id: 'FLIT-099002', Vin: '9FKTEST00000000002', Placa: 'ZZZ002', Ciudad: 'FUNZA', Estado: 'Aprobado',
  Tramite: 'Otros', Transito: 'STRIA FUNZA', CompaniaGestora: '901789698', codigoSecretaria: '25286',
  ...over,
}) as never;

describe('FLIT 1 · aTramite con y sin gestor', () => {
  it('con gestor: los recorta y los pasa al puerto', () => {
    const tf = aTramite(item({ nombreGestor: '  Marta Gómez ', correoGestor: 'marta@gestora.co' }));
    expect(tf).toMatchObject({ nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co' });
  });

  it('sin gestor (el reporte aún no lo trae) o vacío: null, sin error', () => {
    expect(aTramite(item())).toMatchObject({ nombreGestor: null, correoGestor: null });
    expect(aTramite(item({ nombreGestor: '  ', correoGestor: '' }))).toMatchObject({ nombreGestor: null, correoGestor: null });
  });

  it('más largo que su columna: se descarta a null y el warn no lleva el valor', () => {
    const largo = 'x'.repeat(MAX_GESTOR.nombreGestor + 1);
    const tf = aTramite(item({ nombreGestor: largo, correoGestor: 'a'.repeat(MAX_GESTOR.correoGestor) }));
    expect(tf.nombreGestor).toBeNull();
    expect(tf.correoGestor).toHaveLength(MAX_GESTOR.correoGestor);
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain(largo);
  });
});

describe('sync · el gestor ausente no pisa con null lo guardado', () => {
  it('gestorSiViene solo emite las claves con valor', () => {
    expect(gestorSiViene(null, undefined)).toEqual({});
    expect(gestorSiViene('', '')).toEqual({});
    expect(gestorSiViene('Marta', null)).toEqual({ nombreGestor: 'Marta' });
    expect(gestorSiViene('Marta', 'm@x.co')).toEqual({ nombreGestor: 'Marta', correoGestor: 'm@x.co' });
  });

  it('un reporte sin gestor sobre una fila con gestor no es un cambio; uno con valor nuevo sí', () => {
    const guardado = { ciudad: 'FUNZA', nombreGestor: 'Marta Gómez', correoGestor: 'm@x.co' };
    expect(tramiteCambia(guardado, { ciudad: 'FUNZA', ...gestorSiViene(null, null) })).toBe(false);
    expect(tramiteCambia(guardado, { ciudad: 'FUNZA', ...gestorSiViene('Pedro Ruiz', null) })).toBe(true);
    expect(tramiteCambia(guardado, { ciudad: 'FUNZA', ...gestorSiViene('Marta Gómez', 'm@x.co') })).toBe(false);
  });
});
