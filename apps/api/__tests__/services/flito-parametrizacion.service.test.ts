import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock },
  getPoolStats: vi.fn(),
}));

beforeEach(() => selectMock.mockReset());

const { resolverProveedor, modalidadVigente, umbralPara } = await import(
  '../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js'
);

describe('resolverProveedor — especificidad', () => {
  it('compañía gana a organismo y a global (prioridad ASC, primero activo)', async () => {
    // La query ordena por prioridad ASC; el servicio toma el primero activo.
    selectMock.mockReturnValueOnce(chain([
      { prioridad: 10, proveedor: { id: 'compania', activo: true } },
      { prioridad: 20, proveedor: { id: 'organismo', activo: true } },
      { prioridad: 30, proveedor: { id: 'global', activo: true } },
    ]));
    const p = await resolverProveedor(1, '11001');
    expect(p?.id).toBe('compania');
  });

  it('salta el más específico si su proveedor está inactivo', async () => {
    selectMock.mockReturnValueOnce(chain([
      { prioridad: 10, proveedor: { id: 'compania', activo: false } },
      { prioridad: 30, proveedor: { id: 'global', activo: true } },
    ]));
    const p = await resolverProveedor(1, '11001');
    expect(p?.id).toBe('global');
  });

  it('sin regla aplicable → null (información, no fallo)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await resolverProveedor(1, '11001')).toBeNull();
  });
});

describe('modalidadVigente', () => {
  it('sin vigencia abierta → SIN_CLASIFICAR (no es default, es ausencia de decisión)', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await modalidadVigente('11001')).toBe('sin_clasificar');
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
