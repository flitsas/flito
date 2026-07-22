import { describe, it, expect } from 'vitest';
import { resolverCodigoOrganismoFlit } from '../src/organismos-transito';

// Emparejamiento del reporte de FLIT (sin código DIVIPOLA) con el catálogo nacional.
describe('resolverCodigoOrganismoFlit', () => {
  it('empareja por CIUDAD normalizando mayúsculas/tildes (FLIT trae la ciudad en mayúsculas)', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'FUNZA', nombre: null })).toBe('25286');
    expect(resolverCodigoOrganismoFlit({ ciudad: 'ENVIGADO', nombre: null })).toBe('05266');
  });

  it('la ciudad gana aunque el nombre de FLIT no cuadre con el del catálogo (caso Medellín)', () => {
    // FLIT: "STRIA DE TTOyTTE MEDELLIN"; catálogo: "STRIA TTEyTTO MEDELLIN" (no cruzan por nombre).
    expect(resolverCodigoOrganismoFlit({ ciudad: 'MEDELLIN', nombre: 'STRIA DE TTOyTTE MEDELLIN' })).toBe('05001');
  });

  it('respaldo por NOMBRE cuando la ciudad no está en el catálogo', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'CIUDAD INEXISTENTE', nombre: 'STRIA TTOyTTE MCPAL FUNZA' })).toBe('25286');
  });

  it('devuelve null si no cruza por ciudad ni por nombre', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'MUNICIPIO INEXISTENTE', nombre: 'STRIA DESCONOCIDA' })).toBeNull();
    expect(resolverCodigoOrganismoFlit({ ciudad: null, nombre: null })).toBeNull();
  });
});
