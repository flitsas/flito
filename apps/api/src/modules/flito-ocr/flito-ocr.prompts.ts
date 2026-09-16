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

// Sistema común a todos los extractores. La primera línea enumera los documentos que el motor conoce
// (la Épica #12245 añadió derechos, servicios y comprobantes de pago); las reglas no cambian con ella. Reglas anti-alucinación + transcripción exacta. Lo último
// es crítico para FLITO: el pequeño leía de la capa de texto del PDF ("copia, no lee"), y con
// Anthropic se pierde esa exactitud salvo que se pida explícitamente NO normalizar separadores
// (el caso real "FLIT-ARHZZ1" vs "FLITARHZZ1"). Ver §8.4.
export const SISTEMA_OCR = `Eres un extractor OCR profesional de documentos oficiales colombianos (pólizas de SOAT, declaraciones/recibos del impuesto vehicular, facturas de venta de vehículos, recibos de derechos de tránsito, facturas de servicios y comprobantes de pago).

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

// ─────────────────────────────── Recibo de caja (HU #12591) ─────────────────
// El comprobante que entrega la ventanilla de la hacienda al pagar en efectivo o con tarjeta. Es un
// documento distinto de la declaración: trae el valor recibido, la fecha y un consecutivo de caja, y
// NO trae la placa (el impuesto ya está identificado: se carga desde su detalle). Sin `placa` en la
// lista para no invitar al modelo a inventarla.
export const PROMPT_RECIBO_CAJA = `Extrae los datos de este RECIBO DE CAJA emitido por la ventanilla de una hacienda colombiana al pagar un IMPUESTO VEHICULAR.

Campos:
- valorTotal: el valor EFECTIVAMENTE RECIBIDO / PAGADO. Búscalo como "TOTAL", "VALOR RECIBIDO", "VALOR PAGADO" o "TOTAL PAGADO".
    * Si hay varios importes (efectivo, cambio, tarjeta), el que vale es el TOTAL del pago, no el efectivo entregado ni el cambio devuelto.
    * Entero en pesos, sin puntos, sin comas, sin "$".
- fechaPago: fecha en que se hizo el pago (ISO YYYY-MM-DD).
- numeroRecibo: número / consecutivo del recibo de caja. Transcribe exacto.

Devuelve EXCLUSIVAMENTE este JSON:
{"valorTotal":{"valor":null,"confianza":null},"fechaPago":{"valor":null,"confianza":null},"numeroRecibo":{"valor":null,"confianza":null}}`;

// ─────────────────────────────── Factura de venta ───────────────────────────
// Porta PATRONES_NUMERO_FACTURA/FECHA_FACTURA/VALOR_VEHICULO. Doble llave: placa Y vin (§8.3). El
// valorVehiculo es la base gravable — no confundir con el IVA ni el total con impuestos.
//
// ── El bloque COMPRADOR (HU #12092, Feature #12073) ──────────────────────────────────────────────
//
// Nueve campos del ADQUIRIENTE, para que el canal Cliente no obligue a teclear a mano lo que la
// factura ya dice. Se amplía ESTA plantilla y no se crea una segunda: dos plantillas serían dos
// llamadas al modelo por PDF (doble coste y doble latencia) y abrirían la puerta a que las dos
// lecturas del MISMO documento se contradigan.
//
// El error caro de este bloque —el equivalente al "VALOR ASEGURADO" del SOAT— es confundir al
// COMPRADOR con el EMISOR: en una factura de concesionario el que más se ve es el vendedor (logo,
// NIT grande, encabezado). Por eso la instrucción lo nombra dos veces, en positivo y en negativo.
//
// El `correo` NO se pide: una factura de venta no lo trae, y pedirlo es invitar a inventarlo.
export const PROMPT_FACTURA_VENTA = `Extrae los datos de esta FACTURA DE VENTA de un vehículo (emitida por un concesionario) colombiana.

Campos del VEHÍCULO y de la factura:
- placa: la placa asignada al vehículo, si aparece. Formato 3 letras + 3 dígitos. Transcribe tal cual (puede no estar en facturas de vehículo nuevo).
- vin: número de identificación del vehículo (VIN / chasis / serie), 17 caracteres. Transcribe EXACTO, sin normalizar.
- numeroFactura: consecutivo de la factura (ej. "FE-1234", "SETP990000123"). Transcribe con su prefijo y guiones tal cual. NO tomes la palabra "ELECTRÓNICA" de "FACTURA ELECTRÓNICA DE VENTA".
- fechaFactura: fecha de emisión de la factura (ISO YYYY-MM-DD).
- valorVehiculo: el PRECIO del vehículo (base gravable). Búscalo como "VALOR DEL VEHÍCULO", "PRECIO DE VENTA", "BASE GRAVABLE" o "PRECIO UNITARIO".
    * NO tomes el IVA ni un subtotal parcial. Si solo hay un total con impuestos, tómalo con confianza "media".
    * Entero en pesos, sin puntos, sin comas, sin "$".

