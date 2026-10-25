// HU #13941 (decisión de David, 2026-10-24) — El SQL de General · Dr. Flit (0254), GENERADO desde el código:
// `npm run permisos:seed -w apps/api -- --arbol dr-flit` (siembra) y `… --reparto` (reparto). Lo pegado entre
// las marcas «ÁRBOL GENERADO» de la 0254 es EXACTAMENTE esta salida; `funciones.test.ts` lo compara.
//
// Por qué un generador propio y no `sqlSiembraArbol`/`sqlRepartoArbol`: el área estrena su ÍTEM (no existe en la
// base, la 0238 solo movió las páginas que había) y sus acciones no tienen grupo (`predecesores: []`), así que el
// reparto no es la regla «todos» sino dos pasos sin grupo:
//   1. Reparto UNIVERSAL (P-22, como el paso 1b de la 0237): las acciones `repartoUniversal` y su CADENA (ítem y
//      elemento) a cada rol de `permisos_roles`, sin literales de rol. Solo si ningún rol tiene aún la acción:
//      la segunda corrida (o un rol al que el panel se la quitó) no reparte nada.
//   2. `admin` recibe TODAS las acciones y su cadena (ADR-0022; HU #12873 AC8), por `JOIN permisos_roles`: un
//      ambiente sin el rol recibe 0 filas, no una FK rota.
// Nada a usuarios: nadie tenía las acciones, así que no hay `conceder` ni `revocar` que escribir.
import { catalogoCompleto, type FuncionCatalogo } from '../catalogo.js';
import { ACCIONES_POR_AREA, ACCIONES_UNIVERSALES, ancestrosDe, ROL_CON_TODAS_LAS_ACCIONES } from './expansion.js';
import { ITEM_DR_FLIT } from './acciones-dr-flit.js';
import { lit } from './sql-arbol.js';

const ACCIONES = ACCIONES_POR_AREA['dr-flit'];

/** La acción y su cadena (acción → ítem → elemento), en ese orden. */
const cadena = (accion: string): string[] => [accion, ...ancestrosDe(accion)];

/** Siembra: el ítem (nivel 2, bajo `menu.general`) y sus acciones (nivel 3), padres antes que hijas. */
export function sqlSiembraDrFlit(catalogo: FuncionCatalogo[] = catalogoCompleto()): string {
  const porCodigo = new Map(catalogo.map((f) => [f.codigo, f]));
  const filas = [ITEM_DR_FLIT, ...[...ACCIONES].sort((a, b) => porCodigo.get(a)!.orden! - porCodigo.get(b)!.orden!)]
    .map((c) => porCodigo.get(c)!);
  return [
    `-- 1 ítem (nivel 2) y ${ACCIONES.length} acciones (nivel 3). Generado: no editar a mano.`,
    '-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol dr-flit',
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

/** Reparto: universal a todos los roles (paso 1) y todas las acciones a `admin` (paso 2). */
export function sqlRepartoDrFlit(): string {
  const universales = ACCIONES_UNIVERSALES.filter((u) => ACCIONES.includes(u.accion));
  const paresUniversales = universales.flatMap((u) => cadena(u.accion).map((fn) => `  (${lit(u.accion)}, ${lit(fn)})`));
  const deAdmin = [...new Set(ACCIONES.flatMap(cadena))].sort();
  return [
    '-- Paso 1 — Reparto UNIVERSAL: la acción y su cadena (ítem y elemento) a CADA rol de permisos_roles (sin',
    '-- literales de rol: un rol ausente = 0 filas). Solo si la acción existe y aún no la tiene ningún rol.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT r.codigo, v.fn',
    '  FROM permisos_roles r',
    ' CROSS JOIN (VALUES',
    paresUniversales.join(',\n'),
    ' ) AS v(accion, fn)',
    ' WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.accion)',
    '   AND EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = v.fn)',
    '   AND NOT EXISTS (SELECT 1 FROM permisos_rol_funcion x WHERE x.funcion_codigo = v.accion)',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
    '',
    '-- Paso 2 — `admin` recibe TODAS las acciones y su cadena (ADR-0022). JOIN a permisos_roles: un ambiente',
    '-- sin el rol recibe 0 filas, no una FK rota.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT v.rol, v.fn FROM (VALUES',
    deAdmin.map((fn) => `  (${lit(ROL_CON_TODAS_LAS_ACCIONES)}, ${lit(fn)})`).join(',\n'),
    ') AS v(rol, fn)',
    'JOIN permisos_roles r ON r.codigo = v.rol',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
  ].join('\n');
}
