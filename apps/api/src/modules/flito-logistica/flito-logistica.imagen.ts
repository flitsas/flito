// FLITO Logística — validación del MIME REAL y del tamaño de una imagen en dataURL (HU #14110, ADR-0030 §9).
// `bufDesdeDataUrl` (base) decodifica sin validar nada; las firmas que llegan como dataURL pasan por aquí
// ANTES de tocar el almacenamiento: el MIME declarado no se cree, se comprueban los bytes mágicos.

import { LogisticaError } from './flito-logistica.base.js';

export type MimeImagen = 'image/png' | 'image/jpeg';

/** Tope de una firma manuscrita (un canvas PNG ocupa decenas de KB; 1 MB deja holgura sin abrir la puerta a un volcado). */
export const FIRMA_MAX_BYTES = 1024 * 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PREFIJO = /^data:([^;,]+)(;[^,]*)?,/i;

export class ImagenInvalidaError extends LogisticaError {
  constructor(message: string) { super(message, 422, undefined, 'FIRMA_INVALIDA'); }
}

/** Tipo real según la cabecera del archivo, o null si no es PNG ni JPEG. */
export function mimeReal(buf: Buffer): MimeImagen | null {
  if (buf.length >= PNG.length && buf.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (buf.length >= JPEG.length && buf.subarray(0, JPEG.length).equals(JPEG)) return 'image/jpeg';
  return null;
}

/**
 * Decodifica un dataURL (o base64 pelado) y exige que sea una imagen PNG/JPEG real de tamaño acotado. Si
 * trae un MIME declarado, debe coincidir con el real. Lanza `ImagenInvalidaError` (422); el mensaje nunca
 * incluye el contenido recibido.
 */
export function imagenDesdeDataUrl(dataUrl: string, maxBytes = FIRMA_MAX_BYTES): { buf: Buffer; mime: MimeImagen } {
  const prefijo = PREFIJO.exec(dataUrl);
  const declarado = prefijo ? prefijo[1].toLowerCase() : null;
  const b64 = (prefijo ? dataUrl.slice(prefijo[0].length) : dataUrl).replace(/\s+/g, '');
  if (!b64 || b64.length % 4 === 1 || !BASE64.test(b64)) throw new ImagenInvalidaError('La firma no es una imagen válida');
  // Cota ANTES de decodificar: el base64 pesa ~4/3 del binario.
  if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) throw new ImagenInvalidaError('La firma supera el tamaño permitido');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > maxBytes) throw new ImagenInvalidaError('La firma supera el tamaño permitido');
  const mime = mimeReal(buf);
  if (!mime) throw new ImagenInvalidaError('La firma debe ser una imagen PNG o JPEG');
  if (declarado !== null && declarado !== mime && !(declarado === 'image/jpg' && mime === 'image/jpeg')) {
    throw new ImagenInvalidaError('El tipo declarado de la firma no corresponde a su contenido');
  }
  return { buf, mime };
}
