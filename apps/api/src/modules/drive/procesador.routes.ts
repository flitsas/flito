import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { downloadFile } from '../../services/googleDrive.js';
import { env } from '../../config/env.js';
import https from 'https';
import crypto from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { db } from '../../db/client.js';
import { procesamientoCuentas } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('drive-procesador');

// Firma HMAC corta para autorización del endpoint público de descarga.
// Compromiso: cualquiera con la URL completa puede descargar (intencional para hyperlinks Excel),
// pero sin la firma es imposible enumerar timestamps + placas adivinando.
//
// Estrategia de migración a clave dedicada SIN romper tokens existentes:
// - Firma de tokens NUEVOS: si DOWNLOAD_TOKEN_SECRET está definida, usarla; sino fallback a JWT_SECRET.
// - Verificación de tokens: probar la clave nueva primero, luego la vieja (JWT_SECRET) como fallback.
// Esto permite definir DOWNLOAD_TOKEN_SECRET en .env sin invalidar los Excels ya distribuidos.
const PRIMARY_HMAC_KEY = env.DOWNLOAD_TOKEN_SECRET ?? env.JWT_SECRET;
const HAS_DEDICATED_KEY = !!env.DOWNLOAD_TOKEN_SECRET;

function hmac(key: string, dir: string, filename: string): string {
  return crypto.createHmac('sha256', key).update(`${dir}|${filename}`).digest('hex').slice(0, 16);
}

function signFileToken(dir: string, filename: string): string {
  return hmac(PRIMARY_HMAC_KEY, dir, filename);
}

function verifyFileToken(dir: string, filename: string, token: string): boolean {
  const tokenBuf = Buffer.from(token);
  const primary = Buffer.from(hmac(PRIMARY_HMAC_KEY, dir, filename));
  if (tokenBuf.length === primary.length && crypto.timingSafeEqual(tokenBuf, primary)) return true;
  // Fallback: tokens viejos firmados con JWT_SECRET cuando DOWNLOAD_TOKEN_SECRET ya está activo.
  if (HAS_DEDICATED_KEY) {
    const legacy = Buffer.from(hmac(env.JWT_SECRET, dir, filename));
    if (tokenBuf.length === legacy.length && crypto.timingSafeEqual(tokenBuf, legacy)) return true;
  }
  return false;
}

const router = Router();
router.use(authMiddleware, requireRole('admin'));

const processLimiter = rateLimit({ windowMs: 300000, max: 5, keyGenerator: userOrIpKey('cuentas'), message: { error: 'Máximo 5 procesamientos cada 5 minutos' } });

const processingFiles = new Set<string>();

type TipoTramiteCuenta = 'PRENDA' | 'MATRICULA_INICIAL' | 'OTRO' | '';

interface CuentaCobro {
  pagina: number;
  placa: string;
  propietario: string;
  cedula: string;
  vehiculo: string;
  tipoTramite: TipoTramiteCuenta;
  fechaTramite: string;
  organismo: string;
  marca: string;
  valorTotal: number;
  radicado: string;
}

// Nombre compuesto del trámite (igual a la línea de detalle del modelo
// 00-REINTEGROS CLIENTES): "{fecha} {placa} {organismo} {marca} MATRICULA
// MATRICULA INICIAL [Prenda] NORMAL". Se usa como nombre de descarga del PDF
// por placa y como texto del hyperlink en el Excel.
function nombreTramite(c: CuentaCobro): string {
  const fecha = (c.fechaTramite || '').trim();
  const org = (c.organismo || '').trim().toUpperCase();
  const marca = (c.marca || '').trim().toUpperCase();
  const prendaSuffix = c.tipoTramite === 'PRENDA' ? ' Prenda' : '';
  const partes = [fecha, c.placa, org, marca, 'MATRICULA', `MATRICULA INICIAL${prendaSuffix}`, 'NORMAL']
    .filter((p) => p && p.length > 0);
  return partes.join(' ').replace(/\s+/g, ' ').trim();
}

// Sanitiza un nombre para usarlo como filename de descarga (conserva espacios,
// quita caracteres ilegales en sistemas de archivos).
function safeDownloadName(base: string, ext: string): string {
  const clean = base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180);
  return `${clean || 'tramite'}.${ext}`;
}

