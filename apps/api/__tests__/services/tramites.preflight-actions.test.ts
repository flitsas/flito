// TRAM-INNOV-PRE-02 — CTAs canónicos del pre-vuelo (shared-types, puro).

import { describe, it, expect } from 'vitest';
import {
  getPreflightAction, isValidCtaId, PREFLIGHT_CTA_IDS, PREFLIGHT_URLS,
} from '@operaciones/shared-types';

describe('PRE-02 · getPreflightAction', () => {
  it('status ok → sin acción (cualquier key)', () => {
    for (const key of ['soat', 'rtm', 'comparendos_comprador', 'impuesto_vehicular', 'laft_comprador']) {
      expect(getPreflightAction(key, 'ok')).toBeNull();
    }
  });

  it('SOAT fail/warn → step "Subir SOAT" (paso 2)', () => {
    const a = getPreflightAction('soat', 'fail');
    expect(a).toMatchObject({ kind: 'step', ctaId: 'soat_subir', step: 2 });
    expect(getPreflightAction('soat', 'warn')).toMatchObject({ kind: 'step', ctaId: 'soat_subir' });
    expect(getPreflightAction('soat', 'unknown')).toBeNull();
  });

  it('RTM solo en fail → link RUNT', () => {
    expect(getPreflightAction('rtm', 'fail')).toMatchObject({ kind: 'link', ctaId: 'rtm_info', href: PREFLIGHT_URLS.RUNT });
    expect(getPreflightAction('rtm', 'warn')).toBeNull();
  });

  it('comparendos comprador/vendedor warn/fail → link SIMIT', () => {
    for (const k of ['comparendos_comprador', 'comparendos_vendedor']) {
      expect(getPreflightAction(k, 'warn')).toMatchObject({ kind: 'link', ctaId: 'comparendos_simit', href: PREFLIGHT_URLS.SIMIT });
    }
  });

  it('inscripcion_runt warn → link RUNT', () => {
    expect(getPreflightAction('inscripcion_runt', 'warn')).toMatchObject({ kind: 'link', ctaId: 'inscripcion_runt' });
  });

  it('impuesto_vehicular unknown/warn → hint', () => {
    expect(getPreflightAction('impuesto_vehicular', 'unknown')).toMatchObject({ kind: 'hint', ctaId: 'impuesto_hint' });
    expect(getPreflightAction('impuesto_vehicular', 'warn')).toMatchObject({ kind: 'hint', ctaId: 'impuesto_hint' });
  });

  it('LAFT comprador/vendedor warn/fail → hint "Revisar en LAFT"', () => {
    expect(getPreflightAction('laft_comprador', 'warn')).toMatchObject({ kind: 'hint', ctaId: 'laft_revisar' });
    expect(getPreflightAction('laft_vendedor', 'fail')).toMatchObject({ kind: 'hint', ctaId: 'laft_revisar' });
    expect(getPreflightAction('laft_comprador', 'unknown')).toBeNull();
  });

  it('key desconocida → null', () => {
    expect(getPreflightAction('inexistente', 'fail')).toBeNull();
  });

  it('todos los ctaId emitidos están en el catálogo canónico', () => {
    const emitted = [
      getPreflightAction('soat', 'fail'), getPreflightAction('rtm', 'fail'),
      getPreflightAction('comparendos_comprador', 'warn'), getPreflightAction('inscripcion_runt', 'warn'),
      getPreflightAction('impuesto_vehicular', 'unknown'), getPreflightAction('laft_comprador', 'fail'),
    ].filter(Boolean);
    for (const a of emitted) expect(isValidCtaId(a!.ctaId)).toBe(true);
  });
});

describe('PRE-02 · isValidCtaId', () => {
  it('acepta el catálogo y rechaza lo demás', () => {
    for (const id of PREFLIGHT_CTA_IDS) expect(isValidCtaId(id)).toBe(true);
    expect(isValidCtaId('hackeado')).toBe(false);
    expect(isValidCtaId('')).toBe(false);
  });
});
