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
