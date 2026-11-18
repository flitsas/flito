// Reglas puras de vistas de columnas (ADR-0043). Sin base de datos: se prueban sin servidor.
//
// RN-VC1  Resolución de la vista activa: puntero personal → puntero general → vista del sistema.
//         Un puntero a `NULL` es «sistema explícito» y gana sobre la general (es «Restablecer»).
// RN-VC2  Proyección por permiso: columnasEfectivas = vista ∩ columnasPermitidas. La vista guarda también
//         lo que el usuario hoy no ve; el filtro se aplica al LEER, nunca se confía al cliente.
// RN-VC3  Al guardar, una clave que el usuario no puede ver se RECHAZA (no se descarta en silencio).
// RN-VC4  Las columnas fijas (`fija: true`) siempre se muestran, primero, en el orden del catálogo.
import type { ColumnaVista } from './flito-vistas-columnas.catalogo.js';

export const MAX_COLUMNAS_POR_VISTA = 30;
export const MAX_VISTAS_PERSONALES = 20;

export function columnaPermitida(c: ColumnaVista, permitidas: ReadonlySet<string>): boolean {
  return !c.funcion || permitidas.has(c.funcion);
}

/** RN-VC2 + RN-VC4: fijas primero (orden del catálogo), luego la vista en su orden, sin duplicados. */
export function columnasEfectivas(
  claves: readonly string[],
  columnas: readonly ColumnaVista[],
  permitidas: ReadonlySet<string>,
): string[] {
  const porClave = new Map(columnas.map((c) => [c.clave, c]));
  const fijas = columnas.filter((c) => c.fija && columnaPermitida(c, permitidas)).map((c) => c.clave);
  const elegidas = [...new Set(claves)].filter((k) => {
    const c = porClave.get(k);
    return c !== undefined && !c.fija && columnaPermitida(c, permitidas);
  });
  return [...fijas, ...elegidas];
}

/** RN-VC3: separa lo que no existe en el catálogo de lo que existe pero el usuario no puede ver. */
export function clavesRechazadas(
  claves: readonly string[],
  columnas: readonly ColumnaVista[],
  permitidas: ReadonlySet<string>,
): { desconocidas: string[]; noPermitidas: string[] } {
  const porClave = new Map(columnas.map((c) => [c.clave, c]));
  const desconocidas: string[] = [];
  const noPermitidas: string[] = [];
  for (const k of claves) {
    const c = porClave.get(k);
    if (!c) desconocidas.push(k);
    else if (!columnaPermitida(c, permitidas)) noPermitidas.push(k);
  }
  return { desconocidas, noPermitidas };
}

export type OrigenResuelto = 'personal' | 'general' | 'sistema';

export interface PunteroVista {
  vistaId: number | null;
}

/**
 * RN-VC1. `idsPersonales` / `idsCompartidas` son las vistas que el usuario PUEDE ver; un puntero a una
 * vista fuera de su alcance no se usa (cae al siguiente nivel). Un puntero personal que apunta a una
 * compartida tampoco cuenta: el alcance se respeta aunque la base lo permitiera.
 */
export function resolverVistaActiva(
  personal: PunteroVista | undefined,
  general: PunteroVista | undefined,
  idsPersonales: ReadonlySet<number>,
  idsCompartidas: ReadonlySet<number>,
): { origen: OrigenResuelto; vistaId: number | null } {
  if (personal) {
    if (personal.vistaId === null) return { origen: 'sistema', vistaId: null };
    if (idsPersonales.has(personal.vistaId)) return { origen: 'personal', vistaId: personal.vistaId };
  }
  if (general) {
    if (general.vistaId === null) return { origen: 'sistema', vistaId: null };
    if (idsCompartidas.has(general.vistaId)) return { origen: 'general', vistaId: general.vistaId };
  }
  return { origen: 'sistema', vistaId: null };
}
