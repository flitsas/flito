// TRAM-11 — cliente Anthropic resiliente para OCR de documentos y validación
// biométrica de identidad en trámites. Centraliza timeout + retry + clasificación
// de errores + métrica + logging SIN PII (nunca se loguean imágenes ni datos
// extraídos; solo op/status/latencia/tipo de error). Degradación graceful: ante
// fallo, el caller responde con un mensaje usable que invita a continuar con
// carga manual del documento.

import { env } from '../../config/env.js';
import { requestWithRetry, UpstreamError } from '../../shared/upstream.js';
import { tramAnthropicRequestTotal } from '../../shared/metrics.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.ia');

export type AnthropicOp = 'ocr' | 'biometric' | 'checklist';

export type AnthropicResult =
  | { ok: true; data: any }
  | { ok: false; status: number; message: string };

const MSG_MANUAL = 'El servicio de lectura automática no está disponible en este momento. Puedes adjuntar el documento manualmente y continuar.';
const MSG_TIMEOUT = 'La lectura automática tardó demasiado. Puedes adjuntar el documento manualmente y continuar.';

/**
 * Llama a la API de Mensajes de Anthropic con resiliencia. Devuelve `{ ok, data }`
 * en éxito, o `{ ok:false, status, message }` con un código HTTP claro (503) y un
 * mensaje apto para mostrar al usuario en el wizard.
 */
export async function anthropicMessages(payload: object, op: AnthropicOp): Promise<AnthropicResult> {
  if (!env.ANTHROPIC_API_KEY) {
    tramAnthropicRequestTotal.inc({ op, result: 'no_key' });
    return { ok: false, status: 503, message: 'Servicio de IA no configurado. Adjunta el documento manualmente.' };
  }

  const body = JSON.stringify(payload);
  const t0 = Date.now();
  try {
    const resp = await requestWithRetry({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body, timeoutMs: 60_000, retries: 1,
    });
    const ms = Date.now() - t0;

    if (resp.statusCode !== 200) {
      log.warn({ op, status: resp.statusCode, ms }, 'anthropic respondió no-200');
      tramAnthropicRequestTotal.inc({ op, result: 'error' });
      return { ok: false, status: 503, message: MSG_MANUAL };
    }

    let json: any;
    try { json = JSON.parse(resp.buffer.toString('utf8')); } catch { json = null; }
    if (!json || json.error) {
      log.warn({ op, ms, errType: json?.error?.type }, 'anthropic payload de error');
      tramAnthropicRequestTotal.inc({ op, result: 'error' });
      return { ok: false, status: 503, message: MSG_MANUAL };
    }

    log.info({ op, ms }, 'anthropic ok');
    tramAnthropicRequestTotal.inc({ op, result: 'success' });
    return { ok: true, data: json };
  } catch (e) {
    const kind: 'timeout' | 'network' = e instanceof UpstreamError ? e.kind : 'network';
    log.warn({ op, kind }, 'anthropic falló (red/timeout) tras reintentos');
    tramAnthropicRequestTotal.inc({ op, result: kind === 'timeout' ? 'timeout' : 'error' });
    return { ok: false, status: 503, message: kind === 'timeout' ? MSG_TIMEOUT : MSG_MANUAL };
  }
}
