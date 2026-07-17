// ADR-OPS-001 — modo de integraciones: directo vs proxy legacy CEA.

import { env } from '../../config/env.js';

export type IntegracionesMode = 'direct' | 'cea-proxy';

/** `direct` si INTEGRACIONES_MODE=direct o credenciales Fasecolda presentes; si no cea-proxy. */
export function integracionesMode(): IntegracionesMode {
  const m = env.INTEGRACIONES_MODE;
  if (m === 'direct') return 'direct';
  if (m === 'cea-proxy') return 'cea-proxy';
  // auto: direct cuando hay credenciales Fasecolda (señal de cutover configurado)
  if (env.FASECOLDA_USER && env.FASECOLDA_PASS) return 'direct';
  return 'cea-proxy';
}

export function useCeaProxy(): boolean {
  return integracionesMode() === 'cea-proxy';
}
