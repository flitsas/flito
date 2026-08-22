import { Router, Request, Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { vehicles } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { loggerFor } from '../../shared/logger.js';
import { limitesXlsx, rechazoXlsxAHttp, bufferParaExcelJS, MIME_XLSX } from '../../shared/utils/excel.js';
import { medirXlsx } from '../../shared/utils/xlsx-zip.js';

const log = loggerFor('soat-batch');

const router = Router();

/**
 * Techo de lo que el libro puede ocupar DESCOMPRIMIDO (Bug #11682).
 *
 * Los 20 MB de multer acotan lo que viaja por la red, no lo que ocupa en el heap: un xlsx normal
 * comprime ~12:1 —medido en este repo—, así que un archivo que pasa ese tope y el magic number puede
 * traer más de 100 MB de `sheet1.xml` dentro. Con un archivo de 580 000 filas y 10,0 MB en disco esta
 * ruta tardaba 26,5 s con el event loop bloqueado y dejaba +1925 MB de heap… para acabar
 * contestando «Máximo 200 VINs por lote»: el tope de filas de abajo se miraba DESPUÉS de
 * cargar el libro entero.
 *
 * ── Contra qué se calcula ───────────────────────────────────────────────────────────────────────
 * NO contra el `--max-old-space-size=4096` del Dockerfile: esa línea es de la ETAPA DE BUILD y su
 * propio comentario dice que el runtime no la hereda. En producción el API corre bajo PM2 en una
 * sola instancia fork con `max_memory_restart: '512M'` sobre el RSS (`ecosystem.config.cjs:22`), en
 * régimen de ~200 MB. Cruzar ese techo no degrada esta petición: PM2 reinicia el proceso entero y se
 * lleva por delante las peticiones en vuelo de todos los módulos.
 *
 * ── Por qué 2 MB, el más bajo de los tres puntos ────────────────────────────────────────────────
 *   · Esta ruta ya tiene un tope de negocio duro y pequeño: 200 VINs. En formato RUNT —36 columnas,
 *     2 274 B por fila descomprimido, medido— un archivo de 200 filas ocupa 0,43 MB por dentro.
 *   · 2 MB son ~880 filas de ese formato: cuatro veces el tope de negocio. Ese margen es a propósito,
 *     para que a quien se pasa por poco le siga contestando «Máximo 200 VINs por lote» —el mensaje
 *     útil— y no un «archivo demasiado grande»; y para que quepa un libro guardado a mano por Excel,
 *     que con estilos por celda es bastante más gordo que el que escribe ExcelJS.
 *   · Medido POR ESTA RUTA con un archivo justo en el techo (850 filas RUNT): +48 MB de heap y 0,3 s.
 *
 * El `fileSize` de 20 MB de multer queda holgado frente a esto, pero no se toca: el rechazo por
 * tamaño real lo da ya el techo de aquí, con un mensaje que explica el motivo.
 *
 * Ninguna de estas rutas limita la CONCURRENCIA, así que el número se elige para que TRES cargas
 * simultáneas al tope quepan en el presupuesto, no una.
 */
export const BATCH_MAX_DESCOMPRIMIDO = 2 * 1024 * 1024;
const LIMITES_BATCH = limitesXlsx(BATCH_MAX_DESCOMPRIMIDO);

/**
 * Sin `fileFilter`, el content-type que declara el cliente viaja intacto hasta el parser. El criterio
 * es el mismo que ya usa `flito-conciliacion.routes.ts`; el olfateo real de los bytes va después, con
 * `medirXlsx`, porque multer no puede hacerlo sin el buffer completo (AGENTS.md 17).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
  fileFilter: (_req, file, cb) => {
    // El MIME rechazado no se devuelve: es una cadena que escribe el cliente.
    if (file.mimetype === MIME_XLSX) cb(null, true);
    else cb(new Error('El archivo debe ser un .xlsx'));
  },
});

/** Los rechazos de multer salen como 400/413 con el motivo, no como el 500 del error handler. */
function recibirXlsx(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const codigo = (err as { code?: string }).code;
      res.status(codigo === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        ok: false,
        message: codigo === 'LIMIT_FILE_SIZE'
          ? 'El archivo no puede superar 20 MB'
          : (err instanceof Error ? err.message : 'Archivo inválido'),
      });
      return;
    }
    next();
  });
}

