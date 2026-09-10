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
 *
 * Para TARIFAS usar `tipoTramiteTarifaDe` (flito-tarifas.ts): catálogo cerrado, sin tildes y sin
 * adivinar. Esta sigue sirviendo a siigo/mapeo-conceptos, que sí trabaja con texto libre.
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
/**
 * ── El canal Cliente vuelve a los CUATRO estados de siempre (Feature #12074, HU #12080) ──────────
 *
 * Entre el Feature #11912 y hoy hubo dos estados más —`pendiente_revision` y `rechazada`— que solo
 * alcanzaba un SOAT con `origen = 'cliente'`: la solicitud nacía en cuarentena y una persona de
 * Operaciones la validaba o la devolvía. Ese circuito se retira entero: desde la HU #12078 el alta
 * nace en `solicitado` con el gestor de la compañía ya escrito, y desde la #12079 la pantalla que
 * lo revisaba ya no existe. Dos estados a los que ya nadie llega no son un ciclo, son una trampa:
 * cualquier `Record<EstadoSoat, X>` obligaba a inventarles un color y una etiqueta, y `reversar()`
 * tenía que seguir defendiéndose de un destino inalcanzable.
 *
 * La migración 0176 los saca también del tipo de Postgres, y lo hace ABORTANDO si queda alguna fila
 * en ellos. Por eso quitarlos de aquí no es «limpieza de tipos»: es el contrato compartido diciendo
 * lo mismo que la base.
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
 *
 * Desde la HU #12080 no hay más estados que estos cuatro, así que la lista no tiene que declarar
 * ninguna exclusión: los dos del canal Cliente que el ADR-0008 §2 dejaba fuera ya no existen.
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
 * Sigue siendo una LISTA BLANCA y sigue diciendo lo mismo que antes de la HU #12080: el gestor ve
 * lo que está en su cola y lo ya pagado. Lo que cambia es que una solicitud del canal entra en
 * `solicitado` desde el alta (HU #12078), sin pasar por ninguna cuarentena previa.
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

/**
 * Los tipos de documento que se pueden pedir en el ZIP de soportes (Feature #11908, HU #11910).
 *
 * ── Por qué es un catálogo NUEVO y no un subconjunto de `TipoSoporte` ────────────────────────────
 *
 * Porque `factura_venta` significa DOS cosas distintas según de qué cuelgue, y el que hace falta
 * aquí no es el que está en `TipoSoporte`:
 *
 *   · `TipoSoporte.FACTURA_VENTA` sobre `flito_soportes.soat_id` es el adjunto que **sube el
 *     cliente** al radicar o al subsanar (`TIPOS_SOPORTE_VISIBLES_CLIENTE` lo documenta: «es SU
 *     PROPIO adjunto»).
 *   · `TipoSoporteZip.FACTURA_VENTA` es la **factura de venta que emite FLIT**, que ni siquiera vive
 *     en `flito_soportes`: es `flito_tramites.factura_venta_flit_id` → S3 de FLIT.
 *
 * Son dos documentos de dos orígenes con el mismo literal. Reutilizar el enum habría hecho que
 * «marcar factura de venta» en Trámites metiera en el ZIP el adjunto del cliente creyendo que mete
 * la factura de FLIT —o las dos—, sin que ningún tipo lo impidiera. Y `RECIBO_IMPUESTO` tampoco es
 * un alias: en el ZIP resuelve a `recibo_impuesto_sin_marca_agua` con caída a `recibo_impuesto` (ver
 * `shared/soportes/soportes-zip.ts`), o sea a UN documento de entre DOS tipos de la tabla.
 *
 * Lo que este catálogo nombra es «qué puede marcar el usuario en la pantalla», no «qué fila hay en
 * la base». Cada superficie admite un subconjunto: SOAT solo `FACTURA_SOAT`, Impuestos los dos
 * primeros, Trámites los tres.
 */
