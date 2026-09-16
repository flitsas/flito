/**
 * HU #12625 — La geometría de la gráfica de Gastos diarios.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/components/finanzas/gastos-diarios/geometriaGrafica.test.ts
 *   (o `npm run test -w apps/web`)
 *
 * Mutantes del AC7 que este archivo mata:
 *   1. Invertir el orden de apilado (`[...visibles].reverse()` en `apilar`) → falla «apila de abajo
 *      arriba en el orden SOAT, Impuestos, Derechos, Logística, Servicios».
 *   2. Omitir el día en 0 (`serie.filter(d => total > 0)` en `apilar`) → falla «el día en 0 conserva su
 *      posición y no se omite» (y «número de barras = días de la serie»).
 *   3. No reescalar al ocultar (calcular `escalaValor` con las cinco o fijar el max) → falla «ocultar
 *      una categoría reescala el eje a lo visible».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALTO_SVG, MARGEN, anchoBarra, apilar, escalaValor, filasTabla, indicePorX, pasoEtiquetas, resumenFigura,
  textoDetalleDia,
} from './geometriaGrafica.ts';
import { CATEGORIAS } from './tiposGastosDiarios.ts';

const celda = (cantidad: number, valor: string) => ({ cantidad, valor });
const CERO = celda(0, '0.00');
const dia = (d: string, v: Partial<Record<(typeof CATEGORIAS)[number]['clave'], ReturnType<typeof celda>>> = {}) => ({
  dia: d, soat: CERO, impuesto: CERO, derecho: CERO, logistica: CERO, serviciosAdicionales: CERO, ...v,
});
const LAS_CINCO = CATEGORIAS.map((c) => c.clave);
const SERIE = [
  dia('2026-09-01', { soat: celda(1, '100000.00'), impuesto: celda(2, '50000.00') }),
  dia('2026-09-02'),
  dia('2026-09-03', { soat: celda(2, '115000.00'), derecho: celda(1, '90000.00'), logistica: celda(3, '135000.00'), serviciosAdicionales: celda(1, '15000.00') }),
  dia('2026-09-04', { logistica: celda(1, '45000.00') }),
];
/** Sin espacio duro: `pesos` usa el NBSP de es-CO y los textos se comparan como los ve el usuario. */
const plano = (s: string) => s.replace(/\u00a0/g, ' ');

describe('apilar', () => {
  it('número de barras = días de la serie, en su orden', () => {
    const barras = apilar(SERIE, LAS_CINCO);
    assert.equal(barras.length, SERIE.length);
    assert.deepEqual(barras.map((b) => b.dia), SERIE.map((d) => d.dia));
    assert.deepEqual(barras.map((b) => b.indice), [0, 1, 2, 3]);
  });

  it('segmentos por barra = categorías visibles', () => {
    assert.ok(apilar(SERIE, LAS_CINCO).every((b) => b.segmentos.length === 5));
    const dos = apilar(SERIE, ['soat', 'logistica']);
    assert.ok(dos.every((b) => b.segmentos.length === 2));
    assert.deepEqual(dos[2].segmentos.map((s) => s.clave), ['soat', 'logistica']);
    assert.ok(apilar(SERIE, []).every((b) => b.segmentos.length === 0 && b.total === 0));
  });

  it('apila de abajo arriba en el orden SOAT, Impuestos, Derechos, Logística, Servicios (mutante 1)', () => {
    const b = apilar(SERIE, LAS_CINCO)[2];
    assert.deepEqual(b.segmentos.map((s) => s.clave), ['soat', 'impuesto', 'derecho', 'logistica', 'serviciosAdicionales']);
    // El primero arranca en 0 y cada uno empieza donde acaba el anterior: SOAT abajo, Servicios arriba.
    assert.equal(b.segmentos[0].desde, 0);
    assert.equal(b.segmentos[0].hasta, 115000);
    assert.equal(b.segmentos[1].desde, 115000); // Impuestos en 0 ocupa su sitio sin alto
    assert.equal(b.segmentos[1].hasta, 115000);
    assert.equal(b.segmentos[3].desde, 205000);
    assert.equal(b.segmentos[3].hasta, 340000);
    assert.equal(b.segmentos[4].hasta, 355000);
    assert.equal(b.total, 355000);
    // Aunque la lista de tipos venga en otro orden, el apilado no cambia: es un solo estado.
    const desordenado = apilar(SERIE, ['serviciosAdicionales', 'soat', 'logistica'])[2];
    assert.deepEqual(desordenado.segmentos.map((s) => s.clave), ['soat', 'logistica', 'serviciosAdicionales']);
  });

  it('el día en 0 conserva su posición y no se omite (mutante 2)', () => {
    const barras = apilar(SERIE, LAS_CINCO);
    assert.equal(barras[1].dia, '2026-09-02');
    assert.equal(barras[1].indice, 1);
    assert.equal(barras[1].total, 0);
    assert.equal(barras[1].segmentos.length, 5);
    assert.ok(barras[1].segmentos.every((s) => s.desde === 0 && s.hasta === 0));
    // El día siguiente sigue en el 2: el 0 no comprime el eje.
    assert.equal(barras[2].indice, 2);
    assert.equal(barras[2].dia, '2026-09-03');
  });

  it('el total de la barra suma solo lo visible', () => {
    const sinLogistica = apilar(SERIE, LAS_CINCO.filter((c) => c !== 'logistica'));
    assert.equal(sinLogistica[2].total, 220000);
    assert.equal(sinLogistica[3].total, 0);
  });
});

