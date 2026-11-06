import { Request, Response, NextFunction } from 'express';
import { loggerFor } from '../logger.js';
import { AlcanceAjenoError } from '../alcance-filas.js';
import { PiiDecryptError } from '../utils/crypto.js';
import { mensajeDeErrorParaLog, rutaSinDato, stackDeErrorParaLog, textoSinDatoDeUrl } from './ruta-segura.js';

const log = loggerFor('http');

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // Body-parser: payload demasiado grande (p. ej. 3 fotos base64 en validación identidad).
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    log.warn({ method: req.method, path: rutaSinDato(req) }, 'payload too large → 413');
    if (!res.headersSent) {
      res.status(413).json({ ok: false, message: 'Las fotos superan el tamaño permitido. Reduce la resolución o acércate más al documento.' });
    }
    return;
  }

  // HU #13426: escritura fuera del alcance del enlace → 403 con el cuerpo de la frontera.
  if (err instanceof AlcanceAjenoError) {
    if (!res.headersSent) res.status(403).json({ error: 'Sin permisos' });
    return;
  }

  // Feature #14097 (HU #14099): solo el dónde; el valor, cifrado o no, nunca llega al log.
  if (err instanceof PiiDecryptError) {
    log.error({
      requestId: req.headers['x-request-id'],
      table: err.table,
      column: err.column,
      id: err.id,
    }, 'descifrado de PII fallido');
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
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
    log.warn({ method: req.method, path: rutaSinDato(req), pgMsg: textoSinDatoDeUrl(req, pgMsg) }, 'WORM guard → 409');
    if (!res.headersSent) res.status(409).json({ error: 'diagnóstico cerrado (WORM)' });
    return;
  }

  // Rúbrica: score_pct fuera de {0,50,75,100} → RAISE EXCEPTION ... ERRCODE='23514', mensaje 'rubrica:...'
  if (pgCode === '23514' && /rubrica/i.test(pgMsg)) {
    log.warn({ method: req.method, path: rutaSinDato(req), pgMsg: textoSinDatoDeUrl(req, pgMsg) }, 'rúbrica guard → 422');
    if (!res.headersSent) res.status(422).json({ error: 'scorePct fuera de rúbrica (valores válidos: 0, 50, 75, 100)' });
    return;
  }

  // HU #14280: el error del body-parser cita un trozo del cuerpo recibido (`"123…" is not valid JSON`).
  // Basta con decir qué pasó: su stack es de la librería y no aporta al diagnóstico.
  if (err?.type === 'entity.parse.failed') {
    log.error({
      err: 'cuerpo JSON inválido',
      method: req.method,
      path: rutaSinDato(req),
      requestId: req.headers['x-request-id'],
    }, 'unhandled error');
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
    return;
  }

  // HU #14280: el mensaje y el stack se conservan para diagnosticar, sin los valores que traía la URL.
  log.error({
    err: mensajeDeErrorParaLog(req, err),
    method: req.method,
    path: rutaSinDato(req),
    requestId: req.headers['x-request-id'],
    stack: stackDeErrorParaLog(req, err),
  }, 'unhandled error');
  if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
}