export const TipoSoporteZip = {
  /** La factura de venta que emite FLIT (S3 de FLIT), NO el adjunto del canal Cliente. */
  FACTURA_VENTA: 'factura_venta',
  /** El recibo del organismo: el limpio (`sin_marca_agua`) y, si no existe, el marcado. */
  RECIBO_IMPUESTO: 'recibo_impuesto',
  /** El comprobante/póliza que sube el gestor de SOAT. Nunca el comprobante PSE de conciliación. */
  FACTURA_SOAT: 'factura_soat',
} as const;

export type TipoSoporteZip = (typeof TipoSoporteZip)[keyof typeof TipoSoporteZip];

/**
 * El ORDEN FIJO del catálogo, y no es decoración: es la mitad del desempate del AC5.
 *
 * Todas las entradas de un mismo registro se llaman igual (`PLACA-ORGANISMO`), así que el sufijo
 * `-2`/`-3` lo decide el orden en que se recorren. Si ese orden fuera el del array que mandó la
 * pantalla —o el de `Object.keys` de un mapa—, el mismo lote pedido dos veces produciría dos
 * repartos distintos de los sufijos y dos ZIP no comparables. Aquí está escrito una vez y el
 * servidor no admite otro.
 */
export const ORDEN_TIPOS_SOPORTE_ZIP: readonly TipoSoporteZip[] = [
  TipoSoporteZip.FACTURA_VENTA,
  TipoSoporteZip.RECIBO_IMPUESTO,
  TipoSoporteZip.FACTURA_SOAT,
];

/**
 * `codigo` del 409 cuando NINGUNO de los registros marcados tiene el tipo pedido (AC6).
 *
 * La pantalla decide por este código y no por el texto del mensaje. Existe para que el usuario no
 * reciba un ZIP vacío de 22 bytes que abre y no entiende, que es lo que producía el molde heredado
 * —escribía las cabeceras y hacía `pipe` ANTES de saber si habría contenido—.
 */
export const CODIGO_ZIP_SIN_SOPORTES = 'zip_sin_soportes';

/**
 * `codigo` del 422 cuando la suma de BYTES del lote se pasa del presupuesto del ZIP.
 *
 * ⚠️ **No es el mismo caso que {@link CODIGO_ZIP_DEMASIADOS_REGISTROS}, y el copy no puede
 * confundirlos.** Este es por PESO: pocos documentos muy pesados, y se resuelve quitando de la
 * selección los registros con documentos grandes. El otro es por CANTIDAD y se resuelve marcando
 * menos filas, aunque cada una pese nada. Con un solo código el mensaje tendría que ser vago para
 * servir a los dos, y no diría la verdad en ninguno.
 */
export const CODIGO_ZIP_DEMASIADO_GRANDE = 'zip_demasiado_grande';

/**
 * `codigo` del 400 cuando se marcan más de {@link ZIP_SOPORTES_MAX_REGISTROS} registros.
 *
 * **400 y no 422**, a diferencia del de peso: aquella petición está bien formada y lo que no cabe es
 * el RESULTADO; esta no se debe intentar siquiera. Es el mismo criterio con el que
 * `TOPE_LOTE_CERTIFICACION` decide su 400 —«pedir 40 registros no es un lote que salió regular, es
 * una petición que no se debe intentar»—.
 *
 * Tiene código propio porque sin él caía en la rama genérica de Zod, sin `codigo`, y la pantalla
 * enseñaba «no se pudo generar el archivo, avisa a soporte»: el mensaje inútil que el UX quería
 * evitar, y justo en el error más fácil de provocar.
 */
export const CODIGO_ZIP_DEMASIADOS_REGISTROS = 'zip_demasiados_registros';

/**
 * Cuántos registros admite UNA petición de ZIP de soportes.
 *
 * **No es el presupuesto.** Ese va en BYTES (`FLITO_ZIP_SOPORTES_MAX_BYTES`, perilla de entorno)
 * porque lo que cuesta es el archivo que hay detrás del id, no el id. Esto es la forma del cuerpo:
 * un array sin cota se convierte en un `IN (…)` sin cota.
 *
 * Vive aquí y no solo en el API por lo mismo que `FLITO_COLA_EXPORT_MAX_FILAS`: la pantalla lo
 * necesita para avisar ANTES de que el usuario provoque el error, y el servidor lo usa como cota
 * dura. Con dos copias, el aviso diría un número y el backend aplicaría otro.
 *
 * Aun así el servidor manda el número DENTRO del mensaje del 400: el cliente lo hace eco sin tener
 * que estar compilado contra la misma versión de este paquete.
 */
