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

/**
 * Los dos estados que SOLO existen en el canal Cliente (Feature #11912, HU #11915).
 *
 * Nombrados una vez y no repetidos como literales, porque de esta lista dependen tres reglas que
 * tienen que decir lo mismo o el ciclo se abre por la costura:
 *
 *   1. **`reversar()` no sale de ellos.** Sin esa guarda, un admin lleva una solicitud de
 *      `pendiente_revision` a `pendiente` y `POST /enviar` la despacha al gestor sin que nadie la
 *      haya validado — el AC1 saltado por la puerta de al lado.
 *   2. **`reversar()` no entra en ellos.** Lo prohíbe el ADR-0008 §8: devolver a `pendiente_revision`
 *      un SOAT ya validado deja al gestor sin la fila y al cliente con una solicitud que creía
 *      resuelta.
 *   3. **La pantalla no puede ofrecerlos como destino de reversa.** `ESTADOS_OPERACIONES` de
 *      `FlitoSoat.tsx` alimenta a la vez las pills de la cola Y el selector «Estado destino» de la
 *      reversa; añadir ahí los dos estados para que la pill funcione abriría el destino sin que
 *      nadie lo decidiera. La UI necesita las dos listas separadas, y esta es la que dice cuáles no
 *      son destino.
 *
 * NO es lo mismo que «estados que el gestor no ve»: eso ya lo dice `ESTADOS_SOAT_VISIBLES_GESTOR`,
 * que es una lista blanca y responde otra pregunta.
 */