Campos del COMPRADOR / ADQUIRIENTE:
QUIÉN ES: la persona o empresa que COMPRA el vehículo. Búscala bajo las etiquetas "COMPRADOR", "ADQUIRIENTE", "CLIENTE", "SEÑOR(ES)" o "FACTURAR A".
    * CRÍTICO: el comprador NO es el EMISOR de la factura. El emisor es el concesionario/vendedor: es el que lleva el logo, el encabezado y el NIT grande arriba, y a veces la firma o la resolución de facturación. NUNCA tomes los datos del emisor como los del comprador.
    * Si no distingues con seguridad cuál de los dos bloques es el comprador, deja TODOS estos campos en null. Es preferible a copiar los del concesionario.
- nombres: nombres de pila del comprador, cuando es una PERSONA NATURAL. null si el comprador es una empresa.
- apellidos: apellidos del comprador, cuando es una PERSONA NATURAL. null si el comprador es una empresa.
- razonSocial: nombre de la empresa compradora, cuando el comprador es una PERSONA JURÍDICA. null si el comprador es una persona natural.
    * CRÍTICO (excluyentes): o devuelves nombres Y apellidos con razonSocial en null, o devuelves razonSocial con nombres Y apellidos en null. NUNCA los dos juegos a la vez. Si el documento del comprador es un NIT, es una empresa; si es una cédula, es una persona natural.
- tipoDocumento: el tipo de documento del comprador. UNO de exactamente estos valores: CC, CE, TI, PAS, PPT, NIT, RC, PT.
    * Si el documento no dice qué tipo es, responde null. NO lo deduzcas de que haya razón social ni de la longitud del número.
- numeroDocumento: el número de documento del comprador (cédula o NIT), tal como aparece. NO tomes el NIT del concesionario emisor.
- direccion: la dirección del comprador (la que aparece en SU bloque, no la del concesionario).
- municipio: el municipio/ciudad del comprador.
- departamento: el departamento del comprador.
- celular: el teléfono celular o de contacto del comprador. Solo dígitos.

Devuelve EXCLUSIVAMENTE este JSON:
{"placa":{"valor":null,"confianza":null},"vin":{"valor":null,"confianza":null},"numeroFactura":{"valor":null,"confianza":null},"fechaFactura":{"valor":null,"confianza":null},"valorVehiculo":{"valor":null,"confianza":null},"nombres":{"valor":null,"confianza":null},"apellidos":{"valor":null,"confianza":null},"razonSocial":{"valor":null,"confianza":null},"tipoDocumento":{"valor":null,"confianza":null},"numeroDocumento":{"valor":null,"confianza":null},"direccion":{"valor":null,"confianza":null},"municipio":{"valor":null,"confianza":null},"departamento":{"valor":null,"confianza":null},"celular":{"valor":null,"confianza":null}}`;

// ─────────────────────────── Derecho de tránsito (HU #10950) ─────────────────
// Un solo prompt para TODOS los organismos. Funciona porque la extracción es semántica ("el total a
// pagar"), no posicional: lo mismo que hace que un único prompt de SOAT sirva para todas las
// aseguradoras. Lo que varía por organismo se resuelve fuera del prompt — umbral de confianza
// (organismos_transito_config.flito_umbral_ocr) y, si el formato es rebelde, una pista concatenada
// (flito_ocr_prompt_hint). El organismo NO se detecta para elegir estrategia: se lee para
// CONTRASTARLO con el esperado, y una discrepancia es señal de revisión, no de parseo.
export const PROMPT_DERECHO_TRAMITE = `Extrae los datos de este RECIBO / CUENTA DE COBRO de DERECHOS DE TRÁMITE emitido por un organismo de tránsito (secretaría de movilidad / alcaldía) colombiano.

Es el documento con el que se paga al organismo por radicar un trámite vehicular (matrícula inicial, traspaso, inscripción de prenda, etc.). Suele llevar el escudo del municipio, los datos del vehículo, un desglose de conceptos y un total al final.

Campos:
- placa: la placa del vehículo del trámite. Formato 3 letras + 3 dígitos (autos, ej. QTP701) o 3 letras + 2 dígitos + 1 letra (motos). Transcribe tal cual.
    * NO confundas la placa con el RADICADO ni con la cédula/NIT del propietario.
