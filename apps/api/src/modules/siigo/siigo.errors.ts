// Siigo API — traducción de errores al dominio (HU #11250, ampliada por la HU #11339).
//
// Siigo devuelve `{ Status, Errors: [{ Code, Message, Params, Detail }] }`. Ese objeto es útil para
// depurar y malo para operar: nadie sabe si `document_settings` se arregla reintentando o si hay que
// entrar a Siigo Nube a cambiar algo.
//
// Aquí se responde a las tres únicas preguntas que importan aguas arriba:
//   1. ¿Se reintenta? — decide si la operación vuelve a la cola o se para a esperar a un humano.
//   2. ¿Qué le digo a quien opera? — un texto accionable, no el mensaje crudo en inglés.
//   3. ¿Qué hay que hacer y a quién le toca? — la acción concreta y su responsable (HU #11339).
//
// La tercera pregunta es la que convierte el módulo en algo usable: `invalid_dian_resolution` ya
// decía que la resolución estaba vencida, pero quien opera la facturación no puede renovarla — la
// renueva contabilidad en Siigo Nube — y reintentar no sirve de nada. Sin esa capa, el texto informa
// pero no desatasca.
//
// UN SOLO CATÁLOGO (AC2 de la HU #11339). Descripción, acción, responsable y reintentabilidad viven
// en la misma entrada de `CATALOGO`: añadir un código de Siigo es tocar un único sitio. El conjunto
// de códigos transitorios se DERIVA del catálogo en vez de mantenerse aparte, que era justo la
// duplicación que dejaba códigos con reintento pero sin texto (`entry_service`, `general_service`).
//
// El comportamiento por defecto es NO reintentar. Es deliberado: Siigo bloquea el usuario API si
// durante 7 días más del 80 % de las peticiones son errores, así que ante un código desconocido
// callar y reintentar es peor que parar y avisar.

import { ETIQUETA_RESPONSABLE } from '@operaciones/shared-types';
import type { GuiaErrorSiigo, ResponsableError } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import { sanearMensaje } from './siigo.redaccion.js';

// La FORMA de una guía y la tabla de responsables se mudaron a `@operaciones/shared-types` en la
// HU #11340: la bandeja de fallidos devuelve una guía por caso y la pantalla que la pinta necesita
// el mismo tipo. Se reexportan para que todo lo que ya los importaba de aquí siga funcionando sin
// tocar un solo archivo. **Lo que NO se movió es `guiaParaCodigo`**, y no es un olvido: depende del
// catálogo de códigos, del saneamiento y del registro de códigos sin catalogar, que son del
// servidor. Mover la función habría llevado el catálogo entero al navegador.
export { ETIQUETA_RESPONSABLE };
export type { GuiaErrorSiigo, ResponsableError };

const log = loggerFor('siigo-errores');

/** Código sintético cuando la respuesta no cumple la estructura documentada. */
export const CODIGO_RESPUESTA_INESPERADA = 'respuesta_inesperada';

/**
 * Frase de reintento (AC3).
 *
 * Se deriva del error concreto en vez de repetirse en cada entrada del catálogo: son dos frases
 * fijas y da igual el código: o el dato es nuestro y hay que corregirlo, o Siigo no estaba y vuelve
 * solo. Escribirla 58 veces es garantizar que 58 se desincronicen.
 */
const FRASE_REINTENTO = {
  si: 'Se reintenta automáticamente: no hace falta intervenir.',
  no: 'Reintentar no lo arregla: hay que corregir el origen antes de volver a emitir.',
  /**
   * La tercera, que faltaba (HU #11340). Sin ella, un código que no vuelve solo pero que se
   * desatasca reintentándolo a mano tenía que elegir entre dos frases falsas: `si` prometía que no
   * hacía falta intervenir —y hacía falta— y `no` afirmaba que reintentar no lo arregla, que es
   * justo lo contrario de lo que hay que hacer con él.
   */
  manual: 'No vuelve solo, pero reintentarlo desde la bandeja sí puede salir bien.',
} as const;

interface EntradaCatalogo {
  /** Qué pasó, en lenguaje operativo. */
  descripcion: string;
  /** Qué hay que hacer para resolverlo. */
  accion: string;
  /** Quién lo hace. */
  responsable: ResponsableError;
  /**
   * «Vuelve solo». Solo en los códigos transitorios; ausente = no vuelve, que es el defecto seguro.
   *
   * **Implica `responsable: 'automatico'`**, y hay una prueba que lo exige: si el sistema lo
   * reintenta sin ayuda, no hay nadie a quien mandar a arreglarlo.
   */
  reintentable?: true;
  /**
   * «No vuelve solo, pero reintentarlo a mano sirve» (HU #11340).
   *
   * Es la casilla de los códigos en los que el sistema ya se rindió —o que nunca reintenta, como el
   * reenvío de un correo— y en los que aun así volver a intentarlo es lo correcto. **No implica
   * `automatico`**: precisamente lo que dice es que hace falta que una persona pulse.
   *
   * Nunca se pone junto a `reintentable`: son excluyentes por definición.
   */
  reintentoManual?: true;
}

/**
 * Catálogo único de códigos de Siigo.
 *
 * Lo que no está aquí cae a la entrada genérica de `entradaDesconocida`, que sí es accionable y deja
 * el código registrado para añadirlo (AC4).
 */
