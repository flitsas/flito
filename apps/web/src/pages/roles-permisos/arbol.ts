// HU #13430 (Feature #13416, Épica #13411) — El modelo puro del árbol de permisos: elemento → ítem →
// acción (→ acción anidada / opcional). Desde la HU #13589 no hay bloque de transversales: las
// operaciones sueltas de P-29 vienen con su ítem (P-35..P-37).
//
// Diseño: `docs/ux/hu-13430-delta-contrato-arbol.md` (MANDA) y `docs/ux/hu-13430-panel-tres-niveles.md`.
// Todo se calcula sobre un `Set<string>` de códigos marcados (el borrador del rol, o el conjunto
// efectivo `(rol ∪ añadidos) \ quitados` del usuario). La estructura la da el API (#13429); aquí no se
// cablea ningún código del catálogo salvo `menu.ayuda`, que el `PUT` no debe llevar nunca.
//
// Reglas que este archivo calca:
//   · Conservación (AC2): marcar o desmarcar un padre no toca a sus hijos. Un nodo con un ancestro
//     desmarcado está INACTIVO aunque conserve su marca.
//   · P-26: los opcionales no cuentan en «k de n» ni en el parcial; un padre cuyos únicos hijos son
//     opcionales se comporta como hoja.
//   · P-31: «Marcar todo» marca ítems y acciones pero no opcionales; «Desmarcar todo» quita todo.
//   · AC3 (delta §7): `sinAcciones` = ítem FLITO marcado sin ninguna acción marcada.
//   · P-25 (delta §5): una excepción «conceder» bajo un ancestro que el usuario no tiene es «sin efecto».

import { paginaAbiertaAlEnlace, type NodoArbolDef, type TipoEnlace } from '@operaciones/shared-types';

export interface Nodo extends NodoArbolDef {
  hijos: Nodo[];
  /** `efectivo` tal como lo dio el servidor al cargar (R6: opcional con dos padres). */
  efectivoServidor?: boolean;
}

type NodoEntrada = NodoArbolDef & { hijos?: readonly NodoEntrada[]; efectivo?: boolean };

/** Ayuda no se marca nunca (derivada): el `PUT` con `menu.ayuda` daría 400. */
export const CODIGO_AYUDA = 'menu.ayuda';

/** Copia el árbol del API en la forma que pinta el panel, ordenado por `orden` entre hermanos. */
export function normalizar(nodos: readonly NodoEntrada[] | undefined): Nodo[] {
  return [...(nodos ?? [])]
    .sort((a, b) => a.orden - b.orden)
    .map((n) => ({
      codigo: n.codigo, nombre: n.nombre, tipo: n.tipo, padre: n.padre, orden: n.orden,
      descripcion: n.descripcion, slug: n.slug, legado: n.legado, derivado: n.derivado, nivel: n.nivel,
      opcional: n.opcional, efectivoServidor: n.efectivo, hijos: normalizar(n.hijos),
    }));
}

/** Los códigos que el API trae marcados (`marcado`), sin derivados. */
export function marcadosDelApi(nodos: readonly (NodoEntrada & { marcado?: boolean })[] | undefined): string[] {
  const fuera: string[] = [];
  const recorrer = (lista: readonly (NodoEntrada & { marcado?: boolean })[]) => {
    for (const n of lista) {
      if (n.marcado && !n.derivado && n.codigo !== CODIGO_AYUDA) fuera.push(n.codigo);
      recorrer((n.hijos ?? []) as readonly (NodoEntrada & { marcado?: boolean })[]);
    }
  };
  recorrer(nodos ?? []);
  return fuera;
}

export interface Indice {
  porCodigo: ReadonlyMap<string, Nodo>;
  /** Ancestros de cada código, de arriba abajo. Los elementos no tienen. */
  ancestros: ReadonlyMap<string, readonly string[]>;
}

