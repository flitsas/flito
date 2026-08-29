import type { PageSlug } from '../../lib/permissions';

// Catálogo de 18 fichas de Ayuda FLITO (HU #11893). Fuente de verdad de QUÉ puede aparecer
// en el índice. El orden de cada grupo es el de NAV_ITEMS cuando el ítem existe; si no hay
// ítem de menú (Compuerta, Tablero FLITO, Credenciales), al final del grupo.
//
// Las 18 están publicadas (Gestión #11894; Finanzas y Administración #11895). Ausencia de
// archivo = «Ficha pendiente», no error.
//
// `siigo_credenciales` NO es un PageSlug en este worktree (lo añade otra HU). En el catálogo
// se lista solo si `user.role === 'admin'`. Prohibido aliasarla a `siigo_parametrizacion`:
// Financiera tiene parametrización y no debe ver el capítulo de credenciales.

export type AyudaGrupo = 'gestion' | 'finanzas' | 'administracion';

export type ClaveAyuda =
  | 'flito_tramites'
  | 'soat'
  | 'flito_impuestos'
  | 'flito_derechos'
  | 'flito_revisiones'
  | 'flito_compuerta'
  | 'flito_tablero'
  | 'flito_bitacora'
  | 'flito_logistica'
  | 'flito_logistica_ruta'
  | 'flito_comparendos'
  | 'clients'
  | 'flito_bolsas'
  | 'flito_conciliacion'
  | 'finanzas_reporte_costos'
  | 'siigo_parametrizacion'
  | 'siigo_operacion'
  | 'siigo_credenciales';

export interface EntradaAyuda {
  clave: ClaveAyuda;
  grupo: AyudaGrupo;
  etiqueta: string;
  resumen: string;
  /** Ruta de producto. Ausente = no se pinta «Ir a la pantalla». */
  to?: string;
  /**
   * PageSlug para `hasPage`. Ausente solo en `siigo_credenciales` (visibilidad = rol admin).
   * Nunca alias a otro slug.
   */
  permiso?: PageSlug;
}

export const GRUPO_AYUDA_LABEL: Record<AyudaGrupo, string> = {
  gestion: 'Gestión',
  finanzas: 'Finanzas',
  administracion: 'Administración',
};

export const CATALOGO_AYUDA: readonly EntradaAyuda[] = [
  { clave: 'flito_tramites', grupo: 'gestion', etiqueta: 'Gestión Trámites', resumen: 'Cómo despachar SOAT, impuestos y entregas.', to: '/flito/tramites', permiso: 'flito_tramites' },
  // La ficha describe `/flito/soat`, y desde el Feature #11912 esa pantalla tiene llave propia:
  // `flito_soat`, no la `soat` del módulo legacy (`/soat`, `Soat.tsx`). Dejar `permiso: 'soat'`
  // ataría la ayuda de una pantalla al permiso de OTRA (ADR-0008 §4).
  { clave: 'soat', grupo: 'gestion', etiqueta: 'SOAT', resumen: 'Cola de pólizas del proveedor.', to: '/flito/soat', permiso: 'flito_soat' },
  { clave: 'flito_impuestos', grupo: 'gestion', etiqueta: 'Impuestos', resumen: 'Cola de recibos del gestor de impuestos.', to: '/flito/impuestos', permiso: 'flito_impuestos' },
  { clave: 'flito_derechos', grupo: 'gestion', etiqueta: 'Derechos de tránsito', resumen: 'Lo que el organismo cobra por radicar.', to: '/flito/derechos', permiso: 'flito_derechos' },
  { clave: 'flito_revisiones', grupo: 'gestion', etiqueta: 'Revisiones OCR', resumen: 'Cola de confirmación de campos leídos.', to: '/flito/revisiones', permiso: 'flito_revisiones' },
  { clave: 'flito_compuerta', grupo: 'gestion', etiqueta: 'Compuerta de entrega', resumen: 'Habilitar la entrega cuando SOAT e impuestos están resueltos.', to: '/flito/compuerta', permiso: 'flito_compuerta' },
  { clave: 'flito_tablero', grupo: 'gestion', etiqueta: 'Tablero FLITO', resumen: 'Retenciones, estancamientos y diferencias de operación.', to: '/flito/tablero', permiso: 'flito_tablero' },
  { clave: 'flito_bitacora', grupo: 'gestion', etiqueta: 'Bitácora', resumen: 'Rastro de movimientos de un trámite.', to: '/flito/bitacora', permiso: 'flito_bitacora' },
  { clave: 'flito_logistica', grupo: 'gestion', etiqueta: 'Logística', resumen: 'Actas, despacho y trazabilidad por documento.', to: '/flito/logistica', permiso: 'flito_logistica' },
  { clave: 'flito_logistica_ruta', grupo: 'gestion', etiqueta: 'Mi ruta', resumen: 'Recogidas y entregas asignadas al mensajero.', to: '/flito/ruta', permiso: 'flito_logistica_ruta' },
  { clave: 'flito_comparendos', grupo: 'gestion', etiqueta: 'Comparendos', resumen: 'Lo que SIMIT y los municipios reportan de los NIT vigilados.', to: '/flito/comparendos', permiso: 'flito_comparendos' },
  { clave: 'clients', grupo: 'gestion', etiqueta: 'Clientes y proveedores', resumen: 'Empresas, tarifas y datos comerciales.', to: '/clients', permiso: 'clients' },
  { clave: 'flito_bolsas', grupo: 'finanzas', etiqueta: 'Bolsas', resumen: 'Saldos, recargas y cierres.', to: '/flito/bolsas', permiso: 'flito_bolsas' },
  { clave: 'flito_conciliacion', grupo: 'finanzas', etiqueta: 'Conciliación', resumen: 'Cruce del recaudo SOAT contra lo emitido.', to: '/flito/conciliacion', permiso: 'flito_conciliacion' },
  { clave: 'finanzas_reporte_costos', grupo: 'finanzas', etiqueta: 'Reporte de costos', resumen: 'Costos por trámite para contabilidad y cobros.', to: '/finanzas/reporte-costos', permiso: 'finanzas_reporte_costos' },
  { clave: 'siigo_parametrizacion', grupo: 'finanzas', etiqueta: 'Facturación electrónica · Parametrización', resumen: 'Catálogos, mapeo de conceptos y emisión.', to: '/siigo/parametrizacion', permiso: 'siigo_parametrizacion' },
  { clave: 'siigo_operacion', grupo: 'finanzas', etiqueta: 'Facturación electrónica · Operación', resumen: 'Bandeja de facturas y acciones del día a día.', to: '/siigo/operacion', permiso: 'siigo_operacion' },
  { clave: 'siigo_credenciales', grupo: 'administracion', etiqueta: 'Facturación electrónica · Credenciales', resumen: 'Credenciales de la integración. Solo administración.' },
];
