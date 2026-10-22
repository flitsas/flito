// FLITO Impuestos — compresión de los comprobantes PDF al cargarlos (HU #13207, Feature #12955).
// Diseño: docs/diseno/hu-13207-compresion-comprobantes-pdf.md. Se invoca desde `archivar()` de
// flito-recibos.service.ts, DESPUÉS del hash, del OCR, de la vigilancia de fase y del dedupe: lo que
// se guarda en storage puede pesar menos que lo subido, pero el hash y el OCR siguen siendo del original.
//
// Reglas:
//   RN-C1 — NUNCA lanza. Ante cualquier fallo, tiempo excedido o verificación que no cuadra, devuelve el
//           ORIGINAL (escalón 0) y la carga sigue su resultado normal.
//   RN-C2 — Escalón 0 por regla, sin CPU ni spawn: no es PDF por magic bytes (`%PDF-`, no el mimetype ni
//           la extensión: JPEG/PNG caen aquí), pesa ≤ 1 MB, está firmado o está cifrado → el mismo buffer.
//   RN-C3 — Escalón 1 (sin pérdida): pdf-lib reescribe con object streams. Se acepta solo si conserva el
//           número de páginas y `pdftotext -layout` sale IDÉNTICO byte a byte al del original.
//   RN-C4 — Escalón 3 (con pérdida): `pdftoppm` 150 dpi JPEG q75 y rearmado al tamaño de página original
//           (con la rotación ya aplicada). SOLO si el documento entero tiene < 40 caracteres de texto: un
//           PDF con texto (aunque sea una página) NUNCA se rasteriza. Se parte del original, no del 1.
//   RN-C5 — Se guarda el primer escalón que llegue a ≤ 1 MB; si ninguno, el más liviano, y nunca algo más
//           pesado que el original. No llegar a la meta no rechaza la carga.
//   RN-C6 — Topes: 50 páginas; lado > 2000 pt salta el escalón 3; 20 s por archivo (SIGKILL del binario);
//           2 compresiones simultáneas en todo el proceso (semáforo de módulo).
//   RN-C7 — Los JPEG temporales son el comprobante del contribuyente (PII): `mkdtemp` + `rm` en `finally`.
//           El log lleva solo escalón, motivo, bytes y ms: nunca el nombre del archivo ni el texto.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedPDFError, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { loggerFor } from '../../shared/logger.js';
import { ejecutarBinario } from '../flito-ocr/flito-ocr-local.js';

const log = loggerFor('flito-recibos-compresion');

export const META_BYTES = 1024 * 1024;
export const UMBRAL_TEXTO_CHARS = 40;
export const MAX_PAGINAS = 50;
export const MAX_LADO_PT = 2000;
export const TIEMPO_LIMITE_MS = 20_000;
export const MAX_COMPRESIONES_SIMULTANEAS = 2;
const PREFIJO_TMP = 'flito-comp-';

export type Escalon = 0 | 1 | 3;
export type MotivoCompresion =
  | 'NO_PDF' | 'BAJO_META' | 'FIRMADO' | 'CIFRADO'
  | 'META_ALCANZADA' | 'MAS_LIVIANO' | 'SIN_MEJORA'
  | 'SIN_POPPLER' | 'ERROR' | 'TIEMPO' | 'VERIFICACION' | 'LIMITE_PAGINAS';

export interface ResultadoCompresion {
  buffer: Buffer; escalon: Escalon; bytesAntes: number; bytesDespues: number; motivo: MotivoCompresion;
}

export interface DepsCompresion {
  ejecutar: (cmd: string, args: string[], input: Buffer | undefined, timeoutMs: number) => Promise<Buffer>;
  ahora: () => number;
  tiempoLimiteMs: number;
}

const DEPS: DepsCompresion = { ejecutar: ejecutarBinario, ahora: () => Date.now(), tiempoLimiteMs: TIEMPO_LIMITE_MS };

// ── Semáforo de módulo (acota el proceso entero, no un lote) ─────────────────
let activos = 0;
const cola: Array<() => void> = [];
async function adquirir(): Promise<void> {
  if (activos < MAX_COMPRESIONES_SIMULTANEAS) { activos++; return; }
  await new Promise<void>((r) => cola.push(r)); // el cupo lo traspasa `liberar` sin bajar `activos`
}
function liberar(): void {
  const siguiente = cola.shift();
  if (siguiente) siguiente(); else activos--;
}

