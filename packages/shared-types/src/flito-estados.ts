// FLITO — dominio de estados de SOAT, Impuestos, modalidad de organismo y soportes.
// Portado desde packages/shared/src/estados.ts (proyecto FLITO original). Ver
// docs/MIGRACION_FLITO_A_OPERACIONES.md §5–§6 y docs/DECISIONES.md.
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web. Las reglas caras
// (RN-01, CA-03/04, compuerta) se apoyan en estos catálogos.

/**
 * Estado del trámite en FLIT (fuente externa, sincronizada; FLITO no es dueño).
 *
 *   Asignado ──[compuerta]──> Entregado ──> Aprobado ──> (arranca Logística)
 */
export const EstadoTramiteFlito = {
  ASIGNADO: 'asignado',
  ENTREGADO: 'entregado',
  APROBADO: 'aprobado',
  ANULADO: 'anulado',
  RECHAZADO: 'rechazado',
} as const;

export type EstadoTramiteFlito = (typeof EstadoTramiteFlito)[keyof typeof EstadoTramiteFlito];

export const ESTADO_TRAMITE_FLITO_LABEL: Record<EstadoTramiteFlito, string> = {
  asignado: 'Asignado',
  entregado: 'Entregado',
  aprobado: 'Aprobado',
  anulado: 'Anulado',
  rechazado: 'Rechazado',
};

/**
 * Estados en los que el trámite ya no está vivo para SOAT ni Impuestos.
 * Ninguno libera lo ya adquirido (RN-01); solo deja de ser candidato a entrega.
 */
export const ESTADOS_TRAMITE_FLITO_TERMINADOS: readonly EstadoTramiteFlito[] = [
  'anulado', 'rechazado',
];

/** `processStatus === 5` es Asignado (SOAT_IMPUESTOS_TRAMITES.txt). */
export const PROCESS_STATUS_ASIGNADO = 5;

/**
 * Estado del SOAT. Independiente del ciclo del trámite — esa independencia es lo
 * que resuelve el riesgo de doble adquisición (FEATURE_SOAT §7).
 *
 *   Pendiente ──> En adquisición ──> Pagado
 *                      └──> Rechazado ──> (vuelve a Pendiente tras corrección)
 *
 * Reemplaza el `soat_status` legacy ('pendiente/enviado/comprado/verificado/rechazado').
 */
export const EstadoSoat = {
  PENDIENTE: 'pendiente',
  EN_ADQUISICION: 'en_adquisicion',
  PAGADO: 'pagado',
  RECHAZADO: 'rechazado',
} as const;

export type EstadoSoat = (typeof EstadoSoat)[keyof typeof EstadoSoat];

export const ESTADO_SOAT_LABEL: Record<EstadoSoat, string> = {
  pendiente: 'Pendiente',
  en_adquisicion: 'En adquisición',
  pagado: 'Pagado',
  rechazado: 'Rechazado',
};

/**
 * RN-01: un SOAT se adquiere una sola vez por VIN. Ningún evento del trámite
 * libera un VIN en estos estados.
 */
export const ESTADOS_SOAT_BLOQUEAN_REENCOLADO: readonly EstadoSoat[] = [
  'en_adquisicion', 'pagado',
];

export function soatBloqueaReencolado(estado: EstadoSoat): boolean {
  return (ESTADOS_SOAT_BLOQUEAN_REENCOLADO as readonly string[]).includes(estado);
}

/** Estados del SOAT visibles para el gestor (nunca `Pendiente`). Ver DECISIONES.md §6. */
export const ESTADOS_SOAT_VISIBLES_GESTOR: readonly EstadoSoat[] = [
  'en_adquisicion', 'pagado',
];

/**
 * Estado de Impuestos.
 *
 *   Sin factura ──> Pendiente ──> En gestión ──> Pagado
 *                                      └──> Rechazado ──> (vuelve a Pendiente)
 *   Retenido   (organismo sin clasificar)
 *   No aplica  (organismo autogestionado o compañía autogestionable)
 */
