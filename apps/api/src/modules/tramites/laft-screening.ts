// EPIC TRAM-INNOV · B6 (Sprint C) — screening LAFT de comprador/vendedor en pre-vuelo.
//
// Reutiliza el motor de listas restrictivas LAFT (`checkAllLists` /
// `decideFromMatches`). Semáforo INFORMATIVO: NO bloquea el trámite (la decisión
// es humana / política PO). Degradación elegante: timeout 3s o fallo → `unknown`
// (nunca lanza). Sin PII: el resultado expone solo conteo + señal de lista
// (listCode/kind/score), nunca cédulas ni nombres de la contraparte ni del
// listado.

import { checkAllLists, decideFromMatches, type MatchResult } from '../laft/match.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.laft');

export type LaftStatus = 'green' | 'yellow' | 'red' | 'unknown';
export interface LaftScreening {
  status: LaftStatus;
  /** Coincidencias significativas (score ≥ 60). */
  matches: number;
  /** Señal de la mejor coincidencia, sin PII: "OFAC · doc_exact (100)". */
  topSignal: string | null;
}

const SCREEN_TIMEOUT_MS = 3000;
const SIGNIFICATIVO = 60; // umbral name_partial+

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('laft timeout')), ms)),
  ]);
}

/** Mapea las coincidencias a un semáforo informativo (PURO, testeable). */
export function mapScreening(matches: MatchResult[]): LaftScreening {
  const significativos = matches.filter((m) => m.score >= SIGNIFICATIVO);
  const decision = decideFromMatches(matches);
  let status: LaftStatus = 'green';
  if (decision.shouldBlock || decision.needsReview) status = 'red'; // hit fuerte en lista vinculante
  else if (significativos.length > 0) status = 'yellow';            // referencia / parcial → DD intensificada
  const top = matches[0];
  const topSignal = top && top.score >= SIGNIFICATIVO ? `${top.listCode} · ${top.kind} (${top.score})` : null;
  return { status, matches: significativos.length, topSignal };
}

/**
 * Screening de una parte. `null` si no hay documento (no aplica). `unknown` si no
 * hay nombre suficiente o si LAFT falla/timeout. Nunca lanza.
 */
export async function screenParte(doc: string | undefined | null, nombre: string | undefined | null): Promise<LaftScreening | null> {
  if (!doc) return null;
  const fullName = (nombre ?? '').trim();
  if (fullName.length < 2) return { status: 'unknown', matches: 0, topSignal: null };
  try {
    const matches = await withTimeout(checkAllLists({ docNumber: doc, fullName }), SCREEN_TIMEOUT_MS);
    return mapScreening(matches);
  } catch (e: any) {
    log.warn({ err: e?.message }, 'screening LAFT falló — degradado a unknown');
    return { status: 'unknown', matches: 0, topSignal: null };
  }
}

/** Últimos 4 dígitos del documento (para evento/audit sin exponer la cédula). */
export function docLast4(doc: string | undefined | null): string | null {
  if (!doc) return null;
  const d = String(doc).replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}
