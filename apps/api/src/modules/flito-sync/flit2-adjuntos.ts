// FLITO sync — envío de un adjunto a FLIT 2: piezas puras (HU #13268, Feature #13267, ADR-0020).
// Contrato: `POST /api/v1/external/tramites/{id}/adjuntos` (operationId `enviarAdjunto`,
// `flitsas/flit@c2b7f68db`), diseño `docs/diseno/feature-13267-envio-comprobante-flit2.md` §5.
//
// - `clasificarRespuestaAdjunto` es la tabla §5 entera, sin red: se decide por `code`, NUNCA por
//   `detail`. Las extensiones `estado` y `terminal` solo se leen en `not_allowed_in_state`.
// - Un 404 SIN cuerpo problem+json es «la ruta aún no existe» (HU #13263 de FLIT 2 sin desplegar):
//   pausa global, no un error del ítem. Solo el 404 `procedure_not_found` es definitivo.
// - Ningún valor de aquí lleva PII: códigos, estados HTTP e ids.

import { z } from 'zod';
import type { AdjuntoRecibidoFlit2, ResultadoEnvioAdjunto } from './flit2-sync.port.js';

/** Tipo de adjunto que FLITO envía (catálogo de FLIT 2). */
export const TIPO_LIQUIDACION_IMPUESTO = 'liquidacion_impuesto';
/** Límite del contrato (D-8): 20 MB. */
export const MAX_BYTES_ADJUNTO = 20 * 1024 * 1024;
/** MIME que FLIT 2 admite (D-8). Va como Content-Type de la parte `file`. */
export const MIMES_ADJUNTO = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type MimeAdjunto = typeof MIMES_ADJUNTO[number];
/**
 * Estados de FLIT 2 (código crudo del contrato, minúscula) en los que el trámite admite el adjunto
 * (§1). `rechazado` entra aunque FLITO no sepa si tiene subsanación activa: si FLIT 2 vuelve a
 * responder `terminal:false`, la fila se re-estaciona sin gastar intento.
 */
export const ESTADOS_FLIT2_ADMITEN_ADJUNTO = ['preasignacion', 'asignado', 'entregado', 'rechazado'] as const;

const RUTA_ADJUNTOS = (id: string): string => `/api/v1/external/tramites/${encodeURIComponent(id)}/adjuntos`;

/** Cuerpo RFC 7807 de FLIT 2, reducido a lo que decide. null = la respuesta NO es problem+json. */
export interface ProblemaFlit2 {
  code: string;
  /** Solo en `not_allowed_in_state`. undefined = ausente o no booleano. */
  terminal?: boolean;
  /** Solo en `not_allowed_in_state`: estado del trámite en FLIT 2. */
  estado?: string;
}

/** `AdjuntoRecibido` del contrato (201 y 200 tienen el mismo cuerpo). */
export const adjuntoRecibidoSchema = z.object({
  adjuntoId: z.string().uuid(),
  tipo: z.string().min(1).max(60),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  reemplazoDe: z.string().uuid().nullable().optional().transform((v) => v ?? null),
  enMatriz: z.boolean(),
  pagadoMarcado: z.boolean(),
}).passthrough();

/** Código con forma de código (mismo criterio que el pase y el feed). */
function comoCodigo(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const codigo = valor.split('/').pop() ?? '';
  return /^[a-z_]{1,40}$/.test(codigo) ? codigo : null;
}

/**
 * Cuerpo de error → `ProblemaFlit2`, o null si no es un problem+json con `code` (cuerpo vacío, HTML de
 * un proxy, JSON sin código). Pura: recibe el texto ya leído. El texto NUNCA va a un log.
 */
export function problemaDesdeTexto(texto: string | null): ProblemaFlit2 | null {
  if (!texto || !texto.trim()) return null;
  let cuerpo: unknown;
  try { cuerpo = JSON.parse(texto); } catch { return null; }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return null;
  const c = cuerpo as Record<string, unknown>;
  let code: string | null = null;
  for (const campo of ['code', 'error', 'type', 'title']) {
    code = comoCodigo(c[campo]);
    if (code) break;
  }
  if (!code) return null;
  const problema: ProblemaFlit2 = { code };
  if (code === 'not_allowed_in_state') {
    if (typeof c.terminal === 'boolean') problema.terminal = c.terminal;
    if (typeof c.estado === 'string' && c.estado.trim()) problema.estado = c.estado.trim().slice(0, 30);
  }
  return problema;
}

