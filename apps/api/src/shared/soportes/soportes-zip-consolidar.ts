// FLITO — un PDF por registro en el ZIP de Trámites e Impuestos (HU #12817, Feature #12814).
//
// El ZIP de la HU #11910 entregaba una entrada por DOCUMENTO: un trámite con factura, recibo y
// comprobante SOAT salía como `PLACA.pdf`, `PLACA-2.pdf`, `PLACA-3.pdf`, y Operaciones tenía que
// abrir tres archivos para cuadrar un trámite. Aquí cada registro se junta en UN PDF con sus
// documentos en `ORDEN_TIPOS_SOPORTE_ZIP` (factura → recibo → comprobante SOAT), todas las páginas.
//
// ── Por qué ANTES del primer byte y en disco (diseño slim, opción c) ───────────────────────────────
//
// El AC5 exige avisar de los documentos ilegibles, y el único sitio para avisar es la cabecera: o se
// sabe antes de escribirla, o no se puede decir. Tenerlo todo en memoria hasta entonces no cabe
// (peor caso legal ≈ 900 MB contra el `max_memory_restart` de 512 MB de PM2). Así que se consolida
// registro a registro, con concurrencia 2, cada PDF se vuelca a `os.tmpdir()` y solo se retiene su
// ruta. El pico de memoria depende de la concurrencia, no del tamaño del lote.
//
// ── Lo que se omite y lo que NO ───────────────────────────────────────────────────────────────────
//
// - Ilegible (bytes que no son PDF/JPEG/PNG, PDF que no carga o sin páginas, imagen que no se deja
//   incrustar, PNG por encima de `MAX_PIXELES_PNG`, FLIT o MinIO caídos): se omite y se cuenta en `X-Soportes-Omitidos`.
// - PDF **cifrado** (`EncryptedPDFError`): NO se omite (decisión de producto de la HU #12817). pdf-lib
//   no puede copiar sus páginas —con `ignoreEncryption` saldrían en blanco, y eso está prohibido—,
//   así que el original viaja APARTE, bytes intactos, como otra entrada del registro con el
//   desempate de siempre (`PLACA-2.pdf`). Cuenta como incluido.
//
// Depende de `soportes-zip.ts` y nunca al revés: pdf-lib no entra en la ruta de SOAT, que no consolida.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { env } from '../../config/env.js';
import { loggerFor } from '../logger.js';
import {
  clasificarBytes, desempatador, emitirZipSoportes, ZipDemasiadoGrandeError, ZipSinSoportesError,
  type EntradaZip,
} from './soportes-zip.js';

const log = loggerFor('soportes-zip-consolidar');

/** A4 en puntos PDF (72 dpi), la página de una imagen (AC4). */
const A4 = { ancho: 595.28, alto: 841.89 } as const;

/** Registros que se consolidan a la vez. Ver el pico de memoria en la cabecera. */
const CONCURRENCIA = 2;

/**
 * Techo de píxeles de un PNG antes de dejar que pdf-lib lo decodifique.
 *
 * `embedPng` descomprime la imagen ENTERA en memoria (UPNG → RGBA8, 4 B/px) y luego la parte en
 * canales RGB + alfa (otros ~4 B/px): ~8 B/px en el pico. Los topes de bytes no protegen aquí: un PNG
 * de pocos MB puede declarar 20000×20000 en su IHDR (1,6 GB solo en RGBA) y tumbar el proceso, que PM2
 * reinicia a 512 MB. Con 16 Mpx el pico es ≈ 128 MB por imagen y ≈ 256 MB con `CONCURRENCIA` 2, del
 * orden del presupuesto de lote (262 MB) y por debajo del reinicio. Cubre lo real: un A4 escaneado a
 * 300 dpi son 8,7 Mpx, a 400 dpi 15,6 Mpx; una foto de móvil, 12 Mpx. Por encima → omitido (AC5).
 */
const MAX_PIXELES_PNG = 16_000_000;

/** Firma de 8 bytes de todo PNG. */
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * ¿Cabe este PNG bajo `MAX_PIXELES_PNG`? Lee SOLO la cabecera: firma, primer chunk `IHDR` (siempre
 * el primero por especificación) y su ancho/alto. Cabecera inválida o dimensión 0 → `false`.
 */
