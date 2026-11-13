// Apertura de PDFs cifrados con contraseña de apertura (Bug #14569).
//
// Un comprobante SOAT protegido con contraseña se aceptaba en silencio: el OCR local no lo lee, se
// archivaba y el SOAT se quedaba en Solicitado. Este helper detecta el cifrado ANTES del OCR y, si
// el usuario dio la clave, devuelve el PDF descifrado para que el resto del flujo (hash de
// duplicado, archivo guardado, OCR) trabaje sobre él. El original cifrado nunca sale de aquí.
//
// Por qué `qpdf` (binario externo, como poppler en el OCR local): pdf-lib no descifra, y qpdf es la
// herramienta de referencia para AES-256/RC4. Falla CERRADO: si qpdf no está o tarda, se lanza
// `QpdfNoDisponibleError` y el llamador no guarda nada (decisión del humano en el Bug).
//
// La clave es PII (suele ser la cédula o el NIT del titular): nunca va en los argumentos del
// proceso (visibles en `ps`), ni en un `message`, ni en el logger, ni en el stderr registrado. Se
// entrega por stdin (`--password-file=-`) y solo se registra el código de salida.

import { execFile, type ExecFileException } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggerFor } from '../logger.js';

const log = loggerFor('pdf-cifrado');

const TIMEOUT_MS = 30_000;
/** qpdf habla poco por stdout/stderr; el tope evita que un PDF malicioso llene la memoria con avisos. */
const MAX_BUFFER = 1024 * 1024;
const MAX_CONTRASENA = 128;

export class PdfContrasenaIncorrectaError extends Error {
  constructor() { super('La contraseña no abre este PDF.'); }
}

export class QpdfNoDisponibleError extends Error {
  constructor(motivo: string) { super(`No se pudo abrir el PDF protegido (${motivo}).`); }
}

export type AperturaPdf = { estado: 'abierto'; buffer: Buffer } | { estado: 'requiere-contrasena' };

/** Barato y sin proceso externo: solo un PDF con diccionario `/Encrypt` puede estar cifrado. */
function podriaEstarCifrado(buf: Buffer): boolean {
  return buf.subarray(0, 4).toString('latin1') === '%PDF' && buf.includes('/Encrypt', 0, 'latin1');
}

const contrasenaValida = (c: string): boolean =>
  c.length >= 1 && c.length <= MAX_CONTRASENA && !/[\r\n]/.test(c);

/**
 * Corre qpdf y resuelve con su código de salida. Rechaza con `QpdfNoDisponibleError` si el binario
 * no existe (ENOENT), si lo mata el timeout o si no hay código numérico. El stderr NO se registra:
 * qpdf podría repetir parte de la entrada.
 */
function correrQpdf(args: string[], stdin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const hijo = execFile('qpdf', args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (err) => {
      if (!err) { resolve(0); return; }
      const e = err as ExecFileException;
      if (e.killed || e.signal) { reject(new QpdfNoDisponibleError('timeout')); return; }
      if (typeof e.code === 'number') { resolve(e.code); return; }
      reject(new QpdfNoDisponibleError(e.code === 'ENOENT' ? 'qpdf no instalado' : 'qpdf no respondió'));
    });
    // Un EPIPE (qpdf salió antes de leer stdin) no debe tumbar el proceso; el exit code ya lo dice.
    hijo.stdin?.on('error', () => undefined);
    hijo.stdin?.end(stdin ?? '');
  });
}

/**
 * Abre un PDF. Sin cifrado de apertura devuelve el MISMO buffer (el dedup por hash depende de que
 * un archivo idéntico siga siendo idéntico). Cifrado y sin clave → `requiere-contrasena`. Con clave
 * → el PDF descifrado, o `PdfContrasenaIncorrectaError` si la clave no lo abre.
 */
export async function abrirPdf(buf: Buffer, contrasena?: string): Promise<AperturaPdf> {
  if (!podriaEstarCifrado(buf)) return { estado: 'abierto', buffer: buf };

  const dir = await mkdtemp(join(tmpdir(), 'flito-pdf-'));
  try {
    const entrada = join(dir, 'in.pdf');
    await writeFile(entrada, buf, { mode: 0o600 });

    // 0 = pide contraseña de apertura; 2 = no cifrado; 3 = cifrado solo con permisos (se abre igual).
    const requiere = await correrQpdf(['--requires-password', entrada]);
    if (requiere === 2 || requiere === 3) return { estado: 'abierto', buffer: buf };
    if (requiere !== 0) {
      log.warn({ exitCode: requiere }, 'qpdf --requires-password devolvió un código inesperado');
      throw new QpdfNoDisponibleError(`código ${requiere}`);
    }
    if (contrasena === undefined || contrasena === '') return { estado: 'requiere-contrasena' };
    if (!contrasenaValida(contrasena)) throw new PdfContrasenaIncorrectaError();

    const salida = join(dir, 'out.pdf');
    // 0 = descifrado; 3 = descifrado con avisos; 2 = error (clave incorrecta).
    const codigo = await correrQpdf(['--password-file=-', '--decrypt', entrada, salida], contrasena);
    if (codigo === 0 || codigo === 3) return { estado: 'abierto', buffer: await readFile(salida) };
    if (codigo === 2) throw new PdfContrasenaIncorrectaError();
    log.warn({ exitCode: codigo }, 'qpdf --decrypt devolvió un código inesperado');
    throw new QpdfNoDisponibleError(`código ${codigo}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
