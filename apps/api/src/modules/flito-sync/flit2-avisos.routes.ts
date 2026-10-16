// HU #13632 (Feature #13613, Épica #13576) — `POST /api/flito/sync/flit2/avisos`: avisos firmados de FLIT 2.
// Diseño: docs/diseno/hu-13632-avisos-flit2.md (decisión D1).
//
// RUTA PÚBLICA, sin `authMiddleware` (excepción aprobada por David en la HU, regla 4 de AGENTS.md): quien
// llama es FLIT 2, máquina a máquina; la confianza es el HMAC del cuerpo crudo (RN-01 del servicio).
//
// Se monta en `app.ts` ANTES del `express.json` global y del `apiLimiter`. Cadena, en este orden:
//   404 (deshabilitado o sin secreto, AC3) → limitador general y limitador de fallidos (401/400), ambos por
//   IP real (429, AC9) → `express.raw` 16 kB →
//   firma (401, AC2) → JSON + Zod (400, AC4) → `tipo` (200 ignorado, AC4) → servicio (200, AC1/AC6/AC8).
// Este router NUNCA llama `next()` para su ruta: con el endpoint apagado caería en `flit2Routes` y
// respondería el 401 de su `authMiddleware` en vez del 404. Tiene su propio manejador de errores.
// Logs: nunca el cuerpo, la cabecera de firma ni el secreto. Sin PII (el aviso solo trae uuids y versión).

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { loggerFor } from '../../shared/logger.js';
import { flit2AvisosFallidosLimiter, flit2AvisosLimiter } from '../../shared/middleware/rateLimiter.js';
import { esUuid } from '../../shared/utils/uuid.js';
import {
  TIPO_CAMBIO, anotarAvisoValido, anotarFirmaValida, anotarRechazo, avisarConfiguracionAvisos,
  avisoFlit2Schema, recibirAviso, secretoAvisos, verificarFirmaAviso,
} from './flit2-avisos.service.js';

export const RUTA_AVISOS_FLIT2 = '/api/flito/sync/flit2/avisos';
export const LIMITE_CUERPO_AVISO = '16kb';

const log = loggerFor('flito-sync-flit2-avisos');

avisarConfiguracionAvisos();

/** El mismo 404 que da Express a una ruta inexistente: con el endpoint apagado no hay superficie. */
function noExiste(req: Request, res: Response): void {
  res.status(404).type('html').send(
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n'
    + `<pre>Cannot ${req.method} ${RUTA_AVISOS_FLIT2}</pre>\n</body>\n</html>\n`,
  );
}

function exigirAvisosHabilitados(req: Request, res: Response, next: NextFunction): void {
  if (!secretoAvisos()) { noExiste(req, res); return; }
  next();
}

const correlacion = (req: Request): string | null => {
  const c = req.headers['x-correlation-id'];
  return esUuid(c) ? c : null;
};

async function recibir(req: Request, res: Response): Promise<void> {
  const secreto = secretoAvisos();
  if (!secreto) { noExiste(req, res); return; }
  // `express.raw` solo parsea JSON: otro Content-Type deja el cuerpo sin leer. No se re-serializa nunca
  // (no reproduce los bytes firmados): sin Buffer → 401.
  const cuerpo = Buffer.isBuffer(req.body) ? req.body : null;
  const firma = cuerpo
    ? verificarFirmaAviso(cuerpo, req.headers['x-webhook-signature'], secreto)
    : { ok: false as const, motivo: 'mal_formada' as const };
  if (!firma.ok) {
    anotarRechazo();
    log.warn({ motivo: firma.motivo, ip: req.ip ?? null, correlationId: correlacion(req) }, 'aviso de FLIT 2 rechazado por firma');
    res.status(401).json({ error: 'no_autorizado' });
    return;
  }
  anotarFirmaValida();

  let json: unknown;
  try { json = JSON.parse(cuerpo!.toString('utf8')); } catch { json = undefined; }
  const parsed = avisoFlit2Schema.safeParse(json);
  if (!parsed.success) {
    log.warn({ ip: req.ip ?? null, correlationId: correlacion(req) }, 'aviso de FLIT 2 con firma válida y cuerpo inválido');
    res.status(400).json({ error: 'aviso_invalido' });
    return;
  }
  anotarAvisoValido();
  const aviso = parsed.data;
  if (aviso.tipo !== TIPO_CAMBIO) {
    log.debug({ correlationId: correlacion(req) }, 'aviso de FLIT 2 de otro tipo: ignorado');
    res.status(200).json({ estado: 'ignorado' });
    return;
  }
  const estado = await recibirAviso(aviso);
  log.debug({ estado, id: aviso.id, syncVersion: aviso.syncVersion, correlationId: correlacion(req) }, 'aviso de FLIT 2 recibido');
  res.status(200).json({ estado });
}

const router = Router();

router.post(
  '/',
  exigirAvisosHabilitados,
  flit2AvisosLimiter,
  flit2AvisosFallidosLimiter,
  // `type-is` ignora los parámetros: acepta `application/json; charset=utf-8`, que es lo que manda FLIT 2.
  express.raw({ type: 'application/json', limit: LIMITE_CUERPO_AVISO }),
  (req, res) => {
    recibir(req, res).catch((e: unknown) => {
      log.error({ err: (e as Error)?.name }, 'aviso de FLIT 2: error inesperado');
      if (!res.headersSent) res.status(500).json({ error: 'interno' });
    });
  },
);

// Cualquier otro método o subruta: el 404 genérico, sin pasar a `flit2Routes`.
router.use((req, res) => { noExiste(req, res); });

// Errores de los middlewares de arriba (413 del parser, fallo del store del limitador…): se responden aquí.
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const tipo = (err as { type?: string })?.type;
  if (tipo === 'entity.too.large') { res.status(413).json({ error: 'aviso_demasiado_grande' }); return; }
  if ((err as { status?: number })?.status === 400) { res.status(400).json({ error: 'aviso_invalido' }); return; }
  log.error({ err: (err as Error)?.name }, 'aviso de FLIT 2: error en la cadena de middlewares');
  res.status(500).json({ error: 'interno' });
});

export default router;
