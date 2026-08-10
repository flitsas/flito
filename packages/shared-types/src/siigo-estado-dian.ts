// Estado de la factura ante la DIAN y su procedencia (HU #11330, Feature #11243).
//
// **Esto es un eje distinto del `estado` de `siigo_facturas`** (`en_proceso | emitida | fallida`,
// en `siigo-factura.ts`), que pertenece a la Feature #11242 y describe si FLITO consiguió emitir.
// Aquí se describe qué dice la autoridad tributaria sobre un documento que YA existe.
//
// Que sean dos ejes no es un capricho de modelado: si `anulada` viviera en el mismo campo, una
// factura anulada dejaría de constar como emitida — y el documento existe ante la DIAN y existirá
// siempre. Anular no deshace: añade un hecho encima.
//
// Los dos catálogos están duplicados a propósito en sendos `CHECK` de la migración `0137`: la base
// de datos no puede importar TypeScript, y dejar la restricción solo aquí significaría que un
// `UPDATE` suelto puede meter un valor que nadie sabe interpretar. Hay una prueba que compara las
// listas y falla si se separan.

/**
 * Estados posibles ante la DIAN. Cerrados a propósito.
 *
 * `anulada` está desde el primer día aunque todavía nadie la escriba: el modelo tiene que admitirla
 * sin migrar, porque la nota crédito es una pregunta abierta de la Feature y no queremos que la
 * respuesta llegue acompañada de un `ALTER TABLE`.
 */
export const SIIGO_ESTADOS_DIAN = ['en_validacion', 'aceptada', 'rechazada', 'anulada'] as const;
export type SiigoEstadoDian = (typeof SIIGO_ESTADOS_DIAN)[number];

export const SIIGO_ESTADO_DIAN_ETIQUETA: Record<SiigoEstadoDian, string> = {
  en_validacion: 'En validación',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
  anulada: 'Anulada',
};

/**
 * Estados en los que la DIAN todavía no ha dicho la última palabra: son los que vale la pena
 * volver a consultar. Lo usa quien programe el sondeo para elegir a quién preguntar, en vez de
 * repartir la lista de estados por el código.
 */
export const SIIGO_ESTADOS_DIAN_NO_FINALES: readonly SiigoEstadoDian[] = ['en_validacion'];

export function esEstadoDianFinal(estado: SiigoEstadoDian): boolean {
  return !SIIGO_ESTADOS_DIAN_NO_FINALES.includes(estado);
}

/**
 * De dónde salió el dato.
 *
 * Es el corazón de la historia. `webhook` figura en el catálogo aunque **el grupo Webhooks de la
 * API de Siigo esté sin revisar** (`docs/integraciones/siigo-api.md` lo declara pendiente): si
 * mañana resulta que notifica el estado, el sondeo pasa a ser respaldo, se empieza a escribir
 * `webhook` y ningún consumidor se entera. Escribir la ingesta acoplada al sondeo convertiría esa
 * migración en un rediseño.
 *
 * - `emision`: lo dijo la respuesta de crear la factura.
 * - `sondeo`: lo dijo una consulta programada.
 * - `webhook`: lo notificó Siigo.
 * - `manual`: lo registró una persona, mirando Siigo Nube o la DIAN.
 */
export const SIIGO_FUENTES_ESTADO_DIAN = ['emision', 'sondeo', 'webhook', 'manual'] as const;
export type SiigoFuenteEstadoDian = (typeof SIIGO_FUENTES_ESTADO_DIAN)[number];

export const SIIGO_FUENTE_ESTADO_DIAN_ETIQUETA: Record<SiigoFuenteEstadoDian, string> = {
  emision: 'Respuesta de emisión',
  sondeo: 'Consulta programada',
  webhook: 'Notificación de Siigo',
  manual: 'Registro manual',
};

export function esEstadoDian(v: unknown): v is SiigoEstadoDian {
  return typeof v === 'string' && (SIIGO_ESTADOS_DIAN as readonly string[]).includes(v);
}

export function esFuenteEstadoDian(v: unknown): v is SiigoFuenteEstadoDian {
  return typeof v === 'string' && (SIIGO_FUENTES_ESTADO_DIAN as readonly string[]).includes(v);
}

/**
 * Una fila del historial tal como la devuelve la API.
 *
 * `verificadoEn` **no** es lo mismo que `createdAt`, y la diferencia es justo lo que hace legible
 * la pantalla: `createdAt` es cuándo el documento pasó a ese estado; `verificadoEn`, cuándo se
 * confirmó por última vez que seguía ahí. Una factura aceptada hace tres semanas y confirmada hace
 * diez minutos no es lo mismo que una aceptada hace tres semanas y sin mirar desde entonces.
 */
