/**
 * HU #12624 — Lo puro de Gastos diarios.
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/components/finanzas/gastos-diarios/tiposGastosDiarios.test.ts
 *   (o `npm run test -w apps/web`)
 *
 * Mutantes del AC9 que este archivo mata:
 *   1. Quitar «estimado» del rótulo del GMF → falla «el rótulo del GMF dice estimado».
 *   2. Sumar solo las categorías visibles en el total → falla «el total suma las cinco aunque haya ocultas».
 *   3. Consultar la API al cambiar tipo de gasto (meter `tipos` en la clave) → falla «tipos no cambia la clave de consulta».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIAS, ROTULOS_TOTAL, ariaTarjeta, claveDeConsulta, diasEntre, escribirFiltros, hayFiltros,
  leerFiltros, rangoPorDefecto, sinGastos, textoRango, totalDelPeriodo, validarRango,
} from './tiposGastosDiarios.ts';

const celda = (cantidad: number, valor: string) => ({ cantidad, valor });
const TOTALES = {
  soat: celda(12, '3450000.00'), impuesto: celda(4, '1200000.00'), derecho: celda(9, '810000.00'),
  logistica: celda(7, '315000.00'), serviciosAdicionales: celda(5, '75000.00'),
  base: '5850000.00', gmfEstimado: '23400.00', total: '5873400.00',
};

describe('categorías y rótulos (AC3, AC4)', () => {
  it('las cinco en el orden fijo', () => {
    assert.deepEqual(CATEGORIAS.map((c) => c.titulo), ['SOAT', 'Impuestos', 'Derechos de trámite', 'Logística', 'Servicios adicionales']);
    assert.deepEqual(CATEGORIAS.map((c) => c.rotulo), ['SOAT pagados', 'Impuestos pagados', 'Derechos pagados', 'Trámites con logística', 'Servicios asignados']);
  });
  it('el rótulo del GMF dice estimado', () => {
    assert.equal(ROTULOS_TOTAL.gmf, 'GMF (4×1000) estimado');
    assert.match(ROTULOS_TOTAL.gmf, /\bestimado\b/);
    assert.equal(ROTULOS_TOTAL.notaGmf, 'Calculado sobre la suma del periodo; la liquidación lo calcula por trámite.');
  });
  it('aria de la región: singular en 1, «pesos» sin símbolo', () => {
    assert.equal(ariaTarjeta(CATEGORIAS[0], 12, '3450000.00'), 'SOAT: 12 pagados, 3.450.000 pesos');
    assert.equal(ariaTarjeta(CATEGORIAS[0], 1, '287500.00'), 'SOAT: 1 pagado, 287.500 pesos');
    assert.equal(ariaTarjeta(CATEGORIAS[3], 8, '640000.00'), 'Logística: 8 trámites con logística, 640.000 pesos');
    assert.equal(ariaTarjeta(CATEGORIAS[4], 5, '250000.00'), 'Servicios adicionales: 5 asignados, 250.000 pesos');
    assert.equal(ariaTarjeta(CATEGORIAS[1], 0, '0.00'), 'Impuestos: 0 pagados, 0 pesos');
  });
});

describe('total del periodo (AC4, RN-08)', () => {
  it('el total suma las cinco aunque haya ocultas', () => {
    const t = totalDelPeriodo(TOTALES, ['soat', 'impuesto']);
    assert.equal(t.suma, '5850000.00');
    assert.equal(t.gmf, '23400.00');
    assert.equal(t.total, '5873400.00');
    assert.equal(t.hayOcultas, true);
    // Con solo SOAT e Impuestos visibles, la suma de lo visible sería 4.650.000: NO es lo que se pinta.
    assert.notEqual(Number(t.suma), 3450000 + 1200000);
  });
  it('con las cinco marcadas no avisa; con ninguna, avisa y sigue sumando', () => {
    assert.equal(totalDelPeriodo(TOTALES, CATEGORIAS.map((c) => c.clave)).hayOcultas, false);
    const nada = totalDelPeriodo(TOTALES, []);
    assert.equal(nada.hayOcultas, true);
    assert.equal(nada.total, '5873400.00');
  });
  it('vacío = las cinco cantidades en 0, aunque el valor venga como string', () => {
    assert.equal(sinGastos(TOTALES), false);
    const cero = celda(0, '0.00');
    assert.equal(sinGastos({ ...TOTALES, soat: cero, impuesto: cero, derecho: cero, logistica: cero, serviciosAdicionales: cero }), true);
    assert.equal(sinGastos({ ...TOTALES, soat: cero, impuesto: cero, derecho: cero, logistica: cero, serviciosAdicionales: celda(1, '5.00') }), false);
  });
});

describe('filtros ↔ URL y clave de consulta (AC5)', () => {
  it('tipos no cambia la clave de consulta', () => {
    const base = { desde: '2026-08-18', hasta: '2026-09-16', empresas: '900123456' };
    assert.equal(claveDeConsulta({ ...base, tipos: ['soat'] } as never), claveDeConsulta({ ...base, tipos: [] } as never));
    assert.notEqual(claveDeConsulta(base), claveDeConsulta({ ...base, empresas: '' }));
    assert.notEqual(claveDeConsulta(base), claveDeConsulta({ ...base, hasta: '2026-09-15' }));
    assert.equal(claveDeConsulta(base).includes('soat'), false);
  });
  it('sin query: las cinco marcadas, rango vacío, sin filtros', () => {
    const f = leerFiltros(new URLSearchParams(''));
    assert.deepEqual(f, { desde: '', hasta: '', empresas: '', tipos: ['soat', 'impuesto', 'derecho', 'logistica', 'serviciosAdicionales'] });
    assert.equal(hayFiltros(f), false);
    assert.equal(escribirFiltros(f).toString(), '');
  });
  it('tipos presente y vacío = ninguna; desconocidos se descartan; las cinco se omiten al escribir', () => {
    assert.deepEqual(leerFiltros(new URLSearchParams('tipos=')).tipos, []);
    assert.deepEqual(leerFiltros(new URLSearchParams('tipos=impuesto,soat,otro')).tipos, ['soat', 'impuesto']);
    const p = escribirFiltros({ desde: '2026-08-18', hasta: '2026-09-16', empresas: '900123456,800111222', tipos: ['soat'] });
    assert.equal(p.toString(), 'desde=2026-08-18&hasta=2026-09-16&empresas=900123456%2C800111222&tipos=soat');
    assert.equal(escribirFiltros({ ...leerFiltros(p), tipos: ['soat', 'impuesto', 'derecho', 'logistica', 'serviciosAdicionales'] }).has('tipos'), false);
  });
  it('una fecha malformada en la URL no vale como filtro', () => {
    assert.equal(leerFiltros(new URLSearchParams('desde=ayer&hasta=2026-09-16')).desde, '');
  });
});

describe('rango: validación local y texto (AC3, AC5)', () => {
  it('hasta < desde y más de 366 días no consultan; 366 justos sí', () => {
    assert.equal(validarRango('2026-09-16', '2026-09-01'), 'La fecha final es anterior a la inicial.');
    assert.equal(validarRango('2025-01-01', '2026-09-16'), 'El periodo no puede superar 366 días. Acorta el rango.');
    assert.equal(validarRango('2025-09-16', '2026-09-16'), null); // 366 días, ambos incluidos
    assert.equal(validarRango('2025-09-15', '2026-09-16'), 'El periodo no puede superar 366 días. Acorta el rango.');
    assert.equal(validarRango('', ''), null);
    assert.equal(validarRango('2026-09-16', ''), null);
  });
  it('días entre, ambos incluidos, sin mover el día de zona', () => {
    assert.equal(diasEntre('2026-09-16', '2026-09-16'), 1);
    assert.equal(diasEntre('2026-08-18', '2026-09-16'), 30);
  });
  it('últimos 30 días con hoy incluido', () => {
    assert.deepEqual(rangoPorDefecto('2026-09-16'), { desde: '2026-08-18', hasta: '2026-09-16' });
    assert.deepEqual(rangoPorDefecto('2026-01-05'), { desde: '2025-12-07', hasta: '2026-01-05' });
  });
  it('«entre el 18 ago y el 16 sep 2026»: el año una vez si coincide', () => {
    assert.equal(textoRango('2026-08-18', '2026-09-16'), 'entre el 18 ago y el 16 sep 2026');
    assert.equal(textoRango('2025-12-07', '2026-01-05'), 'entre el 7 dic 2025 y el 5 ene 2026');
  });
});