export function indexar(arbol: readonly Nodo[]): Indice {
  const porCodigo = new Map<string, Nodo>();
  const ancestros = new Map<string, string[]>();
  const recorrer = (lista: readonly Nodo[], camino: string[]) => {
    for (const n of lista) {
      porCodigo.set(n.codigo, n);
      ancestros.set(n.codigo, camino);
      recorrer(n.hijos, [...camino, n.codigo]);
    }
  };
  recorrer(arbol, []);
  return { porCodigo, ancestros };
}

export const noOpcionales = (n: Nodo): Nodo[] => n.hijos.filter((h) => !h.opcional);
export const opcionalesDe = (n: Nodo): Nodo[] => n.hijos.filter((h) => h.opcional);

/** Todos los descendientes (en profundidad, padres antes que hijos). */
export function descendientes(n: Nodo): Nodo[] {
  return n.hijos.flatMap((h) => [h, ...descendientes(h)]);
}

/** Descendientes que cuentan: los no opcionales, bajando solo por no opcionales (P-26). */
function contables(n: Nodo): Nodo[] {
  return noOpcionales(n).flatMap((h) => [h, ...contables(h)]);
}

/** ¿Se pinta como hoja (sin «k de n» ni parcial)? Sí si no tiene hijos que cuenten. */
export const esHoja = (n: Nodo): boolean => noOpcionales(n).length === 0;

export type EstadoCasilla = 'marcada' | 'parcial' | 'desmarcada';

function completo(n: Nodo, marcados: ReadonlySet<string>): boolean {
  return marcados.has(n.codigo) && noOpcionales(n).every((h) => completo(h, marcados));
}

/** Tri-estado (ficha full «Casillas tri-estado»): parcial = marcado con algo de adentro sin marcar. */
export function estadoDe(n: Nodo, marcados: ReadonlySet<string>): EstadoCasilla {
  if (!marcados.has(n.codigo)) return 'desmarcada';
  return completo(n, marcados) ? 'marcada' : 'parcial';
}

export interface Cuenta { k: number; n: number; opcionales: number }

/** «k de n» sobre lo que cuenta, más cuántos opcionales hay marcados por debajo. */
export function cuentaDe(nodo: Nodo, marcados: ReadonlySet<string>): Cuenta {
  const c = contables(nodo);
  const opcionales = descendientes(nodo).filter((d) => d.opcional && marcados.has(d.codigo)).length;
  return { k: c.filter((d) => marcados.has(d.codigo)).length, n: c.length, opcionales };
}

/** Inactivo = algún ancestro desmarcado (la puerta de arriba manda; conservación). */
export function inactivo(codigo: string, marcados: ReadonlySet<string>, indice: Indice): boolean {
  return (indice.ancestros.get(codigo) ?? []).some((a) => !marcados.has(a));
}

/** El ancestro desmarcado más alto (el que hay que tocar), o `null`. */
export function ancestroFaltante(codigo: string, marcados: ReadonlySet<string>, indice: Indice): Nodo | null {
  const a = (indice.ancestros.get(codigo) ?? []).find((c) => !marcados.has(c));
  return a ? indice.porCodigo.get(a) ?? null : null;
}

/** El ancestro desmarcado más CERCANO: el que tiene en su panel la explicación que cubre a este nodo. */
export function ancestroDesmarcadoCercano(codigo: string, marcados: ReadonlySet<string>, indice: Indice): string | null {
  const lista = indice.ancestros.get(codigo) ?? [];
  for (let i = lista.length - 1; i >= 0; i -= 1) if (!marcados.has(lista[i])) return lista[i];
  return null;
}

/** AC3 (delta §7): ítem FLITO marcado que tiene acciones y ninguna marcada. Los opcionales no cuentan. */
export function sinAcciones(n: Nodo, marcados: ReadonlySet<string>): boolean {
  if (n.tipo !== 'item' || n.legado || !marcados.has(n.codigo)) return false;
  const acciones = descendientes(n).filter((d) => d.tipo === 'accion');
  return acciones.length > 0 && !acciones.some((a) => marcados.has(a.codigo));
}

