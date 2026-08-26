import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import {
  analizarPdfDeDrive, etiquetaTipoTramite, extraccionDeCuenta, ProcesadorError, type CuentaCobro,
} from './procesador.service.js';
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
import { registrarDesdeExtraccion } from '../flito-derechos/flito-derechos.service.js';

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

    // 1-3. Descarga, OCR página a página y agrupación por placa: son idénticos a lo que hace la
    //       pestaña del Drive en Derechos de tránsito, así que viven en el servicio compartido
    //       (HU #11010). Lo que sigue —Excel, ZIP y ficheros en disco— sí es propio de esta pantalla.
    const analizado = await analizarPdfDeDrive(fileId);
    const { name, srcDoc, totalPaginas: totalPages, cuentas, paginasPorPlaca } = analizado;

    if (totalPages === 0) { res.json({ ok: true, archivoOriginal: name, totalPaginas: 0, cuentasDetectadas: 0, placasUnicas: 0, valorTotal: 0, cuentas: [], archivos: [], excelFile: null, outputDir: null }); return; }

    // 4. Generar PDFs individuales por placa
    const outputDir = path.join(process.cwd(), 'uploads', 'cuentas-cobro', Date.now().toString());
    await mkdir(outputDir, { recursive: true });

    const archivosGenerados: { placa: string; archivo: string; paginas: number }[] = [];
    const { PDFDocument } = await import('pdf-lib');

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

    // 4c. Persistir el derecho de trámite de cada placa (HU #10952). El Excel, los PDF por placa y
    //     el ZIP de arriba NO se tocan: alguien los usa hoy. Esto se suma encima, reusando la
    //     lectura que ya se hizo página a página en vez de volver a gastar OCR.
    const persistencia = { registrados: 0, enRevision: 0, pendientes: 0, duplicados: 0, fallidos: 0 };
    for (const a of archivosGenerados) {
      const cuenta = cuentaPorPlaca.get(a.placa);
      if (!cuenta) continue;
      try {
        const { readFile } = await import('fs/promises');
        const buffer = await readFile(path.join(outputDir, a.archivo));
        const r = await registrarDesdeExtraccion(
          { originalname: `${a.placa}.pdf`, mimetype: 'application/pdf', buffer, size: buffer.length },
          extraccionDeCuenta(cuenta),
          { origen: 'drive', organismoCodigo: null },
          { userId: (req as any).user!.sub, username: (req as any).user!.username, role: (req as any).user!.role },
        );
        persistencia.registrados += r.registrados.length;
        persistencia.enRevision += r.enRevision.length;
        persistencia.pendientes += r.pendientes.length;
        persistencia.duplicados += r.duplicados.length;
      } catch (e) {
        // Una placa que no se pudo persistir no invalida el procesamiento: el Excel y los PDF ya
        // están generados y son el entregable histórico de este endpoint.
        persistencia.fallidos += 1;
        log.warn({ placa: a.placa, err: (e as Error).message }, 'no se pudo persistir el derecho de trámite');
      }
    }
    log.info({ ...persistencia, placas: archivosGenerados.length }, 'derechos de trámite persistidos desde cuentas de cobro');

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
    // Anotar el fallo no puede tapar el fallo: `.catch()` solo cubre rechazos, y si el `update`
    // lanza en síncrono la petición se quedaría sin respuesta.
    try {
      await db.update(procesamientoCuentas).set({ estado: 'error', error: e.message })
        .where(eq(procesamientoCuentas.id, registro.id));
    } catch { /* el registro de auditoría es secundario */ }
    // Un PDF que no lo es, o con demasiadas páginas, es un error del usuario (400), no del
    // servidor: antes se respondía antes de entrar aquí y ahora lo lanza el servicio compartido.
    if (e instanceof ProcesadorError) { res.status(e.status).json({ error: e.message }); return; }
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
