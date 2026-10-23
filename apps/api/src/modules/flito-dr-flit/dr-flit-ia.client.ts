// Dr. Flit IA — cliente HTTP de la Messages API de Anthropic (HU #13856, Feature #13696, IA-4).
// Sin `@anthropic-ai/sdk` (ADR-0027): `requestWithRetry` de `shared/upstream.ts`, como el probe de
// `modules/ai/anthropic-health.ts` y el OCR.
//
// RN-DRF-K1  UNA llamada: `retries: 0` explícito (el default del helper es 2 y triplicaría costo y
//            latencia) y `timeoutMs = DRFLIT_IA_TIMEOUT_MS`.
// RN-DRF-K2  Nunca lanza: todo fallo se traduce a `{ ok: false, motivo }`. Timeout → `ia-timeout`; red,
//            429, 529, 5xx y 4xx (modelo retirado, clave inválida) → `ia-error`.
// RN-DRF-K3  Del cuerpo de error de Anthropic solo se extrae `error.type` (validado contra un patrón
//            corto); el cuerpo crudo nunca sale de aquí (puede ecoar el prompt).
// RN-DRF-K4  De una respuesta 200 solo se toman los bloques `type === "text"`, `stop_reason` y `usage`.
import { env } from '../../config/env.js';
import { requestWithRetry, UpstreamError } from '../../shared/upstream.js';

export const URL_MESSAGES_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
export const VERSION_API_ANTHROPIC = '2023-06-01';

export type MotivoFalloIa = 'ia-timeout' | 'ia-error';

export type ResultadoLlamadaIa =
  | {
    ok: true;
    texto: string;
    stopReason: string | null;
    tokensEntrada: number | null;
    tokensSalida: number | null;
  }
  | { ok: false; motivo: MotivoFalloIa; statusCode: number | null; errorType: string | null };

export interface OpcionesClienteIa {
  apiKey?: string;
  timeoutMs?: number;
}

const RE_TIPO_ERROR = /^[a-z_]{1,40}$/;

function tipoDeError(buffer: Buffer): string | null {
  try {
    const t = (JSON.parse(buffer.toString('utf8')) as { error?: { type?: unknown } })?.error?.type;
    return typeof t === 'string' && RE_TIPO_ERROR.test(t) ? t : null;
  } catch {
    return null;
  }
}

const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface CuerpoMensajes {
  content?: Array<{ type?: unknown; text?: unknown }>;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** POST /v1/messages con el cuerpo ya armado (`dr-flit-ia.prompt.ts`). Ver RN-DRF-K1..K4. */
export async function llamarMensajesIa(
  cuerpo: Record<string, unknown>, o: OpcionesClienteIa = {},
): Promise<ResultadoLlamadaIa> {
  const body = JSON.stringify(cuerpo);
  try {
    const resp = await requestWithRetry({
      url: URL_MESSAGES_ANTHROPIC,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': o.apiKey ?? env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': VERSION_API_ANTHROPIC,
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs: o.timeoutMs ?? env.DRFLIT_IA_TIMEOUT_MS,
      retries: 0,
    });
    if (resp.statusCode !== 200) {
      return { ok: false, motivo: 'ia-error', statusCode: resp.statusCode, errorType: tipoDeError(resp.buffer) };
    }
    let json: CuerpoMensajes;
    try {
      json = JSON.parse(resp.buffer.toString('utf8')) as CuerpoMensajes;
    } catch {
      return { ok: false, motivo: 'ia-error', statusCode: 200, errorType: 'cuerpo_no_json' };
    }
    const texto = (Array.isArray(json.content) ? json.content : [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return {
      ok: true,
      texto,
      stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
      tokensEntrada: numero(json.usage?.input_tokens),
      tokensSalida: numero(json.usage?.output_tokens),
    };
  } catch (e) {
    const timeout = e instanceof UpstreamError && e.kind === 'timeout';
    return { ok: false, motivo: timeout ? 'ia-timeout' : 'ia-error', statusCode: null, errorType: timeout ? 'timeout' : 'network' };
  }
}
