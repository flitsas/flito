// El vistazo a un `.xlsx` ANTES de abrirlo (HU #11676 en Conciliación; promovido a compartido por
// el Bug #11682, que encontró el mismo agujero en los otros tres puntos de ingesta del monolito).
//
// Un `.xlsx` es un zip. `ExcelJS.xlsx.load(buffer)` descomprime y materializa el libro ENTERO en el
// heap antes de que nadie pueda mirar cuántas filas trae, así que cualquier tope que se compruebe
// sobre el libro ya cargado llega tarde: el daño —el heap y el event loop— ya está hecho.
//
// Medido en este repo (Bug #11682) con un libro de 580 000 filas escrito por el propio ExcelJS
// —10 016 899 bytes, o sea POR DEBAJO del `limits.fileSize` de 10 MB, con MIME correcto y magic
// number de xlsx legítimo, y 122 MB descomprimidos por dentro—, subido a las rutas reales:
//
//   · `POST /api/vehicles/upload`        → 32,5 s bloqueado, +2553 MB de heap, RSS 3060 MB
//   · `POST /api/soat/batch-validate`    → 26,5 s bloqueado, +1925 MB de heap … para luego contestar
//                                          «Máximo 200 VINs por lote»: el tope se miraba DESPUÉS
//   · `POST /api/soat/upload-purchases`  → 20,7 s bloqueado, +1418 MB de heap
//
// Con el heap acotado a 512 MB las tres mueren igual: `FATAL ERROR: Ineffective mark-compacts near
// heap limit`, que ningún `try/catch` atrapa. Se muere el proceso entero de la API, no la petición.
//
// Este módulo contesta «¿cuánto pesa esto por dentro?» sin abrir el libro, en dos pasadas:
//
//   1. **Cabeceras.** El directorio central del zip declara el tamaño descomprimido de cada entrada.
//      Leerlo es aritmética sobre unos cientos de bytes al final del archivo: no descomprime nada.
//      Ahí muere el caso real —el de 580 000 filas declara 122 MB— en microsegundos.
//   2. **Datos.** Las cabeceras las escribe quien fabrica el zip, o sea que MIENTEN si el atacante
//      quiere: un zip puede declarar 1 KB y traer 200 MB de deflate. Por eso, cuando las cabeceras
//      pasan, se inflan las entradas con `maxOutputLength` como presupuesto duro. zlib corta en
//      cuanto se pasa (`ERR_BUFFER_TOO_LARGE`) y devuelve el control sin haber materializado el
//      resto. El coste está acotado por el propio presupuesto.
//
// Después de esto, `load` recibe un archivo del que YA se sabe que no pasa de `maxBytes` inflado.
// Lo que este módulo NO hace: entender xlsx. No lee XML, no sabe qué es una hoja más allá del
// nombre de la entrada, y no valida nada de negocio. Eso sigue siendo cosa del parser.
//
// Tampoco decide QUÉ límites ni QUÉ error: devuelve un dato. Cada consumidor pone su techo (que
// depende de cuántas filas admite SU flujo) y traduce el resultado a su propio HTTP y su propio
// copy. Aquí no se sabe nada de eso a propósito: es lo que permite que lo compartan Conciliación,
// vehículos y SOAT sin que ninguno arrastre los códigos de error de otro.

import zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);

/** Firmas del formato zip (APPNOTE 6.3.9), todas little-endian. */
const FIRMA_EOCD = 0x0605_4b50;
const FIRMA_EOCD64 = 0x0606_4b50;
const FIRMA_LOCALIZADOR64 = 0x0706_4b50;
const FIRMA_CENTRAL = 0x0201_4b50;
const FIRMA_LOCAL = 0x0403_4b50;

/** Tamaños fijos de cada registro, sin las partes variables (nombre, extra, comentario). */
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const COMENTARIO_MAX = 0xffff;

/** Un valor de 32 bits a tope significa «está en el extra field zip64», no «vale 4 GB». */
const DESBORDE32 = 0xffff_ffff;
const DESBORDE16 = 0xffff;

/** Los dos únicos métodos que ExcelJS sabe leer. Cualquier otro no es un xlsx que vayamos a abrir. */
const METODO_CRUDO = 0;
const METODO_DEFLATE = 8;

export interface LimitesZip {
  /** Bytes descomprimidos que se toleran en TODO el libro sumado. */
  maxBytes: number;
  /** Hojas (`xl/worksheets/…`) que se toleran. */
  maxHojas: number;
  /** Entradas del zip que se toleran. Un libro de una hoja escrito por ExcelJS trae dieciséis. */
  maxEntradas: number;
}

/**
 * Qué se supo del archivo. Es un resultado, no una excepción: quien llama decide qué HTTP y qué
 * copy le corresponde a cada caso, y aquí no se sabe nada de eso.
 *
 *   ok           — cabe: `bytes` es lo que de verdad ocupa descomprimido
 *   ilegible     — no es un zip que se pueda recorrer, o usa un método de compresión ajeno
 *   excede       — se pasa del presupuesto. `segun` dice si lo delataron sus cabeceras o sus datos
 *   estructura   — demasiadas hojas o demasiadas entradas para el libro que el flujo espera
 */
