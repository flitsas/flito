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
 * Conceptos cuyo valor se negocia con cada compañía gestora (Feature #10939 §2.1 y §2.2).
 *
 * No están aquí SOAT, impuesto ni derecho de tránsito: esos NO se negocian, son desembolsos reales
 * que se leen del documento pagado. Estos dos son honorarios propios de FLIT, y por eso varían de
 * un cliente a otro (el requerimiento cita $200.000 en una compañía y $1.500 en otra).
 */
export const CONCEPTOS_TARIFA = ['tramite_digital', 'logistica'] as const;
export type ConceptoTarifa = (typeof CONCEPTOS_TARIFA)[number];

export const esConceptoTarifa = (v: unknown): v is ConceptoTarifa =>
  typeof v === 'string' && (CONCEPTOS_TARIFA as readonly string[]).includes(v);

export const CONCEPTO_TARIFA_LABEL: Record<ConceptoTarifa, string> = {
  tramite_digital: 'Trámite digital FLIT',
  logistica: 'Negociación logística',
};

/**
 * Cómo normalizar el tipo de trámite antes de compararlo. En `flito_tramites.tipo_tramite` es texto
 * libre de FLIT ("Matricula", "matrícula ", "TRASPASO"), así que sin normalizar la misma tarifa se
 * configuraría tres veces y ninguna coincidiría.
 */
export function normalizarTipoTramite(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toUpperCase();
  return s === '' ? null : s;
}

/**
 * ANS de la operación (Feature #10940 §3.2 y #10942 §5.2).
 *
 * Son iguales para toda la operación, no por proveedor ni por organismo: miden si FLITO va al día,
 * no lo que se pactó con un tercero. Viven en el dominio compartido para que la API y la web no
 * puedan discrepar.
 *
 * `flito_proveedores_soat.sla_horas` y `organismos_transito_config.flito_sla_horas` siguen en la
 * base pero ya no alimentan ninguna señal de pantalla: el ANS de gestión pasó a ser único.
 */
export const ANS_OPERATIVO = {
  /** Días en Borrador a partir de los cuales el trámite se considera estancado. */
  BORRADOR_DIAS: 5,
  /** ANS de aprobación: un trámite debería quedar aprobado en dos días. Más, hay que mirarlo. */
  SIN_APROBAR_DIAS: 2,
  /** A partir de aquí un trámite vivo se pinta en rojo. */
  ATRASADO_DIAS: 5,
  /** Antes de esto se pinta en ámbar: aún a tiempo, pero conviene mirarlo. */
  POR_VENCER_DIAS: 2,
  /** Dentro de estas horas el trámite se muestra como recién ingresado. */
  RECIEN_INGRESADO_HORAS: 24,
  /**
   * ANS de gestión de SOAT e impuestos: un día. Es igual para todos los proveedores y organismos.
   *
   * Antes cada proveedor traía el suyo en `flito_proveedores_soat.sla_horas` y quien no lo tenía
   * caía en un respaldo de 72 h. Eso hacía que el mismo retraso se pintara o no según con quién se
   * hubiera tramitado, que no es lo que mide esta señal: mide si la operación va al día.
   */
  SIN_GESTION_HORAS: 24,
} as const;

/**
 * Alertas operativas del tablero (Feature #10942 §5.2). Son excluyentes entre sí: un botón, un
 * valor. Cada una responde a «qué está en riesgo ahora mismo», no a un estado del trámite.
 */
export const ALERTAS_OPERATIVAS = [
  'borrador_5d', 'sin_aprobar_ans', 'soat_sin_gestion', 'impuesto_sin_gestion',
] as const;

export type AlertaOperativa = (typeof ALERTAS_OPERATIVAS)[number];

export const esAlertaOperativa = (v: unknown): v is AlertaOperativa =>
  typeof v === 'string' && (ALERTAS_OPERATIVAS as readonly string[]).includes(v);

export const ALERTA_OPERATIVA_LABEL: Record<AlertaOperativa, string> = {
  borrador_5d: `Más de ${ANS_OPERATIVO.BORRADOR_DIAS} días en borrador`,
  sin_aprobar_ans: `Más de ${ANS_OPERATIVO.SIN_APROBAR_DIAS} días sin aprobar (ANS)`,
  soat_sin_gestion: 'SOAT solicitado sin gestión',
  impuesto_sin_gestion: 'Impuesto solicitado sin gestión',
};

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
  /**
   * Los DOS estados del canal Cliente (Feature #11912, ADR-0008 §2). Solo los alcanza un SOAT con
   * `origen = 'cliente'`: el que nace del sync de trámites sigue entrando en `pendiente` y su ciclo
   * no cambia en nada.
   *
   *   pendiente_revision ── un cliente radicó la solicitud y Operaciones aún no la ha revisado.
   *                         NO es `pendiente`: `POST /enviar` filtra por `pendiente`, así que un
   *                         admin despachando la cola enviaría al gestor solicitudes sin validar.
   *   rechazada          ── Operaciones la devolvió con causal y observación; el cliente subsana y
   *                         vuelve a `pendiente_revision`.
   *
   * Van al MISMO enum (`flito_soat_estado`) y no a una columna aparte de la tabla satélite, para
   * que una fila tenga un solo estado y `POST /enviar` siga siendo correcto sin tocarlo.
   *
   * Quien los ESCRIBE es la HU #11914 (alta) y la #11915 (revisión). La #11913 solo los declara —y
   * eso ya obliga al compilador a completar cada `Record<EstadoSoat, X>`, que es la red que impide
   * que una pantalla pinte un estado en blanco.
   *
   * El gestor del proveedor NO los ve, y no por una regla nueva: `ESTADOS_SOAT_VISIBLES_GESTOR` es
   * una lista blanca que sigue siendo `['solicitado', 'pagado']`.
   */
  PENDIENTE_REVISION: 'pendiente_revision',
  RECHAZADA: 'rechazada',
} as const;

