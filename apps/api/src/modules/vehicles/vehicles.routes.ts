import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, ilike, or, sql, and, desc, type SQL } from 'drizzle-orm';
import multer from 'multer';
import { db } from '../../db/client.js';
import { vehicles, soatRequests } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { sendExcel, limitesXlsx, rechazoXlsxAHttp, bufferParaExcelJS, MIME_XLSX } from '../../shared/utils/excel.js';
import { medirXlsx } from '../../shared/utils/xlsx-zip.js';
import { audit } from '../../shared/middleware/audit.js';
import { normalizeDocument } from '../../shared/utils/crypto.js';
import { loggerFor } from '../../shared/logger.js';
import { getHistorial, generarCertificadoPdf, normalizeVin, hydratePasaporteFromLegacy } from './vehiculo-historial.js';
import { parseFechaRangoQuery, createdInRangeCondition } from '../../shared/utils/fecha-rango.js';

const log = loggerFor('vehicles');

const router = Router();

/**
 * Techo de lo que el libro puede ocupar DESCOMPRIMIDO (Bug #11682).
 *
 * Los 10 MB de multer acotan lo que viaja por la red, no lo que ocupa en el heap: un xlsx normal
 * comprime ~12:1 —medido en este repo—, así que un archivo que pasa ese tope y el magic number puede
 * traer más de 100 MB de `sheet1.xml` dentro. Ese es el archivo con el que se reprodujo el fallo:
 * 580 000 filas, 10,0 MB en disco y 122 MB por dentro. Esta ruta se comía 32,5 s de event loop y
 * +2553 MB de heap ANTES de mirar nada, y con el heap a 512 MB mataba el proceso con
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`, que ningún `try/catch` atrapa.
 *
 * ── Contra qué se calcula ───────────────────────────────────────────────────────────────────────
 * NO contra el `--max-old-space-size=4096` del Dockerfile: esa línea es de la ETAPA DE BUILD y su
 * propio comentario dice que el runtime no la hereda. En producción el API corre bajo PM2 en una
 * sola instancia fork con `max_memory_restart: '512M'` sobre el RSS (`ecosystem.config.cjs:22`), en
 * régimen de ~200 MB. Cruzar ese techo no degrada esta petición: PM2 reinicia el proceso entero y se
 * lleva por delante las peticiones en vuelo de todos los módulos.
 *
 * ── Por qué 6 MB ────────────────────────────────────────────────────────────────────────────────
 *   · El formato ancho es el de RUNT: 36 columnas, 2 375 B por fila descomprimido —medido con
 *     ExcelJS sobre 200 / 1 000 / 5 000 / 20 000 filas—. 6 MB son ~2 500 filas de ese formato, o
 *     ~21 000 del formato simple de nueve columnas.
 *   · Medido POR ESTA RUTA con un archivo justo en el techo (2 500 filas RUNT): +42 MB de heap y
 *     0,7 s. Tres a la vez son ~130 MB sobre los ~200 MB de régimen: caben bajo los 512 MB de PM2.
 *     Con 12 MB el coste medido sube a +111 MB por carga y tres simultáneas lo cruzan.
 *   · 2 500 filas ya es el techo OPERATIVO de esta ruta por otro motivo: el bucle de abajo hace un
 *     INSERT secuencial por fila. Si Operaciones necesitara cargar más vehículos de una tacada,
 *     lo que habría que cambiar no es este número, es ese bucle.
 *
 * No se copió el de Conciliación (16 MB): allí el archivo es el reporte del portal, con un tope de
 * negocio de 500 filas y 25 KB reales. Aquí el formato y el volumen son otros.
 *
 * Ninguna de estas rutas limita la CONCURRENCIA, así que el número se elige para que TRES cargas
 * simultáneas al tope quepan en el presupuesto, no una.
 */
export const VEHICULOS_CARGA_MAX_DESCOMPRIMIDO = 6 * 1024 * 1024;
const LIMITES_CARGA = limitesXlsx(VEHICULOS_CARGA_MAX_DESCOMPRIMIDO);