export type MedidaXlsx =
  | { estado: 'ok'; entradas: number; hojas: number; bytes: number }
  | { estado: 'ilegible' }
  | { estado: 'excede'; bytes: number; segun: 'cabeceras' | 'datos' }
  | { estado: 'estructura'; entradas: number; hojas: number };

/**
 * El subconjunto de `MedidaXlsx` que obliga a rechazar el archivo. Se nombra aparte para que la
 * firma de quien traduce el resultado no admita un `ok` por descuido.
 */
export type RechazoXlsx = Exclude<MedidaXlsx, { estado: 'ok' }>;

interface EntradaCentral {
  nombre: string;
  metodo: number;
  descomprimido: number;
  offsetLocal: number;
  /** Offset del siguiente registro del directorio central. */
  siguiente: number;
}

/** ¿La entrada es una hoja de cálculo? `xl/worksheets/sheet1.xml`, pero no su `_rels`. */
function esHoja(nombre: string): boolean {
  return /^xl\/worksheets\/[^/]+\.xml$/i.test(nombre);
}

/**
 * El registro final del zip (EOCD), buscado hacia atrás porque puede llevar hasta 64 KB de
 * comentario detrás. Se acepta el primero cuyo comentario declarado cuadre EXACTO con lo que queda
 * de archivo: así una firma que aparezca por casualidad dentro de los datos no confunde la lectura.
 */
function leerEocd(buf: Buffer): { entradas: number; offsetCentral: number; finCentral: number } | null {
  if (buf.length < EOCD_BYTES) return null;
  const minimo = Math.max(0, buf.length - EOCD_BYTES - COMENTARIO_MAX);
  for (let i = buf.length - EOCD_BYTES; i >= minimo; i -= 1) {
    if (buf.readUInt32LE(i) !== FIRMA_EOCD) continue;
    if (i + EOCD_BYTES + buf.readUInt16LE(i + 20) !== buf.length) continue;

    let entradas = buf.readUInt16LE(i + 10);
    let tamano = buf.readUInt32LE(i + 12);
    let offset = buf.readUInt32LE(i + 16);
    if (entradas === DESBORDE16 || tamano === DESBORDE32 || offset === DESBORDE32) {
      const z64 = leerEocd64(buf, i);
      if (!z64) return null;
      ({ entradas, tamano, offset } = z64);
    }
    if (offset + tamano > buf.length) return null;
    return { entradas, offsetCentral: offset, finCentral: offset + tamano };
  }
  return null;
}

/** El EOCD de 64 bits, al que se llega por su localizador, justo antes del EOCD normal. */
function leerEocd64(
  buf: Buffer, offsetEocd: number,
): { entradas: number; tamano: number; offset: number } | null {
  const loc = offsetEocd - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== FIRMA_LOCALIZADOR64) return null;
  const dir = Number(buf.readBigUInt64LE(loc + 8));
  if (!Number.isSafeInteger(dir) || dir < 0 || dir + 56 > buf.length) return null;
  if (buf.readUInt32LE(dir) !== FIRMA_EOCD64) return null;
  const entradas = Number(buf.readBigUInt64LE(dir + 32));
  const tamano = Number(buf.readBigUInt64LE(dir + 40));
  const offset = Number(buf.readBigUInt64LE(dir + 48));
  if (![entradas, tamano, offset].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return { entradas, tamano, offset };
}

/**
 * Los campos de 64 bits que el registro central esconde en su extra field (id 0x0001).
 *
 * Van en orden fijo y SOLO están los que en el registro valían 0xFFFFFFFF, así que hay que consumir
 * el búfer sabiendo cuáles se esperan; leerlos por posición fija es el error clásico.
 */
function leerExtra64(
  extra: Buffer, descomprimido: number, comprimido: number, offsetLocal: number,
): { descomprimido: number; offsetLocal: number } | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const largo = extra.readUInt16LE(p + 2);
    if (p + 4 + largo > extra.length) return null;
    if (id === 0x0001) {
      const campos = [descomprimido === DESBORDE32, comprimido === DESBORDE32, offsetLocal === DESBORDE32];
      let q = p + 4;
      const leidos: number[] = [];
      for (const presente of campos) {
        if (!presente) { leidos.push(-1); continue; }
        if (q + 8 > p + 4 + largo) return null;
        const v = Number(extra.readBigUInt64LE(q));
        if (!Number.isSafeInteger(v) || v < 0) return null;
        leidos.push(v);
        q += 8;
      }
      return {
        descomprimido: leidos[0] >= 0 ? leidos[0] : descomprimido,
        offsetLocal: leidos[2] >= 0 ? leidos[2] : offsetLocal,
      };
    }
    p += 4 + largo;
  }
  return null;
}

