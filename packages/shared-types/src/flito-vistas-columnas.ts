// Vistas de columnas persistidas (ADR-0045). Contrato compartido entre `apps/api` y `apps/web`.
// Las vistas guardan CLAVES de columna, nunca valores de datos del titular.

/** Tablas que admiten vistas de columnas. Cada una tiene su catálogo en `apps/api` (código). */
export const TABLAS_VISTAS_IDS = ['flito-tramites'] as const;
export type TablaVistasId = (typeof TABLAS_VISTAS_IDS)[number];

export type AlcanceVista = 'personal' | 'compartida';

/** De dónde sale la vista activa: punteros personal → general → vista del sistema (ADR-0045). */
export type OrigenVista = 'personal' | 'general' | 'sistema';

export interface ColumnaDisponible {
  clave: string;
  etiqueta: string;
  fija: boolean;
}

export interface VistaColumnas {
  id: number;
  nombre: string;
  alcance: AlcanceVista;
  esPredeterminada: boolean;
  puedeEditar: boolean;
  version: number;
  /**
   * Columnas EFECTIVAS de esta vista para el usuario que consulta: la vista ∩ lo que puede ver, fijas
   * primero, mismo orden que `vistaActiva.columnas`. Así el cliente puede aplicar una vista sin
   * guardarla (la decisión «cambiar sin guardar solo dura la sesión») sin fijar el puntero.
   */
  columnas: string[];
}

export interface VistaActiva {
  /** Id de la vista guardada, o `null` cuando rige la vista del sistema. */
  id: number | null;
  origen: OrigenVista;
  /** Columnas efectivas: la vista ∩ lo que el usuario puede ver. */
  columnas: string[];
}

export interface RespuestaVistasColumnas {
  tablaId: TablaVistasId;
  /** Solo las columnas que el usuario puede ver. */
  columnasDisponibles: ColumnaDisponible[];
  vistaActiva: VistaActiva;
  sistema: { columnas: string[] };
  vistas: VistaColumnas[];
  limites: LimitesVistasColumnas;
}

export interface LimitesVistasColumnas {
  columnasPorVista: number;
  vistasPersonales: number;
}

/** Límites ADR-0045 (decisión del humano, 2026-11-18). */
export const LIMITES_VISTAS_COLUMNAS: LimitesVistasColumnas = {
  columnasPorVista: 30,
  vistasPersonales: 20,
};

/** Códigos de error de la API de vistas de columnas (cuerpo `{ error, codigo }`). */
export const CODIGOS_VISTAS_COLUMNAS = [
  'TABLA_NO_ENCONTRADA',
  'VISTA_NO_ENCONTRADA',
  'COLUMNA_NO_PERMITIDA',
  'CLAVE_DESCONOCIDA',
  'ALCANCE_NO_PERMITIDO',
  'NOMBRE_DUPLICADO',
  'LIMITE_VISTAS',
  'VERSION_CONFLICTO',
  'VISTA_NO_COMPARTIDA',
] as const;
export type CodigoVistasColumnas = (typeof CODIGOS_VISTAS_COLUMNAS)[number];