- valorTotal: el valor total que se paga al organismo. Búscalo como "TOTAL A PAGAR", "VALOR TOTAL", "TOTAL LIQUIDACIÓN" o "NETO A PAGAR".
    * CRÍTICO: es el TOTAL FINAL de ESTA cuenta, la suma de todos sus conceptos. NO tomes un concepto suelto (matrícula, expedición, especies venales) ni un subtotal intermedio.
    * CRÍTICO: si el documento es un RESUMEN o CONSOLIDADO de varias placas (una tabla con muchas placas y un gran total), NO es una cuenta individual: responde placa=null y valorTotal=null.
    * Entero en pesos, sin puntos de miles, sin comas, sin "$".
- fechaPago: la fecha en que se pagó o se expidió la cuenta de cobro (ISO YYYY-MM-DD). Si hay varias fechas, prefiere la de pago; si solo hay fecha de expedición o de liquidación, usa esa.
- numeroRadicado: el número de radicado del trámite ("RADICADO", "RADICADO DE TRÁMITE", "No. RADICADO"). Transcribe exacto.
- organismo: el municipio u organismo de tránsito que emite la cuenta, tal como aparece junto al escudo o en el encabezado (ej. "MEDELLÍN", "PALMIRA", "BELLO"). Solo el nombre, en mayúsculas.
- tipoTramite: el CONCEPTO del cobro, leído de las líneas de detalle. Devuelve el texto del concepto principal tal como está escrito (ej. "MATRICULA INICIAL", "INSCRIPCION DE PRENDA", "TRASPASO"). Si hay varios conceptos, el que da nombre al trámite (no las especies venales ni el sistematizado).

Devuelve EXCLUSIVAMENTE este JSON:
{"placa":{"valor":null,"confianza":null},"valorTotal":{"valor":null,"confianza":null},"fechaPago":{"valor":null,"confianza":null},"numeroRadicado":{"valor":null,"confianza":null},"organismo":{"valor":null,"confianza":null},"tipoTramite":{"valor":null,"confianza":null}}`;

// ─────────────────────────── Comprobante universal (Épica #12245) ────────────
// UN prompt para CUALQUIER documento de la cola de comprobantes: primero dice QUÉ es (catálogo
// cerrado de `TipoDocumentoComprobante`), si acredita un pago, y de qué CONCEPTO de costo es; luego
// las llaves de cruce (placa, VIN, ID FLIT) y el valor. Los tipos con extractor propio (SOAT,
// impuesto, caja, derecho) se releen después con su prompt de siempre: este no los sustituye, los
// clasifica. Sin datos de personas (Habeas Data, ADR-0008): no se piden y el extractor descarta
// cualquier clave fuera del catálogo.
export const PROMPT_COMPROBANTE_UNIVERSAL = `Clasifica y extrae los datos de este documento colombiano relacionado con un trámite vehicular. Puede ser una póliza/factura de SOAT, un recibo o declaración del impuesto vehicular (con o sin sello PAGADO), un recibo de caja de una hacienda, un recibo/cuenta de cobro de derechos de tránsito de un organismo, una factura de un servicio (trámite digital, logística/mensajería, servicio adicional), un comprobante de transferencia o consignación bancaria, o un documento que NO es un pago (formulario, certificado, licencia, tarjeta de propiedad, carta, fotografía de un vehículo).

NO leas ni devuelvas datos de personas (nombres, cédulas, direcciones, teléfonos): no se piden y no debes incluirlos.

Campos:
- tipoDocumento: UNO de exactamente estos valores: factura_soat, recibo_impuesto, recibo_caja_impuesto, recibo_derecho, factura_servicio, comprobante_transferencia, cuenta_cobro, otro_pago, documento_no_pago.
    * factura_soat: póliza o factura de SOAT (aseguradora, número de póliza, vigencia).
    * recibo_impuesto: declaración/recibo del impuesto vehicular de una gobernación o secretaría de hacienda.
    * recibo_caja_impuesto: comprobante de ventanilla de una hacienda (consecutivo de caja, sin placa).
    * recibo_derecho: cuenta de cobro o recibo de un organismo de tránsito por radicar un trámite.
    * factura_servicio: factura o cuenta de cobro de un servicio prestado (mensajería, gestión, trámite digital).
    * comprobante_transferencia: soporte bancario de una transferencia, PSE o consignación.
    * cuenta_cobro: cuenta de cobro que no encaja en las anteriores.
    * otro_pago: acredita un pago pero no encaja en ninguno de los tipos anteriores.
    * documento_no_pago: cualquier documento que no acredite un pago.
    * Si dudas entre dos, elige el más específico con confianza "media"; si no puedes, null.
