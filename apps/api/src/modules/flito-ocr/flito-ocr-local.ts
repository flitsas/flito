// FLITO OCR — FALLBACK LOCAL (sin Anthropic). Reconstruye el enfoque pre-migración: pdftotext/pdftoppm
// (poppler) + Tesseract + patrones. Se usa cuando no hay ANTHROPIC_API_KEY (ver extraer() en el service).
//
// Capas, de la más fiable a la de respaldo:
//   1) PDF con capa de texto → `pdftotext -layout` (NO es OCR: lee el texto embebido → exacto).
//   2) PDF escaneado (sin texto) → `pdftoppm` a PNG → Tesseract (mejor esfuerzo).
//   3) Imagen (jpg/png/…) → Tesseract directo.
// Luego, patrones adaptados al FORMATO FUAST del SOAT (los valores están en columnas, VARIAS filas bajo
// su encabezado; las 3 fechas del bloque superior salen en orden expedición/desde/hasta). La salida es
// CampoCrudo {valor, confianza}; el service normaliza y aplica el umbral igual que al LLM. Conservador:
// el cruce placa/VIN contra el trámite sigue siendo autoritativo → una lectura dudosa va a revisión.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'tesseract.js'; // solo tipo (se borra en compilación): no exige el módulo al arrancar
import { loggerFor } from '../../shared/logger.js';
import type { CampoCrudo, ConfianzaCategorica } from './flito-ocr.prompts.js';

const log = loggerFor('flito-ocr-local');
const LANG_DIR = fileURLToPath(new URL('../../../vendor/tesseract/', import.meta.url)); // eng.traineddata.gz

