import { Router, Request, Response, NextFunction } from 'express';
import https from 'https';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { vehicles as vehiclesTable } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { env } from '../../config/env.js';
import { extractSinglePage, flattenToLegacyShape } from './ocr.pipeline.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('vehicles-ocr');

const router = Router();
const MAX_PDF_MB = 100;
const MAX_PAGES = 100;
const PAGE_CONCURRENCY = 3;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_MB * 1024 * 1024 } });

const handleUploadError = (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, message: `El archivo supera el límite de ${MAX_PDF_MB} MB. Divide el PDF en partes más pequeñas o reduce su resolución.` });
    }
    if (err) return res.status(400).json({ ok: false, message: 'Error procesando el archivo' });
    next();
  });
};

router.use(authMiddleware, requireRole('admin'));

function callAnthropic(content: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: env.ANTHROPIC_MODEL_HAIKU,
      max_tokens: 8000,
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

const EXTRACTION_PROMPT = `Analiza este PDF de declaraciones de impuesto sobre vehiculos automotores de Colombia (puede ser Gobernacion de Antioquia, Caldas, u otra).

Extrae TODOS los vehiculos encontrados en TODAS las paginas. Para cada vehiculo extrae exactamente estos campos:

- placa: valor de D.1 PLACA — formato colombiano: 3 letras + 3 numeros (ej: QTP482, QPK392). Lee CADA letra y numero con MAXIMA precision.
- marca: valor de D.2 MARCA — nombre del fabricante (TESLA, SUZUKI, TOYOTA, CHEVROLET, etc.)
- linea: valor de D.3 LINEA — modelo/referencia del vehiculo (SWIFT, MODEL 3, COROLLA, etc.)
- modelo: valor de D.4 MODELO — ATENCION CRITICA: este campo es el ANO de fabricacion del vehiculo. SOLO puede ser un ano entre 1970 y 2027. Lee los 4 digitos con MAXIMA precision. Si ves "2026" NO lo leas como "2028" ni "2025". Si ves "2025" NO lo leas como "2026". El ano del modelo vehicular es un dato critico que NO puede tener error. Verifica dos veces cada digito.
- clase: valor de D.5 CLASE — tipo de vehiculo (AUTOMOVIL, CAMIONETA, CAMPERO, MOTOCICLETA, etc.)
- carroceria: valor de D.6 CARROCERIA
- cilindraje: valor de D.9 CILINDRAJE — numero en cc. Si es 0 puede ser vehiculo electrico.
- propietarioNombre: C.1 NOMBRE + C.3 APELLIDOS (concatenados con espacio)
- propietarioDocumento: el NUMERO exacto del documento — lee CADA digito
- tipoDocumento: CC o NIT segun lo marcado con X en el formulario
- celular: C.4 CELULAR — 10 digitos
- email: C.6 EMAIL
- direccion: C.7 DIRECCION
- municipioResidencia: C.8 MUNICIPIO
- departamentoResidencia: C.9 DEPARTAMENTO
- municipioMatricula: D.12 MUNICIPIO DE MATRICULA
- departamentoMatricula: D.13 DEPARTAMENTO DE MATRICULA
- avaluoComercial: valor numerico ENTERO de campo 1 (AVALUO COMERCIAL DEL VEHICULO). Sin puntos ni comas. Solo numeros.
- impuesto: valor numerico ENTERO de campo 2 (IMPUESTO SOBRE VEHICULOS). Sin puntos ni comas.
- totalPagar: valor numerico ENTERO de campo 13 (TOTAL A PAGAR). Sin puntos ni comas.
- formularioNo: FORMULARIO No del encabezado

REGLAS DE PRECISION:
1. El campo MODELO (ano) es el mas critico. Es un numero de 4 digitos entre 1970 y 2027. NO inventes, NO redondees, lee EXACTAMENTE lo que dice el documento.
2. La PLACA tiene formato fijo: 3 letras mayusculas + 3 numeros (ej: ABC123). Si ves un caracter ambiguo, prioriza el formato correcto.
3. Los valores monetarios (avaluo, impuesto, total) son ENTEROS sin decimales. No incluyas puntos separadores de miles.
4. El numero de documento debe tener entre 6 y 12 digitos. Lee cada uno con precision.

Responde UNICAMENTE con un JSON array valido, sin markdown, sin backticks, sin texto adicional. Ejemplo:
[{"placa":"ABC123","marca":"TESLA","linea":"MODEL 3","modelo":"2026",...}]`;

async function ocrSingleDocument(b64: string, mediaType: string): Promise<any[]> {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: mediaType, data: b64 } },
    { type: 'text', text: EXTRACTION_PROMPT },
  ];
  const r = await callAnthropic(content);
  if (r?.error) throw new Error(r.error.message || 'Anthropic error');
  const text = r?.content?.[0]?.text || '';
  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch {
    return [];
  }
}

