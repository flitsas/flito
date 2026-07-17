// FLITO OCR — prompts de extracción. Aquí vive el "entender" que en el sistema pequeño estaba en
// packages/server/src/adaptadores/ocr/patrones.ts (regex por campo). Con Anthropic ya no hay regex:
// el conocimiento de emisor (qué es el VALOR TOTAL y no la cobertura, cuál es la vigencia y no la
// expedición, cómo se escribe una placa) se expresa como INSTRUCCIÓN de prompt + schema de confianza
// por campo. Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §8.1/§8.3.
//
// Regla de oro heredada de patrones.ts: "null NO es un error; inventar SÍ lo es". El umbral de
// RN-04/CA-06 solo protege si el modelo es honesto sobre lo que no puede leer.

/** Confianza categórica que pedimos al modelo (el pipeline del grande usa la misma escala). */
export type ConfianzaCategorica = 'alta' | 'media' | 'baja' | null;

/** Un campo del documento con su valor crudo y la confianza categórica del modelo. */
export interface CampoCrudo {
  valor: string | null;
  confianza: ConfianzaCategorica;
}

// Sistema común a los tres extractores. Reglas anti-alucinación + transcripción exacta. Lo último
// es crítico para FLITO: el pequeño leía de la capa de texto del PDF ("copia, no lee"), y con
// Anthropic se pierde esa exactitud salvo que se pida explícitamente NO normalizar separadores
// (el caso real "FLIT-ARHZZ1" vs "FLITARHZZ1"). Ver §8.4.
export const SISTEMA_OCR = `Eres un extractor OCR profesional de documentos oficiales colombianos (pólizas de SOAT, declaraciones/recibos del impuesto vehicular y facturas de venta de vehículos).

REGLAS ABSOLUTAS:
1. Extrae SOLO lo que veas LITERALMENTE en el documento. Usa ÚNICAMENTE lo visible, NUNCA tu conocimiento general ni ejemplos típicos.
2. Si un campo está borroso, cortado, tapado por sellos/firmas, rotado o ausente: responde valor=null y confianza=null. NUNCA inventes.
3. Decir "null" NO es un error. Inventar SÍ lo es. Un campo dudoso en null es preferible a un campo inventado.
4. TRANSCRIBE EXACTAMENTE. No normalices ni "arregles" separadores: si un número de póliza o factura trae guiones, puntos o espacios, cópialos tal cual. "FLIT-ARHZZ1" no es lo mismo que "FLITARHZZ1".
5. PROHIBIDO usar valores de ejemplo (placas ABC123/AAA000, documentos 123456789/000000, nombres "JUAN PEREZ") si no están literalmente escritos.
6. Ante duda entre dos lecturas ("O" vs "0", "S" vs "5"), respeta el formato del campo; si aún dudas, marca confianza="baja".

CONFIANZA por campo:
- "alta": texto nítido, etiqueta inequívoca, sin duda.
- "media": legible con esfuerzo, o el dato está pero su etiqueta es ambigua.
- "baja": parcialmente visible (sello, borrón) — sospechas el valor pero no puedes verificarlo.
- null: ilegible o ausente → el valor también es null.

Respondes SIEMPRE un único objeto JSON, sin markdown ni texto alrededor.`;

// ─────────────────────────────── Factura SOAT ───────────────────────────────
// Porta PATRONES_POLIZA/VALOR_TOTAL/ASEGURADORA/VIGENCIA/EXPEDICION. El riesgo caro (patrones.ts):
// "VALOR ASEGURADO" (cobertura, cientos de millones) NO es "VALOR/PRIMA TOTAL" (el precio pagado).
export const PROMPT_FACTURA_SOAT = `Extrae los datos de esta PÓLIZA/FACTURA DE SOAT (Seguro Obligatorio de Accidentes de Tránsito) colombiano.

Campos:
- placa: la placa del vehículo asegurado. Formato: 3 letras + 3 dígitos (autos, ej. QTQ100) o 3 letras + 2 dígitos + 1 letra (motos). Transcribe tal cual.
- vin: número de identificación del vehículo (VIN / número de chasis / serie), 17 caracteres alfanuméricos. Transcribe EXACTO, sin normalizar.
- numeroPoliza: el número de la póliza (etiqueta "PÓLIZA No", "No. DE PÓLIZA"). NO confundas con la placa ni con el NIT de la aseguradora. Transcribe con sus guiones/puntos tal cual.
- valorTotal: el PRECIO que se pagó por la póliza. Búscalo como "TOTAL A PAGAR", "PRIMA TOTAL", "TOTAL PRIMA" o "VALOR TOTAL".
    * CRÍTICO: "VALOR ASEGURADO" / "VALOR CUBIERTO" / "VALOR AMPARADO" es la COBERTURA (cientos de millones), NO el precio. NUNCA lo tomes como valorTotal.
    * Una póliza desglosa prima, tasa Runt, contribución FOSYGA, subtotal, IVA y total. El valorTotal es el TOTAL FINAL (abajo), no un subtotal.
    * Entero en pesos, sin puntos de miles, sin comas, sin "$".
- aseguradora: la compañía emisora (ej. "Seguros del Estado", "SURA", "Mundial de Seguros", "La Previsora", "Allianz", "Bolívar", "Mapfre", "Axa Colpatria", "Equidad", "Solidaria", "HDI", "Liberty"). Solo el nombre.
- fechaExpedicion: fecha en que se EXPIDIÓ la póliza (formato ISO YYYY-MM-DD).
- vigenciaDesde: fecha DESDE la que la póliza cubre (ISO YYYY-MM-DD).
- vigenciaHasta: fecha HASTA la que cubre (ISO YYYY-MM-DD).
    * La vigencia dura ~1 año: vigenciaHasta ≈ vigenciaDesde + 1 año (a veces −1 día). vigenciaDesde NO es la fecha de expedición (aunque a veces coinciden). Si solo distingues una fecha, no adivines las otras: márcalas null.

Devuelve EXCLUSIVAMENTE este JSON (cada campo con valor y confianza alta|media|baja|null):
{"placa":{"valor":null,"confianza":null},"vin":{"valor":null,"confianza":null},"numeroPoliza":{"valor":null,"confianza":null},"valorTotal":{"valor":null,"confianza":null},"aseguradora":{"valor":null,"confianza":null},"fechaExpedicion":{"valor":null,"confianza":null},"vigenciaDesde":{"valor":null,"confianza":null},"vigenciaHasta":{"valor":null,"confianza":null}}`;

