// Siigo — configuración global de emisión (HU #11284, Feature #11240).
//
// Con qué tipo de comprobante, vendedor, forma de pago y centro de costo nacen las facturas. Son
// cuatro identificadores de UNA empresa de Siigo, así que la configuración es por ambiente, igual
// que los catálogos (HU #11281) y el mapeo de conceptos (HU #11282).
//
// **Tres de los criterios de esta historia describen decisiones que contabilidad todavía no ha
// tomado.** Están implementados como configuración y no como comportamiento, para que responderlas
// más adelante sea cambiar un dato y no reescribir la emisión:
//
//   · AC3 — forma de pago ÚNICA y global. Siigo no admite más de una por factura. Si mañana se
//     decide capturarla por cliente o por trámite, eso es una historia nueva: hoy el modelo de
//     FLITO no tiene forma de pago en ninguna parte.
//   · AC4 — plazo de vencimiento en días, opcional, cero por defecto. El CÁLCULO de la fecha vive
//     en la historia de emisión; aquí solo se declara el plazo.
//   · AC5 — estrategia de numeración configurable, con un solo valor admitido: el consecutivo lo
//     asigna Siigo. Que el enum tenga un elemento es deliberado — añadir «lo envía FLITO» exige una
//     migración y, con ella, una decisión explícita.

/** Estrategias de numeración. Ver AC5: hoy solo una, y ampliarla es una decisión, no un descuido. */
export const ESTRATEGIAS_NUMERACION = ['siigo'] as const;

export type EstrategiaNumeracion = typeof ESTRATEGIAS_NUMERACION[number];

export function esEstrategiaNumeracion(v: unknown): v is EstrategiaNumeracion {
  return typeof v === 'string' && (ESTRATEGIAS_NUMERACION as readonly string[]).includes(v);
}

/**
 * Los cuatro campos que apuntan a un catálogo de Siigo.
 *
 * Se enumeran como constante y no como claves sueltas porque tanto la validación (AC2) como el
 * informe de lo que falta (AC6) tienen que recorrerlos: si alguien añade un quinto campo y olvida
 * uno de los dos recorridos, el hueco no se nota hasta producción.
 */
export const CAMPOS_CATALOGO_EMISION = [
  'documentoTipo',
  'vendedor',
  'formaPago',
  'centroCosto',
] as const;

export type CampoCatalogoEmision = typeof CAMPOS_CATALOGO_EMISION[number];

/** Etiquetas para la interfaz y para los mensajes. Fuente única. */
export const CAMPO_CATALOGO_EMISION_ETIQUETA: Record<CampoCatalogoEmision, string> = {
  documentoTipo: 'Tipo de comprobante',
  vendedor: 'Vendedor',
  formaPago: 'Forma de pago',
  centroCosto: 'Centro de costo',
};

/**
 * Estado de un campo frente a la copia local del catálogo (AC2).
 *
 * `no_aplica` es el centro de costo cuando el tipo de comprobante elegido no lo exige: no está mal
 * que falte, es que no hace falta. Sin ese valor, una configuración correcta aparecería incompleta.
 */
export const VALIDECES_CAMPO_EMISION = [
  'ok',
  'sin_configurar',
  'no_existe',
  'inactivo',
  'catalogo_sin_sincronizar',
  'no_aplica',
] as const;

export type ValidezCampoEmision = typeof VALIDECES_CAMPO_EMISION[number];

/** Diagnóstico de un campo: qué se guardó, si sigue siendo válido y por qué no. */
export interface CampoEmisionValidado {
  campo: CampoCatalogoEmision;
  etiqueta: string;
  /** Código guardado en la configuración. `null` si nunca se configuró. */
  codigo: string | null;
  /** Nombre según la copia local del catálogo, para que la pantalla no muestre solo un número. */
  nombre: string | null;
  validez: ValidezCampoEmision;
  /** Texto accionable cuando `validez` no es `ok` ni `no_aplica`. */
  mensaje: string | null;
}

/** La configuración vigente de un ambiente, con su diagnóstico. */
export interface ConfigEmision {
  id: string;
  ambiente: string;
  documentoTipoCodigo: string | null;
  vendedorCodigo: string | null;
  formaPagoCodigo: string | null;
  centroCostoCodigo: string | null;
  /** AC4 — días. Cero significa «de contado», no «sin declarar». */
  plazoVencimientoDias: number;
  estrategiaNumeracion: EstrategiaNumeracion;
  notas: string | null;
  actualizadaEn: string;
  actualizadaPorId: number | null;
  /** Diagnóstico campo a campo contra los catálogos sincronizados (AC2). */
  campos: CampoEmisionValidado[];
  /**
   * true = los cuatro campos aplicables están configurados y siguen siendo válidos.
   *
   * Derivado, nunca almacenado: si se guardara, una sincronización que invalidara un vendedor
   * dejaría la fila diciendo «lista» hasta que alguien recalculara.
   */
  utilizable: boolean;
}

/**
 * Estado de la parametrización de emisión de un ambiente (AC6).
 *
 * Es lo que consume la compuerta de producción de la HU #11285. `faltantes` enumera los campos, no
 * un contador: la compuerta tiene que poder decir QUÉ falta, no solo cuántos.
 */
export interface EstadoConfigEmision {
  ambiente: string;
  /** false si nunca se guardó una configuración en este ambiente. */
  configurada: boolean;
  completa: boolean;
  /** Campos obligatorios sin valor. */
  faltantes: CampoCatalogoEmision[];
  /** Campos con valor que dejó de ser válido en Siigo (AC2). */
  invalidos: CampoEmisionValidado[];
}
