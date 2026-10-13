// HU #12873 (ADR-0025) — La EXPANSIÓN acción → operaciones: puro, sin base, testeable.
//
// El conjunto efectivo de un usuario sigue siendo `(R ∪ C) \ V` sobre las filas de siempre; lo que
// añade este módulo es que cada `accion.*` de ese conjunto aporta sus operaciones (y las páginas que
// absorbió). Una operación aún concedible (área no migrada, `nivel` NULL) sigue entrando directa.
//
//   funciones = marcados ∪ ⋃ ops(a) para a ∈ marcados ∪ {o | o exige varias acciones y están todas}
//               \ revocados            ← «revocar gana» también sobre lo que traería una acción
//
// Expansión PLANA hasta la #13429 (diseño §4.3): aquí no se exige que la página o el elemento padre
// estén marcados; el gating de ancestros llega con el resolver en cadena completa.
import { ARBOL_ITEMS_Y_ACCIONES } from '@operaciones/shared-types';
import { ACCIONES_ADMINISTRACION, PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION } from './acciones-administracion.js';
import { ACCIONES_FINANZAS, PARTIDA_DE_OPERACION_NUEVA } from './acciones-finanzas.js';
import { ACCIONES_GESTION, CONJUNCIONES_GESTION, type AccionArbol } from './acciones-gestion.js';

/**
 * HU #12873 AC8 (decisión del PO del 2026-10-13) — el rol que recibe TODAS las acciones del árbol, también
 * las que la regla «todos» no le daría. Hoy solo cambia algo en «Solicitar SOAT sin trámite»: la 0226 le
 * excluyó su grupo a `admin` hasta la #12874, que ya está en DEV. La 0233 lo marca por `JOIN permisos_roles`;
 * `repartirPorTodos` y `catalogoDeAcciones` hacen lo mismo en memoria.
 */
export const ROL_CON_TODAS_LAS_ACCIONES = 'admin';

/**
 * Todas las acciones del árbol: Gestión y Tránsito (#12873), Finanzas (#13427) y Administración, Clientes,
 * Bitácora, Tablero y Perfil (#13428); #13429 añade el legado.
 */
export const ACCIONES_ARBOL: Readonly<Record<string, AccionArbol>> = { ...ACCIONES_GESTION, ...ACCIONES_FINANZAS, ...ACCIONES_ADMINISTRACION };
export const CONJUNCIONES_ARBOL = [...CONJUNCIONES_GESTION];

/** Las áreas del árbol con su par de migraciones propio (siembra + reparto). */
export type AreaArbol = 'gestion' | 'finanzas' | 'administracion';

/** Las acciones de cada área (para generar SU migración y SU reporte en seco). */
export const ACCIONES_POR_AREA: Readonly<Record<AreaArbol, readonly string[]>> = {
  gestion: Object.keys(ACCIONES_GESTION).sort(),
  finanzas: Object.keys(ACCIONES_FINANZAS).sort(),
  administracion: Object.keys(ACCIONES_ADMINISTRACION).sort(),
};

/**
 * Las operaciones NUEVAS de todas las áreas (una guarda vieja partida, o una guarda que no existía) con su
 * código de PARTIDA: #13427 (Finanzas) y #13428 (Administración, Clientes, Perfil).
 */
export const PARTIDAS_DE_OPERACIONES_NUEVAS: Readonly<Record<string, string>> = {
  ...PARTIDA_DE_OPERACION_NUEVA, ...PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION,
};

/** HU #13428 (P-22): las acciones de reparto universal y la página de su ítem, que viaja con ellas. */
export const ACCIONES_UNIVERSALES: readonly { accion: string; pagina: string }[] = Object.entries(ACCIONES_ARBOL)
  .filter(([, a]) => a.repartoUniversal)
  .map(([accion]) => ({ accion, pagina: paginaDeAccion(accion) }))
  .sort((x, y) => x.accion.localeCompare(y.accion));

/** La página (ítem) de una acción, subiendo por el árbol de shared-types. */
function paginaDeAccion(accion: string): string {
  const padre = new Map(ARBOL_ITEMS_Y_ACCIONES.map((n) => [n.codigo, n.padre]));
  let c: string | null | undefined = padre.get(accion);
  while (c?.startsWith('accion.')) c = padre.get(c);
  if (!c?.startsWith('pagina.')) throw new Error(`La acción ${accion} no cuelga de ninguna página del árbol.`);
  return c;
}

export function esUniversal(accion: string): boolean {
  return ACCIONES_ARBOL[accion]?.repartoUniversal === true;
}

