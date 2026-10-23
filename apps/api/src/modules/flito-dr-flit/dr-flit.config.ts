// Dr. Flit soporte — disponibilidad y ambiente (HU #13803, Feature #13695). Diseño F5, «Disponibilidad».
//
//   ambiente   = DEPLOY_ENVIRONMENT ?? (NODE_ENV === 'development' ? 'DEV' : 'PDN')
//   disponible = (MODO = simulado && ambiente !== PDN) || (MODO = real && PAT && ORG_URL)
//
// HU #13913 (decisión humana 2026-10-23): el soporte funciona en cualquier ambiente; en producción
// sin DEPLOY_ENVIRONMENT se asume PDN (caso sin tag FLITO-PRUEBAS). Local sin la variable = DEV.
// El simulado en producción sin la variable no arranca (validación de `env`): sería simulado en PDN.
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

export function ambienteDespliegue(c: ConfigDrFlit = env): AmbienteDespliegue {
  return c.DEPLOY_ENVIRONMENT ?? (c.NODE_ENV === 'development' ? 'DEV' : 'PDN');
}

export function etiquetaAmbiente(a: AmbienteDespliegue): string {
  return ETIQUETAS_AMBIENTE_DESPLIEGUE[a];
}

export function soporteDisponible(c: ConfigDrFlit = env): boolean {
  if (c.DRFLIT_ADO_MODO === 'simulado') return ambienteDespliegue(c) !== 'PDN';
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
