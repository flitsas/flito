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
