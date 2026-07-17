import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { anthropicMessages } from './anthropic.js';

const log = loggerFor('tramites-ocr-docs');

import rateLimit from 'express-rate-limit';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// F5: Rate limit propio para OCR (costoso en API)
const ocrLimiter = rateLimit({ windowMs: 60000, max: 10, message: { ok: false, message: 'Máximo 10 análisis por minuto' } });

router.use(authMiddleware, requireRole('admin'));

// Instruccion comun para identificar paginas en PDFs multi-documento
const PAGE_INSTRUCTION = `

IMPORTANTE — DOCUMENTO MULTIPAGINA:
Si el PDF contiene MULTIPLES documentos (factura + FUR + improntas + etc.), identifica SOLO las paginas que corresponden al tipo solicitado.
- paginas_documento: array con los numeros de pagina donde esta el documento solicitado (ej: [1,2] o [3] o [1]). Base 1.
- total_paginas: total de paginas del PDF
Si el documento solicitado NO esta en el PDF, paginas_documento debe ser un array vacio [].`;

const PROMPTS: Record<string, string> = {
  factura: `Analiza este documento. Determina si contiene una FACTURA DE VENTA de vehiculo colombiana.

VALIDACIONES:
1. Debe ser factura de venta, cuenta de cobro o documento equivalente (NO un FUR, NO un formulario de tramite, NO un recibo, NO una cotizacion, NO un certificado)
2. Debe tener datos del emisor (NIT, razon social)
3. Debe tener datos del comprador (nombre, documento)
4. Debe tener descripcion del vehiculo
5. Debe tener valores monetarios (subtotal, IVA, total)
${PAGE_INSTRUCTION}

EXTRAER:
- tipo_documento: "factura_electronica" | "factura_venta" | "cuenta_cobro" | "documento_equivalente" | "no_es_factura"
- es_factura_valida: true/false
- paginas_documento: [numeros de pagina donde esta la factura]
- total_paginas: numero total de paginas del PDF
- numero_factura, fecha (YYYY-MM-DD), resolucion_dian
- emisor_nit, emisor_nombre, emisor_direccion, emisor_ciudad
- comprador_nombre, comprador_documento, comprador_tipo_doc (CC/NIT/CE)
- vehiculo_marca, vehiculo_linea, vehiculo_modelo, vehiculo_color, vehiculo_vin, vehiculo_motor, vehiculo_clase, vehiculo_cilindraje, vehiculo_placa
- subtotal (numerico), iva (numerico), total (numerico)
- forma_pago, cufe, observaciones

JSON valido sin markdown:
{"tipo_documento":"factura_electronica","es_factura_valida":true,"paginas_documento":[1],"total_paginas":1,"numero_factura":"","fecha":"","resolucion_dian":"","emisor_nit":"","emisor_nombre":"","emisor_direccion":"","emisor_ciudad":"","comprador_nombre":"","comprador_documento":"","comprador_tipo_doc":"CC","vehiculo_marca":"","vehiculo_linea":"","vehiculo_modelo":"","vehiculo_color":"","vehiculo_vin":"","vehiculo_motor":"","vehiculo_clase":"","vehiculo_cilindraje":"","vehiculo_placa":"","subtotal":0,"iva":0,"total":0,"forma_pago":"","cufe":"","observaciones":""}`,

  aduana: `Analiza este documento. Determina si contiene un MANIFIESTO DE IMPORTACION, DECLARACION DE IMPORTACION, o CERTIFICADO DE IMPORTACION de vehiculo o motocicleta en Colombia.

VALIDACIONES:
1. DEBE ser uno de estos documentos aduaneros: Declaracion de Importacion (DI) DIAN, Manifiesto de Importacion, Certificado de Homologacion, Licencia de Transito de Importacion (LTI), o documento de aduana equivalente
2. NO es valido si es: una factura de venta, un FUR (Formulario Unico de Registro), un certificado de improntas, una poliza SOAT, un recibo de pago, una cotizacion, un contrato de compraventa
3. DEBE contener datos del importador o agente de aduana (NIT, razon social)
4. DEBE contener descripcion del vehiculo o motocicleta (marca, modelo, VIN o serial)
5. DEBE contener datos de la operacion aduanera (numero declaracion, aduana, pais origen)
6. Para vehiculos nuevos importados (matricula inicial): debe tener referencia al vehiculo especifico con VIN o numero de chasis

TIPOS DE DOCUMENTOS ADUANEROS COLOMBIANOS:
- DECLARACION DE IMPORTACION (DI): Formulario oficial DIAN generado por MUISCA. Tiene numero de declaracion (formato numerico largo), subpartida arancelaria (8710 para vehiculos, 8711 para motos), datos del importador, valores FOB/CIF, tributos (arancel + IVA). Logo DIAN arriba.
- MANIFIESTO DE IMPORTACION: Documento que acompana la mercancia desde puerto hasta zona franca o bodega. Numero de manifiesto, datos del transportador, descripcion de carga.
- CERTIFICADO DE HOMOLOGACION: Documento ICONTEC/NTC que certifica que el vehiculo cumple normas tecnicas colombianas. Codigo NTC, numero certificado.
- LICENCIA DE IMPORTACION: Permiso del MinComercio para importar vehiculos (necesario para algunos tipos). Numero de licencia, vigencia.

SUBPARTIDAS ARANCELARIAS VEHICULOS COLOMBIA:
- 8703: Automoviles y vehiculos para transporte de personas
- 8704: Vehiculos para transporte de mercancias
- 8711: Motocicletas y ciclomotores
- 8702: Vehiculos para transporte colectivo (buses)
- 8701: Tractores

DATOS A EXTRAER:
- tipo_documento: "declaracion_importacion" | "manifiesto_importacion" | "certificado_homologacion" | "licencia_importacion" | "otro"
- es_valido: true/false (false si NO es documento aduanero)
- paginas_documento: [paginas donde esta el documento aduanero]
- total_paginas: total paginas del PDF
- numero_documento: numero de la declaracion, manifiesto o certificado
- fecha: fecha del documento (YYYY-MM-DD)
- aduana: nombre de la aduana (ej: "Aduana de Buenaventura", "Aduana de Cartagena", "Aduana de Bogota")
- importador_nombre: razon social del importador o agente de aduana
- importador_nit: NIT del importador
- importador_direccion: direccion del importador
- importador_ciudad: ciudad del importador
- agente_aduana: nombre del agente de aduana (si aplica)
- agente_aduana_nit: NIT del agente de aduana
- pais_origen: pais de fabricacion del vehiculo (ej: "Estados Unidos", "China", "India", "Japon")
- pais_procedencia: pais desde donde se envio (puede diferir del origen)
- puerto_entrada: puerto de ingreso a Colombia (Buenaventura, Cartagena, Barranquilla, Santa Marta, Bogota)
- subpartida_arancelaria: codigo arancelario (ej: "8703.80.90.00")
- tipo_vehiculo: "automovil" | "motocicleta" | "camioneta" | "bus" | "camion" | "otro"
- vehiculo_marca: marca del vehiculo
- vehiculo_linea: linea o referencia del vehiculo
- vehiculo_modelo: ano del modelo
- vehiculo_vin: VIN (17 caracteres) o numero de chasis
- vehiculo_motor: numero de motor
- vehiculo_chasis: numero de chasis si es diferente del VIN
- vehiculo_cilindraje: cilindraje en cc
- vehiculo_color: color
- vehiculo_clase: clase (automovil, campero, camioneta, motocicleta, etc)
- vehiculo_combustible: tipo de combustible (gasolina, diesel, electrico, hibrido)
- vehiculo_pasajeros: capacidad de pasajeros
- vehiculo_peso_bruto: peso bruto en kg
- cantidad: cantidad de vehiculos en la declaracion (usualmente 1 para matricula)
- valor_fob_usd: valor FOB en dolares (numerico)
- valor_flete_usd: valor del flete en dolares (numerico)
- valor_seguro_usd: valor del seguro en dolares (numerico)
- valor_cif_usd: valor CIF en dolares = FOB + flete + seguro (numerico)
- valor_cif_cop: valor CIF en pesos colombianos (numerico)
- tasa_cambio: tasa de cambio USD/COP usada
- arancel_porcentaje: porcentaje de arancel aplicado
- arancel_valor: valor del arancel en COP (numerico)
- iva_porcentaje: porcentaje de IVA importacion (usualmente 19%)
- iva_valor: valor del IVA en COP (numerico)
- total_tributos: total de tributos aduaneros en COP (numerico)
- regimen: tipo de regimen aduanero ("importacion ordinaria", "zona franca", "trafico postal", etc)
- observaciones: notas, restricciones, o informacion adicional relevante
${PAGE_INSTRUCTION}

JSON valido sin markdown:
{"tipo_documento":"declaracion_importacion","es_valido":true,"paginas_documento":[1],"total_paginas":1,"numero_documento":"","fecha":"","aduana":"","importador_nombre":"","importador_nit":"","importador_direccion":"","importador_ciudad":"","agente_aduana":"","agente_aduana_nit":"","pais_origen":"","pais_procedencia":"","puerto_entrada":"","subpartida_arancelaria":"","tipo_vehiculo":"automovil","vehiculo_marca":"","vehiculo_linea":"","vehiculo_modelo":"","vehiculo_vin":"","vehiculo_motor":"","vehiculo_chasis":"","vehiculo_cilindraje":"","vehiculo_color":"","vehiculo_clase":"","vehiculo_combustible":"","vehiculo_pasajeros":"","vehiculo_peso_bruto":"","cantidad":1,"valor_fob_usd":0,"valor_flete_usd":0,"valor_seguro_usd":0,"valor_cif_usd":0,"valor_cif_cop":0,"tasa_cambio":0,"arancel_porcentaje":0,"arancel_valor":0,"iva_porcentaje":0,"iva_valor":0,"total_tributos":0,"regimen":"","observaciones":""}`,

  impronta: `Analiza este documento. Determina si contiene un CERTIFICADO DE IMPRONTAS, HOJA DE IMPRONTAS DIGITALES, o ACTA DE IMPRONTAS de un vehiculo o motocicleta en Colombia.

VALIDACIONES:
1. DEBE ser uno de estos documentos de identificacion vehicular: Certificado de Improntas Digitales, Hoja de Improntas Digitales del Vehiculo, Acta de Improntas, Informe Pericial de Identificacion Vehicular, o Fotoimpronta certificada
2. NO es valido si es: una factura de venta, un FUR (Formulario Unico de Registro), una declaracion de importacion, una poliza SOAT, un certificado de revision tecnico-mecanica RTM (a menos que incluya seccion de improntas), un recibo de pago, un contrato
3. DEBE contener al menos UNO de estos numeros de identificacion del vehiculo: numero de motor, numero de chasis, VIN, o numero de serie
4. DEBE contener datos del vehiculo (marca, modelo como minimo)
5. Para ser valido el documento debe tener origen en: CDA (Centro de Diagnostico Automotor), VUS (Ventanilla Unica de Servicios), organismo de transito, DIJIN, o entidad certificada

TIPOS DE DOCUMENTOS DE IMPRONTAS COLOMBIANOS:
- HOJA DE IMPRONTAS DIGITALES: Documento digital moderno conforme Resolucion 17145 de 2023. Tiene secciones coloreadas para cada impronta (rojo=motor, azul=chasis, verde=VIN/serie). Fondo grafito simulando calco fisico. Hash SHA-256 y codigo QR de verificacion. Radicado formato IMPR-XXXXX.
- CERTIFICADO DE IMPRONTAS: Documento oficial de CDA o transito con datos del vehiculo, fotos o calcos de numeros de identificacion, comparacion con RUNT, y resultado (COINCIDE/NO COINCIDE/REGRABADO).
- ACTA DE IMPRONTAS: Formulario preimpreso con espacios para calcos fisicos (papel presionado sobre numeros estampados). Incluye croquis del vehiculo con ubicacion de numeros.
- INFORME PERICIAL DIJIN: Documento forense de la policia judicial para casos sospechosos. Analisis tecnico de autenticidad de estampados.
- FOTOIMPRONTA: Fotografias de alta definicion de los numeros de identificacion. Valida segun Resolucion 5748 de 2016.

NUMEROS DE IDENTIFICACION VEHICULAR:
- NUMERO DE MOTOR: Estampado en el bloque del motor. 8-15 caracteres alfanumericos. Profundidad minima 0.2mm.
- NUMERO DE CHASIS: Estampado en el bastidor/larguero del vehiculo. Puede coincidir con VIN.
- VIN (Vehicle Identification Number): 17 caracteres alfanumericos segun ISO 3779/3780. Posiciones: 1-3=fabricante, 4-8=descriptor, 9=digito verificacion, 10=ano modelo, 11=planta, 12-17=secuencial.
- NUMERO DE SERIE: Identificador adicional unico del fabricante.

CONSIDERACIONES POR TIPO DE VEHICULO:
- AUTOMOVILES: Tienen motor, chasis y VIN/serie. Los 3 deben aparecer.
- MOTOCICLETAS: Tienen motor y chasis/marco. Menos puntos de estampado que autos.
- VEHICULOS ELECTRICOS (Tesla, BYD, etc): NO tienen numero de motor tradicional (motores electricos no llevan estampado fisico). El VIN es el identificador principal. Campo motor puede estar vacio o ser N/A — esto es NORMAL y valido.
- VEHICULOS DE CARGA: Pueden tener estampados adicionales en largueros del chasis.

ESTADOS DE VERIFICACION — ATENCION CRITICA:
- COINCIDE: El numero encontrado coincide EXACTAMENTE caracter por caracter con el registrado
- NO COINCIDE: Cualquier diferencia, incluso un solo digito/letra diferente
- REGRABADO: Evidencia de re-estampado (profundidad irregular, desalineacion, marcas de herramienta)
- ILEGIBLE: Corrosion o dano impide lectura completa
- NO VERIFICADO: El documento no muestra comparacion o no se puede determinar

INSTRUCCIONES CRITICAS DE LECTURA:
1. Lee CADA numero de identificacion (motor, chasis, VIN, serie) EXACTAMENTE como aparece en la impronta/calco/foto. Caracter por caracter, digito por digito. NO asumas, NO completes, NO corrijas.
2. Si el documento muestra DOS versiones del mismo numero (uno en el calco/foto y otro en los datos del vehiculo), COMPARALOS tu mismo caracter por caracter. Si son IDENTICOS = "coincide". Si hay CUALQUIER diferencia (un solo caracter distinto, un digito de mas o de menos, una letra cambiada) = "no_coincide".
3. NO confies ciegamente en lo que dice el estado del documento. Si el documento dice "COINCIDE" pero TU comparacion muestra que los numeros son diferentes = reporta "no_coincide" y agrega alerta.
4. Si el documento solo muestra UN numero (sin comparacion), el estado es "no_verificado".
5. Presta MAXIMA atencion a caracteres que se confunden facilmente: 0 vs O, 1 vs I vs l, 5 vs S, 8 vs B, 2 vs Z, 6 vs G. En VIN nunca hay I, O, Q.
6. El VIN tiene EXACTAMENTE 17 caracteres. Si ves mas o menos, hay un error de lectura.
7. Si el numero en la impronta (calco/grafito/foto) difiere del numero escrito en la seccion de datos del vehiculo del MISMO documento = ALERTA CRITICA, reporta "no_coincide" aunque el documento diga lo contrario.

DATOS A EXTRAER:
- tipo_documento: "hoja_improntas_digitales" | "certificado_improntas" | "acta_improntas" | "informe_pericial" | "fotoimpronta" | "otro"
- es_valido: true/false (false si NO es documento de improntas)
- paginas_documento: [paginas donde estan las improntas]
- total_paginas: total paginas del PDF
- numero_certificado: numero del certificado, radicado o acta (ej: "IMPR-7G9K5XBZQ")
- fecha: fecha del documento (YYYY-MM-DD)
- entidad_emisora: nombre del CDA, VUS, organismo de transito o DIJIN que emite
- entidad_nit: NIT de la entidad emisora
- entidad_ciudad: ciudad de la entidad
- inspector_nombre: nombre del inspector o tecnico que tomo las improntas
- inspector_documento: numero de documento del inspector
- vehiculo_placa: placa del vehiculo
- vehiculo_marca: marca
- vehiculo_linea: linea
- vehiculo_modelo: modelo (ano)
- vehiculo_color: color
- vehiculo_clase: clase (automovil, motocicleta, camioneta, campero, etc)
- vehiculo_servicio: tipo de servicio (particular, publico, oficial)
- vehiculo_vin: VIN leido de la IMPRONTA/CALCO (el numero fisico del vehiculo). EXACTAMENTE como aparece. 17 caracteres.
- vehiculo_vin_datos: VIN que aparece en la seccion de DATOS del documento (si existe). Puede diferir del de la impronta.
- vehiculo_motor: numero de motor leido de la IMPRONTA/CALCO. EXACTAMENTE como aparece. Vacio o "N/A" si es electrico.
- vehiculo_motor_datos: numero de motor en la seccion de DATOS (si existe).
- vehiculo_chasis: numero de chasis leido de la IMPRONTA/CALCO. EXACTAMENTE como aparece.
- vehiculo_chasis_datos: numero de chasis en la seccion de DATOS (si existe).
- vehiculo_serie: numero de serie si es diferente del VIN
- estado_motor: TU propia comparacion caracter por caracter entre vehiculo_motor y vehiculo_motor_datos. "coincide" SOLO si son IDENTICOS. "no_coincide" si hay CUALQUIER diferencia. "no_aplica" si es electrico. "no_verificado" si no hay dos versiones para comparar.
- estado_chasis: misma logica de comparacion propia
- estado_vin: misma logica — compara vehiculo_vin con vehiculo_vin_datos caracter por caracter
- estado_serie: misma logica
- tiene_qr: true/false (si el documento tiene codigo QR de verificacion)
- tiene_hash: true/false (si tiene hash SHA-256 de autenticidad)
- hash_valor: valor del hash si es visible
- resolucion_referencia: resolucion citada (ej: "Resolucion 17145 de 2023")
- alertas: array de alertas detectadas (ej: ["REGRABADO en motor", "Numero chasis ilegible"])
- observaciones: observaciones del inspector o notas del documento
${PAGE_INSTRUCTION}

JSON valido sin markdown:
{"tipo_documento":"certificado_improntas","es_valido":true,"paginas_documento":[1],"total_paginas":1,"numero_certificado":"","fecha":"","entidad_emisora":"","entidad_nit":"","entidad_ciudad":"","inspector_nombre":"","inspector_documento":"","vehiculo_placa":"","vehiculo_marca":"","vehiculo_linea":"","vehiculo_modelo":"","vehiculo_color":"","vehiculo_clase":"","vehiculo_servicio":"","vehiculo_vin":"","vehiculo_vin_datos":"","vehiculo_motor":"","vehiculo_motor_datos":"","vehiculo_chasis":"","vehiculo_chasis_datos":"","vehiculo_serie":"","estado_motor":"no_verificado","estado_chasis":"no_verificado","estado_vin":"no_verificado","estado_serie":"no_verificado","tiene_qr":false,"tiene_hash":false,"hash_valor":"","resolucion_referencia":"","alertas":[],"observaciones":""}`,

  soat: `Analiza este documento. Determina si contiene una POLIZA SOAT (Seguro Obligatorio de Accidentes de Transito) de Colombia.

VALIDACIONES:
1. DEBE ser una poliza SOAT vigente o certificado de SOAT emitido por una aseguradora colombiana autorizada
2. NO es valido si es: una factura, un FUR, un certificado de improntas, una declaracion de importacion, un recibo de pago, una cotizacion de seguro
3. DEBE contener: numero de poliza, nombre de aseguradora, fechas de vigencia, datos del vehiculo
4. Aseguradoras SOAT validas en Colombia: Seguros del Estado, La Previsora, Suramericana, Liberty, Mapfre, Allianz, Bolivar, AXA Colpatria, Mundial, Solidaria, La Equidad, entre otras
${PAGE_INSTRUCTION}

EXTRAER:
- tipo_documento: "soat" | "certificado_soat" | "otro"
- es_valido: true/false
- paginas_documento: [paginas], total_paginas: numero
- numero_poliza: numero de la poliza SOAT
- aseguradora: nombre de la aseguradora
- fecha_inicio: fecha inicio vigencia (YYYY-MM-DD)
- fecha_vencimiento: fecha vencimiento (YYYY-MM-DD)
- estado_poliza: "vigente" | "vencida" | "anulada" | "no_determinado"
- vehiculo_placa, vehiculo_marca, vehiculo_linea, vehiculo_modelo, vehiculo_clase
- vehiculo_vin: VIN si aparece
- tomador_nombre, tomador_documento
- valor_prima: valor de la prima (numerico)
- observaciones

JSON valido sin markdown:
{"tipo_documento":"soat","es_valido":true,"paginas_documento":[1],"total_paginas":1,"numero_poliza":"","aseguradora":"","fecha_inicio":"","fecha_vencimiento":"","estado_poliza":"no_determinado","vehiculo_placa":"","vehiculo_marca":"","vehiculo_linea":"","vehiculo_modelo":"","vehiculo_clase":"","vehiculo_vin":"","tomador_nombre":"","tomador_documento":"","valor_prima":0,"observaciones":""}`,
};

