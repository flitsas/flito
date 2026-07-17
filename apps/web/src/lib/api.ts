const BASE = '/api';

// Tope duro de tiempo por petición. Sin esto, un fetch contra una dependencia
// lenta que nunca responde (p.ej. la cadena RUNT del SOAT) deja la promesa
// colgada para siempre → el `finally` que apaga el spinner nunca corre.
// 90s da margen al peor caso de RUNT (captcha + sub-peticiones) pero garantiza
// que el cliente SIEMPRE resuelve o falla con un error legible.
const REQUEST_TIMEOUT_MS = 90_000;

function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string) {
  localStorage.setItem('token', token);
}

export function clearToken() {
  localStorage.removeItem('token');
}

// ---------------------------------------------------------------------------
// Fin de sesión (F-2): en vez de window.location.href (recarga dura que pierde
// el contexto y el motivo), emitimos un evento que AuthProvider escucha para
// hacer logout vía router (navegación SPA). Guardamos el motivo y la ruta para
// que Login muestre el mensaje correcto y devuelva al usuario a donde estaba.
// ---------------------------------------------------------------------------
export const SESSION_ENDED_EVENT = 'auth:session-ended';
export type SessionEndReason = 'invalidated' | 'expired';

function endSession(reason: SessionEndReason): void {
  clearToken();
  try {
    sessionStorage.setItem('auth:end-reason', reason);
    const current = window.location.pathname + window.location.search;
    if (!current.startsWith('/login')) sessionStorage.setItem('auth:redirect', current);
  } catch { /* sessionStorage no disponible */ }
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
}

/** Lee y limpia el motivo de fin de sesión (consumido una vez por Login). */
export function consumeSessionEndReason(): SessionEndReason | null {
  try {
    const r = sessionStorage.getItem('auth:end-reason');
    if (r === 'invalidated' || r === 'expired') {
      sessionStorage.removeItem('auth:end-reason');
      return r;
    }
  } catch { /* ignore */ }
  return null;
}

/** Lee y limpia la ruta previa para volver tras re-login. Default '/'. */
export function consumeRedirectPath(): string {
  try {
    const p = sessionStorage.getItem('auth:redirect');
    sessionStorage.removeItem('auth:redirect');
    if (p && p.startsWith('/') && !p.startsWith('/login')) return p;
  } catch { /* ignore */ }
  return '/';
}

/**
 * Error de API con contexto preservado: status HTTP, mensaje del backend, y fieldErrors zod.
 * Permite al frontend distinguir entre validación, conflicto, no autorizado, etc.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly fieldErrors?: Record<string, string[]>;
  public readonly rawDetails?: unknown;

  constructor(status: number, message: string, fieldErrors?: Record<string, string[]>, rawDetails?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.rawDetails = rawDetails;
  }

  /** Texto legible para mostrar al usuario, con detalles de validación si los hay. */
  toUserMessage(): string {
    if (this.fieldErrors) {
      const flat = Object.entries(this.fieldErrors)
        .flatMap(([field, msgs]) => msgs.map((m) => `${field}: ${m}`));
      if (flat.length > 0) return flat.join(' · ');
    }
    return this.message;
  }
}

function statusToMessage(status: number, backendMsg?: string): string {
  if (backendMsg) return backendMsg;
  if (status === 0) return 'Sin conexión con el servidor';
  if (status === 400) return 'Solicitud inválida';
  if (status === 403) return 'Sin permisos para esta operación';
  if (status === 404) return 'Recurso no encontrado';
  if (status === 409) return 'Conflicto — recargue y reintente';
  if (status === 429) return 'Demasiadas solicitudes, espere un momento';
  if (status >= 500 && status < 600) return 'Error del servidor — intente más tarde';
  return `Error ${status}`;
}

async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const opts: RequestInit = { method, headers };

  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  opts.signal = controller.signal;
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    // AbortError = se cumplió el tope de tiempo (no es "sin conexión").
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, 'La consulta tardó demasiado. Intente de nuevo.');
    }
    throw new ApiError(0, statusToMessage(0));
  } finally {
    clearTimeout(timeoutId);
  }

  // 401 global → fin de sesión vía evento (navegación SPA), no recarga dura.
  // EXCEPCIÓN: el propio /auth/login devuelve 401 para credenciales inválidas.
  // No disparar ahí — dejamos que el componente Login muestre el mensaje real
  // ("Credenciales inválidas") en el toast.
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    const backendMsg = typeof data?.error === 'string' ? data.error : '';
    // El backend distingue "Sesión invalidada…" (permisos cambiados por admin) del
    // resto (token expirado/ inválido). Mapeamos a un motivo legible para Login.
    endSession(/invalidad/i.test(backendMsg) ? 'invalidated' : 'expired');
    throw new ApiError(401, backendMsg || 'Sesión expirada');
  }

  // File downloads — pasar a través como blob.
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('spreadsheet') || ct.includes('octet-stream') || ct.includes('zip') || ct.includes('pdf') || ct.includes('csv') || ct.includes('image/')) {
    return res.blob() as unknown as T;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    // Algunos handlers devuelven `error`, otros `message` (p.ej. vehicles/ocr).
    // Aceptamos ambos para no caer al genérico cuando el backend ya dio contexto.
    const backendMsg = typeof data?.error === 'string'
      ? data.error
      : typeof data?.message === 'string'
        ? data.message
        : undefined;
    const details = (data?.details ?? null) as { fieldErrors?: Record<string, string[]> } | null;
    throw new ApiError(res.status, statusToMessage(res.status, backendMsg), details?.fieldErrors, data);
  }

  // 204 No Content (típicamente DELETE) y respuestas vacías: no parsear JSON.
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as unknown as T;
  return res.json();
}

export const api = {
  get: <T>(path: string, extraHeaders?: Record<string, string>) => request<T>('GET', path, undefined, extraHeaders),
  post: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('POST', path, body, extraHeaders),
  patch: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('PATCH', path, body, extraHeaders),
  put: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) => request<T>('PUT', path, body, extraHeaders),
  delete: <T>(path: string, extraHeaders?: Record<string, string>) => request<T>('DELETE', path, undefined, extraHeaders),
  upload: <T>(path: string, file: File, fieldName = 'file', fields?: Record<string, string>) => {
    const form = new FormData();
    form.append(fieldName, file);
    if (fields) for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return request<T>('POST', path, form);
  },
  download: async (path: string, filename: string) => {
    const blob = await request<Blob>('GET', path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  /** POST que devuelve un PDF/blob (p.ej. generación de documentos legales) y lo descarga. */
  downloadPost: async (path: string, filename: string, body?: unknown) => {
    const blob = await request<Blob>('POST', path, body);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/** Helper para extraer un mensaje útil de cualquier error (incluyendo ApiError y otros). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.toUserMessage();
  if (err instanceof Error) return err.message;
  return 'Error desconocido';
}
