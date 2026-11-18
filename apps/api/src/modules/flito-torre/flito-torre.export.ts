// Torre de Control Gerencial (Épica #14590, ADR-0043) — exportación a Excel del Explorador.
//
// RN-TOR-X1: solo AGREGADOS (una fila por grupo + el total). Sin placas, VIN ni datos del titular: el «máximo» de los
//   tiempos (que sí trae la placa en pantalla) NO va al archivo.
// RN-TOR-X2: el nombre del archivo lleva la métrica y el periodo, nunca una placa, un NIT ni el nombre de una compañía.
// RN-TOR-X3: reutiliza el motor (mismos filtros, alcance, topes y permiso de dinero) con el tope de `GRUPOS_MAX` grupos.
// RN-TOR-X4 (ADR-0044): el cruce sale como UNA hoja de tabla cruzada: cabecera «<principal> / <secundaria>», las
//   columnas, «Los demás (N)» si las hay y el cierre; una fila por grupo y la fila de cierre al final. El cierre se llama
//   «Total» cuando la medida suma (conteo y dinero) y «General» en tiempo y tasa (no son aditivos: el marginal sale del
//   SQL, RN-TOR-C4). En tiempos la celda es la MEDIANA en horas y la cabecera lo dice. Topes 2.000 × 100 (RN-TOR-C3).
// RN-TOR-X5: nombre `torre-<metrica>-<fechaBase>-<periodo>.xlsx` (sin fecha base en las de foto), con `-cruce` si hay
//   dos agrupaciones. Sin compañías, placas ni NIT.
// RN-TOR-X6: ninguna celda de texto empieza por `=`, `+`, `-` ni `@` (inyección de fórmulas): se antepone un apóstrofo.
import type { Response } from 'express';
import {
  ETIQUETAS_AGRUPACION_TORRE, fechaBasePorDefecto, metricaTorre, type ConsultaMetrica, type ResultadoMetrica,
} from '@operaciones/shared-types';
import { sendExcel, type ExcelColumn } from '../../shared/utils/excel.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { GRUPOS_MAX, consultarMetrica, rangoDeConsulta, type OpcionesConsulta } from './flito-torre.metricas.service.js';

/** RN-TOR-X2. */
export function nombreArchivoTorre(c: ConsultaMetrica, hoy?: string): string {
  const r = rangoDeConsulta(c, hoy);
  const periodo = r ? `${r.desde}_${r.hasta}` : 'actual';
  const fecha = c.fechaBase ?? fechaBasePorDefecto(c.metrica);
  const cruce = c.agrupacion && c.agrupacionColumnas ? '-cruce' : '';
  return `torre-${c.metrica.replace(/_/g, '-')}${fecha ? `-${fecha}` : ''}-${periodo}${cruce}.xlsx`;
}

/** RN-TOR-X6: texto seguro para una celda (nunca arranca como fórmula). */
export const textoSeguro = (v: string): string => (/^[=+\-@]/.test(v) ? `'${v}` : v);

/** RN-TOR-X4: la hoja cruzada (pura sobre el resultado del motor). */
export function libroCruce(
  c: ConsultaMetrica, r: ResultadoMetrica,
): { columnas: ExcelColumn[]; filas: Record<string, unknown>[] } {
  const cruce = r.cruce!;
  const tiempo = r.unidad === 'horas';
  const cierre = r.unidad === 'horas' || r.unidad === 'pct' ? 'General' : 'Total';
  const principal = ETIQUETAS_AGRUPACION_TORRE[c.agrupacion!];
  const secundaria = ETIQUETAS_AGRUPACION_TORRE[cruce.agrupacion];
  const columnas: ExcelColumn[] = [
    { header: textoSeguro(`${principal} / ${secundaria}${tiempo ? ' · mediana en horas' : ''}`), key: 'etiqueta', width: 32 },
    ...cruce.columnas.map((col, j) => ({ header: textoSeguro(col.etiqueta), key: `c${j}`, width: 16 })),
    { header: tiempo ? `${cierre} (mediana en horas)` : cierre, key: 'cierre', width: 18 },
  ];
  const valorCelda = (v: { valor: number; mediana?: number } | null): number | null =>
    v == null ? null : tiempo ? v.mediana ?? null : v.valor;
  const filas: Record<string, unknown>[] = r.filas.map((f, i) => {
    const fila: Record<string, unknown> = { etiqueta: textoSeguro(f.etiqueta), cierre: valorCelda(f) };
    cruce.columnas.forEach((_, j) => { fila[`c${j}`] = valorCelda(cruce.celdas[i]?.[j] ?? null); });
    return fila;
  });
  const ultima: Record<string, unknown> = { etiqueta: cierre, cierre: tiempo ? r.total.mediana ?? null : r.total.valor };
  cruce.columnas.forEach((col, j) => { ultima[`c${j}`] = valorCelda(col); });
  filas.push(ultima);
  return { columnas, filas };
}

/** Columnas y filas del libro (puro, para los tests). */
export async function libroMetrica(
  c: ConsultaMetrica, alcance: AlcanceResuelto, op: OpcionesConsulta,
): Promise<{ columnas: ExcelColumn[]; filas: Record<string, unknown>[] }> {
  const r = await consultarMetrica({ ...c, limite: undefined }, alcance, { ...op, limiteMax: GRUPOS_MAX, modo: 'exportar' });
  if (r.cruce) return libroCruce(c, r);
  const tiempo = r.unidad === 'horas';
  const columnas: ExcelColumn[] = [
    { header: c.agrupacion ? 'Grupo' : 'Concepto', key: 'etiqueta', width: 32 },
    { header: metricaTorre(c.metrica).etiqueta, key: 'valor', width: 20 },
    { header: 'Registros', key: 'n', width: 12 },
    { header: 'Participación %', key: 'participacion', width: 16 },
    ...(tiempo ? [
      { header: 'Mediana (horas)', key: 'mediana', width: 16 },
      { header: 'Percentil 90 (horas)', key: 'p90', width: 18 },
      { header: 'Máximo (horas)', key: 'max', width: 16 },
    ] : []),
  ];
  const filas: Record<string, unknown>[] = r.filas.map((f) => ({
    etiqueta: textoSeguro(f.etiqueta), valor: f.valor, n: f.n, participacion: f.participacion,
    ...(tiempo ? { mediana: f.mediana ?? null, p90: f.p90 ?? null, max: f.max ?? null } : {}),
  }));
  filas.push({
    etiqueta: 'Total', valor: r.total.valor, n: r.total.n, participacion: 100,
    ...(tiempo ? { mediana: r.total.mediana ?? null, p90: r.total.p90 ?? null, max: r.total.max ?? null } : {}),
  });
  return { columnas, filas };
}

export async function exportarMetrica(
  res: Response, c: ConsultaMetrica, alcance: AlcanceResuelto, op: OpcionesConsulta,
): Promise<void> {
  const { columnas, filas } = await libroMetrica(c, alcance, op);
  await sendExcel(res, nombreArchivoTorre(c, op.hoy), columnas, filas, { nombreHoja: 'Torre', fijarCabecera: true });
}
