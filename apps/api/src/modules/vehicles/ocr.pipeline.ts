import https from 'https';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('vehicles-ocr-pipeline');

// Pipeline OCR multi-capa para formulario "DECLARACION DEL IMPUESTO SOBRE VEHICULOS
// AUTOMOTORES" de la Gobernación de Antioquia (FO-M8-P6-008).
//
// Capas:
//  1. Rotación automática (pdf-lib detecta /Rotate + aspect ratio)
//  2. Extracción con Haiku + schema de confianza por campo
//  3. Validación matemática de totales (cuadre aritmético)
//  4. Segunda pasada con Sonnet si confianza baja o matemática falla
//  5. Sanitización anti-alucinación (cédulas secuenciales, nombres placeholder)

// FLOTA-03: modelos configurables por entorno (default = valor histórico).
// INC-OCR-2026-05-12: el snapshot sonnet 20250929 fue deprecated por Anthropic
// (404 not_found_error) y rompió la segunda pasada silenciosamente; con env vars
// se puede migrar sin redeploy.
const HAIKU_MODEL = env.ANTHROPIC_MODEL_HAIKU;
const SONNET_MODEL = env.ANTHROPIC_MODEL_SONNET;

// Enum cerrado de tipos de error de Anthropic API. Si el upstream introduce un
// tipo nuevo, lo degradamos a 'unknown_error' (defensa logging).
const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error',
  'request_too_large', 'billing_error',
]);

function sanitizeAnthropicError(err: { type?: unknown; message?: unknown }): { type: string; message: string } {
  const t = typeof err?.type === 'string' && ANTHROPIC_ERROR_TYPES.has(err.type) ? err.type : 'unknown_error';
  // Truncar mensaje + redactar cédulas (6-12 dígitos) y emails antes de log.
  // En errores 'invalid_request_error' o 'request_too_large' el message puede
  // citar fragmentos del prompt que incluyen PII del PDF (cédula propietario,
  // placa, email contacto). BELK requirement.
  let m = typeof err?.message === 'string' ? err.message : 'Anthropic error';
  m = m.replace(/\b\d{6,12}\b/g, '[REDACTED-DOC]').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[REDACTED-EMAIL]');
  if (m.length > 200) m = `${m.slice(0, 200)}...`;
  return { type: t, message: m };
}

// Patrones de alucinación conocidos — valores "genéricos" que el modelo inventa
const HALLUCINATION_PATTERNS = {
  documents: [
    /^123456789\d?$/,        // 1234567890, 123456789
    /^(\d)\1{5,}$/,          // 111111, 000000, 999999
    /^12345\d?$/,            // 12345, 123456
    /^0+[1-9]?$/,            // 000001, 00000
  ],
  names: [
    /^JUAN (CARLOS |PABLO |JOSE )?(GOMEZ|PEREZ|RODRIGUEZ|GARCIA)$/i,
    /^MARIA (JOSE |ISABEL )?(GOMEZ|PEREZ|RODRIGUEZ|GARCIA)$/i,
    /^(PROPIETARIO|TITULAR|NOMBRE) /i,
    /^[A-Z]+ (EJEMPLO|PRUEBA|TEST)$/i,
  ],
  placas: [
    /^ABC\d{3}$/i,           // ABC123, ABC456 (ejemplos típicos)
    /^[A-Z]{3}000$/i,        // AAA000
    /^XXX\d{3}$/i,
  ],
};

export interface ConfidenceField<T = string> {
  valor: T | null;
  confianza: 'alta' | 'media' | 'baja' | null;
}

export type DocumentType = 'individual' | 'listado_concesionario' | 'unknown';

