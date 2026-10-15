// HU #13430 — Árboles de permisos para mockear `GET /api/permisos/roles/:codigo/arbol` y
// `GET /api/users/:id/arbol` (contrato de la #13429) a partir de una definición corta y un conjunto de
// marcas. Calcula `marcado`, `efectivo` (la cadena entera), `sinAcciones` y `nivel` como el servidor,
// para que el spec certifique la PANTALLA y no un mock que ya trae la respuesta pintada.
import type { NodoArbolRol, NodoArbolUsuario, TipoNodoPermiso } from '@operaciones/shared-types';

export interface NodoDef {
  codigo: string;
  nombre: string;
  tipo: TipoNodoPermiso;
  descripcion?: string;
  legado?: boolean;
  derivado?: boolean;
  opcional?: boolean;
  hijos?: NodoDef[];
}

export const elemento = (clave: string, nombre: string, hijos: NodoDef[] = [], extra: Partial<NodoDef> = {}): NodoDef =>
  ({ codigo: `menu.${clave}`, nombre, tipo: 'elemento', hijos, ...extra });
export const item = (slug: string, nombre: string, hijos: NodoDef[] = [], extra: Partial<NodoDef> = {}): NodoDef =>
  ({ codigo: `pagina.${slug}`, nombre, tipo: 'item', hijos, ...extra });
export const accion = (codigo: string, nombre: string, hijos: NodoDef[] = [], descripcion?: string): NodoDef =>
  ({ codigo, nombre, tipo: 'accion', hijos, ...(descripcion ? { descripcion } : {}) });
export const opcional = (codigo: string, nombre: string): NodoDef => ({ codigo, nombre, tipo: 'operacion', opcional: true });

/** Todos los códigos marcables (sin derivados), padres antes que hijos. */
export function codigosDe(defs: readonly NodoDef[]): string[] {
  return defs.flatMap((d) => [...(d.derivado ? [] : [d.codigo]), ...codigosDe(d.hijos ?? [])]);
}

function descendientes(d: NodoDef): NodoDef[] {
  return (d.hijos ?? []).flatMap((h) => [h, ...descendientes(h)]);
}

export function arbolRol(defs: readonly NodoDef[], marcas: ReadonlySet<string>, cadena = true, padre: string | null = null, nivel = 1): NodoArbolRol[] {
  return defs.map((d, i) => {
    const marcado = !d.derivado && marcas.has(d.codigo);
    const acciones = descendientes(d).filter((x) => x.tipo === 'accion');
    return {
      codigo: d.codigo, nombre: d.nombre, tipo: d.tipo, padre, orden: (i + 1) * 10, nivel,
      ...(d.descripcion ? { descripcion: d.descripcion } : {}),
      ...(d.legado ? { legado: true } : {}), ...(d.derivado ? { derivado: true } : {}), ...(d.opcional ? { opcional: true } : {}),
      marcado,
      efectivo: marcado && cadena,
      sinAcciones: d.tipo === 'item' && !d.legado && marcado && acciones.length > 0 && !acciones.some((a) => marcas.has(a.codigo)),
      hijos: arbolRol(d.hijos ?? [], marcas, cadena && marcado, d.codigo, nivel + 1),
    };
  });
}

export function arbolUsuario(
  defs: readonly NodoDef[], rol: ReadonlySet<string>, excepciones: ReadonlyMap<string, 'conceder' | 'revocar'>,
): NodoArbolUsuario[] {
  const efectivos = new Set(rol);
  for (const [c, e] of excepciones) { if (e === 'conceder') efectivos.add(c); else efectivos.delete(c); }
  const pasar = (nodos: NodoArbolRol[]): NodoArbolUsuario[] => nodos.map((n) => ({
    ...n, heredado: rol.has(n.codigo), excepcion: excepciones.get(n.codigo) ?? null, hijos: pasar(n.hijos),
  }));
  return pasar(arbolRol(defs, efectivos));
}
