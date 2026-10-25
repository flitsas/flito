// HU #13429 (Feature #13416 F3, diseño §5-quater.5) — El árbol de permisos para el panel de #13430: la estructura
// (`GET /api/permisos/arbol`), el árbol de un rol con sus marcas y el de un usuario con herencia y excepciones.
//
// `marcado` = el código está en las filas (rol) o en `(R ∪ C) \ V` (usuario); `efectivo` = la cadena entera, con
// la MISMA función del resolutor (`efectivoDeNodos`), no con otra. `sinAcciones` (AC6) = ítem FLITO marcado sin
// ninguna acción marcada debajo (sobre `marcado`, no sobre `efectivo`: el panel lo pinta aunque el elemento esté
// desmarcado); un ítem antiguo nunca. Los opcionales cuelgan de su acción o ítem (`tipo: 'operacion'`,
// `opcional: true`). «Ayuda» viaja `derivado`, sin marca.
//
// HU #13588 (P-35..P-37): ya no hay permisos sueltos fuera del menú. HU #13589: la respuesta ya no trae el
// campo `transversales` (retirado de shared-types junto con el bloque del panel).
// Sin PII: del usuario solo el id y el código de su rol.
import { eq } from 'drizzle-orm';
import {
  ARBOL_PERMISOS, type NodoArbolDef, type NodoArbolRol, type NodoArbolUsuario,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { permisosRoles, permisosRolFuncion, permisosUsuarioFuncion, users } from '../../db/schema.js';
import { catalogoCompleto } from './catalogo.js';
import { efectivoDeNodos, PADRES_DE_OPCIONAL } from './arbol/expansion.js';
import { RolNoEncontradoError } from './permisos-roles.service.js';

export class UsuarioNoEncontradoError extends Error {
  constructor() { super('No existe el usuario'); this.name = 'UsuarioNoEncontradoError'; }
}

let estructura: { arbol: NodoArbolDef[] } | null = null;

/** La estructura, una vez por proceso: nodos del menú y opcionales colgados (sin transversales, HU #13588/#13589). */
export function arbolDef(): { arbol: NodoArbolDef[] } {
  if (estructura) return estructura;
  const nombres = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
  const nodos: NodoArbolDef[] = ARBOL_PERMISOS.map((n) => ({ ...n }));
  const orden = new Map<string, number>();
  for (const [op, padres] of [...PADRES_DE_OPCIONAL].sort(([a], [b]) => a.localeCompare(b))) {
    const padre = padres[0]!;
    const f = nombres.get(op);
    const o = (orden.get(padre) ?? 1000) + 10;
    orden.set(padre, o);
    nodos.push({ codigo: op, nombre: f?.nombreNegocio ?? op, descripcion: f?.descripcion, tipo: 'operacion', padre, orden: o, opcional: true });
  }
  const nivel = new Map<string, number>();
  const porCodigo = new Map(nodos.map((n) => [n.codigo, n]));
  const nivelDe = (n: NodoArbolDef): number => {
    const ya = nivel.get(n.codigo);
    if (ya) return ya;
    const v = n.padre ? nivelDe(porCodigo.get(n.padre)!) + 1 : 1;
    nivel.set(n.codigo, v);
    return v;
  };
  // HU #13944: `exclusivaAdmin` sale del catálogo del código (`FUNCIONES_EXCLUSIVAS_ADMIN`), que el arranque ya
  // comparó con la columna: el panel la pinta bloqueada; el 409 del servicio es la red de seguridad.
  estructura = { arbol: nodos.map((n) => ({ ...n, nivel: nivelDe(n), exclusivaAdmin: nombres.get(n.codigo)?.exclusivaAdmin === true })) };
  return estructura;
}

interface Marcas { marcado: (c: string) => boolean; efectivo: (n: NodoArbolDef) => boolean }

/** Marcas y efectividad de cada nodo sobre un conjunto marcado `M` (rol: sus filas; usuario: `(R ∪ C) \ V`). */
function marcasDe(m: ReadonlySet<string>): Marcas {
  const nodos = efectivoDeNodos(m);
  return {
    marcado: (c) => m.has(c),
    efectivo: (n) => {
      if (n.derivado) return false;
      if (n.opcional) return m.has(n.codigo) && PADRES_DE_OPCIONAL.get(n.codigo)!.some((p) => nodos.has(p));
      return nodos.has(n.codigo);
    },
  };
}

type ConMarcas = Omit<NodoArbolRol, 'hijos'>;

function anidar<T extends ConMarcas & { hijos: T[] }>(planos: T[]): T[] {
  const porCodigo = new Map(planos.map((n) => [n.codigo, n]));
  const raices: T[] = [];
  for (const n of planos) (n.padre && porCodigo.get(n.padre) ? porCodigo.get(n.padre)!.hijos : raices).push(n);
  const ordenar = (xs: T[]) => { xs.sort((a, b) => a.orden - b.orden || a.codigo.localeCompare(b.codigo)); for (const x of xs) ordenar(x.hijos); };
  ordenar(raices);
  return raices;
}

/**
 * `sinAcciones` (AC6): ítem FLITO marcado sin ninguna acción marcada debajo. Un ítem que no tiene acciones en el
 * árbol («Rendimiento», HU #13588: concede su operación él mismo) nunca.
 */
function sinAcciones(n: NodoArbolDef, marcas: Marcas, arbol: NodoArbolDef[]): boolean {
  if (n.tipo !== 'item' || n.legado || !marcas.marcado(n.codigo)) return false;
  if (!arbol.some((h) => h.padre === n.codigo && h.tipo === 'accion')) return false;
  const debajo = (padre: string): boolean => arbol.some((h) => h.padre === padre && h.tipo === 'accion' && (marcas.marcado(h.codigo) || debajo(h.codigo)));
  return !debajo(n.codigo);
}

function conMarcas(n: NodoArbolDef, marcas: Marcas, arbol: NodoArbolDef[]): ConMarcas {
  return { ...n, marcado: !n.derivado && marcas.marcado(n.codigo), efectivo: marcas.efectivo(n), sinAcciones: sinAcciones(n, marcas, arbol) };
}

/** `GET /roles/:codigo/arbol`. */
export async function arbolDeRol(codigo: string) {
  const [rol] = await db.select({ codigo: permisosRoles.codigo, nombre: permisosRoles.nombre, tipoEnlace: permisosRoles.tipoEnlace })
    .from(permisosRoles).where(eq(permisosRoles.codigo, codigo)).limit(1);
  if (!rol) throw new RolNoEncontradoError(codigo);
  const filas = await db.select({ codigo: permisosRolFuncion.funcionCodigo }).from(permisosRolFuncion)
    .where(eq(permisosRolFuncion.rolCodigo, codigo));
  const marcas = marcasDe(new Set(filas.map((f) => f.codigo)));
  const { arbol } = arbolDef();
  const aRol = (n: NodoArbolDef): NodoArbolRol => ({ ...conMarcas(n, marcas, arbol), hijos: [] });
  return { rol, arbol: anidar(arbol.map(aRol)) };
}

/** `GET /usuarios/:id/arbol`: `heredado` = lo marca su rol; `excepcion` = su fila propia, si la hay. */
export async function arbolDeUsuario(userId: number) {
  const [u] = await db.select({ rol: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new UsuarioNoEncontradoError();
  const delRol = await db.select({ codigo: permisosRolFuncion.funcionCodigo }).from(permisosRolFuncion)
    .where(eq(permisosRolFuncion.rolCodigo, u.rol));
  const propias = await db.select({ codigo: permisosUsuarioFuncion.funcionCodigo, efecto: permisosUsuarioFuncion.efecto })
    .from(permisosUsuarioFuncion).where(eq(permisosUsuarioFuncion.userId, userId));
  const heredadas = new Set(delRol.map((f) => f.codigo));
  const excepcion = new Map(propias.map((p) => [p.codigo, p.efecto === 'revocar' ? 'revocar' as const : 'conceder' as const]));
  const m = new Set(heredadas);
  for (const [c, e] of excepcion) if (e === 'conceder') m.add(c);
  for (const [c, e] of excepcion) if (e === 'revocar') m.delete(c);
  const marcas = marcasDe(m);
  const { arbol } = arbolDef();
  const aUsuario = (n: NodoArbolDef): NodoArbolUsuario => ({
    ...conMarcas(n, marcas, arbol), heredado: heredadas.has(n.codigo), excepcion: excepcion.get(n.codigo) ?? null, hijos: [],
  });
  return { userId, rol: u.rol, arbol: anidar(arbol.map(aUsuario)) };
}
