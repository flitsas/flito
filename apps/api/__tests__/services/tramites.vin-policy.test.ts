import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock },
}));

import { findVinMatriculaInicialConflict, isMatriculaInicial } from '../../src/modules/tramites/tramites.vin-policy.js';

beforeEach(() => { selectMock.mockReset(); });

describe('isMatriculaInicial', () => {
  it('sin tipología → matrícula inicial', () => {
    expect(isMatriculaInicial({})).toBe(true);
    expect(isMatriculaInicial({ tipologiaCodigo: null })).toBe(true);
  });
  it('con tipología → no aplica regla de unicidad B01', () => {
    expect(isMatriculaInicial({ tipologiaCodigo: 'traspaso_standard' })).toBe(false);
  });
});

describe('findVinMatriculaInicialConflict', () => {
  it('sin filas → null', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await findVinMatriculaInicialConflict('abc-123')).toBeNull();
  });

  it('solo rechazados → null (permite reintentar)', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 1, estado: 'rechazado', paso: 3, placa: 'X', vin: 'ABC123' },
    ]));
    expect(await findVinMatriculaInicialConflict('ABC123')).toBeNull();
  });

  it('borrador existente → TRAMITE_DUPLICADO', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 7, estado: 'borrador', paso: 2, placa: 'QTP710', vin: 'VIN1' },
    ]));
    const c = await findVinMatriculaInicialConflict('VIN1');
    expect(c?.code).toBe('TRAMITE_DUPLICADO');
    expect(c?.existingTramite.id).toBe(7);
  });

  it('completado → TRAMITE_MATRICULA_COMPLETADA', async () => {
    selectMock.mockReturnValueOnce(chain([
      { id: 3, estado: 'completado', paso: 5, placa: 'ZZZ', vin: 'VIN2' },
    ]));
    const c = await findVinMatriculaInicialConflict('VIN2');
    expect(c?.code).toBe('TRAMITE_MATRICULA_COMPLETADA');
  });
});