export interface OcrVehicleExtraction {
  placa: ConfidenceField;
  marca: ConfidenceField;
  linea: ConfidenceField;
  modelo: ConfidenceField<number>;
  clase: ConfidenceField;
  propietarioNombre: ConfidenceField;
  propietarioDocumento: ConfidenceField;
  tipoDocumento: ConfidenceField;
  celular: ConfidenceField;
  email: ConfidenceField;
  // Renglones de liquidación (campo oficial y número de renglón)
  r1_avaluoComercial: ConfidenceField<number>;
  r2_impuesto: ConfidenceField<number>;
  r5_totalCargo: ConfidenceField<number>;       // sección E — total después de sanciones y descuentos
  r11_totalPagar: ConfidenceField<number>;      // sección F — TOTAL FINAL A PAGAR (concepto 13)
  formularioNo: ConfidenceField;
  // Metadatos de calidad
  _documentType: DocumentType;
  _confidence_avg: number;      // 0-100
  _math_check: 'ok' | 'mismatch' | 'skipped';
  _warnings: string[];
  _model: string;
  _page_rotated?: boolean;
  // Observabilidad de la segunda pasada (PR (B) INC-OCR-2026-05-12):
  // permite distinguir páginas donde la segunda capa NO se intentó vs. se
  // intentó y falló silenciosamente. El catch sigue devolviendo el resultado
  // de Haiku, pero el cliente puede mostrar "solo verificación principal".
  _sonnet_attempted?: boolean;
  _sonnet_errored?: boolean;
  _sonnet_error_type?: string;
}

// ---- PROMPT ANTI-ALUCINACIÓN ----

const EXTRACTION_SYSTEM = `Eres un extractor OCR profesional del formulario oficial "DECLARACION DEL IMPUESTO SOBRE VEHICULOS AUTOMOTORES" (código FO-M8-P6-008) de la Gobernación de Antioquia, Colombia.

REGLAS ABSOLUTAS:
1. SOLO extrae lo que veas LITERALMENTE en la imagen. Usa ÚNICAMENTE información visible en el documento, NO tu conocimiento general.
2. Si un campo está rotado, borroso, cortado, tapado por sellos/firmas, o no es visible: responde valor=null y confianza=null. NUNCA inventes.
3. Decir "null" NO es un error. Inventar SÍ lo es.
4. PROHIBIDO usar nombres genéricos tipo "JUAN CARLOS GOMEZ", "MARIA PEREZ" si no están LITERALMENTE escritos.
5. PROHIBIDO usar cédulas secuenciales tipo 1234567890, 123456789, 111111, 000000.
6. PROHIBIDO usar placas ejemplo tipo ABC123, AAA000.
7. Si dudas entre dos lecturas (ej: "O" vs "0", "S" vs "5"), elige la que respete el formato del campo; si no puedes decidir, marca confianza="baja".`;

