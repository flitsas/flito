// HU #12873 (ADR-0025) — La EXPANSIÓN acción → operaciones: puro, sin base, testeable.
//
// El conjunto efectivo de un usuario sigue siendo `(R ∪ C) \ V` sobre las filas de siempre; lo que
// añade este módulo es que cada `accion.*` de ese conjunto aporta sus operaciones (y las páginas que
// absorbió). Una operación aún concedible (área no migrada, `nivel` NULL) sigue entrando directa.
//
//   funciones = marcados ∪ ⋃ ops(a) para a ∈ marcados ∪ {o | o exige varias acciones y están todas}
//               \ revocados            ← «revocar gana» también sobre lo que traería una acción
//
// HU #13429 (diseño §5-quater.1) — Resolver en CADENA: un nodo cuenta si está marcado Y su padre cuenta
// (`menu.*` → `pagina.*` → `accion.*` → acción anidada). Lo efectivo es:
//   · los nodos efectivos, las operaciones de cada acción efectiva y las de cada ítem ANTIGUO efectivo;
//   · los opcionales marcados cuya acción o ítem es efectivo;
//   · las conjunciones; y al final se resta lo revocado.
// Un código marcado que no es nodo ni opcional NO entra (fallo cerrado): tras la 0240 no existe ninguno en la
// base, y el catálogo lo garantiza al arrancar.
//
// HU #13588 (P-35..P-37) — Ya no hay transversales: las 5 operaciones sueltas de P-29 se conceden con su ítem
// (`vehicles.vehiculos.consultar` con Vehículos, SOAT, Flota y Trámite Digital; las búsquedas RUNT/Fasecolda
// con Trámite Digital; `rum.resumen.ver` con Administración · Rendimiento).
import { ARBOL_ITEMS_Y_ACCIONES, ARBOL_PERMISOS } from '@operaciones/shared-types';
import { ACCIONES_ADMINISTRACION, ITEMS_ADMINISTRACION_OPS, PARTIDA_DE_OPERACION_NUEVA_ADMINISTRACION } from './acciones-administracion.js';
import { ACCIONES_FINANZAS, PARTIDA_DE_OPERACION_NUEVA } from './acciones-finanzas.js';
import { ACCIONES_GESTION, CONJUNCIONES_GESTION, type AccionArbol } from './acciones-gestion.js';
import { ACCIONES_LEGADO, ITEMS_LEGADO_OPS, OPERACIONES_INCORPORADAS_13588 } from './acciones-legado.js';

/**
 * HU #12873 AC8 (decisión del PO del 2026-10-13) — el rol que recibe TODAS las acciones del árbol, también
 * las que la regla «todos» no le daría. Hoy solo cambia algo en «Solicitar SOAT sin trámite»: la 0226 le
 * excluyó su grupo a `admin` hasta la #12874, que ya está en DEV. La 0233 lo marca por `JOIN permisos_roles`;
 * `repartirPorTodos` y `catalogoDeAcciones` hacen lo mismo en memoria.
 */
export const ROL_CON_TODAS_LAS_ACCIONES = 'admin';

/**
 * Todas las acciones del árbol: Gestión y Tránsito (#12873), Finanzas (#13427), Administración, Clientes,
 * Bitácora, Tablero y Perfil (#13428) y el «Administrar» de los ítems PESV (#13429, P-24 A1).
 */
export const ACCIONES_ARBOL: Readonly<Record<string, AccionArbol>> = { ...ACCIONES_GESTION, ...ACCIONES_FINANZAS, ...ACCIONES_ADMINISTRACION, ...ACCIONES_LEGADO };
export const CONJUNCIONES_ARBOL = [...CONJUNCIONES_GESTION];

/** Las áreas del árbol con su par de migraciones propio (siembra + reparto). */
export type AreaArbol = 'gestion' | 'finanzas' | 'administracion' | 'legado';

/** Las acciones de cada área (para generar SU migración y SU reporte en seco). */
export const ACCIONES_POR_AREA: Readonly<Record<AreaArbol, readonly string[]>> = {
  gestion: Object.keys(ACCIONES_GESTION).sort(),
  finanzas: Object.keys(ACCIONES_FINANZAS).sort(),
  administracion: Object.keys(ACCIONES_ADMINISTRACION).sort(),
  legado: Object.keys(ACCIONES_LEGADO).sort(),
};

