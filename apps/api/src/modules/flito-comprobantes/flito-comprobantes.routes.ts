// Comprobantes universales (HTTP) — Épica #12245, Feature #12605 (HU #12611) y Feature #12606
// (HU #12629). Montado en /api/flito/comprobantes. Ocho rutas, cada una con su función del motor de
// permisos (el módulo nace reconducido: ninguna guarda `requireRole`). Errores `ErrorComprobanteDto`
// (`ComprobanteError.cuerpo()`); `Cache-Control: no-store` en el detalle, el archivo, los candidatos
// y el buscador (llaves de vehículo y URL prefirmada).
//
// F2 (0201): `POST /tramites/buscar` por BODY (la llave no va en la URL ni en los logs de acceso),
// `POST /:id/aplicar` (esqueleto: adjuntar documentación; los pagos responden 409 hasta HU-2/HU-3) y
// `POST /:id/descartar`. Aceptar diferencia (F3) llega con su migración y su ruta.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  ASOCIACIONES_COMPROBANTE, CARGA_MASIVA_ARCHIVOS_POR_PETICION, CARGA_MASIVA_MAX_BYTES_ARCHIVO, CodigoErrorComprobante,
  CONCEPTOS_COSTO, ESTADOS_COMPROBANTE, MOTIVOS_PENDIENTE_COMPROBANTE, type AsociacionComprobante, type ConceptoCosto,
  type EstadoComprobante, type MotivoPendienteComprobante,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { comprobantesCargaLimiter } from '../../shared/middleware/rateLimiter.js';
import { esUuid } from '../../shared/utils/uuid.js';
import { cargarLote, type ArchivoCargado } from './flito-comprobantes.carga.js';
import { ComprobanteError, detalle, listar, releer, urlArchivo, type ComprobanteCtx } from './flito-comprobantes.service.js';
import { candidatosPorTexto } from './flito-comprobantes.cruce.js';
import { aplicar, descartar, motivoSchema } from './flito-comprobantes.aplicar.js';

export { aplicarSchema } from './flito-comprobantes.aplicar.js';

const router = Router();
router.use(authMiddleware);

const ctxDe = (user: { sub: number; username: string }): ComprobanteCtx => ({ userId: user.sub, username: user.username });

/**
 * `:id` sin forma de uuid → 404 `no_encontrado` (AC9): antes llegaba a la base y moría en 22P02 como
 * 500. Es la misma regla que la columna `uuid` acepta (`esUuid`), no una regex propia.
 */
function exigirIdUuid(req: Request, res: Response, next: () => void): void {
  if (!esUuid(req.params.id)) { res.status(404).json({ error: 'El comprobante no existe', codigo: CodigoErrorComprobante.NO_ENCONTRADO }); return; }
  next();
}

// ── Carga: 1..5 archivos por envío, 15 MiB cada uno, sin ZIP ─────────────────────────────────────
// Sin `fileFilter` por MIME: el tipo que decide es la CABECERA real, que lee `cargarLote` archivo a
// archivo (un `.pdf` que no empieza por %PDF va a `fallidos`, no tumba el envío entero). Multer solo
// pone los topes de cantidad y peso, que sí son del envío y sí son 400.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CARGA_MASIVA_MAX_BYTES_ARCHIVO, files: CARGA_MASIVA_ARCHIVOS_POR_PETICION },
});
/** Motivos de multer traducidos, sin eco del nombre ni del MIME que mandó el cliente. */
const MOTIVO_MULTER: Record<string, string> = {
  LIMIT_FILE_SIZE: 'Un archivo supera los 15 MB',
  LIMIT_FILE_COUNT: `Máximo ${CARGA_MASIVA_ARCHIVOS_POR_PETICION} archivos por envío`,
  LIMIT_UNEXPECTED_FILE: 'Los archivos van en el campo "archivos"',
};
/** Envuelve a multer para que sus rechazos salgan como 400 con `codigo` y no como el 500 genérico. */
function recibirArchivos(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.array('archivos', CARGA_MASIVA_ARCHIVOS_POR_PETICION)(req, res, (err: unknown) => {
    if (err) {
      const motivo = err instanceof multer.MulterError ? MOTIVO_MULTER[err.code] : undefined;
      res.status(400).json({ error: motivo ?? 'Archivo inválido', codigo: CodigoErrorComprobante.ARCHIVO_INVALIDO });
      return;
    }
    next();
  });
}

const aArchivo = (f: Express.Multer.File): ArchivoCargado => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size });

export const cargaSchema = z.object({ loteId: z.string().uuid() });