export interface SiigoEstadoDianRegistro {
  id: string;
  facturaId: string;
  /** Orden total de la bitácora. Ordenar por fecha no basta: dos filas caben en el mismo instante. */
  secuencia: number;
  estado: SiigoEstadoDian;
  cufe: string | null;
  motivo: string | null;
  fuente: SiigoFuenteEstadoDian;
  /** Cuándo se registró este estado por primera vez. */
  createdAt: string;
  /** Cuándo se confirmó por última vez que el estado seguía siendo este. */
  verificadoEn: string;
}

/**
 * Traducción del `stamp.status` de Siigo al estado ante la DIAN (HU #11332).
 *
 * **Este mapa es corto a propósito y es una incógnita, no un hecho.** `docs/integraciones/siigo-api.md`
 * documenta que `stamp.send` envía el documento a la DIAN, pero **no enumera los valores de
 * `stamp.status`**. Lo único observado es `Audit`, que es lo que devuelve una factura recién creada;
 * el resto son los nombres que la API usa en su propia documentación pública de respuesta.
 *
 * Las claves se comparan en minúsculas para no depender de la capitalización, que tampoco está fijada.
 *
 * **Lo que NO se hace es adivinar.** Un `status` que no esté aquí deja el estado como estaba y queda
 * en la bitácora — ver `traducirEstadoStamp`. La alternativa, mapear lo desconocido a algo, es la
 * peor de todas: marcaría como rechazada una factura que la DIAN aceptó, o al revés, y las dos
 * mentiras se propagan a un reporte que alguien usa para decidir. Un estado que no avanza se nota;
 * uno que avanza mal, no.
 *
 * Ampliarlo cuando se conozcan más valores es añadir una fila aquí, y el test que fija su tamaño
 * obliga a que ese día alguien lo documente.
 */
export const SIIGO_STAMP_STATUS_A_ESTADO_DIAN: Readonly<Record<string, SiigoEstadoDian>> =
  Object.assign(Object.create(null) as Record<string, SiigoEstadoDian>, {
    audit: 'en_validacion',
    pending: 'en_validacion',
    accepted: 'aceptada',
    rejected: 'rechazada',
    cancelled: 'anulada',
    canceled: 'anulada',
  });

/**
 * Traduce lo que Siigo dice del sello. `null` = «no sé qué significa esto», que NO es un estado.
 *
 * Devolver `null` en vez de un valor por defecto es la decisión entera: quien llama tiene que
 * decidir explícitamente qué hacer con lo desconocido, y no puede confundirlo con «en validación».
 */
export function traducirEstadoStamp(status: unknown): SiigoEstadoDian | null {
  if (typeof status !== 'string') return null;

  // `Object.create(null)` arriba y esta validación de salida son DOS defensas contra el mismo error,
  // y las dos hacen falta. Con un objeto literal corriente, `status: "constructor"` no devuelve
  // `undefined` sino la función `Object`, heredada del prototipo — así que el `?? null` no dispara y
  // el valor sale como si fuera un estado. Eso rompería justo la invariante que sostiene esta HU
  // («lo desconocido no se convierte en un estado») y por el peor camino: sin fila en la bitácora, y
  // reventando después dentro de la ingesta con un error que aborta el ciclo entero.
  const candidato: unknown = SIIGO_STAMP_STATUS_A_ESTADO_DIAN[status.trim().toLowerCase()];
  return esEstadoDian(candidato) ? candidato : null;
}

/**
 * Marcador de «rechazada, pero todavía no sabemos por qué» (HU #11333, AC5).
 *
 * Hace falta porque `motivo === null` ya significa algo distinto: que nadie ha preguntado. Sin este
 * valor, una factura cuyo detalle de errores no se pudo obtener sería indistinguible de un rechazo
 * sin causa registrada, y quien opera no sabría si esperar o si ir a mirar a Siigo Nube.
 *
 * Es un texto y no un booleano porque vive en la columna `motivo` del historial, que es append-only:
 * añadir una columna para esto obligaría a una migración sobre una tabla inmutable para expresar un
 * estado transitorio.
 */
export const SIIGO_MOTIVO_RECHAZO_PENDIENTE = 'Motivo pendiente de consultar en Siigo.';

/** ¿El motivo es el marcador de pendiente y no una explicación de verdad? */
export function esMotivoPendiente(motivo: string | null | undefined): boolean {
  return typeof motivo === 'string' && motivo.trim() === SIIGO_MOTIVO_RECHAZO_PENDIENTE;
}