// ── Ejecutar un binario de poppler (stdin opcional, stdout capturado) ─────────
function ejecutar(cmd: string, args: string[], input?: Buffer, timeoutMs = 25000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out: Buffer[] = []; const err: Buffer[] = [];
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd}: timeout`)); }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d as Buffer));
    p.stderr.on('data', (d) => err.push(d as Buffer));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exit ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    if (input) { p.stdin.on('error', () => { /* EPIPE si el proceso cerró */ }); p.stdin.write(input); p.stdin.end(); }
  });
}

// ── Tesseract (Node), worker singleton perezoso ──────────────────────────────
let workerP: Promise<Worker> | null = null;
async function getWorker(): Promise<Worker> {
  if (!workerP) {
    // Import DINÁMICO: `tesseract.js` solo se carga si el fallback local se ejecuta de verdad (sin
    // ANTHROPIC_API_KEY + OCR_LOCAL=1). Así el servidor arranca aunque el paquete no esté instalado
    // en el deploy (p. ej. cuando se usa el OCR de Anthropic y no hace falta el fallback).
    workerP = import('tesseract.js')
      .then(({ createWorker }) => createWorker('eng', 1, { langPath: LANG_DIR, cachePath: os.tmpdir(), gzip: true }))
      .catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}
async function ocrImagen(buf: Buffer): Promise<string> {
  const w = await getWorker();
  const { data } = await w.recognize(buf);
  return data.text || '';
}

// ── PDF → texto ──────────────────────────────────────────────────────────────
async function pdfATexto(buf: Buffer): Promise<string> {
  try { return (await ejecutar('pdftotext', ['-layout', '-', '-'], buf)).toString('utf8'); }
  catch (e) { log.warn({ err: (e as Error).message }, 'pdftotext falló'); return ''; }
}

async function pdfEscaneadoAImagen(buf: Buffer): Promise<Buffer | null> {
  // pdftoppm escribe a un archivo con prefijo (no a stdout en esta versión): usamos uno temporal.
  const base = path.join(os.tmpdir(), `flitocr-${randomUUID()}`);
  try {
    await ejecutar('pdftoppm', ['-png', '-singlefile', '-r', '200', '-f', '1', '-l', '1', '-', base], buf);
    return await fs.readFile(`${base}.png`);
  } catch (e) { log.warn({ err: (e as Error).message }, 'pdftoppm/rasterización falló'); return null; }
  finally { await fs.rm(`${base}.png`, { force: true }).catch(() => {}); }
}

/** Texto del documento por capas: pdftotext → (escaneado) pdftoppm+Tesseract → (imagen) Tesseract. */
export async function textoDocumento(doc: { contentType: string; contenido: Buffer }): Promise<string> {
  const ct = doc.contentType.toLowerCase();
  if (ct.includes('pdf')) {
    const texto = await pdfATexto(doc.contenido);
    if (texto.replace(/\s/g, '').length >= 40) return texto; // tiene capa de texto → exacto
    const png = await pdfEscaneadoAImagen(doc.contenido);     // escaneado → rasterizar + OCR
    return png ? await ocrImagen(png) : texto;
  }
  return ocrImagen(doc.contenido); // imagen directa
}

// ── Patrones (formato FUAST del SOAT: valores en columnas, filas bajo el encabezado) ──

const RE_PLACA = /\b[A-Z]{3}[ -]?\d{2}[A-Z0-9]\b/;                 // ABC123 / ABC12D
const RE_VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/;                          // 17, sin I/O/Q
const RE_POLIZA = /\b\d{12,}\b/;                                   // n.º de póliza: número largo (≥12)
const RE_ID = /(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,}/;            // recibo/factura: ≥4 chars con un dígito
const RE_MONTO = /\$?\s*(?:\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{4,})/;
const RE_FECHA = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\b/; // ISO, dd/mm/yyyy y dd.mm.yyyy
const RE_FECHA_G = new RegExp(RE_FECHA.source, 'g');
const RE_ANIO = /\b(?:19|20)\d{2}\b/;
const ASEGURADORAS = [
  'LA PREVISORA', 'SEGUROS DEL ESTADO', 'AXA COLPATRIA', 'SEGUROS BOLIVAR', 'LA EQUIDAD',
  'MUNDIAL DE SEGUROS', 'SURA', 'MAPFRE', 'ALLIANZ', 'SOLIDARIA', 'PREVISORA', 'BOLIVAR',
  'COLPATRIA', 'EQUIDAD', 'MUNDIAL', 'ESTADO', 'HDI', 'SBS', 'LIBERTY', 'ZURICH',
];

interface Ctx { lineas: string[]; plano: string; fechas: string[] }

/** Texto → líneas normalizadas (mayúsculas, sin tildes, sin líneas vacías) + plano + fechas en orden. */
function preparar(texto: string): Ctx {
  const sinTildes = texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const lineas = sinTildes.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim().toUpperCase()).filter(Boolean);
  const plano = lineas.join('\n');
  const fechas = plano.match(RE_FECHA_G) ?? []; // FUAST: bloque superior = [expedición, desde, hasta]
  return { lineas, plano, fechas };
}

/** Primer `patron` en la ventana [i .. i+max] tras la `etiqueta` (el valor está filas abajo, en columna). */
function ventana(lineas: string[], etiqueta: RegExp, patron: RegExp, max = 5): string | null {
  for (let i = 0; i < lineas.length; i++) {
    const m = etiqueta.exec(lineas[i]);
    if (!m) continue;
    for (let j = i; j <= Math.min(lineas.length - 1, i + max); j++) {
      const texto = j === i ? lineas[i].slice(m.index + m[0].length) : lineas[j];
      const v = texto.match(patron);
      if (v) return v[0];
    }
  }
  return null;
}

/** Match si `patron` aparece con UN solo valor distinto en todo el texto (p. ej. el VIN, repetido igual). */
function unico(plano: string, patron: RegExp): string | null {
  const set = new Set(plano.match(new RegExp(patron.source, 'g')) ?? []);
  return set.size === 1 ? [...set][0] : null;
}

const crudo = (valor: string | null, confianza: ConfianzaCategorica): CampoCrudo => ({ valor, confianza });

function extraerCampo(campo: string, c: Ctx): CampoCrudo {
  const { lineas, plano, fechas } = c;
  switch (campo) {
    case 'placa': {
      const anc = ventana(lineas, /PLACA/, RE_PLACA, 4);
      if (anc) return crudo(anc, 'alta');
      const u = unico(plano, RE_PLACA);
      return crudo(u, u ? 'media' : null);
    }
    case 'vin': {
      const v = ventana(lineas, /\b(VIN|CHASIS|CHASI|SERIE|MOTOR)\b/, RE_VIN, 4) ?? unico(plano, RE_VIN);
      return crudo(v, v ? 'alta' : null);
    }
    case 'numeroPoliza':
      return crudo(ventana(lineas, /P[O0]LIZA/, RE_POLIZA, 4) ?? unico(plano, RE_POLIZA), 'alta');
    case 'numeroRecibo':
      // Impuesto (declaración sugerida): el n.º de FORMULARIO identifica la liquidación.
      return crudo(ventana(lineas, /(RECIBO|COMPROBANTE|REFERENCIA DE PAGO|FORMULARIO|N\.? DE PAGO)/, RE_ID, 4), 'alta');
    case 'numeroFactura':
      return crudo(ventana(lineas, /(FACTURA|N\.? DE FACTURA)/, RE_ID, 4), 'alta');
    case 'valorTotal':
      // SOAT: "TOTAL A PAGAR" (NO "PRIMA", que es un parcial). El monto va unas filas abajo (2 columnas).
      return crudo(ventana(lineas, /(TOTAL A PAGAR|VALOR A PAGAR|VALOR PAGADO|TOTAL PAGADO|VALOR TOTAL)/, RE_MONTO, 4), 'alta');
    case 'valorVehiculo':
      return crudo(ventana(lineas, /(VALOR (DEL )?VEHICULO|VALOR COMERCIAL|VALOR VENTA|BASE GRAVABLE)/, RE_MONTO, 4), 'alta');
    case 'aseguradora': {
      const hit = ASEGURADORAS.find((a) => plano.includes(a));
      return crudo(hit ?? null, hit ? 'alta' : null);
    }
    // FUAST: el bloque superior izquierdo trae las 3 fechas en orden.
    case 'fechaExpedicion': return crudo(fechas[0] ?? null, fechas.length >= 1 ? 'alta' : null);
    case 'vigenciaDesde':   return crudo(fechas[1] ?? null, fechas.length >= 2 ? 'alta' : null);
    case 'vigenciaHasta':   return crudo(fechas[2] ?? null, fechas.length >= 3 ? 'alta' : null);
    case 'fechaPago':
      return crudo(ventana(lineas, /(FECHA DE PAGO|FECHA PAGO|FECHA LIMITE PAGO|PAGADO EL)/, RE_FECHA, 3) ?? fechas[0] ?? null, 'alta');
    case 'fechaFactura':
      return crudo(ventana(lineas, /(FECHA (DE )?FACTURA|FECHA DE VENTA)/, RE_FECHA, 3), 'alta');
    case 'anioGravable':
      return crudo(ventana(lineas, /(A[NÑ]O GRAVABLE|VIGENCIA FISCAL|GRAVABLE|FRACCION A[NÑ]O)/, RE_ANIO, 3), 'alta');
    default:
      return crudo(null, null);
  }
}

/** Extrae los `campos` pedidos del texto del documento (CampoCrudo por campo). Función pura y testeable. */
export function camposDesdeTexto(texto: string, campos: readonly string[]): Record<string, CampoCrudo> {
  const ctx = preparar(texto);
  const out: Record<string, CampoCrudo> = {};
  for (const c of campos) out[c] = extraerCampo(c, ctx);
  return out;
}
