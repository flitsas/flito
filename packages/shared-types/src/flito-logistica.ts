// FLITO — dominio del módulo de Logística. La unidad de trazabilidad es el DOCUMENTO
// individual (una LT, una placa), no el lote (RN-01). Actas y rutas son agrupaciones sobre él.
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web, igual que flito-estados.ts.
// Los tonos de color NO van aquí (viven en la capa web); aquí solo estados + labels + reglas.
//
// OJO con el vocabulario (FEATURE_LOGISTICA §9.7): el `entregado` de logística (documento
// físico en manos del cliente) es DISTINTO del EstadoTramiteFlito.ENTREGADO (compuerta
// SOAT+Impuestos). Son enums y tablas separadas y ocurren en momentos distintos.

/**
 * Estado de un documento físico (LT o placa) a lo largo del ciclo logístico:
 *
 *   Generado ──> Recogido ──> Clasificado ──> En acta ──> Despachado ──> Entregado
 *       │            │                                          │
 *       └────────────┴──> Novedad ──> (se resuelve y retorna)   └──> Devuelto ──> (se reprograma)
 *
 * - Generado:    el organismo lo emitió; aún en el organismo.
 * - Recogido:    el mensajero lo verificó y lo tiene físicamente (actor, hora, ubicación).
 * - Clasificado: asignado automáticamente a su empresa destino (CA-03, sin Excel).
 * - En acta:     incluido en un acta generada, pendiente de despacho.
 * - Despachado:  entregado al mensajero para su ruta; en tránsito.
 * - Entregado:   recibido y firmado por el cliente. Estado TERMINAL.
 * - Novedad:     faltante, dañado o inconsistente. Motivo obligatorio; bloquea el avance (RN-04).
 * - Devuelto:    el receptor no estaba o rechazó. Motivo obligatorio; se reprograma (CA-10).
 */
export const EstadoDocumentoLogistica = {
  GENERADO: 'generado',
  RECOGIDO: 'recogido',
  CLASIFICADO: 'clasificado',
  EN_ACTA: 'en_acta',
  DESPACHADO: 'despachado',
  ENTREGADO: 'entregado',
  NOVEDAD: 'novedad',
  DEVUELTO: 'devuelto',
} as const;

export type EstadoDocumentoLogistica = (typeof EstadoDocumentoLogistica)[keyof typeof EstadoDocumentoLogistica];

export const ESTADO_DOCUMENTO_LOGISTICA_LABEL: Record<EstadoDocumentoLogistica, string> = {
  generado: 'Generado',
  recogido: 'Recogido',
  clasificado: 'Clasificado',
  en_acta: 'En acta',
  despachado: 'Despachado',
  entregado: 'Entregado',
  novedad: 'Novedad',
  devuelto: 'Devuelto',
};

/** Estado terminal del documento: no admite más avance. */
export const ESTADOS_DOCUMENTO_LOGISTICA_TERMINALES: readonly EstadoDocumentoLogistica[] = [
  'entregado',
];

/**
 * Solo un documento CLASIFICADO puede entrar en un acta (CA-04). Novedad y devuelto bloquean
 * el avance hasta resolverse (RN-04/RN-12); generado/recogido aún no están listos.
 */
export function puedeEntrarEnActa(estado: EstadoDocumentoLogistica): boolean {
  return estado === EstadoDocumentoLogistica.CLASIFICADO;
}

/** Estados que bloquean incluir el documento en un acta (para mensajes claros al coordinador). */
export const ESTADOS_LOGISTICA_BLOQUEAN_ACTA: readonly EstadoDocumentoLogistica[] = [
  'novedad', 'devuelto',
];

// ── Estado SIMPLIFICADO (vista de negocio) ───────────────────────────────────
// El ciclo interno tiene más matices (recogido/clasificado/en_acta…), pero la operación y el cliente
// razonan con 5 estados. Este es el vocabulario que se muestra en la consola, el tracking y la ruta.
// El estado interno del documento sigue siendo el de arriba; aquí solo se COLAPSA para presentar.
//
//   Pendiente de recogida → Registrada → Despachada → Entregada         (Con novedad = lateral)
//
// - Pendiente de recogida: el trámite está aprobado pero el mensajero aún no escaneó la LT.
// - Registrada:  el mensajero la recogió y quedó clasificada a su trámite. Lista para armar el acta.
// - Despachada:  se generó el acta y el mensajero salió a entregarla (ya lleva la firma de Operaciones).
// - Entregada:   el mensajero la entregó y el receptor firmó. Estado TERMINAL.
// - Con novedad: hubo una novedad (o devolución) en cualquier punto del ciclo.
export const EstadoLogisticaSimple = {
  PENDIENTE: 'pendiente',
  REGISTRADA: 'registrada',
  DESPACHADA: 'despachada',
  ENTREGADA: 'entregada',
  NOVEDAD: 'novedad',
} as const;

