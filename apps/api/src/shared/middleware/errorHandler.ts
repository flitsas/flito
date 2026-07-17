import { Request, Response, NextFunction } from 'express';
import { loggerFor } from '../logger.js';

const log = loggerFor('http');

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // Body-parser: payload demasiado grande (p. ej. 3 fotos base64 en validación identidad).
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    log.warn({ method: req.method, path: req.path }, 'payload too large → 413');
    if (!res.headersSent) {
      res.status(413).json({ ok: false, message: 'Las fotos superan el tamaño permitido. Reduce la resolución o acércate más al documento.' });
    }
    return;
  }

  // PESV-02 (B-NEW-1): el guard SQL `pesv_diag_items_worm_guard` (mig 0070) lanza
  // errores de Postgres que de otro modo caerían en el 500 genérico. Mapeamos a
  // códigos de dominio claros. Defensa en profundidad: los handlers ya validan
  // estado/rúbrica antes de tocar BD; esto cubre las carreras (cierre concurrente)
  // y cualquier ruta que escriba sin pre-validar.
  const pgCode: string | undefined = err?.code;
  const pgMsg: string = typeof err?.message === 'string' ? err.message : '';

  // WORM: diagnóstico cerrado/inexistente → RAISE EXCEPTION ... ERRCODE='P0001', mensaje 'WORM:...'
  if (pgCode === 'P0001' && /^WORM:/.test(pgMsg)) {
    log.warn({ method: req.method, path: req.path, pgMsg }, 'WORM guard → 409');
    if (!res.headersSent) res.status(409).json({ error: 'diagnóstico cerrado (WORM)' });
    return;
  }

  // Rúbrica: score_pct fuera de {0,50,75,100} → RAISE EXCEPTION ... ERRCODE='23514', mensaje 'rubrica:...'
  if (pgCode === '23514' && /rubrica/i.test(pgMsg)) {
    log.warn({ method: req.method, path: req.path, pgMsg }, 'rúbrica guard → 422');
    if (!res.headersSent) res.status(422).json({ error: 'scorePct fuera de rúbrica (valores válidos: 0, 50, 75, 100)' });
    return;
  }

  log.error({
    err: err.message || String(err),
    method: req.method,
    path: req.path,
    requestId: req.headers['x-request-id'],
    stack: err.stack,
  }, 'unhandled error');
  if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
}
