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

/**
 * Desenlace de «Probar conexión» (HU #13063). Es dato (200), no error HTTP: la pantalla lo pinta
 * como aviso con su propio texto a partir de este valor. Un valor por caso:
 * `rechazado` = 401 `invalid_client` · `cambio_clave` = 403 `secret_rotation_required` ·
 * `bloqueado` = 423 o pausa vigente por 423 · `espera` = 429 o pausa vigente por 429.
 */
export type Flit2PruebaEstado =
  | 'conectado'
  | 'conectado_sin_pii'
  | 'rechazado'
  | 'cambio_clave'
  | 'bloqueado'
  | 'espera'
  | 'no_responde'
  | 'no_configurado'
  | 'sin_acceso';

/** Respuesta de `POST /api/flito/sync/flit2/acceso/probar`. Nunca lleva el pase ni la contraseña. */
export interface Flit2PruebaResultado {
  resultado: Flit2PruebaEstado;
  /** Español llano, de un mapa fijo: nunca el cuerpo de error de FLIT 2. */
  mensaje: string;
  /** ISO 8601. Solo con `bloqueado` o `espera`: hasta cuándo no se vuelve a llamar. */
  bloqueadoHasta: string | null;
  /** Permisos que concedió FLIT 2 al pase (solo con `conectado*`). */
  scope: string[];
}

/**
 * Resumen de una lectura incremental de trámites de FLIT 2 (HU #13091), respuesta de
 * `POST /api/flito/sync/flit2/sincronizar`. Solo números y enums: ningún radicado ni nombre.
 *
 * Cada ítem leído cae en UNA sola clase, así que
 * `leidos = nuevos + actualizados + sinCambios + conflictos + sinVehiculo + eliminadosIgnorados + invalidos`.
 */
export interface Flit2LecturaResultado {
  leidos: number;
  nuevos: number;
  actualizados: number;
  /** Ya guardado con una versión igual o mayor, o llegó idéntico. */
  sinCambios: number;
  /** El radicado ya existe con otra identidad (FLIT 1 u otro id de FLIT 2): no se toca. */
  conflictos: number;
  /** Trámite nuevo sin vehículo o sin VIN: no se guarda hasta que llegue con él. */
  sinVehiculo: number;
  /** Tombstones (`eliminado: true`): se ignoran y solo se cuentan. */
  eliminadosIgnorados: number;
  /** Ítems que no cumplen el contrato (id no uuid, syncVersion no entero…): se saltan. */
  invalidos: number;
  companiasFaltantes: number;
  organismosSinEmparejar: number;
  paginas: number;
  /** `true` = se cortó por el tope de páginas: queda más por leer, basta volver a pulsar. */
  hasMore: boolean;
  /** `since` en la primera corrida (arranque sin histórico); `cursor` en las siguientes. */
  modo: 'since' | 'cursor';
  /** ISO 8601. */
  ejecutadoEn: string;
}