export type EstadoLogisticaSimple = (typeof EstadoLogisticaSimple)[keyof typeof EstadoLogisticaSimple];

export const ESTADO_LOGISTICA_SIMPLE_LABEL: Record<EstadoLogisticaSimple, string> = {
  pendiente: 'Pendiente de recogida',
  registrada: 'Registrada',
  despachada: 'Despachada',
  entregada: 'Entregada',
  novedad: 'Con novedad',
};

/** Pasos lineales del tracking (la novedad NO va en la línea: es un desvío lateral). */
export const ESTADOS_LOGISTICA_SIMPLE_ORDEN: readonly EstadoLogisticaSimple[] = [
  'pendiente', 'registrada', 'despachada', 'entregada',
];

/**
 * Colapsa el estado INTERNO del documento (o null = LT aún no escaneada) al vocabulario de 5 estados.
 * `generado` y ausencia de documento = «Pendiente de recogida»; `recogido`/`clasificado`/`en_acta` =
 * «Registrada»; `despachado` = «Despachada»; `entregado` = «Entregada»; `novedad`/`devuelto` = «Con novedad».
 */
export function simplificarEstadoLogistica(interno: string | null | undefined): EstadoLogisticaSimple {
  switch (interno) {
    case 'recogido':
    case 'clasificado':
    case 'en_acta':
      return 'registrada';
    case 'despachado':
      return 'despachada';
    case 'entregado':
      return 'entregada';
    case 'novedad':
    case 'devuelto':
      return 'novedad';
    case 'generado':
    default:
      return 'pendiente';
  }
}

/** Estado del acta (agrupación por empresa para despacho/entrega). */
export const EstadoActaLogistica = {
  GENERADA: 'generada',
  DESPACHADA: 'despachada',
  ENTREGADA: 'entregada',
  DEVUELTA: 'devuelta',
} as const;

export type EstadoActaLogistica = (typeof EstadoActaLogistica)[keyof typeof EstadoActaLogistica];

export const ESTADO_ACTA_LOGISTICA_LABEL: Record<EstadoActaLogistica, string> = {
  generada: 'Generada',
  despachada: 'Despachada',
  entregada: 'Entregada',
  devuelta: 'Devuelta',
};

/**
 * Tipo de documento físico. LT y placa hoy; `otro` deja espacio a más tipos con el mismo
 * ciclo (FEATURE_LOGISTICA §13.5, pregunta abierta).
 */
export const TipoDocumentoLogistica = {
  LICENCIA_TRANSITO: 'licencia_transito',
  PLACA: 'placa',
  OTRO: 'otro',
} as const;

export type TipoDocumentoLogistica = (typeof TipoDocumentoLogistica)[keyof typeof TipoDocumentoLogistica];

export const TIPO_DOCUMENTO_LOGISTICA_LABEL: Record<TipoDocumentoLogistica, string> = {
  licencia_transito: 'Licencia de tránsito',
  placa: 'Placa',
  otro: 'Otro',
};

/** Estrategia del proveedor logístico: mensajería propia (PWA FLITO) o integración con tercero (§6). */
export const EstrategiaProveedorLogistica = {
  PWA_PROPIA: 'pwa_propia',
  INTEGRACION_TERCERO: 'integracion_tercero',
} as const;

export type EstrategiaProveedorLogistica = (typeof EstrategiaProveedorLogistica)[keyof typeof EstrategiaProveedorLogistica];

export const ESTRATEGIA_PROVEEDOR_LOGISTICA_LABEL: Record<EstrategiaProveedorLogistica, string> = {
  pwa_propia: 'Mensajería propia (PWA)',
  integracion_tercero: 'Integración con tercero',
};