router.use(authMiddleware, requireRole('admin'));

interface BatchResult {
  vin: string; plate: string | null; ownerName: string | null;
  brand: string | null; model: string | null; linea: string | null;
  claseVehiculo: string | null; docType: string | null; docNumber: string | null;
  phone: string | null; email: string | null; city: string | null;
  soatInsurer: string | null; soatPolicy: string | null;
  soatExpiry: string | null; soatStatus: string | null;
  hasSoat: boolean; runtOk: boolean; error: string | null;
}

const batchLimiter = rateLimit({ windowMs: 300000, max: 3, message: { ok: false, message: 'Máximo 3 validaciones batch cada 5 minutos' } });

// C1: NDJSON streaming — envía progreso línea por línea para evitar timeout
router.post('/batch-validate', batchLimiter, recibirXlsx, async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ ok: false, message: 'Archivo requerido' }); return; }

  // ANTES de abrir el libro: `load` descomprime y materializa el archivo entero en el heap, así que
  // el tope de 200 VINs de más abajo llegaba tarde (Bug #11682). Ver shared/utils/xlsx-zip.ts.
  const medida = await medirXlsx(req.file.buffer, LIMITES_BATCH);
  if (medida.estado !== 'ok') {
    const { status, mensaje } = rechazoXlsxAHttp(medida, LIMITES_BATCH);
    log.warn({ estado: medida.estado }, 'xlsx de batch RUNT rechazado sin abrirlo');
    res.status(status).json({ ok: false, message: mensaje });
    return;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bufferParaExcelJS(req.file.buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) { res.status(400).json({ ok: false, message: 'Hoja vacía' }); return; }

  const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const colMap: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, col) => { colMap[norm(cell.text || '')] = col; });
  const c = (name: string) => colMap[norm(name)] || 0;
  const vinCol = c('Numero de VIN') || c('Vin') || 1;

  const vins: { vin: string; ownerName: string; docType: string; docNumber: string; phone: string; email: string; city: string }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const vin = row.getCell(vinCol).text?.trim();
    if (!vin) return;
    const cell = (name: string, fb: number) => row.getCell(c(name) || fb).text?.trim() || '';
    vins.push({
      vin: vin.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      ownerName: cell('Nombres del Comprador', c('NOMBRE COMPLETO') || 20),
      docType: cell('Tipo de Documento Comprador', c('ClaseId') || 21),
      docNumber: cell('Numero de Documento Comprador', c('NumeroId') || 22),
      phone: cell('Telefono del Comprador', c('Celular') || 25),
      email: cell('Correo Comprador', c('Correo') || 35),
      city: cell('Ciudad del Comprador', c('OrganismoDettoCiudad') || 24),
    });
  });

  if (vins.length === 0) { res.status(400).json({ ok: false, message: 'No se encontraron VINs en el archivo' }); return; }
  if (vins.length > 200) { res.status(400).json({ ok: false, message: 'Máximo 200 VINs por lote' }); return; }

  log.info({ vinsCount: vins.length, mode: 'streaming' }, 'procesando batch RUNT');
  await audit(req, { action: 'upload', resource: 'batch', detail: `Batch RUNT: ${vins.length} VINs` });

  // Configurar streaming NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (obj: any) => res.write(JSON.stringify(obj) + '\n');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results: BatchResult[] = [];

  for (let i = 0; i < vins.length; i++) {
    const { vin, ownerName, docType, docNumber, phone, email, city } = vins[i];
    if (i > 0) await sleep(2000);

    send({ t: 'progress', i: i + 1, n: vins.length, vin });

    let runt: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runt = await consultarVehiculoRunt(undefined, vin);
        if (runt.ok) break;
        if (attempt < 3) await sleep(3000);
      } catch (e: any) {
        runt = { ok: false, message: e.message };
        if (attempt < 3) await sleep(3000);
      }
    }

    try {
      if (!runt?.ok || !runt?.data) {
        results.push({ vin, plate: null, ownerName, brand: null, model: null, linea: null, claseVehiculo: null, docType, docNumber, phone, email, city, soatInsurer: null, soatPolicy: null, soatExpiry: null, soatStatus: null, hasSoat: false, runtOk: false, error: runt?.message || 'No encontrado en RUNT' });
        continue;
      }
      const veh = runt.data.vehiculo || {};
      const soatArr = runt.data.soat;
      const soat = Array.isArray(soatArr) ? soatArr[0] : soatArr;

      results.push({
        vin, plate: veh.placa || veh.noPlaca || null, ownerName: ownerName || null,
        brand: veh.marca || null, model: `${veh.linea || ''} ${veh.modelo || ''}`.trim() || null,
        linea: veh.linea || null, claseVehiculo: veh.claseVehiculo || veh.clase || null,
        docType, docNumber, phone, email, city,
        soatInsurer: soat?.razonSocialAsegur || soat?.aseguradora || null,
        soatPolicy: soat?.numSoat || soat?.noPoliza || null,
        soatExpiry: soat?.fechaVencimSoat || null,
        soatStatus: soat?.estadoSoat || null,
        hasSoat: !!soat, runtOk: true, error: null,
      });
    } catch (err: any) {
      results.push({ vin, plate: null, ownerName, brand: null, model: null, linea: null, claseVehiculo: null, docType, docNumber, phone, email, city, soatInsurer: null, soatPolicy: null, soatExpiry: null, soatStatus: null, hasSoat: false, runtOk: false, error: err.message });
    }
  }

  const withSoat = results.filter((r) => r.hasSoat).length;
  const withoutSoat = results.filter((r) => !r.hasSoat && r.runtOk).length;
  const errors = results.filter((r) => !r.runtOk).length;

  send({ t: 'done', ok: true, total: results.length, withSoat, withoutSoat, errors, results });
  res.end();
});

