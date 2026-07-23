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

/**
 * Estado de un paso de gestión (SOAT o Impuestos). Cuatro estados, iguales para ambos:
 *
 *   Pendiente ──> Solicitado ──> Pagado
 *                     └──> Con novedad ──> (se corrige y vuelve a Pendiente/Solicitado)
 *
 * - Pendiente:   aún no se ha solicitado.
 * - Solicitado:  enviado al gestor.
 * - Con novedad: no se pudo marcar pagado (gestor lo devolvió, OCR de baja confianza,
 *                diferencia de valor…). Requiere corrección; se comporta como Pendiente.
 * - Pagado:      el gestor cargó el comprobante y el OCR lo extrajo y asoció al vehículo.
 *
 * La AUTOGESTIÓN no es un estado: se deriva de banderas (compañía) / modalidad (organismo)
 * y no genera registro (se muestra "Autogestionado").
 * Independiente del ciclo del trámite — eso resuelve el riesgo de doble adquisición (RN-01).
 */
export const EstadoSoat = {
  PENDIENTE: 'pendiente',
  SOLICITADO: 'solicitado',
  CON_NOVEDAD: 'con_novedad',
  PAGADO: 'pagado',
} as const;

export type EstadoSoat = (typeof EstadoSoat)[keyof typeof EstadoSoat];

export const ESTADO_SOAT_LABEL: Record<EstadoSoat, string> = {
  pendiente: 'Pendiente',
  solicitado: 'Solicitado',
  con_novedad: 'Con novedad',
  pagado: 'Pagado',
};

/**
 * RN-01: un SOAT se adquiere una sola vez por VIN. Solicitado y Pagado bloquean el reencolado;
 * Con novedad NO (se comporta como Pendiente: se corrige y se reenvía).
 */
export const ESTADOS_SOAT_BLOQUEAN_REENCOLADO: readonly EstadoSoat[] = [
  'solicitado', 'pagado',
];

export function soatBloqueaReencolado(estado: EstadoSoat): boolean {
  return (ESTADOS_SOAT_BLOQUEAN_REENCOLADO as readonly string[]).includes(estado);
}

/** Estados del SOAT visibles para el gestor (nunca `Pendiente`). Ver DECISIONES.md §6. */
export const ESTADOS_SOAT_VISIBLES_GESTOR: readonly EstadoSoat[] = [
  'solicitado', 'pagado',
];

/** Estado de Impuestos: mismos cuatro estados que SOAT (ver EstadoSoat). */
export const EstadoImpuesto = {
  PENDIENTE: 'pendiente',
  SOLICITADO: 'solicitado',
  CON_NOVEDAD: 'con_novedad',
  PAGADO: 'pagado',
} as const;

export type EstadoImpuesto = (typeof EstadoImpuesto)[keyof typeof EstadoImpuesto];

export const ESTADO_IMPUESTO_LABEL: Record<EstadoImpuesto, string> = {
  pendiente: 'Pendiente',
  solicitado: 'Solicitado',
  con_novedad: 'Con novedad',
  pagado: 'Pagado',
};

/** Estados de Impuestos visibles para el gestor (nunca `Pendiente`). */
export const ESTADOS_IMPUESTO_VISIBLES_GESTOR: readonly EstadoImpuesto[] = [
  'solicitado', 'pagado',
];

/**
 * Modalidad de gestión del organismo. Dos valores; el DEFAULT (sin vigencia) es AUTOGESTIONADO:
 * salvo que se marque explícitamente "Requiere gestión", FLITO no gestiona sus impuestos.
 */
export const ModalidadOrganismo = {
  REQUIERE_GESTION: 'requiere_gestion',
  AUTOGESTIONADO: 'autogestionado',
} as const;

export type ModalidadOrganismo = (typeof ModalidadOrganismo)[keyof typeof ModalidadOrganismo];

export const MODALIDAD_ORGANISMO_LABEL: Record<ModalidadOrganismo, string> = {
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
