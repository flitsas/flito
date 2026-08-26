// Ayuda FLITO — clave de página del contenedor (HU #11893, AC1).
//
// El slug existe para el label de NoAccess y el ítem de nav. NO es un permiso que un
// administrador conceda a mano: Users itera `PAGE_GROUPS`, no `Object.keys(PAGES)`.
// La visibilidad del menú es la intersección del catálogo de fichas con `hasPage`.

import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, ROLE_DEFAULT_PAGES, getEffectivePages } from '../src/permissions';

describe('AC1 — el contenedor de Ayuda FLITO no es un permiso concedible', () => {
  it('`flito_ayuda` existe en el catálogo con su etiqueta visible', () => {
    expect(PAGES).toHaveProperty('flito_ayuda');
    expect(PAGES.flito_ayuda).toBe('Ayuda FLITO');
  });

  it('NO aparece en PAGE_GROUPS: Users no debe ofrecer concederlo', () => {
    const enGrupos = PAGE_GROUPS.flatMap((g) => g.pages);
    expect(enGrupos).not.toContain('flito_ayuda');
  });

  it('esta HU no crea el PageSlug `siigo_credenciales`', () => {
    expect(PAGES).not.toHaveProperty('siigo_credenciales');
  });

  it('admin la tiene por Object.keys(PAGES), sin escribirla a mano en otra fila', () => {
    expect(getEffectivePages({ role: 'admin' })).toContain('flito_ayuda');
    expect(ROLE_DEFAULT_PAGES.admin).toEqual(Object.keys(PAGES));
  });

  it('ningún rol no-admin la recibe por defecto', () => {
    const conLaPagina = Object.entries(ROLE_DEFAULT_PAGES)
      .filter(([role, pages]) => role !== 'admin' && (pages as readonly string[]).includes('flito_ayuda'))
      .map(([role]) => role);
    expect(conLaPagina).toEqual([]);
  });

  it('concedérsela a mano a un no-admin no basta: el slug no está en PAGE_GROUPS', () => {
    // `allowedPages` SÍ la uniría (getEffectivePages filtra por isValidPage), pero el picker de
    // Users no la muestra. El gate de ruta usa el helper derivado, no hasPage(flito_ayuda).
    const concedida = getEffectivePages({ role: 'conductor', allowedPages: ['flito_ayuda'] });
    expect(concedida).toContain('flito_ayuda');
    expect(getEffectivePages({ role: 'conductor' })).not.toContain('flito_ayuda');
  });
});