router.post('/ocr', handleUploadError, async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ ok: false, message: 'Archivo PDF requerido' });
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, message: 'API key no configurada' });
    return;
  }

  const header = req.file.buffer.slice(0, 5).toString('ascii');
  const isPdf = header.startsWith('%PDF');
  const isPng = req.file.buffer[0] === 0x89 && req.file.buffer[1] === 0x50;
  if (!isPdf && !isPng) { res.status(400).json({ ok: false, message: 'Solo se aceptan archivos PDF o PNG' }); return; }

  const sizeMb = req.file.size / 1024 / 1024;
  log.info({ originalname: req.file.originalname, sizeMb: Number(sizeMb.toFixed(1)), kind: isPdf ? 'pdf' : 'png' }, 'procesando OCR');

  try {
    let vehicles: any[] = [];
    // FLOTA-03: metadata de observabilidad expuesta al operador (post INC-OCR).
    let meta: {
      totalPages: number; extracted: number; sonnetAttempted: number;
      sonnetErrors: number; sonnetErrorTypes: Record<string, number>; haikuOnlyPages: number;
    } | null = null;

    // Siempre procesamos página por página con el pipeline multi-capa
    // (rotación + Haiku + validación + Sonnet si hay dudas)
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = isPdf ? await PDFDocument.load(req.file.buffer) : null;
    const totalPages = srcDoc ? srcDoc.getPageCount() : 1;

    if (totalPages > MAX_PAGES) {
      res.status(400).json({ ok: false, message: `PDF tiene ${totalPages} páginas. Máximo soportado: ${MAX_PAGES}` });
      return;
    }

    if (!isPdf) {
      // PNG suelto — llamada única al modelo antiguo (raro en producción)
      const b64 = req.file.buffer.toString('base64');
      vehicles = await ocrSingleDocument(b64, 'image/png');
      meta = { totalPages: 1, extracted: vehicles.length, sonnetAttempted: 0, sonnetErrors: 0, sonnetErrorTypes: {}, haikuOnlyPages: vehicles.length };
    } else {
      log.info({ totalPages, concurrency: PAGE_CONCURRENCY }, 'pipeline multi-capa iniciado');

      const results: any[] = new Array(totalPages).fill(null);
      const pageErrors: string[] = [];
      let idx = 0;
      // Contadores separados (PR (B) INC-OCR-2026-05-12):
      //  - sonnetFallbacks: páginas donde Sonnet pass devolvió resultado válido
      //  - sonnetAttempted: páginas donde se intentó la segunda pasada (needsSecondPass=true)
      //  - sonnetErrors:    páginas donde Sonnet pass falló (catch silencioso histórico).
      //                     sonnetErrors NO se mezcla con sonnetFallbacks — antes el log
      //                     mostraba "sonnetFallbacks:0, errors:0" durante el incidente
      //                     activo y ocultaba que TODA llamada a Sonnet fallaba.
      let sonnetFallbacks = 0;
      let sonnetAttempted = 0;
      let sonnetErrors = 0;
      const sonnetErrorTypes: Record<string, number> = {};
      const worker = async () => {
        while (true) {
          const i = idx++;
          if (i >= totalPages) return;
          try {
            const extraction = await extractSinglePage(srcDoc, i);
            if (extraction) {
              const flat = flattenToLegacyShape(extraction);
              results[i] = flat;
              if (extraction._model.includes('sonnet')) sonnetFallbacks++;
              if (extraction._sonnet_attempted) sonnetAttempted++;
              if (extraction._sonnet_errored) {
                sonnetErrors++;
                const t = extraction._sonnet_error_type ?? 'unknown';
                sonnetErrorTypes[t] = (sonnetErrorTypes[t] ?? 0) + 1;
              }
              const placa = flat.placa || 'sin-placa';
              log.info({ page: i + 1, totalPages, placa, confAvg: extraction._confidence_avg, mathCheck: extraction._math_check, model: extraction._model.split('-')[1], warnings: extraction._warnings, sonnetAttempted: extraction._sonnet_attempted, sonnetErrored: extraction._sonnet_errored }, 'pagina extraida');
            } else {
              results[i] = null;
            }
          } catch (e: any) {
            log.error({ page: i + 1, err: e.message }, 'pagina fallo');
            pageErrors.push(`p${i + 1}: ${e.message}`);
            results[i] = null;
          }
        }
      };

      await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
      vehicles = results.filter(Boolean);
      const extractedPages = vehicles.length; // páginas con resultado (pre-dedup)
      meta = {
        totalPages, extracted: extractedPages, sonnetAttempted, sonnetErrors, sonnetErrorTypes,
        haikuOnlyPages: Math.max(0, extractedPages - sonnetAttempted),
      };

      log.info({ extracted: vehicles.length, totalPages, sonnetAttempted, sonnetFallbacks, sonnetErrors, sonnetErrorTypes, errors: pageErrors.length }, 'pipeline completado');

      if (pageErrors.length === totalPages) {
        res.status(502).json({ ok: false, message: 'El servicio de OCR no respondió. Intenta de nuevo en unos minutos.' });
        return;
      }
    }

    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      res.status(400).json({ ok: false, message: 'No se encontraron vehículos en el documento' });
      return;
    }

    // Deduplicar por placa — cuando una placa aparece en varias páginas nos quedamos con
    // la de MAYOR confianza (preferimos Sonnet > Haiku, y confianza alta > media > baja)
    const byPlate = new Map<string, any>();
    for (const v of vehicles) {
      const placa = String(v?.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      // Descartamos placas con formato inválido (claramente alucinadas o ilegibles)
      if (!placa || !/^[A-Z]{3}\d{3}$/.test(placa)) continue;
      const existing = byPlate.get(placa);
      if (!existing || (v._confidence || 0) > (existing._confidence || 0)) {
        byPlate.set(placa, { ...v, placa });
      }
    }

    vehicles = Array.from(byPlate.values()).map((v) => ({
      ...v,
      avaluoComercial: Number(v.avaluoComercial) || 0,
      impuesto: Number(v.impuesto) || 0,
      totalPagar: Number(v.totalPagar) || 0,
      modelo: Number(v.modelo) || v.modelo,
    }));

    await audit(req, {
      action: 'upload',
      resource: 'ocr',
      detail: `OCR PDF: ${req.file.originalname}, ${vehicles.length} vehiculos extraidos`,
    });

    res.json({ ok: true, vehicles, meta });
  } catch (err: any) {
    log.error({ err: err.message }, 'OCR fallo');
    res.status(500).json({ ok: false, message: err.message || 'Error procesando documento' });
  }
});

