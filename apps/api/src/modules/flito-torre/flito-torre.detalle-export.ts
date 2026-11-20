// Torre de Control Gerencial (Épica #14590, ADR-0047) — Excel del DETALLE (`POST /api/flito/torre/detalle/exportar`).
//
// RN-TOR-DX1: dos hojas: «Registros» (las columnas del detalle) y «Definición» (etiqueta, definición, filtros
//   aplicados, segmentos, total y `generadoEn`). Se arma con ExcelJS como el Excel de los tableros, porque
//   `sendExcel` escribe una sola hoja.
// RN-TOR-DX2: toda celda de texto pasa por `textoSeguro` (nunca arranca como fórmula).
// RN-TOR-DX3: nombre `torre-detalle-<conjunto|metrica>-<YYYYMMDD>.xlsx`: sin placa, NIT ni compañía.
// RN-TOR-DX4: sin `FUNCION_TORRE_DINERO` las columnas de dinero NO van al archivo.
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { ETIQUETAS_FECHA_BASE_TORRE, type FiltroTorre, type ResultadoDetalle, type ValorCelda } from '@operaciones/shared-types';
import { MIME_XLSX } from '../../shared/utils/excel.js';
import type { DatosExportacionDetalle } from './flito-torre.detalle.service.js';
import { textoSeguro } from './flito-torre.export.js';

type ResultadoExportable = Omit<ResultadoDetalle, 'pagina' | 'tamano'>;

/** RN-TOR-DX3. */
export function nombreArchivoDetalle(origen: string, generadoEn: string): string {
  return `torre-detalle-${origen.replace(/_/g, '-')}-${generadoEn.slice(0, 10).replace(/-/g, '')}.xlsx`;
}

/** Valor de una celda para el Excel (RN-TOR-DX2). */
export function celdaExcel(v: ValorCelda | undefined): string | number | null {
  if (v == null) return null;
  if (Array.isArray(v)) return textoSeguro(v.join(', '));
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return v;
  return textoSeguro(v);
}

const describirFiltro = (f: FiltroTorre): string => {
  const partes: string[] = [];
  if (f.companiaIds?.length) partes.push(`${f.companiaIds.length} compañía(s)`);
  if (f.organismos?.length) partes.push(`${f.organismos.length} secretaría(s)`);
  if (f.departamentos?.length) partes.push(`${f.departamentos.length} departamento(s)`);
  if (f.tiposTramite?.length) partes.push(`tipos: ${f.tiposTramite.join(', ')}`);
  if (f.flitEstados?.length) partes.push(`estados: ${f.flitEstados.join(', ')}`);
  return partes.length ? partes.join(' · ') : 'Sin filtros adicionales';
};

/** Hojas del libro (puro; para los tests). */
export function libroDetalle(r: ResultadoExportable, filtro: FiltroTorre): {
  registros: { columnas: { header: string; key: string; dinero: boolean }[]; filas: Record<string, string | number | null>[] };
  definicion: { concepto: string; valor: string | number | null }[];
} {
  const columnas = r.columnas.filter((c) => r.dineroVisible || !c.dinero)
    .map((c) => ({ header: textoSeguro(c.etiqueta), key: c.id, dinero: c.dinero }));
  const filas = r.filas.map((f) => Object.fromEntries(columnas.map((c) => [c.key, celdaExcel(f.celdas[c.key as keyof typeof f.celdas])])));
  const definicion = [
    { concepto: 'Cifra', valor: textoSeguro(r.definicion.etiqueta) },
    { concepto: 'Cómo se calcula', valor: textoSeguro(r.definicion.definicion) },
    { concepto: 'Fecha que la ancla', valor: r.definicion.fechaBase ? ETIQUETAS_FECHA_BASE_TORRE[r.definicion.fechaBase] : 'Foto de hoy (no depende del periodo)' },
    { concepto: 'Periodo', valor: r.rango ? `${r.rango.desde} a ${r.rango.hasta}` : 'No aplica' },
    { concepto: 'Filtros aplicados', valor: textoSeguro(describirFiltro(filtro)) },
    { concepto: 'Filtros que no aplican', valor: r.filtrosIgnorados.length ? r.filtrosIgnorados.join(', ') : 'Ninguno' },
    { concepto: 'Segmentos', valor: r.segmentos.length ? textoSeguro(r.segmentos.map((s) => `${s.dimension}: ${s.valores.map((v) => v ?? 'sin valor').join(', ')}`).join(' · ')) : 'Ninguno' },
    { concepto: 'Total de registros', valor: r.total },
    ...(r.valorTotal != null ? [{ concepto: 'Valor total', valor: r.valorTotal }] : []),
    { concepto: 'Generado', valor: r.generadoEn },
  ];
  return { registros: { columnas, filas }, definicion };
}

export async function exportarDetalle(res: Response, datos: DatosExportacionDetalle, filtro: FiltroTorre): Promise<void> {
  const { registros, definicion } = libroDetalle(datos.resultado, filtro);
  const libro = new ExcelJS.Workbook();
  const cabecera = (hoja: ExcelJS.Worksheet) => {
    hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const hoja = libro.addWorksheet('Registros');
  hoja.columns = registros.columnas.map((c) => ({ header: c.header, key: c.key, width: 20 }));
  for (const c of registros.columnas) if (c.dinero) hoja.getColumn(c.key).numFmt = '#,##0';
  cabecera(hoja);
  registros.filas.forEach((f) => hoja.addRow(f));
  const def = libro.addWorksheet('Definición');
  def.columns = [{ header: 'Concepto', key: 'concepto', width: 28 }, { header: 'Valor', key: 'valor', width: 90 }];
  cabecera(def);
  definicion.forEach((f) => def.addRow(f));
  res.setHeader('Content-Type', MIME_XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoDetalle(datos.nombreOrigen, datos.resultado.generadoEn)}"`);
  res.setHeader('Cache-Control', 'no-store');
  await libro.xlsx.write(res);
  res.end();
}
