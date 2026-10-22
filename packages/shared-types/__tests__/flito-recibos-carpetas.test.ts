import { describe, it, expect } from 'vitest';
import { carpetaRaiz, faseDeCarpeta } from '../src/flito-recibos-carpetas';
import { FaseRecibo } from '../src/flito-estados';
import * as barrel from '../src/index';

// HU #12615 — la regla de carpetas se COMPARTE entre el API (archiva y reporta `carpetasSinFase`)
// y el navegador (avisa antes de enviar y ordena liquidaciones delante). Estos casos son la tabla
// del organismo: si una regex cambia aquí, cambian los dos a la vez; si alguien la vuelve a copiar
// en un lado, este test deja de ser la única fuente y el aviso puede mentir.

// La tabla es la MISMA que probaba `apps/api/__tests__/services/flito-recibos.fase.test.ts`
// (HU #12614, AC6): el API ahora re-exporta de aquí y la paridad web/API es por construcción.
describe('faseDeCarpeta — la carpeta del ZIP declara la fase (HU #12614 AC6 / HU #12615)', () => {
  it.each([
    ['liquidaciones_pagadas/ABC123.pdf', FaseRecibo.PAGO],           // pago antes que liquidación
    ['originales_pagadas/ABC123.pdf', FaseRecibo.PAGO],
    ['pagos/ABC123.pdf', FaseRecibo.PAGO],
    ['pago/ABC123.pdf', FaseRecibo.PAGO],
    ['pagos_2026/ABC123.pdf', FaseRecibo.PAGO],
    ['Pagados/2026/ABC123.pdf', FaseRecibo.PAGO],
    ['pagadas/ABC123.pdf', FaseRecibo.PAGO],
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
    // La negación explícita va antes que «marca de agua»: no es pago.
    ['SIN MARCA DE AGUA/ABC123.pdf', FaseRecibo.LIQUIDACION],
    ['sin_marca_de_agua/ABC123.pdf', FaseRecibo.LIQUIDACION],
    // Sin palabra de fase → null. Y el NOMBRE del archivo no declara nada.
    ['2026/ABC123.pdf', null],
    ['otros/pagado.pdf', null],
    ['otros/mayo/ABC123.pdf', null],
    ['pagado.pdf', null],
    ['propagó/ABC123.pdf', null],
    ['', null],
  ] as const)('%s → %s', (ruta, esperado) => {
    expect(faseDeCarpeta(ruta)).toBe(esperado);
  });

  it('en la raíz del ZIP o suelto no declara nada, ni aunque el ARCHIVO se llame «pagado»', () => {
    expect(faseDeCarpeta('ABC123.pdf')).toBeNull();
    expect(faseDeCarpeta('pagado.pdf')).toBeNull();
    expect(faseDeCarpeta('')).toBeNull();
  });

  it('la negación gana al token de pago y el token de pago gana al de liquidación', () => {
    expect(faseDeCarpeta('SIN MARCA DE AGUA/x.pdf')).toBe(FaseRecibo.LIQUIDACION);
    expect(faseDeCarpeta('liquidaciones_pagadas/x.pdf')).toBe(FaseRecibo.PAGO);
  });
});

describe('carpetaRaiz — el primer segmento de carpeta', () => {
  it.each([
    ['liquidaciones/2026/ABC.pdf', 'liquidaciones'],
    ['liquidaciones_pagadas/x/ABC.pdf', 'liquidaciones_pagadas'],
    ['2026/ABC.pdf', '2026'],
    ['otros/ABC.pdf', 'otros'],
    ['/otros/ABC.pdf', 'otros'],
    ['ABC.pdf', null],
    ['', null],
  ] as const)('%s → %s', (ruta, esperado) => {
    expect(carpetaRaiz(ruta)).toBe(esperado);
  });
});

describe('el barrel de shared-types reexporta la regla', () => {
  it('faseDeCarpeta y carpetaRaiz salen del índice', () => {
    expect(barrel.faseDeCarpeta).toBe(faseDeCarpeta);
    expect(barrel.carpetaRaiz).toBe(carpetaRaiz);
  });
});
