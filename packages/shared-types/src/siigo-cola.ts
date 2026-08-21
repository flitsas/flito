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

import type { MotivoElegibilidad } from './siigo-elegibilidad.js';

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
 * Cuántas filas mira un ciclo del trabajador. Fue `SIIGO_COLA_LOTE` hasta el Bug #11649; ahora es
 * esta constante y `siigo.cola.cron.ts` la consume tal cual, sin variable de entorno de por medio.
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

/**
 * Qué hizo el encolado. `encolar()` es idempotente: pedir dos veces lo mismo no crea dos filas.
 *
 * Array `as const` y no solo un `type`, por la misma razón que los desenlaces: la lista de
 * resultados de la RUTA (HU #11328) se construye a partir de esta, y derivarla es la única forma de
 * que no puedan separarse. Con dos uniones escritas a mano, añadir aquí un resultado dejaría a la
 * respuesta HTTP con un contador que nadie suma y un caso que la pantalla no sabe pintar.
 */
export const SIIGO_RESULTADOS_ENCOLADO = [
  /** No estaba: se creó la fila y el trabajador la tomará. */
  'encolado',
  /** Ya estaba en cola (`pendiente` o `error`) y se devuelve tal cual. */
  'ya_en_cola',
  /** Ya se envió. No se vuelve a encolar: el documento existe. */
  'ya_enviado',
  /** Estaba dada por perdida y no se reactivó. Requiere pedirlo explícitamente. */
  'fallido_definitivo',
  /** Estaba dada por perdida y quien encoló pidió reactivarla: contadores a cero y cita para ya. */
  'reactivado',
] as const;
export type SiigoColaResultadoEncolado = (typeof SIIGO_RESULTADOS_ENCOLADO)[number];

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

// ── Enviar a facturación: el contrato de la ruta (HU #11328) ────────────────

/**
 * Qué pasó con CADA trámite de un envío.
 *
 * Es la lista del encolado MÁS los dos desenlaces que ocurren antes de llegar a la cola, y se
 * deriva de ella en vez de repetirla: si mañana `encolar()` distingue un caso nuevo, aparece aquí
 * solo y el `Record` de contadores obliga a contarlo.
 *
 *   `no_elegible` — la evaluación de elegibilidad lo frenó. No se creó lote ni fila de cola, y los
 *                   motivos viajan tal cual los devolvió esa evaluación (AC2).
 *   `error`       — el encolado de ESE trámite falló por sí mismo. Existe para que el fallo de uno
 *                   no se lleve por delante a los demás de la selección (AC1): sin un desenlace
 *                   propio, la única salida sería un 500 para toda la petición y quien envió
 *                   cincuenta trámites no sabría cuáles quedaron dentro.
 */
export const SIIGO_RESULTADOS_ENVIO = [
  ...SIIGO_RESULTADOS_ENCOLADO, 'no_elegible', 'error',
] as const;
export type SiigoResultadoEnvio = (typeof SIIGO_RESULTADOS_ENVIO)[number];

/**
 * Los resultados que significan «no se encoló y hay que hacer algo».
 *
 * `ya_en_cola` y `ya_enviado` NO están: son respuestas idempotentes a una petición repetida, no
 * rechazos. Contarlos como rechazo haría que refrescar una pantalla pareciera un problema.
 */
export const SIIGO_RESULTADOS_ENVIO_RECHAZO: readonly SiigoResultadoEnvio[] = [
  'no_elegible', 'fallido_definitivo', 'error',
];

/** Los que dejan trabajo nuevo en la cola. Son los que suma `encolados`. */
export const SIIGO_RESULTADOS_ENVIO_ENCOLADO: readonly SiigoResultadoEnvio[] = [
  'encolado', 'reactivado',
];

/**
 * Cómo se llama cada desenlace en pantalla (HU #11329).
 *
 * Vive aquí, junto al catálogo y no en la pantalla, por la misma razón que `SIIGO_COLA_ESTADO_ETIQUETA`
 * y `SIIGO_ESTADO_REPORTE_ETIQUETA`: un catálogo y su texto no se separan en dos paquetes, o el día
 * que se añada un desenlace habrá uno de los dos que no se entere.
 *
 * Al ser `Record<SiigoResultadoEnvio, string>`, añadir mañana un resultado a `SIIGO_RESULTADOS_ENVIO`
 * **no compila** hasta que alguien le escriba su texto — que es justo el aviso que hace falta: un
 * desenlace sin rótulo se pintaría como `undefined` en el diálogo de resultados.
 */
export const SIIGO_RESULTADO_ENVIO_ETIQUETA: Record<SiigoResultadoEnvio, string> = {
  encolado: 'En cola para emitir',
  reactivado: 'Reactivados',
  ya_en_cola: 'Ya estaba en cola',
  ya_enviado: 'Ya se había enviado',
  fallido_definitivo: 'Dados por perdidos',
  no_elegible: 'No se puede facturar todavía',
  error: 'No se pudo encolar',
};

