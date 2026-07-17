// EPIC TRAM-INNOV · A2 — verificación pública del expediente (QR), SIN auth.
//
// Montado bajo /api/public/tramite-verificar. Expone integridad (estado + hash
// de últimos eventos) sin PII completa. 404 idéntico para token inválido/expirado
// (no enumera IDs). Rate-limit compartido con los QR públicos de RNDC.

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { qrPublicLimiter } from '../../shared/middleware/rateLimiter.js';
import { env } from '../../config/env.js';
import { verifyByToken, VERIFY_TOKEN_RE } from './eventos.js';

const publicRouter = Router();

// JSON de verificación: GET /api/public/tramite-verificar?t=<token>
publicRouter.get('/', qrPublicLimiter, async (req: Request, res: Response) => {
  const token = String(req.query.t || '');
  const result = await verifyByToken(token);
  if (!result) { res.status(404).json({ valido: false }); return; }
  res.json(result);
});

// QR PNG que apunta a la página pública de verificación.
publicRouter.get('/qr-png/:token', qrPublicLimiter, async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!VERIFY_TOKEN_RE.test(token)) { res.status(400).end(); return; }
  const result = await verifyByToken(token);
  if (!result) { res.status(404).end(); return; }
  const url = `${env.PUBLIC_URL}/tramite/verificar?t=${token}`;
  const png = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(png);
});

export default publicRouter;
