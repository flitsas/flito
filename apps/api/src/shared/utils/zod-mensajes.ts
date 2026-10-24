/**
 * Mensajes por tipo de zod 3 (`required_error` / `invalid_type_error`) en zod 4 — Bug #13928.
 *
 * zod 4 retiró esos dos parámetros y los unificó en `error`, que además se aplica a TODOS los
 * issues del esquema (también a un `.min()`/`.max()` sin mensaje propio). Este mapa conserva la
 * semántica de zod 3: solo responde a `invalid_type`,
 * - `requerido` cuando el valor no viene (`undefined`),
 * - `tipo` cuando viene con un tipo incorrecto (en `z.coerce`, también lo que no convierte: NaN).
 * Lo que no cubre devuelve `undefined` y zod usa su mensaje por defecto, como antes.
 */
export function mensajesDeTipo(m: { requerido?: string; tipo?: string }) {
  return (iss: { code?: string; input?: unknown }): string | undefined => {
    if (iss.code !== 'invalid_type') return undefined;
    return iss.input === undefined ? m.requerido : m.tipo;
  };
}
