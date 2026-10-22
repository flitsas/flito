// Fixtures REALES para la consolidación del ZIP (HU #12817).
//
// Cada PDF lleva páginas cuadradas con un ANCHO que funciona de firma: el orden y el número de páginas
// del PDF consolidado se leen del archivo producido (`anchosDe`), no del orden en que se llamó a una
// función. Un aserto sobre el mock se quedaría verde aunque el PDF saliera al revés.

import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

/** Un PDF con una página cuadrada de cada ancho pedido, en ese orden. */
export async function pdfFirma(anchos: number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const a of anchos) doc.addPage([a, a]);
  return Buffer.from(await doc.save());
}

/** Los anchos de página de un PDF, en orden. Redondeados: pdf-lib guarda decimales. */
export async function anchosDe(pdf: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

/** Tamaño de cada página (para el AC4: A4 con la orientación de la imagen). */
export async function tamanosDe(pdf: Uint8Array): Promise<{ w: number; h: number }[]> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => ({ w: Math.round(p.getWidth()), h: Math.round(p.getHeight()) }));
}

/**
 * Un PDF que pdf-lib rechaza con `EncryptedPDFError`: páginas reales y un `/Encrypt` en el trailer.
 *
 * pdf-lib no sabe cifrar, pero su comprobación de cifrado es exactamente «el trailer apunta a un
 * diccionario `/Encrypt`» (`PDFDocument.isEncrypted`). Es lo que trae un recibo oficial con
 * contraseña de propietario, y es lo que hace falta para ejercitar la rama del cifrado.
 */
export async function pdfCifrado(anchos: number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const a of anchos) doc.addPage([a, a]);
  const enc = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128, P: -3904 }));
  doc.context.trailerInfo.Encrypt = enc;
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Un PNG RGB real de `w`×`h`, codificado a mano (sin dependencia nueva). */
export function png(w: number, h: number): Buffer {
  const trozo = (tipo: string, datos: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const fila = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const crudo = Buffer.concat(Array.from({ length: h }, () => fila));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IDAT', deflateSync(crudo)), trozo('IEND', Buffer.alloc(0)),
  ]);
}

/** Un JPEG real de 1×1 (baseline). */
export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////'
  + '////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAA'
  + 'AAD/2gAIAQEAAD8AN//Z',
  'base64',
);
