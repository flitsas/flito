// Dr. Flit — consultas de gestión sin IA (Feature #13834, HU #13836 G1).
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · campos: docs/ux/flito-dr-flit-f6.md §F6.6.
//
// El valor buscado (placa, VIN o id FLIT) viaja SIEMPRE en el body de `POST /api/flito/<modulo>/buscar`
// (AGENTS.md §14). Cada módulo responde como mucho `TARJETAS_POR_MODULO` tarjetas y el total real.
// Los DTO de tarjeta llevan solo el subconjunto de la fila de la cola que la UX fija: nunca comprador,
// documento, correo, VIN (salvo la tarjeta SOAT sin placa: es su título), soportes ni payloads crudos.
// G2 (SOAT) y G3 (impuestos, derechos) añaden aquí sus propias tarjetas.

/** Largo máximo del valor buscado (tras `trim`). */
export const MAX_VALOR_GESTION = 100;
/** Tarjetas por módulo: el resto se ve en la pantalla del módulo. */
export const TARJETAS_POR_MODULO = 5;

export const MODULOS_GESTION = ['tramites', 'soat', 'impuestos', 'derechos'] as const;
export type ModuloGestion = (typeof MODULOS_GESTION)[number];

/** Body de `POST /api/flito/<modulo>/buscar`. */
export interface BusquedaGestionRequest { valor: string }

/** Respuesta de cada módulo: `items.length <= TARJETAS_POR_MODULO`; `total` es el conteo real. */
export interface ResultadoGestion<T> { total: number; items: T[] }

/** Tarjeta de Gestión Trámites (UX F6.6): placa · id FLIT, chip de estado, trámite, empresa y creado. */
export interface TarjetaTramiteGestion {
  /** Id opaco del trámite (uuid): solo para la `key` de la lista, nunca en una URL. */
  id: string;
  placa: string | null;
  idFlit: string;
  /** Estado crudo de FLIT, el mismo de la cola. */
  estado: string;
  /** true si el estado FLIT es «Asignado»: decide el tono del chip, igual que en la cola. */
  asignado: boolean;
  tipoTramite: string | null;
  /** Nombre de la empresa gestora (compañía). */
  empresa: string | null;
  /** Fecha de creación del trámite en FLIT (ISO), con la de FLITO como respaldo. */
  creado: string | null;
}

/**
 * Tarjeta de Gestión SOAT (UX F6.6, HU #13837): título placa (o VIN sin placa), chip de estado, Compañía
 * (solo si la cola se la muestra a ese usuario), Solicitado y Pagado. Solo campos presentes en las dos
 * ramas de la fila de la cola (interna y del canal Cliente): nada de proveedor, gestión, valor ni vigencia.
 */
export interface TarjetaSoatGestion {
  /** Id opaco de la solicitud SOAT (uuid): solo para la `key` de la lista, nunca en una URL. */
  id: string;
  placa: string | null;
  /**
   * VIN, SOLO cuando no hay placa (es el título de la tarjeta en ese caso). Con placa no viaja: el VIN es
   * cuasi-PII y la tarjeta no lo muestra.
   */
  vin?: string;
  /** Estado de la solicitud SOAT (`EstadoSoat`), el mismo de la cola. */
  estado: string;
  /**
   * Nombre de la compañía. Ausente cuando la cola no muestra esa columna al usuario (proyección del canal
   * Cliente: la compañía es la suya, fija).
   */
  compania?: string;
  /** Fecha en que se solicitó (envió al gestor) el SOAT (ISO) o null. */
  solicitado: string | null;
  /** Fecha de pago (ISO) o null. */
  pagado: string | null;
}

/**
 * Tarjeta de Gestión Impuestos (UX F6.6, HU #13838): título placa · id FLIT, chip con el estado de la cola,
 * Organismo, Liquidado y Fecha de pago. Sin comprador, documento, VIN, valores pagados ni semáforo.
 */
export interface TarjetaImpuestoGestion {
  /** Id opaco del impuesto (uuid): solo para la `key` de la lista, nunca en una URL. */
  id: string;
  placa: string | null;
  idFlit: string;
  /** Estado del impuesto (`EstadoImpuesto`), el mismo de la cola. */
  estado: string;
  /** Nombre del organismo de tránsito, con el código como respaldo. */
  organismo: string;
  /** Valor liquidado (pesos) o null. */
  liquidado: number | null;
  /** Fecha de pago (ISO) o null. */
  pagado: string | null;
}

/**
 * Tarjeta de Gestión Derechos (UX F6.6, HU #13838): la fila de la pestaña «Registrados» de Derechos. Título
 * placa · id FLIT; la cola no tiene estado, así que el único chip es «Con advertencia» y solo si la fila la
 * trae. Filas Concepto (el del recibo), Valor y Fecha de pago. Sin empresa, VIN, radicado ni soportes.
 */
export interface TarjetaDerechoGestion {
  /** Id opaco del registro de derechos (uuid): solo para la `key` de la lista, nunca en una URL. */
  id: string;
  placa: string | null;
  idFlit: string;
  /** true si el registro trae advertencias: pinta el chip «Con advertencia». */
  conAdvertencia: boolean;
  /** Concepto que dice el recibo (`tipoTramiteRecibo`) o null. */
  concepto: string | null;
  /** Valor pagado según el recibo (pesos) o null. */
  valor: number | null;
  /** Fecha de pago del recibo (`YYYY-MM-DD`) o null. */
  fechaPago: string | null;
}