function normalizarTipoTramite(raw: unknown): TipoTramiteCuenta {
  const t = String(raw ?? '').toUpperCase().replace(/\s+/g, '_');
  if (t.includes('PRENDA') || t.includes('GRAVAMEN') || t.includes('GARANTIA')) return 'PRENDA';
  if (t.includes('MATRICULA_INICIAL') || t === 'MATRICULA_INICIAL' || t === 'MI') return 'MATRICULA_INICIAL';
  if (t === 'OTRO') return 'OTRO';
  return '';
}

function etiquetaTipoTramite(t: TipoTramiteCuenta): string {
  if (t === 'PRENDA') return 'PRENDA';
  if (t === 'MATRICULA_INICIAL') return 'MATRICULA INICIAL';
  if (t === 'OTRO') return 'OTRO';
  return '';
}


// POST /procesar-cuentas — Procesa un PDF de Drive, separa por placa, genera Excel
router.post('/procesar-cuentas', processLimiter, async (req: Request, res: Response) => {
  const { fileId } = req.body;
  if (!fileId) { res.status(400).json({ error: 'fileId requerido' }); return; }

  if (processingFiles.has(fileId)) { res.status(409).json({ error: 'Este archivo ya está siendo procesado' }); return; }
  processingFiles.add(fileId);

  const [registro] = await db.insert(procesamientoCuentas).values({
    usuarioId: (req as any).user!.sub, driveFileId: fileId, estado: 'procesando',
  }).returning();

  try {

    // Limpiar procesamientos anteriores > 24h
    const baseDir = path.join(process.cwd(), 'uploads', 'cuentas-cobro');
    await mkdir(baseDir, { recursive: true });
    try {
      const { readdir, stat, rm } = await import('fs/promises');
      const dirs = await readdir(baseDir);
      const ahora = Date.now();
      for (const d of dirs) { const ts = parseInt(d); if (!isNaN(ts) && ahora - ts > 24 * 60 * 60 * 1000) await rm(path.join(baseDir, d), { recursive: true, force: true }).catch(() => {}); }
    } catch {}

    // 1. Descargar PDF de Drive
    const { buffer, name } = await downloadFile(fileId);

    if (!name?.toLowerCase().endsWith('.pdf')) { res.status(400).json({ error: 'El archivo debe ser PDF' }); return; }

    // 2. Cargar PDF con pdf-lib
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = await PDFDocument.load(buffer);
    const totalPages = srcDoc.getPageCount();

    if (totalPages === 0) { res.json({ ok: true, archivoOriginal: name, totalPaginas: 0, cuentasDetectadas: 0, placasUnicas: 0, valorTotal: 0, cuentas: [], archivos: [], excelFile: null, outputDir: null }); return; }
    const MAX_PAGES = 150;
    if (totalPages > MAX_PAGES) { res.status(400).json({ error: `PDF tiene ${totalPages} páginas. Máximo soportado: ${MAX_PAGES}` }); return; }

    // 3. Para cada página, extraer como PDF individual y hacer OCR con Claude (paralelizado por chunks)
    const cuentas: CuentaCobro[] = [];
    const paginasPorPlaca = new Map<string, number[]>();

    const procesarPagina = async (i: number): Promise<void> => {
      const singleDoc = await PDFDocument.create();
      const [copiedPage] = await singleDoc.copyPages(srcDoc, [i]);
      singleDoc.addPage(copiedPage);
      const singleBytes = await singleDoc.save();
      const b64 = Buffer.from(singleBytes).toString('base64');

      const ocrBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: `Analiza esta pagina de un PDF de tramites vehiculares colombianos.

PRIMERO determina que tipo de pagina es:
- TIPO A: "CUENTA DE COBRO" individual — tiene encabezado "CUENTA DE COBRO", logo de alcaldia, UN solo vehiculo con su placa, conceptos desglosados (matricula, expedicion, etc), y un TOTAL A PAGAR al final.
- TIPO B: Pagina de RESUMEN o PORTADA — tiene una LISTA o TABLA con MULTIPLES placas, o dice "TOTAL PAGOS", "CONCESIONARIO", o es un listado tipo Excel con columnas FECHA/PLACA/VALOR.
- TIPO C: Pagina en blanco, indice, o cualquier otra cosa que NO sea una cuenta de cobro individual.

Si es TIPO B o TIPO C, responde inmediatamente: {"placa":"","valorTotal":0}
NO extraigas datos de paginas de resumen aunque tengan placas listadas.

Si es TIPO A (cuenta de cobro individual), extrae CARACTER POR CARACTER:

1. PLACA: formato colombiano 3 letras + 3 numeros (ej: QTP701). Aparece junto a la descripcion del vehiculo en la seccion de datos, o en el campo CEDULA/NIT seguido del numero. NO es el radicado.
2. PROPIETARIO: campo "NOMBRE O RAZON SOCIAL".
3. CEDULA: numero de documento del propietario (solo digitos).
4. VEHICULO: descripcion del vehiculo (marca, clase, tipo, modelo).
5. VALOR TOTAL: el numero en "TOTAL A PAGAR" al final de la cuenta. Numero entero sin puntos ni comas.
6. RADICADO: "RADICADO DE TRAMITE" en la parte superior.
7. TIPO TRAMITE: lee las LINEAS DE CONCEPTOS / desglose de cobro:
   - Si hay PRENDA, INSCRIPCION DE PRENDA, GARANTIA MOBILIARIA o GRAVAMEN (prenda) → "PRENDA"
   - Si solo MATRICULA INICIAL (sin prenda en conceptos) → "MATRICULA_INICIAL"
   - Si ninguno aplica claramente → "OTRO" o ""
8. FECHA TRAMITE: la fecha del tramite / fecha de la cuenta de cobro, en formato YYYY-MM-DD (ej: 2026-05-23). Si solo hay fecha de expedicion, usa esa.
9. ORGANISMO: el organismo o secretaria de transito (municipio) que emite la cuenta — aparece junto al logo de la alcaldia o en el encabezado (ej: PALMIRA, MEDELLIN, BELLO). Solo el nombre del municipio en MAYUSCULAS.
10. MARCA: la marca del vehiculo en MAYUSCULAS (ej: TESLA, CHEVROLET, RENAULT). Extraela de la descripcion del vehiculo.

PRECISION:
- Placa = exactamente 6 caracteres: 3 letras + 3 numeros
- NO confundir O con 0, I con 1, S con 5, B con 8
- El TOTAL A PAGAR es de UNA sola cuenta, NO de un lote completo. Valores tipicos: 100.000 a 500.000 pesos
- Si el valor supera 1.000.000, probablemente es una pagina de resumen → responder {"placa":"","valorTotal":0}

Responde SOLO JSON sin markdown:
{"placa":"ABC123","propietario":"NOMBRE","cedula":"123456","vehiculo":"CAMIONETA MARCA 2026","valorTotal":236700,"radicado":"1005504347","tipoTramite":"MATRICULA_INICIAL","fechaTramite":"2026-05-23","organismo":"PALMIRA","marca":"TESLA"}` },
        ] }],
      });

      const ocrResult: any = await new Promise((resolve, reject) => {
        const rq = https.request({
          method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(ocrBody) },
        }, (r2) => { let d = ''; r2.on('data', (c: string) => d += c); r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
        rq.setTimeout(60000, () => rq.destroy(new Error('Timeout')));
        rq.on('error', reject); rq.write(ocrBody); rq.end();
      });

      const ocrText = ocrResult?.content?.[0]?.text || '';
      let datos: any = null;
      try { datos = JSON.parse(ocrText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch {}

      // Descartar páginas de resumen mal parseadas: cuentas individuales en Colombia
      // están en el rango 50k–5M; valores fuera de ese rango son agregados o ruido OCR.
      const valor = Number(datos?.valorTotal) || 0;
      const VALOR_MAX_INDIVIDUAL = 5_000_000;
      if (datos?.placa && valor > 0 && valor <= VALOR_MAX_INDIVIDUAL) {
        const placa = datos.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
        cuentas.push({
          pagina: i + 1, placa, propietario: datos.propietario || '', cedula: datos.cedula || '',
          vehiculo: datos.vehiculo || '', tipoTramite: normalizarTipoTramite(datos.tipoTramite),
          fechaTramite: String(datos.fechaTramite || '').trim(),
          organismo: String(datos.organismo || '').trim(),
          marca: String(datos.marca || '').trim(),
          valorTotal: valor, radicado: datos.radicado || '',
        });

        if (!paginasPorPlaca.has(placa)) paginasPorPlaca.set(placa, []);
        paginasPorPlaca.get(placa)!.push(i);
      }
    };

    const CONCURRENCY = 5;
    for (let chunkStart = 0; chunkStart < totalPages; chunkStart += CONCURRENCY) {
      const chunkEnd = Math.min(chunkStart + CONCURRENCY, totalPages);
      const tasks: Promise<void>[] = [];
      for (let i = chunkStart; i < chunkEnd; i++) tasks.push(procesarPagina(i));
      await Promise.all(tasks);
      if (chunkEnd < totalPages) await new Promise(r => setTimeout(r, 500));
    }

    cuentas.sort((a, b) => a.pagina - b.pagina);

    // 4. Generar PDFs individuales por placa
    const outputDir = path.join(process.cwd(), 'uploads', 'cuentas-cobro', Date.now().toString());
    await mkdir(outputDir, { recursive: true });

    const archivosGenerados: { placa: string; archivo: string; paginas: number }[] = [];

    for (const [placa, paginas] of paginasPorPlaca) {
      const placaDoc = await PDFDocument.create();
      for (const pageIdx of paginas) {
        const [copied] = await placaDoc.copyPages(srcDoc, [pageIdx]);
        placaDoc.addPage(copied);
      }
      const placaBytes = await placaDoc.save();
      const filename = `${placa}.pdf`;
      await writeFile(path.join(outputDir, filename), placaBytes);
      archivosGenerados.push({ placa, archivo: filename, paginas: paginas.length });
    }

    // 4b. ZIP con TODAS las facturas, cada una nombrada con el nombre compuesto
    //     del trámite (descarga masiva). El archivo en disco/URL es `00-FACTURAS.zip`
    //     (seguro); el usuario lo recibe como "00-REINTEGROS CLIENTES - Facturas.zip".
    const cuentaPorPlaca = new Map<string, CuentaCobro>();
    for (const c of cuentas) if (!cuentaPorPlaca.has(c.placa)) cuentaPorPlaca.set(c.placa, c);
    const zipStorageName = '00-FACTURAS.zip';
    const zipDisplayName = '00-REINTEGROS CLIENTES - Facturas.zip';
    if (archivosGenerados.length > 0) {
      const archiver = (await import('archiver')).default;
      const { createWriteStream } = await import('fs');
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(path.join(outputDir, zipStorageName));
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', () => resolve());
        archive.on('error', reject);
        archive.pipe(output);
        const usados = new Set<string>();
        for (const a of archivosGenerados) {
          const cuenta = cuentaPorPlaca.get(a.placa);
          let entry = cuenta ? safeDownloadName(nombreTramite(cuenta), 'pdf') : a.archivo;
          // Evita colisiones de nombre dentro del ZIP.
          if (usados.has(entry)) entry = entry.replace(/\.pdf$/i, ` ${a.placa}.pdf`);
          usados.add(entry);
          archive.file(path.join(outputDir, a.archivo), { name: entry });
        }
        archive.finalize();
      });
    }

    // 5. Generar Excel resumen
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Resumen Cuentas');
    ws.columns = [
      { header: 'PLACA', key: 'placa', width: 12 },
      { header: 'PROPIETARIO', key: 'propietario', width: 35 },
      { header: 'CEDULA/NIT', key: 'cedula', width: 18 },
      { header: 'VEHICULO', key: 'vehiculo', width: 30 },
      { header: 'TIPO TRAMITE', key: 'tipoTramite', width: 18 },
      { header: 'VALOR TOTAL', key: 'valorTotal', width: 15 },
      { header: 'RADICADO', key: 'radicado', width: 18 },
      { header: 'PAGINA', key: 'pagina', width: 8 },
      { header: 'ARCHIVO PDF', key: 'archivoPdf', width: 20 },
    ];

    // Header style
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E3A8A' } };
    });

    const dirName = outputDir.split('/').pop() ?? '';
    const baseUrl = env.PUBLIC_URL || 'https://operaciones.flitsas.com';
    cuentas.forEach((c) => {
      const nombre = nombreTramite(c);
      const row = ws.addRow({ ...c, tipoTramite: etiquetaTipoTramite(c.tipoTramite), archivoPdf: nombre });
      // El archivo EN DISCO/URL conserva el nombre seguro `${placa}.pdf`; el
      // texto visible del hyperlink usa el nombre compuesto del trámite.
      const filename = `${c.placa}.pdf`;
      const token = signFileToken(dirName, filename);
      const dl = encodeURIComponent(safeDownloadName(nombre, 'pdf'));
      const pdfUrl = `${baseUrl}/api/public/drive/cuentas-archivo/${dirName}/${token}/${filename}?dl=${dl}`;
      row.getCell('archivoPdf').value = { text: nombre, hyperlink: pdfUrl } as any;
      row.getCell('archivoPdf').font = { color: { argb: '2563EB' }, underline: true };
    });

    // Formato moneda para valor
    ws.getColumn('valorTotal').numFmt = '#,##0';

    // Fila de total
    const totalRow = ws.addRow({
      placa: '', propietario: '', cedula: '', vehiculo: 'TOTAL', tipoTramite: '',
      valorTotal: cuentas.reduce((s, c) => s + (c.valorTotal || 0), 0),
      radicado: '', pagina: '',
    });
    totalRow.font = { bold: true };

    // Nombre EN DISCO/URL sin espacios (las rutas de descarga sanitizan
    // [^a-zA-Z0-9._-] → un espacio rompería el match y daría 404). El nombre
    // CON espacio que ve el usuario se entrega aparte como `excelFile` y el
    // frontend lo usa en `a.download` (Content-Disposition también lo respeta).
    const excelStorageName = '00-REINTEGROS-CLIENTES.xlsx';
    const excelDisplayName = '00-REINTEGROS CLIENTES.xlsx';
    const excelPath = path.join(outputDir, excelStorageName);
    await wb.xlsx.writeFile(excelPath);

    await db.update(procesamientoCuentas).set({
      nombreArchivo: name, totalPaginas: totalPages, cuentasDetectadas: cuentas.length,
      placasUnicas: paginasPorPlaca.size, valorTotal: String(cuentas.reduce((s, c) => s + (c.valorTotal || 0), 0)),
      directorioSalida: outputDir.replace(process.cwd(), ''), estado: 'completado',
    }).where(eq(procesamientoCuentas.id, registro.id));

    // URLs para el frontend: usamos el endpoint AUTHENTICATED (Bearer Token).
    // No requiere HMAC porque la auth ya valida — más simple y no se rompe con cache de browser.
    // Los hyperlinks DEL EXCEL siguen usando el endpoint público con HMAC (ya generados arriba).
    const authUrl = (filename: string) => `/api/drive/cuentas-archivo/${dirName}/${filename}`;

    res.json({
      ok: true,
      archivoOriginal: name,
      totalPaginas: totalPages,
      cuentasDetectadas: cuentas.length,
      placasUnicas: paginasPorPlaca.size,
      valorTotal: cuentas.reduce((s, c) => s + (c.valorTotal || 0), 0),
      cuentas: cuentas.map((c) => ({ ...c, downloadUrl: authUrl(`${c.placa}.pdf`), pdfFile: safeDownloadName(nombreTramite(c), 'pdf') })),
      archivos: archivosGenerados.map((a) => ({ ...a, downloadUrl: authUrl(a.archivo) })),
      excelFile: excelDisplayName,
      excelDownloadUrl: authUrl(excelStorageName),
      zipFile: archivosGenerados.length > 0 ? zipDisplayName : null,
      zipDownloadUrl: archivosGenerados.length > 0 ? authUrl(zipStorageName) : null,
      outputDir: outputDir.replace(process.cwd(), ''),
    });
  } catch (e: any) {
    log.error({ err: e.message, registroId: registro.id }, 'procesamiento cuentas falló');
    await db.update(procesamientoCuentas).set({ estado: 'error', error: e.message }).where(eq(procesamientoCuentas.id, registro.id)).catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    processingFiles.delete(fileId);
  }
});

