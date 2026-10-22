// Helpers PUROS del borrado en el almacenamiento (HU #13410): sin cliente MinIO ni E/S.
//
// Viven aparte de `storage.ts` a propósito: muchos specs mockean `storage.js` con una fábrica cerrada
// (`vi.mock(..., () => ({ removeEntityDocument, ... }))`), y un módulo que importara estos helpers
// desde ahí recibiría `undefined` en esos tests. `storage.ts` los re-exporta para quien ya lo importa.
//
// Las claves de almacenamiento llevan la carpeta del NIT y a veces el nombre del archivo: son PII
// (Ley 1581, AGENTS.md §14). A logs y a la base solo va la huella y el código del error.

import { createHash } from 'node:crypto';

/** Huella corta de una clave para correlacionar sin escribirla (sha256, 16 hex). */
export function huellaClave(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * ¿El almacenamiento dijo «ese objeto no existe»? Para un borrado eso es «borrado». `code`/`name`
 * `NoSuchKey`, `NotFound` o `NoSuchObject` (S3Error del cliente MinIO) o HTTP 404. Cualquier otro
 * error (`AccessDenied`, red, timeout) es fallo.
 */
export function esObjetoInexistente(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; name?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const codigos = ['NoSuchKey', 'NotFound', 'NoSuchObject'];
  return codigos.includes(String(o.code)) || codigos.includes(String(o.name))
    || o.statusCode === 404 || o.$metadata?.httpStatusCode === 404;
}

/** Nombre/código del error para logs y columnas: nunca el mensaje, que puede repetir la clave. */
export function nombreDeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; name?: unknown };
    if (typeof o.code === 'string' && o.code) return o.code;
    if (typeof o.name === 'string' && o.name) return o.name;
  }
  return 'error';
}
