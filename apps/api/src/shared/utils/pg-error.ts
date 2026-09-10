/**
 * Códigos SQLSTATE que llegan envueltos: drizzle (postgres-js) envuelve el error del driver en un
 * `DrizzleQueryError` cuyo `cause` es el `PostgresError` con `code` y con el MENSAJE del trigger. Se
 * sigue la cadena `cause` (tope 5) porque ni el `code` ni el texto viven en el error de fuera.
 */

/** El error de la cadena `cause` que lleva ese SQLSTATE, o `null` si ninguno lo lleva. */
export function errorPg(e: unknown, codigo: string): { code: string; message: string } | null {
  for (let actual: unknown = e, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') break;
    if ((actual as { code?: unknown }).code === codigo) {
      const message = (actual as { message?: unknown }).message;
      return { code: codigo, message: typeof message === 'string' ? message : '' };
    }
    actual = (actual as { cause?: unknown }).cause;
  }
  return null;
}

/** ¿Es este error el código SQLSTATE dado? */
export function esCodigoPg(e: unknown, codigo: string): boolean {
  return errorPg(e, codigo) !== null;
}
