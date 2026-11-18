// TRAM-11 — cliente Anthropic resiliente para OCR de documentos y validación
// biométrica de identidad en trámites. Centraliza timeout + retry + clasificación
// de errores + métrica + logging SIN PII (nunca se loguean imágenes ni datos
// extraídos; solo op/status/latencia/tipo de error). Degradación graceful: ante
// fallo, el caller responde con un mensaje usable que invita a continuar con
// carga manual del documento.
//
// Contrato `ia-consumo` v1 (ADR-0045): es el ÚNICO punto de FLITO que habla con `api.anthropic.com`. Cada
// intento HTTP (reintentos incluidos, vía `onIntento` de `requestWithRetry`) deja una fila en
// `ia_consumo_log` con el contexto que abrió quien llama (`conContextoIa`). El registro nunca bloquea ni
// cambia el resultado. Tres formas, según lo que el llamador ya esperaba antes de pasar por aquí:
//   · `anthropicMessages`      → `{ ok, data } | { ok:false, status, message }` (trámites, flito-ocr, copiloto);
//   · `anthropicPeticion`      → la respuesta HTTP tal cual o `UpstreamError` (Dr. Flit, salud de modelos);
//   · `anthropicMensajesCrudo` → el cuerpo parseado (JSON o texto) de cualquier status, o `UpstreamError`
//     (las llamadas que antes eran `https.request` directo: vehículos, Drive, RUNT, captcha).

import { env } from '../../config/env.js';
import { requestWithRetry, UpstreamError, type IntentoUpstream, type UpstreamResponse } from '../../shared/upstream.js';
import { tramAnthropicRequestTotal } from '../../shared/metrics.js';
import { loggerFor } from '../../shared/logger.js';
import {
  registrarConsumoIa, registrarIntentoAnthropic, renderizarPrompt, tareaPorOp, type LlamadaAnthropic,
} from '../../shared/ia-consumo/registro.js';

const log = loggerFor('tramite.ia');

export const URL_MENSAJES_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
export const VERSION_API_ANTHROPIC = '2023-06-01';

export type AnthropicOp = 'ocr' | 'biometric' | 'checklist' | 'captcha' | 'chat' | 'salud';

export type AnthropicResult =
  | { ok: true; data: any; consumoId?: string | null }
  | { ok: false; status: number; message: string };

export interface OpcionesAnthropic {
  /** Timeout por intento. Default 60 s. */
  timeoutMs?: number;
  /** Reintentos adicionales. Default 1. */
  retries?: number;
  /** Llave explícita (Dr. Flit la inyecta en sus tests). Default `env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** La salud de modelos pide `max_tokens: 1`: cortar por tope ahí es éxito. */
  maxTokensEsExito?: boolean;
  /** Número del primer intento en el registro, para quien lleva su propio bucle (captcha RUNT). Default 1. */
  intentoInicial?: number;
}

const MSG_MANUAL = 'El servicio de lectura automática no está disponible en este momento. Puedes adjuntar el documento manualmente y continuar.';
const MSG_TIMEOUT = 'La lectura automática tardó demasiado. Puedes adjuntar el documento manualmente y continuar.';

function describir(payload: object, op: AnthropicOp, o: OpcionesAnthropic): LlamadaAnthropic {
  const p = payload as { model?: unknown; max_tokens?: unknown };
  return {
    modelo: typeof p.model === 'string' ? p.model : null,
    maxTokens: typeof p.max_tokens === 'number' ? p.max_tokens : null,
    prompt: renderizarPrompt(payload),
    op,
    maxTokensEsExito: o.maxTokensEsExito,
  };
}

/** Fila «no_configurado» (sin llave): no hubo llamada HTTP, pero el intento de uso queda medido. */
function registrarSinLlave(llamada: LlamadaAnthropic): void {
  const ahora = new Date();
  registrarConsumoIa({
    proveedor: 'anthropic', inicio: ahora, fin: ahora, resultado: 'no_configurado',
    modeloSolicitado: llamada.modelo, maxTokens: llamada.maxTokens, promptHash: llamada.prompt.hash,
    errorCodigo: 'sin_api_key', archivo: { mime: llamada.prompt.mime, bytes: llamada.prompt.bytes },
    metadatos: { op: llamada.op }, tipoTareaPorDefecto: tareaPorOp(llamada.op),
  });
}

