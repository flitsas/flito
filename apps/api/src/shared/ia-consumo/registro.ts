// Contrato `ia-consumo` v1 (ADR-0047) — de una llamada a la IA a una fila de `ia_consumo_log`.
//
// `registrarIntentoAnthropic` lo llama el cliente central (`modules/tramites/anthropic.ts`) una vez por
// intento HTTP; `registrarConsumoIa` es la vía genérica (respaldo Tesseract, «no configurado»). Ambos son
// síncronos, no lanzan y solo encolan (`escritor.ts`).
//
// Reglas que se aplican aquí (contrato §Reglas):
//   · nunca la imagen/PDF ni su base64, ni llaves ni encabezados: el prompt se renderiza solo con su texto
//     y los adjuntos como `[image image/png]`;
//   · `error_mensaje` recortado a 500 y sin cédulas ni correos (Anthropic puede citar el prompt en un 400);
//   · prompt y respuesta completos solo en el detalle (bandera `IA_CONSUMO_DETALLE`), recortados a 64 KB;
//   · sin contexto ⇒ `modulo = proceso = 'desconocido'`; sin `origen` ⇒ `usuario` si hay usuario, si no `job`.
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  MODULO_DESCONOCIDO, PROCESO_DESCONOCIDO, type OrigenIa, type ProveedorIa, type ResultadoIa, type TipoTareaIa,
} from './catalogo.js';
import { leerContextoIa, normalizarPlacaIa, type ContextoIa } from './contexto.js';
import { encolarConsumoIa, type FilaConsumoIa } from './escritor.js';
import { uuidv7 } from './uuid7.js';

export const APLICATIVO_IA = 'flito';
export const SERVICIO_IA = 'api';
export const MAX_ERROR_MENSAJE = 500;
export const MAX_DETALLE_BYTES = 64 * 1024;

/**
 * dev | qa | pdn | local. Orden: IA_CONSUMO_AMBIENTE (misma variable que FLIT) → DEPLOY_ENVIRONMENT → la regla de
 * Dr. Flit (producción sin ninguna de las dos se asume PDN).
 */
export function ambienteIa(
  e: { IA_CONSUMO_AMBIENTE?: string; DEPLOY_ENVIRONMENT?: string; NODE_ENV?: string } = env,
): string {
  if (e.IA_CONSUMO_AMBIENTE) return e.IA_CONSUMO_AMBIENTE.toLowerCase();
  if (e.DEPLOY_ENVIRONMENT) return e.DEPLOY_ENVIRONMENT.toLowerCase();
  return e.NODE_ENV === 'production' ? 'pdn' : 'local';
}

/** Recorta a `max` bytes UTF-8 sin partir un carácter. */
export function recortarBytes(texto: string | null | undefined, max = MAX_DETALLE_BYTES): string | null {
  if (texto === null || texto === undefined) return null;
  const buf = Buffer.from(texto, 'utf8');
  if (buf.length <= max) return texto;
  return buf.subarray(0, max).toString('utf8').replace(/�$/, '');
}

/** Mensaje de error apto para la fila: sin documentos (6-12 dígitos) ni correos, a 500 caracteres. */
export function mensajeSeguro(m: unknown): string | null {
  if (typeof m !== 'string' || !m) return null;
  const limpio = m.replace(/\b\d{6,12}\b/g, '[DOC]').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
  return limpio.length > MAX_ERROR_MENSAJE ? limpio.slice(0, MAX_ERROR_MENSAJE) : limpio;
}

export interface PromptRenderizado {
  texto: string;
  hash: string;
  /** media_type del primer adjunto (imagen o documento). */
  mime: string | null;
  /** Suma de los adjuntos decodificados (estimada desde el base64, sin decodificar). */
  bytes: number | null;
}

function bytesDeBase64(b64: string): number {
  const relleno = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - relleno);
}