// El limitador va DELANTE de multer (AC9): un exceso se frena antes de leer 75 MB de cuerpo.
router.post('/', exigirFuncion('comprobantes.lote.cargar'), comprobantesCargaLimiter, recibirArchivos, async (req: Request, res: Response) => {
  const parsed = cargaSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'loteId inválido', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo', codigo: CodigoErrorComprobante.ARCHIVO_INVALIDO }); return; }
  try {
    const resultado = await cargarLote(files.map(aArchivo), parsed.data.loteId, ctxDe(req.user!));
    await audit(req, { action: 'upload', resource: 'flito_comprobante_lote', resourceId: parsed.data.loteId,
      detail: `Envío de ${files.length} archivo(s): ${resultado.documentos} documento(s), ${resultado.pendientes.length} pendiente(s), ${resultado.duplicados.length} duplicado(s), ${resultado.fallidos.length} fallido(s).` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

// ── Cola ─────────────────────────────────────────────────────────────────────────────────────────
export const listarSchema = z.object({
  estado: z.enum(ESTADOS_COMPROBANTE as [EstadoComprobante, ...EstadoComprobante[]]).optional(),
  concepto: z.enum(CONCEPTOS_COSTO as [ConceptoCosto, ...ConceptoCosto[]]).optional(),
  motivo: z.enum(MOTIVOS_PENDIENTE_COMPROBANTE as [MotivoPendienteComprobante, ...MotivoPendienteComprobante[]]).optional(),
  loteId: z.string().uuid().optional(),
  tramiteId: z.string().uuid().optional(),
  asociacion: z.enum(ASOCIACIONES_COMPROBANTE as unknown as [AsociacionComprobante, ...AsociacionComprobante[]]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', exigirFuncion('comprobantes.cola.ver'), async (req: Request, res: Response) => {
  const parsed = listarSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtros inválidos', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  try { res.json(await listar(parsed.data)); } catch (e) { handleError(res, e); }
});

// ── Buscador de trámites: por BODY, para que la llave no quede en la URL ni en los logs de acceso ──
export const buscarTramitesSchema = z.object({ buscar: z.string().trim().min(3).max(60) });

router.post('/tramites/buscar', exigirFuncion('comprobantes.tramites.buscar'), async (req: Request, res: Response) => {
  const parsed = buscarTramitesSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Escribe entre 3 y 60 caracteres', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  try {
    const candidatos = await candidatosPorTexto(parsed.data.buscar);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ candidatos });
  } catch (e) { handleError(res, e); }
});

// ── Detalle ──────────────────────────────────────────────────────────────────────────────────────
router.get('/:id', exigirFuncion('comprobantes.comprobante.ver'), exigirIdUuid, async (req: Request, res: Response) => {
  try {
    const dto = await detalle(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(dto);
  } catch (e) { handleError(res, e); }
});

// ── Archivo: URL prefirmada de corta vida (calco de flito-revisiones) ────────────────────────────
router.get('/:id/archivo', exigirFuncion('comprobantes.archivo.descargar'), exigirIdUuid, async (req: Request, res: Response) => {
  try {
    const url = await urlArchivo(req.params.id, req.query.aplicado === '1');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  } catch (e) { handleError(res, e); }
});

// ── Releer: solo sobre `ocr_no_disponible`; nunca crea filas ─────────────────────────────────────
router.post('/:id/releer', exigirFuncion('comprobantes.comprobante.releer'), exigirIdUuid, async (req: Request, res: Response) => {
  try {
    const dto = await releer(req.params.id, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_comprobante', resourceId: req.params.id, detail: `Comprobante releído: ${dto.motivoPendiente}.` });
    res.setHeader('Cache-Control', 'no-store');
    res.json(dto);
  } catch (e) { handleError(res, e); }
});

// ── Aplicar: 404 → 409 ya_resuelto → 400 → (pago: 409 destino_no_admite, eslabón) → tx con FOR UPDATE ─
router.post('/:id/aplicar', exigirFuncion('comprobantes.comprobante.aplicar'), exigirIdUuid, async (req: Request, res: Response) => {
  try {
    const comprobante = await aplicar(req.params.id, req.body, ctxDe(req.user!));
    await audit(req, { action: 'update', resource: 'flito_comprobante', resourceId: req.params.id,
      detail: `Comprobante adjuntado como documentación del trámite ${comprobante.tramite?.idFlit ?? '—'} (${comprobante.concepto}, cruce ${comprobante.cruce}).` });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ resultado: 'aplicado', comprobante });
  } catch (e) { handleError(res, e); }
});

// ── Descartar: libera el archivo solo si ningún otro comprobante vivo lo comparte ─────────────────
router.post('/:id/descartar', exigirFuncion('comprobantes.comprobante.descartar'), exigirIdUuid, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'El motivo va entre 5 y 500 caracteres', codigo: CodigoErrorComprobante.DATOS_INVALIDOS }); return; }
  try {
    await descartar(req.params.id, parsed.data.motivo, ctxDe(req.user!));
    await audit(req, { action: 'delete', resource: 'flito_comprobante', resourceId: req.params.id, detail: `Comprobante descartado: ${parsed.data.motivo}` });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

function handleError(res: Response, e: unknown): void {
  if (e instanceof ComprobanteError) { res.status(e.status).json(e.cuerpo()); return; }
  throw e;
}

export default router;
