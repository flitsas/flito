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