export const ZIP_SOPORTES_MAX_REGISTROS = 100;

/**
 * Cabeceras con las que el ZIP dice CUÁNTO trae, para el aviso del caso parcial.
 *
 * «Marqué 5 y solo 2 tenían soporte» se acordó como «se descarga y se avisa con cifras». El cuerpo
 * de la respuesta es el archivo, así que el único sitio donde caben esas cifras es la cabecera. Se
 * nombran aquí y no como literales en las dos puntas porque **el nombre de la cabecera ES el
 * contrato**: un literal repetido en cliente y servidor se desincroniza sin que nada avise, y el
 * síntoma sería que el aviso vuelve al genérico —en verde y sin error en ninguna parte—.
 *
 * ── Son DOS cifras distintas y hay que elegir la buena ───────────────────────────────────────────
 *
 * `incluidos` cuenta DOCUMENTOS; `registros` cuenta REGISTROS marcados que aportaron al menos uno.
 * En SOAT casi coinciden; en el ZIP mixto de Trámites **no**, porque un trámite aporta hasta tres
 * documentos. Para componer «2 de las 5 que marcaste» hay que usar `registros`: con `incluidos`
 * saldría «6 de 5», una cifra falsa con aspecto de cierta.
 *
 * ── Lo que NO dicen, y es deliberado ─────────────────────────────────────────────────────────────
 *
 * Ninguna distingue POR QUÉ un registro no aportó: «no existe», «no es de este actor» y «no tiene
 * ese documento» son el mismo silencio. Publicar la causa convertiría el ZIP en un oráculo de
 * pertenencia, que es justo lo que evita el 409 cuando no queda ninguno.
 */
