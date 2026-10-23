// FLITO — Expediente documental de la COMPAÑÍA en bolsas (HTTP). Montado en /api/flito/bolsas-documentos
// con `conAlcance('bolsas', …)` (HU #13889, Feature #13888, ADR-0028 §5).
//
// Solo personal FLIT: cada ruta lleva `soloSinEnlace()` además de su `exigirFuncion` (D9), así que el
// enlace `compania` queda cerrado aunque la frontera le abra `bolsas`. Las acciones `bolsas.documentos.*`
// solo se siembran marcadas a `admin` (regla del repo: admin tiene todas); a cualquier otro rol (p. ej.
// Financiera) se las asigna el admin a mano desde Permisos.
//
// Ninguna ruta lleva PII en la URL: `companiaId` y `documentoId` son ids opacos. Los logs y la auditoría
// nunca llevan el nombre del archivo ni su contenido.
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  MIMES_DOCUMENTO_BOLSA, TAMANO_MAX_DOCUMENTO_BOLSA, TIPOS_DOCUMENTO_BOLSA, type MimeDocumentoBolsa,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { soloSinEnlace } from '../../shared/middleware/frontera-enlace.js';
import { audit } from '../../shared/middleware/audit.js';
import { bolsasDocumentosCargaLimiter } from '../../shared/middleware/rateLimiter.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { detectMime } from '../pesv/magic-number.js';
import { archivoDe, BolsaDocumentoError, cargarDocumento, expedienteDe, historialDe } from './flito-bolsas-documentos.service.js';

const router = Router();
router.use(authMiddleware);


const MB_MAX = TAMANO_MAX_DOCUMENTO_BOLSA / (1024 * 1024);
const MSG_TIPO = 'El archivo debe ser un PDF, JPG o PNG.';
const MSG_TAMANO = `El archivo supera el máximo de ${MB_MAX} MB.`;
const MSG_CONTENIDO = 'El contenido del archivo no corresponde a un PDF, JPG o PNG válido.';

const ES_MIME = (m: string): m is MimeDocumentoBolsa => (MIMES_DOCUMENTO_BOLSA as readonly string[]).includes(m);

// Mismo patrón que el comprobante de una recarga de bolsa (memoria, 15 MB, filtro por MIME declarado y
// después el MIME REAL por magic bytes), replicado aquí y no importado: es otro módulo y otra sesión.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAX_DOCUMENTO_BOLSA, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ES_MIME(file.mimetype)) cb(null, true);
    else cb(new BolsaDocumentoError(400, MSG_TIPO));
  },
});

/** Los rechazos de multer salen como 400 con copy de producto, no como el 500 del error handler. */
function recibirArchivo(req: Request, res: Response, next: NextFunction): void {
  upload.single('archivo')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    if (err instanceof BolsaDocumentoError) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') { res.status(400).json({ error: MSG_TAMANO }); return; }
    res.status(400).json({ error: 'No se pudo leer el archivo. Adjunta un único archivo en el campo «archivo».' });
  });
}

/** BolsaDocumentoError es de negocio; lo demás sube al error handler. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof BolsaDocumentoError) { res.status(e.estado).json({ error: e.message }); return; }
  throw e;
}

const companiaParams = z.object({ companiaId: z.coerce.number().int().positive() });
const tipoParams = companiaParams.extend({ tipo: z.enum(TIPOS_DOCUMENTO_BOLSA) });
const documentoParams = z.object({ documentoId: z.string().uuid() });

const MSG_PARAMS = 'La compañía o el tipo de documento no son válidos.';

/** E1 — El expediente de la compañía (los 5 tipos, con su vigente y su estado). */
router.get('/companias/:companiaId', soloSinEnlace(), exigirFuncion('bolsas.documentos.ver'), async (req: Request, res: Response) => {
  const p = companiaParams.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: MSG_PARAMS }); return; }
  try {
    res.json(await expedienteDe(p.data.companiaId));
  } catch (e) { fallo(res, e); }
});

/** E2 — Historial de versiones de un tipo. */
router.get('/companias/:companiaId/tipos/:tipo/historial', soloSinEnlace(), exigirFuncion('bolsas.documentos.ver'), async (req: Request, res: Response) => {
  const p = tipoParams.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: MSG_PARAMS }); return; }
  try {
    res.json({ versiones: await historialDe(p.data.companiaId, p.data.tipo) });
  } catch (e) { fallo(res, e); }
});

/** E3 — Carga o reemplazo de un documento (multipart, campo `archivo`). */
router.post(
  '/companias/:companiaId/tipos/:tipo',
  soloSinEnlace(), exigirFuncion('bolsas.documentos.cargar'), bolsasDocumentosCargaLimiter, recibirArchivo,
  async (req: Request, res: Response) => {
    const p = tipoParams.safeParse(req.params);
    if (!p.success) { res.status(400).json({ error: MSG_PARAMS }); return; }
    if (!req.file) { res.status(400).json({ error: 'Adjunta el archivo del documento.' }); return; }
    if (req.file.size === 0) { res.status(400).json({ error: 'El archivo está vacío.' }); return; }
    // MIME REAL: un ejecutable renombrado a .pdf declara application/pdf y pasa el fileFilter.
    const real = await detectMime(req.file.buffer);
    if (!real || !ES_MIME(real) || real !== req.file.mimetype) { res.status(400).json({ error: MSG_CONTENIDO }); return; }

    try {
      const doc = await cargarDocumento({
        companiaId: p.data.companiaId, tipo: p.data.tipo, buffer: req.file.buffer, mime: real,
        userId: req.user?.sub ?? null,
      });
      await audit(req, {
        action: 'upload', resource: 'flito_bolsa_documento', resourceId: doc.id,
        detail: `Documento ${doc.tipo} v${doc.version} de la compañía ${p.data.companiaId}`,
      });
      res.status(201).json(doc);
    } catch (e) { fallo(res, e); }
  },
);

const EXTENSION: Record<MimeDocumentoBolsa, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** E5 — Descarga: la API descifra y transmite (nunca una URL firmada, D6). */
router.get('/documentos/:documentoId/archivo', soloSinEnlace(), exigirFuncion('bolsas.documentos.ver'), async (req: Request, res: Response) => {
  const p = documentoParams.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: 'El documento no es válido.' }); return; }
  try {
    const a = await archivoDe(p.data.documentoId);
    if (a.tipo === 'cedula_representante') {
      // Ley 1581 art. 17. `resourceId` admite un número: va la compañía y el uuid en `motivo` (ADR-0028 §4.2).
      // `logPiiAccess` es best-effort: si falla internamente, no tumba la descarga.
      await logPiiAccess(req, {
        resourceTipo: 'flito_bolsa_documento', resourceId: a.companiaId, accion: 'read',
        camposAccedidos: ['cedula_representante.archivo'], motivo: `descarga documento ${p.data.documentoId}`,
      });
    }
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${a.tipo}-v${a.version}.${EXTENSION[a.mime]}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(a.contenido);
  } catch (e) { fallo(res, e); }
});

export default router;