export const ESTADOS_SOAT_CANAL_CLIENTE: readonly EstadoSoat[] = [
  'pendiente_revision', 'rechazada',
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

// ── Canal Cliente: catálogos que la pantalla de alta y la API tienen que compartir ────────────────
// (Feature #11912, HU #11914 — ADR-0008 §6)

/**
 * Tipos de documento del propietario, catálogo RUNT (AC1 de la HU #11914).
 *
 * Vive en shared-types y no en `apps/api/src/modules/runt/runt-tipo-doc.ts` porque lo necesitan LOS
 * DOS lados: el `z.enum` del alta y el desplegable del formulario. `runt-tipo-doc.ts` sigue siendo
 * el que TRADUCE cada uno al código de la pasarela (`CC → C`, `PPT → Y`…); esto es solo el catálogo
 * de lo que el producto ofrece, y un test de la API afirma que los ocho valores de aquí tienen
 * traducción allí — si alguien añade uno sin mapearlo, la consulta saldría con el tipo en blanco.
 *
 * El orden es el del refinamiento y es el que la pantalla pinta.
 */
export const TIPOS_DOCUMENTO_RUNT = ['CC', 'CE', 'TI', 'PAS', 'PPT', 'NIT', 'RC', 'PT'] as const;

export type TipoDocumentoRunt = (typeof TIPOS_DOCUMENTO_RUNT)[number];

/**
 * Códigos de error del alta del canal Cliente. Van en el cuerpo (`{ error, codigo }`) JUNTO al
 * estado HTTP, no en su lugar.
 *
 * **Por qué existen, y por qué en shared-types.** Los AC2, AC3 y AC4 piden tres desenlaces que el
 * formulario tiene que distinguir para poder responder distinto: reintentar (el RUNT falló), pintar
 * un modal («ya tiene SOAT vigente») o mandar al detalle de la solicitud que ya existe (RN-01). Tres
 * respuestas distintas del mismo `409`/`422` no se pueden separar por el estado HTTP, y separarlas
 * comparando el TEXTO del mensaje es lo que rompe la próxima vez que alguien corrija una tilde.
 *
 * Ninguno de estos códigos lleva dato del vehículo ni del propietario: son constantes, y el mensaje
 * que los acompaña es el que se le enseña a una persona.
 */
export const CodigoErrorSolicitudSoat = {
  /** El usuario `cliente` no tiene compañía (el CHECK de la 0168 lo impide; esto es la red). */
  SIN_COMPANIA: 'sin_compania',
  /** La compañía tiene el flag «SOAT sin trámite» APAGADO (AC5). */
  CANAL_DESACTIVADO: 'canal_desactivado',
  /** El RUNT no respondió o respondió un fallo (AC2) → el formulario puede reintentar. */
  RUNT_NO_DISPONIBLE: 'runt_no_disponible',
  /** El RUNT respondió, pero no tiene ese vehículo registrado (AC2). */
  RUNT_SIN_REGISTRO: 'runt_sin_registro',
  /** El organismo que reporta el RUNT no cruza con el catálogo de FLITO (AC2). */
  ORGANISMO_NO_CATALOGADO: 'organismo_no_catalogado',
  /** El RUNT dice que el vehículo YA tiene SOAT vigente (AC3) → modal, y no se compra. */
  SOAT_VIGENTE: 'soat_vigente',
  /** Ese VIN ya tiene fila en `flito_soat`, de trámite o de este canal, incluida una Rechazada (AC4). */
  VIN_YA_TIENE_SOAT: 'vin_ya_tiene_soat',
  /** El adjunto no es un PDF por CONTENIDO, no solo por extensión (AC5). */
  ARCHIVO_NO_PDF: 'archivo_no_pdf',

  // ── Revisión, rechazo y subsanación (HU #11915) ────────────────────────────────────────────────
  //
  // Se suman a los ocho de arriba en vez de estrenar un segundo catálogo: son el MISMO canal, los
  // sirven las mismas rutas y el cliente HTTP de la web ya sabe leer `codigo` de esta lista
  // (`apps/web/src/lib/soatCliente.ts` valida contra `Object.values(...)`). Un catálogo aparte
  // obligaría a duplicar esa validación y a decidir en cada `catch` cuál de los dos mirar.

  /** El id no existe, o no es de la compañía de quien pregunta (404-no-403 de `buscarConAcceso`). */
  SOLICITUD_NO_ENCONTRADA: 'solicitud_no_encontrada',
  /**
   * La fila existe pero NO nació del canal (`origen = 'tramite'`).
   *
   * No es un caso teórico: un `cliente` ve en su cola TODOS los SOAT de su compañía, también los que
   * creó el sync de trámites, y un `admin` los ve todos. Validar, rechazar o subsanar por estas
   * rutas un SOAT de trámite metería el ciclo del canal en un flujo que no lo tiene (AC1).
   */
  NO_ES_DEL_CANAL: 'no_es_del_canal',
  /** La transición no aplica desde el estado en el que está la fila (AC1, AC2, AC3). */
  ESTADO_NO_PERMITE: 'estado_no_permite',
  /** La causal no está en el catálogo general, o está desactivada (AC2). */
  CAUSAL_INVALIDA: 'causal_invalida',
  /** El rechazo llegó sin observación, o con una en blanco (AC2). */
  OBSERVACION_REQUERIDA: 'observacion_requerida',
  /**
   * Validar llegó sin destino, o con los dos.
   *
   * No es una formalidad del formulario: un `solicitado` sin proveedor y sin contingencia es un SOAT
   * en la cola de NADIE y sin ANS con el que medirlo — lo mismo que la HU #10979 arregló haciendo
   * obligatorio el proveedor en el envío masivo.
   */
  DESTINO_REQUERIDO: 'destino_requerido',
} as const;

export type CodigoErrorSolicitudSoat =
  (typeof CodigoErrorSolicitudSoat)[keyof typeof CodigoErrorSolicitudSoat];

/**
 * Una causal del catálogo de rechazo, tal como la sirve `GET /flito/soat/causales-rechazo`
 * (Feature #11912, HU #11915).
 *
 * Catálogo GENERAL: no hay causales por compañía, ni aquí ni en la tabla. Lo dice el AC2 y es además
 * el precedente del repo (`flito_comparendos_causales`).
 *
 * `activo` viaja aunque el endpoint solo devuelva las activas, y no es redundante: el detalle de un
 * rechazo YA REGISTRADO tiene que poder rotular una causal que se desactivó después, y sin el campo
 * la pantalla no distinguiría «esta causal ya no se ofrece» de «esta causal no existe».
 */
export interface CausalRechazoSoat {
  id: string;
  nombre: string;
  activo: boolean;
  orden: number;
}