export const EstadoImpuesto = {
  SIN_FACTURA: 'sin_factura',
  RETENIDO: 'retenido',
  PENDIENTE: 'pendiente',
  EN_GESTION: 'en_gestion',
  PAGADO: 'pagado',
  RECHAZADO: 'rechazado',
  NO_APLICA: 'no_aplica',
} as const;

export type EstadoImpuesto = (typeof EstadoImpuesto)[keyof typeof EstadoImpuesto];

export const ESTADO_IMPUESTO_LABEL: Record<EstadoImpuesto, string> = {
  sin_factura: 'Sin factura de venta',
  retenido: 'Retenido por organismo sin clasificar',
  pendiente: 'Pendiente de envío',
  en_gestion: 'En gestión',
  pagado: 'Pagado',
  rechazado: 'Rechazado',
  no_aplica: 'No aplica',
};

/** Estados de Impuestos visibles para el gestor (nunca `Pendiente`). */
export const ESTADOS_IMPUESTO_VISIBLES_GESTOR: readonly EstadoImpuesto[] = [
  'en_gestion', 'pagado',
];

/**
 * Modalidad de gestión del organismo (FEATURE_IMPUESTOS §6.1).
 * `Sin clasificar` NO es un default: es la ausencia de decisión y retiene los
 * trámites (RN-01 de Impuestos prohíbe asumir cualquiera de las otras dos).
 */
export const ModalidadOrganismo = {
  SIN_CLASIFICAR: 'sin_clasificar',
  REQUIERE_GESTION: 'requiere_gestion',
  AUTOGESTIONADO: 'autogestionado',
} as const;

export type ModalidadOrganismo = (typeof ModalidadOrganismo)[keyof typeof ModalidadOrganismo];

export const MODALIDAD_ORGANISMO_LABEL: Record<ModalidadOrganismo, string> = {
  sin_clasificar: 'Sin clasificar',
  requiere_gestion: 'Requiere gestión FLITO',
  autogestionado: 'Autogestionado por el organismo',
};

/** Tipo de propiedad del vehículo. Cambia el mapeo de compradores (FEATURE_SOAT §9.6). */
export const TipoPropiedad = {
  UNICO_PROPIETARIO: 'unico_propietario',
  MULTIPLE_PROPIETARIO: 'multiple_propietario',
} as const;

export type TipoPropiedad = (typeof TipoPropiedad)[keyof typeof TipoPropiedad];

/**
 * Tipo de soporte cargado. Impuestos maneja los recibos con y sin marca de agua
 * (SOAT_IMPUESTOS_TRAMITES.txt). La factura de venta la emite el concesionario,
 * no FLITO (DECISIONES.md §7).
 */
export const TipoSoporte = {
  FACTURA_SOAT: 'factura_soat',
  FACTURA_VENTA: 'factura_venta',
  RECIBO_IMPUESTO: 'recibo_impuesto',
  RECIBO_IMPUESTO_SIN_MARCA_AGUA: 'recibo_impuesto_sin_marca_agua',
} as const;

export type TipoSoporte = (typeof TipoSoporte)[keyof typeof TipoSoporte];

/** Módulos parametrizables por compañía (FLITO.md). */
export const ModuloFlito = {
  SOAT: 'soat',
  IMPUESTOS: 'impuestos',
  LOGISTICA: 'logistica',
} as const;

export type ModuloFlito = (typeof ModuloFlito)[keyof typeof ModuloFlito];

/** Ámbito de una regla de proveedor SOAT; menor número = más específico. */
export const AmbitoReglaProveedor = {
  COMPANIA: 'compania',
  ORGANISMO: 'organismo',
  GLOBAL: 'global',
} as const;

export type AmbitoReglaProveedor = (typeof AmbitoReglaProveedor)[keyof typeof AmbitoReglaProveedor];

/** Prioridad por ámbito (compañía gana a organismo, que gana a global). */
export const PRIORIDAD_POR_AMBITO: Record<AmbitoReglaProveedor, number> = {
  compania: 10,
  organismo: 20,
  global: 30,
};