function pngDentroDelTecho(buf: Buffer): boolean {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(FIRMA_PNG)) return false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  const ancho = buf.readUInt32BE(16);
  const alto = buf.readUInt32BE(20);
  return ancho > 0 && alto > 0 && ancho * alto <= MAX_PIXELES_PNG;
}

/** El resultado puro de juntar los documentos de UN registro. */
export interface PdfConsolidado {
  /** El PDF con todas las páginas legibles, o `null` si no quedó ninguna (el registro no aporta PDF). */
  pdf: Uint8Array | null;
  /** Documentos legibles metidos en `pdf`. */
  incluidos: number;
  /** Documentos ilegibles: no entran y se avisan (AC5). */
  omitidos: number;
  /** PDFs cifrados, en su orden: viajan APARTE, sin tocar sus bytes. */
  cifrados: Buffer[];
}

/**
 * Una imagen en UNA página A4 con la orientación de la imagen, escalada para caber entera sin
 * deformarse y centrada (AC4: «una página A4 completa, sin recortes»).
 */
async function anadirImagen(destino: PDFDocument, buf: Buffer, tipo: 'jpg' | 'png'): Promise<void> {
  // COPIA a un `Uint8Array` propio, y no es cosmético: el embebedor de JPEG de pdf-lib lee
  // `new DataView(datos.buffer)` ignorando el `byteOffset`, y un `Buffer` pequeño (los de
  // `Buffer.concat`/`Buffer.from` bajo 4 KiB) vive dentro del pool compartido de Node con offset ≠ 0.
  // Sin la copia, un JPEG válido falla con «SOI not found» y se contaría como ilegible. Medido.
  const datos = Uint8Array.from(buf);
  const img = tipo === 'jpg' ? await destino.embedJpg(datos) : await destino.embedPng(datos);
  const apaisada = img.width > img.height;
  const ancho = apaisada ? A4.alto : A4.ancho;
  const alto = apaisada ? A4.ancho : A4.alto;
  const escala = Math.min(ancho / img.width, alto / img.height);
  const w = img.width * escala;
  const h = img.height * escala;
  const pagina = destino.addPage([ancho, alto]);
  pagina.drawImage(img, { x: (ancho - w) / 2, y: (alto - h) / 2, width: w, height: h });
}

/**
 * ¿Es el `EncryptedPDFError` de pdf-lib?
 *
 * `instanceof` NO sirve: pdf-lib se distribuye transpilado a ES5 y su subclase de `Error` pierde el
 * prototipo (medido: `constructor.name === 'Error'` e `instanceof EncryptedPDFError === false`). Se
 * reconoce por su mensaje, que es fijo en la librería, y se conserva el `instanceof` por si una
 * versión futura lo arregla.
 */
function esCifrado(e: unknown): boolean {
  return e instanceof EncryptedPDFError
    || (e instanceof Error && e.message.startsWith('Input document to `PDFDocument.load` is encrypted'));
}

/**
 * Junta los documentos de UN registro, en el orden en que llegan. **Pura, sin E/S**: es la parte que
 * prueba los AC1-AC5 leyendo el PDF que produce.
 *
 * Nada de `ignoreEncryption`: un cifrado copiado sale en blanco, que es la «página vacía» del AC3.
 */
export async function consolidarPdf(docs: Buffer[]): Promise<PdfConsolidado> {
  const destino = await PDFDocument.create();
  let incluidos = 0;
  let omitidos = 0;
  const cifrados: Buffer[] = [];

  for (const buf of docs) {
    const tipo = clasificarBytes(buf);
    try {
      if (tipo === 'pdf') {
        const src = await PDFDocument.load(buf);
        const indices = src.getPageIndices();
        if (indices.length === 0) { omitidos += 1; continue; }
        const paginas = await destino.copyPages(src, indices);
        for (const p of paginas) destino.addPage(p);
        incluidos += 1;
      } else if (tipo === 'png' && !pngDentroDelTecho(buf)) {
        // Nunca llega a `embedPng`: la bomba de descompresión se corta leyendo 24 bytes.
        omitidos += 1;
      } else if (tipo === 'jpg' || tipo === 'png') {
        await anadirImagen(destino, buf, tipo);
        incluidos += 1;
      } else {
        omitidos += 1;
      }
    } catch (e) {
      if (esCifrado(e)) cifrados.push(buf);
      else omitidos += 1;
    }
    // pdf-lib es síncrono: entre documento y documento se suelta el event loop.
    await new Promise<void>((r) => setImmediate(r));
  }

  const pdf = destino.getPageCount() > 0 ? await destino.save() : null;
  return { pdf, incluidos, omitidos, cifrados };
}

