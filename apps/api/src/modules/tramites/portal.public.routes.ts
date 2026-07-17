// EPIC TRAM-INNOV · A3 — rutas públicas del portal de participantes (SIN auth).
//
// Montado bajo /api/tramite-portal. Rate-limit compartido (qrPublicLimiter).
// 404 genérico para token inválido (no enumera). Subida exige consentimiento.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { db } from '../../db/client.js';
import { tramitesDocumentos } from '../../db/schema.js';
import { qrPublicLimiter } from '../../shared/middleware/rateLimiter.js';
import { getPortalView, aceptarDeclaracion, authorizeUpload, finalizarParticipacion, getFirmaPortalUrl, simularFirmaPortal } from './portal.js';
import { emitEvento, sha256 } from './eventos.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const VALID_DOC_TYPES = ['factura', 'aduana', 'impronta', 'soat', 'certificado_ambiental', 'compraventa', 'acta_remate', 'oficio_judicial', 'declaracion_aduana', 'otro'];
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const sanitizeFilename = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);

// GET /:token — vista mínima del trámite + pasos pendientes.
router.get('/:token', qrPublicLimiter, async (req: Request, res: Response) => {
  const view = await getPortalView(req.params.token, req);
  if (!view) { res.status(404).json({ error: 'Enlace inválido o expirado' }); return; }
  res.json(view);
});

// POST /:token/aceptar-declaracion — consentimiento Ley 1581.
router.post('/:token/aceptar-declaracion', qrPublicLimiter, async (req: Request, res: Response) => {
  const r = await aceptarDeclaracion(req.params.token, req);
  if (!r.ok) { res.status(404).json({ error: 'Enlace inválido o expirado' }); return; }
  res.json({ ok: true });
});

// POST /:token/documentos — subida (exige consentimiento previo).
router.post('/:token/documentos', qrPublicLimiter, upload.single('file'), async (req: Request, res: Response) => {
  const auth = await authorizeUpload(req.params.token);
  if (!auth.ok) {
    if (auth.code === 'sin_consentimiento') { res.status(403).json({ error: 'Debe aceptar el tratamiento de datos antes de subir documentos' }); return; }
    res.status(404).json({ error: 'Enlace inválido o expirado' }); return;
  }
  if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
  if (!ALLOWED_MIME.includes(req.file.mimetype)) { res.status(400).json({ error: 'Tipo de archivo no permitido. Use PDF, JPEG, PNG o WebP.' }); return; }
  const rawTipo = String(req.body.tipo || 'otro');
  const tipo = VALID_DOC_TYPES.includes(rawTipo) ? rawTipo : 'otro';
  const { tramiteId, rol } = auth.ctx;

  const dir = path.join(process.cwd(), 'uploads', 'tramites', String(tramiteId));
  await mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(req.file.originalname);
  const filename = `${tipo}_${Date.now()}_${safeName}`;
  await writeFile(path.join(dir, filename), req.file.buffer);

  const [doc] = await db.insert(tramitesDocumentos).values({
    tramiteId, tipo,
    filename: `uploads/tramites/${tramiteId}/${filename}`,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype, size: req.file.size,
  }).returning();

  // Mandato/poder cuando el participante es mandatario (epic A2/A3).
  emitEvento({ tramiteId, tipo: rol === 'mandatario' ? 'mandato_subido' : 'documento_subido', actorRole: rol, payload: { tipo, via: 'portal' }, docHash: sha256(req.file.buffer) });
  res.status(201).json({ id: doc.id, tipo: doc.tipo, originalName: doc.originalName });
});

// POST /:token/finalizar — el participante termina (revoca el token).
router.post('/:token/finalizar', qrPublicLimiter, async (req: Request, res: Response) => {
  const r = await finalizarParticipacion(req.params.token);
  if (!r.ok) { res.status(404).json({ error: 'Enlace inválido o expirado' }); return; }
  res.json({ ok: true });
});

// TRAM-INNOV-B3 — firma desde el portal.
// GET /:token/firma/url — URL de firma del rol (mock o zapsign). 404 si no hay pendiente.
router.get('/:token/firma/url', qrPublicLimiter, async (req: Request, res: Response) => {
  const r = await getFirmaPortalUrl(req.params.token);
  if (!r.ok) { res.status(404).json({ error: 'Sin firma pendiente para este participante' }); return; }
  res.json({ url: r.url, proveedor: r.proveedor, estado: r.estado });
});

// POST /:token/firma-simulada — completa la firma en modo mock (demo/dev).
router.post('/:token/firma-simulada', qrPublicLimiter, async (req: Request, res: Response) => {
  const r = await simularFirmaPortal(req.params.token);
  if (!r.ok) {
    const status = r.code === 'invalid_token' ? 404 : 400;
    res.status(status).json({ error: r.code });
    return;
  }
  res.json({ ok: true });
});

export default router;