/**
 * Qué significa cada desenlace, en una línea bajo su encabezado.
 *
 * **`error` y `no_elegible` no dicen lo mismo, y por eso no se explican igual**: el primero es que
 * algo se rompió al registrar el envío —se reintenta— y el segundo, que el servidor lo revisó y
 * todavía no procede —reintentar devolvería lo mismo—. Distinguirlos solo por color dejaría fuera a
 * quien no distingue rojo de gris; el texto es el que carga con la diferencia.
 *
 * `ya_en_cola` y `ya_enviado` son el AC6 escrito: quien acaba de pulsar dos veces y teme haber
 * facturado dos veces necesita leer, con esas palabras, que no se duplicó nada.
 */
export const SIIGO_RESULTADO_ENVIO_EXPLICACION: Record<SiigoResultadoEnvio, string> = {
  encolado: 'La factura sale sola en los próximos minutos. No hay que volver a pulsar.',
  reactivado: 'Estaban dados por perdidos y volvieron a la cola. Se reintentan desde ya.',
  ya_en_cola: 'Ya se habían enviado y siguen esperando su turno. No se pidieron dos veces.',
  ya_enviado: 'Su factura ya salió a Siigo. El estado va en la columna «Factura DIAN».',
  fallido_definitivo:
    'Se intentaron varias veces y ya no se reintentan solos. Hay que pedirlo a mano.',
  no_elegible:
    'El servidor los revisó y todavía no cumplen. No se reintenta: hay que resolver el motivo '
    + 'primero.',
  error:
    'No es un rechazo: algo falló al registrar el envío de estos trámites. Los demás sí entraron. '
    + 'Se puede reintentar.',
};

/** Qué pasó con un trámite del envío. */
export interface SiigoEnvioTramite {
  tramiteId: string;
  resultado: SiigoResultadoEnvio;
  /**
   * Los motivos de la evaluación de elegibilidad, **palabra por palabra** (AC2).
   *
   * Vacío salvo en `no_elegible`. Esta ruta no redacta ni resume ninguno: una segunda versión del
   * mismo diagnóstico sería siempre la que se quedara vieja, y quien lee el rechazo aquí y la
   * elegibilidad allá vería dos explicaciones distintas del mismo hecho.
   */
  motivos: MotivoElegibilidad[];
  /** El estado de su fila de cola, cuando llegó a haber una. */
  estado: SiigoColaEstado | null;
  colaId: string | null;
  loteId: string | null;
  /** Solo en `error`: qué impidió encolar ESTE trámite. No es un motivo de elegibilidad. */
  detalle: string | null;
}

/**
 * El recuento del envío (AC1).
 *
 * Los tres primeros números responden preguntas distintas y por eso no se solapan: `encolados` es
 * trabajo nuevo, `yaEstaban` es una repetición inocua y `rechazados` es lo que exige que alguien
 * actúe. `porResultado` los desglosa entero para que la suma siempre cuadre con `total`.
 */
export interface SiigoResumenEnvio {
  total: number;
  encolados: number;
  yaEstaban: number;
  rechazados: number;
  porResultado: Record<SiigoResultadoEnvio, number>;
}

/** La respuesta de enviar a facturación. */
export interface SiigoRespuestaEnvio {
  /**
   * El ambiente en que se encoló. Va en la respuesta porque lo decide el SERVIDOR y no quien
   * llama: quien envía tiene derecho a saber contra qué empresa de Siigo acaba de encolar.
   */
  ambiente: string;
  items: SiigoEnvioTramite[];
  resumen: SiigoResumenEnvio;
}

/** Un resumen de envío con todos los resultados a cero: ninguno desaparece por no tener casos. */
export function resumenEnvioVacio(): SiigoResumenEnvio {
  const porResultado = Object.fromEntries(
    SIIGO_RESULTADOS_ENVIO.map((r) => [r, 0]),
  ) as Record<SiigoResultadoEnvio, number>;
  return { total: 0, encolados: 0, yaEstaban: 0, rechazados: 0, porResultado };
}

/**
 * Cuenta los resultados de un envío. Vive aquí, y no en el servidor, porque la pantalla que muestre
 * el desglose tiene que contar igual: dos aritméticas del mismo hecho acabarían discrepando.
 */
export function resumirEnvio(items: SiigoEnvioTramite[]): SiigoResumenEnvio {
  const r = resumenEnvioVacio();
  r.total = items.length;
  for (const it of items) {
    r.porResultado[it.resultado] += 1;
    if (SIIGO_RESULTADOS_ENVIO_ENCOLADO.includes(it.resultado)) r.encolados += 1;
    else if (SIIGO_RESULTADOS_ENVIO_RECHAZO.includes(it.resultado)) r.rechazados += 1;
    else r.yaEstaban += 1;
  }
  return r;
}