/** Texto del prompt de un payload de la Messages API, sin base64. Nunca lanza. */
export function renderizarPrompt(payload: unknown): PromptRenderizado {
  const partes: string[] = [];
  let mime: string | null = null;
  let bytes = 0;
  let hayAdjuntos = false;
  const bloque = (b: unknown) => {
    if (typeof b === 'string') { partes.push(b); return; }
    const o = b as { type?: unknown; text?: unknown; source?: { media_type?: unknown; data?: unknown } } | null;
    if (!o || typeof o !== 'object') return;
    if (o.type === 'text' && typeof o.text === 'string') { partes.push(o.text); return; }
    if (o.type === 'image' || o.type === 'document') {
      const mt = typeof o.source?.media_type === 'string' ? o.source.media_type : 'desconocido';
      mime ??= mt;
      hayAdjuntos = true;
      if (typeof o.source?.data === 'string') bytes += bytesDeBase64(o.source.data);
      partes.push(`[${String(o.type)} ${mt}]`);
    }
  };
  try {
    const p = payload as { system?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> } | null;
    if (typeof p?.system === 'string') partes.push(p.system);
    else if (Array.isArray(p?.system)) p.system.forEach(bloque);
    for (const m of Array.isArray(p?.messages) ? p.messages : []) {
      if (Array.isArray(m?.content)) m.content.forEach(bloque);
      else bloque(m?.content);
    }
  } catch { /* payload raro: se registra lo que se haya podido leer */ }
  const texto = partes.join('\n');
  return {
    texto,
    hash: createHash('sha256').update(texto, 'utf8').digest('hex'),
    mime,
    bytes: hayAdjuntos ? bytes : null,
  };
}

export interface DatosConsumoIa {
  proveedor: ProveedorIa;
  inicio: Date;
  fin: Date;
  resultado: ResultadoIa;
  intento?: number;
  modeloSolicitado?: string | null;
  modeloRespondido?: string | null;
  idRespuestaProveedor?: string | null;
  maxTokens?: number | null;
  promptHash?: string | null;
  httpStatus?: number;
  stopReason?: string | null;
  errorCodigo?: string | null;
  errorMensaje?: string | null;
  tokensEntrada?: number;
  tokensSalida?: number;
  tokensCacheLectura?: number;
  tokensCacheEscritura?: number;
  /** Adjunto deducido del payload, si el contexto no declara uno. */
  archivo?: { mime: string | null; bytes: number | null };
  metadatos?: Record<string, unknown>;
  /** Si el contexto no declara `tipoTarea` (el contrato no tiene «desconocido» para este catálogo). */
  tipoTareaPorDefecto?: TipoTareaIa;
  promptTexto?: string | null;
  respuestaTexto?: string | null;
  /** Para tests: contexto explícito en lugar del ambiental. */
  contexto?: ContextoIa;
}

const entero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function origenDe(c: ContextoIa): OrigenIa {
  return c.origen ?? (c.usuarioId ? 'usuario' : 'job');
}