// ── Escalón 0 por regla ──────────────────────────────────────────────────────
const MAGIC_PDF = Buffer.from('%PDF-', 'latin1');
export const esPdf = (b: Buffer): boolean => b.length >= MAGIC_PDF.length && b.subarray(0, MAGIC_PDF.length).equals(MAGIC_PDF);
/** Conservador: `/Sig` también casa `/SigFlags`; un falso positivo solo deja el original. */
export const pareceFirmado = (b: Buffer): boolean => b.includes('/ByteRange', 0, 'latin1') || b.includes('/Sig', 0, 'latin1');
export const pareceCifrado = (b: Buffer): boolean => b.includes('/Encrypt', 0, 'latin1');

/** Segunda red: firma declarada en el catálogo (AcroForm con SigFlags, o /Perms). No usa `getForm()`: lo crearía. */
function firmaEnCatalogo(doc: PDFDocument): boolean {
  if (doc.catalog.has(PDFName.of('Perms'))) return true;
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  return acro instanceof PDFDict && acro.has(PDFName.of('SigFlags'));
}

export const tieneCapaDeTexto = (texto: string): boolean => texto.replace(/\s/g, '').length >= UMBRAL_TEXTO_CHARS;

// ── Presupuesto de tiempo ────────────────────────────────────────────────────
class TiempoExcedido extends Error {}
class Descartado extends Error {} // el candidato no pasa la autoverificación

interface Reloj { restante: () => number }

async function correr(deps: DepsCompresion, reloj: Reloj, cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const restante = reloj.restante();
  if (restante <= 0) throw new TiempoExcedido();
  let t: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new TiempoExcedido()), restante); });
  try {
    return await Promise.race([deps.ejecutar(cmd, args, input, restante), limite]);
  } catch (e) {
    if (/: timeout$/.test((e as Error).message)) throw new TiempoExcedido();
    throw e;
  } finally { clearTimeout(t); }
}

const pdftotext = async (deps: DepsCompresion, reloj: Reloj, buf: Buffer): Promise<string> =>
  (await correr(deps, reloj, 'pdftotext', ['-layout', '-', '-'], buf)).toString('utf8');

// ── Escalón 1: pdf-lib sin pérdida ───────────────────────────────────────────
async function escalonSinPerdida(doc: PDFDocument, paginas: number, textoOriginal: string, deps: DepsCompresion, reloj: Reloj): Promise<Buffer> {
  const out = Buffer.from(await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }));
  const recargado = await PDFDocument.load(out, { updateMetadata: false });
  if (recargado.getPageCount() !== paginas) throw new Descartado();
  if (await pdftotext(deps, reloj, out) !== textoOriginal) throw new Descartado();
  return out;
}