const CATALOGO: Record<string, EntradaCatalogo> = {
  already_exists: {
    descripcion: 'El registro ya existe en Siigo Nube.',
    accion: 'Busca el registro en Siigo Nube y úsalo en vez de crear otro; si el duplicado es el que querías, da la operación por aplicada.',
    responsable: 'operacion',
  },
  blocked_transactions: {
    descripcion: 'Las transacciones están bloqueadas en Siigo Nube para esa fecha o documento.',
    accion: 'Emite con una fecha dentro del periodo abierto, o pide a contabilidad que levante el bloqueo de transacciones en Siigo Nube.',
    responsable: 'contabilidad',
  },
  company_settings: {
    descripcion: 'Falta configurar algo en la empresa de Siigo Nube.',
    accion: 'Pide a contabilidad que complete los datos de la empresa en Siigo Nube antes de reintentar la emisión.',
    responsable: 'contabilidad',
  },
  customer_settings: {
    descripcion: 'La configuración del cliente en Siigo Nube impide la operación.',
    accion: 'Revisa la ficha fiscal del cliente en FLITO (tipo de persona, responsabilidades y correo) y corrígela; si el cliente ya existe en Siigo Nube con otros datos, contabilidad debe ajustarlo allí.',
    responsable: 'operacion',
  },
  date_settings: {
    descripcion: 'La fecha no está permitida por la configuración de Siigo Nube.',
    accion: 'Usa una fecha dentro del periodo habilitado; si necesitas esa fecha en concreto, contabilidad debe abrir el periodo.',
    responsable: 'operacion',
  },
  delete_not_allowed: {
    descripcion: 'Siigo no permite borrar este documento en su estado actual.',
    accion: 'No se borra: contabilidad debe anularlo con una nota crédito desde Siigo Nube.',
    responsable: 'contabilidad',
  },
  disabled_functionality: {
    descripcion: 'La funcionalidad no está habilitada en el plan de Siigo Nube.',
    accion: 'Contabilidad debe habilitarla con Siigo; hasta entonces esta operación no se puede emitir por la integración.',
    responsable: 'contabilidad',
  },
  document_settings: {
    descripcion: 'La configuración del tipo de comprobante en Siigo Nube impide la operación.',
    accion: 'Pide a contabilidad que revise el tipo de comprobante en Siigo Nube: prefijo, resolución asociada y consecutivo.',
    responsable: 'contabilidad',
  },
  documents_service: {
    descripcion: 'El servicio de documentos de Siigo no respondió. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  duplicated_document: {
    descripcion: 'Ya existe un documento con ese consecutivo en Siigo Nube.',
    accion: 'Comprueba en Siigo Nube si la factura ya quedó emitida: si quedó, no la vuelvas a emitir; si no, contabilidad debe corregir el consecutivo de la resolución.',
    responsable: 'operacion',
  },
  entry_service: {
    descripcion: 'El servicio de comprobantes contables de Siigo no respondió. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  general_service: {
    descripcion: 'Un servicio interno de Siigo no respondió. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  header_required: {
    descripcion: 'Falta una cabecera obligatoria en la petición.',
    accion: 'Es un defecto de la integración, no un dato mal capturado: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  invalid_account: {
    descripcion: 'La cuenta contable indicada no es válida.',
    accion: 'Pide a contabilidad la cuenta correcta y actualiza con ella el mapeo de conceptos de FLITO.',
    responsable: 'contabilidad',
  },
  invalid_amount: {
    descripcion: 'Un valor monetario no es válido.',
    accion: 'Revisa los importes del documento (unitario, descuento e impuestos): deben ser numéricos, no negativos y con dos decimales como máximo.',
    responsable: 'operacion',
  },
  invalid_array: {
    descripcion: 'Un arreglo de la petición no cumple lo esperado.',
    accion: 'Es un defecto de la integración: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  invalid_balance: {
    descripcion: 'El saldo no permite la operación.',
    accion: 'Contabilidad debe revisar en Siigo Nube el saldo del tercero o del documento antes de volver a intentarlo.',
    responsable: 'contabilidad',
  },
  invalid_code: {
    descripcion: 'Un código enviado no existe o no está activo en Siigo Nube.',
    accion: 'Comprueba en Siigo Nube el código señalado (producto, forma de pago o vendedor): dejó de existir o se inactivó. Al reenviar, las listas se leen de Siigo en el momento, así que ya no aparecerá.',
    responsable: 'operacion',
  },
  invalid_cost_center: {
    descripcion: 'El centro de costos no existe o está inactivo.',
    accion: 'Al reenviar, elige un centro de costos activo en el paso de emisión, o pide a contabilidad que reactive ese en Siigo Nube.',
    responsable: 'operacion',
  },
  invalid_currency: {
    descripcion: 'La moneda no está configurada en Siigo Nube.',
    accion: 'Contabilidad debe habilitar la moneda en Siigo Nube; mientras tanto, emite en pesos.',
    responsable: 'contabilidad',
  },
  invalid_date: {
    descripcion: 'La fecha no es válida. En facturas electrónicas no se admite una fecha anterior a hoy.',
    accion: 'Emite con la fecha de hoy. Si la operación es de un día anterior, esa diferencia se documenta aparte: la DIAN no acepta retroactivos.',
    responsable: 'operacion',
  },
  invalid_date_range: {
    descripcion: 'El rango de fechas no es válido.',
    accion: 'Corrige el rango: la fecha inicial debe ser anterior a la final y ambas dentro de lo que admite Siigo.',
    responsable: 'operacion',
  },
  invalid_description: {
    descripcion: 'La descripción no cumple el formato esperado.',
    accion: 'Acorta la descripción y quítale saltos de línea y caracteres especiales antes de reintentar.',
    responsable: 'operacion',
  },
  invalid_dian_resolution: {
    descripcion: 'La resolución DIAN no es válida o está vencida. Revísala en Siigo Nube.',
    accion: 'Contabilidad debe renovar o activar la resolución DIAN en Siigo Nube. Hasta que esté vigente, ninguna factura de ese prefijo se va a emitir.',
    responsable: 'contabilidad',
  },
  invalid_document: {
    descripcion: 'El tipo de comprobante no es válido para esta operación.',
    accion: 'Confirma con contabilidad qué tipo de comprobante corresponde y elígelo en el paso de emisión al reenviar.',
    responsable: 'contabilidad',
  },
  invalid_email: {
    descripcion: 'Un correo electrónico no tiene un formato válido.',
    accion: 'Corrige el correo en la ficha del cliente en FLITO: es por donde la DIAN entrega la factura, así que sin él no hay emisión.',
    responsable: 'operacion',
  },
  invalid_identification: {
    descripcion: 'El número de identificación del tercero no es válido.',
    accion: 'Corrige la identificación en la ficha del cliente en FLITO: sin puntos ni guiones, y con el dígito de verificación que corresponda al NIT.',
    responsable: 'operacion',
  },
  'invalid_idempotency-key': {
    descripcion: 'La clave de idempotencia no cumple el formato exigido por Siigo.',
    accion: 'Es un defecto de la integración: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  invalid_name: {
    descripcion: 'El nombre no cumple el formato esperado.',
    accion: 'Revisa el nombre del tercero en FLITO: según el tipo de persona Siigo espera razón social o nombres y apellidos separados.',
    responsable: 'operacion',
  },
  invalid_partner_id: {
    descripcion: 'La cabecera Partner-Id no es válida. Revisa SIIGO_PARTNER_ID.',
    accion: 'Es configuración de la integración: soporte técnico debe corregir SIIGO_PARTNER_ID. No hay nada que corregir en el documento.',
    responsable: 'soporte',
  },
  invalid_payment: {
    descripcion: 'La forma de pago no es válida, no está activa, o maneja fecha de vencimiento.',
    // FLITO no maneja plazo, así que no envía `due_date`; una forma de pago con vencimiento lo
    // exige y la factura se cae. Normalmente no se puede elegir una así —el selector las esconde
    // leyendo `due_date` del catálogo—, de modo que llegar aquí significa que la configuración
    // cambió en Siigo Nube después de elegirla, y eso es lo que hay que decir.
    accion: 'Elige una forma de pago de contado al reenviar. Si esa forma de pago maneja fecha de vencimiento en Siigo Nube, no sirve: FLITO no factura a crédito. Contabilidad puede activarla como de contado o indicar cuál usar.',
    responsable: 'operacion',
  },
  invalid_plan_type: {
    descripcion: 'El plan contratado en Siigo Nube no permite esta operación.',
    accion: 'Contabilidad debe gestionar con Siigo la ampliación del plan; no se resuelve desde FLITO.',
    responsable: 'contabilidad',
  },
  invalid_range: {
    descripcion: 'Un valor está fuera del rango permitido.',
    accion: 'Ajusta el valor señalado al rango que admite Siigo y vuelve a emitir.',
    responsable: 'operacion',
  },
  invalid_reference: {
    descripcion: 'Una referencia enviada no existe en Siigo Nube.',
    accion: 'Comprueba que el documento o registro referenciado exista en Siigo Nube y vuelve a sincronizar los catálogos en FLITO.',
    responsable: 'operacion',
  },
  invalid_retentions: {
    descripcion: 'Las retenciones enviadas no son válidas.',
    accion: 'Contabilidad debe confirmar qué retenciones aplican a ese tercero; después se ajusta la parametrización en FLITO.',
    responsable: 'contabilidad',
  },
  invalid_total_payments: {
    descripcion: 'La suma de las formas de pago no coincide con el total del documento.',
    accion: 'Cuadra las formas de pago con el total: la diferencia tiene que ser cero, sin redondeos.',
    responsable: 'operacion',
  },
  invalid_type: {
    descripcion: 'Un tipo enviado no es válido.',
    accion: 'Revisa el tipo señalado en la parametrización de FLITO contra el catálogo de Siigo y corrígelo.',
    responsable: 'operacion',
  },
  invalid_url: {
    descripcion: 'Una URL enviada no es válida.',
    accion: 'Es un defecto de la integración: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  invalid_value: {
    descripcion: 'Un valor enviado no es válido.',
    accion: 'Corrige en FLITO el campo señalado y vuelve a emitir.',
    responsable: 'operacion',
  },
  length_max: {
    descripcion: 'Un campo supera la longitud máxima permitida.',
    accion: 'Acorta el campo señalado en FLITO hasta el límite que admite Siigo.',
    responsable: 'operacion',
  },
  length_min: {
    descripcion: 'Un campo no alcanza la longitud mínima exigida.',
    accion: 'Completa el campo señalado en FLITO antes de volver a emitir.',
    responsable: 'operacion',
  },
  non_editable: {
    descripcion: 'El documento no es editable en su estado actual.',
    accion: 'Ya está en firme: si hay que cambiarlo, contabilidad lo anula con nota crédito en Siigo Nube y se emite de nuevo.',
    responsable: 'contabilidad',
  },
  not_found: {
    descripcion: 'El recurso no existe en Siigo Nube.',
    accion: 'Comprueba que exista en Siigo Nube y vuelve a sincronizar los catálogos en FLITO; puede haberse borrado allí.',
    responsable: 'operacion',
  },
  parameter_empty: {
    descripcion: 'Un parámetro obligatorio llegó vacío.',
    accion: 'Completa en FLITO el campo señalado y vuelve a emitir.',
    responsable: 'operacion',
  },
  parameter_inactive: {
    descripcion: 'Un parámetro referenciado está inactivo en Siigo Nube.',
    accion: 'Cámbialo por uno activo desde FLITO, o pide a contabilidad que lo reactive en Siigo Nube.',
    responsable: 'operacion',
  },
  parameter_not_allowed: {
    descripcion: 'Un parámetro enviado no está permitido para esta operación.',
    accion: 'Es un defecto de la integración: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  parameter_required: {
    descripcion: 'Falta un parámetro obligatorio.',
    accion: 'Completa en FLITO el campo señalado y vuelve a emitir.',
    responsable: 'operacion',
  },
  parameters_exclusive: {
    descripcion: 'Se enviaron parámetros mutuamente excluyentes.',
    accion: 'Es un defecto de la integración: repórtalo a soporte técnico con el identificador de la operación.',
    responsable: 'soporte',
  },
  payment_types_service: {
    descripcion: 'El servicio de formas de pago de Siigo no respondió. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  product_settings: {
    descripcion: 'La configuración del producto en Siigo Nube impide la operación.',
    accion: 'Pide a contabilidad que complete el producto en Siigo Nube (impuestos y cuenta contable) antes de reintentar.',
    responsable: 'contabilidad',
  },
  request_timeout: {
    descripcion: 'Siigo no alcanzó a responder. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  requests_limit: {
    descripcion: 'Se superó el límite de 100 peticiones por minuto. Se reintenta automáticamente.',
    accion: 'Espera: la cola vuelve a enviarlo cuando pase el minuto. Si se repite todos los días, soporte técnico debe revisar el ritmo de emisión.',
    responsable: 'automatico',
    reintentable: true,
  },
  read_only: {
    descripcion: 'La cuenta de Siigo Nube está en modo SOLO LECTURA: no admite crear ningún documento.',
    // No es un problema de esta factura ni de su parametrización: es de la cuenta entera, y hasta
    // que se levante no va a emitirse nada. Merece decirlo así de claro, porque el síntoma —una
    // factura que se rechaza— invita a revisar el comprobante, el cliente o el producto, y ahí no
    // hay nada que arreglar.
    //
    // `reintentable: false` a propósito: reintentar contra una cuenta en solo lectura gasta cuota
    // para obtener exactamente el mismo rechazo, y llena de errores la bitácora que alimenta el
    // freno de emisión.
    accion: 'Contabilidad debe revisar el estado del producto Siigo Nube (suscripción, pago o plan): mientras esté en solo lectura, NINGUNA factura se puede emitir. No es un problema de este trámite.',
    responsable: 'contabilidad',
  },
  [CODIGO_RESPUESTA_INESPERADA]: {
    descripcion: 'Siigo respondió algo que no cumple la estructura de error que documenta.',
    accion: 'Si se repite, repórtalo a soporte técnico con el identificador de la operación: suele ser una caída de Siigo o un cambio en su API.',
    responsable: 'soporte',
  },
  service_unavailable: {
    descripcion: 'Siigo no está disponible en este momento. Se puede reintentar.',
    accion: 'Si el fallo se repite durante más de una hora, avisa a soporte técnico para que revise el estado de Siigo.',
    responsable: 'automatico',
    reintentable: true,
  },
  unauthorized: {
    descripcion: 'Siigo rechazó la autorización de la petición.',
    accion: 'Soporte técnico debe revisar las credenciales de Siigo configuradas en FLITO (usuario API y access key). No es un problema del documento.',
    responsable: 'soporte',
  },
  unhandled_error: {
    descripcion: 'Siigo devolvió un error no controlado.',
    accion: 'Repórtalo a soporte técnico con el identificador de la operación: reintentarlo suele devolver exactamente el mismo error.',
    responsable: 'soporte',
  },
  update_not_allowed: {
    descripcion: 'Siigo no permite modificar este documento en su estado actual.',
    accion: 'Si hay que cambiarlo, contabilidad debe anularlo con nota crédito en Siigo Nube y emitirlo de nuevo.',
    responsable: 'contabilidad',
  },
  values_limit: {
    descripcion: 'Se superó el número de valores permitidos.',
    accion: 'Divide el documento en varios: tiene más ítems de los que Siigo admite en una sola factura.',
    responsable: 'operacion',
  },
  warehouse_settings: {
    descripcion: 'La configuración de la bodega en Siigo Nube impide la operación.',
    accion: 'Pide a contabilidad que revise la bodega en Siigo Nube, o selecciona otra en la parametrización de FLITO.',
    responsable: 'contabilidad',
  },

  // ── Códigos que pone FLITO, no Siigo (HU #11340) ───────────────────────────────────────────
  //
  // **Por qué están en ESTE catálogo y no en otro.** `siigo_cola_facturacion.error_code` y
  // `siigo_facturas.error_code` no solo guardan códigos de Siigo: el trabajador escribe ahí
  // `no_elegible`, `emision_en_curso` o `error_interno` cuando el fallo ocurre antes de salir a la
  // red, y el acta de envío escribe `cliente_sin_correo`. La bandeja de fallidos lee esas columnas y
  // pide una guía por código: sin estas entradas, la mayoría de los casos que hay que operar cada
  // día se pintaban como «un código que FLITO todavía no traduce», que es justo el mensaje genérico
  // que toda la HU #11339 existe para no dar. Además ensuciaban `codigosSinCatalogar()`, que es la
  // alarma de «falta un código de Siigo», con códigos nuestros que no faltaban.
  //
  // **Qué se marca reintentable y por qué importa.** `CODIGOS_REINTENTABLES` se deriva de aquí y lo
  // consume `esReintentable`, que el trabajador llama en la rama `desenlace === 'fallida'`. En esa
  // rama el código SIEMPRE viene de Siigo (`describirFallo` solo devuelve códigos nuestros con
  // `respondio: false`, que no llega a esa rama), así que ninguna de estas entradas cambia lo que
  // hace el trabajador: solo deciden si la bandeja ofrece reintentar o exige corregir un dato (AC3).
  cliente_sin_correo: {
    descripcion: 'El cliente no tiene ningún correo utilizable en su ficha.',
    accion: 'Completa el correo de facturación en la ficha del cliente en FLITO y vuelve a pedir el envío. Reenviar ahora no manda nada: no hay a dónde.',
    responsable: 'operacion',
  },
  demasiados_destinatarios: {
    descripcion: 'El envío lleva más direcciones de las que Siigo admite.',
    accion: 'Deja como máximo cinco direcciones en la ficha del cliente o en el envío manual y vuelve a pedirlo.',
    responsable: 'operacion',
  },
  destinatario_invalido: {
    descripcion: 'Alguna de las direcciones de correo no tiene forma de dirección.',
    accion: 'Corrige la dirección en la ficha del cliente en FLITO y vuelve a pedir el envío.',
    responsable: 'operacion',
  },
  dian_rechazada: {
    descripcion: 'La DIAN rechazó el documento.',
    accion: 'No se reintenta: la factura ya existe y reintentar emitiría un segundo documento. Contabilidad debe corregirla en Siigo Nube y registrar la corrección en FLITO.',
    responsable: 'contabilidad',
  },
  emision_datos: {
    descripcion: 'Faltan datos para armar la factura, o alguno no cuadra.',
    accion: 'Revisa la liquidación y la ficha fiscal del cliente; corrígelas y vuelve a enviar el trámite a facturación.',
    responsable: 'operacion',
  },
  emision_en_curso: {
    descripcion: 'Otro proceso tenía tomada la emisión de este lote cuando le tocó el turno.',
    // Nada salió de FLITO por nuestra parte: la clave la tenía otro. Vuelve solo y sin riesgo.
    accion: 'No hace falta hacer nada: vuelve a intentarse solo en el próximo ciclo.',
    responsable: 'automatico',
    reintentable: true,
  },
  emision_sin_configuracion: {
    descripcion: 'El lote no trae con qué emitir: falta comprobante, vendedor o forma de pago.',
    accion: 'Vuelve a enviar los trámites desde el reporte de costos eligiendo la emisión. Reintentar este lote no lo arregla: la configuración se guarda al enviar.',
    responsable: 'operacion',
  },
  emision_sin_correo: {
    descripcion: 'Siigo no mandó el correo al crear la factura.',
    accion: 'Pide el reenvío desde la bandeja: la factura está emitida y lo único que falta es la entrega.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  emision_sin_mapeo: {
    descripcion: 'Algún concepto de la factura no tiene producto de Siigo asignado.',
    accion: 'Completa el mapeo de conceptos en la parametrización de FLITO y vuelve a reintentar la emisión.',
    responsable: 'operacion',
  },
  emision_sin_tramites: {
    descripcion: 'El lote no tiene trámites: no hay nada que facturar.',
    accion: 'Vuelve a enviar los trámites desde el reporte de costos. Este lote es anterior al registro de pertenencia y no se puede reconstruir.',
    responsable: 'operacion',
  },
  error_interno: {
    descripcion: 'Falló algo de FLITO antes de llegar a pedirle nada a Siigo.',
    // `automatico` con fundamento: este código se reserva para el fallo que ocurre ANTES de salir a
    // la red (ver `comoResultado` en el trabajador, que lo distingue de `huerfana` justo por eso).
    // No hay documento que pueda existir en Siigo, así que la fila vuelve sola sin riesgo.
    accion: 'Vuelve a intentarse solo. Si se repite en varias facturas, pásalo a soporte técnico con la hora exacta.',
    responsable: 'automatico',
    reintentable: true,
  },
  factura_no_emitida: {
    descripcion: 'La factura todavía no existe en Siigo: no está emitida o falló al emitirse.',
    accion: 'Primero hay que emitirla. Reintenta la emisión desde la bandeja; el correo se pide después.',
    responsable: 'operacion',
  },
  no_elegible: {
    descripcion: 'El trámite no cumple las condiciones para facturarse.',
    accion: 'Mira el detalle: dice qué condición falta. Corrígela y vuelve a enviar el trámite a facturación.',
    responsable: 'operacion',
  },
  reconciliada_inexistente: {
    descripcion: 'La reconciliación comprobó que el documento no existe en Siigo.',
    accion: 'Se puede reintentar la emisión: no hay documento ante la DIAN que pueda duplicarse.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  resuelta_a_mano: {
    descripcion: 'Una persona comprobó en Siigo que la factura no llegó a crearse.',
    accion: 'Ya está comprobado que no hay documento: reintentar la emisión desde la bandeja es seguro.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  siigo_no_responde: {
    descripcion: 'Siigo no contestó: se agotaron los intentos sin recibir respuesta.',
    accion: 'No se sabe si la petición llegó. Comprueba en Siigo Nube antes de reintentar; si no hay documento, reintentar es seguro.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  siigo_rechazo: {
    descripcion: 'Siigo rechazó el envío del correo.',
    // El reenvío NUNCA es automático —no hay cron que lo intente— así que `reintentable` sería
    // mentira aunque el fallo sea pasajero. Lo que hay es un botón, y eso es `reintentoManual`.
    accion: 'Reinténtalo desde la bandeja: suele ser pasajero. Si vuelve a fallar, mira el detalle del acta de envío.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  sin_desenlace: {
    descripcion: 'El ciclo terminó sin que nadie dijera qué pasó con la emisión.',
    // NO es `automatico`, y la diferencia importa: este código cubre también la fila huérfana, es
    // decir, una emisión que PUEDE existir en Siigo. Decir «no hace falta intervenir» invitaría a
    // reintentar a ciegas sobre un documento que quizá ya está ante la DIAN.
    accion: 'Comprueba en Siigo Nube si la factura llegó a crearse; si no está, reintenta desde la bandeja.',
    responsable: 'operacion',
    reintentoManual: true,
  },
  sin_factura_local: {
    descripcion: 'La emisión terminó sin dejar fila de factura en FLITO.',
    accion: 'Compruébalo en Siigo Nube antes de tocar nada: puede existir un documento que FLITO no registró. Si no existe, vuelve a enviar el trámite.',
    responsable: 'operacion',
  },
};

