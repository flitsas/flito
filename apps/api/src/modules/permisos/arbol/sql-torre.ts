// Torre de Control Gerencial (Épica #14590) — El SQL de los permisos de la Torre (0303), GENERADO desde el código:
// `npm run permisos:seed -w apps/api -- --arbol torre` (siembra) y `… --reparto` (reparto). Lo pegado entre las
// marcas «ÁRBOL GENERADO» de la 0303 es EXACTAMENTE esta salida; `flito-torre-permisos.test.ts` lo compara.
//
// Mismo esquema que `sql-dr-flit.ts`: el área estrena sus ítems y sus acciones no tienen grupo, así que el reparto
// no es la regla «todos» sino literal:
//   1. `admin` recibe TODAS las acciones y su cadena (ADR-0022).
//   2. `financiera`, `auditor`, `gerencia_comercial` y `gerencia_general` reciben `REPARTO_TORRE`.
//   3. Los dos roles que nacen en la 0303 (`ROLES_NUEVOS_TORRE`) reciben además lo que `crearRol` da a todo rol
//      nuevo: las acciones de reparto universal (Perfil, «Ver los manuales» de Dr. Flit) y su cadena.
// Ambos por `JOIN permisos_roles`: un ambiente sin el rol recibe 0 filas, no una FK rota.
import { catalogoCompleto, type FuncionCatalogo } from '../catalogo.js';
import { ACCIONES_UNIVERSALES, ancestrosDe, ROL_CON_TODAS_LAS_ACCIONES } from './expansion.js';
import { ACCIONES_TORRE, ITEMS_TORRE_ARBOL, REPARTO_TORRE } from './acciones-torre.js';
import { lit } from './sql-arbol.js';

/**
 * Tramos que nacen DESPUÉS de la 0303 (ya aplicada), cada uno con su propia migración: el detalle (ADR-0047, 0307),
 * Productos (B3, 0308), Logística (B4, 0309) y Equipo (B5, 0310). La salida de un tramo nunca incluye los códigos de
 * otro, así que agregar uno no cambia las anteriores. Un tramo puede traer acciones cuyo ítem es de OTRO tramo (Equipo
 * cuelga de `pagina.torre_operativa`): esas van solas, después de los ítems del tramo, y el ítem no se re-siembra.
 */
const MARCA_TRAMO = {
  detalle: 'torre_detalle', productos: 'torre_productos', logistica: 'torre_logistica',
  // B5: no estrena ítem (cuelga de `pagina.torre_operativa`, de la fundación): la marca es la acción misma.
  equipo: 'torre_operativa.ver_equipo',
} as const;
export type TramoTorre = 'fundacion' | keyof typeof MARCA_TRAMO;
const tramoDe = (codigo: string): TramoTorre =>
  (Object.keys(MARCA_TRAMO) as (keyof typeof MARCA_TRAMO)[]).find((t) => codigo.includes(MARCA_TRAMO[t])) ?? 'fundacion';
const enTramo = (t: TramoTorre) => (codigo: string): boolean => tramoDe(codigo) === t;
const accionesDe = (t: TramoTorre): string[] => Object.keys(ACCIONES_TORRE).filter(enTramo(t));
const itemsDe = (t: TramoTorre): string[] => ITEMS_TORRE_ARBOL.filter(enTramo(t));

/** Los roles que crea la 0303. */
export const ROLES_NUEVOS_TORRE = ['gerencia_comercial', 'gerencia_general'] as const;

/** La acción y su cadena (acción → ítem → elemento), en ese orden. */
const cadena = (accion: string): string[] => [accion, ...ancestrosDe(accion)];

