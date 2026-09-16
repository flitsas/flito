// HU #12614 (Feature #12589) — reglas PURAS de la fase de un recibo: el sello PAGADO vigila la fase
// declarada (AC2/AC3/AC4), la placa repetida en el lote se resuelve por el sello (AC5) y la carpeta
// del ZIP declara la fase con los tokens de pago por delante de los de liquidación (AC6). Sin mocks:
// aquí caen los mutantes M2/M3/M4 del AC7 en una tabla, sin coreografía de `selectMock`.
//
//   · M2 — ante la duda (sello null o bajo el umbral) se rechaza o se manda a revisión → `vigilarFase(_, null)` ≠ null
//   · M3 — la placa repetida no resuelve por el sello (sigue la fase declarada)          → `resolverPlacaRepetida` (i)
//   · M4 — la regla de carpetas evalúa liquidación antes que pago                         → `liquidaciones_pagadas` → liquidación

import { describe, it, expect } from 'vitest';
import { CampoImpuesto, FaseRecibo } from '@operaciones/shared-types';
import {
  carpetaRaiz, DETALLE_LIQUIDACION_CON_SELLO, DETALLE_PAGO_SIN_SELLO, faseDeCarpeta, leerSello, liquidacionPrimero,
  resolverPlacaRepetida, vigilarFase, type EntradaPlaca,
} from '../../src/modules/flito-impuestos/flito-recibos.fase.js';

const campo = (valor: string | null, confianza: number, confiable = confianza >= 0.85) => ({ valor, confianza, confiable });

describe('leerSello — solo cuenta el sello confiable', () => {
  it.each([
    ['clave ausente', {}, null],
    ['valor null', { [CampoImpuesto.SELLO_PAGADO]: campo(null, 0) }, null],
    ["'true' bajo el umbral", { [CampoImpuesto.SELLO_PAGADO]: campo('true', 0.6) }, null],
    ["'false' bajo el umbral", { [CampoImpuesto.SELLO_PAGADO]: campo('false', 0.6) }, null],
    ["'true' confiable", { [CampoImpuesto.SELLO_PAGADO]: campo('true', 0.95) }, true],
    ["'false' confiable", { [CampoImpuesto.SELLO_PAGADO]: campo('false', 0.95) }, false],
    // Lo que manda es `confiable` (ya re-marcado con el umbral del organismo), no un umbral fijo.
    ["'false' con confianza 0.9 marcado NO confiable", { [CampoImpuesto.SELLO_PAGADO]: campo('false', 0.9, false) }, null],
  ])('%s → %s', (_n, extraccion, esperado) => {
    expect(leerSello(extraccion)).toBe(esperado);
  });
});

describe('vigilarFase — tabla declarado × sello (AC2/AC3/AC4)', () => {
  it.each([
    [FaseRecibo.PAGO, null, null],
    [FaseRecibo.LIQUIDACION, null, null],
    [FaseRecibo.PAGO, true, null],
    [FaseRecibo.LIQUIDACION, false, null],
  ])('%s + sello %s → sigue (null)', (fase, sello, esperado) => {
    expect(vigilarFase(fase, sello)).toBe(esperado);
  });

  it('pago sin sello → rechazo «súbelo con la fase Liquidación» (AC2)', () => {
    expect(vigilarFase(FaseRecibo.PAGO, false)).toEqual({ detalle: DETALLE_PAGO_SIN_SELLO });
    expect(DETALLE_PAGO_SIN_SELLO).toMatch(/Liquidación/);
  });

  it('liquidación con sello → rechazo «súbelo con la fase Pago» (AC3)', () => {
    expect(vigilarFase(FaseRecibo.LIQUIDACION, true)).toEqual({ detalle: DETALLE_LIQUIDACION_CON_SELLO });
    expect(DETALLE_LIQUIDACION_CON_SELLO).toMatch(/Pago/);
  });

  it('ante la duda NUNCA rechaza, en ninguna fase (M2)', () => {
    for (const fase of [FaseRecibo.PAGO, FaseRecibo.LIQUIDACION]) expect(vigilarFase(fase, null)).toBeNull();
  });
});