/**
 * Códigos transitorios, DERIVADOS del catálogo.
 *
 * Antes era una lista aparte y por eso `entry_service` y `general_service` se reintentaban sin tener
 * texto que enseñar. Un solo sitio donde añadir códigos (AC2) es lo que impide que vuelva a pasar.
 */
const CODIGOS_REINTENTABLES = new Set(
  Object.entries(CATALOGO).filter(([, e]) => e.reintentable === true).map(([codigo]) => codigo),
);

/** Códigos que el catálogo traduce hoy. Para diagnóstico y para que las pruebas cubran todos. */
export function codigosCatalogados(): string[] {
  return Object.keys(CATALOGO).sort();
}

/**
 * Estados HTTP transitorios cuando la respuesta no trae código.
 *
 * El 500 queda FUERA a propósito: `unhandled_error` suele repetirse con el mismo cuerpo, y
 * reintentarlo consume cuota para volver a fallar igual.
 */
const STATUS_REINTENTABLES = new Set([408, 429, 502, 503, 504]);

// ---------------------------------------------------------------------------------------------
// Saneo de lo que llega por el cable (AC5)
// ---------------------------------------------------------------------------------------------

/** Sustituto de cualquier cosa con pinta de credencial que llegue en un código o en un campo. */
export const MARCA_SECRETO_OMITIDO = '[dato sensible omitido]';

