// TRAM-INNOV-PRE-02 — CTAs canónicos del pre-vuelo (server-driven).
//
// Fuente ÚNICA de las acciones accionables de cada check del pre-vuelo. El API
// adjunta `action` a cada check (`getPreflightAction`); la web la consume tal cual
// (sin mapeo cliente). Cada acción lleva un `ctaId` estable para telemetría
// (POST /tramites/:id/preflight/cta → evento preflight_cta_clicked).
//
// Pura, sin IO. Reemplaza el mapeo cliente de TRAM-PRE-01 (preflightActions.ts).

export type PreflightCheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

/** Acción canónica de un check. `kind` discrimina el payload. */
export type PreflightAction =
  | { kind: 'link'; label: string; ctaId: PreflightCtaId; href: string }
  | { kind: 'step'; label: string; ctaId: PreflightCtaId; step: number }
  | { kind: 'hint'; label: string; ctaId: PreflightCtaId; hint: string };

/** URLs externas oficiales (consulta del operador). */
export const PREFLIGHT_URLS = {
  SIMIT: 'https://consultasimit.fcm.org.co/',
  RUNT: 'https://www.runt.com.co/',
} as const;

/** IDs canónicos de CTA — estables para telemetría y validación del endpoint. */
export const PREFLIGHT_CTA_IDS = [
  'soat_subir',
  'rtm_info',
  'comparendos_simit',
  'inscripcion_runt',
  'impuesto_hint',
  'laft_revisar',
] as const;
export type PreflightCtaId = typeof PREFLIGHT_CTA_IDS[number];

export function isValidCtaId(id: string): id is PreflightCtaId {
  return (PREFLIGHT_CTA_IDS as readonly string[]).includes(id);
}

/**
 * Acción canónica para un check `(key, status)`, o `null` si no requiere acción.
 * `ok` nunca tiene acción. El API la adjunta a cada check; la web la renderiza.
 */
export function getPreflightAction(key: string, status: PreflightCheckStatus): PreflightAction | null {
  if (status === 'ok') return null;
  const actionable = status === 'warn' || status === 'fail';

  switch (key) {
    case 'soat':
      // SOAT vencido/por vencer → subir la póliza en el paso de Documentos.
      return actionable ? { kind: 'step', label: 'Subir SOAT', ctaId: 'soat_subir', step: 2 } : null;

    case 'rtm':
      return status === 'fail' ? { kind: 'link', label: 'Información RTM', ctaId: 'rtm_info', href: PREFLIGHT_URLS.RUNT } : null;

    case 'comparendos_comprador':
    case 'comparendos_vendedor':
      return actionable ? { kind: 'link', label: 'Consultar SIMIT', ctaId: 'comparendos_simit', href: PREFLIGHT_URLS.SIMIT } : null;

    case 'inscripcion_runt':
      return actionable ? { kind: 'link', label: 'Verificar en RUNT', ctaId: 'inscripcion_runt', href: PREFLIGHT_URLS.RUNT } : null;

    case 'impuesto_vehicular':
      return status === 'unknown' || status === 'warn'
        ? { kind: 'hint', label: 'Cómo verificar', ctaId: 'impuesto_hint', hint: 'Solicita el paz y salvo vehicular en la gobernación o secretaría de tránsito de tu departamento.' }
        : null;

    case 'laft_comprador':
    case 'laft_vendedor':
      // LAFT accionable (HITL): coincidencia en listas → escalar a cumplimiento.
      return actionable
        ? { kind: 'hint', label: 'Revisar en LAFT', ctaId: 'laft_revisar', hint: 'Coincidencia en listas restrictivas. Escala al Oficial de Cumplimiento y documenta la debida diligencia antes de continuar el trámite.' }
        : null;

    default:
      return null;
  }
}
