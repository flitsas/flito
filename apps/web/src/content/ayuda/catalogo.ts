import type { PageSlug } from '../../lib/permissions';

// Catálogo de las fichas de Ayuda FLITO (HU #11893; Roles y permisos de la HU #12085; Gastos diarios de
// la HU #12624). Fuente de verdad de QUÉ puede aparecer en el índice. Ausencia de archivo = «Ficha
// pendiente», no error.
//
// HU #13431 (P-33): la etiqueta de cada capítulo es el nombre de su ítem del menú y el orden de cada
// grupo es el de `NAV_ENTRADAS` (components/shell/navEntradas.ts) — lo vigila
// `e2e/tests/flito-ayuda-indice.spec.ts`. Solo se listan pantallas que son un ítem del menú:
//   · `flito_tablero` (clave y archivo se conservan para no romper enlaces) es desde P-11 (HU #13428)
//     el **Tablero** de General (`/`). Cuelga de `flito_tablero` porque «Ver el tablero» lo expande
//     junto con la función que pinta ese contenido; `dashboard` lo tiene también quien ve el inicio
//     genérico.
//   · La antigua «Compuerta de entrega» no es un ítem del menú: «Entregar trámites» es una acción de
//     Gestión Trámites y se explica en su ficha. `/flito/ayuda/flito_compuerta` cae en «Esta ficha no
//     existe», como cualquier clave fuera del catálogo.
//
// `siigo_credenciales` cuelga de su propio PageSlug (HU #12872; antes, del nombre del rol).
// Prohibido aliasarla a `siigo_parametrizacion`: Financiera tiene parametrización y no debe ver el
// capítulo de credenciales.

export type AyudaGrupo = 'general' | 'gestion' | 'finanzas' | 'administracion';

export type ClaveAyuda =
  | 'flito_tramites'
  | 'soat'
  | 'flito_impuestos'
  | 'flito_derechos'
  | 'flito_revisiones'
  | 'flito_tablero'
  | 'flito_bitacora'
  | 'flito_logistica'
  | 'flito_logistica_ruta'
  | 'flito_comparendos'
  | 'clients'
  | 'flito_bolsas'
  | 'flito_tarifas'
  | 'flito_servicios_adicionales'
  | 'flito_conciliacion'
  | 'finanzas_reporte_costos'
  | 'finanzas_gastos_diarios'
  | 'flito_comprobantes'
  | 'siigo_parametrizacion'
  | 'siigo_operacion'
  | 'siigo_credenciales'
  | 'roles_permisos';

export interface EntradaAyuda {
  clave: ClaveAyuda;
  grupo: AyudaGrupo;
  etiqueta: string;
  /**
   * Solo para entradas **sin** `.md` (ficha pendiente). Con `.md`, el resumen vive en el
   * encabezado de la ficha (Feature #13691 · HU #13703, fuente única); la prueba de artefactos
   * prohíbe tenerlo en los dos sitios.
   */
  resumenPendiente?: string;
  /** Ruta de producto. Ausente = no se pinta «Ir a la pantalla». */
  to?: string;
  /**
   * PageSlug para `hasPage`. Ausente = la ficha no se lista (fail-closed).
   * Nunca alias a otro slug.
   */
  permiso?: PageSlug;
}

/**
 * Orden de los grupos en el índice, igual al del menú (HU #13431). Lo comparten el índice y
 * Anterior/Siguiente de la ficha (Feature #13691 · HU #13705, diseño slim §7).
 */
export const GRUPOS_ORDEN: readonly AyudaGrupo[] = ['general', 'gestion', 'finanzas', 'administracion'];

export const GRUPO_AYUDA_LABEL: Record<AyudaGrupo, string> = {
  general: 'General',
  gestion: 'Gestión',
  finanzas: 'Finanzas',
  administracion: 'Administración',
};

