// Épica #14548 (ADR-0051, bloque A) — permisos del visor de consumo de IA: el ítem del árbol, sus tres acciones, sus
// operaciones y el reparto (solo `admin`, D4). La deriva de los contadores del catálogo vive en sus propios tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARBOL_PERMISOS } from '@operaciones/shared-types';
import { ACCIONES_IA_CONSUMO, OPERACIONES_IA_CONSUMO } from '../../../src/modules/permisos/arbol/acciones-ia-consumo.js';
import { ACCIONES_NACIDAS_TRAS_LA_SIEMBRA, OPERACIONES_NACIDAS_EN_EL_ARBOL } from '../../../src/modules/permisos/arbol/acciones-finanzas.js';
import { ACCIONES_ARBOL, ACCIONES_POR_AREA, operacionesDe } from '../../../src/modules/permisos/arbol/expansion.js';
import { paresRepartoIaConsumo, sqlRepartoIaConsumo, sqlSiembraIaConsumo } from '../../../src/modules/permisos/arbol/sql-ia-consumo.js';
import { catalogoCompleto } from '../../../src/modules/permisos/catalogo.js';

const SQL = readFileSync(join(__dirname, '../../../src/db/migrations/0321_flito_ia_consumo_permisos.sql'), 'utf8');
const INICIO = '-- ÁRBOL GENERADO (inicio)\n';
const FIN = '-- ÁRBOL GENERADO (fin)';

const ACCIONES = ['accion.ia_consumo.ver', 'accion.ia_consumo.exportar', 'accion.ia_consumo.ver_contenido'];
const OPERACIONES = ['ia_consumo.registros.ver', 'ia_consumo.registros.exportar', 'ia_consumo.contenido.ver'];

describe('ítem «Consumo de IA» en el árbol (ADR-0051, D4)', () => {
  it('nace en Administración con orden 70 y sus tres acciones, y solo esas', () => {
    const pagina = catalogoCompleto().find((f) => f.codigo === 'pagina.ia_consumo');
    expect(pagina?.padre).toBe('menu.administracion');
    expect(pagina?.orden).toBe(70);
    expect(pagina?.nombreNegocio).toBe('Consumo de IA');
    const hijos = ARBOL_PERMISOS.filter((n) => n.padre === 'pagina.ia_consumo').map((n) => n.codigo).sort();
    expect(hijos).toEqual([...ACCIONES].sort());
    expect(Object.keys(ACCIONES_IA_CONSUMO).sort()).toEqual([...ACCIONES].sort());
  });

  it('el catálogo del código deja la página y sus tres acciones solo a `admin` (A-24)', () => {
    const catalogo = catalogoCompleto();
    for (const codigo of ['pagina.ia_consumo', ...ACCIONES]) {
      expect(catalogo.find((f) => f.codigo === codigo)?.roles, codigo).toEqual(['admin']);
    }
  });

  it('la lectura es `ver`; exportar y ver_contenido no lo son (una acción de descarga no concede la lectura por sí sola)', () => {
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.ver']).toMatchObject({ lectura: true, operaciones: ['ia_consumo.registros.ver'] });
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.exportar']).toMatchObject({ operaciones: ['ia_consumo.registros.exportar'] });
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.exportar']).not.toHaveProperty('lectura');
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.ver_contenido']).toMatchObject({ operaciones: ['ia_consumo.contenido.ver'] });
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.ver_contenido']).not.toHaveProperty('lectura');
  });

  it('ninguna acción tiene predecesores: nadie las tenía, y solo `admin` las recibe (D4)', () => {
    for (const a of ACCIONES) expect(ACCIONES_IA_CONSUMO[a]?.predecesores, a).toEqual([]);
    expect(paresRepartoIaConsumo().every(([rol]) => rol === 'admin')).toBe(true);
  });

  it('`apoyo` de exportar y de contenido es la lectura: quien recibe la descarga también ve la lista (V4)', () => {
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.exportar']?.apoyo).toEqual(['ia_consumo.registros.ver']);
    expect(ACCIONES_IA_CONSUMO['accion.ia_consumo.ver_contenido']?.apoyo).toEqual(['ia_consumo.registros.ver']);
    expect(operacionesDe('accion.ia_consumo.exportar')).toEqual(expect.arrayContaining(['ia_consumo.registros.exportar']));
  });

  it('las acciones son posteriores a la siembra (V1): entran en ACCIONES_NACIDAS_TRAS_LA_SIEMBRA y no en ACCIONES_POR_AREA', () => {
    for (const a of ACCIONES) {
      expect(ACCIONES_ARBOL[a], a).toBeDefined();
      expect(ACCIONES_NACIDAS_TRAS_LA_SIEMBRA.has(a), a).toBe(true);
    }
    for (const area of Object.keys(ACCIONES_POR_AREA)) {
      for (const a of ACCIONES) expect(ACCIONES_POR_AREA[area as keyof typeof ACCIONES_POR_AREA], `${area}: ${a}`).not.toContain(a);
    }
  });

  it('las tres operaciones nacen en el árbol y no se siembran (no están en el mundo plano)', () => {
    for (const op of OPERACIONES) expect(OPERACIONES_NACIDAS_EN_EL_ARBOL.has(op), op).toBe(true);
    expect([...OPERACIONES_IA_CONSUMO].sort()).toEqual([...OPERACIONES].sort());
  });

  it('la frontera cierra el visor a todo enlace: `/api/ia-consumo` va montado sin `conAlcance`', () => {
    const app = readFileSync(join(__dirname, '../../../src/app.ts'), 'utf8');
    expect(app).toMatch(/app\.use\('\/api\/ia-consumo', iaConsumoRoutes\);/);
    expect(app).not.toMatch(/conAlcance\('ia-consumo'/);
  });
});

describe('generador ↔ migración 0321 (V6)', () => {
  it('lo pegado entre las marcas es exactamente la salida del generador (siembra y reparto)', () => {
    const bloque = SQL.slice(SQL.indexOf(INICIO) + INICIO.length, SQL.indexOf(FIN));
    expect(bloque.trim()).toBe(`${sqlSiembraIaConsumo()}\n\n${sqlRepartoIaConsumo()}`.trim());
  });

  it('la siembra da exactamente la página y las tres acciones, con su padre y su orden', () => {
    const siembra = sqlSiembraIaConsumo();
    expect(siembra).toContain("('pagina.ia_consumo', 'administracion', 'Consumo de IA', ");
    expect(siembra).toContain("'pagina', 'menu.administracion', '2', '70')");
    for (const a of ACCIONES) expect(siembra).toContain(`('${a}', `);
    expect(siembra).toContain("'accion', 'pagina.ia_consumo', '3', '10')");
  });

  it('el reparto de la migración cubre las tres acciones, su página y el menú, y ningún otro rol', () => {
    const bloque = SQL.slice(SQL.indexOf(INICIO) + INICIO.length, SQL.indexOf(FIN));
    const reparto = bloque.slice(bloque.indexOf('INSERT INTO permisos_rol_funcion'));
    const pares = [...reparto.matchAll(/\('([a-z_]+)', '([^']+)'\)/g)].map(([, rol, fn]) => [rol, fn]);
    expect(pares.length).toBeGreaterThan(0);
    expect(pares.every(([rol]) => rol === 'admin')).toBe(true);
    expect(pares.map(([, fn]) => fn).sort()).toEqual(
      [...ACCIONES, 'menu.administracion', 'pagina.ia_consumo'].sort(),
    );
  });
});
