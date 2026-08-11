// Cola de emisión de facturas (HU #11327, Feature #11242).
//
// **Por qué hay una cola aparte de `siigo_facturas`.** Son dos ejes distintos y confundirlos costaría
// una columna que nadie sabría interpretar. `siigo_facturas` responde «¿qué le pasó al DOCUMENTO?» y
// por eso no tiene —ni puede tener— un estado `pendiente`: su fila nace cuando se reserva la clave de
// idempotencia, y reservar la clave ya es estar en proceso (ver `siigo-factura.ts`). La cola responde
// una pregunta que ninguna fila de facturas puede contestar: «¿queda trabajo por hacer y cuándo le
// toca?». Lo que está pendiente es el trámite, no el documento.
//
// **Lo que la cola NO garantiza, y conviene tenerlo escrito.** La cola no impide la doble factura.
// Eso lo impiden la reserva de la clave (`idx_siigo_facturas_idem`), el índice de trámites vivos y el
// `Idempotency-Key` que viaja a Siigo. Lo que la cola impide es el TRABAJO duplicado: que dos
// instancias gasten cuota intentando lo mismo.
//
// **Estos valores están duplicados a propósito en un `CHECK` de la migración `0144`**, por la misma
// razón que los de la factura en la `0135`: la base de datos no puede importar TypeScript, y dejar la
// restricción solo en el código significaría que un `UPDATE` suelto puede meter un estado que nadie
// sabe interpretar. Hay una prueba que compara las dos listas y falla si se separan.

/**
 * Los cuatro estados de una fila de la cola. Cerrados, y no se solapan (AC2).
 *
 * **No hay un quinto estado para «la está procesando alguien»**: eso es el arrendamiento
 * (`tomadoPor` / `tomadoEn`), que es una propiedad de la fila y no una fase del trabajo. Como estado
 * habría que devolverlo a `pendiente` cuando el proceso muere —y si muere, justamente no queda nadie
 * que lo devuelva—, así que una instancia caída dejaría la fila atascada para siempre. Con el
 * arrendamiento no hace falta que nadie limpie: al vencer, la fila vuelve a ser elegible sola.
 */
export const SIIGO_COLA_ESTADOS = ['pendiente', 'enviado', 'error', 'fallido_definitivo'] as const;
export type SiigoColaEstado = (typeof SIIGO_COLA_ESTADOS)[number];

export const SIIGO_COLA_ESTADO_ETIQUETA: Record<SiigoColaEstado, string> = {
  pendiente: 'Pendiente',
  enviado: 'Enviado',
  error: 'Con error, se reintentará',
  fallido_definitivo: 'Fallido, no se reintenta solo',
};

/**
 * Dos contadores con dos techos, y no uno solo.
 *
 * `intentos` cuenta DESENLACES: Siigo contestó y rechazó. Son los que gastan el techo, porque cada
 * uno es información nueva sobre por qué esto no va a salir.
 *
 * `esperas` cuenta CICLOS SIN DESENLACE: la clave estaba tomada por otro proceso, el `POST` salió y
 * no volvió, la fila quedó huérfana. Con un solo contador, un Siigo lento quema los cinco intentos
 * sin que nadie haya rechazado nada y la fila acaba `fallido_definitivo` con el documento
 * posiblemente vivo ante la DIAN — que es exactamente la afirmación que no se puede hacer sin
 * comprobarla.
 */
export const SIIGO_COLA_MAX_INTENTOS = 5;
export const SIIGO_COLA_MAX_ESPERAS = 20;

/**
 * Cuántas filas mira un ciclo del trabajador (`SIIGO_COLA_LOTE`).
 *
 * Peor caso ≈ 6 peticiones por fila (los 4 intentos de `ejecutarConResiliencia` más el margen del
 * tercero), o sea ≈ 90 < `MAX_PETICIONES_POR_VENTANA` (100). Con un intervalo de 2 min > `VENTANA_MS`
 * (60 s), un ciclo entero cabe en la ventana sin que el limitador tenga que dormir a nadie.
 */
export const SIIGO_COLA_LOTE_DEFECTO = 15;

/**
 * Minutos de arrendamiento de una fila de la cola.
 *
 * **Deliberadamente MAYOR que el de la factura** (15 por defecto). Si fuera menor, la cola daría por
 * abandonada una fila cuya emisión sigue viva y la entregaría a un segundo trabajador: dos procesos
 * llamando a `emitirFactura` sobre el mismo lote. No saldrían dos facturas —la reserva de la clave lo
 * impide— pero sí dos peticiones y un desenlace `en_curso` que no aporta nada. Al revés no pasa nada:
 * la fila espera un poco más de lo estrictamente necesario.
 */
export const SIIGO_COLA_ARRENDAMIENTO_MIN = 20;

/**
 * Qué pasó con el último ciclo de trabajo de la fila. Es el desenlace de `emitirFactura`, más
 * `error_interno` para el fallo que ocurre antes de que la emisión llegue a devolver nada.
 *
 * Array `as const` y no solo un `type`, para que la prueba que compara este catálogo con el `CHECK`
 * de la migración pueda recorrerlo. Todas las columnas de catálogo del módulo llevan restricción en
 * la base; esta se quedó sin ella porque el valor no existía como lista.
 */
export const SIIGO_COLA_DESENLACES = [
  'emitida', 'ya_emitida', 'en_curso', 'huerfana', 'fallida', 'no_elegible', 'error_interno',
] as const;
export type SiigoColaDesenlace = (typeof SIIGO_COLA_DESENLACES)[number];

/** Qué hizo el encolado. `encolar()` es idempotente: pedir dos veces lo mismo no crea dos filas. */
export type SiigoColaResultadoEncolado =
  /** No estaba: se creó la fila y el trabajador la tomará. */
  | 'encolado'
  /** Ya estaba en cola (`pendiente` o `error`) y se devuelve tal cual. */
  | 'ya_en_cola'
  /** Ya se envió. No se vuelve a encolar: el documento existe. */
  | 'ya_enviado'
  /** Estaba dada por perdida y no se reactivó. Requiere pedirlo explícitamente. */
  | 'fallido_definitivo'
  /** Estaba dada por perdida y quien encoló pidió reactivarla: contadores a cero y cita para ya. */
  | 'reactivado';

/** Una fila de la cola tal como la devolverá la API (HU #11328). */
export interface SiigoColaItem {
  id: string;
  loteId: string;
  ambiente: string;
  estado: SiigoColaEstado;
  intentos: number;
  maxIntentos: number;
  esperas: number;
  maxEsperas: number;
  proximoIntentoAt: string;
  ultimoIntentoAt: string | null;
  /** La factura que produjo el trabajo, cuando llegó a haber una. */
  facturaId: string | null;
  desenlace: SiigoColaDesenlace | null;
  errorCode: string | null;
  errorDetalle: string | null;
  createdAt: string;
  updatedAt: string;
}

export function esEstadoCola(v: unknown): v is SiigoColaEstado {
  return typeof v === 'string' && (SIIGO_COLA_ESTADOS as readonly string[]).includes(v);
}
