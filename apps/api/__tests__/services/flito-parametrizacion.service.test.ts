import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock },
  getPoolStats: vi.fn(),
}));

beforeEach(() => selectMock.mockReset());

const { modalidadVigente, umbralPara } = await import(
  '../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js'
);

// Los tests de `resolverProveedor` se retiran con la función (HU #10979): las reglas de
// enrutamiento por ámbito ya no existen, el proveedor se elige al enviar el SOAT al gestor. Lo que
// fijaban —que la compañía gana al organismo y este al global— dejó de ser una regla del sistema.

describe('modalidadVigente', () => {
  it('sin vigencia abierta → AUTOGESTIONADO (default: FLITO no gestiona salvo marca explícita)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await modalidadVigente('11001')).toBe('autogestionado');
  });

  it('con vigencia abierta → su modalidad', async () => {
    selectMock.mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    expect(await modalidadVigente('11001')).toBe('requiere_gestion');
  });
});

describe('umbralPara', () => {
  it('sin sobrescritura → umbral por defecto del env (0.85)', () => {
    expect(umbralPara(null)).toBe(0.85);
    expect(umbralPara(undefined)).toBe(0.85);
  });
  it('con sobrescritura → ese valor', () => {
    expect(umbralPara('0.9')).toBe(0.9);
    expect(umbralPara(0.7)).toBe(0.7);
  });
});
