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
const { escribirTramite } = await import('../../src/modules/flito-sync/flito-sync.service.js');

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

  it('el gestor no entra al raw (flit_raw): ni nombre ni correo, y el resto del ítem sí', () => {
    const tf = aTramite(item({ nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co' }));
    const crudo = JSON.stringify(tf.raw);
    expect(crudo).not.toContain('Marta Gómez');
    expect(crudo).not.toContain('marta@gestora.co');
    expect(tf.raw).not.toHaveProperty('nombreGestor');
    expect(tf.raw).not.toHaveProperty('correoGestor');
    expect(tf.raw).toMatchObject({ Id: 'FLIT-099002', Placa: 'ZZZ002', CompaniaGestora: '901789698' });
    expect(tf).toMatchObject({ nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co' });
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

describe('escribirTramite · fila con gestor y valores sin gestor', () => {
  it('no hay cambios ni diferencia de gestor en la Bitácora (la fuente que no lo trae no lo borra)', async () => {
    const existente = {
      id: 'eeee0000-0000-0000-0000-000000000320', flitEstado: 'Aprobado', ciudad: 'FUNZA', tipoTramite: 'Otros',
      facturaVentaFlitId: null, fechaAprobacion: null, companiaId: null, organismoCodigo: null, plateComplete: 'ZZZ320',
      nombreGestor: 'Marta Gómez', correoGestor: 'm@x.co',
    };
    const valores = {
      flitEstado: 'Aprobado', ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: null, fechaAprobacion: null,
      companiaId: null, organismoCodigo: null, plateComplete: 'ZZZ320', ...gestorSiViene(null, null),
    };
    const set = vi.fn();
    const tx = {
      update: () => ({ set: (v: unknown) => { set(v); return { where: () => ({ returning: async () => [existente] }) }; } }),
      insert: () => { throw new Error('no debe escribir historial'); },
    };
    const r = await escribirTramite(tx as never, existente as never, 'FLIT-320', valores as never);
    expect(r.huboCambios).toBe(false);
    expect(r.diferencias.map((d) => d.campo)).not.toContain('nombre_gestor');
    expect(r.diferencias.map((d) => d.campo)).not.toContain('correo_gestor');
    expect(set.mock.calls[0]![0]).not.toHaveProperty('nombreGestor');
  });
});

describe('gestorSiViene · formato del correo', () => {
  it('un correo válido pasa', () => {
    expect(gestorSiViene(null, 'marta@gestora.co')).toEqual({ correoGestor: 'marta@gestora.co' });
  });

  // Un solo carácter prohibido por caso (una sola @): así cada exclusión de la regex se prueba por separado.
  it.each([
    ['x@y.co?bcc=a@b.co'], ['marta @gestora.co'], ['marta.gestora.co'], ['a@b'], ['a@b.co,c@d.co'], ['<a@b.co>'],
    ['x@y.co?subject=hola'], ['x@y.co&bcc=z'], ['x@y.co,z'], ['x@y.co;z'], ['x@y.co<z'], ['x@y.co>z'], ['x@y.co"z'], ['a@@y.co'],
  ])(
    'se omite %s (como si no viniera: no pisa lo guardado)', (malo) => {
      expect(gestorSiViene('Marta', malo)).toEqual({ nombreGestor: 'Marta' });
    },
  );
});