/** HU #13429 — El padre de cada NODO del árbol (sin «Ayuda», derivada: no es un permiso). */
export const PADRE: ReadonlyMap<string, string | null> = new Map(
  ARBOL_PERMISOS.filter((n) => !n.derivado).map((n) => [n.codigo, n.padre]),
);

/** HU #13429 — Los ítems antiguos (los 46 de `legado.ts`). */
export const ITEMS_ANTIGUOS: ReadonlySet<string> = new Set(Object.keys(ITEMS_LEGADO_OPS));

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
export function paginaDeAccion(accion: string): string {
  const padre = new Map(ARBOL_ITEMS_Y_ACCIONES.map((n) => [n.codigo, n.padre]));
  let c: string | null | undefined = padre.get(accion);
  while (c?.startsWith('accion.')) c = padre.get(c);
  if (!c?.startsWith('pagina.')) throw new Error(`La acción ${accion} no cuelga de ninguna página del árbol.`);
  return c;
}

export function esUniversal(accion: string): boolean {
  return ACCIONES_ARBOL[accion]?.repartoUniversal === true;
}

/**
 * HU #13588 (P-35..P-37) — Los 5 permisos que eran sueltos (P-29), con el ítem que ahora los concede: los 4 de
 * ítems antiguos (Vehículos, SOAT, Flota, Trámite Digital) y `rum.resumen.ver` de Administración · Rendimiento.
 * Es lo que reparte la 0240 (y su reporte en seco).
 */
export const INCORPORADAS_13588: Readonly<Record<string, readonly string[]>> = {
  ...OPERACIONES_INCORPORADAS_13588,
  ...Object.fromEntries(Object.entries(ITEMS_ADMINISTRACION_OPS).map(([item, i]) => [item, i.operaciones])),
};

/** HU #13588 — Las 5 operaciones que dejaron de ser sueltas. */
export const SUELTAS_INCORPORADAS_13588: readonly string[] = [...new Set(Object.values(INCORPORADAS_13588).flat())].sort();

/** Lo que expande cada ítem sin nivel 3 (antiguo, o «Rendimiento»): lo de la #13429 más lo de la #13588. */
const OPS_DE_ITEM: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [item, i] of Object.entries(ITEMS_LEGADO_OPS)) m.set(item, [...i.operaciones]);
  for (const [item, ops] of Object.entries(INCORPORADAS_13588)) m.set(item, [...(m.get(item) ?? []), ...ops]);
  return m;
})();

const OPS_DE = new Map<string, readonly string[]>([
  ...Object.entries(ACCIONES_ARBOL).map(([accion, a]) => [accion, [...a.operaciones, ...(a.apoyo ?? [])]] as const),
  // HU #13429: un ítem antiguo efectivo expande como una acción (HU #13588: también «Rendimiento»).
  ...[...OPS_DE_ITEM].filter(([, ops]) => ops.length),
]);

/** Lo que concede la acción (grupo + apoyo; nunca los opcionales). Vacío si el código no es una acción del árbol. */
export function operacionesDe(accion: string): readonly string[] {
  return OPS_DE.get(accion) ?? [];
}

/** Acciones de LECTURA (flag explícito en el mapeo): se reciben con ALGUNA operación del grupo. */
export const ACCIONES_LECTURA: ReadonlySet<string> = new Set(
  Object.entries(ACCIONES_ARBOL).filter(([, a]) => a.lectura).map(([accion]) => accion),
);

/** HU #13429 (P-24, A1): las que se reciben con ALGUNA del grupo: las de lectura y las marcadas `alguna`. */
export const ACCIONES_POR_ALGUNA: ReadonlySet<string> = new Set(
  Object.entries(ACCIONES_ARBOL).filter(([, a]) => a.lectura || a.alguna).map(([accion]) => accion),
);