/** Un registro del directorio central, o `null` si el zip no se deja recorrer. */
function leerEntrada(buf: Buffer, p: number, fin: number): EntradaCentral | null {
  if (p + CENTRAL_BYTES > fin || buf.readUInt32LE(p) !== FIRMA_CENTRAL) return null;
  const metodo = buf.readUInt16LE(p + 10);
  const comprimido = buf.readUInt32LE(p + 20);
  const largoNombre = buf.readUInt16LE(p + 28);
  const largoExtra = buf.readUInt16LE(p + 30);
  const largoComentario = buf.readUInt16LE(p + 32);
  const siguiente = p + CENTRAL_BYTES + largoNombre + largoExtra + largoComentario;
  if (siguiente > fin) return null;

  let descomprimido = buf.readUInt32LE(p + 24);
  let offsetLocal = buf.readUInt32LE(p + 42);
  if (descomprimido === DESBORDE32 || offsetLocal === DESBORDE32) {
    const inicioExtra = p + CENTRAL_BYTES + largoNombre;
    const z64 = leerExtra64(
      buf.subarray(inicioExtra, inicioExtra + largoExtra), descomprimido, comprimido, offsetLocal,
    );
    if (!z64) return null;
    ({ descomprimido, offsetLocal } = z64);
  }

  const nombre = buf.toString('utf8', p + CENTRAL_BYTES, p + CENTRAL_BYTES + largoNombre);
  return { nombre, metodo, descomprimido, offsetLocal, siguiente };
}

/** Dónde empiezan los datos de una entrada, según su cabecera local (que trae sus propios largos). */
function inicioDatos(buf: Buffer, offsetLocal: number): number | null {
  if (offsetLocal < 0 || offsetLocal + LOCAL_BYTES > buf.length) return null;
  if (buf.readUInt32LE(offsetLocal) !== FIRMA_LOCAL) return null;
  const inicio = offsetLocal + LOCAL_BYTES
    + buf.readUInt16LE(offsetLocal + 26) + buf.readUInt16LE(offsetLocal + 28);
  return inicio <= buf.length ? inicio : null;
}

/**
 * Cuánto ocupa de verdad el libro descomprimido, sin abrirlo.
 *
 * Ver la cabecera del archivo para el porqué de las dos pasadas. El presupuesto se reparte entre las
 * entradas: en cuanto la suma se pasa de `maxBytes` se corta y se vuelve, sin inflar el resto.
 */
export async function medirXlsx(buffer: Buffer, limites: LimitesZip): Promise<MedidaXlsx> {
  const eocd = leerEocd(buffer);
  if (!eocd) return { estado: 'ilegible' };

  // ── Pasada 1: las cabeceras ────────────────────────────────────────────────
  const entradas: EntradaCentral[] = [];
  let p = eocd.offsetCentral;
  let declarados = 0;
  let hojas = 0;
  while (p < eocd.finCentral) {
    const entrada = leerEntrada(buffer, p, eocd.finCentral);
    if (!entrada) return { estado: 'ilegible' };
    entradas.push(entrada);
    declarados += entrada.descomprimido;
    if (esHoja(entrada.nombre)) hojas += 1;
    // Se corta en cuanto se pasa: un directorio central con un millón de registros tampoco se
    // recorre entero para luego decir que no.
    if (entradas.length > limites.maxEntradas || hojas > limites.maxHojas) {
      return { estado: 'estructura', entradas: entradas.length, hojas };
    }
    if (declarados > limites.maxBytes) {
      return { estado: 'excede', bytes: declarados, segun: 'cabeceras' };
    }
    p = entrada.siguiente;
  }
  if (entradas.length === 0) return { estado: 'ilegible' };

  // ── Pasada 2: los datos, que son los que mandan ────────────────────────────
  let reales = 0;
  for (const entrada of entradas) {
    const inicio = inicioDatos(buffer, entrada.offsetLocal);
    if (inicio === null || inicio > eocd.offsetCentral) return { estado: 'ilegible' };

    if (entrada.metodo === METODO_CRUDO) {
      // Sin comprimir: lo que ocupa dentro del zip es lo que ocupa fuera, y el zip entero ya pasó
      // por el tope de bytes de multer. No hay nada que inflar ni, por tanto, nada que acotar.
      reales += Math.min(entrada.descomprimido, eocd.offsetCentral - inicio);
    } else if (entrada.metodo === METODO_DEFLATE) {
      const presupuesto = limites.maxBytes - reales;
      if (presupuesto <= 0) return { estado: 'excede', bytes: limites.maxBytes, segun: 'datos' };
      try {
        // El final del dato se deja en el arranque del directorio central en vez de fiarse del
        // `comprimido` declarado: zlib para solo al acabar el flujo deflate y le da igual lo que
        // venga detrás, así que una cabecera que mienta a lo grande no cambia el resultado.
        const salida = await inflateRaw(buffer.subarray(inicio, eocd.offsetCentral), {
          maxOutputLength: presupuesto,
        });
        reales += salida.length;
      } catch (e) {
        const codigo = (e as NodeJS.ErrnoException).code;
        if (codigo === 'ERR_BUFFER_TOO_LARGE') {
          return { estado: 'excede', bytes: limites.maxBytes, segun: 'datos' };
        }
        return { estado: 'ilegible' };
      }
    } else {
      return { estado: 'ilegible' };
    }
  }

  return { estado: 'ok', entradas: entradas.length, hojas, bytes: reales };
}