/** Lee el cuerpo de una respuesta de error (sin lanzar) y lo reduce con `problemaDesdeTexto`. */
export async function leerProblema(res: Response): Promise<ProblemaFlit2 | null> {
  try { return problemaDesdeTexto(await res.text()); } catch { return null; }
}

/**
 * URL del envío, o null si `idFlit2` no es un segmento seguro (vacío, `.` o `..`: misma guarda que
 * `urlDeAdjunto`). null → `definitivo procedure_not_found` SIN llamar.
 */
export function urlDeEnvioAdjunto(base: string, idFlit2: string): URL | null {
  const id = idFlit2.trim();
  if (!id || id === '.' || id === '..') return null;
  return new URL(RUTA_ADJUNTOS(id), base);
}

/** Tipo real por bytes, SIN caída a PDF: lo que no es pdf/jpeg/png/webp → null (pre-validación RN-06). */
export function mimeAdjuntoPorBytes(buf: Buffer): MimeAdjunto | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const EXTENSION_POR_MIME: Record<MimeAdjunto, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

/** Lo que llega en un 200/201 para validarlo contra el contrato y el sha256 local. */
export interface ExitoCrudo {
  cuerpo: unknown;
  sha256Local: string;
}

function clasificarExito(status: number, exito: ExitoCrudo | undefined): ResultadoEnvioAdjunto {
  const r = adjuntoRecibidoSchema.safeParse(exito?.cuerpo);
  if (!r.success) return { tipo: 'reintentable', codigo: 'respuesta_invalida', status };
  if (!exito || r.data.sha256.toLowerCase() !== exito.sha256Local.toLowerCase()) {
    return { tipo: 'reintentable', codigo: 'sha256_distinto', status };
  }
  const recibido: AdjuntoRecibidoFlit2 = {
    adjuntoId: r.data.adjuntoId, tipo: r.data.tipo, sha256: r.data.sha256.toLowerCase(),
    reemplazoDe: r.data.reemplazoDe, enMatriz: r.data.enMatriz, pagadoMarcado: r.data.pagadoMarcado,
  };
  return { tipo: 'enviado', nuevo: status === 201, recibido };
}

/**
 * La tabla §5 del diseño, fila a fila. Pura: sin red, sin reloj. `problema` es null cuando la
 * respuesta no trae problem+json; `retryAfter` en segundos (solo el 429 lo usa); `exito` solo en 2xx.
 */
export function clasificarRespuestaAdjunto(
  status: number, problema: ProblemaFlit2 | null, retryAfter: number | null, exito?: ExitoCrudo,
): ResultadoEnvioAdjunto {
  const code = problema?.code ?? null;
  if (status === 200 || status === 201) return clasificarExito(status, exito);
  if (status === 401) return { tipo: 'reintentable', codigo: 'invalid_token', status };
  if (status === 403 && code === 'insufficient_scope') return { tipo: 'pausa', codigo: 'insufficient_scope', status };
  if (status === 404) {
    if (problema === null) return { tipo: 'pausa', codigo: 'no_disponible', status };
    if (code === 'procedure_not_found') return { tipo: 'definitivo', motivo: 'procedure_not_found', status };
  }
  if (status === 400) {
    if (code === 'missing_file' || code === 'invalid_mime' || code === 'file_too_large') {
      return { tipo: 'definitivo', motivo: code, status };
    }
    if (code === 'invalid_tipo') return { tipo: 'pausa', codigo: 'invalid_tipo', status };
  }
  if (status === 409) {
    if (code === 'attachment_exists') return { tipo: 'definitivo', motivo: 'attachment_exists', status };
    if (code === 'not_allowed_in_state') {
      if (problema?.terminal === true) {
        return { tipo: 'definitivo', motivo: 'not_allowed_in_state', status, ...(problema.estado ? { estadoFlit2: problema.estado } : {}) };
      }
      if (problema?.terminal === false) return { tipo: 'estacionar', estadoFlit2: problema.estado ?? '' };
      // Sin `terminal` booleano: fuera de contrato, se cuenta como intento.
      return { tipo: 'reintentable', codigo: 'respuesta_invalida', status };
    }
  }
  if (status === 429) {
    // El contrato lo manda siempre (entero); 60 solo como defensa si faltara.
    return { tipo: 'espera', segundos: retryAfter !== null && retryAfter >= 0 ? retryAfter : 60 };
  }
  if (status >= 500) return { tipo: 'reintentable', codigo: code ?? `http_${status}`, status };
  return { tipo: 'reintentable', codigo: `inesperado_${status}`, status };
}
