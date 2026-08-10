// Facturación electrónica — claves de página del catálogo compartido (HU #11342, AC5).
//
// Vive en shared-types y no en apps/api porque el catálogo de páginas es la FUENTE ÚNICA que
// consumen API y web: si la clave de operación se colara dentro de la de parametrización, ambos
// lados quedarían mal a la vez y no habría dónde verlo.

import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, ROLE_DEFAULT_PAGES, getEffectivePages } from '../src/permissions';

describe('AC5 — la pantalla de operación tiene clave propia', () => {
  it('`siigo_operacion` existe y es distinta de parametrización y del reporte de costos', () => {
    expect(PAGES).toHaveProperty('siigo_operacion');
    // Tres claves distintas para tres trabajos distintos: parametrizar se hace una vez, operar es
    // el día a día y el reporte de costos tiene otra audiencia. Fusionarlas obligaría a conceder
    // la operación diaria a quien solo debe parametrizar.
    const claves = new Set(['siigo_operacion', 'siigo_parametrizacion', 'finanzas_reporte_costos']);
    expect(claves.size).toBe(3);
    for (const clave of claves) expect(PAGES).toHaveProperty(clave);
  });

  it('aparece en el grupo Finanzas, o no se podría conceder desde la pantalla de usuarios', () => {
    const finanzas = PAGE_GROUPS.find((g) => g.label === 'Finanzas');
    expect(finanzas?.pages).toContain('siigo_operacion');
  });

  it('financiera y auditor la reciben por rol; admin la tiene por tenerlas todas', () => {
    expect(ROLE_DEFAULT_PAGES.financiera).toContain('siigo_operacion');
    // Auditoría VE la bandeja; que no pueda ejecutar nada lo garantiza la tabla de acciones del
    // backend (siigo.permisos.ts), no el catálogo de páginas.
    expect(ROLE_DEFAULT_PAGES.auditor).toContain('siigo_operacion');
    expect(getEffectivePages({ role: 'admin' })).toContain('siigo_operacion');
  });

  it('ningún otro rol la recibe por defecto', () => {
    const conLaPagina = Object.entries(ROLE_DEFAULT_PAGES)
      .filter(([role, pages]) => role !== 'admin' && (pages as readonly string[]).includes('siigo_operacion'))
      .map(([role]) => role)
      .sort();
    expect(conLaPagina).toEqual(['auditor', 'financiera']);
  });
});
