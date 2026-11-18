// Bug #14569 — shared/pdf/pdf-cifrado.ts: detección y descifrado de un PDF con contraseña de
// apertura vía qpdf. Primero con `execFile` simulado (códigos de salida, timeout, ENOENT, que la
// clave nunca vaya en los argumentos ni en el mensaje, borrado del temporal); luego con qpdf real
// contra el fixture cifrado con «clave-prueba» (se salta si la máquina no tiene qpdf).

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({ execFileMock: null as unknown as ReturnType<typeof vi.fn> }));

vi.mock('node:child_process', async (orig) => {
  const real = await orig() as typeof import('node:child_process');
  h.execFileMock = vi.fn((...a: unknown[]) => (real.execFile as (...x: unknown[]) => unknown)(...a));
  return { ...real, execFile: h.execFileMock };
});

const { abrirPdf, clavesDesdeNombre, PdfContrasenaIncorrectaError, QpdfNoDisponibleError } = await import('../../src/shared/pdf/pdf-cifrado.js');

const CIFRADO = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << /Encrypt 5 0 R >>\n%%EOF');
const CLAVE = '1032456789'; // como una cédula: lo que NO debe filtrarse

type Resultado = { code?: number | string | null; killed?: boolean; signal?: string } | null;
interface Llamada { args: string[]; stdin: string | undefined }

/** Programa respuestas en orden: `null` = exit 0; `{ code: n }` = exit n; etc. Las llamadas se
 * registran al ocurrir: leer el arreglo devuelto DESPUÉS del `await`. */
function simular(...resultados: Resultado[]): Llamada[] {
  const llamadas: Llamada[] = [];
  for (const r of resultados) {
    h.execFileMock.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, cb: (e: unknown) => void) => {
      const llamada: Llamada = { args, stdin: undefined };
      llamadas.push(llamada);
      setImmediate(() => cb(r === null ? null : Object.assign(new Error('qpdf falló'), r)));
      return { stdin: { on: vi.fn(), end: vi.fn((s?: string) => { llamada.stdin = s; }) } };
    });
  }
  return llamadas;
}

/** El temporal es el directorio del archivo de entrada (primer path que no es flag). */
const dirDe = (l: Llamada) => dirname(l.args.find((a) => !a.startsWith('--'))!);

beforeEach(() => { h.execFileMock.mockClear(); });

