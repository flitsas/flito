// HU #14131 (Feature #14013, AC1) — plantilla XLSX de la carga masiva. Sin datos ni PII: solo la fila de
// encabezados (estática). Si alguna vez se generan celdas con datos del usuario (rechazadas, HU #14133),
// pasarlas por `escaparFormula`.

import ExcelJS from 'exceljs';

export const ENCABEZADOS_RENOVACION = ['Placa', 'Documento', 'Nombre', 'Correo', 'Celular'] as const;
export type TipoPlantillaMasivo = 'renovacion' | 'inicial';

export const NOMBRE_ARCHIVO_PLANTILLA: Record<'renovacion', string> = { renovacion: 'plantilla-soat-renovacion.xlsx' };

/** Neutraliza la inyección de fórmulas (CSV/XLSX injection): un valor que empiece por = + - @ (o tab/CR) se prefija con `'`. */
export function escaparFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

export async function generarPlantillaRenovacion(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Renovación');
  ws.addRow([...ENCABEZADOS_RENOVACION]);
  ws.getRow(1).font = { bold: true };
  // Texto en todas las columnas: la placa y el documento no deben perder ceros ni pasar a notación científica.
  ENCABEZADOS_RENOVACION.forEach((_, i) => {
    const col = ws.getColumn(i + 1);
    col.numFmt = '@';
    col.width = 22;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