export function itemsSinAcciones(elemento: Nodo, marcados: ReadonlySet<string>): number {
  return [elemento, ...descendientes(elemento)].filter((d) => sinAcciones(d, marcados)).length;
}

/** P-31: lo que «Marcar todo» marca — el nodo y sus descendientes, sin opcionales ni derivados. */
export function codigosMarcarTodo(nodos: readonly Nodo[]): string[] {
  return nodos.flatMap((n) => (n.derivado || n.opcional ? [] : [n.codigo, ...codigosMarcarTodo(n.hijos)]));
}

/** «Desmarcar todo» quita todo, opcionales incluidos. */
export function codigosDesmarcarTodo(nodos: readonly Nodo[]): string[] {
  return nodos.flatMap((n) => [n.codigo, ...codigosDesmarcarTodo(n.hijos)]).filter((c) => c !== CODIGO_AYUDA);
}

/** Cuántas casillas tiene el árbol entero (para la lista de roles): todo menos lo derivado. */
export function totalMarcables(arbol: readonly Nodo[]): number {
  return codigosDesmarcarTodo(arbol).length;
}

/** El conjunto que viaja en el `PUT`: todo lo marcado, inactivos incluidos, nunca `menu.ayuda`. */
export function funcionesParaGuardar(borrador: ReadonlySet<string>, indice: Indice): string[] {
  return [...borrador].filter((c) => c !== CODIGO_AYUDA && !indice.porCodigo.get(c)?.derivado).sort();
}

// ─── Modo usuario (AC4, P-25) ────────────────────────────────────────────────────────────────────

export type Efecto = 'conceder' | 'revocar';

/** `(rol ∪ añadidos) \ quitados`: lo que el usuario tendrá marcado. */
export function marcadosDelUsuario(rol: ReadonlySet<string>, excepciones: ReadonlyMap<string, Efecto>): Set<string> {
  const s = new Set(rol);
  for (const [c, e] of excepciones) { if (e === 'conceder') s.add(c); else s.delete(c); }
  return s;
}

/** Clic en una casilla del usuario: si el resultado coincide con el rol, se borra la excepción. */
export function alternarExcepcion(
  codigo: string, rol: ReadonlySet<string>, excepciones: ReadonlyMap<string, Efecto>,
): Map<string, Efecto> {
  const ahora = marcadosDelUsuario(rol, excepciones).has(codigo);
  const deseado = !ahora;
  const siguiente = new Map(excepciones);
  if (deseado === rol.has(codigo)) siguiente.delete(codigo);
  else siguiente.set(codigo, deseado ? 'conceder' : 'revocar');
  return siguiente;
}

export type Origen = 'rol' | 'no_lo_trae' | 'anadido' | 'anadido_ya_rol' | 'anadido_sin_efecto' | 'quitado';

export function origenDe(
  codigo: string, rol: ReadonlySet<string>, excepciones: ReadonlyMap<string, Efecto>, indice: Indice,
): Origen {
  const e = excepciones.get(codigo);
  if (e === 'revocar') return 'quitado';
  if (e === 'conceder') {
    if (rol.has(codigo)) return 'anadido_ya_rol';
    return inactivo(codigo, marcadosDelUsuario(rol, excepciones), indice) ? 'anadido_sin_efecto' : 'anadido';
  }
  return rol.has(codigo) ? 'rol' : 'no_lo_trae';
}

export interface ResumenExcepciones { anadidas: number; sinEfecto: number; quitadas: number }

