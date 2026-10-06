// HU #13310 (Feature #13309, ADR-0021) — funciones puras del envío del comprobante de pago a FLIT 1.
// Sin red ni estado: las prueba `__tests__/services/flit1-adjuntos.test.ts`.
//
// RN-F1-A1 Id real (AC2, ADR-0021 §7 + A-3). `FLIT-0[124]<dígitos>` → los dígitos SIN ceros a la
//   izquierda (`FLIT-012345` → `2345`, `FLIT-010045` → `45`). Todo ceros u otro formato → null (= `error`
//   sin llamar).
// RN-F1-A2 Bases (D-8). `https:`, sin user/pass, sin query ni hash; path permitido (el stage), barra
//   final recortada. Inválida = ausente.
// RN-F1-A3 URL de subida (A-1). Sale de la respuesta del paso 1 y se valida en código: `https:`, sin
//   credenciales, hostname en minúsculas terminado en `.amazonaws.com` (con el punto: `evilamazonaws.com`
//   no pasa). No hay variable de allowlist.
// RN-F1-A4 Clasificación (diseño §5.1 + A-2). 429/5xx → reintentable; 403/404 de un host FLIT1_* sin
//   cuerpo o con el cuerpo de API Gateway → pausa de configuración; el resto de 4xx → definitivo. El
//   cuerpo NUNCA se guarda ni se loguea: solo decide la rama.

export const CATEGORIA_FLIT1 = 'impuestos-flito';
/** Timeouts por paso (el 2 sube hasta 20 MB). Timeout = `red` (reintentable). */
export const TIMEOUTS_FLIT1_MS = { 1: 10_000, 2: 60_000, 3: 15_000 } as const;
/** Tope de lectura del cuerpo 2xx del paso 1: más grande = `respuesta_invalida`. */
export const MAX_CUERPO_PASO1_BYTES = 64 * 1024;
/** Tope de lectura de un cuerpo de error 403/404 (solo para clasificarlo; nunca se guarda). */
export const MAX_CUERPO_ERROR_BYTES = 4 * 1024;
const SUFIJO_S3 = '.amazonaws.com';
const MAX_ID_ARCHIVO = 100;

/** RN-F1-A1. null = id inválido (AC2): la fila pasa a `error` sin llamar a FLIT 1. */
export function idRealDeIdFlit(idFlit: string | null | undefined): string | null {
  if (typeof idFlit !== 'string') return null;
  const m = /^FLIT-0[124](\d+)$/.exec(idFlit);
  if (!m) return null;
  const sinCeros = m[1]!.replace(/^0+/, '');
  return sinCeros === '' ? null : sinCeros;
}

/** RN-F1-A2. Devuelve la base normalizada (sin barra final) o null si falta o no es válida. */
export function baseFlit1Valida(v: string | null | undefined): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/** RN-F1-A3. La URL de subida validada, o null (→ pausa global, sin consumir intento). */
export function urlSubidaFlit1Permitida(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(SUFIJO_S3) || host.length === SUFIJO_S3.length) return null;
  return u;
}

export interface RespuestaArchivoFlit1 { id: string; url: string; fields: Array<[string, string]> }

/**
 * Cuerpo 2xx del paso 1 → `{ id, url, fields }` (fields en el orden recibido), o null si no cumple la
 * forma (D-7 → reintentable `respuesta_invalida`).
 */
export function parsearRespuestaArchivo(json: unknown): RespuestaArchivoFlit1 | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const c = json as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id.trim() || c.id.length > MAX_ID_ARCHIVO) return null;
  const p = c.presignedUrl;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const { url, fields } = p as Record<string, unknown>;
  if (typeof url !== 'string' || !url) return null;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const pares = Object.entries(fields as Record<string, unknown>);
  if (!pares.every(([, v]) => typeof v === 'string')) return null;
  return { id: c.id, url, fields: pares as Array<[string, string]> };
}

/** Mensajes con los que API Gateway responde a una ruta sin desplegar o sin permiso. */
const MENSAJES_API_GATEWAY = new Set(['missing authentication token', 'forbidden', 'not found']);

/**
 * A-2: ¿el cuerpo de un 403/404 es «de configuración»? Vacío, no JSON, o `{ "message": <de API Gateway> }`
 * y nada más. Un JSON con otra forma (el error propio del backend de FLIT 1) NO lo es.
 * `null` = no se pudo leer o superó el tope: se trata como cuerpo propio (definitivo).
 */
export function esCuerpoDeConfiguracion(texto: string | null): boolean {
  if (texto === null) return false;
  if (!texto.trim()) return true;
  let cuerpo: unknown;
  try { cuerpo = JSON.parse(texto); } catch { return true; }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return false;
  const c = cuerpo as Record<string, unknown>;
  const claves = Object.keys(c);
  return claves.length === 1 && claves[0] === 'message' && typeof c.message === 'string'
    && MENSAJES_API_GATEWAY.has(c.message.trim().toLowerCase());
}

export type ClaseStatusFlit1 = 'reintentable' | 'pausa' | 'definitivo';

/**
 * RN-F1-A4 para un status ≠ 2xx. `cuerpo` solo se mira en 403/404 de los pasos 1 y 3 (hosts FLIT1_*);
 * el paso 2 es S3 y sus 4xx (policy vencida, tamaño) son definitivos.
 */
export function clasificarStatusFlit1(paso: 1 | 2 | 3, status: number, cuerpo: string | null): ClaseStatusFlit1 {
  if (status === 429 || status >= 500 || status < 400) return 'reintentable';
  if ((status === 403 || status === 404) && paso !== 2 && esCuerpoDeConfiguracion(cuerpo)) return 'pausa';
  return 'definitivo';
}
