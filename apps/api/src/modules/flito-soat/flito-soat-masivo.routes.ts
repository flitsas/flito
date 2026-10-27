// FLITO — SOAT, canal Cliente: carga masiva sin trámite (HTTP). HU #14131 (Feature #14013, ADR-0032).
// Diseño: docs/diseno-feature-14013-14014-carga-masiva-soat.md §5. Montado en `/api/flito/soat`, ANTES del
// router del canal Cliente (ver `app.ts`).
//
//   GET  /cliente/masivo/plantilla?tipo=renovacion — plantilla XLSX (solo encabezados; GET legítimo: sin PII).
//   POST /cliente/masivo                           — multipart `archivo` + `tipo` (+ `companiaId`): crea el lote `en_cola`.
//   GET  /cliente/masivo/:loteId                   — avance del lote (contadores, sin PII); 404 fuera de alcance.
//
// Todas con `authMiddleware` + `exigirFuncion('soat.solicitud.crear')` (la del alta; sin función nueva).
// Limiters propios (NO `soatClienteLimiter`: el sondeo lo agotaría), ANTES de multer. El XLSX viaja en el
// cuerpo y nunca se persiste; en la URL solo el uuid opaco del lote.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { contextoSoat } from './flito-soat.service.js';
import { SolicitudSoatError } from './flito-soat-cliente.service.js';
import { ClienteNoOperableError } from '../clients/cliente-operable.js';
import { ErrorLoteMasivo, falloMasivo } from './flito-soat-masivo.errors.js';
import { avanceLote, crearLoteMasivo } from './flito-soat-masivo.service.js';
import { soatMasivoAltaLimiter, soatMasivoLecturaLimiter } from './flito-soat-masivo.limiters.js';
import { NOMBRE_ARCHIVO_PLANTILLA, generarPlantillaRenovacion } from './flito-soat-masivo-plantilla.js';
import { registrarAltaLoteMasivo } from './flito-soat-masivo.pii.js';
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
    if (req.query.tipo !== undefined && req.query.tipo !== 'renovacion') {
      responder(res, falloMasivo(400, 'tipo_invalido', 'El tipo de plantilla no es válido.')); return;
    }
    const buf = await generarPlantillaRenovacion();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${NOMBRE_ARCHIVO_PLANTILLA.renovacion}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

router.post('/cliente/masivo', exigirFuncion('soat.solicitud.crear'), soatMasivoAltaLimiter, recibirArchivo,
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
    res.setHeader('Cache-Control', 'no-store');
    res.json(avance);
  });

export default router;
