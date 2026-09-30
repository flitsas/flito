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
 * Resumen de una lectura incremental de trámites de FLIT 2 (HU #13091). Ya no es la respuesta de ningún
 * endpoint (el `POST …/flit2/sincronizar` se retiró en la HU #13190): lo producen la lectura programada y
 * la que arranca tras guardar el acceso, y va al log y a la auditoría. Solo números y enums: ningún
 * radicado ni nombre.
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

// ── HU #13097 — estado de la conexión con FLIT 2 (`GET /api/flito/sync/flit2/estado`) ──────────────
// Diseño: `docs/ux/hu-13098-estado-conexion-flit2.md` § «Contrato propuesto». Sin clientId, contraseña,
// pase, cursores ni textos crudos de FLIT 2: solo fechas ISO, banderas, códigos cerrados y un conteo.

export type Flit2ProblemaTipo = 'rechazado' | 'bloqueado' | 'lectura';
export type Flit2RechazoMotivo = 'credenciales' | 'cambio_clave' | 'otro';

export interface Flit2EstadoProblema {
  tipo: Flit2ProblemaTipo;
  /** Solo tipo 'lectura': código de la última lectura fallida (la UI lo mapea a una frase, no lo pinta). */
  codigo: string | null;
  /** Solo tipo 'rechazado': motivo normalizado a la lista cerrada. */
  motivo: Flit2RechazoMotivo | null;
  /** Hora del hecho (ISO). */
  en: string | null;
  /** Solo tipo 'bloqueado': hasta cuándo dura el bloqueo (ISO). */
  hasta: string | null;
}

/**
 * Pulso de la lectura automática (HU #13188) del proceso que atendió el `GET`. Siempre presente, también
 * con `configurado: false`. Con el programa apagado (`FLIT2_SYNC_CRON=false`) `intervaloMs` y `proximaEn`
 * van en null. `proximaEn` puede quedar unos ms antes de `generadoEn` si el timer se retrasa: la UI lo
 * trata como «en breve».
 */
export interface Flit2EstadoAutomatica {
  /** La lectura programada está encendida y armada en este proceso. */
  activa: boolean;
  /** Cada cuánto corre (ms). null con activa=false. */
  intervaloMs: number | null;
  /** ISO. Cuándo sale la próxima corrida. null con activa=false. */
  proximaEn: string | null;
  /** Hay una lectura con el candado tomado en este proceso (cron, botón u otro origen). */
  enCurso: boolean;
  /** ISO. Hora del servidor con que se compuso la respuesta. */
  generadoEn: string;
}

export interface Flit2EstadoConexion {
  /** false si no hay acceso guardado o el servidor no tiene FLIT 2 configurado. */
  configurado: boolean;
  /** Solo con configurado=false. */
  motivoSinConfigurar: 'sin_acceso' | 'ambiente' | null;
  ultimaExitosaEn: string | null;
  ultimoIntentoEn: string | null;
  /** Hay trabajo pendiente o la posición de lectura no está al día. */
  atrasada: boolean;
  /** Calculada en el servidor: ≥ 30 min sin lectura exitosa, o acceso rechazado/bloqueado. false sin configurar. */
  alerta: boolean;
  /** Uno solo, con precedencia rechazado > bloqueado > lectura. */
  problema: Flit2EstadoProblema | null;
  /** Trámites que llegaron sin los datos del comprador (solo el número). */
  piiEnmascarada: { tramites: number; desde: string | null };
  /** HU #13188: pulso de la lectura automática. */
  automatica: Flit2EstadoAutomatica;
}