// Endpoint authenticated (Bearer JWT) para descarga desde el frontend logueado.
// Equivale al público pero NO requiere token HMAC porque la auth ya valida.
// Útil para frontend que olvida el token (cache de browser) o para acceso programático.
router.get('/cuentas-archivo/:dir/:filename', async (req: Request, res: Response) => {
  try {
    const dir = req.params.dir.replace(/[^0-9]/g, '');
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!dir || !filename) { res.status(400).json({ error: 'Parámetros inválidos' }); return; }
    const filePath = path.join(process.cwd(), 'uploads', 'cuentas-cobro', dir, filename);
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!filePath.startsWith(uploadsDir)) { res.status(403).json({ error: 'Acceso denegado' }); return; }

    const { access: fsAccess, constants } = await import('fs/promises');
    try { await fsAccess(filePath, constants.R_OK); } catch { res.status(404).json({ error: 'Archivo no encontrado' }); return; }

    const mime = filename.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : filename.endsWith('.zip') ? 'application/zip'
      : 'application/pdf';
    res.setHeader('Content-Type', mime);
    // `?dl=` permite descargar con el nombre COMPUESTO del trámite (el archivo en
    // disco se llama `${placa}.pdf`/`00-FACTURAS.zip`). Limpieza anti header-injection.
    const dlRaw = typeof req.query.dl === 'string' ? req.query.dl : '';
    const dlName = dlRaw.replace(/[\r\n"\\]/g, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 200);
    res.setHeader('Content-Disposition', dlName
      ? `attachment; filename*=UTF-8''${encodeURIComponent(dlName)}`
      : `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  } catch { res.status(404).json({ error: 'Archivo no encontrado' }); }
});

export default router;

// Router público para descarga de archivos procesados (sin login — los hyperlinks Excel
// se distribuyen sin contexto de sesión; protegidos por token HMAC en la URL).
export const publicRouter = Router();

// Rate limit por IP: 60 descargas/minuto. Suficiente para uso normal (Excel con 50-100 placas),
// pero corta enumeración masiva de directorios.
const downloadLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas descargas, espere un minuto' },
});

publicRouter.get('/cuentas-archivo/:dir/:token/:filename', downloadLimiter, async (req: Request, res: Response) => {
  try {
    // Whitelist estricta: dir solo dígitos, token solo hex, filename caracteres seguros.
    // Esto YA evita "../" y absolutos pero es defense in depth, no la única capa.
    const dir = req.params.dir.replace(/[^0-9]/g, '');
    const token = req.params.token.replace(/[^a-f0-9]/gi, '');
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!dir || !filename || !token || token.length !== 16) {
      res.status(400).json({ error: 'Parámetros inválidos' }); return;
    }
    // Defensa adicional contra filenames patológicos (ej: ".." reducido a "..").
    if (filename.startsWith('.') || filename.includes('..')) {
      res.status(400).json({ error: 'Nombre de archivo inválido' }); return;
    }

    if (!verifyFileToken(dir, filename, token)) {
      res.status(403).json({ error: 'Token de descarga inválido' }); return;
    }

    // Defense in depth: path.normalize para colapsar /a/../b → /b, luego path.resolve a absoluto,
    // y verificar que el resultado siga DENTRO de uploadsDir. La whitelist de regex YA debería
    // bloquear todo "../" pero esta capa extra protege contra futuros refactors que la quiten.
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const filePath = path.resolve(uploadsDir, 'cuentas-cobro', dir, filename);
    const relative = path.relative(uploadsDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.status(403).json({ error: 'Acceso denegado' }); return;
    }

    const { access: fsAccess, constants } = await import('fs/promises');
    try { await fsAccess(filePath, constants.R_OK); } catch { res.status(404).json({ error: 'Archivo no encontrado' }); return; }

    const mime = filename.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : filename.endsWith('.zip') ? 'application/zip'
      : 'application/pdf';
    res.setHeader('Content-Type', mime);
    // `?dl=` permite descargar con el nombre COMPUESTO del trámite (el archivo en
    // disco se llama `${placa}.pdf`/`00-FACTURAS.zip`). Limpieza anti header-injection.
    const dlRaw = typeof req.query.dl === 'string' ? req.query.dl : '';
    const dlName = dlRaw.replace(/[\r\n"\\]/g, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 200);
    res.setHeader('Content-Disposition', dlName
      ? `attachment; filename*=UTF-8''${encodeURIComponent(dlName)}`
      : `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  } catch { res.status(404).json({ error: 'Archivo no encontrado' }); }
});
