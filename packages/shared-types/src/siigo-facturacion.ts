// FLITO — facturación electrónica: conceptos facturables y su tratamiento tributario (HU #11282,
// Feature #11240).
//
// Módulo PURO (sin zod ni side-effects): lo consumen la API, la web y los tests.
//
// Por qué una constante NUEVA y no `CONCEPTOS_TARIFA` (flito-estados.ts): esa lista vale
// `['tramite_digital', 'logistica']`, que son los conceptos que SE NEGOCIAN con cada compañía. Los
// facturables son otra cosa —todo lo que puede aparecer como línea en la factura, incluidos los
// desembolsos que FLIT no negocia (SOAT, impuesto, derecho de tránsito) y el GMF—. Fusionarlas
// haría que añadir una tarifa negociable creara una línea de factura, y viceversa.

/**
 * Conceptos que pueden convertirse en una línea de la factura electrónica.
 *
 * Salen uno a uno de las columnas de valor de `flito_liquidaciones`, que es la liquidación SELLADA:
 * lo que se factura es exactamente lo que se liquidó, ni un concepto más ni uno menos. Si mañana la
 * liquidación gana una columna de valor, esta lista y la semilla del mapeo tienen que crecer con
 * ella — no hay forma de facturar algo que la liquidación no calcula.
 */
export const CONCEPTOS_FACTURABLES = [
  'soat',
  'impuesto_vehicular',
  'derecho_transito',
  'tramite_digital',
  'logistica',
  'gmf',
] as const;

export type ConceptoFacturable = (typeof CONCEPTOS_FACTURABLES)[number];

export const esConceptoFacturable = (v: unknown): v is ConceptoFacturable =>
  typeof v === 'string' && (CONCEPTOS_FACTURABLES as readonly string[]).includes(v);

export const CONCEPTO_FACTURABLE_LABEL: Record<ConceptoFacturable, string> = {
  soat: 'SOAT',
  impuesto_vehicular: 'Impuesto vehicular',
  derecho_transito: 'Derecho de tránsito',
  tramite_digital: 'Trámite digital FLIT',
  logistica: 'Logística',
  gmf: 'GMF (4x1000)',
};

/**
 * Columna de `flito_liquidaciones` que aporta el valor de cada concepto.
 *
 * Es la trazabilidad del AC1 escrita como dato: quien arme la factura toma el valor de aquí y no de
 * un `switch` sobre el nombre del concepto. Si una columna se renombra, este mapa es el único sitio
 * que hay que tocar y TypeScript señala el resto.
 */
export const CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION: Record<ConceptoFacturable, string> = {
  soat: 'valorSoat',
  impuesto_vehicular: 'valorImpuesto',
  derecho_transito: 'valorDerecho',
  tramite_digital: 'valorTramiteDigital',
  logistica: 'valorLogistica',
  gmf: 'valorGmf',
};

/**
 * Clasificación tributaria del producto en Siigo. Los tres valores son los que acepta
 * `tax_classification` de `POST /v1/products` (`Taxed | Exempt | Excluded`), traducidos.
 *
 * NO hay un cuarto valor «sin declarar»: eso se representa con la ausencia del dato (null en la
 * fila del mapeo), porque «todavía no lo dijo contabilidad» no es una clasificación tributaria.
 */
export const CLASIFICACIONES_TRIBUTARIAS = ['gravado', 'exento', 'excluido'] as const;
export type ClasificacionTributaria = (typeof CLASIFICACIONES_TRIBUTARIAS)[number];

export const esClasificacionTributaria = (v: unknown): v is ClasificacionTributaria =>
  typeof v === 'string' && (CLASIFICACIONES_TRIBUTARIAS as readonly string[]).includes(v);

export const CLASIFICACION_TRIBUTARIA_LABEL: Record<ClasificacionTributaria, string> = {
  gravado: 'Gravado',
  exento: 'Exento',
  excluido: 'Excluido',
};

/** Equivalencia con `tax_classification` de la API de Siigo. */
export const CLASIFICACION_TRIBUTARIA_SIIGO: Record<ClasificacionTributaria, 'Taxed' | 'Exempt' | 'Excluded'> = {
  gravado: 'Taxed',
  exento: 'Exempt',
  excluido: 'Excluded',
};

/**
 * Impuesto aplicable a un concepto. `id` es el identificador del impuesto EN LA EMPRESA de Siigo
 * (`GET /v1/taxes`), y por eso no es constante entre ambientes: el mismo IVA del 19 % tiene un id
 * distinto en la empresa de pruebas y en la de producción.
 */
export interface ImpuestoAplicable {
  /** Id del impuesto en Siigo. Numérico y propio de la empresa. */
  id: number;
  /** Nombre tal como lo devuelve Siigo. Informativo: lo que viaja en la factura es el id. */
  nombre?: string | null;
  /** Porcentaje declarado en Siigo. Informativo, para que la pantalla no mienta. */
  porcentaje?: number | null;
}

/**
 * Unidad de medida por defecto para factura electrónica (`unit` de `POST /v1/products`). Siigo usa
 * `94` = unidad. Se deja como valor sugerido para la pantalla, NUNCA como relleno silencioso de una
 * fila sin configurar.
 */
export const UNIDAD_MEDIDA_SIIGO_POR_DEFECTO = '94';

/**
 * Tope de `code` en `POST /v1/products`: alfanumérico, sin espacios, hasta 30 caracteres. Validarlo
 * de nuestro lado evita gastar una llamada a Siigo para que la rechace por formato.
 */
export const CODIGO_PRODUCTO_SIIGO_RE = /^[A-Za-z0-9._-]{1,30}$/;

/**
 * Motivos por los que una confirmación de contabilidad puede caerse (AC4). Son los campos cuyo
 * cambio invalida lo que contabilidad revisó; el resto (notas, nombre descriptivo, unidad de
 * medida) no toca el tratamiento tributario y no revierte nada.
 */
export const CAMPOS_QUE_REVIERTEN_CONFIRMACION = [
  'clasificacionTributaria',
  'impuestos',
  'ingresoParaTerceros',
  'codigoProducto',
] as const;
export type CampoQueRevierteConfirmacion = (typeof CAMPOS_QUE_REVIERTEN_CONFIRMACION)[number];

export const CAMPO_REVIERTE_LABEL: Record<CampoQueRevierteConfirmacion, string> = {
  clasificacionTributaria: 'clasificación tributaria',
  impuestos: 'impuestos aplicables',
  ingresoParaTerceros: 'ingreso recibido para terceros',
  codigoProducto: 'código de producto en Siigo',
};
