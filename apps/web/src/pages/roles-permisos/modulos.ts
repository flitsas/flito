// HU #12085 (Feature #12072) — Roles y permisos: etiquetas y copy que la pantalla comparte.
//
// `GET /api/permisos/funciones` agrupa por CLAVE de módulo (`flito_soat_e_impuestos`), no por
// etiqueta. Aquí vive el mapa clave → etiqueta legible; lo que no esté en el mapa cae a la clave
// capitalizada y sin `_`, para que un módulo nuevo del catálogo se vea antes de que alguien lo
// bautice aquí. Ningún número del catálogo se cablea: la pantalla cuenta lo que llega (ficha §2).

import type { TipoEnlace, TipoPrincipalRol } from '@operaciones/shared-types';
import type { GrupoDeFunciones } from '../../lib/api';

const ETIQUETAS_MODULO: Record<string, string> = {
  administracion: 'Administración',
  bitacora: 'Bitácora',
  bolsas: 'Bolsas',
  comparendos: 'Comparendos',
  compuerta: 'Compuerta de entrega',
  conciliacion: 'Conciliación',
  cumplimiento_laft: 'Cumplimiento (LAFT)',
  derechos: 'Derechos de tránsito',
  finanzas: 'Finanzas',
  flito_soat_e_impuestos: 'FLITO (SOAT e Impuestos)',
  flota: 'Flota',
  general: 'General',
  impuestos: 'Impuestos',
  liquidacion: 'Liquidación',
  logistica: 'Logística',
  mantenimiento: 'Mantenimiento',
  operaciones: 'Operaciones',
  parametrizacion: 'Parametrización',
  permisos: 'Roles y permisos',
  pesv: 'PESV',
  privacidad: 'Privacidad y datos',
  revisiones: 'Revisiones OCR',
  rndc: 'RNDC',
  soat: 'SOAT',
  sync: 'Sincronización',
  tablero: 'Tablero',
  tramite: 'Trámite digital',
  tramites: 'Gestión de trámites',
  transito: 'Tránsito',
  usuarios: 'Usuarios',
};

export function etiquetaModulo(clave: string): string {
  const conocida = ETIQUETAS_MODULO[clave];
  if (conocida) return conocida;
  const limpia = clave.replace(/_/g, ' ').trim();
  return limpia ? limpia.charAt(0).toUpperCase() + limpia.slice(1) : clave;
}

/**
 * Los módulos con al menos una función, ordenados por su etiqueta. El vacío D de la ficha (§6.4):
 * un módulo que llega sin filas no se pinta, porque un acordeón vacío es un rectángulo que
 * promete algo.
 */
export function modulosVisibles(grupos: GrupoDeFunciones[]): GrupoDeFunciones[] {
  return grupos
    .filter((g) => g.funciones.length > 0)
    .map((g) => ({ ...g, etiqueta: etiquetaModulo(g.modulo) }))
    .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'))
    .map(({ etiqueta: _e, ...g }) => g);
}

// HU #12533 — Tres secciones por origen del módulo (ficha §13). El reparto y las tres reubicaciones
// son decisión de producto (§13.2); aquí solo se calcan. Todo es presentación: el `PUT` sigue
// mandando los mismos códigos, la función solo se PINTA en otro acordeón.

export type Seccion = 'flito' | 'previo_en_uso' | 'previo_sin_uso';

export interface DefinicionSeccion {
  clave: Seccion;
  titulo: string;
  /** Una línea bajo el rótulo; solo la sección 3 la lleva (§13.3, decisión 23). */
  ayuda?: string;
}

/** Orden fijo de las secciones (§13.1). No se ordenan alfabéticamente. */
export const SECCIONES: readonly DefinicionSeccion[] = [
  { clave: 'flito', titulo: 'FLITO' },
  { clave: 'previo_en_uso', titulo: 'Ya existía y FLITO lo usa' },
  { clave: 'previo_sin_uso', titulo: 'Existe pero no se usa', ayuda: 'Si se marcan, el rol sí entra a esas pantallas. FLITO no las usa hoy.' },
];

/** Clave de módulo del API → sección. Una clave que no esté aquí cae en FLITO (§13.2). */
const SECCION_DE_MODULO: Record<string, Seccion> = {
  flito_soat_e_impuestos: 'flito',
  finanzas: 'flito',
  soat: 'flito',
  tramites: 'flito',
  impuestos: 'flito',
  derechos: 'flito',
  revisiones: 'flito',
  compuerta: 'flito',
  tablero: 'flito',
  bitacora: 'flito',
  logistica: 'flito',
  bolsas: 'flito',
  comparendos: 'flito',
  conciliacion: 'flito',
  liquidacion: 'flito',
  parametrizacion: 'flito',
  sync: 'flito',
  general: 'previo_en_uso',
  administracion: 'previo_en_uso',
  usuarios: 'previo_en_uso',
  permisos: 'previo_en_uso',
  transito: 'previo_en_uso',
  flota: 'previo_sin_uso',
  mantenimiento: 'previo_sin_uso',
  pesv: 'previo_sin_uso',
  rndc: 'previo_sin_uso',
  cumplimiento_laft: 'previo_sin_uso',
  tramite: 'previo_sin_uso',
  operaciones: 'previo_sin_uso',
  privacidad: 'previo_sin_uso',
};

export function seccionDeModulo(clave: string): Seccion {
  return SECCION_DE_MODULO[clave] ?? 'flito';
}

/** Código de función → clave del módulo en el que se pinta (§13.2). El API no se entera. */
const REUBICACIONES: Record<string, string> = {
  'pagina.transito': 'transito',
  'pagina.drive': 'derechos',
  'pagina.privacy': 'privacidad',
};

