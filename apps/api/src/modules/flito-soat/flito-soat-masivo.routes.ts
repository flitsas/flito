// FLITO — SOAT, canal Cliente: carga masiva sin trámite (HTTP). HU #14131 (Feature #14013, ADR-0032).
// Diseño: docs/diseno-feature-14013-14014-carga-masiva-soat.md §5. Montado en `/api/flito/soat`, ANTES del
// router del canal Cliente (ver `app.ts`).
//
//   GET  /cliente/masivo/plantilla?tipo=renovacion|inicial — plantilla XLSX (solo encabezados; GET legítimo: sin PII).
//   POST /cliente/masivo                           — multipart `archivo` + `tipo` (+ `companiaId`): crea el lote `en_cola`.
//   GET  /cliente/masivo/:loteId                   — avance del lote (contadores y filas; placa/vehículo efímeros, un registro PII por lote); 404 fuera de alcance.
//   GET  /cliente/masivo/:loteId/rechazadas        — XLSX de rechazadas + «Motivo» (HU #14133; PII, un registro por descarga).
//
// Todas con `authMiddleware` + `exigirFuncion('soat.solicitud.crear')` (la del alta; sin función nueva).
// Limiters propios (NO `soatClienteLimiter`: el sondeo lo agotaría), ANTES de multer. El XLSX viaja en el
// cuerpo y nunca se persiste; en la URL solo el uuid opaco del lote.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { contextoSoat } from './flito-soat.service.js';
import { SolicitudSoatError } from './flito-soat-cliente.service.js';
import { ClienteNoOperableError } from '../clients/cliente-operable.js';
import { ErrorLoteMasivo, falloMasivo } from './flito-soat-masivo.errors.js';
import { avanceLote, crearLoteMasivo } from './flito-soat-masivo.service.js';
import { soatMasivoAltaLimiter, soatMasivoDescargaLimiter, soatMasivoLecturaLimiter } from './flito-soat-masivo.limiters.js';
import { NOMBRE_ARCHIVO_PLANTILLA, generarPlantilla, type TipoPlantillaMasivo } from './flito-soat-masivo-plantilla.js';
import { registrarAltaLoteMasivo, registrarDescargaRechazadasMasivo, registrarLecturaFilasMasivo } from './flito-soat-masivo.pii.js';
import { descargarRechazadas, nombreArchivoRechazadas } from './flito-soat-masivo-descarga.js';
import { MAX_BYTES } from './flito-soat-masivo-parse.js';

const router = Router();
router.use(authMiddleware);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * multer en memoria: 1 archivo, 1 MB, campos acotados. El `fileFilter` solo corta por extensión (barato);
 * el `Content-Type` lo declara el cliente y no vale: la verificación REAL por bytes (firma PK, partes
 * OOXML, tope descomprimido) la hace `parsearXlsxRenovacion` antes de tocar exceljs.
 */
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 256, parts: 8 },
  fileFilter: (_req, file, cb) => {
    if (!/\.xlsx$/i.test(file.originalname || '')) {
      cb(falloMasivo(400, 'formato_invalido', 'Solo se aceptan archivos Excel .xlsx.'));
      return;
    }
    cb(null, true);
  },
}).single('archivo');

function recibirArchivo(req: Request, res: Response, next: NextFunction): void {
  subida(req, res, (err?: unknown) => {
    if (!err) { next(); return; }
    if (err instanceof ErrorLoteMasivo) { responder(res, err); return; }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') { responder(res, falloMasivo(413, 'archivo_muy_grande', 'El archivo supera 1 MB.')); return; }
      responder(res, falloMasivo(400, 'formato_invalido', 'No se pudo leer el archivo enviado.'));
      return;
    }
    next(err);
  });
}

function responder(res: Response, e: ErrorLoteMasivo): void {
  res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.datos ?? {}) });
}

const altaSchema = z.object({
  tipo: z.string().trim().default('renovacion'),
  companiaId: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.coerce.number().int().positive().nullable().optional(),
  ),
});
const idSchema = z.string().guid();

