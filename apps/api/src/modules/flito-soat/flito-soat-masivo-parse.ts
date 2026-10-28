// HU #14131 (Feature #14013) — lectura y validación del XLSX de la carga masiva (renovación).
//
// Decisiones cerradas: solo XLSX, primera hoja, fila 1 = encabezados (sin distinguir mayúsculas/tildes,
// en cualquier orden; uno faltante o desconocido rechaza TODO el archivo), celdas leídas como TEXTO
// (la placa y el documento no pierden ceros ni pasan a notación científica), filas totalmente vacías
// ignoradas, 1–200 filas. Las filas con formato inválido y las repetidas NO tumban el archivo: nacen
// `rechazada` con su motivo (diseño §3/§4.1). Esta validación es de FORMATO; la consulta al RUNT es del
// worker (HU #14132). Ningún mensaje de error lleva el valor de una celda.

import ExcelJS from 'exceljs';
import { falloMasivo } from './flito-soat-masivo.errors.js';
import { esXlsxReal } from './flito-soat-masivo-contenedor.js';
import { ENCABEZADOS_RENOVACION } from './flito-soat-masivo-plantilla.js';
import { z } from 'zod';
// Reglas de la renovación individual (HU #14017): MISMOS esquemas, no una copia (un test los compara).
import { numeroDocumentoSchema, placaSchema } from './flito-soat-cliente.routes.js';

export const MAX_FILAS = 200;
export const MAX_BYTES = 1024 * 1024;
const MAX_COLUMNAS_LEIDAS = 50;

export type MotivoRechazoEntrada =
  | 'placa_invalida' | 'documento_invalido' | 'nombre_invalido' | 'correo_invalido' | 'celular_invalido' | 'fila_duplicada';

export interface FilaParseada {
  nFila: number;
  placa: string;
  documento: string;
  nombre: string;
  correo: string;
  celular: string;
  motivoRechazo: MotivoRechazoEntrada | null;
}

const LARGO = { placa: 10, documento: 30, nombre: 150, correo: 150, celular: 20 } as const;

/** Minúsculas y sin tildes: «DOCUMENTO», «documentó» y «Documento» son el mismo encabezado. */
export const normalizarEncabezado = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const CLAVES: Record<string, keyof typeof LARGO> = {
  placa: 'placa', documento: 'documento', nombre: 'nombre', correo: 'correo', celular: 'celular',
};

/** Correo del propietario: el mismo criterio que el alta individual (`z.string().trim().email().max(150)`). */
const correoSchema = z.string().trim().email().max(150);

/** Textos del motivo de rechazo (ADO #14132): nombran el campo, nunca devuelven el valor tecleado. */
export const MENSAJE_MOTIVO: Record<string, string> = {
  placa_invalida: 'Placa inválida',
  documento_invalido: 'Documento inválido',
  nombre_invalido: 'Nombre inválido',
  correo_invalido: 'Correo inválido',
  celular_invalido: 'Celular inválido',
  fila_duplicada: 'Placa repetida en el archivo',
};

type Valor = ExcelJS.CellValue;

/** Cualquier celda → texto. Un número entero se escribe sin notación científica; una fórmula vale su resultado. */
export function celdaATexto(v: Valor): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 }) : '';
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return celdaATexto(v.result as Valor);
    if ('text' in v) return celdaATexto(v.text as Valor);
    if ('error' in v) return '';
  }
  return '';
}

/** Valida y normaliza una fila cruda con las reglas del canal. Devuelve el motivo del primer campo inválido. */
export function validarFila(c: { placa: string; documento: string; nombre: string; correo: string; celular: string }):
  { placa: string; documento: string; motivo: MotivoRechazoEntrada | null } {
  const placa = placaSchema.safeParse(c.placa);
  const documento = numeroDocumentoSchema.safeParse(c.documento);
  const base = { placa: placa.success ? (placa.data as string) : c.placa, documento: documento.success ? documento.data : c.documento };
  const celular = c.celular.replace(/\s/g, '');
  let motivo: MotivoRechazoEntrada | null = null;
  if (!placa.success) motivo = 'placa_invalida';
  else if (!documento.success) motivo = 'documento_invalido';
  else if (c.nombre.length < 2 || c.nombre.length > LARGO.nombre) motivo = 'nombre_invalido';
  else if (!correoSchema.safeParse(c.correo).success) motivo = 'correo_invalido';
  else if (!/^3\d{9}$/.test(celular)) motivo = 'celular_invalido'; // 10 dígitos y empieza por 3 (AC8 de #14132)
  return { ...base, motivo };
}