/** Arma la fila con el contexto vigente y la encola. Devuelve el id (para `anotarConsumoIa`) o null. */
export function registrarConsumoIa(d: DatosConsumoIa): string | null {
  try {
    if (!env.IA_CONSUMO_LOG) return null;
    const c = d.contexto ?? leerContextoIa();
    const id = uuidv7(d.inicio.getTime());
    const metadatos = { ...(c.metadatos ?? {}), ...(d.metadatos ?? {}) };
    const fila: FilaConsumoIa = {
      id,
      correlacionId: c.correlacionId ?? id,
      intento: Math.max(1, d.intento ?? 1),
      pasada: Math.max(1, c.pasada ?? 1),
      fechaInicio: d.inicio,
      fechaFin: d.fin,
      latenciaMs: Math.max(0, d.fin.getTime() - d.inicio.getTime()),
      aplicativo: APLICATIVO_IA,
      servicio: SERVICIO_IA,
      ambiente: ambienteIa(),
      tenantId: c.tenantId ?? null,
      usuarioId: c.usuarioId ?? null,
      usuarioLogin: c.usuarioLogin ?? null,
      origen: origenDe(c),
      modulo: c.modulo ?? MODULO_DESCONOCIDO,
      proceso: c.proceso ?? PROCESO_DESCONOCIDO,
      tipoTarea: c.tipoTarea ?? d.tipoTareaPorDefecto ?? 'ocr',
      placa: normalizarPlacaIa(c.placa),
      entidadTipo: c.entidadTipo ?? null,
      entidadId: c.entidadId === null || c.entidadId === undefined ? null : String(c.entidadId),
      archivoMime: c.archivo?.mime ?? d.archivo?.mime ?? null,
      archivoBytes: c.archivo?.bytes ?? d.archivo?.bytes ?? null,
      archivoPaginas: c.archivo?.paginas ?? null,
      archivoSha256: c.archivo?.sha256 ?? null,
      proveedor: d.proveedor,
      modeloSolicitado: d.modeloSolicitado ?? null,
      modeloRespondido: d.modeloRespondido ?? null,
      idRespuestaProveedor: d.idRespuestaProveedor ?? null,
      maxTokens: d.maxTokens ?? null,
      promptCodigo: c.promptCodigo ?? null,
      promptVersion: c.promptVersion ?? null,
      promptHash: d.promptHash ?? null,
      httpStatus: d.httpStatus ?? 0,
      resultado: d.resultado,
      stopReason: d.stopReason ?? null,
      errorCodigo: d.errorCodigo ?? null,
      errorMensaje: mensajeSeguro(d.errorMensaje),
      tokensEntrada: entero(d.tokensEntrada),
      tokensSalida: entero(d.tokensSalida),
      tokensCacheLectura: entero(d.tokensCacheLectura),
      tokensCacheEscritura: entero(d.tokensCacheEscritura),
      costoUsdEstimado: null,
      metadatos: Object.keys(metadatos).length > 0 ? metadatos : null,
    };
    const detalle = d.promptTexto !== undefined || d.respuestaTexto !== undefined
      ? { promptTexto: recortarBytes(d.promptTexto ?? null), respuestaTexto: recortarBytes(d.respuestaTexto ?? null) }
      : null;
    encolarConsumoIa(fila, detalle);
    return id;
  } catch {
    return null;
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────────────────────────

const RE_TIPO_ERROR = /^[a-z_]{1,40}$/;
/** `op` histórico del cliente → tipo de tarea, para llamadas sin contexto. */
const TAREA_POR_OP: Record<string, TipoTareaIa> = {
  ocr: 'ocr', biometric: 'validacion_identidad', checklist: 'chat', captcha: 'captcha', chat: 'chat', salud: 'salud',
};
export const tareaPorOp = (op: string): TipoTareaIa | undefined => TAREA_POR_OP[op];
/** 4xx que dicen «el contenido o el archivo no sirve», no «el servicio falló». */
const STATUS_RECHAZO = new Set([400, 413, 415, 422]);

export interface IntentoAnthropic {
  intento: number;
  inicio: Date;
  fin: Date;
  statusCode?: number;
  buffer?: Buffer;
  error?: { kind: 'timeout' | 'network'; message?: string };
}

export interface LlamadaAnthropic {
  modelo: string | null;
  maxTokens: number | null;
  prompt: PromptRenderizado;
  op: string;
  /** La salud de modelos pide `max_tokens: 1`: ahí cortar por tope es éxito, no respuesta inválida. */
  maxTokensEsExito?: boolean;
}

interface CuerpoAnthropic {
  id?: unknown;
  model?: unknown;
  stop_reason?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
  usage?: {
    input_tokens?: unknown; output_tokens?: unknown;
    cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
  };
  error?: { type?: unknown; message?: unknown };
}

function parsear(buffer: Buffer | undefined): CuerpoAnthropic | null {
  if (!buffer || buffer.length === 0) return null;
  try {
    const v = JSON.parse(buffer.toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as CuerpoAnthropic) : null;
  } catch {
    return null;
  }
}

const textoDe = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Clasifica un intento según el catálogo `resultado` del contrato. */
export function clasificarIntentoAnthropic(
  i: Pick<IntentoAnthropic, 'statusCode' | 'error'>, cuerpo: CuerpoAnthropic | null, maxTokensEsExito = false,
): { resultado: ResultadoIa; errorCodigo: string | null } {
  if (i.error) return { resultado: i.error.kind === 'timeout' ? 'timeout' : 'red', errorCodigo: i.error.kind };
  const s = i.statusCode ?? 0;
  const tipo = typeof cuerpo?.error?.type === 'string' && RE_TIPO_ERROR.test(cuerpo.error.type) ? cuerpo.error.type : null;
  if (s === 429) return { resultado: 'rate_limit', errorCodigo: tipo ?? 'http_429' };
  if (s >= 200 && s < 300) {
    if (!cuerpo) return { resultado: 'respuesta_invalida', errorCodigo: 'cuerpo_no_json' };
    if (cuerpo.error) return { resultado: 'respuesta_invalida', errorCodigo: tipo ?? 'error_en_200' };
    if (cuerpo.stop_reason === 'max_tokens' && !maxTokensEsExito) return { resultado: 'respuesta_invalida', errorCodigo: 'max_tokens' };
    if (cuerpo.stop_reason === 'refusal') return { resultado: 'respuesta_invalida', errorCodigo: 'refusal' };
    return { resultado: 'exito', errorCodigo: null };
  }
  if (s === 0) return { resultado: 'red', errorCodigo: 'sin_status' };
  if (STATUS_RECHAZO.has(s)) return { resultado: 'rechazado', errorCodigo: tipo ?? `http_${s}` };
  return { resultado: 'error_proveedor', errorCodigo: tipo ?? `http_${s}` };
}

/** Registra un intento HTTP contra la Messages API. Devuelve el id de la fila o null. */
export function registrarIntentoAnthropic(llamada: LlamadaAnthropic, i: IntentoAnthropic): string | null {
  try {
    if (!env.IA_CONSUMO_LOG) return null;
    const cuerpo = parsear(i.buffer);
    const { resultado, errorCodigo } = clasificarIntentoAnthropic(i, cuerpo, llamada.maxTokensEsExito);
    const respuesta = Array.isArray(cuerpo?.content)
      ? cuerpo.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
      : null;
    return registrarConsumoIa({
      proveedor: 'anthropic',
      inicio: i.inicio,
      fin: i.fin,
      intento: i.intento,
      resultado,
      modeloSolicitado: llamada.modelo,
      modeloRespondido: textoDe(cuerpo?.model),
      idRespuestaProveedor: textoDe(cuerpo?.id),
      maxTokens: llamada.maxTokens,
      promptHash: llamada.prompt.hash,
      httpStatus: i.error ? 0 : (i.statusCode ?? 0),
      stopReason: textoDe(cuerpo?.stop_reason),
      errorCodigo,
      errorMensaje: i.error ? (i.error.message ?? null) : (resultado === 'exito' ? null : textoDe(cuerpo?.error?.message)),
      tokensEntrada: entero(cuerpo?.usage?.input_tokens),
      tokensSalida: entero(cuerpo?.usage?.output_tokens),
      tokensCacheLectura: entero(cuerpo?.usage?.cache_read_input_tokens),
      tokensCacheEscritura: entero(cuerpo?.usage?.cache_creation_input_tokens),
      archivo: { mime: llamada.prompt.mime, bytes: llamada.prompt.bytes },
      metadatos: { op: llamada.op },
      tipoTareaPorDefecto: tareaPorOp(llamada.op),
      ...(env.IA_CONSUMO_DETALLE ? { promptTexto: llamada.prompt.texto, respuestaTexto: respuesta } : {}),
    });
  } catch {
    return null;
  }
}
