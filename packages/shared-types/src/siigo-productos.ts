// Siigo — productos y validación del mapeo contra Siigo (HU #11283).
//
// El mapeo de conceptos (HU #11282) acepta hoy cualquier código de producto con la forma correcta.
// «Con la forma correcta» no es «existe»: un código bien escrito que en Siigo no está, o que está
// inactivo, no se descubre hasta el momento de emitir — y ahí ya hay una factura que no salió y un
// trámite parado. Esta HU adelanta ese descubrimiento al momento de guardar.
//
// La distinción que sostiene todo el diseño es entre **no existe** y **no se pudo verificar**. La
// primera es un dato malo: quien parametriza tiene que corregirlo. La segunda es una caída de Siigo:
// el dato puede estar perfecto. Confundirlas en un solo «no se pudo guardar» llevaría a cambiar un
// código que estaba bien, y a dejar el mapeo peor que antes.

/**
 * Producto de Siigo tal como lo entrega `GET /v1/products?code=`.
 *
 * Se declara en inglés porque es la forma literal de la respuesta del API. La traducción al dominio
 * ocurre en el servicio; mezclar los dos idiomas en la misma interfaz es lo que hace que nadie sepa
 * si `nombre` viene de Siigo o lo pusimos nosotros.
 */
export interface SiigoProductoApi {
  id?: string;
  code?: string;
  name?: string;
  active?: boolean;
  /** Id del grupo de inventario. Es el `account_group` del catálogo cacheado. */
  account_group?: number | { id?: number; name?: string } | null;
  taxes?: Array<{ id?: number; name?: string; percentage?: number }>;
  unit?: string | { code?: string; name?: string } | null;
}

/** Respuesta paginada de los listados de Siigo. */
export interface SiigoListadoApi<T> {
  pagination?: { page?: number; page_size?: number; total_results?: number };
  results?: T[];
}

/**
 * Por qué se rechazó una validación. Cada motivo lleva una acción distinta, y por eso son valores
 * separados y no un booleano con un texto:
 *
 *   · `formato`                  → corregir el código antes de gastar cuota de Siigo (AC4).
 *   · `no_existe`                → crear el producto en Siigo o escribir el código correcto (AC1).
 *   · `inactivo`                 → activarlo en Siigo; el código está bien (AC2).
 *   · `impuesto_desconocido`     → el id no está en la copia local de `/v1/taxes` (AC3).
 *   · `catalogo_sin_sincronizar` → la copia local está vacía: sincronizar antes de juzgar (AC3).
 *   · `no_verificable`           → Siigo no respondió. El dato puede estar bien (AC6).
 */
export const MOTIVOS_RECHAZO_VALIDACION = [
  'formato',
  'no_existe',
  'inactivo',
  'impuesto_desconocido',
  'catalogo_sin_sincronizar',
  'no_verificable',
] as const;

export type MotivoRechazoValidacion = typeof MOTIVOS_RECHAZO_VALIDACION[number];

export function esMotivoRechazoValidacion(v: unknown): v is MotivoRechazoValidacion {
  return typeof v === 'string' && (MOTIVOS_RECHAZO_VALIDACION as readonly string[]).includes(v);
}

/**
 * Los motivos que significan «el dato está mal». Su complemento es `no_verificable`, que significa
 * «el dato puede estar bien y no lo sabemos» (AC6).
 *
 * Se declara aquí, junto a la lista, para que añadir un motivo obligue a decidir de qué lado cae en
 * vez de heredar el que le toque por el orden del arreglo.
 */
export const MOTIVOS_DE_DATO_INVALIDO: readonly MotivoRechazoValidacion[] = [
  'formato', 'no_existe', 'inactivo', 'impuesto_desconocido', 'catalogo_sin_sincronizar',
];

export function esDatoInvalido(motivo: MotivoRechazoValidacion): boolean {
  return MOTIVOS_DE_DATO_INVALIDO.includes(motivo);
}

/** Resultado de validar un mapeo contra Siigo antes de guardarlo. */
export interface ValidacionMapeo {
  valido: boolean;
  /** `null` cuando `valido` es true. */
  motivo: MotivoRechazoValidacion | null;
  /** Texto accionable para quien parametriza. Nunca el mensaje crudo de Siigo en inglés. */
  mensaje: string;
  /** Nombre del producto según Siigo, para que la pantalla confirme que es el que se creía. */
  nombreProductoSiigo: string | null;
  /** Momento de la verificación, ISO-8601. `null` si no se llegó a consultar a Siigo. */
  verificadoEn: string | null;
}

/**
 * Estado de validación que se persiste en cada fila del mapeo (AC7).
 *
 * `sin_validar` es el estado de las filas anteriores a esta HU y el de las que se guardan sin
 * código de producto: no es un fallo, es que no hay nada que verificar todavía.
 */
export const ESTADOS_VALIDACION_MAPEO = [
  'sin_validar',
  'valido',
  'no_existe',
  'inactivo',
  'no_verificable',
] as const;

export type EstadoValidacionMapeo = typeof ESTADOS_VALIDACION_MAPEO[number];

export function esEstadoValidacionMapeo(v: unknown): v is EstadoValidacionMapeo {
  return typeof v === 'string' && (ESTADOS_VALIDACION_MAPEO as readonly string[]).includes(v);
}

/** Una fila revisada por la revalidación masiva (AC7). */
export interface ConceptoRevalidado {
  id: string;
  concepto: string;
  tipoTramite: string | null;
  codigoProducto: string;
  estado: EstadoValidacionMapeo;
  mensaje: string;
}

/**
 * Resultado de la revalidación de un ambiente completo (AC7).
 *
 * `noVerificados` va aparte de `conNovedad` a propósito: si Siigo estuvo caído durante la
 * revalidación, decir que «3 conceptos tienen problemas» cuando en realidad no se pudo mirar
 * ninguno es exactamente la confusión que el AC6 pide evitar, trasladada al informe.
 */
export interface ResultadoRevalidacion {
  ambiente: string;
  ejecutadaEn: string;
  /** Filas activas con código de producto: las únicas que hay algo que revalidar. */
  revisados: number;
  /** Las que dejaron de existir o quedaron inactivas. */
  conNovedad: ConceptoRevalidado[];
  /** Las que no se pudieron comprobar porque Siigo no respondió. */
  noVerificados: ConceptoRevalidado[];
  /**
   * true = se alcanzó el tope de códigos por ejecución y quedaron filas sin revisar.
   *
   * Se informa explícitamente en vez de recortar en silencio: un informe que dice «0 novedades»
   * habiendo mirado la mitad del mapeo es peor que no haberlo ejecutado, porque da confianza.
   */
  truncado: boolean;
  /** Códigos distintos que quedaron sin comprobar por el tope. 0 cuando `truncado` es false. */
  codigosPendientes: number;
}

/**
 * Tope de códigos DISTINTOS que una sola revalidación consulta contra Siigo.
 *
 * Es exactamente la ventana de cuota de Siigo (100 peticiones por minuto y por empresa). Una
 * ejecución no puede monopolizar más de una ventana: el excedente del limitador no se descarta,
 * espera, así que sin tope una revalidación grande encolaría detrás de sí toda la emisión de
 * facturas mientras dura.
 */
export const MAX_CODIGOS_POR_REVALIDACION = 100;