/**
 * Sin `fileFilter`, el content-type que declara el cliente viaja intacto hasta el parser. El criterio
 * es el mismo que ya usa `flito-conciliacion.routes.ts`; el olfateo real de los bytes va después, con
 * `medirXlsx`, porque multer no puede hacerlo sin el buffer completo (AGENTS.md 17).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
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
        error: codigo === 'LIMIT_FILE_SIZE'
          ? 'El archivo no puede superar 10 MB'
          : (err instanceof Error ? err.message : 'Archivo inválido'),
      });
      return;
    }
    next();
  });
}

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.use(authMiddleware);

const vehicleSchema = z.object({
  vin: z.string().min(1).max(17),
  plate: z.string().max(10).optional().nullable(),
  ownerName: z.string().max(200).optional().nullable(),
  // Normalizado antes de persistir: "1.036.640.908" → "1036640908". Permite que privacy/forget matchee.
  ownerDocument: z.string().max(20).optional().nullable().transform((v) => v == null ? v : normalizeDocument(v) || null),
  brand: z.string().max(50).optional().nullable(),
  model: z.string().max(50).optional().nullable(),
  year: z.number().int().optional().nullable(),
  vehicleClass: z.string().max(50).optional().nullable(),
  notes: z.string().optional().nullable(),
});

// List vehicles with latest SOAT status
router.get('/', async (req: Request, res: Response) => {
  const search = req.query.search ? (req.query.search as string).slice(0, 100) : undefined;
  const status = req.query.status as string | undefined;
  const rango = parseFechaRangoQuery(req.query as Record<string, unknown>);
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  let query = db.select({
    id: vehicles.id,
    vin: vehicles.vin,
    plate: vehicles.plate,
    ownerName: vehicles.ownerName,
    ownerDocument: vehicles.ownerDocument,
    brand: vehicles.brand,
    model: vehicles.model,
    year: vehicles.year,
    vehicleClass: vehicles.vehicleClass,
    notes: vehicles.notes,
    stage: vehicles.stage,
    clientId: vehicles.clientId,
    taxPaid: vehicles.taxPaid,
    createdAt: vehicles.createdAt,
    multasEstado: vehicles.multasEstado,
    multasTotal: vehicles.multasTotal,
    multasCount: vehicles.multasCount,
    multasConsultadoAt: vehicles.multasConsultadoAt,
    soatStatus: soatRequests.status,
    policyNumber: soatRequests.policyNumber,
    insurer: soatRequests.insurer,
    expiryDate: soatRequests.expiryDate,
  })
    .from(vehicles)
    .leftJoin(
      soatRequests,
      sql`${soatRequests.vehicleId} = ${vehicles.id} AND ${soatRequests.id} = (
        SELECT MAX(sr2.id) FROM soat_requests sr2 WHERE sr2.vehicle_id = ${vehicles.id}
      )`
    )
    .$dynamic();

  const conditions: SQL[] = [];
  const rangoCond = createdInRangeCondition(vehicles.createdAt, rango);
  if (rangoCond) conditions.push(rangoCond);
  if (search) {
    const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');
    const safeSearch = escapeLike(search);
    const searchCond = or(
      ilike(vehicles.vin, `%${safeSearch}%`),
      ilike(vehicles.plate, `%${safeSearch}%`),
      ilike(vehicles.ownerName, `%${safeSearch}%`),
      ilike(vehicles.ownerDocument, `%${safeSearch}%`)
    );
    if (searchCond) conditions.push(searchCond);
  }
  if (conditions.length === 1) query = query.where(conditions[0]!);
  else if (conditions.length > 1) query = query.where(and(...conditions));

  const result = await query.orderBy(desc(vehicles.createdAt));

  const filtered = status ? result.filter((r) => (r.soatStatus || 'sin_solicitud') === status) : result;
  const masked = (req.user!.role !== 'admin') ? filtered.map((r: any) => ({
    ...r,
    ownerDocument: r.ownerDocument ? r.ownerDocument.slice(0, 4) + '****' : null,
  })) : filtered;
  res.json(masked.slice(offset, offset + limit));
});

// Create single vehicle
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = vehicleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const existing = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, parsed.data.vin)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: 'VIN ya existe' });
    return;
  }

  const [vehicle] = await db.insert(vehicles).values({
    ...parsed.data,
    updatedAt: new Date(),
  }).returning();

  await audit(req, { action: 'create', resource: 'vehicle', resourceId: String(vehicle.id), detail: `VIN: ${vehicle.vin}` });
  res.status(201).json(vehicle);
});

// Update vehicle (assign plate, etc.)
router.patch('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = vehicleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos' });
    return;
  }

  const [updated] = await db.update(vehicles).set({
    ...parsed.data,
    updatedAt: new Date(),
  }).where(eq(vehicles.id, id)).returning();

  if (!updated) {
    res.status(404).json({ error: 'Vehículo no encontrado' });
    return;
  }

  res.json(updated);
});

// Bulk upload from Excel (auto-detect RUNT format or simple format)
router.post('/upload', requireRole('admin'), recibirXlsx, async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Archivo requerido' });
    return;
  }

  // ANTES de abrir el libro: `load` descomprime y materializa el archivo entero en el heap, así que
  // un tope mirado sobre el libro ya cargado llega tarde (Bug #11682). Ver shared/utils/xlsx-zip.ts.
  const medida = await medirXlsx(req.file.buffer, LIMITES_CARGA);
  if (medida.estado !== 'ok') {
    const { status, mensaje } = rechazoXlsxAHttp(medida, LIMITES_CARGA);
    log.warn({ estado: medida.estado }, 'xlsx de carga masiva rechazado sin abrirlo');
    res.status(status).json({ error: mensaje });
    return;
  }

  const workbook = new (await import('exceljs')).default.Workbook();
  await workbook.xlsx.load(bufferParaExcelJS(req.file.buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) { res.status(400).json({ error: 'Hoja vacía' }); return; }

  // Detect format — map headers by column number, normalize removing accents
  const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const colMap: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, col) => { colMap[norm(cell.text || '')] = col; });

  const col = (name: string) => colMap[norm(name)] || 0;
  const isRunt = !!col('Numero de VIN') || !!col('Numero de Placa');

  log.info({ format: isRunt ? 'RUNT' : 'simple' }, 'upload format detectado');

  const rows: any[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = (name: string, fallback: number) => row.getCell(col(name) || fallback).text?.trim() || null;
    let v: any;
    if (isRunt) {
      const vin = cell('Numero de VIN', 18);
      const plate = cell('Numero de Placa', 36);
      if (!vin && !plate) return;
      v = {
        vin: vin || plate || '',
        plate: plate,
        ownerName: cell('Nombres del Comprador', 20),
        ownerDocument: cell('Numero de Documento Comprador', 22),
        brand: cell('Marca de Vehiculo', 6),
        model: cell('Linea de Vehiculo', 7),
        year: parseInt(cell('Modelo Vehiculo', 9) || '') || null,
        vehicleClass: cell('Clase Vehiculo', 5),
        notes: [
          cell('Estado de Proceso', 28),
          cell('Placa Preasignada', 34) !== '0' && cell('Placa Preasignada', 34) ? `Preasignada: ${cell('Placa Preasignada', 34)}` : null,
          cell('id', 1) ? `ID: ${cell('id', 1)}` : null,
          cell('Correo Comprador', 35) ? `Email: ${cell('Correo Comprador', 35)}` : null,
          cell('Telefono del Comprador', 25) ? `Tel: ${cell('Telefono del Comprador', 25)}` : null,
        ].filter(Boolean).join(' | ') || null,
        stage: 'ingreso',
      };
    } else {
      const vin = row.getCell(1).text?.trim();
      if (!vin) return;
      v = { vin, plate: row.getCell(2).text?.trim() || null, ownerName: row.getCell(3).text?.trim() || null, ownerDocument: row.getCell(4).text?.trim() || null, brand: row.getCell(5).text?.trim() || null, model: row.getCell(6).text?.trim() || null, year: parseInt(row.getCell(7).text) || null, vehicleClass: row.getCell(8).text?.trim() || null, notes: row.getCell(9).text?.trim() || null };
    }
    rows.push(v);
  });

  if (rows.length === 0) {
    res.status(400).json({ error: 'No se encontraron datos en el archivo' });
    return;
  }

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await db.insert(vehicles).values({ ...row, updatedAt: new Date() }).onConflictDoNothing().returning({ id: vehicles.id });
      if (result.length > 0) inserted++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  await audit(req, { action: 'upload', resource: 'vehicle', detail: `Carga masiva: ${inserted} insertados, ${skipped} omitidos de ${rows.length}` });
  res.json({ total: rows.length, inserted, skipped });
});

// Export vehicles to Excel
router.get('/export', requireRole('admin'), async (req: Request, res: Response) => {
  const result = await db.select().from(vehicles);

  await sendExcel(res, 'vehiculos.xlsx', [
    { header: 'VIN', key: 'vin', width: 20 },
    { header: 'Placa', key: 'plate', width: 12 },
    { header: 'Propietario', key: 'ownerName', width: 25 },
    { header: 'Documento', key: 'ownerDocument', width: 15 },
    { header: 'Marca', key: 'brand', width: 15 },
    { header: 'Modelo', key: 'model', width: 15 },
    { header: 'Año', key: 'year', width: 8 },
    { header: 'Clase', key: 'vehicleClass', width: 15 },
    { header: 'Notas', key: 'notes', width: 30 },
  ], result);
});

// Delete vehicle
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

  // C2: Check + delete en transacción
  const result = await db.transaction(async (tx) => {
    const active = await tx.select({ id: soatRequests.id }).from(soatRequests).where(eq(soatRequests.vehicleId, id)).limit(1);
    if (active.length > 0) return { error: 'No se puede eliminar: tiene solicitudes SOAT asociadas' };
    const [deleted] = await tx.delete(vehicles).where(eq(vehicles.id, id)).returning({ id: vehicles.id });
    return deleted ? { ok: true } : { error: 'Vehículo no encontrado', status: 404 };
  });
  if ('error' in result) { res.status((result as any).status || 409).json({ error: result.error }); return; }
  const deleted = true;
  if (!deleted) {
    res.status(404).json({ error: 'Vehículo no encontrado' });
    return;
  }

  res.json({ ok: true });
});

// Registrar resultado de consulta SIMIT (multas de tránsito).
// Operación manual: el operador consulta SIMIT externamente y registra el resultado.
const multasSchema = z.object({
  estado: z.enum(['sin_multas', 'con_multas', 'acuerdo_pago']),
  total: z.number().min(0).max(999_999_999).optional(),
  count: z.number().int().min(0).max(999).optional(),
  notas: z.string().max(500).optional(),
}).refine(
  (d) => d.estado !== 'con_multas' || (typeof d.total === 'number' && d.total > 0 && typeof d.count === 'number' && d.count > 0),
  { message: 'Si hay multas, total y cantidad deben ser mayores a 0', path: ['total'] },
);

router.patch('/:id/multas', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = multasSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  // Si estado es 'sin_multas' forzamos total y count a 0 para coherencia.
  const total = data.estado === 'sin_multas' ? 0 : (data.total ?? 0);
  const count = data.estado === 'sin_multas' ? 0 : (data.count ?? 0);

  const [updated] = await db.update(vehicles).set({
    multasEstado: data.estado,
    multasTotal: String(total),
    multasCount: count,
    multasConsultadoAt: new Date(),
    multasNotas: data.notas ?? null,
    updatedAt: new Date(),
  }).where(eq(vehicles.id, id)).returning({
    id: vehicles.id,
    plate: vehicles.plate,
    multasEstado: vehicles.multasEstado,
    multasTotal: vehicles.multasTotal,
    multasCount: vehicles.multasCount,
    multasConsultadoAt: vehicles.multasConsultadoAt,
    multasNotas: vehicles.multasNotas,
  });

  if (!updated) { res.status(404).json({ error: 'Vehículo no encontrado' }); return; }

  await audit(req, {
    action: 'update', resource: 'vehicle', resourceId: String(id),
    detail: `Multas: ${data.estado}${count ? ` (${count} comparendos · $${total.toLocaleString('es-CO')})` : ''}`,
  });
  res.json(updated);
});

// Update vehicle stage (pipeline)
router.patch('/:id/stage', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const { stage } = req.body;
  const validStages = ['ingreso', 'impuesto', 'soat_pendiente', 'soat_comprado', 'soat_verificado', 'listo'];
  if (!validStages.includes(stage)) { res.status(400).json({ error: 'Etapa inválida' }); return; }
  const [updated] = await db.update(vehicles).set({ stage, updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'Vehículo no encontrado' }); return; }
  await audit(req, { action: 'update', resource: 'vehicle', resourceId: String(id), detail: `Etapa → ${stage}` });
  res.json(updated);
});

// Assign client to vehicle
router.patch('/:id/client', requireRole('admin'), async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }
  const { clientId } = req.body;
  const [updated] = await db.update(vehicles).set({ clientId: clientId || null, updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'Vehículo no encontrado' }); return; }
  res.json(updated);
});

// Pipeline stats (?desde=&hasta= o ?fecha= — mismo criterio que listado)
router.get('/pipeline/stats', requireRole('admin'), async (req: Request, res: Response) => {
  const rangoCond = createdInRangeCondition(vehicles.createdAt, parseFechaRangoQuery(req.query as Record<string, unknown>));
  let statsQuery = db.select({ stage: vehicles.stage, count: sql<number>`count(*)::int` }).from(vehicles).$dynamic();
  if (rangoCond) statsQuery = statsQuery.where(rangoCond);
  const result = await statsQuery.groupBy(vehicles.stage);
  const stats: Record<string, number> = { ingreso: 0, impuesto: 0, soat_pendiente: 0, soat_comprado: 0, soat_verificado: 0, listo: 0 };
  result.forEach((r) => { stats[r.stage] = r.count; });
  res.json(stats);
});

// TRAM-INNOV B1 — pasaporte vehicular: historial encadenado + certificado.
// Rutas de 2 segmentos por VIN; no colisionan con las de `/:id` (numéricas).
router.get('/:vin/historial', async (req: Request, res: Response) => {
  const vin = normalizeVin(req.params.vin);
  if (!vin) { res.status(400).json({ error: 'VIN inválido' }); return; }
  res.json(await getHistorial(vin, { hydrate: true }));
});

router.post('/:vin/historial/sync', async (req: Request, res: Response) => {
  const vin = normalizeVin(req.params.vin);
  if (!vin) { res.status(400).json({ error: 'VIN inválido' }); return; }
  const added = await hydratePasaporteFromLegacy(vin);
  const resultado = await getHistorial(vin, { hydrate: false });
  res.json({ ...resultado, imported: added });
});

router.get('/:vin/certificado', async (req: Request, res: Response) => {
  const vin = normalizeVin(req.params.vin);
  if (!vin) { res.status(400).json({ error: 'VIN inválido' }); return; }
  const resultado = await getHistorial(vin);
  if (resultado.eventos.length === 0) { res.status(404).json({ error: 'Sin historial para este VIN' }); return; }
  const pdf = await generarCertificadoPdf(resultado);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="pasaporte_${vin}.pdf"`);
  res.send(pdf);
});

export default router;
