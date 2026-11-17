// FLITO Revisiones — buscador de trámite de la cola de revisión OCR (Bug #14569, punto 8).
//
// Contrato de `POST /api/flito/revisiones/:id/candidatos/buscar`. Las llaves de búsqueda (placa, VIN,
// N.º FLIT) viajan en el BODY y nunca en la URL (AGENTS.md §14: placa = cuasi-PII). La respuesta no
// proyecta columnas personales del titular: ni nombre ni documento de compradores.

/** Cuántos candidatos devuelve el buscador si el cliente no pide otra cosa. */
export const CANDIDATOS_REVISION_LIMITE = 20;
/** Techo de `limite` que acepta el servidor. */
export const CANDIDATOS_REVISION_LIMITE_MAX = 50;
/** Longitud mínima del texto libre (tras recortar espacios). `''` cuenta como ausente. */
export const CANDIDATOS_REVISION_TEXTO_MIN = 3;
/** Longitud máxima del texto libre (tras recortar espacios). */
export const CANDIDATOS_REVISION_TEXTO_MAX = 60;
/** Longitud máxima de `placa` y de `vin` en el body. */
export const CANDIDATOS_REVISION_PLACA_MAX = 10;
export const CANDIDATOS_REVISION_VIN_MAX = 20;

/** Motivo con que un trámite de derechos aparece pero no se puede elegir (la regla «uno por trámite» sigue en el servidor). */
export const MOTIVO_CANDIDATO_YA_TIENE_DERECHO = 'Ya tiene derecho';

/**
 * Body del buscador. Todo opcional:
 * - `texto` (3..60 tras trim; `''` = ausente): coincidencia parcial sobre N.º FLIT, placa y VIN.
 * - Sin `texto` y con `placa` y/o `vin`: igualdad exacta (placa OR vin), normalizada.
 * - Sin nada: los candidatos del módulo hasta `limite`.
 */
export interface BuscarCandidatosRevisionBody {
  texto?: string;
  placa?: string;
  vin?: string;
  /** 1..50, por defecto {@link CANDIDATOS_REVISION_LIMITE}. */
  limite?: number;
}

/**
 * Un registro al que se puede atar el documento en revisión: SOAT (`flito_soat.id`), impuesto o
 * factura de venta (`flito_impuestos.id`) o trámite (`flito_tramites.id`, en derechos). `id` es lo
 * que se manda como `registroId` a `POST /:id/resolver`.
 */
export interface CandidatoRevisionDto {
  id: string;
  /** N.º FLIT. En SOAT pueden ser varios, unidos por `, `; null en el canal Cliente. */
  idFlit: string | null;
  placa: string | null;
  vin: string | null;
  /** `${idFlit ?? 'Sin N.º FLIT'} · ${placa ?? 'sin placa'}`. */
  etiqueta: string;
  /** SOAT: «marca línea»; derechos: «tipo de trámite · organismo»; impuestos/factura de venta: organismo. */
  detalle: string | null;
  /**
   * Coincidencia EXACTA (normalizada: mayúsculas, sin guiones ni espacios) con la `placa` / `vin` del
   * body. Los dos a la vez son posibles: la UI pinta «Coincide placa y VIN», «Coincide placa» o
   * «Coincide VIN», y nada si los dos son false.
   */
  coincide: { placa: boolean; vin: boolean };
  /** false solo en derechos cuando el trámite ya tiene su derecho registrado. */
  seleccionable: boolean;
  motivoNoSeleccionable: string | null;
}

export interface CandidatosRevisionRespuesta {
  /** Coincidencias exactas primero, luego las más recientes. Vacío si la revisión ya está resuelta. */
  items: CandidatoRevisionDto[];
  /** Cuántos cumplen el filtro en total (no solo los devueltos). */
  total: number;
  /** `total > items.length`: hay más resultados que afinar con la búsqueda. */
  truncado: boolean;
  /** El registro que la revisión ya tiene asociado (`registroId`), en cualquier estado; null si no hay. */
  registroActual: CandidatoRevisionDto | null;
}