/** Un código de Siigo es un identificador corto; más que esto es basura o un intento de inyección. */
const MAX_CODIGO = 60;

/** La lista de campos viene de Siigo; se acota para que no empuje fuera al texto que sí importa. */
const MAX_CAMPOS = 200;

/**
 * Cosas con forma de secreto.
 *
 * La defensa de verdad es estructural: el texto operativo se ARMA con el catálogo y nunca reproduce
 * el `Message` ni el `Detail` que devolvió Siigo, que son los únicos sitios por donde podría venir
 * un volcado. Esto es la segunda línea, por si un código o un nombre de campo trae dentro algo que
 * no debería salir del proceso.
 */
/**
 * Cuántos `Params` se miran. El array lo llena Siigo, no nosotros.
 */
const MAX_PARAMS = 10;

/** Lo que se enseña en lugar de un `param` que no tiene forma de nombre de campo. */
export const MARCA_CAMPO_OMITIDO = '[valor omitido]';

/**
 * Forma de un NOMBRE DE CAMPO. Lo que no la tenga, no se muestra.
 *
 * **Lista blanca, y aquí está el porqué.** `Params` debería traer la ruta del campo que Siigo
 * rechazó (`customer.identification`), pero eso no está documentado y el array lo llena el
 * proveedor: para códigos como `invalid_identification` o `invalid_email` es perfectamente posible
 * que devuelva el VALOR rechazado —una cédula, un correo— en vez de la ruta. Ese texto acaba en
 * `siigo_factura_estados_dian.motivo` y en `siigo_operaciones.mensaje`, dos tablas append-only que
 * NO están en el flujo de olvido: un dato personal que entre ahí no se puede rectificar ni suprimir.
 *
 * `redactarSecretos` no basta y no es su culpa: es una lista negra de credenciales —`bearer`, JWT,
 * `token:`— y ninguna lista negra reconoce una cédula suelta ni un correo. La misma lección que la
 * HU #11332 aplicó al payload del sondeo, aplicada aquí: si no se puede enumerar lo peligroso, hay
 * que enumerar lo aceptable.
 *
 * Un nombre de campo no lleva arroba, ni espacios, ni rachas largas de dígitos. Un valor sí.
 */
