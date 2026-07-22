// FLITO OCR — motor de extracción. REUSA el cliente Anthropic resiliente del grande
// (modules/tramites/anthropic.ts: timeout/retry/métricas/sin PII); NO abre un cliente nuevo
// (decisión D-OCR de la migración). Sustituye a packages/server/src/adaptadores/ocr/* del pequeño
// (pdftotext/pdftoppm/Tesseract + patrones.ts), que desaparecen. Ver docs §8.
//
// Contrato de salida: el shared-type CampoExtraido {valor, confianza(0..1), confiable}. El grande
// devuelve confianza CATEGÓRICA ('alta'|'media'|'baja'|null); aquí se mapea a numérica para
// preservar el contrato del pequeño y el umbral de RN-04/CA-06 sin tocar el tipo compartido.
// Con OCR_UMBRAL_DEFECTO=0.85 solo 'alta' resulta confiable; media/baja/null → cola de revisión.

import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { anthropicMessages } from '../tramites/anthropic.js';
import {
  CampoSoat, CampoImpuesto, CampoFacturaVenta,
  type CampoExtraido, type ExtraccionSoat, type ExtraccionImpuesto, type ExtraccionFacturaVenta,
} from '@operaciones/shared-types';
import {
  SISTEMA_OCR, PROMPT_FACTURA_SOAT, PROMPT_RECIBO_IMPUESTO, PROMPT_FACTURA_VENTA,
  type CampoCrudo, type ConfianzaCategorica,
} from './flito-ocr.prompts.js';

const log = loggerFor('flito-ocr');

/** El OCR (Anthropic) no está disponible: sin API key, timeout, o error del upstream. */
export class OcrNoDisponibleError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface DocumentoAAnalizar {
  nombreArchivo: string;
  contentType: string;
  contenido: Buffer;
  /** `confianza >= umbral` marca cada campo como confiable. Lo decide quien llama (§6), no el motor. */
  umbral: number;
}

// Categórica → numérica. Los cortes se eligen para que, con el umbral por defecto (0.85), solo
// 'alta' pase: es la traducción exacta de "alta→confiable, media/baja/null→revisión" (§8.2) sin
// cambiar el tipo compartido CampoExtraido.
const CONFIANZA_NUMERICA: Record<'alta' | 'media' | 'baja', number> = { alta: 0.95, media: 0.6, baja: 0.3 };

function aNumerica(c: ConfianzaCategorica): number {
  return c ? CONFIANZA_NUMERICA[c] : 0;
}

// ─────────────────────────── Normalización (portada de patrones.ts) ──────────

const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};

/** ISO (yyyy-mm-dd) desde los formatos que se ven en Colombia. Día primero (convención local). */
export function normalizarFecha(crudo: string): string | null {
  const texto = crudo.trim().toLowerCase();
  const iso = texto.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = texto.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const largo = texto.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})$/);
  if (largo && MESES[largo[2]]) return `${largo[3]}-${MESES[largo[2]]}-${largo[1].padStart(2, '0')}`;
  return null;
}

/**
 * Pesos colombianos a número entero (string). "1.234.567,89" → "1234567". Un separador final
 * seguido de 1-2 dígitos es la parte decimal y se descarta (SOAT/impuesto se cobran en pesos
 * enteros); los demás separadores son de miles, sin importar si son punto o coma.
 */
export function normalizarPesos(crudo: string): string | null {
  let limpio = String(crudo).replace(/[^\d.,]/g, '');
  if (!limpio) return null;
  const decimal = limpio.match(/[.,]\d{1,2}$/);
  if (decimal) limpio = limpio.slice(0, decimal.index);
  const numero = Number(limpio.replace(/[^\d]/g, ''));
  return Number.isFinite(numero) && numero > 0 ? String(numero) : null;
}

/**
 * Placa deducida del NOMBRE del archivo, respaldo del OCR (§8.4, memoria
 * facturas-nombradas-por-placa). El pequeño la usa para enrutar comprobantes en la carga masiva
 * cuando el OCR no logra leer la placa del contenido.
 */
export function placaDesdeNombre(nombre: string): string | null {
  const limpio = nombre.toUpperCase().replace(/\.[A-Z0-9]+$/, '');
  const m = limpio.match(/([A-Z]{3})[\s_-]?(\d{3}|\d{2}[A-Z])/);
  return m ? `${m[1]}${m[2]}` : null;
}

// ─────────────────────────── Parsing de la respuesta ─────────────────────────

