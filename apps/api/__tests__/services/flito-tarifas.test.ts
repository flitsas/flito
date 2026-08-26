// HU #10963 — tarifas negociadas por compañía (Feature #10939 §2.1 y §2.2).
//
// El núcleo es `tarifaDe()`: qué valor gana y, sobre todo, que un concepto sin configurar NO
// devuelva cero. Ese cero silencioso es lo que haría cuadrar un total falso en el reporte.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';
import { normalizarTipoTramite } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { tarifaDe, crearTarifa, actualizarTarifa, TarifaError } =
  await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); deleteMock.mockReset();
});

describe('normalizarTipoTramite — FLIT manda el tipo como texto libre', () => {
  it('iguala las variantes de escritura del mismo tipo', () => {
    expect(normalizarTipoTramite('Traspaso')).toBe('TRASPASO');
    expect(normalizarTipoTramite('  traspaso ')).toBe('TRASPASO');
    expect(normalizarTipoTramite('TRASPASO')).toBe('TRASPASO');
  });

  it('trata vacío y ausente como «sin tipo» (tarifa genérica)', () => {
    expect(normalizarTipoTramite('')).toBeNull();
    expect(normalizarTipoTramite('   ')).toBeNull();
    expect(normalizarTipoTramite(null)).toBeNull();
    expect(normalizarTipoTramite(undefined)).toBeNull();
  });
});

describe('tarifaDe — qué valor gana', () => {
  it('la tarifa del tipo exacto manda sobre la genérica', async () => {
    selectMock.mockReturnValueOnce(chain([
      { tipoTramite: null, valor: '100000' },
      { tipoTramite: 'TRASPASO', valor: '250000' },
    ]));
    const r = await tarifaDe(7, 'tramite_digital', 'Traspaso');
    expect(r).toEqual({ valor: 250000, origen: 'especifica' });
  });

  it('sin tarifa específica cae a la genérica', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipoTramite: null, valor: '100000' }]));
    const r = await tarifaDe(7, 'tramite_digital', 'Matricula');
    expect(r).toEqual({ valor: 100000, origen: 'generica' });
  });

  it('sin ninguna tarifa devuelve «no configurada», nunca cero', async () => {
    // Un cero aquí sumaría un total falso en el reporte y nadie lo notaría.
    selectMock.mockReturnValueOnce(chain([]));
    const r = await tarifaDe(7, 'logistica', 'Traspaso');
    expect(r).toEqual({ valor: null, origen: 'no_configurada' });
    expect(r.valor).not.toBe(0);
  });

  it('un trámite sin compañía emparejada no tiene tarifa', async () => {
    const r = await tarifaDe(null, 'tramite_digital', 'Traspaso');
    expect(r.origen).toBe('no_configurada');
    expect(selectMock).not.toHaveBeenCalled(); // ni siquiera va a la BD
  });

  it('un valor de cero configurado a propósito sí se respeta', async () => {
    // Cero es un precio válido si alguien lo configuró; lo inaceptable es inventarlo.
    selectMock.mockReturnValueOnce(chain([{ tipoTramite: null, valor: '0' }]));
    const r = await tarifaDe(7, 'logistica', null);
    expect(r).toEqual({ valor: 0, origen: 'generica' });
  });

  it('el tipo se compara normalizado, no literal', async () => {
    selectMock.mockReturnValueOnce(chain([{ tipoTramite: 'MATRICULA', valor: '55000' }]));
    const r = await tarifaDe(7, 'tramite_digital', '  matricula ');
    expect(r).toEqual({ valor: 55000, origen: 'especifica' });
  });
});

describe('crearTarifa — validaciones', () => {
  it('rechaza un valor negativo', async () => {
    await expect(crearTarifa({ companiaId: 1, concepto: 'logistica', valor: -1 }, 1))
      .rejects.toBeInstanceOf(TarifaError);
  });

  it('rechaza una compañía inexistente', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(crearTarifa({ companiaId: 999, concepto: 'logistica', valor: 1000 }, 1))
      .rejects.toThrow(/no existe/i);
  });

  it('traduce el choque de unicidad a un mensaje accionable', async () => {
    selectMock.mockReturnValueOnce(chain([{ id: 1 }]));
    insertMock.mockReturnValue({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })) }),
    });
    await expect(crearTarifa({ companiaId: 1, concepto: 'logistica', valor: 1000 }, 1))
      .rejects.toThrow(/Ed[íi]tala en vez de crear otra/i);
  });
});

describe('actualizarTarifa — validaciones', () => {
  it('rechaza un valor negativo', async () => {
    await expect(actualizarTarifa('id-1', { valor: -5 }, 1)).rejects.toBeInstanceOf(TarifaError);
  });

  it('falla si la tarifa no existe', async () => {
    updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    await expect(actualizarTarifa('no-existe', { valor: 10 }, 1)).rejects.toThrow(/no existe/i);
  });
});
