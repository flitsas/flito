// Torre de Control Gerencial (Épica #14590, ADR-0043) — exportación a Excel del Explorador.
//
// RN-TOR-X1: solo AGREGADOS (una fila por grupo + el total). Sin placas, VIN ni datos del titular: el «máximo» de los
//   tiempos (que sí trae la placa en pantalla) NO va al archivo.
// RN-TOR-X2: el nombre del archivo lleva la métrica y el periodo, nunca una placa, un NIT ni el nombre de una compañía.
// RN-TOR-X3: reutiliza el motor (mismos filtros, alcance, topes y permiso de dinero) con el tope de `GRUPOS_MAX` grupos.
import type { Response } from 'express';
import { metricaTorre, type ConsultaMetrica } from '@operaciones/shared-types';
import { sendExcel, type ExcelColumn } from '../../shared/utils/excel.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { GRUPOS_MAX, consultarMetrica, rangoDeConsulta, type OpcionesConsulta } from './flito-torre.metricas.service.js';

/** RN-TOR-X2. */
export function nombreArchivoTorre(c: ConsultaMetrica, hoy?: string): string {
  const r = rangoDeConsulta(c, hoy);
  const periodo = r ? `${r.desde}_${r.hasta}` : 'actual';
  return `torre-${c.metrica.replace(/_/g, '-')}-${periodo}.xlsx`;
}

/** Columnas y filas del libro (puro, para los tests). */
export async function libroMetrica(
  c: ConsultaMetrica, alcance: AlcanceResuelto, op: OpcionesConsulta,
): Promise<{ columnas: ExcelColumn[]; filas: Record<string, unknown>[] }> {
  const r = await consultarMetrica({ ...c, limite: undefined }, alcance, { ...op, limiteMax: GRUPOS_MAX });
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
    etiqueta: f.etiqueta, valor: f.valor, n: f.n, participacion: f.participacion,
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