/** Siembra: los ítems (nivel 2) y sus acciones (nivel 3), padres antes que hijas. */
export function sqlSiembraTorre(catalogo: FuncionCatalogo[] = catalogoCompleto(), tramo: TramoTorre = 'fundacion'): string {
  const porCodigo = new Map(catalogo.map((f) => [f.codigo, f]));
  const ACCIONES = accionesDe(tramo);
  const items = itemsDe(tramo);
  const porOrden = (a: string, b: string): number => porCodigo.get(a)!.orden! - porCodigo.get(b)!.orden!;
  const codigos = [
    ...items.flatMap((item) => [item, ...ACCIONES.filter((a) => ancestrosDe(a)[0] === item).sort(porOrden)]),
    ...ACCIONES.filter((a) => !items.includes(ancestrosDe(a)[0]!)).sort(porOrden),
  ];
  const filas = codigos.map((c) => porCodigo.get(c)!);
  return [
    `-- ${items.length} ítems (nivel 2) y ${ACCIONES.length} acciones (nivel 3). Generado: no editar a mano.`,
    tramo === 'fundacion'
      ? '-- Regenerar con: npm run permisos:seed -w apps/api -- --arbol torre'
      : `-- Generado por \`sqlSiembraTorre(catalogo, '${tramo}')\` (\`arbol/sql-torre.ts\`).`,
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

/** Los pares (rol, función) que siembra la 0303: `admin` con todo y el reparto literal de `REPARTO_TORRE`. */
export function paresRepartoTorre(tramo: TramoTorre = 'fundacion'): [string, string][] {
  const deAdmin = [...new Set(accionesDe(tramo).flatMap(cadena))].map((fn): [string, string] => [ROL_CON_TODAS_LAS_ACCIONES, fn]);
  const otros = REPARTO_TORRE.flatMap(([rol, fns]) => fns.map((fn): [string, string] => [rol, fn]));
  if (tramo !== 'fundacion') {
    // Los elementos (menús) ya los sembró la 0303 a estos roles: el tramo solo agrega su ítem y sus acciones.
    return [...new Map([...deAdmin, ...otros].filter(([, fn]) => enTramo(tramo)(fn)).map((p) => [p.join('|'), p])).values()]
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  }
  const universales = [...new Set(ACCIONES_UNIVERSALES.flatMap((u) => cadena(u.accion)))];
  const deRolNuevo = ROLES_NUEVOS_TORRE.flatMap((rol) => universales.map((fn): [string, string] => [rol, fn]));
  return [...deAdmin, ...otros.filter(([, fn]) => enTramo('fundacion')(fn)), ...deRolNuevo]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/** Reparto: todas las acciones a `admin` y `REPARTO_TORRE` a los demás, por `JOIN permisos_roles`. */
export function sqlRepartoTorre(tramo: TramoTorre = 'fundacion'): string {
  return [
    ...(tramo === 'fundacion' ? [
      '-- `admin` recibe TODAS las acciones y su cadena (ADR-0022); financiera, auditor y las dos gerencias, su',
      '-- reparto literal (`REPARTO_TORRE`); los dos roles nuevos, además, lo universal de todo rol nuevo (Perfil y',
      '-- «Ver los manuales» de Dr. Flit, con su cadena). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.',
    ] : tramo === 'detalle' ? [
      '-- `admin` recibe las dos acciones y el ítem (ADR-0022); financiera, auditor y las dos gerencias, su reparto',
      '-- literal (`REPARTO_TORRE`: el auditor NO exporta). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.',
    ] : tramo === 'equipo' ? [
      '-- `admin` recibe la acción (ADR-0022) y gerencia_general, su reparto literal (`REPARTO_TORRE`; decisión del',
      '-- humano: nadie más ve el equipo). El ítem `pagina.torre_operativa` ya lo tienen los dos (la 0303).',
      '-- JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.',
    ] : [
      '-- `admin` recibe la acción y el ítem (ADR-0022); auditor y gerencia_general (los que ven Operativa), su reparto',
      '-- literal (`REPARTO_TORRE`). JOIN a permisos_roles: un ambiente sin el rol recibe 0 filas.',
    ]),
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)',
    'SELECT v.rol, v.fn FROM (VALUES',
    paresRepartoTorre(tramo).map(([rol, fn]) => `  (${lit(rol)}, ${lit(fn)})`).join(',\n'),
    ') AS v(rol, fn)',
    'JOIN permisos_roles r ON r.codigo = v.rol',
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
  ].join('\n');
}