function parseJSONLoose(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
    return null;
  }
}

function leerCampoCrudo(raw: unknown): CampoCrudo {
  if (!raw || typeof raw !== 'object') return { valor: null, confianza: null };
  const o = raw as { valor?: unknown; confianza?: unknown };
  const conf = typeof o.confianza === 'string' ? o.confianza.toLowerCase() : null;
  const confianza = (conf === 'alta' || conf === 'media' || conf === 'baja') ? conf : null;
  const valor = o.valor === null || o.valor === undefined || o.valor === '' ? null : String(o.valor);
  return { valor, confianza };
}

// ─────────────────────────── Llamada al modelo ───────────────────────────────

function bloqueDocumento(doc: DocumentoAAnalizar): Record<string, unknown> {
  const data = doc.contenido.toString('base64');
  const ct = doc.contentType.toLowerCase();
  if (ct.includes('pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  // Imagen (jpg/png/webp/gif). Media type acotado a lo que Anthropic acepta.
  const media = ct.includes('png') ? 'image/png'
    : ct.includes('webp') ? 'image/webp'
    : ct.includes('gif') ? 'image/gif'
    : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

/** Una pasada contra un modelo. Devuelve el mapa crudo campo→{valor,confianza} o null si no parseó. */
async function pasada(
  doc: DocumentoAAnalizar,
  modelo: string,
  prompt: string,
  systemExtra: string,
): Promise<Record<string, CampoCrudo> | null> {
  const payload = {
    model: modelo,
    max_tokens: 1500,
    system: SISTEMA_OCR + (systemExtra ? `\n\n${systemExtra}` : ''),
    messages: [{ role: 'user', content: [bloqueDocumento(doc), { type: 'text', text: prompt }] }],
  };

  const res = await anthropicMessages(payload, 'ocr');
  if (!res.ok) throw new OcrNoDisponibleError(res.status, res.message);

  const text = (res.data as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
  const parsed = parseJSONLoose(text);
  if (!parsed) { log.warn({ modelo }, 'OCR: respuesta no parseable como JSON'); return null; }

  const salida: Record<string, CampoCrudo> = {};
  for (const [k, v] of Object.entries(parsed)) salida[k] = leerCampoCrudo(v);
  return salida;
}

/**
 * Extrae los campos pedidos. Doble pasada como el pipeline del grande: primero Haiku (barato); si
 * algún campo de `camposEscalacion` no salió 'alta', reintenta con Sonnet y se queda, por campo, con
 * la lectura de mayor confianza. Así lo dudoso se verifica con el modelo más capaz antes de decidir
 * revisión, y lo nítido no gasta una segunda llamada.
 */
async function extraer(
  doc: DocumentoAAnalizar,
  prompt: string,
  campos: readonly string[],
  camposEscalacion: readonly string[],
  normalizadores: Record<string, (v: string) => string | null>,
): Promise<Record<string, CampoExtraido>> {
  const p1 = await pasada(doc, env.ANTHROPIC_MODEL_HAIKU, prompt, '');
  let crudo = p1 ?? {};

  const necesitaEscalar = camposEscalacion.some((c) => crudo[c]?.confianza !== 'alta');
  if (necesitaEscalar) {
    const extra = 'La lectura previa con un modelo rápido dejó campos dudosos. Verifica cada campo con máximo rigor citando la zona del documento que lo soporta. Si aun así no puedes leer un campo, valor=null y confianza=null.';
    try {
      const p2 = await pasada(doc, env.ANTHROPIC_MODEL_SONNET, prompt, extra);
      if (p2) crudo = fusionar(crudo, p2, campos);
    } catch (e) {
      // Sonnet caído no invalida la primera pasada: seguimos con Haiku (mejor que nada). Un fallo
      // total (ambas pasadas) ya habría lanzado en la primera.
      log.warn({ err: (e as Error).message }, 'OCR: segunda pasada (Sonnet) falló; se usa Haiku');
    }
  }

  const salida: Record<string, CampoExtraido> = {};
  for (const campo of campos) {
    salida[campo] = aCampoExtraido(crudo[campo] ?? { valor: null, confianza: null }, doc.umbral, normalizadores[campo]);
  }
  return salida;
}

/** Por campo, gana la pasada con mayor confianza (desempate: la segunda, más capaz). */
function fusionar(a: Record<string, CampoCrudo>, b: Record<string, CampoCrudo>, campos: readonly string[]): Record<string, CampoCrudo> {
  const out: Record<string, CampoCrudo> = {};
  for (const c of campos) {
    const ca = a[c] ?? { valor: null, confianza: null };
    const cb = b[c] ?? { valor: null, confianza: null };
    out[c] = aNumerica(cb.confianza) >= aNumerica(ca.confianza) ? cb : ca;
  }
  return out;
}

function aCampoExtraido(crudo: CampoCrudo, umbral: number, normalizar?: (v: string) => string | null): CampoExtraido {
  const valor = crudo.valor !== null && normalizar ? normalizar(crudo.valor) : crudo.valor;
  // Si la normalización descarta el valor (p.ej. un "valor" que no era un número), no puede ser
  // confiable aunque el modelo dijera 'alta': no hay dato que dar por bueno.
  const confianza = valor === null ? 0 : aNumerica(crudo.confianza);
  return { valor, confianza, confiable: confianza >= umbral };
}

// ─────────────────────────── Normalizadores por campo ────────────────────────

const placaN = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
const vinN = (v: string) => v.toUpperCase().replace(/\s/g, '') || null; // exacto salvo espacios
const textoExactoN = (v: string) => v.trim().toUpperCase() || null;     // póliza/factura/recibo: NO se tocan separadores
const trimN = (v: string) => v.trim() || null;
const anioN = (v: string) => { const m = v.match(/(?:19|20)\d{2}/); return m ? m[0] : null; };

// ─────────────────────────── Extractores públicos ────────────────────────────

/** Factura/póliza de SOAT. Vigencia y expedición se extraen pero NO se exigen (D-7). */
export async function extraerFacturaSoat(doc: DocumentoAAnalizar): Promise<ExtraccionSoat> {
  const campos = [
    CampoSoat.PLACA, CampoSoat.VIN, CampoSoat.NUMERO_POLIZA, CampoSoat.VALOR_TOTAL,
    CampoSoat.ASEGURADORA, CampoSoat.FECHA_EXPEDICION, CampoSoat.VIGENCIA_DESDE, CampoSoat.VIGENCIA_HASTA,
  ] as const;
  // Escalar si la llave o algún campo requerido para pagar (§ CAMPOS_REQUERIDOS) queda dudoso.
  const escalacion = [CampoSoat.PLACA, CampoSoat.VIN, CampoSoat.NUMERO_POLIZA, CampoSoat.VALOR_TOTAL, CampoSoat.ASEGURADORA];
  const r = await extraer(doc, PROMPT_FACTURA_SOAT, campos, escalacion, {
    [CampoSoat.PLACA]: placaN, [CampoSoat.VIN]: vinN, [CampoSoat.NUMERO_POLIZA]: textoExactoN,
    [CampoSoat.VALOR_TOTAL]: normalizarPesos, [CampoSoat.ASEGURADORA]: trimN,
    [CampoSoat.FECHA_EXPEDICION]: normalizarFecha, [CampoSoat.VIGENCIA_DESDE]: normalizarFecha,
    [CampoSoat.VIGENCIA_HASTA]: normalizarFecha,
  });
  return r as ExtraccionSoat;
}

/** Recibo de impuesto. Solo valorTotal bloquea el avance a pagado (§8.3). */
export async function extraerReciboImpuesto(doc: DocumentoAAnalizar): Promise<ExtraccionImpuesto> {
  const campos = [
    CampoImpuesto.PLACA, CampoImpuesto.VALOR_TOTAL, CampoImpuesto.NUMERO_RECIBO,
    CampoImpuesto.FECHA_PAGO, CampoImpuesto.ANIO_GRAVABLE,
  ] as const;
  const escalacion = [CampoImpuesto.PLACA, CampoImpuesto.VALOR_TOTAL];
  const r = await extraer(doc, PROMPT_RECIBO_IMPUESTO, campos, escalacion, {
    [CampoImpuesto.PLACA]: placaN, [CampoImpuesto.VALOR_TOTAL]: normalizarPesos,
    [CampoImpuesto.NUMERO_RECIBO]: textoExactoN, [CampoImpuesto.FECHA_PAGO]: normalizarFecha,
    [CampoImpuesto.ANIO_GRAVABLE]: anioN,
  });
  return r as ExtraccionImpuesto;
}

// Integración FLIT (Fase 8): la factura de venta viene de FLIT (no se analiza con OCR). El extractor
// `extraerFacturaVenta` se retiró; SOAT y recibo de impuesto mantienen su OCR.
