// Finanzas — Gastos diarios: la geometría de la gráfica de evolución diaria (HU #12625). Lo PURO:
// apilar la serie por categoría, la escala del eje de valor, cada cuántos días va una etiqueta, el
// resumen de la figura, las filas de la tabla equivalente y el texto que se anuncia por día. Sin
// JSX ni React a propósito: `geometriaGrafica.test.ts` corre con `node --test` y aquí viven los tres
// mutantes del AC7 (invertir el orden de apilado, omitir el día en 0, no reescalar al ocultar).
//
// Las medidas están en unidades del `viewBox`; la gráfica pone el ancho medido del contenedor como
// ancho del `viewBox`, así que 1 unidad = 1 px y el texto no se escala.
//
// Los imports relativos llevan `.ts` (tsconfig `allowImportingTsExtensions`; Vite lo resuelve igual)
// porque el ESM de Node no adivina extensiones y este archivo se importa desde `node --test`.

import type { GastosDiariosDia } from '@operaciones/shared-types';
import { pesos } from '../tiposReporteCostos.ts';
import { CATEGORIAS, diaCorto, type CategoriaGasto, type GastosDiariosCategoria } from './tiposGastosDiarios.ts';

/** Alto del `<svg>` en px y márgenes del área de barras (eje Y a la izquierda, eje X abajo). */
export const ALTO_SVG = 280;
export const MARGEN = { izq: 76, der: 12, arriba: 12, abajo: 28 } as const;
/** Ancho mínimo de una etiqueta del eje de días («18 ago») más su aire: con menos, se solapan. */
const ANCHO_ETIQUETA = 44;

export interface Segmento {
  clave: GastosDiariosCategoria;
  categoria: CategoriaGasto;
  cantidad: number;
  valor: number;
  /** Acumulado por debajo del segmento (en pesos): el primero arranca en 0. */
  desde: number;
  /** Acumulado con este segmento incluido. */
  hasta: number;
}

export interface BarraDia {
  /** Posición en el eje de días: la misma aunque el día esté en 0 (AC1). */
  indice: number;
  dia: string;
  /** Suma de las categorías VISIBLES del día. */
  total: number;
  /** Uno por categoría visible, de abajo arriba en el orden de `CATEGORIAS` (AC1). */
  segmentos: Segmento[];
}

/**
 * Una barra por elemento de la serie, en su orden, con un segmento por categoría marcada, apilado
 * en el orden fijo de `CATEGORIAS` (SOAT abajo). Un día con todo en 0 sale con total 0 y sus
 * segmentos vacíos, en su `indice`: no se omite ni desplaza a los demás (primer y segundo mutante).
 */
export function apilar(serie: readonly GastosDiariosDia[], tipos: readonly GastosDiariosCategoria[]): BarraDia[] {
  const visibles = CATEGORIAS.filter((c) => tipos.includes(c.clave));
  return serie.map((d, indice) => {
    let acumulado = 0;
    const segmentos = visibles.map((categoria) => {
      const celda = d[categoria.clave];
      const valor = Number(celda.valor);
      const desde = acumulado;
      acumulado += valor;
      return { clave: categoria.clave, categoria, cantidad: celda.cantidad, valor, desde, hasta: acumulado };
    });
    return { indice, dia: d.dia, total: acumulado, segmentos };
  });
}

export interface EscalaValor {
  /** Techo del eje: la última marca, ≥ al mayor total visible. Nunca 0 (evita dividir por cero). */
  max: number;
  /** Marcas del eje en pesos, de 0 a `max`, en pasos «redondos» (1·10ⁿ, 2·10ⁿ, 5·10ⁿ). */
  ticks: number[];
}

/** El paso redondo más cercano por encima de `bruto`: 1, 2 o 5 por la potencia de diez que toque. */
function pasoRedondo(bruto: number): number {
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const fraccion = bruto / potencia;
  const base = fraccion <= 1 ? 1 : fraccion <= 2 ? 2 : fraccion <= 5 ? 5 : 10;
  return base * potencia;
}

