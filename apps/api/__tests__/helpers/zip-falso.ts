// Un escritor de zips que se deja MENTIR, para las pruebas del guardián de `.xlsx`.
//
// Se escribe a mano —80 líneas de formato zip— porque hace falta poder mentir en las cabeceras:
// ninguna librería escribe un directorio central que declare 1 KB para 40 MB de datos, y ese es
// justo el caso que la segunda pasada de `medirXlsx` tiene que atrapar.
//
// Lo que hace útil a este falsificador es que produce archivos con DOS desenlaces distinguibles:
// un zip que declara una hoja enorme pero cuyos datos son basura solo se puede rechazar por tamaño
// si NADIE lo abrió; si alguien lo abre primero, ExcelJS revienta y el error es otro. Eso da una
// prueba del ORDEN que no depende de cronómetros ni de medir el heap.
//
// Nació en `__tests__/services/flito-conciliacion-zip.test.ts` (HU #11676) y se promovió a helper
// con el Bug #11682, cuando el mismo guardián pasó a cubrir vehículos y SOAT.

import zlib from 'zlib';

export interface EntradaFalsa {
  nombre: string;
  /** Contenido SIN comprimir. Se guarda deflateado salvo que `crudo` diga lo contrario. */
  datos: Buffer;
  /** Lo que el zip DECLARA que ocupa descomprimido. Por defecto, la verdad. */
  declarado?: number;
  crudo?: boolean;
}

export function zipDe(entradas: EntradaFalsa[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, 'utf8');
    const datos = e.crudo ? e.datos : zlib.deflateRawSync(e.datos);
    const metodo = e.crudo ? 0 : 8;
    const crc = zlib.crc32 ? zlib.crc32(e.datos) : 0;
    const declarado = e.declarado ?? e.datos.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nombre.length, 26);
    locales.push(local, nombre, datos);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre);

    offset += 30 + nombre.length + datos.length;
  }

  const central = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entradas.length, 8);
  eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, central, eocd]);
}

/** El esqueleto mínimo de un xlsx, para que lo que se pruebe sea el tamaño y no la forma. */
export function xlsxFalso(hoja: EntradaFalsa, hojasExtra = 0): Buffer {
  const extras = Array.from({ length: hojasExtra }, (_, i) => ({
    nombre: `xl/worksheets/sheet${i + 2}.xml`,
    datos: Buffer.from('<worksheet/>'),
  }));
  return zipDe([
    { nombre: '[Content_Types].xml', datos: Buffer.from('<Types/>') },
    { nombre: '_rels/.rels', datos: Buffer.from('<Relationships/>') },
    { nombre: 'xl/workbook.xml', datos: Buffer.from('<workbook/>') },
    hoja,
    ...extras,
  ]);
}
