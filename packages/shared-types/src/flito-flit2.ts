// Acceso de FLITO a FLIT 2 (Feature #13057, HU #13061). Contrato del proveedor en
// `docs/integraciones/flit2-api.md`; diseño en `docs/diseno/hu-13061-13063-acceso-flit2.md`.

/** Estado del acceso vigente según las marcas que deja el pase (HU #13063). */
export type Flit2AccesoEstado = 'vigente' | 'rechazado' | 'bloqueado';

/**
 * Lo que se sabe del acceso a FLIT 2 sin decir la contraseña: ni entera, ni recortada, ni un prefijo.
 * `configurado: false` (con el resto en `null`) es un estado normal, no un error.
 */
export interface Flit2AccesoMeta {
  configurado: boolean;
  /** Usuario de servicio (`client_id`). No es secreto: es el nombre con el que FLIT 2 conoce a FLITO. */
  clientId: string | null;
  actualizadoPor: { id: number; nombre: string } | null;
  /** ISO 8601. Desde cuándo está vigente este acceso. */
  actualizadoEn: string | null;
  estado: Flit2AccesoEstado | null;
  /** ISO 8601. Solo con `estado: 'bloqueado'`. */
  bloqueadoHasta: string | null;
}

/** Cuerpo de `PUT /api/flito/sync/flit2/acceso`. */
export interface Flit2GuardarAccesoInput {
  clientId: string;
  clientSecret: string;
}
