// Estados y estrategias de la factura electrónica (HU #11323, Feature #11242).
//
// Aparte de `siigo-emision.ts`, que describe *con qué parámetros* nace una factura (HU #11284).
// Esto describe *qué le pasa* a la factura una vez existe, y lo comparten la emisión, la bandeja de
// fallidos (HU #11340), el seguimiento DIAN (HU #11330) y las dos pantallas.
//
// **Estos valores están duplicados a propósito en un `CHECK` de la migración `0135`.** La
// duplicación es deliberada: la base de datos no puede importar TypeScript, y dejar la restricción
// solo en el código significaría que un `UPDATE` suelto puede meter un estado que nadie sabe
// interpretar. Hay una prueba que compara las dos listas y falla si se separan.

/**
 * Estados de una factura. Cerrados a propósito.
 *
 * **No hay `pendiente`**: una fila de `siigo_facturas` nace cuando se reserva su clave de
 * idempotencia, y reservar la clave ya es estar en proceso. Lo que está pendiente es el trámite.
 *
 * **Tampoco hay `anulada`**: el estado ante la DIAN es un eje distinto (HU #11330), y mezclarlos
 * haría que una factura anulada dejara de constar como emitida, cuando el documento existe ante la
 * autoridad y existirá siempre.
 */
export const SIIGO_FACTURA_ESTADOS = ['en_proceso', 'emitida', 'fallida'] as const;
export type SiigoFacturaEstado = (typeof SIIGO_FACTURA_ESTADOS)[number];

export const SIIGO_FACTURA_ESTADO_ETIQUETA: Record<SiigoFacturaEstado, string> = {
  en_proceso: 'En proceso',
  emitida: 'Emitida',
  fallida: 'Fallida',
};

/**
 * Cómo se agrupan los trámites en facturas.
 *
 * **Un solo valor admitido, y es deliberado** (decisión D-1, diferida): la granularidad —una
 * factura por trámite frente a una consolidada por cliente— no está decidida. Añadir `consolidada`
 * exige una migración, y con ella una decisión explícita en vez de un cambio silencioso.
 */
export const SIIGO_ESTRATEGIAS_LOTE = ['por_tramite'] as const;
export type SiigoEstrategiaLote = (typeof SIIGO_ESTRATEGIAS_LOTE)[number];

/**
 * Estrategia de retenciones. **Pregunta 7, abierta**: no se sabe si a las facturas de FLIT les
 * aplican ReteICA, ReteIVA o autorretención. Mientras valga `ninguna` no se envía `retentions[]`.
 */
export const SIIGO_RETENCIONES_ESTRATEGIAS = ['ninguna'] as const;
export type SiigoRetencionesEstrategia = (typeof SIIGO_RETENCIONES_ESTRATEGIAS)[number];

/** **Pregunta 15, abierta**: se asume COP, y se afirma en la base de datos en vez de suponerlo. */
export const SIIGO_MONEDAS = ['COP'] as const;
export type SiigoMoneda = (typeof SIIGO_MONEDAS)[number];

/**
 * Formato que Siigo exige para `Idempotency-Key`: alfanumérico, hasta 30, sin espacios ni
 * caracteres especiales.
 *
 * Vive aquí porque **el id de un lote no se puede usar en crudo**: un UUID lleva guiones y 36
 * caracteres, así que la clave se DERIVA (resumen hexadecimal truncado). `siigo.client.ts` aplica
 * esta misma regla antes de salir a la red, y la migración `0135` la afirma como `CHECK` — una
 * clave inválida guardada es una emisión que fallará siempre sin que se vea el motivo.
 */
export const SIIGO_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9]{1,30}$/;
export const SIIGO_IDEMPOTENCY_KEY_MAX = 30;

/** Minutos por defecto tras los cuales una factura `en_proceso` se considera huérfana. */
export const ARRENDAMIENTO_EN_PROCESO_MIN_DEFECTO = 15;

/** Una factura tal como la devuelve la API. `totalSiigo` es cadena: `numeric` llega así. */
export interface SiigoFactura {
  id: string;
  loteId: string;
  ambiente: string;
  idempotencyKey: string;
  siigoInvoiceId: string | null;
  numero: string | null;
  cufe: string | null;
  publicUrl: string | null;
  totalSiigo: string | null;
  estado: SiigoFacturaEstado;
  intentos: number;
  errorCode: string | null;
  errorDetalle: string | null;
  enviadaEn: string | null;
  /** Marca APARTE del estado: una factura emitida con total discrepante SIGUE emitida. */
  requiereRevision: boolean;
  revisionMotivo: string | null;
}

/**
 * En qué punto del ciclo está la factura de un trámite, visto desde el reporte de costos (HU #11336).
 *
 * **Es una COMBINACIÓN de dos ejes, no una columna.** El estado de emisión (¿salió de FLITO?) y el
 * estado ante la DIAN (¿lo aceptó la autoridad?) son independientes y el sistema los guarda por
 * separado, con razón: una factura puede estar emitida y rechazada a la vez, y aplanarlos en una
 * sola columna obligaría a mantenerla sincronizada desde dos sitios. Lo que esta lista define es
 * cómo se traduce ese par a la frase que le sirve a quien mira el reporte.
 *
 * El orden es el del ciclo, y la pantalla lo respeta: se lee de izquierda a derecha como avanza una
 * factura. `fallido` va al final aunque ocurra pronto, porque es donde alguien tiene que actuar.
 */
export const SIIGO_ESTADOS_REPORTE = [
  /** Nunca se le pidió factura electrónica. NO es un fallo: es que todavía no le toca (AC4). */
  'no_enviado',
  /** Se pidió y está en curso. Es un estado que se resuelve solo; nadie tiene que hacer nada. */
  'en_proceso',
  /** Salió de FLITO y Siigo la recibió, pero la DIAN todavía no se ha pronunciado. */
  'emitido',
  /** La DIAN la aceptó. Es el final feliz y el único que cierra el ciclo. */
  'aceptado',
  /** La DIAN la rechazó. Hay algo que corregir y el motivo lo explica (HU #11333). */
  'rechazado',
  /**
   * La DIAN la anuló. Séptimo estado, más allá de los seis que enumera el AC1, y con motivo:
   * mostrar una factura anulada como «Emitida» es una afirmación falsa en una pantalla de control,
   * y contabilidad la usa para cuadrar. El AC enumera lo que tiene que estar, no prohíbe distinguir
   * algo que el sistema sabe. La suma sigue cuadrando con el total, que es lo que el AC1 exige.
   */
  'anulado',
  /** El intento de emitir falló. Distinto de `no_enviado`: aquí sí se intentó (AC4). */
  'fallido',
] as const;
export type SiigoEstadoReporte = (typeof SIIGO_ESTADOS_REPORTE)[number];

export const SIIGO_ESTADO_REPORTE_ETIQUETA: Record<SiigoEstadoReporte, string> = {
  no_enviado: 'Sin enviar',
  en_proceso: 'En proceso',
  emitido: 'Emitida',
  aceptado: 'Aceptada por la DIAN',
  rechazado: 'Rechazada por la DIAN',
  anulado: 'Anulada',
  fallido: 'Falló al emitir',
};

export function esEstadoReporte(v: unknown): v is SiigoEstadoReporte {
  return typeof v === 'string' && (SIIGO_ESTADOS_REPORTE as readonly string[]).includes(v);
}

/** Los contadores del reporte: uno por estado, más el total para poder cuadrar (AC1). */
export type SiigoResumenReporte = Record<SiigoEstadoReporte, number> & { total: number };