describe('resolverPlacaRepetida — AC5', () => {
  const e = (archivo: string, sello: boolean | null, fase: FaseRecibo = FaseRecibo.PAGO, llave: string | null = 'ABC123'): EntradaPlaca => ({ archivo, llave, fase, sello });

  it.each([FaseRecibo.PAGO, FaseRecibo.LIQUIDACION])('(i) false + true, declarada %s → liquidación y pago, sea cual sea la declarada (M3)', (fase) => {
    expect(resolverPlacaRepetida([e('a.pdf', false, fase), e('b.pdf', true, fase)])).toEqual([
      { accion: 'procesar', fase: FaseRecibo.LIQUIDACION },
      { accion: 'procesar', fase: FaseRecibo.PAGO },
    ]);
    // Y en el orden inverso, cada uno conserva su fase por el sello, no por la posición.
    expect(resolverPlacaRepetida([e('b.pdf', true, fase), e('a.pdf', false, fase)])).toEqual([
      { accion: 'procesar', fase: FaseRecibo.PAGO },
      { accion: 'procesar', fase: FaseRecibo.LIQUIDACION },
    ]);
  });

  it('(ii) un sello ilegible en el par → los dos a faseNoCoincide «no se distingue»', () => {
    const r = resolverPlacaRepetida([e('a.pdf', false), e('b.pdf', null)]);
    expect(r).toHaveLength(2);
    for (const d of r) {
      expect(d.accion).toBe('faseNoCoincide');
      expect((d as { detalle: string }).detalle).toBe('Dos documentos de ABC123 y no se distingue cuál es el pago.');
    }
  });

  it.each([true, false])('(iii) los dos con el mismo sello (%s) → el primero con la fase del sello, el segundo duplicado', (sello) => {
    const r = resolverPlacaRepetida([e('a.pdf', sello, FaseRecibo.LIQUIDACION), e('b.pdf', sello, FaseRecibo.LIQUIDACION)]);
    expect(r[0]).toEqual({ accion: 'procesar', fase: sello ? FaseRecibo.PAGO : FaseRecibo.LIQUIDACION });
    expect(r[1]!.accion).toBe('duplicado');
    expect((r[1] as { detalle: string }).detalle).toContain('a.pdf');
    expect((r[1] as { detalle: string }).detalle).toContain('ABC123');
  });

  it('(iv) placas distintas → todos procesar con su fase declarada, sin tocar', () => {
    expect(resolverPlacaRepetida([e('a.pdf', false, FaseRecibo.PAGO, 'ABC123'), e('b.pdf', null, FaseRecibo.PAGO, 'XYZ789')])).toEqual([
      { accion: 'procesar', fase: FaseRecibo.PAGO },
      { accion: 'procesar', fase: FaseRecibo.PAGO },
    ]);
  });

  it('(v) misma placa con fases declaradas DISTINTAS → no se agrupan (cada uno sigue AC2–AC4)', () => {
    expect(resolverPlacaRepetida([e('a.pdf', null, FaseRecibo.LIQUIDACION), e('b.pdf', true, FaseRecibo.PAGO)])).toEqual([
      { accion: 'procesar', fase: FaseRecibo.LIQUIDACION },
      { accion: 'procesar', fase: FaseRecibo.PAGO },
    ]);
  });

  it('(vi) sin llave no se agrupa; solo o vacío → procesar', () => {
    expect(resolverPlacaRepetida([e('a.pdf', null, FaseRecibo.PAGO, null), e('b.pdf', null, FaseRecibo.PAGO, null)]))
      .toEqual([{ accion: 'procesar', fase: FaseRecibo.PAGO }, { accion: 'procesar', fase: FaseRecibo.PAGO }]);
    expect(resolverPlacaRepetida([e('a.pdf', false)])).toEqual([{ accion: 'procesar', fase: FaseRecibo.PAGO }]);
    expect(resolverPlacaRepetida([])).toEqual([]);
  });

  it('(vii) tres de la misma placa: liquidación, pago y el tercero duplicado; con uno ilegible, «Varios» y todos rechazados', () => {
    const r = resolverPlacaRepetida([e('a.pdf', true), e('b.pdf', false), e('c.pdf', true)]);
    expect(r.map((d) => d.accion)).toEqual(['procesar', 'procesar', 'duplicado']);
    expect((r[0] as { fase: string }).fase).toBe(FaseRecibo.PAGO);
    expect((r[1] as { fase: string }).fase).toBe(FaseRecibo.LIQUIDACION);
    const dudoso = resolverPlacaRepetida([e('a.pdf', true), e('b.pdf', false), e('c.pdf', null)]);
    expect(dudoso.every((d) => d.accion === 'faseNoCoincide')).toBe(true);
    expect((dudoso[0] as { detalle: string }).detalle).toMatch(/^Varios documentos de ABC123/);
  });
});

