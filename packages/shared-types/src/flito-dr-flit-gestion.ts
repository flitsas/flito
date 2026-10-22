// Dr. Flit — consultas de gestión sin IA (Feature #13834, HU #13836 G1).
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · campos: docs/ux/flito-dr-flit-f6.md §F6.6.
//
// El valor buscado (placa, VIN o id FLIT) viaja SIEMPRE en el body de `POST /api/flito/<modulo>/buscar`
// (AGENTS.md §14). Cada módulo responde como mucho `TARJETAS_POR_MODULO` tarjetas y el total real.
// Los DTO de tarjeta llevan solo el subconjunto de la fila de la cola que la UX fija: nunca comprador,
// documento, correo, VIN, soportes ni payloads crudos. G2 (SOAT) y G3 (impuestos, derechos) añaden aquí
// sus propias tarjetas.

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