describe('escalaValor', () => {
  it('el techo cubre el mayor total y las marcas van de 0 al techo en pasos redondos', () => {
    const e = escalaValor(apilar(SERIE, LAS_CINCO)); // mayor = 355.000
    assert.equal(e.ticks[0], 0);
    assert.equal(e.ticks.at(-1), e.max);
    assert.ok(e.max >= 355000);
    assert.equal(e.max, 400000);
    assert.deepEqual(e.ticks, [0, 100000, 200000, 300000, 400000]);
  });

  it('ocultar una categoría reescala el eje a lo visible (mutante 3)', () => {
    const conTodo = escalaValor(apilar(SERIE, LAS_CINCO));
    const sinLogistica = escalaValor(apilar(SERIE, LAS_CINCO.filter((c) => c !== 'logistica')));
    assert.ok(sinLogistica.max < conTodo.max, `${sinLogistica.max} debe ser menor que ${conTodo.max}`);
    assert.ok(sinLogistica.max >= 220000);
    assert.equal(sinLogistica.max, 300000);
  });

  it('con todo en 0 el eje va de 0 a 1 (no divide por cero)', () => {
    assert.deepEqual(escalaValor(apilar(SERIE, [])), { max: 1, ticks: [0] });
    assert.deepEqual(escalaValor([]), { max: 1, ticks: [0] });
  });
});

describe('pasoEtiquetas y ancho de barra', () => {
  it('366 días caben en 1366 sin solapar: una etiqueta cada N con N·ranura ≥ 44 px', () => {
    // Ancho del área de barras a 1366 con el sidebar abierto y los márgenes del svg.
    const anchoPlot = 1366 - 256 - 48 - MARGEN.izq - MARGEN.der;
    const paso = pasoEtiquetas(366, anchoPlot);
    assert.ok(paso > 1);
    assert.ok((anchoPlot / 366) * paso >= 44);
    assert.ok(Math.ceil(366 / paso) <= 24, 'no más de dos docenas de etiquetas');
    assert.ok(anchoBarra(366, anchoPlot).barra >= 1);
  });

  it('30 días a 1000 px rotulan cada 2; con mucho ancho, cada día', () => {
    assert.equal(pasoEtiquetas(30, 1000), 2);
    assert.equal(pasoEtiquetas(30, 2000), 1);
    assert.equal(pasoEtiquetas(0, 1000), 1);
  });

  it('indicePorX devuelve el día bajo el puntero y null fuera del área', () => {
    assert.equal(indicePorX(0, 30, 900), 0);
    assert.equal(indicePorX(899, 30, 900), 29);
    assert.equal(indicePorX(31, 30, 900), 1);
    assert.equal(indicePorX(-1, 30, 900), null);
    assert.equal(indicePorX(900, 30, 900), null);
    assert.equal(indicePorX(10, 0, 900), null);
  });

  it('el svg tiene alto fijo y un margen izquierdo para los pesos con miles', () => {
    assert.equal(ALTO_SVG, 280);
    assert.ok(MARGEN.izq >= 70);
  });
});

describe('resumenFigura, filasTabla y textoDetalleDia', () => {
  it('resume rango, categorías visibles y total con GMF (AC4)', () => {
    assert.equal(plano(resumenFigura('2026-08-18', '2026-09-16', 5, '5873400.00')),
      'Gastos diarios del 18 ago al 16 sep 2026: 5 categorías, total $ 5.873.400');
    assert.equal(plano(resumenFigura('2025-12-20', '2026-01-05', 1, 0)),
      'Gastos diarios del 20 dic 2025 al 5 ene 2026: 1 categoría, total $ 0');
  });

  it('la tabla tiene una fila por día y una celda por categoría visible más el total', () => {
    const filas = filasTabla(apilar(SERIE, ['soat', 'logistica']));
    assert.equal(filas.length, 4);
    assert.deepEqual(filas[2].celdas.map((c) => c.titulo), ['SOAT', 'Logística']);
    assert.equal(filas[2].celdas[1].cantidad, 3);
    assert.equal(filas[2].celdas[1].valor, 135000);
    assert.equal(filas[2].total, 250000);
    assert.equal(filas[2].diaTexto, '3 sep 2026');
    assert.equal(filas[1].total, 0);
  });

  it('el detalle del día lista cada categoría visible con cantidad y valor, y la suma', () => {
    const barras = apilar(SERIE, LAS_CINCO);
    assert.equal(plano(textoDetalleDia(barras[2])),
      '3 sep 2026: SOAT 2 pagados, $ 115.000; Impuestos 0 pagados, $ 0; Derechos de trámite 1 pagado, $ 90.000; '
      + 'Logística 3 trámites con logística, $ 135.000; Servicios adicionales 1 asignado, $ 15.000. Total del día $ 355.000');
    assert.equal(textoDetalleDia(barras[1]), '2 sep 2026: sin gastos');
  });
});
