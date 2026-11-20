// HU #13452 (Feature #12871, Épica #13411) — El Tablero de General (`pagina.dashboard`) es el módulo
// `tablero` de la frontera (P-11 unió Tablero FLITO a General). `FRONTERA_POR_ENLACE.tablero` lo abre
// solo a `compania` (#13426): la compañía lo ve con sus cifras; proveedor y organismos no.
import { describe, it, expect } from 'vitest';
import { MODULO_FRONTERA_DE_PAGINA, PAGINAS_DE_SESION, paginaAbiertaAlEnlace } from '../src/index.js';

describe('paginaAbiertaAlEnlace · Tablero de General', () => {
  it('`dashboard` pertenece al módulo `tablero`, igual que `flito_tablero`', () => {
    expect(MODULO_FRONTERA_DE_PAGINA.dashboard).toBe('tablero');
    expect(MODULO_FRONTERA_DE_PAGINA.flito_tablero).toBe('tablero');
  });

  it('abierto al enlace compañía', () => {
    expect(paginaAbiertaAlEnlace('dashboard', 'compania')).toBe(true);
  });

  it.each(['proveedor', 'organismos_transito'] as const)('cerrado al enlace %s', (enlace) => {
    expect(paginaAbiertaAlEnlace('dashboard', enlace)).toBe(false);
  });

  it.each([null, undefined, 'ninguno'] as const)('sin enlace (%s) no cambia: abierto', (enlace) => {
    expect(paginaAbiertaAlEnlace('dashboard', enlace)).toBe(true);
  });
});

// HU #13942 — Dr. Flit no se cierra por ningún enlace: sus rutas son transversales del API (HU #13941).
describe('paginaAbiertaAlEnlace · Dr. Flit (HU #13942)', () => {
  it('`flito_dr_flit` es pantalla de sesión, como Perfil y Ayuda', () => {
    expect(PAGINAS_DE_SESION).toEqual(['perfil', 'flito_ayuda', 'flito_dr_flit']);
  });

  it.each(['compania', 'proveedor', 'organismos_transito'] as const)('abierto al enlace %s', (enlace) => {
    expect(paginaAbiertaAlEnlace('flito_dr_flit', enlace)).toBe(true);
  });

  it.each([null, undefined, 'ninguno'] as const)('sin enlace (%s): abierto', (enlace) => {
    expect(paginaAbiertaAlEnlace('flito_dr_flit', enlace)).toBe(true);
  });

  it('control: una pantalla sin módulo de frontera sigue cerrada al enlace compañía', () => {
    expect(paginaAbiertaAlEnlace('clients', 'compania')).toBe(false);
  });
});