export interface SeccionVisible extends DefinicionSeccion {
  grupos: GrupoDeFunciones[];
}

/**
 * Reparte el catálogo en las tres secciones, en orden fijo:
 *   1. reubica las funciones de `REUBICACIONES` en su módulo destino (se crea si no vino);
 *   2. descarta módulos sin funciones (vacío D, también el origen que quedó vacío al mover);
 *   3. ordena alfabéticamente por etiqueta dentro de cada sección (`modulosVisibles`);
 *   4. clave desconocida → FLITO;
 *   5. una sección sin módulos no se devuelve (vacío E).
 * Σ funciones de lo devuelto == Σ funciones de `grupos`: no se pierde ni se duplica ninguna.
 */
export function seccionesVisibles(grupos: GrupoDeFunciones[]): SeccionVisible[] {
  const porModulo = new Map<string, GrupoDeFunciones>();
  const moduloDe = (clave: string): GrupoDeFunciones => {
    let g = porModulo.get(clave);
    if (!g) { g = { modulo: clave, funciones: [] }; porModulo.set(clave, g); }
    return g;
  };
  // Dos pasadas: primero lo propio de cada módulo, después lo reubicado, para que una función
  // movida se pinte detrás de las que ya eran del destino y no por delante según el orden del API.
  const reubicadas: { destino: string; funcion: GrupoDeFunciones['funciones'][number] }[] = [];
  for (const g of grupos) {
    const propio = moduloDe(g.modulo);
    for (const f of g.funciones) {
      const destino = REUBICACIONES[f.codigo];
      if (destino) reubicadas.push({ destino, funcion: f }); else propio.funciones.push(f);
    }
  }
  for (const { destino, funcion } of reubicadas) moduloDe(destino).funciones.push(funcion);
  const porSeccion = new Map<Seccion, GrupoDeFunciones[]>();
  for (const g of modulosVisibles([...porModulo.values()])) {
    const s = seccionDeModulo(g.modulo);
    porSeccion.set(s, [...(porSeccion.get(s) ?? []), g]);
  }
  return SECCIONES.flatMap((s) => {
    const suyos = porSeccion.get(s.clave);
    return suyos && suyos.length > 0 ? [{ ...s, grupos: suyos }] : [];
  });
}

/** «0 de 5 marcadas» / «1 de 5 marcada» (cuenta del rótulo de sección, §13.7). */
export function kDeNMarcadas(k: number, n: number): string {
  return `${k} de ${n} ${k === 1 ? 'marcada' : 'marcadas'}`;
}

export const ETIQUETA_ENLACE: Record<TipoEnlace, string> = {
  ninguno: 'No se atan a nada',
  compania: 'Una compañía',
  proveedor_soat: 'Un gestor SOAT',
  organismos_transito: 'Organismos de tránsito',
};

/** Ayuda de cada ámbito en el formulario (ficha §8.5). */
export const AYUDA_ENLACE: Record<TipoEnlace, string> = {
  ninguno: 'Sus usuarios ven lo que este cuadro tenga marcado, sin filtro por entidad.',
  compania: 'Al crear un usuario con este rol habrá que elegirle una compañía, y solo verá lo de esa compañía.',
  proveedor_soat: 'Al crear un usuario con este rol habrá que elegirle un gestor SOAT, y solo verá los trámites de ese gestor.',
  organismos_transito: 'Al crear un usuario con este rol habrá que marcarle uno o más organismos, y solo verá lo de esos organismos.',
};

/** Cómo se lee el ámbito en la cabecera del rol («Se atan a…»). */
export const ENLACE_EN_CABECERA: Record<TipoEnlace, string> = {
  ninguno: 'No se atan a nada',
  compania: 'Se atan a una compañía',
  proveedor_soat: 'Se atan a un gestor SOAT',
  organismos_transito: 'Se atan a organismos de tránsito',
};

export const ETIQUETA_ACCESO: Record<TipoPrincipalRol, string> = {
  interno: 'Interno',
  externo: 'Externo',
};

/** «1 usuario tiene este rol.» / «4 usuarios tienen este rol.» */
export function usuariosTienenEsteRol(n: number): string {
  return n === 1 ? '1 usuario tiene este rol.' : `${n} usuarios tienen este rol.`;
}

/** «1 marcada» / «3 marcadas». */
export function marcadas(n: number): string {
  return n === 1 ? '1 marcada' : `${n} marcadas`;
}

/** «1 desmarcada» / «3 desmarcadas». */
export function desmarcadas(n: number): string {
  return n === 1 ? '1 desmarcada' : `${n} desmarcadas`;
}

/** «1 cambio» / «3 cambios». */
export function cambios(n: number): string {
  return n === 1 ? '1 cambio' : `${n} cambios`;
}

/** «1 función marcada fuera del canal» / «7 funciones marcadas fuera del canal». */
export function funcionesFueraDelCanal(n: number): string {
  return n === 1 ? '1 función marcada fuera del canal' : `${n} funciones marcadas fuera del canal`;
}

/**
 * El código del rol, derivado del nombre (ficha §8.5 y decisión 11): minúsculas, tildes plegadas,
 * todo lo que no sea letra o dígito a `_`, sin `_` en los extremos, tope 40. El patrón que el API
 * exige es `^[a-z0-9_]+$`; una tilde sin plegar lo rompería con un 400 que la pantalla no habría
 * avisado (nota de QA 11).
 */
export const PATRON_CODIGO = /^[a-z0-9_]+$/;
export const LARGO_MAX_CODIGO = 40;

export function derivarCodigo(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LARGO_MAX_CODIGO)
    .replace(/_+$/g, '');
}
