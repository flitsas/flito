// Épica #14548 (ADR-0051) — Contrato del visor de solo lectura de los registros de consumo de IA (`/api/ia-consumo`).
// Bloque A: catálogos, búsqueda y detalle. Los DTO de contenido y de exportación (bloque B) no están aquí.
// Sin totales ni costos agregados: el visor muestra registros. Las fechas de la respuesta son instantes ISO 8601; las
// del rango de consulta son `YYYY-MM-DD` (día civil de Colombia).

/** Filas por página de la búsqueda. Sin total: la página siguiente se pide con `siguienteCursor`. */
export const IA_PAGINA = 50;
/** Máximo de días naturales por consulta, ambos extremos incluidos. */
export const IA_RANGO_MAX_DIAS = 31;
/** Meses de ventana por defecto (`IA_CONSUMO_VISOR_VENTANA_MESES`, entero 1..24). */
export const IA_VENTANA_MESES_DEFECTO = 3;

/** Ventana vigente en el servidor: solo se consulta dentro de `[desde, hasta]` (días de Colombia). */
export interface IaVentana {
  desde: string;
  hasta: string;
  meses: number;
}

export interface IaProcesoCatalogo {
  proceso: string;
  modulo: string;
}

/** `GET /api/ia-consumo/catalogos`: listas cerradas para los selects y la ventana vigente. */
export interface IaCatalogos {
  origenes: string[];
  resultados: string[];
  tiposTarea: string[];
  proveedores: string[];
  procesos: IaProcesoCatalogo[];
  modulos: string[];
  ventana: IaVentana;
}

/** Filtros de la búsqueda. Van en el cuerpo (AGENTS §14): ningún dato personal viaja en la URL. */
export interface IaFiltros {
  usuario?: string;
  placa?: string;
  entidad?: string;
  origen?: string;
  modulo?: string;
  proceso?: string;
  tipoTarea?: string;
  proveedor?: string;
  modelo?: string;
  resultado?: string;
}

/** Cuerpo de `POST /api/ia-consumo/registros/buscar`. */
export interface IaBusquedaCuerpo {
  desde: string;
  hasta: string;
  cursor?: string;
  filtros?: IaFiltros;
}

/** Una fila de `ia_consumo_log` en la lista. Sin `error_mensaje` ni `metadatos` (van en el detalle). */
export interface IaRegistroLista {
  id: string;
  correlacionId: string;
  intento: number;
  pasada: number;
  fechaInicio: string;
  fechaFin: string;
  latenciaMs: number;
  aplicativo: string;
  servicio: string;
  ambiente: string;
  tenantId: string | null;
  usuarioId: string | null;
  usuarioLogin: string | null;
  origen: string;
  modulo: string;
  proceso: string;
  tipoTarea: string;
  placa: string | null;
  entidadTipo: string | null;
  entidadId: string | null;
  archivoMime: string | null;
  archivoBytes: number | null;
  archivoPaginas: number | null;
  archivoSha256: string | null;
  proveedor: string;
  modeloSolicitado: string | null;
  modeloRespondido: string | null;
  idRespuestaProveedor: string | null;
  maxTokens: number | null;
  promptCodigo: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  httpStatus: number;
  resultado: string;
  stopReason: string | null;
  errorCodigo: string | null;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheLectura: number;
  tokensCacheEscritura: number;
  costoUsdEstimado: string | null;
}

/**
 * `GET /api/ia-consumo/registros/:id`: la fila completa, salvo `metadatos` si pesa más de 4 096 bytes (entonces va
 * `null` y `metadatosBytes` dice cuánto pesa). Dice si hay contenido guardado y cuánto mide, sin traerlo.
 */
export interface IaRegistroDetalle extends IaRegistroLista {
  errorMensaje: string | null;
  metadatos: Record<string, unknown> | null;
  metadatosBytes: number | null;
  tieneContenido: boolean;
  bytesPrompt: number | null;
  bytesRespuesta: number | null;
  /** Aproximado: el texto mide 65 533 bytes o más. Un texto de esa medida puede no estar recortado. */
  posiblementeRecortado: boolean;
  /** Hasta 20 registros de la misma correlación dentro de la ventana, sin el propio. */
  relacionados: IaRegistroLista[];
}

export interface IaBusquedaRespuesta {
  items: IaRegistroLista[];
  siguienteCursor: string | null;
}

/** Cuerpo de error del visor: `codigo` es estable para ramificar; `error` es el texto para la persona usuaria. */
export interface IaErrorRespuesta {
  error: string;
  codigo: string;
}
