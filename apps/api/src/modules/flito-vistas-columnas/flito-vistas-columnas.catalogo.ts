// Catálogo de columnas por tabla de vistas (ADR-0045). En CÓDIGO, no en base: la vista del sistema
// es esta lista en su orden. El servicio es genérico; solo este archivo sabe de Gestión Trámites.
//
// Reglas del catálogo:
//   · `clave` es estable: es lo que se persiste en `columnas`. No renombrar sin migración de datos.
//   · `funcion` es el permiso que desbloquea la columna. Sin `funcion`, la columna la ve quien ve la tabla.
//   · `fija` = no se puede ocultar (la columna identificadora de la fila).
//   · La columna de acciones y la casilla de selección NO van aquí: son fijas y no son datos.
//   · `pii: true` = dato personal del titular. Se registra en el log de acceso de la lectura que la proyecta
//     (AGENTS.md §16; lo hace la ruta de la tabla, no este catálogo). Decisión del humano (2026-11-18): su
//     función es `tramites.cola.ver`, sin función adicional.
import type { TablaVistasId } from '@operaciones/shared-types';

export interface ColumnaVista {
  clave: string;
  etiqueta: string;
  pii: boolean;
  funcion?: string;
  fija: boolean;
}

export interface TablaVistas {
  tablaId: TablaVistasId;
  /** Permiso para ver la tabla: la guarda de todas sus rutas (`exigirFuncion`). */
  funcionAcceso: string;
  columnas: readonly ColumnaVista[];
  /** Vista del sistema: todas las columnas, en el orden de la tabla. */
  columnasSistema: readonly string[];
}

const FUNCION_TRAMITES = 'tramites.cola.ver';

const COLUMNAS_TRAMITES: readonly ColumnaVista[] = [
  { clave: 'tramite', etiqueta: 'Trámite', pii: false, fija: true },
  { clave: 'fuente', etiqueta: 'Fuente', pii: false, fija: false },
  { clave: 'creado', etiqueta: 'Creado', pii: false, fija: false },
  { clave: 'aprobado', etiqueta: 'Aprobado', pii: false, fija: false },
  { clave: 'vehiculo', etiqueta: 'Vehículo', pii: false, fija: false },
  { clave: 'comprador', etiqueta: 'Propietario', pii: true, funcion: FUNCION_TRAMITES, fija: false },
  { clave: 'correo', etiqueta: 'Correo', pii: true, funcion: FUNCION_TRAMITES, fija: false },
  { clave: 'empresa_gestora', etiqueta: 'Empresa gestora', pii: false, fija: false },
  { clave: 'transito', etiqueta: 'Tránsito', pii: false, fija: false },
  { clave: 'ciudad', etiqueta: 'Ciudad', pii: false, fija: false },
  { clave: 'soat', etiqueta: 'SOAT', pii: false, fija: false },
  { clave: 'impuestos', etiqueta: 'Impuestos', pii: false, fija: false },
  { clave: 'logistica', etiqueta: 'Logística', pii: false, fija: false },
  { clave: 'derechos_transito', etiqueta: 'Derechos de tránsito', pii: false, fija: false },
  { clave: 'soportes', etiqueta: 'Soportes', pii: false, fija: false },
];

function tabla(tablaId: TablaVistasId, funcionAcceso: string, columnas: readonly ColumnaVista[]): TablaVistas {
  return { tablaId, funcionAcceso, columnas, columnasSistema: columnas.map((c) => c.clave) };
}

export const TABLAS_VISTAS: Readonly<Record<TablaVistasId, TablaVistas>> = {
  'flito-tramites': tabla('flito-tramites', 'tramites.cola.ver', COLUMNAS_TRAMITES),
};

/** Búsqueda segura: solo claves propias del catálogo (nada de `__proto__` ni heredadas). */
export function obtenerTablaVistas(tablaId: string): TablaVistas | undefined {
  return Object.prototype.hasOwnProperty.call(TABLAS_VISTAS, tablaId)
    ? TABLAS_VISTAS[tablaId as TablaVistasId]
    : undefined;
}

/** Funciones de columna distintas de una tabla: lo que la ruta debe preguntar al usuario. */
export function funcionesDeColumnas(tablaVistas: TablaVistas): string[] {
  const set = new Set<string>();
  for (const c of tablaVistas.columnas) if (c.funcion) set.add(c.funcion);
  return [...set];
}
