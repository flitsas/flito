// HU #14135 (Feature #14014, AC3/AC4/AC8/AC9) — lectura y validación del XLSX de la carga masiva INICIAL (solo VIN).
//
// Mismas decisiones que la Renovación (`flito-soat-masivo-parse.ts`): solo XLSX, primera hoja, fila 1 =
// encabezados (sin distinguir mayúsculas/tildes), celdas como TEXTO, 1–200 filas. La única columna es «VIN»
// (se ignora una «Motivo» final, del archivo de rechazadas). Diferencias:
//   · una fila VACÍA entre filas con datos nace `rechazada` (`vin_invalido`) sin consultar el RUNT (AC8); las
//     vacías del final se ignoran (el Excel suele arrastrar filas con formato);
//   · un VIN repetido: la 1.ª se procesa y las demás nacen `rechazada` (`fila_duplicada`, «VIN repetido», AC4);
//   · un archivo con columnas de la plantilla de Renovación se rechaza completo (`plantilla_equivocada`, AC9).
// Ningún mensaje de error lleva el valor de una celda. La validación es de FORMATO: el RUNT es del worker.

import { z } from 'zod';
import { falloMasivo } from './flito-soat-masivo.errors.js';
import { normalizarId } from './flito-soat-cliente.service.js';
import {
  abrirHoja, celdaATexto, ENCABEZADO_MOTIVO, MAX_FILAS, normalizarEncabezado, plantillaEquivocada,
} from './flito-soat-masivo-parse.js';
import { ENCABEZADOS_INICIAL, ENCABEZADOS_RENOVACION } from './flito-soat-masivo-plantilla.js';

export type MotivoRechazoVin = 'vin_invalido' | 'fila_duplicada';

export interface FilaVinParseada { nFila: number; vin: string; motivoRechazo: MotivoRechazoVin | null }

const MAX_COLUMNAS_LEIDAS = 50;
/** Tope de filas físicas recorridas (las vacías con formato no deben costar): 200 de datos + holgura. */
const MAX_FILAS_FISICAS = 2_000;

/** Mismas reglas que el VIN del alta individual (`vehiculoSchema` de flito-soat-cliente.routes: 11–17, sin I/O/Q). */
const vinSchema = z.string().min(11).max(17).regex(/^[A-HJ-NPR-Z0-9]+$/);
export const esVinValido = (vinNormalizado: string): boolean => vinSchema.safeParse(vinNormalizado).success;

const ENCABEZADOS_RENOV_NORM = new Set(ENCABEZADOS_RENOVACION.map((h) => normalizarEncabezado(h)));

export async function parsearXlsxInicial(buf: Buffer): Promise<{ filas: FilaVinParseada[] }> {
  const ws = await abrirHoja(buf);
  if (ws.columnCount > MAX_COLUMNAS_LEIDAS) {
    throw falloMasivo(400, 'encabezados_invalidos', 'El archivo tiene columnas que no son de la plantilla.', { esperados: [...ENCABEZADOS_INICIAL] });
  }
  let colVin = 0;
  let repetido = false;
  let desconocidos = 0;
  let deRenovacion = false;
  const fila1 = ws.getRow(1);
  for (let c = 1; c <= ws.columnCount; c++) {
    const texto = celdaATexto(fila1.getCell(c).value);
    if (texto === '') continue;
    const norm = normalizarEncabezado(texto);
    if (norm === ENCABEZADO_MOTIVO) continue; // columna final del archivo de rechazadas
    if (norm === 'vin') { if (colVin) repetido = true; colVin = c; continue; }
    if (ENCABEZADOS_RENOV_NORM.has(norm)) deRenovacion = true;
    desconocidos++;
  }
  // AC9: columnas de Renovación (sin la de VIN) = la plantilla equivocada, con mensaje que lo explica.
  if (deRenovacion && !colVin) throw plantillaEquivocada('inicial');
  if (!colVin || desconocidos > 0 || repetido) {
    throw falloMasivo(400, 'encabezados_invalidos', 'Los encabezados no coinciden con la plantilla. Use exactamente: VIN.',
      { esperados: [...ENCABEZADOS_INICIAL], faltantes: colVin ? [] : [...ENCABEZADOS_INICIAL], columnasDesconocidas: desconocidos, repetidos: repetido });
  }

  const crudos: Array<{ nFila: number; vin: string }> = [];
  const tope = Math.min(ws.rowCount, MAX_FILAS_FISICAS);
  for (let n = 2; n <= tope; n++) crudos.push({ nFila: n, vin: celdaATexto(ws.getRow(n).getCell(colVin).value) });
  while (crudos.length > 0 && crudos[crudos.length - 1]!.vin === '') crudos.pop(); // vacías del final: se ignoran
  if (crudos.length === 0) throw falloMasivo(400, 'archivo_vacio', 'El archivo no tiene filas de datos.');
  if (crudos.length > MAX_FILAS) throw falloMasivo(422, 'demasiadas_filas', `El archivo supera el máximo de ${MAX_FILAS} filas.`);

  const vistos = new Set<string>();
  const filas = crudos.map(({ nFila, vin: crudo }): FilaVinParseada => {
    const norm = normalizarId(crudo);
    const ok = esVinValido(norm);
    let motivoRechazo: MotivoRechazoVin | null = ok ? null : 'vin_invalido';
    if (ok) { if (vistos.has(norm)) motivoRechazo = 'fila_duplicada'; else vistos.add(norm); }
    // Lo rechazado se guarda recortado a la longitud de la columna.
    return { nFila, vin: (ok ? norm : crudo).slice(0, 17), motivoRechazo };
  });
  return { filas };
}