const EXTRACTION_PROMPT = `Extrae los datos del formulario Antioquia según el mapeo EXACTO de renglones.

**PASO 0 — CLASIFICACIÓN DEL DOCUMENTO (CRÍTICO):**
Antes de extraer cualquier campo, identifica el tipo de documento:

- "individual": formulario oficial "DECLARACION SUGERIDA DE IMPUESTO SOBRE VEHICULOS AUTOMOTORES" con secciones A,B,C,D,E,F y datos de UN SOLO vehículo.
- "listado_concesionario": tabla/listado con columnas tipo "CONCESIONARIO | FECHA | PLACA | VALOR", múltiples filas de pagos, encabezado "TOTAL PAGOS" o similar. NO es un formulario individual.
- "unknown": cualquier otra cosa (recibo, certificado, página en blanco, otro tipo de documento).

Si _documentType ≠ "individual", responde TODOS los demás campos con valor=null y confianza=null. NO inventes datos.

**Sección C — DATOS DEL DECLARANTE:**
- propietarioNombre: C1 NOMBRE O RAZON SOCIAL + C3 APELLIDOS (concatenados con espacio)
- propietarioDocumento: NÚMERO de documento del declarante (solo dígitos)
- tipoDocumento: CC | NIT | CE | TI | Otro (el marcado con X)
- celular: C7 CELULAR
- email: C9 E-MAIL

**Sección D — DATOS DEL VEHÍCULO:**
- placa: D1 PLACA (formato: 3 letras + 3 dígitos, ej. QTQ100)
- marca: D2 MARCA (ej. TESLA, CHEVROLET)
- linea: D3 LINEA (ej. MODEL Y, SPARK)
- modelo: D4 MODELO (año de 4 dígitos entre 1970 y 2027, lee CADA dígito)
- clase: D5 CLASE (AUTOMOVIL, CAMIONETA, CAMPERO, MOTOCICLETA, etc.)

**Sección E — DECLARACION (subtotales, renglones numerados):**
- r1_avaluoComercial: renglón 1 AVALUO COMERCIAL DEL VEHICULO (entero sin puntos)
- r2_impuesto: renglón 2 IMPUESTO SOBRE VEHICULOS AUTOMOTORES (entero sin puntos)
- r5_totalCargo: renglón "TOTAL A CARGO" en la sección E (entero sin puntos). Este es un SUBTOTAL — NO es el total a pagar final.

**Sección F — PAGO (¡el que importa!):**
- r11_totalPagar: el renglón "TOTAL A PAGAR" en la sección F. Es el VALOR FINAL DEFINITIVO que el contribuyente debe pagar al banco.

**CÓMO ENCONTRARLO** (instrucciones visuales precisas):
1. Busca el ÚLTIMO valor numérico del formulario, en la esquina inferior derecha del bloque "F. PAGO".
2. Está en una casilla con FONDO de color destacado (verde claro, celeste o resaltado) — distinta de las demás casillas que son blancas.
3. Justo a su izquierda dice literalmente "TOTAL A PAGAR" (el último renglón numerado de la sección F, generalmente renglón 11 o 13).
4. Por encima de él hay otros renglones: INTERESES POR MORA, PAGOS ANTERIORES, SALDO A FAVOR, SALDO A PAGAR, SERVICIO. Ese es el orden típico.
5. El TOTAL A PAGAR suele ser MAYOR que TOTAL A CARGO (incluye intereses + servicio) — diferencia común: $25,000 a $200,000.

**ERROR FRECUENTE A EVITAR**: en la sección F a veces aparece TAMBIÉN el TOTAL A CARGO (replicado de la sección E como referencia). NO lo confundas con TOTAL A PAGAR. El TOTAL A PAGAR es el ÚLTIMO valor, después de sumar intereses/servicio.

**REGLA DE DESEMPATE (CRÍTICA — el modelo confunde estos dos):**
Si ves DOS valores grandes en el formulario, uno etiquetado "TOTAL A CARGO" (en sección E, después de sumas de impuesto+sanciones-descuentos) y otro etiquetado "TOTAL A PAGAR" (en sección F, después del bloque "PAGO" con intereses), NUNCA los confundas:
- r5_totalCargo = el de la sección E (subtotal de la declaración)
- r11_totalPagar = el de la sección F (TOTAL FINAL — este es el que debe pagar el ciudadano)

Si solo hay UN valor visible y NO puedes distinguir si corresponde a sección E o F: marca solo r11_totalPagar con confianza="baja", deja r5_totalCargo en valor=null,confianza=null. NUNCA dupliques el valor en ambos campos.

**MANEJO DEL SELLO "PROCESADO" / "PAGADO":**
Es común que un sello rojo (PROCESADO, PAGADO, RECIBIDO) cubra parte de la sección F. Si el sello tapa el valor numérico:
1. Busca el mismo valor en las casillas pequeñas de la derecha (replican los totales).
2. Si no es legible en ninguna parte, marca confianza="baja" pero NO inventes.
3. Si está parcialmente visible (puedes ver algunos dígitos), reporta lo que veas con confianza="baja".

**Formulario No** (encabezado): formularioNo

REGLAS DE FORMATO:
- Placa: 3 letras mayúsculas + 3 números. Validar.
- Modelo: número entero 1970-2027.
- Valores monetarios (r1, r2, r5, r11): enteros sin puntos ni comas ni símbolos $.
- Documento: solo dígitos, 6-12 caracteres.

SCHEMA DE RESPUESTA (JSON, sin markdown):
{
  "_documentType": "individual" | "listado_concesionario" | "unknown",
  "placa": {"valor": ..., "confianza": ...},
  "marca": {...},
  ... (todos los campos)
  "r5_totalCargo": {"valor": ..., "confianza": ...},
  "r11_totalPagar": {"valor": ..., "confianza": ...}
}

Confianza:
- "alta": texto nítido, sin duda
- "media": legible con algo de esfuerzo, alguna ambigüedad
- "baja": parcialmente visible (sello, borrón) — sospecho el valor pero no puedo verificar
- null: ilegible, rotado, tapado completamente → valor también null

VALIDACIÓN CRÍTICA antes de responder:
- ¿_documentType es correcto? (si es listado o desconocido, demás campos en null)
- ¿La placa tiene formato (3 letras + 3 dígitos)?
- ¿El modelo está entre 1970 y 2027?
- ¿r11_totalPagar es REALMENTE el TOTAL A PAGAR de la sección F (no el TOTAL A CARGO de la sección E)?
- ¿Si r5_totalCargo y r11_totalPagar están ambos extraídos, son DIFERENTES o iguales? Si son iguales y no hay intereses visibles, está bien; si son iguales pero hay intereses, hay error.

Responde SOLO el JSON. Nada más.`;

