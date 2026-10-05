// HU #13268 (Feature #13267, Épica #12741) — estado del envío del comprobante de pago del impuesto a
// FLIT 2 (outbox `flito_impuesto_envios_flit2`, migración 0219). Los seis valores deben coincidir con
// el CHECK `ck_flito_impuesto_envios_flit2_estado` (test de paridad en apps/api).

export const EstadoEnvioFlit2 = {
  PENDIENTE: 'pendiente',
  /** FLIT 2 aún no admite el adjunto (409 terminal:false): espera a que el trámite cambie. */
  EN_ESPERA: 'en_espera',
  ENVIADO: 'enviado',
  /** El gestor cargó primero su comprobante en FLIT 2 (409 attachment_exists): final. */
  YA_CARGADO_GESTOR: 'ya_cargado_gestor',
  ERROR: 'error',
  /** Pagado sin recibo de pago ni de caja: se programa al cargarse el recibo. */
  SIN_COMPROBANTE: 'sin_comprobante',
} as const;
export type EstadoEnvioFlit2 = typeof EstadoEnvioFlit2[keyof typeof EstadoEnvioFlit2];

export const ESTADOS_ENVIO_FLIT2: readonly EstadoEnvioFlit2[] = Object.values(EstadoEnvioFlit2);

/** Lo que expone el detalle del impuesto (AC10). Sin motivo del error (D-4: va a auditoría). */
export interface EnvioComprobanteFlit2 {
  estado: EstadoEnvioFlit2;
  /** Solo los que consumen intento (no 429, ni pausas, ni en_espera, ni pre-validación local). */
  intentos: number;
  ultimoIntentoEn: string | null;
}

/** Intentos contra FLIT 2 antes de dejar la fila en `error` (AC5). */
export const MAX_INTENTOS_ENVIO_FLIT2 = 3;

// ── HU #13269 — reemplazo del comprobante de pago ───────────────────────────────────────────────

/**
 * Por qué el reemplazo NO reprogramó el envío a FLIT 2:
 *   · `ya_cargado_gestor`: el gestor cargó primero el suyo en FLIT 2; gana el gestor y no se reenvía.
 *   · `no_flit2`: el trámite no viene de FLIT 2 (el reemplazo queda solo en FLITO).
 *   · `sin_envio_previo`: trámite de FLIT 2 pagado antes del envío automático: sin fila, no se envía (D-5).
 */
export type MotivoSinReenvioFlit2 = 'ya_cargado_gestor' | 'no_flit2' | 'sin_envio_previo';

/** Lo que hizo el reemplazo con el envío a FLIT 2 (lo dice la UI de la #13270). */
export type ReprogramacionEnvioFlit2 =
  | { reenviado: true }
  | { reenviado: false; motivo: MotivoSinReenvioFlit2 };

/**
 * Códigos de error del reemplazo. Los de archivo, 404 y estado tienen el MISMO valor que los de la carga
 * por fase (`CodigoErrorCargaPorFase`): el rechazo es el mismo.
 */
export const CodigoErrorReemplazoComprobante = {
  /** 400: sin archivo, más de uno, tipo no permitido, bytes que no cuadran o > 15 MiB. */
  ARCHIVO_INVALIDO: 'archivo_invalido',
  /** 404: el impuesto no existe o queda fuera de la frontera del actor. */
  NO_ENCONTRADO: 'no_encontrado',
  /** 409: el impuesto no está `pagado`. */
  ESTADO_NO_PERMITIDO: 'estado_no_permitido',
  /** 409: el impuesto no tiene comprobante de pago vigente: se usa la carga normal (AC4). */
  SIN_COMPROBANTE_VIGENTE: 'sin_comprobante_vigente',
} as const;
export type CodigoErrorReemplazoComprobante =
  (typeof CodigoErrorReemplazoComprobante)[keyof typeof CodigoErrorReemplazoComprobante];

/**
 * Respuesta 200 del reemplazo. `reemplazado` escribió (viejo descartado, nuevo vigente); los demás no
 * escribieron nada y traen el `detalle` (mismos textos que la carga por fase).
 */
export type RespuestaReemplazoComprobante =
  | { resultado: 'reemplazado'; soporteId: string; soportesDescartados: string[]; envioFlit2: ReprogramacionEnvioFlit2 }
  | { resultado: 'duplicado' | 'fase_no_coincide' | 'placa_no_coincide'; detalle: string };