const FORMA_DE_CAMPO = /^(?!.*\d{6})[A-Za-z_][A-Za-z0-9_.[\]-]{0,59}$/;

const PATRONES_SECRETO: RegExp[] = [
  /\bbearer\s+[\w.~+/-]+=*/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g,
  /\b(access[_-]?key|api[_-]?key|password|clave|secret|token|authorization)\b\s*[:=]\s*\S+/gi,
];

function redactarSecretos(texto: string): string {
  return PATRONES_SECRETO.reduce((acc, patron) => acc.replace(patron, MARCA_SECRETO_OMITIDO), texto);
}

/**
 * Cómo se muestra el campo que Siigo señala. **Una sola definición, y por eso está exportada.**
 *
 * Los `Params` de Siigo son datos de fuera: pasan por `redactarSecretos` y se acotan. Quien los
 * pinte por su cuenta —componiendo el motivo de un rechazo, por ejemplo— se saltaría esa defensa
 * sin enterarse, y tendríamos dos formas distintas de enseñar lo mismo con distinto nivel de
 * protección. La HU #11333 la usa por esto.
 */
export function campoLegible(params: readonly string[] | undefined): string {
  const admitidos = (params ?? [])
    // Tope de elementos ANTES de unir: el array lo llena el proveedor y `join` sobre cientos de
    // miles de cadenas construye un texto de cientos de MB antes de que nadie lo recorte.
    .slice(0, MAX_PARAMS)
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p !== '')
    // Lo que no tiene forma de campo se SUSTITUYE, no se descarta. Descartarlo en silencio haría
    // que un rechazo con un solo error pareciera no señalar ningún campo, y quien lo lea no sabría
    // si Siigo no dijo nada o si dijo algo que no se pudo enseñar. La marca conserva esa diferencia.
    .map((p) => (FORMA_DE_CAMPO.test(p) ? p : MARCA_CAMPO_OMITIDO));

  return recortar(admitidos.join(', '), MAX_CAMPOS);
}

