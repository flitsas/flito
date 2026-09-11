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
  CampoSoat, CampoImpuesto, CampoFacturaVenta, CampoDerechoTramite,
  CAMPOS_COMPRADOR_FACTURA, TIPOS_DOCUMENTO_RUNT,
  type CampoExtraido, type ExtraccionSoat, type ExtraccionImpuesto, type ExtraccionFacturaVenta,
  type ExtraccionDerechoTramite,
} from '@operaciones/shared-types';
import {
  SISTEMA_OCR, PROMPT_FACTURA_SOAT, PROMPT_RECIBO_IMPUESTO, PROMPT_FACTURA_VENTA, PROMPT_DERECHO_TRAMITE,
  type CampoCrudo, type ConfianzaCategorica,
} from './flito-ocr.prompts.js';
import { textoDocumento, camposDesdeTexto } from './flito-ocr-local.js';

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
  const iso = texto.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = texto.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
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
  // FALLBACK LOCAL (sin Anthropic): pdftotext/Tesseract + patrones (reconstruye el OCR pre-migración).
  // Se activa cuando no hay API key; desactivable con OCR_LOCAL=0. Solo la LECTURA es local; el cruce
  // placa/VIN, el umbral y el veredicto siguen siendo la lógica real de quien llama.
  if (!env.ANTHROPIC_API_KEY && process.env.OCR_LOCAL === '1') {
    const texto = await textoDocumento(doc);
    const crudoLocal = camposDesdeTexto(texto, campos);
    const salidaLocal: Record<string, CampoExtraido> = {};
    for (const campo of campos) {
      salidaLocal[campo] = aCampoExtraido(crudoLocal[campo] ?? { valor: null, confianza: null }, doc.umbral, normalizadores[campo]);
    }
    log.info({ campos: campos.length, chars: texto.length }, 'OCR local (fallback sin Anthropic)');
    return salidaLocal;
  }

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

// ── Normalizadores del COMPRADOR de la factura de venta (HU #12092, AC5) ─────────────────────────
//
// **Lo que no cabe en su columna destino se descarta, no se trunca.** Es el mismo mecanismo que ya
// usa `normalizarPesos`: `aCampoExtraido` convierte un `null` de la normalización en
// `confianza: 0, confiable: false`, así que el campo llega al formulario vacío en vez de llegar con
// un valor recortado que `altaSchema` rechazaría después con un 400 sobre algo que el usuario nunca
// escribió. Un nombre cortado por la mitad es peor que un nombre ausente: parece correcto.

/** Descarta lo que no quepa en la columna a la que este valor va a acabar yendo. */
const cota = (max: number) => (v: string | null): string | null => (v !== null && v.length > max ? null : v);

/**
 * Texto libre del titular: se conserva tal como está escrito, solo sin espacios de borde.
 *
 * `trimN` y NO `textoExactoN`: este valor no se persiste directamente, se PRELLENA en un formulario
 * que una persona lee y corrige. Forzar mayúsculas convertiría «Juana Pérez» en «JUANA PÉREZ» y
 * obligaría a reescribirlo; el `numeroPoliza` sí se sube a mayúsculas porque es un identificador.
 */
const textoTitularN = (max: number) => (v: string) => cota(max)(trimN(v));

/**
 * Documento del comprador: sin puntos, comas ni espacios, en mayúsculas (AC5).
 *
 * **Conserva letras y el guion.** El AC nombra puntos y comas; quitar el guion borraría el dígito de
 * verificación de un NIT («900.123.456-7» → «9001234567» pierde el 7) y quitar las letras rompería un
 * pasaporte o una cédula de extranjería. Destino: `flito_compradores.numero_documento`, varchar(30).
 */
const numeroDocumentoN = (v: string) => cota(30)(v.toUpperCase().replace(/[.,\s]/g, '').trim() || null);

/** Celular: SOLO dígitos (AC5). Destino `flito_compradores.celular`, varchar(30). */
const celularN = (v: string) => cota(30)(v.replace(/\D/g, '') || null);

/**
 * Tipo de documento: uno de `TIPOS_DOCUMENTO_RUNT` o `null`, **nunca un valor inventado** (AC5).
 *
 * Se cruza contra la MISMA constante que valida el alta del canal (`documentoSchema`): si el modelo
 * devuelve «CEDULA» o «NIT.», el campo llega vacío y la persona lo elige, en vez de llegar con un
 * valor que el `z.enum` del alta rechazaría con un 400 sobre un desplegable que se rellenó solo.
 */
const tipoDocumentoN = (v: string): string | null => {
  const limpio = v.trim().toUpperCase().replace(/[^A-Z]/g, '');
  return (TIPOS_DOCUMENTO_RUNT as readonly string[]).includes(limpio) ? limpio : null;
};

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

/**
 * Recibo / cuenta de cobro de DERECHO DE TRÁMITE (HU #10950). Solo `valorTotal` bloquea el registro
 * (la placa se valida aparte: es la llave de cruce). Radicado, organismo y tipo se extraen pero no
 * se exigen — varían mucho entre organismos y su ausencia no impide saber cuánto se pagó.
 *
 * `promptHint` es la pista opcional del organismo (`flito_ocr_prompt_hint`): así un formato rebelde
 * se resuelve con una línea de configuración en vez de con un extractor propio.
 */