/** Lo que las rutas de Trámites e Impuestos necesitan para emitir: entradas, cifras y la limpieza. */
export interface ZipConsolidado {
  /** Una por PDF escrito en disco: el consolidado de cada registro y sus cifrados aparte. */
  entradas: EntradaZip[];
  /** Documentos legibles consolidados + cifrados que van aparte → `X-Soportes-Incluidos`. */
  incluidos: number;
  /** Documentos ilegibles o que no se pudieron leer → `X-Soportes-Omitidos`. */
  omitidos: number;
  /** Borra el directorio temporal. Idempotente; va en el `finally` de la ruta. */
  limpiar: () => Promise<void>;
}

/** El total de bytes REALES leídos en la petición, compartido entre los registros concurrentes. */
interface Contador { total: number }

/**
 * Un stream entero a `Buffer`, cortando si el documento o el lote se pasan (AC8).
 *
 * El presupuesto se comprobó con los bytes DECLARADOS (`resolverEntradasZip`); la factura de FLIT
 * entra con su cupo y su tamaño real puede ser mayor. Aquí se suma lo que de verdad llega y se corta
 * con el MISMO tope: el límite no cambia, solo deja de poder sobrepasarse sin que nadie lo vea.
 */
async function leerConTope(stream: Readable, topeDoc: number, contador: Contador): Promise<Buffer> {
  const trozos: Buffer[] = [];
  let leidos = 0;
  const topeLote = env.FLITO_ZIP_SOPORTES_MAX_BYTES;
  try {
    for await (const c of stream) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
      leidos += b.length;
      contador.total += b.length;
      if (leidos > topeDoc || contador.total > topeLote) throw new ZipDemasiadoGrandeError(topeLote);
      trozos.push(b);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(trozos);
}

/** Lo que dejó en disco UN registro, antes de nombrarlo. */
interface ResultadoRegistro {
  registroId: string;
  nombreRegistro: string;
  /** Rutas en orden: el consolidado (si hubo) y luego los cifrados. */
  archivos: { ruta: string; bytes: number; cifrado: boolean }[];
  incluidos: number;
  omitidos: number;
}

async function consolidarRegistro(
  grupo: EntradaZip[], dir: string, contador: Contador,
): Promise<ResultadoRegistro> {
  const cupo = env.FLITO_ZIP_FACTURA_CUPO_BYTES;
  const docs: Buffer[] = [];
  let noLeidos = 0;
  for (const e of grupo) {
    try {
      const { stream } = await e.abrir();
      // Defensa por documento: el doble de lo que se presupuestó, y nunca menos que el cupo de FLIT.
      docs.push(await leerConTope(stream, Math.max(e.bytes, cupo) * 2, contador));
    } catch (err) {
      if (err instanceof ZipDemasiadoGrandeError) throw err;
      noLeidos += 1;
      // Sin placa ni nombre: este log no es sitio para un dato personal.
      log.warn({ err: (err as Error).message, tipo: e.tipo }, 'documento no leído; se omite del consolidado');
    }
  }

  const r = await consolidarPdf(docs);
  docs.length = 0;
  const archivos: ResultadoRegistro['archivos'] = [];
  const escribir = async (bytes: Uint8Array, cifrado: boolean): Promise<void> => {
    const ruta = path.join(dir, `${randomUUID()}.pdf`);
    // 0o600: el temporal lleva documentos de terceros; solo el usuario del proceso lo lee.
    await fs.writeFile(ruta, bytes, { mode: 0o600 });
    archivos.push({ ruta, bytes: bytes.length, cifrado });
  };
  if (r.pdf) await escribir(r.pdf, false);
  for (const c of r.cifrados) await escribir(c, true);

  return {
    registroId: grupo[0]!.registroId,
    nombreRegistro: grupo[0]!.nombreRegistro,
    archivos,
    incluidos: r.incluidos + r.cifrados.length,
    omitidos: r.omitidos + noLeidos,
  };
}

/**
 * Consolida las entradas de `resolverEntradasZip` en UN PDF por registro, en disco temporal.
 *
 * Las entradas ya llegan en orden de servidor (registro por `createdAt, id`; tipo por
 * `ORDEN_TIPOS_SOPORTE_ZIP`; soportes por `subidoEn, id`), así que se agrupan de forma consecutiva
 * sin reordenar. Los resultados se guardan POR ÍNDICE y se nombran al final: el nombre no depende
 * de qué registro terminó antes, así que `PLACA.pdf` / `PLACA-2.pdf` es determinista (AC6).
 *
 * @throws ZipSinSoportesError  ningún documento fue legible (el mismo 409, AC5).
 * @throws ZipDemasiadoGrandeError  los bytes reales superan el tope (AC8).
 * En los dos casos el temporal ya está borrado.
 */
export async function consolidarPorRegistro(entradas: EntradaZip[]): Promise<ZipConsolidado> {
  const grupos: EntradaZip[][] = [];
  for (const e of entradas) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo[0]!.registroId === e.registroId) ultimo.push(e);
    else grupos.push([e]);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flito-zip-'));
  const limpiar = (): Promise<void> => fs.rm(dir, { recursive: true, force: true });

  try {
    const contador: Contador = { total: 0 };
    const resultados: ResultadoRegistro[] = new Array(grupos.length);
    let siguiente = 0;
    let fallo: unknown = null;
    const trabajador = async (): Promise<void> => {
      while (fallo === null && siguiente < grupos.length) {
        const i = siguiente++;
        try {
          resultados[i] = await consolidarRegistro(grupos[i]!, dir, contador);
        } catch (e) {
          fallo ??= e;
        }
      }
    };
    // `allSettled` + primer fallo, y no `Promise.all`: con `all` el otro trabajador seguiría
    // escribiendo en un directorio que el `catch` de abajo ya está borrando.
    await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCIA, grupos.length) }, trabajador));
    if (fallo !== null) throw fallo;

    const nombrar = desempatador();
    const salida: EntradaZip[] = [];
    let incluidos = 0;
    let omitidos = 0;
    let cifrados = 0;
    for (const r of resultados) {
      incluidos += r.incluidos;
      omitidos += r.omitidos;
      for (const a of r.archivos) {
        if (a.cifrado) cifrados += 1;
        salida.push({
          nombreBase: nombrar(r.nombreRegistro),
          nombreRegistro: r.nombreRegistro,
          tipo: 'consolidado',
          registroId: r.registroId,
          bytes: a.bytes,
          abrir: async () => ({ stream: createReadStream(a.ruta), extension: 'pdf' }),
        });
      }
    }

    // R3 del diseño: la cifra real de cifrados en DEV, sin placa.
    log.info({ registros: resultados.length, incluidos, omitidos, cifrados }, 'zip consolidado');
    if (salida.length === 0) throw new ZipSinSoportesError();
    return { entradas: salida, incluidos, omitidos, limpiar };
  } catch (e) {
    await limpiar();
    throw e;
  }
}

/**
 * Emite el ZIP ya consolidado y borra el temporal pase lo que pase.
 *
 * El `close` de la respuesta cubre al cliente que corta la descarga a medias: sin él, un archivador
 * atascado por backpressure dejaría el directorio en `/tmp` hasta que alguien reiniciara.
 */
export async function emitirZipConsolidado(res: Response, zc: ZipConsolidado): Promise<number> {
  res.once('close', () => { void zc.limpiar(); });
  try {
    return await emitirZipSoportes(res, zc.entradas, undefined, { incluidos: zc.incluidos, omitidos: zc.omitidos });
  } finally {
    await zc.limpiar();
  }
}