/** Operaciones OPCIONALES de alguna acción (P-9): ni grupo, ni expansión, ni absorbidas. */
export const OPCIONALES_ARBOL: ReadonlySet<string> = new Set(Object.values(ACCIONES_ARBOL).flatMap((a) => a.opcionales ?? []));

/**
 * HU #13429 — De quién cuelga cada opcional: las acciones que lo declaran (P-9) o el ítem antiguo (P-26). Basta
 * que uno sea efectivo. El primero es su `padre_codigo` en la base.
 */
export const PADRES_DE_OPCIONAL: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  const poner = (op: string, padre: string) => m.set(op, [...(m.get(op) ?? []), padre]);
  for (const n of ARBOL_ITEMS_Y_ACCIONES) for (const op of ACCIONES_ARBOL[n.codigo]?.opcionales ?? []) poner(op, n.codigo);
  for (const [item, i] of Object.entries(ITEMS_LEGADO_OPS)) for (const op of i.opcionales ?? []) poner(op, item);
  return m;
})();

/**
 * LA regla del paso, en un solo sitio: de lectura → basta ALGUNA operación del grupo; si modifica → TODAS.
 * La usan el reparto en memoria, el catálogo del código y (en SQL) la 0233 vía `tmp_lectura_12873`.
 * HU #13429: `alguna` también basta con una; `exigeItem` pide además la página del ítem.
 */
export function cumpleGrupo(accion: string, tiene: (codigo: string) => boolean): boolean {
  if (esUniversal(accion)) return true; // HU #13428 (P-22): a todos, sin grupo.
  const grupo = predecesoresDe(accion);
  const ok = ACCIONES_POR_ALGUNA.has(accion) ? grupo.some(tiene) : grupo.every(tiene);
  return ok && (!ACCIONES_ARBOL[accion]?.exigeItem || tiene(paginaDeAccion(accion)));
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
  // HU #13429: lo que expande un ítem antiguo (permanentes y transitorios) tampoco se concede ya directo.
  ...Object.values(ITEMS_LEGADO_OPS).flatMap((i) => i.operaciones),
  // HU #13588: los 5 que eran sueltos, ahora del ítem.
  ...SUELTAS_INCORPORADAS_13588,
]);

/** Índice inverso: qué acciones, ítems antiguos (o conjunciones) dan una operación. Bitácora y avisos. */
export function codigosQueConceden(codigo: string): string[] {
  const salida = new Set<string>([codigo]);
  for (const [accion, ops] of OPS_DE) if (ops.includes(codigo)) salida.add(accion);
  for (const c of CONJUNCIONES_ARBOL) if (c.operacion === codigo) for (const a of c.acciones) salida.add(a);
  return [...salida];
}

/** HU #13429 — Los ancestros de un nodo, del padre a la raíz (`[]` en un elemento o un código que no es nodo). */
export function ancestrosDe(codigo: string): string[] {
  const salida: string[] = [];
  for (let p = PADRE.get(codigo) ?? null; p; p = PADRE.get(p) ?? null) salida.push(p);
  return salida;
}

/** HU #13429 — Qué es un código para el resolutor; `null` = no entra (fallo cerrado). */
export function claseDe(codigo: string): 'nodo' | 'opcional' | null {
  if (PADRE.has(codigo)) return 'nodo';
  if (PADRES_DE_OPCIONAL.has(codigo)) return 'opcional';
  return null; // HU #13588: sin clase «transversal»; una fila directa heredada no entra (fallo cerrado).

}

/**
 * HU #13429 — Los NODOS efectivos de un conjunto marcado: `efectivo(n) = n ∈ M ∧ (padre(n) = null ∨
 * efectivo(padre(n)))`. Es la misma función para el resolutor y para el `efectivo` del panel (§5-quater.5).
 */
export function efectivoDeNodos(marcados: Iterable<string>): Set<string> {
  const m = new Set(marcados);
  const memo = new Map<string, boolean>();
  const efectivo = (n: string): boolean => {
    const ya = memo.get(n);
    if (ya !== undefined) return ya;
    const p = PADRE.get(n);
    const v = p !== undefined && m.has(n) && (p === null || efectivo(p));
    memo.set(n, v);
    return v;
  };
  return new Set([...m].filter(efectivo));
}