/**
 * La escala del eje de valor sale SOLO de las barras que le pasan, que ya traen solo lo visible:
 * ocultar una categoría reescala (tercer mutante). Con todo en 0, un eje de 0 a 1 para no dividir por 0.
 */
export function escalaValor(barras: readonly BarraDia[]): EscalaValor {
  const mayor = barras.reduce((m, b) => Math.max(m, b.total), 0);
  if (mayor <= 0) return { max: 1, ticks: [0] };
  const paso = pasoRedondo(mayor / 4);
  const max = Math.ceil(mayor / paso) * paso;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += paso) ticks.push(v);
  return { max, ticks };
}

/**
 * Cada cuántos días se rotula el eje X para que dos etiquetas no se toquen en `anchoPlot` px:
 * 30 días a 1000 px → cada 2; 366 días a 1000 px → cada 17. Nunca menos de 1.
 */
export function pasoEtiquetas(nDias: number, anchoPlot: number): number {
  if (nDias <= 0 || anchoPlot <= 0) return 1;
  return Math.max(1, Math.ceil((nDias * ANCHO_ETIQUETA) / anchoPlot));
}

/** Ancho de la ranura de cada día y de su barra (con aire), en px. */
export function anchoBarra(nDias: number, anchoPlot: number): { ranura: number; barra: number } {
  const ranura = nDias > 0 ? anchoPlot / nDias : anchoPlot;
  return { ranura, barra: Math.max(1, ranura * (nDias > 120 ? 0.85 : 0.65)) };
}

/** El índice del día bajo la abscisa `x` (relativa al área de barras), o null fuera de ella. */
export function indicePorX(x: number, nDias: number, anchoPlot: number): number | null {
  if (nDias <= 0 || x < 0 || x >= anchoPlot) return null;
  return Math.min(nDias - 1, Math.floor((x / anchoPlot) * nDias));
}

/** «Gastos diarios del 18 ago al 16 sep 2026: 5 categorías, total $ 5.873.400» (AC4). */
export function resumenFigura(desde: string, hasta: string, nVisibles: number, total: string | number): string {
  const mismoAnio = desde.slice(0, 4) === hasta.slice(0, 4);
  const categorias = nVisibles === 1 ? '1 categoría' : `${nVisibles} categorías`;
  return `Gastos diarios del ${diaCorto(desde, !mismoAnio)} al ${diaCorto(hasta, true)}: ${categorias}, total ${pesos(Number(total))}`;
}

export interface FilaTabla {
  dia: string;
  diaTexto: string;
  /** Una celda por categoría visible, en el orden de la barra. */
  celdas: { clave: GastosDiariosCategoria; titulo: string; cantidad: number; valor: number }[];
  total: number;
}

/** La tabla equivalente (AC4): día × categorías visibles + total del día. Una fila por barra. */
export function filasTabla(barras: readonly BarraDia[]): FilaTabla[] {
  return barras.map((b) => ({
    dia: b.dia,
    diaTexto: diaCorto(b.dia, true),
    celdas: b.segmentos.map((s) => ({ clave: s.clave, titulo: s.categoria.titulo, cantidad: s.cantidad, valor: s.valor })),
    total: b.total,
  }));
}

/**
 * Lo que se anuncia al pasar por un día (AC3): «3 sep 2026: SOAT 2 pagados, $ 115.000; … Total del
 * día $ 340.000». Con el día en 0: «3 sep 2026: sin gastos».
 */
export function textoDetalleDia(barra: BarraDia): string {
  const dia = diaCorto(barra.dia, true);
  if (barra.total === 0) return `${dia}: sin gastos`;
  const partes = barra.segmentos.map((s) => `${s.categoria.titulo} ${s.categoria.conteo(s.cantidad)}, ${pesos(s.valor)}`);
  return `${dia}: ${partes.join('; ')}. Total del día ${pesos(barra.total)}`;
}