export async function extraerDerechoTramite(
  doc: DocumentoAAnalizar,
  promptHint?: string | null,
): Promise<ExtraccionDerechoTramite> {
  const campos = [
    CampoDerechoTramite.PLACA, CampoDerechoTramite.VALOR_TOTAL, CampoDerechoTramite.FECHA_PAGO,
    CampoDerechoTramite.NUMERO_RADICADO, CampoDerechoTramite.ORGANISMO, CampoDerechoTramite.TIPO_TRAMITE,
  ] as const;
  const escalacion = [CampoDerechoTramite.PLACA, CampoDerechoTramite.VALOR_TOTAL];
  const hint = promptHint?.trim();
  const prompt = hint
    ? `${PROMPT_DERECHO_TRAMITE}\n\nPISTA ESPECÍFICA DE ESTE ORGANISMO (tiene prioridad sobre las indicaciones genéricas de arriba): ${hint}`
    : PROMPT_DERECHO_TRAMITE;
  const r = await extraer(doc, prompt, campos, escalacion, {
    [CampoDerechoTramite.PLACA]: placaN,
    [CampoDerechoTramite.VALOR_TOTAL]: normalizarPesos,
    [CampoDerechoTramite.FECHA_PAGO]: normalizarFecha,
    [CampoDerechoTramite.NUMERO_RADICADO]: textoExactoN,
    [CampoDerechoTramite.ORGANISMO]: textoExactoN,
    [CampoDerechoTramite.TIPO_TRAMITE]: textoExactoN,
  });
  return r as ExtraccionDerechoTramite;
}

/**
 * Factura de VENTA del vehículo: los cinco campos documentales de siempre MÁS los nueve del
 * COMPRADOR (HU #12092, Feature #12073).
 *
 * ── Un solo llamador, y decirlo es parte del contrato ────────────────────────────────────────────
 *
 * Lo usa **el canal Cliente** (`leerFacturaVenta` en `flito-soat-cliente.service.ts`) y nadie más:
 * es una lectura que PRELLENA un formulario, no persiste nada y no decide nada. El flujo de
 * impuestos/FLIT sigue sin analizar la factura con OCR (ver la nota del final del archivo).
 *
 * ── Escalación a Sonnet: los cinco campos que acaban siendo el TITULAR LEGAL ─────────────────────
 *
 * `numeroDocumento`, `tipoDocumento`, `nombres`, `apellidos` y `razonSocial` van a la escalación
 * junto a la llave del vehículo y al valor. No es por importancia abstracta: son los que deciden a
 * nombre de quién queda la solicitud, y son justo donde el error caro de esta plantilla —confundir
 * al comprador con el concesionario emisor— produce un valor plausible y equivocado. Con catorce
 * campos la segunda pasada se disparará casi siempre; es UNA llamada más en un endpoint que el rate
 * limit del canal acota a 20 por ventana, y es lo que compra el «no inventar» del AC3.
 *
 * `direccion`, `municipio`, `departamento` y `celular` NO escalan: son datos de contacto que la
 * persona ve y corrige en el formulario, y un error ahí no cambia de quién es el vehículo.
 */
export async function extraerFacturaVenta(doc: DocumentoAAnalizar): Promise<ExtraccionFacturaVenta> {
  const campos = [
    CampoFacturaVenta.PLACA, CampoFacturaVenta.VIN, CampoFacturaVenta.NUMERO_FACTURA,
    CampoFacturaVenta.FECHA_FACTURA, CampoFacturaVenta.VALOR_VEHICULO,
    ...CAMPOS_COMPRADOR_FACTURA,
  ] as const;
  const escalacion = [
    CampoFacturaVenta.PLACA, CampoFacturaVenta.VIN, CampoFacturaVenta.VALOR_VEHICULO,
    CampoFacturaVenta.NUMERO_DOCUMENTO, CampoFacturaVenta.TIPO_DOCUMENTO,
    CampoFacturaVenta.NOMBRES, CampoFacturaVenta.APELLIDOS, CampoFacturaVenta.RAZON_SOCIAL,
  ];
  const r = await extraer(doc, PROMPT_FACTURA_VENTA, campos, escalacion, {
    [CampoFacturaVenta.PLACA]: placaN,
    [CampoFacturaVenta.VIN]: vinN,
    [CampoFacturaVenta.NUMERO_FACTURA]: textoExactoN,
    [CampoFacturaVenta.FECHA_FACTURA]: normalizarFecha,
    [CampoFacturaVenta.VALOR_VEHICULO]: normalizarPesos,
    // Las cotas son las de las columnas de `flito_compradores` a las que el alta del canal manda
    // cada valor, y las mismas que declara `titularCampos` en la ruta del canal.
    [CampoFacturaVenta.NOMBRES]: textoTitularN(200),
    [CampoFacturaVenta.APELLIDOS]: textoTitularN(200),
    [CampoFacturaVenta.RAZON_SOCIAL]: textoTitularN(200),
    [CampoFacturaVenta.TIPO_DOCUMENTO]: tipoDocumentoN,
    [CampoFacturaVenta.NUMERO_DOCUMENTO]: numeroDocumentoN,
    [CampoFacturaVenta.DIRECCION]: textoTitularN(300),
    [CampoFacturaVenta.MUNICIPIO]: textoTitularN(100),
    [CampoFacturaVenta.DEPARTAMENTO]: textoTitularN(100),
    [CampoFacturaVenta.CELULAR]: celularN,
  });
  return r as ExtraccionFacturaVenta;
}

// Integración FLIT (Fase 8): en el flujo de IMPUESTOS/FLIT la factura de venta viene de FLIT y no se
// analiza con OCR — ahí el extractor de arriba no se llama y esa decisión sigue en pie. Lo que la HU
// #12092 reinstaura es su uso en el canal Cliente, donde la factura la adjunta el propio cliente y es
// la única fuente documental del comprador. SOAT y recibo de impuesto mantienen su OCR de siempre.