// TRAM-11: la llamada a Anthropic pasa por el helper resiliente (timeout+retry+
// métrica). Construimos el payload y delegamos en anthropicMessages('ocr').
function visionPayload(b64: string, mediaType: string, prompt: string) {
  return {
    model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
    messages: [{ role: 'user', content: [
      { type: mediaType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: prompt },
    ] }],
  };
}

// S1: Extrae paginas con limite de seguridad
async function extractPages(pdfBuffer: Buffer, pages: number[]): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();
  if (totalPages > 200) throw new Error('PDF excede 200 paginas');
  const pageIndices = pages.map((p) => p - 1).filter((i) => i >= 0 && i < totalPages).slice(0, 20);
  if (pageIndices.length === 0) return pdfBuffer;
  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach((page) => newDoc.addPage(page));
  const bytes = await newDoc.save();
  return Buffer.from(bytes);
}

// POST /ocr/:tipo — Analiza documento, extrae datos y recorta paginas si es multi-doc
router.post('/ocr/:tipo', ocrLimiter, upload.single('file'), async (req: Request, res: Response) => {
  const tipo = req.params.tipo;
  const prompt = PROMPTS[tipo];
  if (!prompt) { res.status(400).json({ ok: false, message: `Tipo no soportado: ${tipo}` }); return; }
  if (!req.file) { res.status(400).json({ ok: false, message: 'Archivo requerido' }); return; }
  if (!env.ANTHROPIC_API_KEY) { res.status(500).json({ ok: false, message: 'API key no configurada' }); return; }

  const header = req.file.buffer.slice(0, 5).toString('ascii');
  const isPdf = header.startsWith('%PDF');
  const isJpg = req.file.buffer[0] === 0xFF && req.file.buffer[1] === 0xD8;
  const isPng = req.file.buffer[0] === 0x89 && req.file.buffer[1] === 0x50;
  if (!isPdf && !isJpg && !isPng) { res.status(400).json({ ok: false, message: 'Solo PDF, JPG o PNG' }); return; }

  // F1: Validar tamaño base64 resultante (10MB archivo = ~13.3MB base64)
  if (req.file.size > 10 * 1024 * 1024) { res.status(400).json({ ok: false, message: 'Archivo máximo 10MB' }); return; }

  const b64 = req.file.buffer.toString('base64');
  const mediaType = isPdf ? 'application/pdf' : isJpg ? 'image/jpeg' : 'image/png';

  log.info({ tipo, originalname: req.file.originalname, sizeKb: Math.round(req.file.size / 1024) }, 'procesando OCR doc');

  try {
    const ai = await anthropicMessages(visionPayload(b64, mediaType, prompt), 'ocr');
    if (!ai.ok) { res.status(ai.status).json({ ok: false, message: ai.message }); return; }
    const r = ai.data;

    const text = r.content?.[0]?.text || '';
    let data: any;
    try { data = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
    catch { res.status(500).json({ ok: false, message: 'No se pudo extraer datos del documento' }); return; }

    // F2: Si multi-doc, extraer paginas y guardar en disco (NO devolver base64 en JSON)
    let extractedFilename: string | null = null;
    if (isPdf && data.paginas_documento && Array.isArray(data.paginas_documento) && data.paginas_documento.length > 0) {
      const totalPages = data.total_paginas || 1;
      if (data.paginas_documento.length < totalPages) {
        log.info({ totalPages, paginasExtraidas: data.paginas_documento, tipo }, 'multi-doc detectado, extrayendo subset');
        try {
          const extracted = await extractPages(req.file.buffer, data.paginas_documento);
          const dir = path.join(process.cwd(), 'uploads', 'ocr-temp');
          await mkdir(dir, { recursive: true });
          extractedFilename = `${tipo}_${Date.now()}.pdf`;
          await writeFile(path.join(dir, extractedFilename), extracted);
          data._paginas_extraidas = true;
          data._paginas_originales = totalPages;
          data._extracted_filename = extractedFilename;
        } catch (e: any) {
          log.error({ err: e.message }, 'error extrayendo paginas');
        }
      }
    }

    await audit(req, { action: 'upload', resource: 'ocr_doc', detail: `OCR ${tipo}: ${req.file.originalname}${data._paginas_extraidas ? ` (${data.paginas_documento.length}/${data._paginas_originales} pags)` : ''}` });

    log.info({ tipo, valido: !!(data.es_factura_valida || data.es_valido), pdfRecortado: !!data._paginas_extraidas }, 'OCR doc completado');
    res.json({ ok: true, tipo, data });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// GET /ocr-extracted/:filename — Descarga PDF recortado
router.get('/ocr-extracted/:filename', async (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename).replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = path.join(process.cwd(), 'uploads', 'ocr-temp', filename);
  try {
    const buffer = await readFile(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buffer);
  } catch { res.status(404).json({ ok: false, message: 'Archivo no encontrado' }); }
});

export default router;