function recortar(valor: string, max: number): string {
  const limpio = redactarSecretos(valor).trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}

// ---------------------------------------------------------------------------------------------
// Códigos que el catálogo no conoce (AC4)
// ---------------------------------------------------------------------------------------------

/** Tope del registro: un código desconocido no puede convertirse en una fuga de memoria. */
const MAX_CODIGOS_DESCONOCIDOS = 200;

const CODIGOS_DESCONOCIDOS = new Set<string>();

/**
 * Deja constancia de un código que el catálogo no traduce.
 *
 * Se registra una sola vez por código y proceso: si Siigo empieza a devolver un código nuevo en cada
 * factura de la noche, interesa saberlo, no tener 4.000 líneas iguales en la bitácora.
 */
function registrarCodigoDesconocido(codigo: string): void {
  if (CODIGOS_DESCONOCIDOS.has(codigo)) return;
  if (CODIGOS_DESCONOCIDOS.size >= MAX_CODIGOS_DESCONOCIDOS) return;
  CODIGOS_DESCONOCIDOS.add(codigo);
  log.warn({ codigo }, 'Código de error de Siigo sin traducir: añádelo al catálogo de siigo.errors');
}

/** Códigos vistos que aún no están en el catálogo. Para diagnóstico y para saber qué añadir. */
export function codigosSinCatalogar(): string[] {
  return [...CODIGOS_DESCONOCIDOS].sort();
}