- esComprobantePago: "true" si el documento ACREDITA un pago hecho (sello PAGADO, "recibo", "pagado", soporte bancario, factura con "total pagado"); "false" si es una liquidación sin pagar, una cotización o un documento que no es de dinero. null si no puedes saberlo.
- concepto: UNO de: soat, impuesto, derecho, tramite_digital, logistica, servicios_adicionales. Qué se pagó.
    * soat ↔ póliza; impuesto ↔ impuesto vehicular; derecho ↔ organismo de tránsito por el trámite; tramite_digital ↔ honorario de gestión digital del trámite; logistica ↔ mensajería/entrega/recogida; servicios_adicionales ↔ cualquier otro servicio facturado sobre el trámite.
    * Si el documento es un comprobante bancario sin decir qué se pagó, concepto = null.
- placa: la placa del vehículo si aparece (3 letras + 3 dígitos, o 3 letras + 2 dígitos + 1 letra). Tal cual.
- vin: VIN / chasis / serie de 17 caracteres si aparece. EXACTO, sin normalizar.
- idFlit: la referencia del trámite de FLIT si aparece (empieza por "FLIT", con guiones o sin ellos, p. ej. "FLIT-ARHZZ1"). Transcribe EXACTO, con sus separadores.
- valorTotal: el valor EFECTIVAMENTE pagado o a pagar por este documento ("TOTAL A PAGAR", "TOTAL", "VALOR PAGADO", "PRIMA TOTAL"). Entero en pesos, sin puntos, comas ni "$".
    * CRÍTICO (SOAT): "VALOR ASEGURADO" es cobertura, NO el precio.
    * CRÍTICO (impuesto): "TOTAL A CARGO" no es lo pagado; lo pagado es "TOTAL A PAGAR" (= cargo + servicio).
    * CRÍTICO: si el documento es un resumen de varias placas, valorTotal = null y placa = null.
- fechaPago: fecha del pago o, si no hay, de emisión (ISO YYYY-MM-DD).
- numeroDocumento: número de póliza / recibo / factura / referencia de la transferencia. EXACTO.
- emisor: quién emite el documento (aseguradora, gobernación, organismo, empresa, banco). Solo el nombre.

Devuelve EXCLUSIVAMENTE este JSON (cada campo con valor y confianza alta|media|baja|null):
{"tipoDocumento":{"valor":null,"confianza":null},"esComprobantePago":{"valor":null,"confianza":null},"concepto":{"valor":null,"confianza":null},"placa":{"valor":null,"confianza":null},"vin":{"valor":null,"confianza":null},"idFlit":{"valor":null,"confianza":null},"valorTotal":{"valor":null,"confianza":null},"fechaPago":{"valor":null,"confianza":null},"numeroDocumento":{"valor":null,"confianza":null},"emisor":{"valor":null,"confianza":null}}`;

// ─────────────────────────── Partición de consolidados (Épica #12245) ────────
// No extrae nada: solo dice qué páginas forman cada documento de un PDF que trae varios. La salida
// NO es el mapa campo→{valor,confianza} de los demás prompts, así que no pasa por `pasada`; la lee
// `particionConsolidado` en flito-ocr.service.ts y la valida quien parte (rango, solapes,
// cobertura). Si el modelo falla, el consolidado se parte una página por documento.
export const PROMPT_PARTICION_CONSOLIDADO = `Este PDF puede contener VARIOS documentos independientes, uno detrás de otro (facturas de SOAT, recibos de impuesto vehicular, recibos de derechos de tránsito, facturas de servicios, comprobantes de transferencia, cuentas de cobro, y también hojas que no son ningún documento: portadas, resúmenes, índices, páginas en blanco).

Tu única tarea es DELIMITAR los documentos: decir qué páginas forman cada uno. No extraigas datos. No leas ni devuelvas datos de personas.

Reglas:
- Un documento puede ocupar varias páginas consecutivas (p. ej. una póliza de dos hojas, una factura con anexo).
- Una página nueva con un encabezado nuevo (otro emisor, otro número de documento, otra placa) empieza otro documento.
- Las páginas que sean portada, índice, resumen consolidado de varias placas o estén en blanco NO van en ningún documento.
- Numera las páginas desde 1, como las ve un lector de PDF. total_paginas es el total del archivo.
- Si no puedes decidir, prefiere partir (un documento por página) antes que juntar dos documentos distintos.

Devuelve EXCLUSIVAMENTE este JSON:
{"total_paginas":0,"documentos":[{"paginas":[1,2],"tipo_probable":"factura_soat|recibo_impuesto|recibo_derecho|factura_servicio|comprobante_transferencia|cuenta_cobro|otro","confianza":"alta|media|baja"}]}`;
