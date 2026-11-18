// Torre de Control (Épica #14590) — estado de la barra de filtros compartida por las páginas de la Torre.
//
// Decisión del PO (spec UX §4): los filtros viven en `sessionStorage['flito-torre-filtros']`, los leen las
// 5 páginas al montarse y NUNCA van en la URL. La placa no se guarda aquí jamás (solo vive en memoria del
// Drawer). Se borran al cerrar sesión (`limpiarFiltrosTorre`, que llama `auth.tsx`).
//
// Archivo sin dependencias de React ni de shared-types en tiempo de ejecución: `auth.tsx` lo importa y va en
// el chunk de /login (presupuesto de `check:bundle`).

export const CLAVE_FILTROS_TORRE = 'flito-torre-filtros';
/** Fila de vista del Explorador (Top N, Absoluto/%, Comparar): sin PII, también solo en sessionStorage. */
export const CLAVE_VISTA_TORRE = 'flito-torre-vista';

/** Claves de periodo: con nombre, un mes concreto (`m:YYYY-MM`) o un rango personalizado. */
export type PeriodoTorre =
  | 'hoy' | 'ayer' | 'ultimos_7' | 'mes' | 'mes_anterior' | 'ultimos_6m' | 'anio' | 'personalizado' | `m:${string}`;

/**
 * v2 (Épica #14590, RN-TOR-W1): cada filtro es una LISTA (vacía = todos). La lectura acepta además la forma escalar
 * de la v1 (`companiaId`, `organismo`, …) que pudo quedar en la pestaña; la escritura solo guarda listas.
 */
export interface FiltrosTorre {
  companiaIds: number[];
  periodo: PeriodoTorre;
  /** Solo con `periodo = 'personalizado'`. Días calendario `YYYY-MM-DD`, ambos inclusive. */
  rango: { desde: string; hasta: string } | null;
  /** Códigos DIVIPOLA de los organismos de tránsito. */
  organismos: string[];
  /** Códigos DANE de 2 dígitos. */
  departamentos: string[];
  tiposTramite: string[];
  flitEstados: string[];
}

export const FILTROS_TORRE_INICIALES: FiltrosTorre = {
  companiaIds: [], periodo: 'mes', rango: null, organismos: [], departamentos: [], tiposTramite: [], flitEstados: [],
};

/** Tope defensivo de valores por filtro (lo guardado puede venir manipulado). */
const MAX_VALORES = 200;

const esFecha = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const texto = (v: unknown, patron?: RegExp): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 60 && (!patron || patron.test(v)) ? v : null;
const idValido = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** La lista nueva (`plural`) o, si no está, el valor escalar viejo (`singular`); sin repetidos ni basura. */
function lista<T>(o: Record<string, unknown>, plural: string, singular: string, valido: (v: unknown) => T | null): T[] {
  const crudo = Array.isArray(o[plural]) ? (o[plural] as unknown[]) : o[singular] != null ? [o[singular]] : [];
  const vistos = new Set<T>();
  for (const v of crudo.slice(0, MAX_VALORES)) {
    const ok = valido(v);
    if (ok !== null) vistos.add(ok);
  }
  return [...vistos];
}

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
    companiaIds: lista(o, 'companiaIds', 'companiaId', (v) => (idValido(v) ? v : null)),
    periodo: periodo === 'personalizado' && !rango ? FILTROS_TORRE_INICIALES.periodo : periodo,
    rango: periodo === 'personalizado' ? rango : null,
    organismos: lista(o, 'organismos', 'organismo', (v) => texto(v, /^\d{5}$/)),
    departamentos: lista(o, 'departamentos', 'departamento', (v) => texto(v, /^\d{2}$/)),
    tiposTramite: lista(o, 'tiposTramite', 'tipoTramite', (v) => texto(v)),
    flitEstados: lista(o, 'flitEstados', 'flitEstado', (v) => texto(v)),
  };
}

/** Hay algo en «Más filtros» (OT, departamento, tipo o estado). */
export const hayMasFiltros = (f: FiltrosTorre): boolean =>
  f.organismos.length + f.departamentos.length + f.tiposTramite.length + f.flitEstados.length > 0;

export function leerFiltrosTorre(): FiltrosTorre {
  try {
    const crudo = sessionStorage.getItem(CLAVE_FILTROS_TORRE);
    return normalizarFiltrosTorre(crudo ? JSON.parse(crudo) : null);
  } catch {
    // sessionStorage deshabilitado o JSON roto: se arranca con los defaults.
    return { ...FILTROS_TORRE_INICIALES };
  }
}

/** Solo se escribe la forma v2 (listas): nunca las claves escalares viejas ni la placa. */
export function guardarFiltrosTorre(f: FiltrosTorre): void {
  const v2: FiltrosTorre = {
    companiaIds: f.companiaIds, periodo: f.periodo, rango: f.rango, organismos: f.organismos,
    departamentos: f.departamentos, tiposTramite: f.tiposTramite, flitEstados: f.flitEstados,
  };
  try { sessionStorage.setItem(CLAVE_FILTROS_TORRE, JSON.stringify(v2)); } catch { /* sin almacenamiento: solo memoria */ }
}

/** Cierre de sesión: los filtros de un usuario no los hereda el siguiente en la misma pestaña. */
export function limpiarFiltrosTorre(): void {
  try {
    sessionStorage.removeItem(CLAVE_FILTROS_TORRE);
    sessionStorage.removeItem(CLAVE_VISTA_TORRE);
  } catch { /* nada que barrer */ }
}