describe('abrirPdf — con qpdf simulado', () => {
  it('sin /Encrypt no llama a qpdf y devuelve el mismo buffer', async () => {
    const buf = Buffer.from('%PDF-1.7\nsin cifrado\n%%EOF');
    const r = await abrirPdf(buf, CLAVE);
    expect(r).toEqual({ estado: 'abierto', buffer: buf });
    expect(h.execFileMock).not.toHaveBeenCalled();
  });

  it('bytes que no son PDF (imagen) no llaman a qpdf aunque contengan /Encrypt', async () => {
    const buf = Buffer.from('\x89PNG /Encrypt');
    expect((await abrirPdf(buf)).estado).toBe('abierto');
    expect(h.execFileMock).not.toHaveBeenCalled();
  });

  it.each([2, 3])('exit %i en --requires-password → abierto con el buffer original', async (code) => {
    const ll = simular({ code });
    const r = await abrirPdf(CIFRADO);
    expect(r).toEqual({ estado: 'abierto', buffer: CIFRADO });
    expect(ll[0].args[0]).toBe('--requires-password');
    expect(h.execFileMock).toHaveBeenCalledTimes(1);
  });

  it('exit 0 sin contraseña → requiere-contrasena (no intenta descifrar)', async () => {
    simular(null);
    expect(await abrirPdf(CIFRADO)).toEqual({ estado: 'requiere-contrasena' });
    expect(h.execFileMock).toHaveBeenCalledTimes(1);
  });

  it('exit 2 al descifrar → PdfContrasenaIncorrectaError, sin la clave en el mensaje', async () => {
    simular(null, { code: 2 });
    const e = await abrirPdf(CIFRADO, CLAVE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PdfContrasenaIncorrectaError);
    expect((e as Error).message).not.toContain(CLAVE);
  });

  it('la clave llega por stdin y NO aparece en los argumentos', async () => {
    const ll = simular(null, { code: 2 });
    await abrirPdf(CIFRADO, CLAVE).catch(() => undefined);
    const desc = ll[1];
    expect(desc.args).toContain('--password-file=-');
    expect(desc.args).toContain('--decrypt');
    expect(desc.args).toContain('--deterministic-id');
    expect(desc.args.join(' ')).not.toContain(CLAVE);
    expect(desc.stdin).toBe(CLAVE);
    const opts = h.execFileMock.mock.calls[1][2] as { timeout: number; shell?: unknown };
    expect(opts.timeout).toBe(30_000);
    expect(opts.shell).toBeUndefined();
  });

  it('ENOENT (qpdf no instalado) → QpdfNoDisponibleError', async () => {
    simular({ code: 'ENOENT' });
    await expect(abrirPdf(CIFRADO, CLAVE)).rejects.toBeInstanceOf(QpdfNoDisponibleError);
  });

  it('timeout (proceso matado) → QpdfNoDisponibleError, sin la clave en el mensaje', async () => {
    simular(null, { code: null, killed: true, signal: 'SIGTERM' });
    const e = await abrirPdf(CIFRADO, CLAVE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(QpdfNoDisponibleError);
    expect((e as Error).message).not.toContain(CLAVE);
  });

  it('exit inesperado en --requires-password → QpdfNoDisponibleError', async () => {
    simular({ code: 1 });
    await expect(abrirPdf(CIFRADO)).rejects.toBeInstanceOf(QpdfNoDisponibleError);
  });

  it('clave con salto de línea o de más de 128 → incorrecta sin llamar a --decrypt', async () => {
    simular(null);
    await expect(abrirPdf(CIFRADO, 'a\nb')).rejects.toBeInstanceOf(PdfContrasenaIncorrectaError);
    simular(null);
    await expect(abrirPdf(CIFRADO, 'x'.repeat(129))).rejects.toBeInstanceOf(PdfContrasenaIncorrectaError);
    expect(h.execFileMock).toHaveBeenCalledTimes(2);
  });

  it('el temporal se borra también cuando hay error', async () => {
    const ll = simular(null, { code: 2 });
    await abrirPdf(CIFRADO, CLAVE).catch(() => undefined);
    expect(existsSync(dirDe(ll[0]))).toBe(false);
  });

  it('el temporal se borra también con requiere-contrasena', async () => {
    const ll = simular(null);
    await abrirPdf(CIFRADO);
    expect(existsSync(dirDe(ll[0]))).toBe(false);
  });
});

// ─────────────────────────── qpdf real ───────────────────────────────────────

const hayQpdf = (() => { try { execFileSync('qpdf', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/soat/factura-cifrada.pdf');

describe.skipIf(!hayQpdf)('abrirPdf — qpdf real contra el fixture (clave «clave-prueba»)', () => {
  const cifrado = readFileSync(FIXTURE);

  it('sin clave → requiere-contrasena', async () => {
    expect(await abrirPdf(cifrado)).toEqual({ estado: 'requiere-contrasena' });
  });

  it('clave incorrecta → PdfContrasenaIncorrectaError', async () => {
    await expect(abrirPdf(cifrado, 'otra-clave')).rejects.toBeInstanceOf(PdfContrasenaIncorrectaError);
  });

  it('clave correcta → PDF descifrado, sin /Encrypt y que ya no pide clave', async () => {
    const r = await abrirPdf(cifrado, 'clave-prueba');
    expect(r.estado).toBe('abierto');
    if (r.estado !== 'abierto') return;
    expect(r.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(r.buffer.equals(cifrado)).toBe(false);
    expect(r.buffer.includes('/Encrypt')).toBe(false);
    expect(await abrirPdf(r.buffer)).toEqual({ estado: 'abierto', buffer: r.buffer });
  });

  it('descifrar dos veces el mismo PDF da los mismos bytes (mismo sha256 → el duplicado se detecta)', async () => {
    const a = await abrirPdf(cifrado, 'clave-prueba');
    const b = await abrirPdf(cifrado, 'clave-prueba');
    if (a.estado !== 'abierto' || b.estado !== 'abierto') throw new Error('no se abrió el fixture');
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    expect(sha(a.buffer)).toBe(sha(b.buffer));
    expect(a.buffer.equals(b.buffer)).toBe(true);
  });
});

// ─────────────────── nombre del archivo como contraseña (punto 10) ───────────

describe('clavesDesdeNombre — candidatos derivados del nombre (Bug #14569, punto 10)', () => {
  it('orden (a) tal cual sin .pdf, (b) con trim, (c) MAYÚSCULAS sin espacios ni guiones', () => {
    expect(clavesDesdeNombre('abc-123 .PDF')).toEqual(['abc-123 ', 'abc-123', 'ABC123']);
  });

  it('deduplica: un nombre ya limpio y en mayúsculas da un solo candidato', () => {
    expect(clavesDesdeNombre('ABC123.pdf')).toEqual(['ABC123']);
    expect(clavesDesdeNombre('abc123.pdf')).toEqual(['abc123', 'ABC123']);
  });

  it('la extensión se quita sin importar mayúsculas y solo la final', () => {
    expect(clavesDesdeNombre('X.Pdf')).toEqual(['X']);
    expect(clavesDesdeNombre('a.pdf.pdf')).toEqual(['a.pdf', 'A.PDF']);
    expect(clavesDesdeNombre('placa.png')).toEqual(['placa.png', 'PLACA.PNG']);
  });

  it('excluye vacíos, >128 caracteres y saltos de línea', () => {
    expect(clavesDesdeNombre('.pdf')).toEqual([]);
    expect(clavesDesdeNombre('  - .pdf')).toEqual(['  - ', '-']); // la variante (c) queda vacía
    expect(clavesDesdeNombre('   .pdf')).toEqual(['   ']); // trim y (c) vacías
    expect(clavesDesdeNombre(`${'a'.repeat(129)}.pdf`)).toEqual([]);
    expect(clavesDesdeNombre(`${'a'.repeat(128)}.pdf`)).toEqual(['a'.repeat(128), 'A'.repeat(128)]);
    expect(clavesDesdeNombre('ab\ncd.pdf')).toEqual([]);
    expect(clavesDesdeNombre('ab\rcd.pdf')).toEqual([]);
  });
});

describe('abrirPdf con candidatos — qpdf simulado', () => {
  it('UN solo --requires-password; prueba TODOS en orden por stdin y, si ninguno abre, requiere-contrasena (no incorrecta)', async () => {
    const ll = simular({ code: 0 }, { code: 2 }, { code: 2 }, { code: 2 });
    expect(await abrirPdf(CIFRADO, undefined, ['uno', 'DOS', 'tres', 'cuatro'])).toEqual({ estado: 'requiere-contrasena' });
    expect(ll.map((l) => l.args[0])).toEqual(['--requires-password', '--password-file=-', '--password-file=-', '--password-file=-']);
    expect(ll.slice(1).map((l) => l.stdin)).toEqual(['uno', 'DOS', 'tres']); // tope de 3 aunque lleguen más
    expect(ll.flatMap((l) => l.args).some((a) => ['uno', 'DOS', 'tres'].includes(a))).toBe(false);
  });

  it('la clave escrita manda: con contraseña no se prueban los candidatos', async () => {
    const ll = simular({ code: 0 }, { code: 2 });
    await expect(abrirPdf(CIFRADO, CLAVE, ['ABC123'])).rejects.toBeInstanceOf(PdfContrasenaIncorrectaError);
    expect(ll.map((l) => l.stdin).filter(Boolean)).toEqual([CLAVE]);
  });
});

describe.skipIf(!hayQpdf)('abrirPdf — qpdf real: PDF cifrado con clave = su nombre (punto 10)', () => {
  let dir = '';
  let cifradoNombre: Buffer = Buffer.alloc(0);
  beforeAll(() => {
    // Fixture derivado: el de «clave-prueba» descifrado y vuelto a cifrar con «ABC123».
    dir = mkdtempSync(join(tmpdir(), 'pdf-nombre-'));
    const plano = join(dir, 'plano.pdf');
    const salida = join(dir, 'ABC123.pdf');
    execFileSync('qpdf', ['--password=clave-prueba', '--decrypt', FIXTURE, plano]);
    execFileSync('qpdf', ['--encrypt', 'ABC123', 'ABC123', '256', '--', plano, salida]);
    cifradoNombre = readFileSync(salida);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sin candidatos pide clave; con los del nombre «abc-123 .PDF» se abre (gana la 3.ª variante)', async () => {
    expect(await abrirPdf(cifradoNombre)).toEqual({ estado: 'requiere-contrasena' });
    h.execFileMock.mockClear();
    const r = await abrirPdf(cifradoNombre, undefined, clavesDesdeNombre('abc-123 .PDF'));
    expect(r.estado).toBe('abierto');
    if (r.estado !== 'abierto') return;
    expect(r.buffer.includes('/Encrypt')).toBe(false);
    expect(h.execFileMock).toHaveBeenCalledTimes(4); // 1 --requires-password + 3 intentos
  });

  it('un nombre que no es la clave → requiere-contrasena', async () => {
    expect(await abrirPdf(cifradoNombre, undefined, clavesDesdeNombre('OTRO999.pdf'))).toEqual({ estado: 'requiere-contrasena' });
  });
});