export function resumenExcepciones(
  codigos: readonly string[], rol: ReadonlySet<string>, excepciones: ReadonlyMap<string, Efecto>, indice: Indice,
): ResumenExcepciones {
  const r = { anadidas: 0, sinEfecto: 0, quitadas: 0 };
  for (const c of codigos) {
    const o = excepciones.has(c) ? origenDe(c, rol, excepciones, indice) : null;
    if (o === 'quitado') r.quitadas += 1;
    else if (o === 'anadido_sin_efecto') { r.anadidas += 1; r.sinEfecto += 1; } else if (o) r.anadidas += 1;
  }
  return r;
}

// ─── Copy (exportado para que el spec E2E lea el mismo literal) ──────────────────────────────────

export const COPY_AYUDA_DERIVADA = 'Ayuda no se marca: cada usuario la ve sola, con los capítulos de lo que puede usar.';
export const COPY_ITEM_ANTIGUO = 'Este ítem no se divide en acciones: marcarlo da acceso a todo lo de la pantalla.';
export const COPY_ITEM_ANTIGUO_OPCIONALES = 'Marcarlo da acceso a todo lo de la pantalla, menos lo opcional que se marca aparte.';

export const rotuloOpcional = (padre: string) => `Opcional: no viene con ${padre}, se marca aparte`;

/** Primera línea del panel de un elemento cuyos ítems son todos antiguos (delta §4). */
export function explicacionElementoAntiguo(elemento: Nodo): string | null {
  const items = elemento.hijos.filter((h) => h.tipo === 'item');
  if (items.length === 0 || !items.every((i) => i.legado)) return null;
  if (items.some((i) => noOpcionales(i).length > 0)) {
    return `En ${elemento.nombre}, marcar un ítem da su pantalla. Donde aparece «Administrar», hace falta marcarla para crear y editar los registros de esa pantalla.`;
  }
  return `Los ítems de ${elemento.nombre} no se dividen en acciones: marcar un ítem da acceso a todo lo de la pantalla.`;
}

/** La frase bajo un ítem antiguo (delta §4); `null` si la dice el elemento o si tiene «Administrar». */
export function explicacionItemAntiguo(item: Nodo, padre: Nodo | undefined): string | null {
  if (item.tipo !== 'item' || !item.legado) return null;
  if (item.hijos.length === 0) return padre && explicacionElementoAntiguo(padre) ? null : COPY_ITEM_ANTIGUO;
  return esHoja(item) ? COPY_ITEM_ANTIGUO_OPCIONALES : null;
}

export function avisoSinAcciones(item: string, modo: 'rol' | 'usuario'): string {
  return modo === 'rol'
    ? `Marcado sin ninguna acción: quien tenga este rol verá ${item} en el menú, pero no tendrá ninguna acción dentro. Marca al menos una acción o desmarca el ítem.`
    : `Marcado sin ninguna acción: este usuario verá ${item} en el menú, pero no tendrá ninguna acción dentro.`;
}

export function explicacionDesmarcado(nombre: string, modo: 'rol' | 'usuario'): string {
  return modo === 'rol'
    ? `${nombre} está desmarcado: lo de adentro no aplica, pero sus marcas se conservan para cuando lo vuelvas a marcar.`
    : `${nombre} no aplica a este usuario: lo de adentro se conserva, pero no tendrá acceso mientras ${nombre} esté desmarcado.`;
}

export const fraseSinEfecto = (ancestro: string) =>
  `No tiene efecto: a este usuario le falta «${ancestro}». Añádeselo también para que valga.`;

const plural = (n: number, uno: string, varios: string) => (n === 1 ? `1 ${uno}` : `${n} ${varios}`);

/** «4 de 6 · 1 opcional» / «1 opcional» (hoja con opcionales) / «Inactivo · conserva 2 de 3». */
export function textoCuenta(c: Cuenta, hoja: boolean, desmarcado: boolean): string {
  const partes: string[] = [];
  if (!hoja) partes.push(desmarcado && c.k > 0 ? `Inactivo · conserva ${c.k} de ${c.n}` : `${c.k} de ${c.n}`);
  if (c.opcionales > 0) partes.push(plural(c.opcionales, 'opcional', 'opcionales'));
  return partes.join(' · ');
}