const OPS_DE = new Map<string, readonly string[]>(
  Object.entries(ACCIONES_ARBOL).map(([accion, a]) => [accion, [...a.operaciones, ...(a.apoyo ?? [])]]),
);

/** Lo que concede la acción (grupo + apoyo; nunca los opcionales). Vacío si el código no es una acción del árbol. */
export function operacionesDe(accion: string): readonly string[] {
  return OPS_DE.get(accion) ?? [];
}

/** Acciones de LECTURA (flag explícito en el mapeo): se reciben con ALGUNA operación del grupo. */
export const ACCIONES_LECTURA: ReadonlySet<string> = new Set(
  Object.entries(ACCIONES_ARBOL).filter(([, a]) => a.lectura).map(([accion]) => accion),
);

/** Operaciones OPCIONALES de alguna acción (P-9): ni grupo, ni expansión, ni absorbidas. */
export const OPCIONALES_ARBOL: ReadonlySet<string> = new Set(Object.values(ACCIONES_ARBOL).flatMap((a) => a.opcionales ?? []));

/**
 * LA regla del paso, en un solo sitio: de lectura → basta ALGUNA operación del grupo; si modifica → TODAS.
 * La usan el reparto en memoria, el catálogo del código y (en SQL) la 0233 vía `tmp_lectura_12873`.
 */
export function cumpleGrupo(accion: string, tiene: (codigo: string) => boolean): boolean {
  if (esUniversal(accion)) return true; // HU #13428 (P-22): a todos, sin grupo.
  const grupo = predecesoresDe(accion);
  return ACCIONES_LECTURA.has(accion) ? grupo.some(tiene) : grupo.every(tiene);
}

/** El grupo de la acción: lo que había que tener (todo, o algo si es de lectura) para recibirla en el paso. */
export function predecesoresDe(accion: string): readonly string[] {
  const a = ACCIONES_ARBOL[accion];
  return a?.predecesores ?? a?.operaciones ?? [];
}

/**
 * HU #13427 (§5-bis.1): un predecesor de PÁGINA que la acción no concede (`pagina.finanzas_gastos_diarios`)
 * NO se absorbe: la página sigue siendo el ítem. Una página que la acción sí concede (la compuerta, P-10 de
 * #12873) sí se absorbe.
 */
export function predecesorNoAbsorbido(accion: string, codigo: string): boolean {
  return codigo.startsWith('pagina.') && !(ACCIONES_ARBOL[accion]?.operaciones ?? []).includes(codigo);
}

/**
 * Los códigos que dejan de concederse directamente: el grupo de cada acción y las operaciones de
 * conjunción. La migración de reparto los borra de `permisos_funciones` y de las marcas; el catálogo
 * del código deja de emitirlos. Las de `apoyo` NO entran (si no son grupo de otra acción, siguen vivas).
 */
export const CODIGOS_ABSORBIDOS: ReadonlySet<string> = new Set([
  ...Object.values(ACCIONES_ARBOL).flatMap((a) => a.operaciones),
  // HU #13427: el código viejo que se parte (predecesor explícito) también deja de concederse; la página no.
  ...Object.entries(ACCIONES_ARBOL).flatMap(([accion, a]) => (a.predecesores ?? []).filter((p) => !predecesorNoAbsorbido(accion, p))),
  ...CONJUNCIONES_ARBOL.map((c) => c.operacion),
]);

/** Índice inverso: qué acciones (o conjunciones) dan una operación. Para la bitácora y `usuariosConFuncion`. */
export function codigosQueConceden(codigo: string): string[] {
  const salida = new Set<string>([codigo]);
  for (const [accion, ops] of OPS_DE) if (ops.includes(codigo)) salida.add(accion);
  for (const c of CONJUNCIONES_ARBOL) if (c.operacion === codigo) for (const a of c.acciones) salida.add(a);
  return [...salida];
}

/** Marcados (ya `(R ∪ C)` sin lo revocado) → conjunto efectivo expandido. No muta la entrada. */
export function expandir(marcados: Iterable<string>, revocados: Iterable<string> = []): Set<string> {
  const salida = new Set(marcados);
  const acciones = [...salida].filter((c) => OPS_DE.has(c));
  for (const a of acciones) for (const op of OPS_DE.get(a)!) salida.add(op);
  for (const c of CONJUNCIONES_ARBOL) {
    if (c.acciones.every((a) => salida.has(a))) salida.add(c.operacion);
  }
  for (const r of revocados) salida.delete(r);
  return salida;
}