// ── Escalón 3: rasterizar (solo sin capa de texto) ───────────────────────────
async function rasterizar(original: Buffer, doc: PDFDocument, deps: DepsCompresion, reloj: Reloj): Promise<Buffer> {
  const paginas = doc.getPages();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), PREFIJO_TMP));
  try {
    await correr(deps, reloj, 'pdftoppm', ['-jpeg', '-jpegopt', 'quality=75', '-r', '150', '-f', '1', '-l', String(paginas.length), '-', path.join(dir, 'p')], original);
    const jpgs = (await fs.readdir(dir))
      .map((f) => ({ f, n: Number(/^p-(\d+)\.jpg$/.exec(f)?.[1] ?? NaN) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n);
    if (jpgs.length !== paginas.length) throw new Descartado();
    const nuevo = await PDFDocument.create();
    for (let i = 0; i < paginas.length; i++) {
      const pag = paginas[i]!;
      // pdftoppm renderiza la CropBox (que por defecto es la MediaBox) y ya aplica /Rotate.
      const { width, height } = pag.getCropBox();
      const girada = pag.getRotation().angle % 180 !== 0;
      const [w, h] = girada ? [height, width] : [width, height];
      const img = await nuevo.embedJpg(await fs.readFile(path.join(dir, jpgs[i]!.f)));
      nuevo.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    const out = Buffer.from(await nuevo.save({ useObjectStreams: true }));
    if ((await PDFDocument.load(out)).getPageCount() !== paginas.length) throw new Descartado();
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ladoExcedido = (doc: PDFDocument): boolean =>
  doc.getPages().some((p) => { const { width, height } = p.getSize(); return width > MAX_LADO_PT || height > MAX_LADO_PT; });

// ── Punto de entrada ─────────────────────────────────────────────────────────
/** Comprime un comprobante antes de guardarlo. NUNCA lanza (RN-C1). */
export async function comprimirComprobante(
  entrada: { buffer: Buffer; mimetype: string },
  depsParciales: Partial<DepsCompresion> = {},
): Promise<ResultadoCompresion> {
  const original = entrada.buffer;
  const bytesAntes = original.length;
  const tal = (motivo: MotivoCompresion): ResultadoCompresion => ({ buffer: original, escalon: 0, bytesAntes, bytesDespues: bytesAntes, motivo });

  const regla: MotivoCompresion | null = !esPdf(original) ? 'NO_PDF'
    : bytesAntes <= META_BYTES ? 'BAJO_META'
      : pareceFirmado(original) ? 'FIRMADO'
        : pareceCifrado(original) ? 'CIFRADO' : null;
  if (regla) { registrar(tal(regla), 0); return tal(regla); }

  const deps: DepsCompresion = { ...DEPS, ...depsParciales };
  await adquirir();
  const inicio = deps.ahora();
  let r: ResultadoCompresion;
  try {
    r = await comprimirPesado(original, deps, { restante: () => deps.tiempoLimiteMs - (deps.ahora() - inicio) }, tal);
  } catch (e) {
    r = tal(e instanceof TiempoExcedido ? 'TIEMPO' : 'ERROR');
  } finally { liberar(); }
  registrar(r, deps.ahora() - inicio);
  return r;
}

const MOTIVOS_DE_FALLO: ReadonlySet<MotivoCompresion> = new Set(['SIN_POPPLER', 'ERROR', 'TIEMPO', 'VERIFICACION', 'LIMITE_PAGINAS']);

/** Un log por archivo: solo cifras (RN-C7). Nunca el nombre del archivo ni el texto extraído. */
function registrar(r: ResultadoCompresion, ms: number): void {
  const campos = { escalon: r.escalon, motivo: r.motivo, bytesAntes: r.bytesAntes, bytesDespues: r.bytesDespues, ms };
  if (MOTIVOS_DE_FALLO.has(r.motivo)) log.warn(campos, 'compresión de comprobante: se guarda el original');
  else if (r.motivo === 'NO_PDF' || r.motivo === 'BAJO_META') log.debug(campos, 'compresión de comprobante: no aplica');
  else log.info(campos, 'compresión de comprobante');
}

async function comprimirPesado(
  original: Buffer, deps: DepsCompresion, reloj: Reloj, tal: (m: MotivoCompresion) => ResultadoCompresion,
): Promise<ResultadoCompresion> {
  const bytesAntes = original.length;
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(original, { updateMetadata: false }); }
  catch (e) { return tal(e instanceof EncryptedPDFError ? 'CIFRADO' : 'ERROR'); }
  if (firmaEnCatalogo(doc)) return tal('FIRMADO');
  const paginas = doc.getPageCount();
  if (paginas > MAX_PAGINAS) return tal('LIMITE_PAGINAS');

  let texto: string;
  try { texto = await pdftotext(deps, reloj, original); }
  catch (e) {
    if (e instanceof TiempoExcedido) throw e;
    return tal((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'SIN_POPPLER' : 'ERROR');
  }
  const conTexto = tieneCapaDeTexto(texto);

  const candidatos: Array<{ buffer: Buffer; escalon: Escalon }> = [];
  let descartes = 0;
  const probar = async (escalon: Escalon, fn: () => Promise<Buffer>): Promise<ResultadoCompresion | null> => {
    try {
      const buf = await fn();
      if (buf.length < bytesAntes) candidatos.push({ buffer: buf, escalon });
      if (buf.length <= META_BYTES && buf.length < bytesAntes) return { buffer: buf, escalon, bytesAntes, bytesDespues: buf.length, motivo: 'META_ALCANZADA' };
    } catch (e) {
      if (e instanceof TiempoExcedido) throw e;
      descartes++; // Descartado o fallo del escalón: se sigue con el siguiente
    }
    return null;
  };

  const r1 = await probar(1, () => escalonSinPerdida(doc, paginas, texto, deps, reloj));
  if (r1) return r1;
  if (!conTexto && !ladoExcedido(doc)) {
    const r3 = await probar(3, () => rasterizar(original, doc, deps, reloj));
    if (r3) return r3;
  }

  if (candidatos.length === 0) return tal(descartes > 0 ? 'VERIFICACION' : 'SIN_MEJORA');
  const mejor = candidatos.reduce((a, b) => (b.buffer.length < a.buffer.length ? b : a));
  return { buffer: mejor.buffer, escalon: mejor.escalon, bytesAntes, bytesDespues: mejor.buffer.length, motivo: 'MAS_LIVIANO' };
}
