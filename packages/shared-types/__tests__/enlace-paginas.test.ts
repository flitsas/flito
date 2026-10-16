// HU #13452 (Feature #12871, Épica #13411) — El Tablero de General (`pagina.dashboard`) es el módulo
// `tablero` de la frontera (P-11 unió Tablero FLITO a General). `FRONTERA_POR_ENLACE.tablero` lo abre
// solo a `compania` (#13426): la compañía lo ve con sus cifras; proveedor y organismos no.
import { describe, it, expect } from 'vitest';
import { MODULO_FRONTERA_DE_PAGINA, paginaAbiertaAlEnlace } from '../src/index.js';

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
