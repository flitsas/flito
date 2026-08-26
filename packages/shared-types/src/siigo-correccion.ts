// Corrección de una factura ya emitida (HU #11343, Feature #11244).
//
// **Lo que esta historia NO afirma.** No se sabe si corregir una factura emitida es una nota
// crédito. `docs/integraciones/siigo-api.md` §3 documenta dos operaciones DISTINTAS —`DELETE
// /v1/invoices/{id}` es *borrar* y `POST /v1/invoices/{id}/annul` es *anular*— y dice que **ninguna
// de las dos aplica** a una factura en proceso de envío a la DIAN o ya aceptada (con CUFE), que es
// justo el caso que hay que corregir. El grupo `/v1/credit-notes` **nunca se ha leído**. Por eso
// aquí no existe el valor `nota_credito`: nombrarlo sería escribir como hecho lo que es una
// incógnita (pregunta 8 de §6 del diseño, abierta por dos motivos: el de negocio y el documental).
//
// Y por eso mismo el catálogo se queda corto a propósito. Ampliarlo exige una migración —el mismo
// patrón con el que la `0135` trata la granularidad, las retenciones y la moneda—: el día que
// alguien lea el grupo de notas crédito, añadir el valor será una decisión escrita y fechada, no un
// literal que apareció en un `switch`.

/**
 * Qué se le hizo a la factura. **Tres valores, y los tres se apoyan en algo comprobable.**
 *
 * - `anulacion` y `borrado` existen porque la API de Siigo las documenta como operaciones distintas.
 *   Que estén en el catálogo no significa que se puedan ejecutar: `evaluarCorreccion()` decide eso.
 * - `otra` es el cajón honesto. Una persona en Siigo Nube puede haber hecho una operación cuyo
 *   nombre en el contrato todavía no conocemos; obligarla a elegir entre dos etiquetas que no
 *   describen lo que hizo produciría un registro FALSO, que es peor que un registro genérico.
 *   Por eso `motivo` es obligatorio: es donde se cuenta qué fue.
 */
export const SIIGO_CORRECCION_TIPOS = ['anulacion', 'borrado', 'otra'] as const;
export type SiigoCorreccionTipo = (typeof SIIGO_CORRECCION_TIPOS)[number];

export const SIIGO_CORRECCION_TIPO_ETIQUETA: Record<SiigoCorreccionTipo, string> = {
  anulacion: 'Anulación',
  borrado: 'Borrado',
  otra: 'Otra corrección hecha en Siigo',
};

/**
 * Quién ejecutó la corrección.
 *
 * **Un solo valor, y es el único que hoy es cierto sin decidir nada**: alguien la hizo en Siigo Nube
 * y la registró en FLITO. El ejecutor que actúa contra la API es la HU #11344 y está bloqueada por
 * la pregunta 8.
 *
 * La columna nace igualmente desde el primer día. Es la misma jugada que `siigo_factura_tramites`
 * hace con la consolidación: cuando la pregunta se responda, el ejecutor automático será una función
 * nueva y una fila con otro valor — no una migración de las que ya existen ni un cambio en las
 * consultas que las leen.
 */
export const SIIGO_CORRECCION_EJECUTORES = ['manual'] as const;
export type SiigoCorreccionEjecutor = (typeof SIIGO_CORRECCION_EJECUTORES)[number];

export const SIIGO_CORRECCION_EJECUTOR_ETIQUETA: Record<SiigoCorreccionEjecutor, string> = {
  manual: 'Registro de una corrección hecha fuera de FLITO',
};

/**
 * Qué hacer con esta factura. No es el tipo de corrección: es el camino.
 *
 * - `registro_externo` — hay un documento en Siigo. Se corrige por fuera y se registra aquí.
 * - `reintento` — no hay documento que corregir. Lo que aplica es reintentar la emisión o marcarla
 *   como fallida definitiva (AC6).
 */
export const SIIGO_CORRECCION_VIAS = ['registro_externo', 'reintento'] as const;
export type SiigoCorreccionVia = (typeof SIIGO_CORRECCION_VIAS)[number];

/**
 * Mínimo del motivo. Más largo que el del reverso de liquidación (5) a propósito: aquel explica un
 * cambio interno reversible; este explica por qué se tocó un documento ante la autoridad tributaria,
 * y «error» no lo explica.
 */
export const SIIGO_CORRECCION_MOTIVO_MIN = 10;
export const SIIGO_CORRECCION_MOTIVO_MAX = 1000;

/** Una opción del menú de correcciones, admisible o no, siempre con su motivo (AC1). */
export interface SiigoCorreccionOpcion {
  tipo: SiigoCorreccionTipo;
  /** ¿Se puede registrar hoy una corrección de este tipo sobre esta factura? */
  admisible: boolean;
  /**
   * ¿Podría ejecutarla FLITO contra Siigo el día que exista el ejecutor automático (HU #11344)?
   *
   * Separado de `admisible` porque son preguntas distintas: hoy **nada** es automatizable —no hay
   * ejecutor— pero eso no impide registrar lo que se hizo por fuera.
   */
  automatizable: boolean;
  /** Ejecutores disponibles para este tipo. Hoy `['manual']` o vacío si no es admisible. */
  ejecutores: SiigoCorreccionEjecutor[];
  /** Por qué sí o por qué no. Nunca vacío: una exclusión sin motivo no es una respuesta. */
  motivo: string;
}

/** El resultado de `evaluarCorreccion()`. Función del estado y del tiempo, sin llamar a Siigo. */
export interface SiigoEvaluacionCorreccion {
  /** ¿Hay algún tipo admisible? Equivale a «existe un documento que corregir». */
  puedeCorregirse: boolean;
  via: SiigoCorreccionVia;
  /** El camino en una frase, para el mensaje de error y para la pantalla. */
  viaTexto: string;
  /** Horas desde que la factura existe. `null` si nunca llegó a existir. */
  antiguedadHoras: number | null;
  opciones: SiigoCorreccionOpcion[];
  /** ¿Ya hay una corrección registrada? La factura sigue existiendo; solo deja de estar pendiente. */
  yaCorregida: boolean;
}

/** Una corrección registrada, tal como la devuelve la API. */
export interface SiigoCorreccionRegistrada {
  id: string;
  facturaId: string;
  tipo: SiigoCorreccionTipo;
  ejecutor: SiigoCorreccionEjecutor;
  /** Número o identificador del documento en Siigo. Sin él la corrección no se puede verificar. */
  documentoSiigo: string;
  motivo: string;
  /** Cuándo se hizo en Siigo (`yyyy-MM-dd`). Distinto de `registradaEn`, que es cuándo se anotó. */
  fechaCorreccion: string;
  registradaEn: string;
  registradoPor: number | null;
  registradoPorNombre: string | null;
}

/** Cómo ve el reporte y la bandeja un trámite ya corregido (AC4). */
export interface SiigoTramiteCorregido {
  tramiteId: string;
  facturaId: string | null;
  corregida: boolean;
  tipo: SiigoCorreccionTipo | null;
  documentoSiigo: string | null;
  fechaCorreccion: string | null;
}