/**
 * POST /v1/messages con timeout y reintentos acotados, registrando cada intento. Devuelve la respuesta del
 * último intento (cualquier status) o lanza `UpstreamError` (red/timeout). `consumoId` es la fila del
 * último intento, para `anotarConsumoIa`.
 */
export async function anthropicPeticion(
  payload: object, op: AnthropicOp, o: OpcionesAnthropic = {},
): Promise<UpstreamResponse & { consumoId: string | null }> {
  const llamada = describir(payload, op, o);
  const body = JSON.stringify(payload);
  let consumoId: string | null = null;
  const resp = await requestWithRetry({
    url: URL_MENSAJES_ANTHROPIC,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': o.apiKey ?? env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': VERSION_API_ANTHROPIC,
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: o.timeoutMs ?? 60_000,
    retries: o.retries ?? 1,
    onIntento: (i: IntentoUpstream) => {
      consumoId = registrarIntentoAnthropic(llamada, {
        intento: (o.intentoInicial ?? 1) + i.intento - 1, inicio: i.inicio, fin: i.fin, statusCode: i.statusCode, buffer: i.buffer,
        error: i.error ? { kind: i.error.kind, message: i.error.message } : undefined,
      });
    },
  });
  return { ...resp, consumoId };
}

/**
 * Llama a la API de Mensajes de Anthropic con resiliencia. Devuelve `{ ok, data }`
 * en éxito, o `{ ok:false, status, message }` con un código HTTP claro (503) y un
 * mensaje apto para mostrar al usuario en el wizard.
 */
export async function anthropicMessages(payload: object, op: AnthropicOp, o: OpcionesAnthropic = {}): Promise<AnthropicResult> {
  if (!(o.apiKey ?? env.ANTHROPIC_API_KEY)) {
    tramAnthropicRequestTotal.inc({ op, result: 'no_key' });
    registrarSinLlave(describir(payload, op, o));
    return { ok: false, status: 503, message: 'Servicio de IA no configurado. Adjunta el documento manualmente.' };
  }

  const t0 = Date.now();
  try {
    const resp = await anthropicPeticion(payload, op, o);
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
    return { ok: true, data: json, consumoId: resp.consumoId };
  } catch (e) {
    const kind: 'timeout' | 'network' = e instanceof UpstreamError ? e.kind : 'network';
    log.warn({ op, kind }, 'anthropic falló (red/timeout) tras reintentos');
    tramAnthropicRequestTotal.inc({ op, result: kind === 'timeout' ? 'timeout' : 'error' });
    return { ok: false, status: 503, message: kind === 'timeout' ? MSG_TIMEOUT : MSG_MANUAL };
  }
}

export interface RespuestaCruda {
  statusCode: number;
  /** El cuerpo con `JSON.parse` si se pudo; si no, el texto tal cual (lo que veía el `https.request` de antes). */
  cuerpo: any;
  consumoId: string | null;
}

/**
 * Para las llamadas que antes iban por `https.request` directo y leían el cuerpo de CUALQUIER status
 * (`r.error` → error; `r.content[0].text` → éxito). Conserva ese contrato: devuelve el cuerpo, y lanza
 * `UpstreamError` en red o timeout como antes rechazaba la promesa. Por defecto un solo intento (como esas
 * llamadas); el timeout lo pone cada una. Sin llave sale igual con la llave vacía (como antes): Anthropic
 * responde `authentication_error` y queda registrado como `error_proveedor`.
 */
export async function anthropicMensajesCrudo(
  payload: object, op: AnthropicOp, o: OpcionesAnthropic = {},
): Promise<RespuestaCruda> {
  try {
    const resp = await anthropicPeticion(payload, op, { ...o, retries: o.retries ?? 0 });
    const texto = resp.buffer.toString('utf8');
    let cuerpo: unknown;
    try { cuerpo = JSON.parse(texto); } catch { cuerpo = texto; }
    const exito = resp.statusCode === 200 && cuerpo && typeof cuerpo === 'object' && !('error' in cuerpo);
    tramAnthropicRequestTotal.inc({ op, result: exito ? 'success' : 'error' });
    return { statusCode: resp.statusCode, cuerpo, consumoId: resp.consumoId };
  } catch (e) {
    const kind = e instanceof UpstreamError ? e.kind : 'network';
    tramAnthropicRequestTotal.inc({ op, result: kind === 'timeout' ? 'timeout' : 'error' });
    throw e;
  }
}
