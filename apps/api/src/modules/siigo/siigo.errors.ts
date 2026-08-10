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

import { loggerFor } from '../../shared/logger.js';
import { sanearMensaje } from './siigo.redaccion.js';

const log = loggerFor('siigo-errores');

/** Código sintético cuando la respuesta no cumple la estructura documentada. */
export const CODIGO_RESPUESTA_INESPERADA = 'respuesta_inesperada';

/**
 * Quién resuelve el error.
 *
 * Las tres primeras son las del AC1. `soporte` se añadió porque hay errores que no puede tocar ni
 * quien opera ni contabilidad —una cabecera mal formada, `SIIGO_PARTNER_ID`, un código que Siigo
 * inventó ayer—: mandarlos a operación es mandarlos a un callejón sin salida.
 */
export type ResponsableError = 'operacion' | 'contabilidad' | 'soporte' | 'automatico';

/** Cómo se nombra a cada responsable en el texto que lee quien opera. */
export const ETIQUETA_RESPONSABLE: Record<ResponsableError, string> = {
  operacion: 'quien opera la facturación, desde FLITO',
  contabilidad: 'contabilidad, en Siigo Nube',
  soporte: 'soporte técnico de FLITO',
  automatico: 'nadie: se resuelve solo',
};

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
} as const;

interface EntradaCatalogo {
  /** Qué pasó, en lenguaje operativo. */
  descripcion: string;
  /** Qué hay que hacer para resolverlo. */
  accion: string;
  /** Quién lo hace. */
  responsable: ResponsableError;
  /** Solo en los códigos transitorios. Ausente = no se reintenta, que es el defecto seguro. */
  reintentable?: true;
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
    accion: 'Vuelve a sincronizar los catálogos de Siigo en FLITO y comprueba el código señalado (producto, forma de pago o vendedor).',
    responsable: 'operacion',
  },
  invalid_cost_center: {
    descripcion: 'El centro de costos no existe o está inactivo.',
    accion: 'Elige un centro de costos activo en la parametrización de FLITO, o pide a contabilidad que reactive ese en Siigo Nube.',
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
    accion: 'Confirma con contabilidad qué tipo de comprobante corresponde y ajústalo en la configuración de emisión de FLITO.',
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
    descripcion: 'La forma de pago no es válida o no está activa.',
    accion: 'Elige otra forma de pago en FLITO, o pide a contabilidad que active esa en Siigo Nube.',
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
const PATRONES_SECRETO: RegExp[] = [
  /\bbearer\s+[\w.~+/-]+=*/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g,
  /\b(access[_-]?key|api[_-]?key|password|clave|secret|token|authorization)\b\s*[:=]\s*\S+/gi,
];

function redactarSecretos(texto: string): string {
  return PATRONES_SECRETO.reduce((acc, patron) => acc.replace(patron, MARCA_SECRETO_OMITIDO), texto);
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
  if (CATALOGO[codigo]) return;
  registrarCodigoDesconocido(recortar(codigo, MAX_CODIGO));
}

/** Punto ÚNICO de resolución de un código contra el catálogo. */
function buscarEntrada(codigo: string): { entrada: EntradaCatalogo; conocido: boolean } {
  const entrada = CATALOGO[codigo];
  if (entrada) return { entrada, conocido: true };
  anotarSiDesconocido(codigo);
  return { entrada: entradaDesconocida(recortar(codigo, MAX_CODIGO)), conocido: false };
}

// ---------------------------------------------------------------------------------------------
// Construcción del texto que lee quien opera
// ---------------------------------------------------------------------------------------------

/**
 * Guía completa de un error: qué pasó, qué hacer, quién lo hace y si vuelve solo.
 *
 * `texto` es la versión de una sola cadena, ya saneada, para pintarla tal cual en la bandeja de
 * fallidos; los campos sueltos están para agrupar y filtrar sin volver a parsear la frase.
 */
export interface GuiaErrorSiigo {
  codigo: string;
  descripcion: string;
  accion: string;
  responsable: ResponsableError;
  responsableEtiqueta: string;
  reintentable: boolean;
  /** `false` cuando el código no está en el catálogo y la guía es la genérica. */
  conocido: boolean;
  texto: string;
}

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
  const campos = recortar((opciones.params ?? []).join(', '), MAX_CAMPOS);
  const responsableEtiqueta = ETIQUETA_RESPONSABLE[entrada.responsable];

  const partes = [entrada.descripcion];
  if (campos.length > 0) partes.push(`Campo: ${campos}.`);
  partes.push(reintentable ? FRASE_REINTENTO.si : FRASE_REINTENTO.no);
  partes.push(entrada.accion);
  partes.push(`Lo resuelve: ${responsableEtiqueta}.`);

  return {
    codigo,
    descripcion: entrada.descripcion,
    accion: entrada.accion,
    responsable: entrada.responsable,
    responsableEtiqueta,
    reintentable,
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
    const campos = recortar(this.params.join(', '), MAX_CAMPOS);
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