/** Marcados (ya `(R ∪ C)` sin lo revocado) → conjunto efectivo con la cadena y expandido. No muta la entrada. */
export function expandir(marcados: Iterable<string>, revocados: Iterable<string> = []): Set<string> {
  const m = new Set(marcados);
  const nodos = efectivoDeNodos(m);
  const salida = new Set(nodos);
  for (const c of m) {
    const clase = claseDe(c);
    if (clase === 'opcional' && PADRES_DE_OPCIONAL.get(c)!.some((p) => nodos.has(p))) salida.add(c);
  }
  for (const n of nodos) for (const op of OPS_DE.get(n) ?? []) salida.add(op);
  for (const c of CONJUNCIONES_ARBOL) {
    if (c.acciones.every((a) => salida.has(a))) salida.add(c.operacion);
  }
  for (const r of revocados) salida.delete(r);
  return salida;
}

/**
 * HU #13588 — El resolutor tal como era entre la 0239 y la 0240: las 5 sueltas eran TRANSVERSALES (marcadas →
 * efectivas, sin cadena) y ningún ítem las daba. Solo para los reportes en seco (#13429 «mañana», #13588 «hoy»).
 */
export function expandirComoEn13429(marcados: Iterable<string>, revocados: Iterable<string> = []): Set<string> {
  const m = new Set(marcados);
  const fuera = new Set(revocados);
  const salida = expandir(m, fuera);
  for (const s of SUELTAS_INCORPORADAS_13588) {
    if (m.has(s) && !fuera.has(s)) salida.add(s);
    else salida.delete(s);
  }
  return salida;
}

/**
 * La expansión PLANA de antes de la #13429 (sin cadena, sin ítems antiguos): el «hoy» del reporte en seco.
 * No la usa ningún resolutor.
 */
export function expandirSinCadena(marcados: Iterable<string>, revocados: Iterable<string> = []): Set<string> {
  const salida = new Set(marcados);
  for (const a of [...salida]) if (a.startsWith('accion.')) for (const op of OPS_DE.get(a) ?? []) salida.add(op);
  for (const c of CONJUNCIONES_ARBOL) if (c.acciones.every((a) => salida.has(a))) salida.add(c.operacion);
  for (const r of revocados) salida.delete(r);
  return salida;
}

/**
 * HU #13429 (§5-quater.5, AC8) — Las ALTERNATIVAS que conceden F, cada una con su cadena entera (el código y sus
 * ancestros, de abajo arriba): F tiene al usuario si alguna alternativa está marcada eslabón a eslabón. Un código
 * que no es nodo ni opcional no es alternativa (no entra en el resolutor).
 */
export function alternativasDe(funcion: string): string[][] {
  const salida: string[][] = [];
  for (const c of codigosQueConceden(funcion)) {
    const clase = claseDe(c);
    if (clase === 'nodo') salida.push([c, ...ancestrosDe(c)]);
    else if (clase === 'opcional') for (const p of PADRES_DE_OPCIONAL.get(c)!) salida.push([c, p, ...ancestrosDe(p)]);
  }
  return salida;
}

/**
 * HU #13429 — `nodo` del 409: el eslabón MÁS ALTO de la cadena de F que falta en `conjunto` (el que se intentó
 * guardar). Se mira la primera alternativa que es nodo del árbol (la «de casa» de F); `undefined` si está entera.
 */
export function nodoDesmarcado(funcion: string, conjunto: ReadonlySet<string>): string | undefined {
  const cadena = alternativasDe(funcion).find((a) => PADRE.has(a[0]!));
  return cadena ? [...cadena].reverse().find((c) => !conjunto.has(c)) : undefined;
}

/** HU #13429 — `nodo` del 409 del `PATCH` de usuario: el eslabón más alto de la cadena de F que la petición REVOCA. */
export function nodoRevocado(funcion: string, revocados: ReadonlySet<string>): string | undefined {
  const cadena = alternativasDe(funcion).find((a) => PADRE.has(a[0]!));
  return cadena ? [...cadena].reverse().find((c) => revocados.has(c)) : undefined;
}