// ─────────────────────────────── Recibo de impuesto ─────────────────────────
// Porta PATRONES_VALOR_IMPUESTO/NUMERO_RECIBO/FECHA_PAGO/ANIO_GRAVABLE. Riesgo caro: la declaración
// vehicular es una tabla con varios totales; se paga "TOTAL A PAGAR" (= cargo + servicio), NO
// "TOTAL A CARGO". El patrón viejo devolvía el cargo y facturaba de menos.
export const PROMPT_RECIBO_IMPUESTO = `Extrae los datos de este RECIBO / DECLARACIÓN de pago del IMPUESTO VEHICULAR colombiano.

Campos:
- placa: la placa del vehículo. Formato 3 letras + 3 dígitos (o 3 letras + 2 dígitos + 1 letra en motos). Transcribe tal cual.
- valorTotal: el valor EFECTIVAMENTE PAGADO. Búscalo como "TOTAL A PAGAR" o "VALOR PAGADO".
    * CRÍTICO: la declaración tiene VARIOS totales: "TOTAL A CARGO" (el impuesto), "SERVICIO", y "TOTAL A PAGAR" = cargo + servicio. Lo pagado es el "TOTAL A PAGAR", NUNCA el "TOTAL A CARGO".
    * Entero en pesos, sin puntos, sin comas, sin "$".
- numeroRecibo: número del recibo/comprobante/referencia de pago. Transcribe exacto.
- fechaPago: fecha en que se pagó (ISO YYYY-MM-DD).
- anioGravable: el año gravable / vigencia fiscal del impuesto (4 dígitos, ej. 2026).

Devuelve EXCLUSIVAMENTE este JSON:
{"placa":{"valor":null,"confianza":null},"valorTotal":{"valor":null,"confianza":null},"numeroRecibo":{"valor":null,"confianza":null},"fechaPago":{"valor":null,"confianza":null},"anioGravable":{"valor":null,"confianza":null}}`;

// ─────────────────────────────── Factura de venta ───────────────────────────
// Porta PATRONES_NUMERO_FACTURA/FECHA_FACTURA/VALOR_VEHICULO. Doble llave: placa Y vin (§8.3). El
// valorVehiculo es la base gravable — no confundir con el IVA ni el total con impuestos.
export const PROMPT_FACTURA_VENTA = `Extrae los datos de esta FACTURA DE VENTA de un vehículo (emitida por un concesionario) colombiana.

Campos:
- placa: la placa asignada al vehículo, si aparece. Formato 3 letras + 3 dígitos. Transcribe tal cual (puede no estar en facturas de vehículo nuevo).
- vin: número de identificación del vehículo (VIN / chasis / serie), 17 caracteres. Transcribe EXACTO, sin normalizar.
- numeroFactura: consecutivo de la factura (ej. "FE-1234", "SETP990000123"). Transcribe con su prefijo y guiones tal cual. NO tomes la palabra "ELECTRÓNICA" de "FACTURA ELECTRÓNICA DE VENTA".
- fechaFactura: fecha de emisión de la factura (ISO YYYY-MM-DD).
- valorVehiculo: el PRECIO del vehículo (base gravable). Búscalo como "VALOR DEL VEHÍCULO", "PRECIO DE VENTA", "BASE GRAVABLE" o "PRECIO UNITARIO".
    * NO tomes el IVA ni un subtotal parcial. Si solo hay un total con impuestos, tómalo con confianza "media".
    * Entero en pesos, sin puntos, sin comas, sin "$".

Devuelve EXCLUSIVAMENTE este JSON:
{"placa":{"valor":null,"confianza":null},"vin":{"valor":null,"confianza":null},"numeroFactura":{"valor":null,"confianza":null},"fechaFactura":{"valor":null,"confianza":null},"valorVehiculo":{"valor":null,"confianza":null}}`;
