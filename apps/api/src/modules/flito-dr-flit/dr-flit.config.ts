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

/**
 * Límites de adjuntos que el GET expone al panel. HU-3 (#13805) los hará configurables
 * (`DRFLIT_ADJUNTOS_MAX` / `DRFLIT_ADJUNTO_MAX_MB`); los TIPOS no son configurables (P9-4).
 */
export const ADJUNTOS_DRFLIT: Readonly<{ maxArchivos: number; maxBytesArchivo: number; tipos: readonly TipoAdjuntoSoporte[] }> =
  Object.freeze({
    maxArchivos: 3,
    maxBytesArchivo: 5 * 1024 * 1024,
    tipos: Object.freeze(['image/png', 'image/jpeg', 'application/pdf'] as const),
  });
