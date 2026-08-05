// Siigo API — traducción de errores al dominio (HU #11250).
//
// Siigo devuelve `{ Status, Errors: [{ Code, Message, Params, Detail }] }`. Ese objeto es útil para
// depurar y malo para operar: nadie sabe si `document_settings` se arregla reintentando o si hay que
// entrar a Siigo Nube a cambiar algo.
//
// Aquí se responde a las dos únicas preguntas que importan aguas arriba:
//   1. ¿Se reintenta? — decide si la operación vuelve a la cola o se para a esperar a un humano.
//   2. ¿Qué le digo a quien opera? — un texto accionable, no el mensaje crudo en inglés.
//
// El comportamiento por defecto es NO reintentar. Es deliberado: Siigo bloquea el usuario API si
// durante 7 días más del 80 % de las peticiones son errores, así que ante un código desconocido
// callar y reintentar es peor que parar y avisar.

/** Códigos que describen una condición pasajera: la misma petición puede funcionar más tarde. */
const CODIGOS_REINTENTABLES = new Set([
  'requests_limit',
  'service_unavailable',
  'request_timeout',
  'documents_service',
  'payment_types_service',
  'entry_service',
  'general_service',
]);

/**
 * Estados HTTP transitorios cuando la respuesta no trae código.
 *
 * El 500 queda FUERA a propósito: `unhandled_error` suele repetirse con el mismo cuerpo, y
 * reintentarlo consume cuota para volver a fallar igual.
 */
const STATUS_REINTENTABLES = new Set([408, 429, 502, 503, 504]);

/** Texto operativo por código. Lo que no está aquí cae al mensaje genérico. */
const DESCRIPCION: Record<string, string> = {
  already_exists: 'El registro ya existe en Siigo Nube.',
  blocked_transactions: 'Las transacciones están bloqueadas en Siigo Nube para esa fecha o documento.',
  company_settings: 'Falta configurar algo en la empresa de Siigo Nube.',
  customer_settings: 'La configuración del cliente en Siigo Nube impide la operación.',
  date_settings: 'La fecha no está permitida por la configuración de Siigo Nube.',
  delete_not_allowed: 'Siigo no permite borrar este documento en su estado actual.',
  disabled_functionality: 'La funcionalidad no está habilitada en el plan de Siigo Nube.',
  document_settings: 'La configuración del tipo de comprobante en Siigo Nube impide la operación.',
  documents_service: 'El servicio de documentos de Siigo no respondió. Se puede reintentar.',
  duplicated_document: 'Ya existe un documento con ese consecutivo en Siigo Nube.',
  header_required: 'Falta una cabecera obligatoria en la petición.',
  invalid_account: 'La cuenta contable indicada no es válida.',
  invalid_amount: 'Un valor monetario no es válido.',
  invalid_array: 'Un arreglo de la petición no cumple lo esperado.',
  invalid_balance: 'El saldo no permite la operación.',
  invalid_code: 'Un código enviado no existe o no está activo en Siigo Nube.',
  invalid_cost_center: 'El centro de costos no existe o está inactivo.',
  invalid_currency: 'La moneda no está configurada en Siigo Nube.',
  invalid_date: 'La fecha no es válida. En facturas electrónicas no se admite una fecha anterior a hoy.',
  invalid_date_range: 'El rango de fechas no es válido.',
  invalid_description: 'La descripción no cumple el formato esperado.',
  invalid_dian_resolution: 'La resolución DIAN no es válida o está vencida. Revísala en Siigo Nube.',
  invalid_document: 'El tipo de comprobante no es válido para esta operación.',
  invalid_email: 'Un correo electrónico no tiene un formato válido.',
  invalid_identification: 'El número de identificación del tercero no es válido.',
  'invalid_idempotency-key': 'La clave de idempotencia no cumple el formato exigido por Siigo.',
  invalid_name: 'El nombre no cumple el formato esperado.',
  invalid_partner_id: 'La cabecera Partner-Id no es válida. Revisa SIIGO_PARTNER_ID.',
  invalid_payment: 'La forma de pago no es válida o no está activa.',
  invalid_plan_type: 'El plan contratado en Siigo Nube no permite esta operación.',
  invalid_range: 'Un valor está fuera del rango permitido.',
  invalid_reference: 'Una referencia enviada no existe en Siigo Nube.',
  invalid_retentions: 'Las retenciones enviadas no son válidas.',
  invalid_total_payments: 'La suma de las formas de pago no coincide con el total del documento.',
  invalid_type: 'Un tipo enviado no es válido.',
  invalid_url: 'Una URL enviada no es válida.',
  invalid_value: 'Un valor enviado no es válido.',
  length_max: 'Un campo supera la longitud máxima permitida.',
  length_min: 'Un campo no alcanza la longitud mínima exigida.',
  non_editable: 'El documento no es editable en su estado actual.',
  not_found: 'El recurso no existe en Siigo Nube.',
  parameter_empty: 'Un parámetro obligatorio llegó vacío.',
  parameter_inactive: 'Un parámetro referenciado está inactivo en Siigo Nube.',
  parameter_not_allowed: 'Un parámetro enviado no está permitido para esta operación.',
  parameter_required: 'Falta un parámetro obligatorio.',
  parameters_exclusive: 'Se enviaron parámetros mutuamente excluyentes.',
  product_settings: 'La configuración del producto en Siigo Nube impide la operación.',
  request_timeout: 'Siigo no alcanzó a responder. Se puede reintentar.',
  requests_limit: 'Se superó el límite de 100 peticiones por minuto. Se reintenta automáticamente.',
  service_unavailable: 'Siigo no está disponible en este momento. Se puede reintentar.',
  unauthorized: 'Siigo rechazó la autorización de la petición.',
  unhandled_error: 'Siigo devolvió un error no controlado.',
  update_not_allowed: 'Siigo no permite modificar este documento en su estado actual.',
  values_limit: 'Se superó el número de valores permitidos.',
  warehouse_settings: 'La configuración de la bodega en Siigo Nube impide la operación.',
};

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

  /** Texto para quien opera: qué pasó y, si Siigo lo dice, en qué campo. */
  get descripcionOperativa(): string {
    const base = DESCRIPCION[this.code] ?? `Siigo rechazó la operación (${this.code}).`;
    if (this.params.length === 0) return base;
    const campos = this.params.join(', ');
    return `${base} Campo: ${campos}.`;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      params: this.params,
      detail: this.detail,
      reintentable: this.reintentable,
      descripcionOperativa: this.descripcionOperativa,
    };
  }
}

/** Código sintético cuando la respuesta no cumple la estructura documentada. */
export const CODIGO_RESPUESTA_INESPERADA = 'respuesta_inesperada';

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