export const sufijoSinAcciones = (n: number) => (n > 0 ? plural(n, 'ítem sin acciones', 'ítems sin acciones') : '');

export function textoExcepciones(r: ResumenExcepciones): string {
  const total = r.anadidas + r.quitadas;
  if (total === 0) return '';
  const sinEfecto = r.sinEfecto > 0 ? ` (${r.sinEfecto} sin efecto)` : '';
  return `${plural(total, 'excepción', 'excepciones')}${sinEfecto}`;
}

/** Cabecera del bloque del usuario (delta §5). */
export function resumenUsuario(rol: string, r: ResumenExcepciones): string {
  const total = r.anadidas + r.quitadas;
  if (total === 0) return `Lo que trae del rol ${rol}, sin excepciones.`;
  const partes: string[] = [];
  if (r.anadidas > 0) partes.push(`${plural(r.anadidas, 'añadida', 'añadidas')}${r.sinEfecto > 0 ? ` (${r.sinEfecto} sin efecto)` : ''}`);
  if (r.quitadas > 0) partes.push(plural(r.quitadas, 'quitada', 'quitadas'));
  return `Lo que trae del rol ${rol}, con ${plural(total, 'excepción', 'excepciones')}: ${partes.join(' y ')}.`;
}

// ─── 409 anti-bloqueo (AC5, delta §6) ────────────────────────────────────────────────────────────

const INICIO_409 = 'No se guardó: con este cambio FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos.';
const FIN_409 = 'Tus cambios siguen aquí, sin guardar.';

export interface Aviso409 { texto: string; nodo: string | null }

/** Resuelve el nombre: `nodo` → `funcion` → sin nombre (y sin «Mostrar dónde está»). */
export function aviso409(cuerpo: { nodo?: string; funcion?: string }, indice: Indice, modo: 'rol' | 'usuario'): Aviso409 {
  const codigo = [cuerpo.nodo, cuerpo.funcion].find((c) => c && indice.porCodigo.has(c)) ?? null;
  const nombre = codigo ? indice.porCodigo.get(codigo)?.nombre : null;
  if (!codigo || !nombre) {
    const donde = modo === 'rol' ? 'en este rol' : 'a este usuario';
    return { texto: `${INICIO_409} Revisa Administración, Usuarios y Roles y permisos ${donde} antes de guardar. ${FIN_409}`, nodo: null };
  }
  const medio = modo === 'rol'
    ? `Deja marcado «${nombre}» en este rol o dáselo antes a otro rol con usuarios activos.`
    : `Deja «${nombre}» a este usuario o dáselo antes a otro usuario activo.`;
  return { texto: `${INICIO_409} ${medio} ${FIN_409}`, nodo: codigo };
}

/**
 * HU #13452 — Los nodos del árbol que el ENLACE del rol cierra (`FRONTERA_POR_ENLACE`): cada ítem cuya
 * pantalla no es de un módulo abierto a ese enlace, y todo lo que cuelga de él. Valor = el código del
 * ítem que lo cierra (el que lleva la nota). Vacío con enlace `ninguno`: sin enlace nada cambia.
 */
export function cerradosPorEnlace(arbol: readonly Nodo[], enlace: TipoEnlace): Map<string, string> {
  const cerrados = new Map<string, string>();
  if (enlace === 'ninguno') return cerrados;
  const visitar = (n: Nodo) => {
    if (n.tipo === 'item' && n.slug && !paginaAbiertaAlEnlace(n.slug, enlace)) {
      cerrados.set(n.codigo, n.codigo);
      for (const d of descendientes(n)) cerrados.set(d.codigo, n.codigo);
      return;
    }
    n.hijos.forEach(visitar);
  };
  arbol.forEach(visitar);
  return cerrados;
}