export const CATALOGO_AYUDA: readonly EntradaAyuda[] = [
  { clave: 'flito_tablero', grupo: 'general', etiqueta: 'Tablero', to: '/', permiso: 'flito_tablero' },
  { clave: 'clients', grupo: 'gestion', etiqueta: 'Clientes y proveedores', to: '/clients', permiso: 'clients' },
  { clave: 'flito_tramites', grupo: 'gestion', etiqueta: 'Gestión Trámites', to: '/flito/tramites', permiso: 'flito_tramites' },
  { clave: 'flito_derechos', grupo: 'gestion', etiqueta: 'Derechos', to: '/flito/derechos', permiso: 'flito_derechos' },
  { clave: 'flito_revisiones', grupo: 'gestion', etiqueta: 'Revisiones OCR', to: '/flito/revisiones', permiso: 'flito_revisiones' },
  { clave: 'flito_bitacora', grupo: 'gestion', etiqueta: 'Bitácora', to: '/flito/bitacora', permiso: 'flito_bitacora' },
  { clave: 'flito_comparendos', grupo: 'gestion', etiqueta: 'Comparendos', to: '/flito/comparendos', permiso: 'flito_comparendos' },
  { clave: 'flito_logistica', grupo: 'gestion', etiqueta: 'Logística', to: '/flito/logistica', permiso: 'flito_logistica' },
  { clave: 'flito_logistica_ruta', grupo: 'gestion', etiqueta: 'Mi ruta', to: '/flito/ruta', permiso: 'flito_logistica_ruta' },
  // La ficha describe `/flito/soat`, y desde el Feature #11912 esa pantalla tiene llave propia:
  // `flito_soat`, no la `soat` del módulo legacy (`/soat`, `Soat.tsx`). Dejar `permiso: 'soat'`
  // ataría la ayuda de una pantalla al permiso de OTRA (ADR-0008 §4).
  { clave: 'soat', grupo: 'gestion', etiqueta: 'SOAT', to: '/flito/soat', permiso: 'flito_soat' },
  { clave: 'flito_impuestos', grupo: 'gestion', etiqueta: 'Impuestos', to: '/flito/impuestos', permiso: 'flito_impuestos' },
  { clave: 'finanzas_reporte_costos', grupo: 'finanzas', etiqueta: 'Reporte de costos', to: '/finanzas/reporte-costos', permiso: 'finanzas_reporte_costos' },
  { clave: 'finanzas_gastos_diarios', grupo: 'finanzas', etiqueta: 'Gastos diarios', to: '/finanzas/gastos-diarios', permiso: 'finanzas_gastos_diarios' },
  { clave: 'flito_bolsas', grupo: 'finanzas', etiqueta: 'Bolsas', to: '/flito/bolsas', permiso: 'flito_bolsas' },
  { clave: 'flito_tarifas', grupo: 'finanzas', etiqueta: 'Tarifas', to: '/flito/tarifas', permiso: 'flito_tarifas' },
  { clave: 'flito_servicios_adicionales', grupo: 'finanzas', etiqueta: 'Servicios adicionales', to: '/flito/servicios-adicionales', permiso: 'flito_servicios_adicionales' },
  { clave: 'flito_comprobantes', grupo: 'finanzas', etiqueta: 'Comprobantes', to: '/flito/comprobantes', permiso: 'flito_comprobantes' },
  { clave: 'flito_conciliacion', grupo: 'finanzas', etiqueta: 'Conciliación', to: '/flito/conciliacion', permiso: 'flito_conciliacion' },
  { clave: 'siigo_parametrizacion', grupo: 'finanzas', etiqueta: 'Facturación electrónica · Parametrización', to: '/siigo/parametrizacion', permiso: 'siigo_parametrizacion' },
  { clave: 'siigo_operacion', grupo: 'finanzas', etiqueta: 'Facturación electrónica · Operación', to: '/siigo/operacion', permiso: 'siigo_operacion' },
  { clave: 'roles_permisos', grupo: 'administracion', etiqueta: 'Roles y permisos', to: '/roles-permisos', permiso: 'roles_permisos' },
  { clave: 'siigo_credenciales', grupo: 'administracion', etiqueta: 'Integración con Siigo', to: '/siigo/credenciales', permiso: 'siigo_credenciales' },
];