export type EstadoSoat = (typeof EstadoSoat)[keyof typeof EstadoSoat];

export const ESTADO_SOAT_LABEL: Record<EstadoSoat, string> = {
  pendiente: 'Pendiente',
  solicitado: 'Solicitado',
  con_novedad: 'Con novedad',
  pagado: 'Pagado',
  pendiente_revision: 'Pendiente de revisión',
  rechazada: 'Rechazada',
};

/**
 * RN-01: un SOAT se adquiere una sola vez por VIN. Solicitado y Pagado bloquean el reencolado;
 * Con novedad NO (se comporta como Pendiente: se corrige y se reenvía).
 *
 * Los dos estados del canal Cliente NO entran aquí, y es decisión escrita (ADR-0008 §2 y riesgo
 * abierto 1): ampliar esta lista cambia el contador de auditoría del sync, que no es alcance del
 * Feature #11912.
 */
export const ESTADOS_SOAT_BLOQUEAN_REENCOLADO: readonly EstadoSoat[] = [
  'solicitado', 'pagado',
];

export function soatBloqueaReencolado(estado: EstadoSoat): boolean {
  return (ESTADOS_SOAT_BLOQUEAN_REENCOLADO as readonly string[]).includes(estado);
}

/**
 * Estados del SOAT visibles para el gestor (nunca `Pendiente`). Ver DECISIONES.md §6.
 *
 * Es una LISTA BLANCA, y por eso los dos estados del canal Cliente quedan fuera sin escribir nada:
 * el gestor no ve lo que un cliente radicó hasta que Operaciones lo valida y pasa a `solicitado`.
 */
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

/**
 * RN-01 Impuestos: FLITO gestiona el impuesto SOLO si la compañía NO lo autogestiona Y el organismo
 * está en modalidad `requiere_gestion`. En cualquier otro caso lo gestiona alguien más y FLITO ni lo
 * paga ni lo cobra.
 *
 * Vive en el dominio compartido porque hay tres sitios que tienen que responder lo mismo y no pueden
 * discrepar: el sync —que por eso no crea registro de impuesto—, la liquidación —que por eso no lo
 * exige para sellar— y el reporte de costos —que por eso no lo pinta como una ausencia—. Estaba solo
 * dentro del sync, así que los otros dos deducían la respuesta mirando si existía el registro, que
 * es una pista, no la regla.
 */
export function flitoGestionaImpuesto(
  impuestosAutogestionable: boolean,
  modalidad: ModalidadOrganismo,
): boolean {
  return !impuestosAutogestionable && modalidad === ModalidadOrganismo.REQUIERE_GESTION;
}

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
  // HU #11335 — los dos documentos de la factura electrónica que FLITO emite ante la DIAN. Nada
  // que ver con `FACTURA_VENTA`, que es la del concesionario y llega de fuera. Viven en el mismo
  // catálogo porque acaban en la misma tabla y en la misma lista de la pantalla; lo que se deriva
  // de ellos (extensión, content-type, endpoint de Siigo) está en `siigo-archivo.ts`.
  FACTURA_ELECTRONICA_PDF: 'factura_electronica_pdf',
  FACTURA_ELECTRONICA_XML: 'factura_electronica_xml',
  // Feature #11623, HU #11678 — el comprobante del pago PSE de una boleta conciliada. Cuelga de la
  // BOLETA (`flito_soportes.conciliacion_boleta_id`), no de un SOAT ni de un trámite: la financiera
  // paga una boleta que agrupa N SOAT y el portal emite UN solo comprobante por ese pago.
  COMPROBANTE_PSE: 'comprobante_pse',
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
