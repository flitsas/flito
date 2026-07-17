import { Router, Request, Response } from 'express';
import { eq, isNull } from 'drizzle-orm';
import QRCode from 'qrcode';
import { db } from '../../db/client.js';
import { manifiestos, vehicles, rndcMunicipios } from '../../db/schema.js';
import { qrPublicLimiter } from '../../shared/middleware/rateLimiter.js';
import { env } from '../../config/env.js';

// Router público — SIN authMiddleware. Montado bajo /api/rndc/public/manifiestos.
// Datos mínimos: nada de PII conductor, ni cliente, ni valores comerciales.
const publicRouter = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

publicRouter.get('/qr/:token', qrPublicLimiter, async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!TOKEN_RE.test(token)) { res.status(400).json({ error: 'Token inválido' }); return; }

  const [row] = await db.select({
    numero: manifiestos.numero,
    consecutivoRndc: manifiestos.consecutivoRndc,
    estado: manifiestos.estado,
    fechaExpedicion: manifiestos.fechaExpedicion,
    placa: vehicles.plate,
    origenDane: manifiestos.municipioOrigenDane,
    destinoDane: manifiestos.municipioDestinoDane,
    anuladoAt: manifiestos.anuladoAt,
    deletedAt: manifiestos.deletedAt,
  })
    .from(manifiestos)
    .leftJoin(vehicles, eq(vehicles.id, manifiestos.vehiculoPrincipalId))
    .where(eq(manifiestos.qrToken, token))
    .limit(1);

  // Respuesta 404 idéntica para token inválido y manifiesto eliminado: no leak de existencia.
  if (!row || row.deletedAt !== null) { res.status(404).json({ valido: false }); return; }

  // Resolver nombres de municipios.
  const [origen] = row.origenDane
    ? await db.select({ nombre: rndcMunicipios.nombre })
        .from(rndcMunicipios).where(eq(rndcMunicipios.codigoDane, row.origenDane)).limit(1)
    : [null];
  const [destino] = row.destinoDane
    ? await db.select({ nombre: rndcMunicipios.nombre })
        .from(rndcMunicipios).where(eq(rndcMunicipios.codigoDane, row.destinoDane)).limit(1)
    : [null];

  res.json({
    valido: row.anuladoAt === null && row.estado !== 'anulado',
    numero: row.numero,
    consecutivoRndc: row.consecutivoRndc,
    estado: row.estado,
    fechaExpedicion: row.fechaExpedicion,
    placa: row.placa,
    origen: origen?.nombre ?? row.origenDane,
    destino: destino?.nombre ?? row.destinoDane,
    razonSocialEmpresa: 'Kyverum LLC',
  });
});

// QR PNG: imagen escaneable que abre la página pública /m/:token.
publicRouter.get('/qr-png/:token', qrPublicLimiter, async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!TOKEN_RE.test(token)) { res.status(400).end(); return; }

  // Validar que el manifiesto existe (404 idéntico para inválido y eliminado).
  const [exists] = await db.select({ id: manifiestos.id })
    .from(manifiestos)
    .where(eq(manifiestos.qrToken, token))
    .limit(1);
  if (!exists) { res.status(404).end(); return; }

  const url = `${env.PUBLIC_URL}/m/${token}`;
  const png = await QRCode.toBuffer(url, {
    type: 'png',
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(png);
});

export default publicRouter;