// ---- LLAMADAS A ANTHROPIC ----

function callAnthropic(model: string, content: any[], systemPrompt: string, maxTokens = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    });
    const rq = https.request({
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (r2) => {
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    rq.setTimeout(120000, () => rq.destroy(new Error('Anthropic timeout')));
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}

// ---- ROTACIÓN AUTOMÁTICA ----

export async function ensurePageUpright(srcDoc: any, pageIndex: number): Promise<{ bytes: Uint8Array; rotated: boolean }> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const singleDoc = await PDFDocument.create();
  const [copied] = await singleDoc.copyPages(srcDoc, [pageIndex]);
  singleDoc.addPage(copied);

  const page = singleDoc.getPage(0);
  const rotation = page.getRotation().angle;
  let rotated = false;

  // Si la página tiene rotación declarada ≠ 0, la normalizamos a 0
  if (rotation !== 0) {
    page.setRotation(degrees(0));
    rotated = true;
  }

  const bytes = await singleDoc.save();
  return { bytes, rotated };
}

// ---- PARSING + NORMALIZACIÓN ----

function parseJSONLoose(text: string): any | null {
  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch {
    // Intentar extraer el primer bloque JSON válido
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

function normalizeField<T>(raw: any, coerce?: (v: any) => T | null): ConfidenceField<T> {
  if (!raw || typeof raw !== 'object') return { valor: null, confianza: null };
  const { valor, confianza } = raw;
  const confLower = typeof confianza === 'string' ? confianza.toLowerCase() : null;
  const validConf = ['alta', 'media', 'baja'].includes(confLower as string) ? confLower : null;
  const normalized = coerce ? (valor === null || valor === undefined ? null : coerce(valor)) : (valor === null || valor === '' ? null : valor);
  return { valor: normalized as T | null, confianza: validConf as any };
}

const toInt = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const normalizeDocType = (v: any): DocumentType => {
  if (v === 'individual' || v === 'listado_concesionario' || v === 'unknown') return v;
  return 'unknown';
};

// ---- DETECCIÓN DE ALUCINACIÓN ----

function detectHallucinations(data: OcrVehicleExtraction): string[] {
  const warnings: string[] = [];

  const doc = data.propietarioDocumento?.valor;
  if (doc && HALLUCINATION_PATTERNS.documents.some((r) => r.test(String(doc)))) {
    warnings.push(`Documento sospechoso (patrón secuencial): ${doc}`);
  }

  const name = data.propietarioNombre?.valor;
  if (name && HALLUCINATION_PATTERNS.names.some((r) => r.test(String(name)))) {
    warnings.push(`Nombre sospechoso (genérico): ${name}`);
  }

  const placa = data.placa?.valor;
  if (placa && HALLUCINATION_PATTERNS.placas.some((r) => r.test(String(placa)))) {
    warnings.push(`Placa sospechosa (ejemplo): ${placa}`);
  }

  // Validación de formato
  if (placa && !/^[A-Z]{3}\d{3}$/i.test(String(placa))) {
    warnings.push(`Placa con formato inválido: ${placa}`);
  }

  const modelo = data.modelo?.valor;
  if (modelo && (modelo < 1970 || modelo > 2027)) {
    warnings.push(`Modelo fuera de rango (1970-2027): ${modelo}`);
  }

  if (doc && !/^\d{6,12}$/.test(String(doc))) {
    warnings.push(`Documento con formato inválido: ${doc}`);
  }

  return warnings;
}

// ---- VALIDACIÓN MATEMÁTICA ----

function validateMath(data: OcrVehicleExtraction): 'ok' | 'mismatch' | 'skipped' {
  const r2 = data.r2_impuesto?.valor;
  const r5 = data.r5_totalCargo?.valor;
  const r11 = data.r11_totalPagar?.valor;

  if (r11 === null || r2 === null) return 'skipped';

  // Heurística clave: cuando el modelo se confunde y extrae el TOTAL A CARGO en r11_totalPagar,
  // suele copiar el MISMO número en ambos campos r5 y r11. Si r5 === r11 (o difieren <0.5%) y el
  // valor es significativo, lo marcamos como mismatch para forzar segunda pasada con Sonnet.
  // Caso típico: formularios con sello PROCESADO donde el modelo no logra leer el TOTAL A PAGAR.
  if (r5 !== null && r5 > 100_000 && r11 > 100_000) {
    const diff = Math.abs(r11 - r5);
    if (diff <= r5 * 0.005) {
      // r5 ≈ r11 — sospechoso. Excepción: si r2 ≈ r5 también (sin sanciones ni intereses,
      // todo el flujo es lineal), el caso es legítimo y NO marcamos.
      const r2NearR5 = Math.abs(r5 - r2) <= r2 * 0.05;
      if (!r2NearR5) return 'mismatch';
    }
  }

  // r11 (TOTAL A PAGAR sección F) suele ser >= r5 (TOTAL A CARGO sección E) porque
  // suma intereses por mora. Permitimos r11 < r5 hasta un 50% (saldo a favor en cuenta).
  if (r5 !== null && r5 > 0 && r11 < r5 * 0.5) {
    return 'mismatch';
  }

  // Sanity: r11 contra impuesto base. Vehículos con mora multianual pueden tener intereses
  // grandes, pero >10x el impuesto es señal de error de OCR (probablemente leyó otro número).
  if (r2 > 0 && (r11 < r2 * 0.3 || r11 > r2 * 10)) {
    return 'mismatch';
  }

  return 'ok';
}

// ---- CÁLCULO DE CONFIANZA PROMEDIO ----

function computeAvgConfidence(data: Omit<OcrVehicleExtraction, '_confidence_avg' | '_math_check' | '_warnings' | '_model'>): number {
  const CRITICAL_FIELDS: (keyof typeof data)[] = [
    'placa', 'propietarioNombre', 'propietarioDocumento', 'r2_impuesto', 'r11_totalPagar',
  ];
  const WEIGHT = { alta: 100, media: 65, baja: 30 };
  let sum = 0;
  let count = 0;
  for (const k of CRITICAL_FIELDS) {
    const f = data[k] as ConfidenceField;
    if (f && f.confianza) {
      sum += WEIGHT[f.confianza];
      count++;
    } else if (f && f.valor === null) {
      sum += 0;
      count++;
    }
  }
  return count > 0 ? Math.round(sum / count) : 0;
}

// ---- EXTRACCIÓN CON UN MODELO ----

async function extractWithModel(
  pdfBytes: Uint8Array,
  model: string,
  systemExtra = ''
): Promise<{ data: any; rawText: string } | null> {
  const b64 = Buffer.from(pdfBytes).toString('base64');
  const systemPrompt = EXTRACTION_SYSTEM + (systemExtra ? `\n\n${systemExtra}` : '');

  const r = await callAnthropic(model, [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
    { type: 'text', text: EXTRACTION_PROMPT },
  ], systemPrompt);

  if (r?.error) {
    const safe = sanitizeAnthropicError(r.error);
    const err = new Error(`${safe.type}: ${safe.message}`) as Error & { anthropicType?: string };
    err.anthropicType = safe.type;
    throw err;
  }
  const text = r?.content?.[0]?.text || '';
  const parsed = parseJSONLoose(text);
  return parsed ? { data: parsed, rawText: text } : null;
}

// ---- PIPELINE COMPLETO ----

export async function extractSinglePage(
  srcDoc: any,
  pageIndex: number,
): Promise<OcrVehicleExtraction | null> {
  const { bytes, rotated } = await ensurePageUpright(srcDoc, pageIndex);

  // Pasada 1: Haiku
  const firstPass = await extractWithModel(bytes, HAIKU_MODEL);
  if (!firstPass?.data) return null;

  const normalized: OcrVehicleExtraction = {
    placa: normalizeField(firstPass.data.placa, (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '')),
    marca: normalizeField(firstPass.data.marca),
    linea: normalizeField(firstPass.data.linea),
    modelo: normalizeField(firstPass.data.modelo, toInt),
    clase: normalizeField(firstPass.data.clase),
    propietarioNombre: normalizeField(firstPass.data.propietarioNombre, (v) => String(v).trim()),
    propietarioDocumento: normalizeField(firstPass.data.propietarioDocumento, (v) => String(v).replace(/[^\d]/g, '')),
    tipoDocumento: normalizeField(firstPass.data.tipoDocumento),
    celular: normalizeField(firstPass.data.celular, (v) => String(v).replace(/[^\d]/g, '')),
    email: normalizeField(firstPass.data.email),
    r1_avaluoComercial: normalizeField(firstPass.data.r1_avaluoComercial, toInt),
    r2_impuesto: normalizeField(firstPass.data.r2_impuesto, toInt),
    r5_totalCargo: normalizeField(firstPass.data.r5_totalCargo, toInt),
    r11_totalPagar: normalizeField(firstPass.data.r11_totalPagar, toInt),
    formularioNo: normalizeField(firstPass.data.formularioNo),
    _documentType: normalizeDocType(firstPass.data._documentType),
    _confidence_avg: 0,
    _math_check: 'skipped',
    _warnings: [],
    _model: HAIKU_MODEL,
    _page_rotated: rotated,
  };

  // Si NO es un formulario individual, no tiene sentido validar ni hacer segunda pasada.
  if (normalized._documentType !== 'individual') {
    normalized._warnings = [`Documento no es formulario de impuesto (tipo: ${normalized._documentType}). Use otra herramienta para listados de concesionario.`];
    return normalized;
  }

  normalized._confidence_avg = computeAvgConfidence(normalized);
  normalized._math_check = validateMath(normalized);
  normalized._warnings = detectHallucinations(normalized);

  const needsSecondPass =
    normalized._confidence_avg < 65 ||
    normalized._math_check === 'mismatch' ||
    normalized._warnings.length > 0;

  if (!needsSecondPass) return normalized;

  // Marca intento ANTES de llamar al modelo. Si el catch se dispara, este flag
  // queda true y el cliente sabe que la verificación se intentó (vs. casos
  // donde no se intentó porque la primera pasada fue confiable).
  normalized._sonnet_attempted = true;

  // Pasada 2: Sonnet (modelo más capaz) — solo si la primera tuvo dudas
  const extra = `La pasada previa con Haiku dio confianza ${normalized._confidence_avg}%. Razones de revisión: ${[
    normalized._math_check === 'mismatch' ? 'validación matemática falló' : null,
    ...normalized._warnings,
  ].filter(Boolean).join(' | ') || 'baja confianza global'}. Verifica cada campo con máximo rigor. CITA la zona del documento que soporta cada valor. Si sigues sin poder leer un campo, valor=null.`;

  try {
    const secondPass = await extractWithModel(bytes, SONNET_MODEL, extra);
    if (secondPass?.data) {
      const sonnetResult: OcrVehicleExtraction = {
        placa: normalizeField(secondPass.data.placa, (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '')),
        marca: normalizeField(secondPass.data.marca),
        linea: normalizeField(secondPass.data.linea),
        modelo: normalizeField(secondPass.data.modelo, toInt),
        clase: normalizeField(secondPass.data.clase),
        propietarioNombre: normalizeField(secondPass.data.propietarioNombre, (v) => String(v).trim()),
        propietarioDocumento: normalizeField(secondPass.data.propietarioDocumento, (v) => String(v).replace(/[^\d]/g, '')),
        tipoDocumento: normalizeField(secondPass.data.tipoDocumento),
        celular: normalizeField(secondPass.data.celular, (v) => String(v).replace(/[^\d]/g, '')),
        email: normalizeField(secondPass.data.email),
        r1_avaluoComercial: normalizeField(secondPass.data.r1_avaluoComercial, toInt),
        r2_impuesto: normalizeField(secondPass.data.r2_impuesto, toInt),
        r5_totalCargo: normalizeField(secondPass.data.r5_totalCargo, toInt),
        r11_totalPagar: normalizeField(secondPass.data.r11_totalPagar, toInt),
        formularioNo: normalizeField(secondPass.data.formularioNo),
        _documentType: normalizeDocType(secondPass.data._documentType),
        _confidence_avg: 0,
        _math_check: 'skipped',
        _warnings: [],
        _model: SONNET_MODEL,
        _page_rotated: rotated,
        _sonnet_attempted: true,
      };
      sonnetResult._confidence_avg = computeAvgConfidence(sonnetResult);
      sonnetResult._math_check = validateMath(sonnetResult);
      sonnetResult._warnings = detectHallucinations(sonnetResult);
      return sonnetResult;
    }
  } catch (e: any) {
    // PR (B) INC-OCR-2026-05-12: catch ya NO es silencioso. Marca observabilidad
    // y deja un warning visible para el cliente. Retorna resultado de Haiku
    // (mejor que nada) pero el frontend puede mostrar "solo capa principal".
    normalized._sonnet_errored = true;
    normalized._sonnet_error_type = typeof e?.anthropicType === 'string' ? e.anthropicType : 'unknown';
    normalized._warnings = [
      ...normalized._warnings,
      'Verificación con capa avanzada no disponible; solo procesamiento principal verificó esta página.',
    ];
    log.error({
      page: pageIndex + 1,
      err: e?.message,
      anthropicType: e?.anthropicType ?? null,
    }, 'Sonnet pass fallo');
  }

  return normalized;
}

// Aplana el resultado al schema que el frontend ya conoce (backward-compat)
export function flattenToLegacyShape(r: OcrVehicleExtraction): any {
  return {
    placa: r.placa.valor || '',
    marca: r.marca.valor || '',
    linea: r.linea.valor || '',
    modelo: r.modelo.valor || '',
    clase: r.clase.valor || '',
    carroceria: '',
    cilindraje: '',
    propietarioNombre: r.propietarioNombre.valor || '',
    propietarioDocumento: r.propietarioDocumento.valor || '',
    tipoDocumento: r.tipoDocumento.valor || '',
    celular: r.celular.valor || '',
    email: r.email.valor || '',
    direccion: '',
    municipioResidencia: '',
    departamentoResidencia: '',
    municipioMatricula: '',
    departamentoMatricula: '',
    avaluoComercial: r.r1_avaluoComercial.valor || 0,
    impuesto: r.r2_impuesto.valor || 0,
    totalCargo: r.r5_totalCargo.valor || 0,
    totalPagar: r.r11_totalPagar.valor || 0,
    formularioNo: r.formularioNo.valor || '',
    // Meta para UI
    _documentType: r._documentType,
    _confidence: r._confidence_avg,
    _math_check: r._math_check,
    _warnings: r._warnings,
    _model: r._model,
    _page_rotated: r._page_rotated,
    _sonnet_attempted: r._sonnet_attempted ?? false,
    _sonnet_errored: r._sonnet_errored ?? false,
    _sonnet_error_type: r._sonnet_error_type,
  };
}