describe('faseDeCarpeta — la carpeta declara la fase (AC6)', () => {
  it.each([
    ['liquidaciones_pagadas/ABC123.pdf', FaseRecibo.PAGO],           // M4: pago antes que liquidación
    ['originales_pagadas/ABC123.pdf', FaseRecibo.PAGO],
    ['pagos/ABC123.pdf', FaseRecibo.PAGO],
    ['pago/ABC123.pdf', FaseRecibo.PAGO],
    ['pagos_2026/ABC123.pdf', FaseRecibo.PAGO],
    ['Pagados/2026/ABC123.pdf', FaseRecibo.PAGO],
    ['CON MARCA/ABC123.pdf', FaseRecibo.PAGO],
    ['CON MARCA DE AGUA/ABC123.pdf', FaseRecibo.PAGO],
    ['marca de agua/ABC123.pdf', FaseRecibo.PAGO],
    ['con_agua/ABC123.pdf', FaseRecibo.PAGO],
    ['liquidaciones_originales/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['liquidaciones/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['originales/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['SIN MARCA/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['sin_agua/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['limpias/ABC123.pdf', FaseRecibo.LIQUIDACION],
    // La negación explícita va antes que «marca de agua» (TC-24): no es pago.
    ['SIN MARCA DE AGUA/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['sin_marca_de_agua/ABC123.pdf', FaseRecibo.LIQUIDACION],
    // Sin palabra de fase → null. Y el NOMBRE del archivo no declara nada.
    ['2026/ABC123.pdf', null],
    ['otros/pagado.pdf', null],
    ['pagado.pdf', null],
    ['propagó/ABC123.pdf', null],
    ['', null],
  ])('%s → %s', (ruta, esperado) => {
    expect(faseDeCarpeta(ruta)).toBe(esperado);
  });
});

describe('carpetaRaiz — el primer segmento de carpeta', () => {
  it.each([
    ['liquidaciones_pagadas/x/ABC.pdf', 'liquidaciones_pagadas'],
    ['otros/ABC.pdf', 'otros'],
    ['/otros/ABC.pdf', 'otros'],
    ['ABC.pdf', null],
    ['', null],
  ])('%s → %s', (ruta, esperado) => {
    expect(carpetaRaiz(ruta)).toBe(esperado);
  });
});

describe('liquidacionPrimero — estable', () => {
  it('pone las liquidaciones delante y conserva el orden relativo del resto', () => {
    const items = [
      { n: 1, fase: FaseRecibo.PAGO }, { n: 2, fase: FaseRecibo.LIQUIDACION }, { n: 3, fase: FaseRecibo.PAGO }, { n: 4, fase: FaseRecibo.LIQUIDACION },
    ];
    expect(liquidacionPrimero(items, (i) => i.fase).map((i) => i.n)).toEqual([2, 4, 1, 3]);
    // Anidado: el accesor es lo que evita ordenar por una clave que no existe (`fase` en la raíz).
    const anidados = [{ archivo: { fase: FaseRecibo.PAGO } }, { archivo: { fase: FaseRecibo.LIQUIDACION } }];
    expect(liquidacionPrimero(anidados, (i) => i.archivo.fase)[0]!.archivo.fase).toBe(FaseRecibo.LIQUIDACION);
  });
});
