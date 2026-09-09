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

  // Era una aserción de ALCANCE de la #11893 («esta HU no crea el PageSlug»), no una regla de
  // dominio: declaraba que la ficha de ayuda nombraba una clave que todavía no existía. La HU
  // #11890 la creó, así que la afirmación se invierte en vez de borrarse — lo que hay que
  // sostener ahora es que la ficha del catálogo ya no apunta al vacío.
  it('el PageSlug `siigo_credenciales` que nombra su ficha ya existe (HU #11890)', () => {
    expect(PAGES).toHaveProperty('siigo_credenciales');
  });

  // HU #12081 AC2-bis y AC4 — Este caso decía «admin la tiene por Object.keys(PAGES)», y esa era
  // justamente la fila que el AC4 retira. Desde la 0179 `admin` NO tiene fila en la tabla y
  // `flito_ayuda` NO entra al catálogo de funciones: nadie la concede, ni siquiera él.
  //
  // Y no pasa nada, que es el punto: su visibilidad nunca dependió de `hasPage`. Medido el 9/09/2026
  // — el gate de ruta (`App.tsx`, AyudaFlitoGate) y el del menú (`navItems.ts:51`) usan
  // `puedeVerAyudaFlito`, que es la intersección con el catálogo de fichas. Si alguien "arregla"
  // esto metiéndola en PAGE_GROUPS o en una fila de rol, el caso de arriba y este se ponen rojos.
  it('nadie la recibe por defecto, `admin` incluido, y su visibilidad sigue siendo derivada', () => {
    expect(ROLE_DEFAULT_PAGES.admin).toBeUndefined();
    expect(getEffectivePages({ role: 'admin' })).not.toContain('flito_ayuda');
    const conLaPagina = Object.entries(ROLE_DEFAULT_PAGES)
      .filter(([, pages]) => (pages as readonly string[]).includes('flito_ayuda'))
      .map(([role]) => role);
    expect(conLaPagina).toEqual([]);
    // El catálogo la sigue declarando como slug: lo que no es, es concedible.
    expect(PAGES).toHaveProperty('flito_ayuda');
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