export interface ArchivoParseado { filas: FilaParseada[]; }

/** Valida el contenedor y lee la hoja. Lanza `ErrorLoteMasivo` (sin datos de celdas) ante cualquier rechazo completo. */
export async function parsearXlsxRenovacion(buf: Buffer): Promise<ArchivoParseado> {
  if (buf.length === 0) throw falloMasivo(400, 'archivo_vacio', 'El archivo está vacío.');
  if (buf.length > MAX_BYTES) throw falloMasivo(413, 'archivo_muy_grande', 'El archivo supera 1 MB.');
  if (!esXlsxReal(buf)) throw falloMasivo(400, 'formato_invalido', 'El archivo no es un Excel .xlsx válido.');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw falloMasivo(400, 'formato_invalido', 'El archivo no es un Excel .xlsx válido.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw falloMasivo(400, 'archivo_vacio', 'El archivo no tiene datos.');

  // Encabezados (fila 1).
  const columnaDe = new Map<keyof typeof LARGO, number>();
  const desconocidos: number[] = [];
  const maxCol = Math.min(ws.columnCount, MAX_COLUMNAS_LEIDAS);
  if (ws.columnCount > MAX_COLUMNAS_LEIDAS) {
    throw falloMasivo(400, 'encabezados_invalidos', 'El archivo tiene columnas que no son de la plantilla.', { esperados: [...ENCABEZADOS_RENOVACION] });
  }
  let repetido = false;
  const fila1 = ws.getRow(1);
  for (let c = 1; c <= maxCol; c++) {
    const texto = celdaATexto(fila1.getCell(c).value);
    if (texto === '') continue;
    const clave = CLAVES[normalizarEncabezado(texto)];
    if (!clave) { desconocidos.push(c); continue; }
    if (columnaDe.has(clave)) repetido = true;
    columnaDe.set(clave, c);
  }
  const faltan = ENCABEZADOS_RENOVACION.filter((h) => !columnaDe.has(CLAVES[normalizarEncabezado(h)]!));
  if (faltan.length > 0 || desconocidos.length > 0 || repetido) {
    // Solo NOMBRES de columna de la plantilla (nunca lo tecleado en la hoja): ni el desconocido se devuelve.
    throw falloMasivo(400, 'encabezados_invalidos',
      'Los encabezados no coinciden con la plantilla. Use exactamente: Placa, Documento, Nombre, Correo, Celular.',
      { esperados: [...ENCABEZADOS_RENOVACION], faltantes: faltan, columnasDesconocidas: desconocidos.length, repetidos: repetido });
  }

  // Datos (fila 2 en adelante). Se corta al pasar de 200 sin leer el resto.
  const filas: FilaParseada[] = [];
  let excede = false;
  ws.eachRow({ includeEmpty: false }, (row, nFila) => {
    if (nFila === 1 || excede) return;
    const leer = (k: keyof typeof LARGO) => celdaATexto(row.getCell(columnaDe.get(k)!).value);
    const crudos = { placa: leer('placa'), documento: leer('documento'), nombre: leer('nombre'), correo: leer('correo'), celular: leer('celular') };
    if (Object.values(crudos).every((v) => v === '')) return; // fila vacía (también las del final)
    if (filas.length >= MAX_FILAS) { excede = true; return; }
    const nombre = crudos.nombre.replace(/\s+/g, ' ');
    const r = validarFila({ ...crudos, nombre });
    filas.push({
      nFila, placa: r.placa, documento: r.documento, nombre, correo: crudos.correo.toLowerCase(),
      celular: crudos.celular.replace(/\s/g, ''), motivoRechazo: r.motivo,
    });
  });
  if (excede) throw falloMasivo(422, 'demasiadas_filas', `El archivo supera el máximo de ${MAX_FILAS} filas.`);
  if (filas.length === 0) throw falloMasivo(400, 'archivo_vacio', 'El archivo no tiene filas de datos.');

  // Duplicadas en el archivo: la 2.ª ocurrencia de una placa válida nace rechazada.
  const vistas = new Set<string>();
  for (const f of filas) {
    if (f.motivoRechazo) continue;
    if (vistas.has(f.placa)) f.motivoRechazo = 'fila_duplicada'; else vistas.add(f.placa);
  }
  // Lo rechazado se guarda recortado a la longitud de la columna (diseño §4.1).
  for (const f of filas) for (const k of Object.keys(LARGO) as Array<keyof typeof LARGO>) f[k] = f[k].slice(0, LARGO[k]);
  return { filas };
}
