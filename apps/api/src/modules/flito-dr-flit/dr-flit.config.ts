// Dr. Flit soporte — disponibilidad y ambiente (HU #13803, Feature #13695). Diseño F5, «Disponibilidad».
//
//   ambiente   = DEPLOY_ENVIRONMENT ?? (NODE_ENV === 'development' ? 'DEV' : null)
//   disponible = ambiente !== null && (
//                  (MODO = simulado && ambiente !== PDN) || (MODO = real && PAT && ORG_URL))
//
// Fallo cerrado: en producción sin DEPLOY_ENVIRONMENT el soporte no está disponible (no se adivina).
// Funciones puras sobre un objeto de configuración para poder probarlas sin recargar `env`.
import {
  ETIQUETAS_AMBIENTE_DESPLIEGUE, type AmbienteDespliegue, type TipoAdjuntoSoporte,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';

export interface ConfigDrFlit {
  NODE_ENV: 'development' | 'production';
  DEPLOY_ENVIRONMENT?: AmbienteDespliegue;
  DRFLIT_ADO_MODO: 'real' | 'simulado';
  DRFLIT_ADO_PAT?: string;
  DRFLIT_ADO_ORG_URL?: string;
}

/** HU #13854 (Feature #13696, IA-2) — configuración de la IA de Dr. Flit. */
export interface ConfigIaDrFlit {
  DRFLIT_IA_HABILITADA: boolean;
  ANTHROPIC_API_KEY?: string;
  DRFLIT_IA_TOPE_DIARIO: number;
}

/** IA disponible = interruptor encendido (`=1`) Y clave de Anthropic configurada. Fallo cerrado. */
export function iaDisponible(c: Pick<ConfigIaDrFlit, 'DRFLIT_IA_HABILITADA' | 'ANTHROPIC_API_KEY'> = env): boolean {
  return c.DRFLIT_IA_HABILITADA && Boolean(c.ANTHROPIC_API_KEY);
}

/** Tope diario de mensajes a la IA por usuario (`DRFLIT_IA_TOPE_DIARIO`, 0..500; 0 = sin cupo). */
export function topeDiarioIa(c: Pick<ConfigIaDrFlit, 'DRFLIT_IA_TOPE_DIARIO'> = env): number {
  return c.DRFLIT_IA_TOPE_DIARIO;
}

export function ambienteDespliegue(c: ConfigDrFlit = env): AmbienteDespliegue | null {
  return c.DEPLOY_ENVIRONMENT ?? (c.NODE_ENV === 'development' ? 'DEV' : null);
}

export function etiquetaAmbiente(a: AmbienteDespliegue | null): string | null {
  return a ? ETIQUETAS_AMBIENTE_DESPLIEGUE[a] : null;
}

export function soporteDisponible(c: ConfigDrFlit = env): boolean {
  const ambiente = ambienteDespliegue(c);
  if (ambiente === null) return false;
  if (c.DRFLIT_ADO_MODO === 'simulado') return ambiente !== 'PDN';
  return Boolean(c.DRFLIT_ADO_PAT && c.DRFLIT_ADO_ORG_URL);
}

/** Tipos de adjunto admitidos (P9-4: NO configurables). Se verifican por bytes, no por extensión. */
export const TIPOS_ADJUNTO_DRFLIT: readonly TipoAdjuntoSoporte[] =
  Object.freeze(['image/png', 'image/jpeg', 'application/pdf'] as const);

export interface LimitesAdjuntosDrFlit {
  maxArchivos: number;
  maxBytesArchivo: number;
  tipos: readonly TipoAdjuntoSoporte[];
}

/** Límites de adjuntos desde la configuración (HU #13805, AC3): `DRFLIT_ADJUNTOS_MAX` y `DRFLIT_ADJUNTO_MAX_MB`. */
export function limitesAdjuntos(
  c: { DRFLIT_ADJUNTOS_MAX: number; DRFLIT_ADJUNTO_MAX_MB: number } = env,
): Readonly<LimitesAdjuntosDrFlit> {
  return Object.freeze({
    maxArchivos: c.DRFLIT_ADJUNTOS_MAX,
    maxBytesArchivo: c.DRFLIT_ADJUNTO_MAX_MB * 1024 * 1024,
    tipos: TIPOS_ADJUNTO_DRFLIT,
  });
}

/**
 * Límites vigentes del proceso. El GET de autorización los expone al panel y el multer de
 * `POST /casos-soporte` los aplica: una sola fuente para lo que se anuncia y lo que se exige.
 */
export const ADJUNTOS_DRFLIT: Readonly<LimitesAdjuntosDrFlit> = limitesAdjuntos();
