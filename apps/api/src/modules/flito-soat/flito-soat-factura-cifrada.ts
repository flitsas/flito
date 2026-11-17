// Comprobante SOAT en PDF cifrado con contraseña de apertura (Bug #14569).
//
// Adaptador entre el helper transversal `shared/pdf/pdf-cifrado.ts` y la carga de facturas de
// `flito-soat.service.ts` (individual y masiva). Se apoya en un archivo propio porque el servicio
// tiene techo congelado de líneas (`eslint.config.mjs`).
//
// Regla: el original cifrado NUNCA se guarda. O se descifra y el flujo sigue con el PDF descifrado
// (hash de duplicado, archivo guardado, OCR), o no se guarda nada. qpdf no disponible = falla
// cerrado (503 en la individual; `noAsociados` en la masiva, sin frenar el resto del lote).
//
// También vive aquí `expandir()` (ZIP → archivos), movida desde el servicio por el mismo techo.
// Una entrada de un ZIP expandido en el servidor no hereda contraseña: no hay cómo emparejarla.

import JSZip from 'jszip';
import { abrirPdf, PdfContrasenaIncorrectaError, QpdfNoDisponibleError } from '../../shared/pdf/pdf-cifrado.js';
import { SoatError, type ArchivoSubido, type ResultadoCargaMasiva } from './flito-soat.service.js';

const MSG_CIFRADO = 'Este PDF está protegido con contraseña. Escríbela para cargarlo.';
const MSG_INCORRECTA = 'La contraseña no abre este PDF.';
const MSG_NO_DISPONIBLE = 'No pudimos abrir el PDF protegido en este momento. Intenta más tarde.';

/** El archivo que sigue el flujo: descifrado, con `size` recalculado y SIN la contraseña. */
function abierto(archivo: ArchivoSubido, buffer: Buffer): ArchivoSubido {
  return { originalname: archivo.originalname, mimetype: archivo.mimetype, buffer, size: buffer.length };
}

/** Carga individual: devuelve el archivo abierto o lanza `SoatError` (422/503) sin guardar nada. */
export async function abrirFacturaCifrada(archivo: ArchivoSubido): Promise<ArchivoSubido> {
  try {
    const r = await abrirPdf(archivo.buffer, archivo.contrasena);
    if (r.estado === 'requiere-contrasena') throw new SoatError(422, MSG_CIFRADO, 'PDF_CIFRADO');
    return abierto(archivo, r.buffer);
  } catch (e) {
    if (e instanceof PdfContrasenaIncorrectaError) throw new SoatError(422, MSG_INCORRECTA, 'PDF_CONTRASENA_INCORRECTA');
    if (e instanceof QpdfNoDisponibleError) throw new SoatError(503, MSG_NO_DISPONIBLE, 'PDF_CIFRADO_NO_DISPONIBLE');
    throw e;
  }
}

/**
 * Carga masiva: devuelve el archivo abierto, o `null` si ya quedó registrado en `res`
 * (`protegidos` si falta o falla la clave; `noAsociados` si qpdf no está disponible).
 */
export async function abrirEnLote(archivo: ArchivoSubido, res: ResultadoCargaMasiva): Promise<ArchivoSubido | null> {
  const fila = (detalle: string) => ({ archivo: archivo.originalname, placa: null, soatId: null, detalle });
  try {
    const r = await abrirPdf(archivo.buffer, archivo.contrasena);
    if (r.estado === 'requiere-contrasena') { res.protegidos.push(fila('Protegido con contraseña.')); return null; }
    return abierto(archivo, r.buffer);
  } catch (e) {
    if (e instanceof PdfContrasenaIncorrectaError) { res.protegidos.push(fila(MSG_INCORRECTA)); return null; }
    if (e instanceof QpdfNoDisponibleError) { res.noAsociados.push(fila(MSG_NO_DISPONIBLE)); return null; }
    throw e;
  }
}

/** Un ZIP es una caja: se abre y se procesa cada archivo que trae (PDF/imagen). */
export async function expandir(archivos: ArchivoSubido[]): Promise<ArchivoSubido[]> {
  const salida: ArchivoSubido[] = [];
  for (const archivo of archivos) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    if (!esZip) { salida.push(archivo); continue; }

    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf'
        : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg'
        : lower.endsWith('.png') ? 'image/png'
        : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length });
    }
  }
  return salida;
}
