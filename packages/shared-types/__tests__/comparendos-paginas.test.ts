// FLITO Comparendos — clave de página del catálogo compartido (HU #11559, AC1).
//
// Vive en shared-types y no en apps/api por el mismo motivo que `siigo-paginas.test.ts`: el catálogo
// de páginas es la FUENTE ÚNICA que consumen API y web, así que un error aquí deja mal a los dos
// lados a la vez y no habría un tercer sitio donde verlo.
//
// Lo que estas pruebas fijan no es que el slug exista —eso lo diría el compilador— sino QUIÉN lo
// recibe: el router de `/flito/comparendos` exige `admin` a nivel de router entero
// (`flito-comparendos.routes.ts`), así que conceder la página a cualquier otro rol —`auditor` es el
// candidato natural, porque entra a casi todo FLITO en lectura— sería darle una pantalla que
// responde 403 en cada petición. El test existe para que ese error no se cuele en un futuro
// «añádele las vistas FLITO al auditor».

import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, ROLE_DEFAULT_PAGES, getEffectivePages } from '../src/permissions';

describe('AC1 — la página de comparendos tiene clave propia', () => {
  it('`flito_comparendos` existe en el catálogo con su etiqueta visible', () => {
    expect(PAGES).toHaveProperty('flito_comparendos');
    expect(PAGES.flito_comparendos).toBe('FLITO — Comparendos');
  });

  it('aparece en el grupo FLITO, o no se podría conceder desde la pantalla de usuarios', () => {
    const flito = PAGE_GROUPS.find((g) => g.label === 'FLITO (SOAT e Impuestos)');
    expect(flito?.pages).toContain('flito_comparendos');
  });

  it('admin la tiene por tenerlas todas, sin tocar ROLE_DEFAULT_PAGES', () => {
    expect(getEffectivePages({ role: 'admin' })).toContain('flito_comparendos');
    // La fila de admin es `Object.keys(PAGES)`: la página entra sola. Si alguien la escribiera
    // además a mano en otra fila, el test de abajo lo cazaría.
  });

  it('ningún rol la recibe por defecto — en particular NO `auditor`', () => {
    const conLaPagina = Object.entries(ROLE_DEFAULT_PAGES)
      .filter(([role, pages]) => role !== 'admin' && (pages as readonly string[]).includes('flito_comparendos'))
      .map(([role]) => role);
    expect(conLaPagina).toEqual([]);
    expect(getEffectivePages({ role: 'auditor' })).not.toContain('flito_comparendos');
  });

  it('un usuario no-admin solo la obtiene si un administrador se la concede a mano', () => {
    // `allowedPages` es la vía prevista para el «quien opera comparendos» que no es admin del
    // sistema. Que funcione es parte del AC: la página se concede sin abrirle el resto.
    const concedida = getEffectivePages({ role: 'transito', allowedPages: ['flito_comparendos'] });
    expect(concedida).toContain('flito_comparendos');
    expect(concedida).not.toContain('users');
  });
});
