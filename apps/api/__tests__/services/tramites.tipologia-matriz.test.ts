// TRAM-TIPO-01 (Fase 3) — matriz paso × tipología + journeys (lógica pura).
//
// Solo shared-types (sin IO): valida partes por tipología, el flag de vendedor y
// la ausencia de drift entre el catálogo de checklist (A5) y la matriz.

import { describe, it, expect } from 'vitest';
import {
  TIPOLOGIA_JOURNEYS, TRAMITE_TIPOLOGIAS,
  getJourney, vendedorRequerido, getAdquirente, getPartesRequeridas, getPasoTipologia,
  matrizDriftIssues, getBannerExpediente, getTipologiaCompliance,
} from '@operaciones/shared-types';

describe('TRAM-TIPO-02 · importación + banners', () => {
  it('importacion en catálogo y matriz, sin drift', () => {
    expect(matrizDriftIssues()).toEqual([]);
    expect(TRAMITE_TIPOLOGIAS.map((t) => t.codigo)).toContain('importacion');
    expect(getJourney('importacion')?.adquirente.rol).toBe('importador');
    expect(getAdquirente('importacion').label).toMatch(/importador/i);
    expect(vendedorRequerido('importacion')).toBe(false);
    expect(getPartesRequeridas('importacion').some((p) => p.rol === 'vendedor')).toBe(false);
    expect(getPasoTipologia('importacion', 2)?.nota).toMatch(/declaración de importación/i);
  });

  it('getBannerExpediente: remate e importación tienen banner; traspaso no', () => {
    expect(getBannerExpediente('remate')).toMatch(/remate judicial/i);
    expect(getBannerExpediente('importacion')).toMatch(/importación/i);
    expect(getBannerExpediente('traspaso_standard')).toBeNull();
    expect(getBannerExpediente(null)).toBeNull();
  });

  it('getTipologiaCompliance es la FUENTE ÚNICA del banner (titulo/cuerpo/tono)', () => {
    const remate = getTipologiaCompliance('remate')!;
    expect(remate).toMatchObject({ titulo: 'Remate judicial', tono: 'warn' });
    expect(remate.cuerpo).toMatch(/no valida la legalidad del remate/i);
    const imp = getTipologiaCompliance('importacion')!;
    expect(imp.titulo).toMatch(/importación/i);
    expect(imp.tono).toBe('info');
    expect(imp.cuerpo).toMatch(/documentos aduaneros son responsabilidad/i);
    expect(getTipologiaCompliance('sucesion')).toMatchObject({ tono: 'info' });
    expect(getTipologiaCompliance('traspaso_standard')).toBeNull();
    // getBannerExpediente deriva de la misma fuente.
    expect(getBannerExpediente('remate')).toContain(remate.cuerpo);
  });
});

describe('TRAM-TIPO-01 · journeys por tipología', () => {
  it('hay un journey por cada tipología del catálogo (sin drift)', () => {
    expect(matrizDriftIssues()).toEqual([]);
    const journeyCodes = TIPOLOGIA_JOURNEYS.map((j) => j.codigo).sort();
    const catalogCodes = TRAMITE_TIPOLOGIAS.map((t) => t.codigo).sort();
    expect(journeyCodes).toEqual(catalogCodes);
  });

  it('cada journey tiene 5 pasos y al menos una parte', () => {
    for (const j of TIPOLOGIA_JOURNEYS) {
      expect(j.pasos).toHaveLength(5);
      expect(j.partes.length).toBeGreaterThan(0);
      expect(j.partes.some((p) => p.rol === j.adquirente.rol)).toBe(true);
    }
  });
});

describe('TRAM-TIPO-01 · vendedorRequerido', () => {
  it('solo traspaso_standard exige vendedor', () => {
    expect(vendedorRequerido('traspaso_standard')).toBe(true);
    expect(vendedorRequerido('sucesion')).toBe(false);
    expect(vendedorRequerido('remate')).toBe(false);
    expect(vendedorRequerido('flota_corporativa')).toBe(false);
  });

  it('sin tipología o desconocida → false (retrocompatible)', () => {
    expect(vendedorRequerido(null)).toBe(false);
    expect(vendedorRequerido(undefined)).toBe(false);
    expect(vendedorRequerido('inexistente')).toBe(false);
  });

  it('traspaso_standard lista vendedor obligatorio en partes', () => {
    const partes = getPartesRequeridas('traspaso_standard');
    expect(partes.some((p) => p.rol === 'vendedor' && p.obligatorio)).toBe(true);
  });

  it('sucesión no lista parte vendedora', () => {
    expect(getPartesRequeridas('sucesion').some((p) => p.rol === 'vendedor')).toBe(false);
  });
});

describe('TRAM-TIPO-01 · adquirente y pasos', () => {
  it('getAdquirente cae al genérico Comprador sin tipología', () => {
    expect(getAdquirente(null)).toMatchObject({ rol: 'comprador', label: 'Comprador' });
    expect(getAdquirente('inexistente').rol).toBe('comprador');
  });

  it('cada tipología relabela el adquirente del paso 3', () => {
    expect(getAdquirente('traspaso_standard').rol).toBe('comprador');
    expect(getAdquirente('sucesion').label).toMatch(/heredero/i);
    expect(getAdquirente('remate').rol).toBe('adjudicatario');
    expect(getAdquirente('flota_corporativa').rol).toBe('representante_legal');
  });

  it('getJourney / getPasoTipologia', () => {
    expect(getJourney('remate')?.nombre).toMatch(/remate/i);
    expect(getJourney('nope')).toBeUndefined();
    expect(getPasoTipologia('traspaso_standard', 3)?.titulo).toMatch(/vendedor/i);
    expect(getPasoTipologia('sucesion', 3)?.nota).toMatch(/sin parte vendedora/i);
    expect(getPasoTipologia('remate', 99)).toBeUndefined();
  });
});