// POST /export-provider — Genera Excel para enviar al proveedor
router.post('/export-provider', async (req: Request, res: Response) => {
  const { items } = req.body as { items: BatchResult[] };
  if (!items || !items.length) { res.status(400).json({ error: 'Sin datos' }); return; }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SOAT');

  ws.columns = [
    { header: 'Vin', key: 'vin', width: 22 },
    { header: 'Placa', key: 'plate', width: 10 },
    { header: 'Linea', key: 'linea', width: 15 },
    { header: 'NOMBRE COMPLETO', key: 'ownerName', width: 30 },
    { header: 'ClaseId', key: 'docType', width: 8 },
    { header: 'NumeroId', key: 'docNumber', width: 15 },
    { header: 'Celular', key: 'phone', width: 15 },
    { header: 'Correo', key: 'email', width: 30 },
    { header: 'OrganismoDettoCiudad', key: 'city', width: 20 },
  ];

  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const sanitizeCell = (v: any) => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  items.forEach((item) => {
    ws.addRow(Object.fromEntries(Object.entries(item).map(([k, v]) => [k, sanitizeCell(v)])));
  });

  await audit(req, { action: 'export', resource: 'soat-provider', detail: `Excel proveedor: ${items.length} vehiculos` });

  const today = new Date();
  const filename = `SOAT_${today.getDate().toString().padStart(2, '0')}_${(today.getMonth() + 1).toString().padStart(2, '0')}_${today.getFullYear()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
