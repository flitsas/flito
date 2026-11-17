// Torre de Control (Épica #14590) — estado de la barra de filtros compartida por las páginas de la Torre.
//
// Decisión del PO (spec UX §4): los filtros viven en `sessionStorage['flito-torre-filtros']`, los leen las
// 5 páginas al montarse y NUNCA van en la URL. La placa no se guarda aquí jamás (solo vive en memoria del
// Drawer). Se borran al cerrar sesión (`limpiarFiltrosTorre`, que llama `auth.tsx`).
//
// Archivo sin dependencias de React ni de shared-types en tiempo de ejecución: `auth.tsx` lo importa y va en
// el chunk de /login (presupuesto de `check:bundle`).

export const CLAVE_FILTROS_TORRE = 'flito-torre-filtros';

/** Claves de periodo: con nombre, un mes concreto (`m:YYYY-MM`) o un rango personalizado. */
export type PeriodoTorre =
  | 'hoy' | 'ayer' | 'ultimos_7' | 'mes' | 'mes_anterior' | 'ultimos_6m' | 'anio' | 'personalizado' | `m:${string}`;

export interface FiltrosTorre {
  companiaId: number | null;
  periodo: PeriodoTorre;
  /** Solo con `periodo = 'personalizado'`. Días calendario `YYYY-MM-DD`, ambos inclusive. */
  rango: { desde: string; hasta: string } | null;
  /** Código DIVIPOLA del organismo de tránsito. */
  organismo: string | null;
  /** Código DANE de 2 dígitos. */
  departamento: string | null;
  tipoTramite: string | null;
  flitEstado: string | null;
}

export const FILTROS_TORRE_INICIALES: FiltrosTorre = {
  companiaId: null, periodo: 'mes', rango: null, organismo: null, departamento: null, tipoTramite: null, flitEstado: null,
};

const esFecha = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const texto = (v: unknown, patron?: RegExp): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 60 && (!patron || patron.test(v)) ? v : null;

const PERIODOS_FIJOS = new Set(['hoy', 'ayer', 'ultimos_7', 'mes', 'mes_anterior', 'ultimos_6m', 'anio', 'personalizado']);

/** Lo guardado puede venir de otra versión o manipulado: se valida campo a campo y lo dudoso cae al default. */
export function normalizarFiltrosTorre(crudo: unknown): FiltrosTorre {
  if (!crudo || typeof crudo !== 'object') return { ...FILTROS_TORRE_INICIALES };
  const o = crudo as Record<string, unknown>;
  const periodo = typeof o.periodo === 'string' && (PERIODOS_FIJOS.has(o.periodo) || /^m:\d{4}-\d{2}$/.test(o.periodo))
    ? (o.periodo as PeriodoTorre) : FILTROS_TORRE_INICIALES.periodo;
  const r = o.rango as Record<string, unknown> | null | undefined;
  const rango = r && esFecha(r.desde) && esFecha(r.hasta) && r.desde <= r.hasta ? { desde: r.desde, hasta: r.hasta } : null;
  return {
    companiaId: typeof o.companiaId === 'number' && Number.isInteger(o.companiaId) && o.companiaId > 0 ? o.companiaId : null,
    periodo: periodo === 'personalizado' && !rango ? FILTROS_TORRE_INICIALES.periodo : periodo,
    rango: periodo === 'personalizado' ? rango : null,
    organismo: texto(o.organismo, /^\d{5}$/),
    departamento: texto(o.departamento, /^\d{2}$/),
    tipoTramite: texto(o.tipoTramite),
    flitEstado: texto(o.flitEstado),
  };
}

export function leerFiltrosTorre(): FiltrosTorre {
  try {
    const crudo = sessionStorage.getItem(CLAVE_FILTROS_TORRE);
    return normalizarFiltrosTorre(crudo ? JSON.parse(crudo) : null);
  } catch {
    // sessionStorage deshabilitado o JSON roto: se arranca con los defaults.
    return { ...FILTROS_TORRE_INICIALES };
  }
}

export function guardarFiltrosTorre(f: FiltrosTorre): void {
  try { sessionStorage.setItem(CLAVE_FILTROS_TORRE, JSON.stringify(f)); } catch { /* sin almacenamiento: solo memoria */ }
}

/** Cierre de sesión: los filtros de un usuario no los hereda el siguiente en la misma pestaña. */
export function limpiarFiltrosTorre(): void {
  try { sessionStorage.removeItem(CLAVE_FILTROS_TORRE); } catch { /* nada que barrer */ }
}