// Exportar datos OCR a Excel
router.post('/ocr-export', async (req: Request, res: Response) => {
  const { vehicles } = req.body;
  if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
    res.status(400).json({ error: 'Sin datos para exportar' });
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Impuestos Vehiculares');

  ws.columns = [
    { header: 'Formulario', key: 'formularioNo', width: 14 },
    { header: 'Placa', key: 'placa', width: 10 },
    { header: 'Propietario', key: 'propietarioNombre', width: 30 },
    { header: 'Tipo Doc', key: 'tipoDocumento', width: 8 },
    { header: 'Documento', key: 'propietarioDocumento', width: 15 },
    { header: 'Celular', key: 'celular', width: 14 },
    { header: 'Email', key: 'email', width: 25 },
    { header: 'Direccion', key: 'direccion', width: 25 },
    { header: 'Municipio Res.', key: 'municipioResidencia', width: 18 },
    { header: 'Depto Res.', key: 'departamentoResidencia', width: 15 },
    { header: 'Marca', key: 'marca', width: 12 },
    { header: 'Linea', key: 'linea', width: 15 },
    { header: 'Modelo', key: 'modelo', width: 8 },
    { header: 'Clase', key: 'clase', width: 12 },
    { header: 'Carroceria', key: 'carroceria', width: 12 },
    { header: 'Cilindraje', key: 'cilindraje', width: 10 },
    { header: 'Mun. Matricula', key: 'municipioMatricula', width: 18 },
    { header: 'Depto Matricula', key: 'departamentoMatricula', width: 15 },
    { header: 'Avaluo Comercial', key: 'avaluoComercial', width: 16 },
    { header: 'Impuesto', key: 'impuesto', width: 14 },
    { header: 'Total a Cargo', key: 'totalCargo', width: 14 },
    { header: 'Total a Pagar', key: 'totalPagar', width: 14 },
  ];

  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const v of vehicles) {
    ws.addRow(v);
  }

  // Formato moneda en columnas numericas
  const moneyFmt = '"$"#,##0';
  ws.getColumn('avaluoComercial').numFmt = moneyFmt;
  ws.getColumn('impuesto').numFmt = moneyFmt;
  ws.getColumn('totalCargo').numFmt = moneyFmt;
  ws.getColumn('totalPagar').numFmt = moneyFmt;

  // Fila de totales
  const totalRow = ws.addRow({
    placa: 'TOTALES',
    avaluoComercial: vehicles.reduce((s: number, v: any) => s + (Number(v.avaluoComercial) || 0), 0),
    impuesto: vehicles.reduce((s: number, v: any) => s + (Number(v.impuesto) || 0), 0),
    totalCargo: vehicles.reduce((s: number, v: any) => s + (Number(v.totalCargo) || 0), 0),
    totalPagar: vehicles.reduce((s: number, v: any) => s + (Number(v.totalPagar) || 0), 0),
  });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };

  await audit(req, { action: 'export', resource: 'ocr', detail: `Excel impuestos: ${vehicles.length} vehiculos` });

  const filename = `Impuestos_${new Date().toISOString().split('T')[0]}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// Importar vehículos extraídos por OCR al pipeline — upsert por placa
const ocrImportSchema = z.object({
  vehicles: z.array(z.object({
    placa: z.string().min(1),
    marca: z.string().optional().nullable(),
    linea: z.string().optional().nullable(),
    modelo: z.union([z.string(), z.number()]).optional().nullable(),
    clase: z.string().optional().nullable(),
    propietarioNombre: z.string().optional().nullable(),
    propietarioDocumento: z.string().optional().nullable(),
    avaluoComercial: z.union([z.string(), z.number()]).optional().nullable(),
    impuesto: z.union([z.string(), z.number()]).optional().nullable(),
    totalPagar: z.union([z.string(), z.number()]).optional().nullable(),
    formularioNo: z.string().optional().nullable(),
  })).min(1),
});

router.post('/ocr-import', async (req: Request, res: Response) => {
  const parsed = ocrImportSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, message: 'Datos inválidos' }); return; }

  const normPlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const toInt = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const toYear = (v: unknown): number | null => {
    const n = toInt(v);
    return n && n >= 1970 && n <= 2030 ? n : null;
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const v of parsed.data.vehicles) {
      const plate = normPlate(v.placa);
      if (!plate || plate.length < 5) { skipped++; continue; }

      const impuesto = toInt(v.impuesto);
      const totalPagar = toInt(v.totalPagar);
      const avaluoComercial = toInt(v.avaluoComercial);
      const year = toYear(v.modelo);

      const [existing] = await tx.select({ id: vehiclesTable.id, stage: vehiclesTable.stage })
        .from(vehiclesTable).where(eq(vehiclesTable.plate, plate)).limit(1);

      if (existing) {
        // Actualizar datos de impuesto. El stage avanza a 'impuesto' solo si el vehículo
        // está aún en 'ingreso' — no retrocede si ya está en soat_pendiente o posterior.
        const STAGE_ORDER: Record<string, number> = { ingreso: 0, impuesto: 1, soat_pendiente: 2, soat_comprado: 3, soat_verificado: 4, listo: 5 };
        const currentOrder = STAGE_ORDER[existing.stage] ?? 0;
        const nextStage = currentOrder < 1 ? 'impuesto' : existing.stage;

        await tx.update(vehiclesTable).set({
          ownerName: v.propietarioNombre || undefined,
          ownerDocument: v.propietarioDocumento || undefined,
          brand: v.marca || undefined,
          model: v.linea || undefined,
          year: year || undefined,
          vehicleClass: v.clase || undefined,
          avaluoComercial: avaluoComercial || undefined,
          impuestoTotalPagar: totalPagar || undefined,
          taxAmount: impuesto || undefined,
          taxDate: new Date().toISOString().split('T')[0],
          formularioNo: v.formularioNo || undefined,
          taxSource: 'ocr',
          stage: nextStage as any,
          updatedAt: new Date(),
        }).where(eq(vehiclesTable.id, existing.id));
        updated++;
      } else {
        // Insertar sin VIN (el formulario de impuesto no lo trae)
        await tx.insert(vehiclesTable).values({
          vin: null as any,
          plate,
          ownerName: v.propietarioNombre || null,
          ownerDocument: v.propietarioDocumento || null,
          brand: v.marca || null,
          model: v.linea || null,
          year,
          vehicleClass: v.clase || null,
          avaluoComercial,
          impuestoTotalPagar: totalPagar,
          taxAmount: impuesto,
          taxDate: new Date().toISOString().split('T')[0],
          formularioNo: v.formularioNo || null,
          taxSource: 'ocr',
          stage: 'impuesto',
        });
        created++;
      }
    }
  });

  await audit(req, {
    action: 'upload',
    resource: 'vehicle',
    detail: `OCR import: ${created} creados, ${updated} actualizados, ${skipped} omitidos (${parsed.data.vehicles.length} total)`,
  });

  res.json({ ok: true, total: parsed.data.vehicles.length, created, updated, skipped });
});

export default router;