router.get('/cliente/masivo/plantilla', exigirFuncion('soat.solicitud.crear'), soatMasivoLecturaLimiter,
  async (req: Request, res: Response) => {
    const tipo = req.query.tipo ?? 'renovacion';
    if (tipo !== 'renovacion' && tipo !== 'inicial') {
      responder(res, falloMasivo(400, 'tipo_invalido', 'El tipo de plantilla no es válido.')); return;
    }
    const buf = await generarPlantilla(tipo as TipoPlantillaMasivo);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${NOMBRE_ARCHIVO_PLANTILLA[tipo as TipoPlantillaMasivo]}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

/**
 * HU #14132: sin worker no hay quien procese el lote, y un lote `en_cola` bloquea a su compañía (índice de un
 * lote activo). Con `SOAT_MASIVO_WORKER_ENABLED=0` (apagado explícito; el defecto es encendido) el alta responde 503 ANTES del limiter y de multer,
 * sin leer el archivo ni crear nada. La plantilla y el avance siguen disponibles.
 */
const exigirWorkerEncendido = (_req: Request, res: Response, next: NextFunction): void => {
  if (env.SOAT_MASIVO_WORKER_ENABLED) { next(); return; }
  responder(res, falloMasivo(503, 'carga_masiva_no_disponible', 'La carga masiva no está disponible por ahora.'));
};

router.post('/cliente/masivo', exigirFuncion('soat.solicitud.crear'), exigirWorkerEncendido, soatMasivoAltaLimiter, recibirArchivo,
  async (req: Request, res: Response) => {
    try {
      if (!req.file) { responder(res, falloMasivo(400, 'archivo_requerido', 'Adjunta el archivo Excel de la carga.')); return; }
      const campos = altaSchema.safeParse(req.body ?? {});
      if (!campos.success) { responder(res, falloMasivo(400, 'tipo_invalido', 'Los datos de la carga no son válidos.')); return; }
      const ctx = await contextoSoat(req.user!);
      const lote = await crearLoteMasivo(req.file.buffer, campos.data.tipo, ctx, campos.data.companiaId ?? null);
      // AC9: un único registro de acceso PII por lote (conteo de filas; sin datos de filas).
      await registrarAltaLoteMasivo(req, { id: lote.loteId, tipo: lote.tipo, filas: lote.total });
      await audit(req, { action: 'upload', resource: 'flito_soat_masivo_lote', resourceId: lote.loteId,
        detail: `Carga masiva de SOAT (${lote.tipo}): ${lote.total} filas, ${lote.rechazadasDeEntrada} rechazadas de entrada` });
      res.status(201).json(lote);
    } catch (e) {
      if (e instanceof ErrorLoteMasivo) { responder(res, e); return; }
      if (e instanceof SolicitudSoatError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
      if (e instanceof ClienteNoOperableError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  });

router.get('/cliente/masivo/:loteId', exigirFuncion('soat.solicitud.crear'), soatMasivoLecturaLimiter,
  async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.loteId).success) { res.status(404).json({ error: 'La carga no existe' }); return; }
    const ctx = await contextoSoat(req.user!);
    const avance = await avanceLote(req.params.loteId, ctx);
    // 404 y no 403 fuera de alcance: no se confirma que el lote exista.
    if (!avance) { res.status(404).json({ error: 'La carga no existe' }); return; }
    // HU #14134: UN registro PII por lote y usuario al devolver filas con placa/VIN (no uno por sondeo).
    if (avance.filas.some((f) => f.placa || f.vin)) await registrarLecturaFilasMasivo(req, { id: avance.loteId, filas: avance.filas.length }, req.user!.sub);
    res.setHeader('Cache-Control', 'no-store');
    res.json(avance);
  });

router.get('/cliente/masivo/:loteId/rechazadas', exigirFuncion('soat.solicitud.crear'), soatMasivoDescargaLimiter,
  async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.loteId).success) { res.status(404).json({ error: 'La carga no existe' }); return; }
    try {
      const ctx = await contextoSoat(req.user!);
      const d = await descargarRechazadas(req.params.loteId, ctx);
      if (!d) { res.status(404).json({ error: 'La carga no existe' }); return; }
      await registrarDescargaRechazadasMasivo(req, { id: d.loteId, filas: d.filas });
      await audit(req, { action: 'export', resource: 'flito_soat_masivo_lote', resourceId: d.loteId,
        detail: `Descarga de rechazadas de la carga masiva de SOAT: ${d.filas} filas` });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoRechazadas(d.tipo)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(d.buffer);
    } catch (e) {
      if (e instanceof ErrorLoteMasivo) { responder(res, e); return; }
      throw e;
    }
  });

export default router;
