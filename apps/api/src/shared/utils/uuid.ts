// Validación de UUID en el borde HTTP (Bug #11622).
//
// Existe como archivo propio porque el mismo criterio lo necesitan dos capas que no se conocen
// entre sí: el middleware de `X-Request-Id` en `app.ts` y el saneo previo al INSERT en
// `shared/pii-audit.ts`. Dos regex copiadas serían dos criterios que se separan con el tiempo, y el
// que se quedara corto volvería a abrir el 22P02 que este bug cierra.
//
// ── El criterio no es «RFC 4122», es «la columna `uuid` lo acepta» ───────────────────────────────
//
// Errar por defecto no rompe nada —se descarta un id que era bueno y se genera otro—, mientras que
// errar por exceso devuelve el 22P02 que borraba la fila de `pii_access_log`. Pero «no rompe nada»
// no es gratis: cada valor que se rechaza de más es una correlación que se pierde. De ahí las dos
// decisiones de esta lista:
//
//   · **No se comprueban versión ni variante.** PostgreSQL admite los 32 dígitos hex con cualquier
//     nibble ahí —el UUID nil `00000000-…-000000000000` incluido—, así que exigir `[1-8]` tiraría
//     identificadores que la columna sí guarda.
//   · **Se acepta la forma de 32 hex SIN guiones**, que PostgreSQL también admite. No es un capricho
//     teórico: es exactamente `$request_id` de nginx, el generador de `X-Request-Id` más probable
//     delante de esta API. Hoy ese valor llega hasta la tabla y se guarda (PostgreSQL lo canoniza al
//     insertarlo); rechazarlo aquí sería romper en silencio una correlación que funciona, justo el
//     tipo de daño colateral que este bug vino a evitar. Se devuelve TAL CUAL —sin añadirle
//     guiones— para que la cadena que el API escribe en sus logs siga siendo `grep`-able contra la
//     del proxy que la emitió; la normalización a 8-4-4-4-12 la hace PostgreSQL en la columna.
//
// Lo que queda fuera es la forma con llaves `{…}` y los guiones en posiciones arbitrarias que
// `uuid_in` tolera: ningún generador real las produce y admitirlas obligaría a imitar el parser de
// PostgreSQL en una regex, que es la clase de cosa que se desvía del original con la siguiente
// versión. Un valor así se descarta y se genera uno nuevo; nada se rompe.

/** Forma canónica 8-4-4-4-12. */
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 dígitos hex seguidos — `$request_id` de nginx y equivalentes. */
const UUID_SIN_GUIONES = /^[0-9a-f]{32}$/i;

/**
 * `true` si `valor` es un string que una columna `uuid` de PostgreSQL va a aceptar.
 *
 * Acepta `unknown` a propósito: las cabeceras de Express pueden llegar como `string[]` cuando el
 * cliente repite la cabecera, y quien llama no debería tener que acordarse de filtrar el tipo antes.
 */
export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && (UUID_CANONICO.test(valor) || UUID_SIN_GUIONES.test(valor));
}
