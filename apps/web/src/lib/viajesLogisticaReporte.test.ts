/**
 * HU #12628 — Funciones puras de los viajes de logística en el reporte de costos.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/viajesLogisticaReporte.test.ts
 *
 * Mutantes que este archivo mata:
 *   1. `textoCeldaViajes(null)` devuelve «0» o `vacio` (un `?? 0`) → falla «null es Sin dato, nunca 0».
 *   2. `rotuloBotonViajes(1)` pinta «Viajes · 1» → falla «con 1, 0 y null el rótulo es Viajes».
 *   3. `nombreAccesibleBotonViajes` no empieza por el texto visible → falla «empieza por Viajes».
 *   4. `lineaOrigen` pinta «Estimado…» en `sin_desglose` → falla «sin_desglose dice Sellado el».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  etiquetaModoViaje, lineaOrigen, nombreAccesibleBotonViajes, rotuloBotonViajes, rutaViajesDeTramiteReporte,
  textoCeldaViajes, textoTarifaDelMomento, textoTotalViajesPanel, textoViajeIncluido, tituloPanelViajes,
  TITULO_SIN_DATO_VIAJES,
} from './viajesLogisticaReporte.ts';

/** `Intl` mete un espacio duro tras el signo; los asertos lo normalizan como hará quien lo lea. */
const plano = (s: string) => s.replace(/\s/g, ' ');

describe('textoCeldaViajes (AC2)', () => {
  it('n ≥ 1 es el número con su nombre accesible; el 1 va en singular', () => {
    assert.deepEqual(textoCeldaViajes(3), { clase: 'viajes', texto: '3', accesible: '3 viajes de logística' });
    assert.deepEqual(textoCeldaViajes(1), { clase: 'viajes', texto: '1', accesible: '1 viaje de logística' });
  });
  it('0 es el guion con title «Autogestiona»', () => {
    assert.deepEqual(textoCeldaViajes(0), { clase: 'vacio', title: 'Autogestiona' });
  });
  it('null es Sin dato, nunca 0', () => {
    const celda = textoCeldaViajes(null);
    assert.equal(celda.clase, 'sin_dato');
    assert.equal(celda.clase === 'sin_dato' && celda.texto, 'Sin dato');
    assert.equal(celda.clase === 'sin_dato' && celda.title, TITULO_SIN_DATO_VIAJES);
    assert.equal(TITULO_SIN_DATO_VIAJES, 'Se liquidó antes de que FLITO cobrara viajes adicionales.');
    assert.notEqual(JSON.stringify(celda).includes('"0"'), true);
  });
});

describe('rotuloBotonViajes (AC3)', () => {
  it('con n ≥ 2 cuenta', () => {
    assert.equal(rotuloBotonViajes(2), 'Viajes · 2');
    assert.equal(rotuloBotonViajes(7), 'Viajes · 7');
  });
  it('con 1, 0 y null el rótulo es Viajes', () => {
    assert.equal(rotuloBotonViajes(1), 'Viajes');
    assert.equal(rotuloBotonViajes(0), 'Viajes');
    assert.equal(rotuloBotonViajes(null), 'Viajes');
  });
});

describe('nombreAccesibleBotonViajes (AC3, WCAG 2.5.3)', () => {
  it('empieza por Viajes y dice cuántos', () => {
    assert.equal(nombreAccesibleBotonViajes('FLIT-10234', 3), 'Viajes de logística de FLIT-10234: 3 viajes');
    assert.equal(nombreAccesibleBotonViajes('FLIT-10234', 1), 'Viajes de logística de FLIT-10234: 1 viaje');
    assert.equal(nombreAccesibleBotonViajes('FLIT-10234', 0), 'Viajes de logística de FLIT-10234: autogestiona');
    assert.equal(nombreAccesibleBotonViajes('FLIT-10234', null), 'Viajes de logística de FLIT-10234: sin dato');
    assert.ok(nombreAccesibleBotonViajes('FLIT-1', 2).startsWith('Viajes'));
  });
});

describe('tituloPanelViajes y ruta (AC4)', () => {
  it('sin placa no cuelga el separador', () => {
    assert.equal(tituloPanelViajes('FLIT-10234', 'ABC123'), 'Viajes de logística · FLIT-10234 · ABC123');
    assert.equal(tituloPanelViajes('FLIT-10234', null), 'Viajes de logística · FLIT-10234');
    assert.equal(tituloPanelViajes('FLIT-10234', ''), 'Viajes de logística · FLIT-10234');
  });
  it('la ruta es la del reporte, no la de la consola logística', () => {
    assert.equal(rutaViajesDeTramiteReporte('abc'), '/finanzas/tramites/abc/viajes-logistica');
  });
});

describe('lineaOrigen (AC4, AC5)', () => {
  it('vigente es la estimación', () => {
    assert.equal(lineaOrigen({ origen: 'vigente', liquidadoEn: null }), 'Estimado con los viajes registrados');
  });
  it('sellado y sin_desglose dicen Sellado el con la fecha y hora', () => {
    const sellado = lineaOrigen({ origen: 'sellado', liquidadoEn: '2026-09-12T14:14:00.000Z' });
    assert.ok(sellado.startsWith('Sellado el '), sellado);
    assert.ok(/2026/.test(sellado), sellado);
    assert.ok(/\d{1,2}:\d{2}/.test(sellado), sellado);
    const sinDesglose = lineaOrigen({ origen: 'sin_desglose', liquidadoEn: '2026-09-12T14:14:00.000Z' });
    assert.equal(sinDesglose, sellado);
  });
});

describe('modo, tarifa del momento y viaje incluido (AC4)', () => {
  it('el modo es una palabra y la desviación va aparte', () => {
    assert.equal(etiquetaModoViaje('inicial'), 'Tarifa');
    assert.equal(etiquetaModoViaje('manual'), 'Precio manual');
    assert.equal(plano(textoTarifaDelMomento(45000)), 'Tarifa del momento $ 45.000');
    assert.equal(textoTarifaDelMomento(null), 'Sin tarifa');
  });
  it('la cabecera del viaje 1 dice la tarifa o que no la hay', () => {
    assert.equal(plano(textoViajeIncluido(35000)), 'Viaje 1 · incluido en la tarifa · $ 35.000');
    assert.equal(textoViajeIncluido(null), 'Viaje 1 · incluido en la tarifa · Sin tarifa configurada');
  });
});

describe('textoTotalViajesPanel', () => {
  it('singular y plural del pie', () => {
    assert.equal(textoTotalViajesPanel(1), '1 viaje');
    assert.equal(textoTotalViajesPanel(3), '3 viajes');
  });
});
