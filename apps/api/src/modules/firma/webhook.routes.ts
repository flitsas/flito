// TRAM-INNOV-B3 — webhook del proveedor de firma (montado en /api/webhooks/firma).
// Cuerpo RAW (Buffer) para validar HMAC. Sin auth de sesión: la confianza es el HMAC.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { completarFirma } from './firma.service.js';

const router = Router();

function verifyHmac(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /:proveedor — { envelopeId, evento: 'firmada'|'rechazada', sha256?, pdfPath? }
router.post('/:proveedor', async (req: Request, res: Response) => {
  const secret = env.FIRMA_WEBHOOK_SECRET;
  if (!secret) { res.status(503).json({ error: 'Webhook de firma no configurado (FIRMA_WEBHOOK_SECRET)' }); return; }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifyHmac(raw, req.header('x-firma-signature') ?? undefined, secret)) {
    res.status(401).json({ error: 'Firma HMAC inválida' });
    return;
  }

  let payload: { envelopeId?: string; evento?: string; sha256?: string; pdfPath?: string };
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'JSON inválido' }); return; }

  const envelopeId = String(payload.envelopeId ?? '');
  const evento = payload.evento;
  if (!envelopeId || (evento !== 'firmada' && evento !== 'rechazada')) {
    res.status(400).json({ error: 'Payload inválido (envelopeId + evento firmada|rechazada)' });
    return;
  }

  try {
    const result = await completarFirma({
      envelopeId, resultado: evento,
      pdfPath: payload.pdfPath ?? null, sha256: payload.sha256 ?? null,
    });
    if (!result.ok) { res.status(404).json({ error: result.message }); return; }
    res.json({ ok: true, estado: result.firma.estado });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