/** Solo para pruebas: el registro es memoria de proceso y los tests corren en serie. */
export function olvidarCodigosSinCatalogar(): void {
  CODIGOS_DESCONOCIDOS.clear();
}

/** Entrada genérica pero accionable, que además nombra el código original (AC4). */
function entradaDesconocida(codigo: string): EntradaCatalogo {
  return {
    descripcion: `Siigo rechazó la operación con un código que FLITO todavía no traduce (${codigo}).`,
    accion: 'Mira el detalle de la operación en la bitácora y, si no es evidente, pasa el código a soporte técnico para que lo añada al catálogo.',
    responsable: 'soporte',
  };
}

/**
 * Anota el código si el catálogo no lo traduce.
 *
 * Se llama al traducir el error —cuando nace, aunque nadie llegue a pintarlo— y al resolverlo contra
 * el catálogo. Un código que Siigo devuelve de madrugada y que nadie mira hasta el lunes tiene que
 * estar registrado igual: para eso sirve el registro.
 */
function anotarSiDesconocido(codigo: string): void {
  if (enCatalogo(codigo)) return;
  registrarCodigoDesconocido(recortar(codigo, MAX_CODIGO));
}

/**
 * ¿El catálogo tiene ESTE código, o solo lo hereda del prototipo?
 *
 * `CATALOGO` es un objeto literal, así que `CATALOGO['constructor']` devuelve la función `Object`
 * —truthy— y `CATALOGO['toString']` una función. Sin esta comprobación, un `Code: "constructor"`
 * en la respuesta de Siigo se daba por conocido, su `descripcion` era `undefined`, y la cadena
 * literal «undefined» acababa escrita en una columna append-only que no se puede corregir. Además
 * silenciaba el registro de códigos sin catalogar, que es la alarma de que falta uno.
 */
function enCatalogo(codigo: string): boolean {
  return Object.hasOwn(CATALOGO, codigo);
}

/** Punto ÚNICO de resolución de un código contra el catálogo. */
function buscarEntrada(codigo: string): { entrada: EntradaCatalogo; conocido: boolean } {
  const entrada = enCatalogo(codigo) ? CATALOGO[codigo] : undefined;
  if (entrada) return { entrada, conocido: true };
  anotarSiDesconocido(codigo);
  return { entrada: entradaDesconocida(recortar(codigo, MAX_CODIGO)), conocido: false };
}

// ---------------------------------------------------------------------------------------------
// Construcción del texto que lee quien opera
// ---------------------------------------------------------------------------------------------

/**
 * Guía para un código suelto.
 *
 * Existe aparte de `SiigoApiError` porque la bandeja de fallidos lee códigos ya persistidos, cuando
 * el objeto de error hace rato que se perdió. Sin `reintentable` explícito manda el catálogo.
 */
export function guiaParaCodigo(
  codigo: string,
  opciones: { params?: string[]; reintentable?: boolean } = {},
): GuiaErrorSiigo {
  const { entrada, conocido } = buscarEntrada(codigo);
  const reintentable = opciones.reintentable ?? entrada.reintentable === true;
  // El reintento a mano NO se puede sobrescribir desde fuera: `opciones.reintentable` existe para
  // que un `SiigoApiError` imponga «este lote concreto no se reintenta» sobre el defecto del
  // catálogo, y eso es una propiedad del error vivo. Que un código se pueda desatascar pulsando un
  // botón es una propiedad del CÓDIGO, y no cambia según quién pregunte.
  const reintentoManual = !reintentable && entrada.reintentoManual === true;
  const campos = campoLegible(opciones.params);
  const responsableEtiqueta = ETIQUETA_RESPONSABLE[entrada.responsable];

  const partes = [entrada.descripcion];
  if (campos.length > 0) partes.push(`Campo: ${campos}.`);
  if (reintentable) partes.push(FRASE_REINTENTO.si);
  else partes.push(reintentoManual ? FRASE_REINTENTO.manual : FRASE_REINTENTO.no);
  partes.push(entrada.accion);
  partes.push(`Lo resuelve: ${responsableEtiqueta}.`);

  return {
    codigo,
    descripcion: entrada.descripcion,
    accion: entrada.accion,
    responsable: entrada.responsable,
    responsableEtiqueta,
    reintentable,
    reintentoManual,
    sirveReintentar: reintentable || reintentoManual,
    conocido,
    // `sanearMensaje` corta volcados de SQL y acota la longitud: el mismo saneo que protege la
    // bitácora WORM protege lo que se le enseña a quien opera.
    texto: sanearMensaje(partes.join(' ')),
  };
}

export interface DetalleErrorSiigo {
  code: string;
  message: string;
  params: string[];
  detail: string | null;
}

/**
 * Error de la API de Siigo ya clasificado.
 *
 * `toJSON` está redefinido para que serializarlo dé una forma estable y sin sorpresas. Los secretos
 * nunca llegan hasta aquí: el cuerpo de la petición no se guarda en el error, solo la respuesta.
 */
