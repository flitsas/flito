// FLITO — SOAT, canal Cliente: el SOAT que el RUNT reporta como activo (HU #12842, Feature #12840).
//
// Contrato entre `flito-soat-cliente` (API) y el wizard del canal Cliente (web, HU #12844).
// Desde la RN-05 del Feature #12840 el canal PUBLICA la póliza del RUNT, la aseguradora y las
// fechas del SOAT activo: en el `409 soat_vigente` (anidado en `soatActivo`) y en el aviso
// `vigenciaProxima` del 200 de la preconsulta (plano junto a `venceEl`).

/**
 * El SOAT que el RUNT reporta en `data.soat[0]`. Solo cuenta el primero.
 *
 * Fechas en `yyyy-mm-dd` del día en Bogotá. Un dato que el RUNT no trajo va en `null`, nunca se
 * inventa.
 */
export interface SoatActivoRunt {
  /** `numSoat` del RUNT, normalizada como se persiste en `flito_soat.poliza_runt`. */
  poliza: string | null;
  /** `fechaExpedicion`. */
  fechaExpedicion: string | null;
  /** `fechaInicioPoliza`. */
  inicioVigencia: string | null;
  /** `fechaVencimSoat`. */
  vencimiento: string | null;
  /** `razonSocialAsegur`. El RUNT no trae el NIT de la aseguradora. */
  aseguradora: string | null;
  /** El campo `estado` del RUNT (p. ej. «VIGENTE»). Nunca `estadoSoat`, que es otra cosa. */
  estado: string | null;
}

/** Aviso del 200 de la preconsulta cuando al SOAT vigente le quedan ≤ 30 días. */
export interface VigenciaProximaSoat extends SoatActivoRunt {
  /** `yyyy-mm-dd`. No es nullable: sin fecha no hay aviso, hay 409. */
  venceEl: string;
}

/**
 * Datos del cuerpo del `409 soat_vigente` (van en el nivel superior del cuerpo del error, junto a
 * `codigo` y `mensaje`). `soatActivo` va anidado para no chocar con la clave `estado` del 409 de
 * solicitud propia.
 */
export interface DatosSoatVigente409 {
  /** Se conserva por compatibilidad: AUSENTE (no null) si el RUNT no trae fecha. */
  fechaVencimiento?: string;
  /** Siempre presente en este 409, con `null` por dato ausente. */
  soatActivo: SoatActivoRunt;
}

/** Ventana de renovación anticipada: vence hoy + 30 días o antes (inclusive), en Bogotá. */
export const DIAS_RENOVACION_ANTICIPADA = 30;