export const CABECERAS_ZIP_SOPORTES = {
  /** Cuántos DOCUMENTOS lleva el archivo. */
  incluidos: 'X-Soportes-Incluidos',
  /** De cuántos REGISTROS marcados salió al menos un documento. */
  registros: 'X-Soportes-Registros',
} as const;

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
  /**
   * El organismo que reporta el RUNT no cruza con el catálogo de FLITO.
   *
   * **Desde la HU #11966 (ADR-0010) ya NO es un error HTTP de ninguno de los dos endpoints del
   * canal**: el organismo no es compuerta (AC5), así que la solicitud se crea igual con
   * `organismo_codigo` NULL y este código queda anotado en
   * `flito_soat_solicitud.verificacion_codigo`. Se conserva en el catálogo porque sigue siendo el
   * vocabulario de esa columna.
   */
  ORGANISMO_NO_CATALOGADO: 'organismo_no_catalogado',
  /**
   * Placa o VIN que el RUNT trajo DIFIERE de lo radicado, o los datos no corresponden con los
   * propietarios activos del vehículo. Un campo que el RUNT no trajo (`NO_VERIFICABLE`) no es este
   * código.
   *
   * **Desde la HU #11966 ABORTA el alta con un 422** (AC2), además de seguir siendo un valor del
   * satélite para las filas históricas de la #11935. Es una respuesta de NEGOCIO —el registro sí
   * contestó—, y por eso no puede salir como el 503 de `RUNT_NO_DISPONIBLE`: esa distinción es
   * literalmente el AC4. Cuando lo que no cuadra es el VIN tecleado, el cuerpo lleva además
   * `campo: 'vin'` — y **nunca** el VIN que trajo el RUNT, que convertiría el endpoint en un lector
   * de VIN por placa.
   */
  RUNT_NO_CUADRA: 'runt_no_cuadra',
  /**
   * El RUNT tiene el vehículo pero **no publica su VIN**, así que no hay VIN efectivo que persistir
   * (HU #11966, AC5: «sin VIN en la respuesta del RUNT no se crea (RN-01)»).
   *
   * Código propio y no `RUNT_NO_CUADRA`: «revise los datos» le dice al usuario que corrija algo
   * suyo, y aquí no hay nada que corregir. `flito_soat.vin` es NOT NULL UNIQUE y es la columna sobre
   * la que vive la RN-01, así que sin VIN no se puede crear la fila. Es la única forma de que la
   * pantalla no mienta.
   */
  RUNT_SIN_VIN: 'runt_sin_vin',
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
 * La familia «revise los datos»: los tres desenlaces en los que el RUNT **sí respondió** y la
 * respuesta impide crear la solicitud (HU #11966, AC2 y AC5).
 *
 * Se exporta para que la pantalla del wizard (#11967) no tenga que re-listar la familia y para que
 * no la deduzca del estado HTTP ni del texto del mensaje: los tres son `422`, pero `422` no es
 * sinónimo de esta familia y el mensaje cambia con cualquier corrección de estilo.
 *
 * **`RUNT_NO_DISPONIBLE` no está, y esa ausencia es el AC4**: «el RUNT no está disponible» es un
 * fallo de TRANSPORTE (503) y presentarlo como «revise los datos» le pide al usuario que corrija
 * algo que no está mal. La distinción se decide por transporte —HTTP 200 = el RUNT respondió—, no
 * por el texto que mande Kyverum.
 */
export const CODIGOS_REVISE_LOS_DATOS = [
  CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO,
  CodigoErrorSolicitudSoat.RUNT_NO_CUADRA,
  CodigoErrorSolicitudSoat.RUNT_SIN_VIN,
] as const;

/**
 * Desenlace de la verificación RUNT del canal Cliente. Nace con la HU #11935 (ADR-0009) como estado
 * de un job post-commit; **desde la HU #11966 (ADR-0010) el alta es bloqueante y una fila nueva nace
 * en `ok`**.
 *
 * Los otros cuatro valores son RESIDUO HISTÓRICO: solo los llevan las solicitudes radicadas entre la
 * #11935 y la #11966, que no se reescriben ni se reconsultan (AC6 de la #11966). Siguen aquí y en el
 * CHECK de la base porque esas filas existen y hay que poder leerlas; no porque se puedan producir.
 *
 * `ok` no estaba en el AC2 de la #11935 (listaba los desenlaces de fallo + pendiente); hacía falta
 * para no dejar el éxito indistinguible de «aún no corrió», y hoy es el único que se escribe.
 */
export const ESTADOS_VERIFICACION_SOLICITUD_SOAT = [
  'pendiente', 'caido', 'sin_registro', 'no_cuadra', 'ok',
] as const;

export type EstadoVerificacionSolicitudSoat =
  (typeof ESTADOS_VERIFICACION_SOLICITUD_SOAT)[number];

// `CausalRechazoSoat` vivía aquí: el catálogo que servía `GET /flito/soat/causales-rechazo`
// (Feature #11912, HU #11915). Se retira con la HU #12080 junto al endpoint que lo publicaba y a la
// tabla `flito_soat_causales_rechazo` que lo guardaba (migración 0176). No queda ningún productor
// ni ningún consumidor del tipo, y dejarlo declarado invitaría a escribir una pantalla contra un
// catálogo que ya no existe en la base.

// ─────────────── Verificación diaria de vigencia contra el RUNT (Feature #12075) ─────────────────

/**
 * Lo que la verificación de las 00:10 escribe en `flito_soat.estado_vigencia` (HU #12096).
 *
 * **Tres valores, no cuatro**, y esa es la decisión que hay que entender antes de tocar nada:
 * `vencido` NO se persiste. Se DERIVA en el servidor comparando `vence_el` contra el día de Bogotá,
 * porque un SOAT que hoy está vigente mañana está vencido sin que nadie lo haya tocado — guardarlo
 * como estado obligaría a reescribir filas cada medianoche para que la columna dejara de mentir.
 * El vocabulario de pantalla (con `vencido` dentro) es {@link VIGENCIAS_SOAT_VISTA}.
 *
 * **No se confunde con `ESTADOS_VERIFICACION_SOLICITUD_SOAT`**, que es la compuerta RUNT del ALTA
 * del canal Cliente (`pendiente|caido|sin_registro|no_cuadra|ok`), otro momento y otro dueño. El
 * parecido de `sin_registro` es superficial: allí significa «el registro no conoce el vehículo que
 * se está radicando» y aquí «el RUNT no reporta SOAT vigente para un vehículo que FLITO ya pagó».
 *
 *   · `vigente`       — el RUNT respondió y reporta póliza vigente.
 *   · `sin_registro`  — el RUNT respondió y NO la reporta (vencida, sin póliza, o sin vehículo).
 *   · `no_verificado` — no hubo respuesta. **No dice nada del vehículo**, y por eso no es un «no».
 */
export const ESTADOS_VIGENCIA_SOAT = ['vigente', 'sin_registro', 'no_verificado'] as const;

export type EstadoVigenciaSoat = (typeof ESTADOS_VIGENCIA_SOAT)[number];

export const esEstadoVigenciaSoat = (v: unknown): v is EstadoVigenciaSoat =>
  typeof v === 'string' && (ESTADOS_VIGENCIA_SOAT as readonly string[]).includes(v);

/**
 * El vocabulario de PANTALLA: los tres persistidos más `vencido`, que el servidor deriva.
 *
 * Es también el de los tres filtros de la cola (`vencido`, `sin_registro`, `no_verificado`); no se
 * ofrece filtrar por `vigente` porque nadie barre la cola buscando lo que está bien.
 */
export const VIGENCIAS_SOAT_VISTA = ['vigente', 'vencido', 'sin_registro', 'no_verificado'] as const;

export type VigenciaSoatVista = (typeof VIGENCIAS_SOAT_VISTA)[number];

/** Los tres que la cola acepta como filtro. `vigente` no está: ver {@link VIGENCIAS_SOAT_VISTA}. */
export const FILTROS_VIGENCIA_COLA = ['vencido', 'sin_registro', 'no_verificado'] as const;

export type FiltroVigenciaCola = (typeof FILTROS_VIGENCIA_COLA)[number];

export const esFiltroVigenciaCola = (v: unknown): v is FiltroVigenciaCola =>
  typeof v === 'string' && (FILTROS_VIGENCIA_COLA as readonly string[]).includes(v);

/**
 * Por qué no se pudo consultar. **Vocabulario CERRADO**, y ese es todo el punto.
 *
 * Son las mismas cuatro clases que `causaDeCaida()` del canal Cliente produce a partir del mensaje
 * de la pasarela. Que sean cuatro tokens fijos —y no el `err.message`— es lo que permite guardarlas
 * en `flito_soat_verificacion_corridas.motivos` y loguearlas sin abrir una vía de PII: el mensaje de
 * un tercero puede traer dentro la placa o el VIN con los que se consultó, y `logger` no redacta lo
 * que no reconoce.
 */
export const MOTIVOS_CAIDA_RUNT = ['timeout', 'red', 'circuito', 'otro'] as const;

export type MotivoCaidaRunt = (typeof MOTIVOS_CAIDA_RUNT)[number];

/**
 * El `jsonb` de `flito_soat_verificacion_corridas.motivos`: cuántas caídas de cada clase, más
 * cuántos reintentos POR VEHÍCULO se gastaron en la corrida (un total, no un mapa por vehículo —
 * eso sería una lista de identificadores en una columna que nadie necesita para operar).
 *
 * Todas las claves son opcionales y su ausencia significa CERO. Un `Record` completo obligaría a
 * escribir los cuatro ceros en cada corrida buena, que es ruido con forma de dato.
 */
export type ResumenMotivosCorrida = Partial<Record<MotivoCaidaRunt, number>> & {
  /** Consultas repetidas por un mismo vehículo dentro de la corrida (tope `MAX_REINTENTOS_VEHICULO`). */
  reintentos?: number;
};
