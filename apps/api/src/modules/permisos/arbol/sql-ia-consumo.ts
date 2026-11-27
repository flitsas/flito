// Épica #14548 (ADR-0051) — El SQL de los permisos del visor de solo lectura de consumo de IA (0321), GENERADO desde el
// código: `npm run permisos:seed -w apps/api -- --arbol ia-consumo` (siembra) y `… --reparto` (reparto). Lo pegado entre
// las marcas «ÁRBOL GENERADO» de la 0321 es EXACTAMENTE esta salida; `ia-consumo-permisos.test.ts` lo compara.
//
// Modelo: `sql-torre.ts`, pero SIN `padreAntesDeAreas` (V13): la 0321 es posterior a la 0315 y `pagina.ia_consumo` no
// está en `ELEMENTO_ANTERIOR`, así que la cadena de cada acción es la de hoy (`ancestrosDe`).
//
// Reparto: SOLO `admin` (ADR-0051, D4). No hay reparto a otros roles: el resto lo concede el panel de permisos.
// `JOIN permisos_roles`: un ambiente sin el rol recibe 0 filas, no una FK rota.
import { catalogoCompleto, type FuncionCatalogo } from '../catalogo.js';
import { ancestrosDe, ROL_CON_TODAS_LAS_ACCIONES } from './expansion.js';
import { ACCIONES_IA_CONSUMO } from './acciones-ia-consumo.js';
import { lit } from './sql-arbol.js';

/** El ítem que estrena la 0321 (nivel 2), bajo `menu.administracion`. */
export const ITEM_IA_CONSUMO = 'pagina.ia_consumo';

/** La acción y su cadena (acción → ítem → elemento), en ese orden. */
const cadena = (accion: string): string[] => [accion, ...ancestrosDe(accion)];

/** Siembra: el ítem (nivel 2) y sus acciones (nivel 3), padres antes que hijas. */
export function sqlSiembraIaConsumo(catalogo: FuncionCatalogo[] = catalogoCompleto()): string {
  const porCodigo = new Map(catalogo.map((f) => [f.codigo, f]));
  const porOrden = (a: string, b: string): number => porCodigo.get(a)!.orden! - porCodigo.get(b)!.orden!;
  const acciones = Object.keys(ACCIONES_IA_CONSUMO).sort(porOrden);
  const filas = [ITEM_IA_CONSUMO, ...acciones].map((c) => porCodigo.get(c)!);
  return [
    `-- 1 ítems (nivel 2) y ${acciones.length} acciones (nivel 3). Generado: no editar a mano.`,
    '-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol ia-consumo',
    'INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES',
    filas.map((f) => `  (${[f.codigo, f.modulo, f.nombreNegocio, f.descripcion, f.tipo, f.padre!, String(f.nivel), String(f.orden)].map(lit).join(', ')})`).join(',\n'),
    'ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,',
    '  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,',
    '  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden',
    '  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,',
    '         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)',
    '    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,',
    '         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);',
  ].join('\n');
}

/** Los pares (rol, función) que siembra la 0321: `admin` con la cadena de cada acción (ADR-0022 AC2). */
export function paresRepartoIaConsumo(): [string, string][] {
  return [...new Set(Object.keys(ACCIONES_IA_CONSUMO).flatMap(cadena))]
    .map((fn): [string, string] => [ROL_CON_TODAS_LAS_ACCIONES, fn])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/** Reparto: solo `admin`, por `JOIN permisos_roles`. */
export function sqlRepartoIaConsumo(): string {
  return [
    '-- `admin` recibe las tres acciones y su cadena (ADR-0051, D4; ADR-0022 AC2). Ningún otro rol: el resto lo concede el panel de',
    '-- permisos. JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT v.rol, v.fn FROM (VALUES',
    paresRepartoIaConsumo().map(([rol, fn]) => `  (${lit(rol)}, ${lit(fn)})`).join(',\n'),
    ') AS v(rol, fn)',
    'JOIN permisos_roles r ON r.codigo = v.rol',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
  ].join('\n');
}