export class SiigoApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: string[];
  readonly detail: string | null;
  readonly reintentable: boolean;
  /** Todos los errores devueltos, no solo el primero. */
  readonly errores: DetalleErrorSiigo[];
  /** Cuerpo crudo cuando no cumplía la estructura documentada. Para diagnosticar. */
  readonly cuerpoCrudo: string | null;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    params?: string[];
    detail?: string | null;
    reintentable: boolean;
    errores?: DetalleErrorSiigo[];
    cuerpoCrudo?: string | null;
  }) {
    super(args.message);
    this.name = 'SiigoApiError';
    this.status = args.status;
    this.code = args.code;
    this.params = args.params ?? [];
    this.detail = args.detail ?? null;
    this.reintentable = args.reintentable;
    this.errores = args.errores ?? [];
    this.cuerpoCrudo = args.cuerpoCrudo ?? null;
  }

  /**
   * Qué hacer, quién lo hace y si vuelve solo.
   *
   * Manda `this.reintentable` sobre el defecto del catálogo: un lote con un error de datos dentro no
   * se reintenta aunque el código principal sea transitorio, y la guía tiene que decir eso.
   */
  get guia(): GuiaErrorSiigo {
    return guiaParaCodigo(this.code, { params: this.params, reintentable: this.reintentable });
  }

  /** Texto para quien opera: qué pasó y, si Siigo lo dice, en qué campo. */
  get descripcionOperativa(): string {
    const { entrada } = buscarEntrada(this.code);
    if (this.params.length === 0) return entrada.descripcion;
    // `campoLegible` y no `params.join`, que era lo que había aquí. Los dos pintaban lo mismo y solo
    // uno filtraba, así que la lista blanca de la HU #11333 protegía el motivo de rechazo y dejaba
    // esta puerta abierta — y este texto acaba en `siigo_operaciones.mensaje`, que es WORM: lo que
    // entra ahí no se puede rectificar ni suprimir. Siigo documenta que `Params` trae nombres de
    // campo, pero nada lo garantiza, y el día que traiga un valor sería una identificación en una
    // tabla donde los arts. 8.d y 8.e de la Ley 1581 ya no se pueden ejercer.
    const campos = campoLegible(this.params);
    if (!campos) return entrada.descripcion;
    return `${entrada.descripcion} Campo: ${campos}.`;
  }

  /** Qué hay que hacer para resolverlo. */
  get accionSugerida(): string {
    return this.guia.accion;
  }

  /** Quién lo resuelve. */
  get responsable(): ResponsableError {
    return this.guia.responsable;
  }

  toJSON(): Record<string, unknown> {
    const guia = this.guia;
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      params: this.params,
      detail: this.detail,
      reintentable: this.reintentable,
      descripcionOperativa: this.descripcionOperativa,
      accionSugerida: guia.accion,
      responsable: guia.responsable,
      responsableEtiqueta: guia.responsableEtiqueta,
      textoOperativo: guia.texto,
    };
  }
}

interface CuerpoErrorSiigo {
  Status?: number;
  Errors?: Array<{ Code?: string; Message?: string; Params?: string[]; Detail?: string }>;
}

function esCuerpoDeError(v: unknown): v is CuerpoErrorSiigo {
  return typeof v === 'object' && v !== null && Array.isArray((v as CuerpoErrorSiigo).Errors);
}

/**
 * ¿Se puede reintentar? Manda el código; el estado HTTP solo decide cuando no hay código.
 *
 * Un código de datos con un 503 sigue siendo un error de datos: reintentarlo no lo arregla.
 */
export function esReintentable(code: string | null, status: number): boolean {
  if (code) return CODIGOS_REINTENTABLES.has(code);
  return STATUS_REINTENTABLES.has(status);
}

/**
 * Convierte una respuesta fallida de Siigo en un `SiigoApiError`.
 *
 * Nunca lanza por sí misma: una respuesta rara produce un error genérico con el cuerpo conservado,
 * no una excepción sin controlar encima de la que ya estamos gestionando.
 */
export function traducirErrorSiigo(status: number, datos: unknown): SiigoApiError {
  if (esCuerpoDeError(datos) && datos.Errors!.length > 0) {
    const errores: DetalleErrorSiigo[] = datos.Errors!.map((e) => ({
      code: e.Code ?? 'sin_codigo',
      message: e.Message ?? 'Siigo no describió el error.',
      params: Array.isArray(e.Params) ? e.Params : [],
      detail: e.Detail ?? null,
    }));
    const principal = errores[0]!;
    // Reintentable solo si TODOS lo son: basta un error de datos para que reintentar sea inútil.
    const reintentable = errores.every((e) => esReintentable(e.code, status));
    // Se anotan TODOS, no solo el principal: un código nuevo escondido en el segundo error del lote
    // es exactamente el que nunca se descubriría mirando pantallas.
    errores.forEach((e) => anotarSiDesconocido(e.code));

    return new SiigoApiError({
      status: datos.Status ?? status,
      code: principal.code,
      message: principal.message,
      params: principal.params,
      detail: principal.detail,
      reintentable,
      errores,
    });
  }

  // Estructura no documentada: una página HTML, un cuerpo vacío, un texto suelto. Se conserva
  // recortado para poder diagnosticar sin llenar la bitácora con una página entera.
  const crudo = datos === null || datos === undefined
    ? null
    : (typeof datos === 'string' ? datos : safeStringify(datos)).slice(0, 2000);

  return new SiigoApiError({
    status,
    code: CODIGO_RESPUESTA_INESPERADA,
    message: `Siigo respondió ${status} con un cuerpo que no cumple la estructura de error documentada.`,
    reintentable: esReintentable(null, status),
    cuerpoCrudo: crudo,
  });
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
