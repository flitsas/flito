// HU #14131 (Feature #14013, R-5 del diseño) — verificación del contenedor XLSX ANTES de pasarlo a exceljs.
//
// Un .xlsx es un ZIP (OOXML). La extensión y el `Content-Type` los pone el cliente, así que aquí se mira
// el CONTENIDO: firma `PK`, directorio central, las dos partes obligatorias de OOXML y un tope de
// tamaño DESCOMPRIMIDO medido inflando de verdad cada entrada con `maxOutputLength` (el tamaño que
// declara el directorio central lo escribe quien sube el archivo, así que no se confía en él: una zip
// bomb declara poco y expande mucho). Sin dependencias nuevas: `zlib` de Node.

import { inflateRawSync } from 'node:zlib';

/** Tope total descomprimido (un XLSX legítimo de 200 filas pesa unas decenas de KB). */
export const TOPE_DESCOMPRIMIDO = 20 * 1024 * 1024;
const MAX_ENTRADAS = 100;
const PARTES_OBLIGATORIAS = ['[Content_Types].xml', 'xl/workbook.xml'];

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** `true` si el buffer es un ZIP/OOXML estructuralmente válido, con las partes de un libro y sin bomba. */
export function esXlsxReal(buf: Buffer): boolean {
  try {
    if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false; // firma "PK"
    // EOCD: última ocurrencia de su firma en los últimos 22 + 65535 bytes.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) return false;
    const entradas = buf.readUInt16LE(eocd + 10);
    const offsetCd = buf.readUInt32LE(eocd + 16);
    if (entradas === 0 || entradas > MAX_ENTRADAS || offsetCd === 0xffffffff) return false; // ZIP64 no aplica a 1 MB

    const nombres = new Set<string>();
    let total = 0;
    let p = offsetCd;
    for (let n = 0; n < entradas; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) return false;
      const metodo = buf.readUInt16LE(p + 10);
      const comprimido = buf.readUInt32LE(p + 20);
      const lenNombre = buf.readUInt16LE(p + 28);
      const lenExtra = buf.readUInt16LE(p + 30);
      const lenComentario = buf.readUInt16LE(p + 32);
      const offsetLocal = buf.readUInt32LE(p + 42);
      const nombre = buf.toString('utf8', p + 46, p + 46 + lenNombre);
      nombres.add(nombre);

      if (offsetLocal + 30 > buf.length || buf.readUInt32LE(offsetLocal) !== SIG_LOCAL) return false;
      const inicio = offsetLocal + 30 + buf.readUInt16LE(offsetLocal + 26) + buf.readUInt16LE(offsetLocal + 28);
      if (inicio + comprimido > buf.length) return false;
      const datos = buf.subarray(inicio, inicio + comprimido);
      let real: number;
      if (metodo === 0) real = datos.length;
      else if (metodo === 8) real = inflateRawSync(datos, { maxOutputLength: TOPE_DESCOMPRIMIDO - total + 1 }).length;
      else return false;
      total += real;
      if (total > TOPE_DESCOMPRIMIDO) return false;
      p += 46 + lenNombre + lenExtra + lenComentario;
    }
    return PARTES_OBLIGATORIAS.every((parte) => nombres.has(parte));
  } catch {
    // Inflado inválido, `maxOutputLength` superado, lectura fuera de rango: no es un XLSX utilizable.
    return false;
  }
}
