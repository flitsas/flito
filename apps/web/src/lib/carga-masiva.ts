// FLITO — topes de la carga masiva SOAT / Impuestos (HU #12050).
//
// Un solo sitio para peso, copy de validación y 413/504. Los dos modales importan de aquí;
// no se extrae un modal compartido (Impuestos tiene el checkbox) ni se parte el POST en tandas.
//
// Los números viven en `@operaciones/shared-types`. El copy es UX
// (`docs/ux/flito-soat-impuestos-carga-topes.md`) y no se publica en el paquete: `File` es DOM.

import {
  CARGA_MASIVA_MAX_ARCHIVOS,
  CARGA_MASIVA_MAX_BYTES_ARCHIVO,
  CARGA_MASIVA_MAX_BYTES_CRUDOS,
  CARGA_MASIVA_MAX_BYTES_CUERPO,
} from '@operaciones/shared-types';
import { ApiError, errorMessage } from './api';

const BYTES_EN_MB = 1024 * 1024;

const COPY_413 =
  'Esta carga pesa más de lo que el servidor admite. Pártala: quite archivos y sube el resto en otra carga.';
const COPY_504 =
  'El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.';
const COPY_HTML = 'No se pudo completar la carga. Vuelve a intentar.';

type ArchivoCarga = Pick<File, 'name' | 'size'>;

const mbUnDecimal = (bytes: number): string => (bytes / BYTES_EN_MB).toFixed(1);

const topeMbEntero = (bytes: number): number => bytes / BYTES_EN_MB;

function textoError(e: unknown): string {
  const partes: string[] = [];
  if (e instanceof ApiError) {
    partes.push(e.message);
    if (typeof e.rawDetails === 'string') partes.push(e.rawDetails);
  } else if (e instanceof Error) {
    partes.push(e.message);
  }
  return partes.join(' ');
}

function pareceHtmlProxy(texto: string): boolean {
  const t = texto.toLowerCase();
  return (
    t.includes('<!doctype')
    || t.includes('<html')
    || t.includes('<center')
    || t.includes('request entity too large')
    || t.includes('413 request entity')
    || t.includes('gateway time-out')
    || t.includes('gateway timeout')
  );
}

/** Suma de `file.size` (bytes crudos, sin empaque multipart). */
export function pesoCargaMasiva(archivos: readonly ArchivoCarga[]): number {
  return archivos.reduce((suma, archivo) => suma + archivo.size, 0);
}

/** Peso en pantalla: `12.3 MB` (punto, un decimal), el mismo criterio que `soatCliente`. */
export function formatearPesoCargaMasiva(bytes: number): string {
  return `${mbUnDecimal(bytes)} MB`;
}

/**
 * Línea que sustituye «N archivo(s) listos.». Denominador = techo nginx (250 MB),
 * no el corte de envío (200 MB).
 */
export function textoContadorCargaMasiva(archivos: readonly ArchivoCarga[]): string {
  const n = archivos.length;
  const unidad = n === 1 ? 'archivo' : 'archivos';
  return `${n} ${unidad} · ${formatearPesoCargaMasiva(pesoCargaMasiva(archivos))} de ${topeMbEntero(CARGA_MASIVA_MAX_BYTES_CUERPO)} MB`;
}

function fraseCantidad(n: number): string {
  const exceso = n - CARGA_MASIVA_MAX_ARCHIVOS;
  return `Seleccionaste ${n} archivos y el máximo son ${CARGA_MASIVA_MAX_ARCHIVOS} (${exceso} de más). Quite archivos.`;
}

function fraseUnArchivoGrande(archivo: ArchivoCarga): string {
  const x = mbUnDecimal(archivo.size);
  const exceso = mbUnDecimal(archivo.size - CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  return `«${archivo.name}» pesa ${x} MB y el máximo por archivo son ${tope} MB (${exceso} MB de más). Quite ese archivo o súbelo aparte.`;
}

function fraseVariosArchivosGrandes(pasaderos: readonly ArchivoCarga[]): string {
  const mostrados = pasaderos.slice(0, 3)
    .map((archivo) => `«${archivo.name}» (${mbUnDecimal(archivo.size)} MB)`)
    .join(', ');
  const resto = pasaderos.length - 3;
  const cola = resto > 0 ? ` y ${resto} más` : '';
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  return `${pasaderos.length} archivos pesan más de ${tope} MB: ${mostrados}${cola}. El máximo por archivo son ${tope} MB. Quítalos o súbelos aparte.`;
}

function frasePesoEnvio(peso: number): string {
  const x = mbUnDecimal(peso);
  const exceso = mbUnDecimal(peso - CARGA_MASIVA_MAX_BYTES_CRUDOS);
  const tope = topeMbEntero(CARGA_MASIVA_MAX_BYTES_CRUDOS);
  return `Esta carga pesa ${x} MB y el máximo de un envío son ${tope} MB (${exceso} MB de más). Quite archivos.`;
}

/**
 * Cortes en el cliente, **antes** de armar el FormData. Si fallan varios topes, las frases
 * van en este orden: cantidad → por archivo → peso. `null` si cabe (también si n === 0).
 */
export function validarCargaMasiva(archivos: readonly ArchivoCarga[]): string | null {
  const frases: string[] = [];
  const n = archivos.length;

  if (n > CARGA_MASIVA_MAX_ARCHIVOS) frases.push(fraseCantidad(n));

  const pasaderos = archivos.filter((archivo) => archivo.size > CARGA_MASIVA_MAX_BYTES_ARCHIVO);
  if (pasaderos.length === 1) frases.push(fraseUnArchivoGrande(pasaderos[0]));
  else if (pasaderos.length > 1) frases.push(fraseVariosArchivosGrandes(pasaderos));

  const peso = pesoCargaMasiva(archivos);
  if (peso > CARGA_MASIVA_MAX_BYTES_CRUDOS) frases.push(frasePesoEnvio(peso));

  return frases.length === 0 ? null : frases.join(' ');
}

/**
 * Solo para el `catch` de `CargaMasiva` / `CargaRecibos`. No toca `statusToMessage` de `api.ts`.
 */
export function mensajeErrorCargaMasiva(e: unknown): string {
  const status = e instanceof ApiError ? e.status : undefined;
  const texto = textoError(e);

  if (status === 413 || /request entity too large/i.test(texto)) return COPY_413;
  if (status === 504 || status === 502 || /gateway time-?out/i.test(texto)) return COPY_504;
  if (pareceHtmlProxy(texto)) return COPY_HTML;
  return errorMessage(e);
}
