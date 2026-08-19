// Siigo API — redacción de los mensajes de error antes de que salgan del proceso.
//
// Motivo (hallazgo Medium de la auditoría de la HU #11281): a partir de `drizzle-orm` 0.45,
// `pg-core/session.js` envuelve TODO error del driver en un `DrizzleQueryError` cuyo `message` se
// construye literalmente como `Failed query: <SQL>\nparams: <valores enlazados>`. Es decir: la
// sentencia completa —nombres de tabla y de columnas— y todos sus parámetros, que en el catálogo de
// vendedores son los nombres de personas.
//
// Ese `message` viajaba a dos sitios: la respuesta HTTP y la bitácora `siigo_operaciones`, que es
// WORM de verdad (`0126_siigo_operaciones_worm.sql` bloquea UPDATE y DELETE por disparador). Lo que
// entra ahí NO SE PUEDE DEPURAR DESPUÉS, y eso choca de frente con los derechos de rectificación y
// supresión de la Ley 1581 (art. 8). La corrección de la causa está en el servicio de catálogos —el
// fallo de persistencia ahora es un error de dominio con mensaje fijo—; esto es la segunda línea:
// aunque otro flujo futuro registre un error crudo, la sentencia no llega a escribirse.
//
// No se intenta «limpiar» el SQL dejando solo lo inocuo: se CORTA en la primera marca y se
// reemplaza el resto por una marca fija. Un saneamiento parcial exigiría entender la sentencia, y
// cualquier hueco en ese entendimiento se convierte en una fila inmutable con datos personales.

/** Sustituto de todo lo que vaya detrás de la primera marca de SQL. */
export const MARCA_SQL_OMITIDO = '[consulta SQL omitida]';

/** Sustituto del valor de un filtro que puede llevar datos del titular. */
export const MARCA_FILTRO_OMITIDO = '[filtro omitido]';

/**
 * Filtros de una URL cuyo VALOR puede ser un dato personal.
 *
 * `customer_identification` es un NIT casi siempre y una **cédula** cuando el cliente es persona
 * natural. Aparece en la cadena de consulta de las búsquedas contra Siigo, y basta con que un error
 * mencione la ruta para que acabe en `siigo_operaciones.mensaje`, que prohíbe UPDATE y DELETE: una
 * vez escrito, los derechos de rectificación y supresión (Ley 1581, art. 8 lit. d y e) ya no se
 * pueden ejercer sobre él. Se recorta el valor y se conserva el nombre, que es lo que sirve para
 * entender qué se estaba buscando.
 */
const FILTROS_CON_PII = /\b(customer_identification|identification|document|nit|cedula)=[^&\s"']*/gi;

function redactarFiltrosDeRuta(mensaje: string): string {
  return mensaje.replace(FILTROS_CON_PII, (_m, clave: string) => `${clave}=${MARCA_FILTRO_OMITIDO}`);
}

/**
 * Tope de longitud del mensaje. La columna es `text`, así que no lo impone la base: lo impone que
 * una bitácora inmutable no puede crecer sin límite por un error con un volcado dentro.
 */
export const MAX_LONGITUD_MENSAJE = 1000;

/**
 * Marcas de que un mensaje trae una sentencia dentro.
 *
 * Las dos primeras son la envoltura exacta de drizzle ≥ 0.45. Las demás son SQL compilado por el
 * dialecto de Postgres de drizzle, que siempre entrecomilla los identificadores (`insert into
 * "siigo_catalogos"`): exigir la comilla es lo que evita que un mensaje operativo en español que
 * mencione «select» o «update» se recorte por error.
 */
const PATRONES_SQL: RegExp[] = [
  /failed query:/i,
  /(^|\n)\s*params:\s/i,
  /\binsert\s+into\s+"/i,
  /\bupdate\s+"[^"]+"\s+set\b/i,
  /\bdelete\s+from\s+"/i,
  /\bselect\s[^;]{0,400}?\sfrom\s+"/i,
  /\bon\s+conflict\s*\(/i,
];

/**
 * Devuelve el mensaje sin la sentencia SQL ni sus valores enlazados, y acotado en longitud.
 *
 * Conserva lo que hubiera ANTES de la marca: cuando un error de dominio antepone su propia
 * explicación a un mensaje del motor, esa explicación es justo lo que sirve para operar.
 */
export function sanearMensaje(mensaje: string): string {
  let corte = -1;
  for (const patron of PATRONES_SQL) {
    const m = patron.exec(mensaje);
    if (m && (corte === -1 || m.index < corte)) corte = m.index;
  }

  let salida = mensaje;
  if (corte !== -1) {
    const prefijo = mensaje.slice(0, corte).trimEnd();
    salida = prefijo.length > 0 ? `${prefijo} ${MARCA_SQL_OMITIDO}` : MARCA_SQL_OMITIDO;
  }

  salida = redactarFiltrosDeRuta(salida);

  return salida.length > MAX_LONGITUD_MENSAJE
    ? `${salida.slice(0, MAX_LONGITUD_MENSAJE)}…`
    : salida;
}

/**
 * Detalle técnico de un error, apto para el LOG DEL SERVIDOR.
 *
 * Prefiere la causa del driver (`value too long for type character varying(200)`, `statement
 * timeout`) sobre el mensaje de la envoltura de drizzle: dice exactamente lo mismo para depurar y no
 * lleva ni la sentencia ni los parámetros. Y aun así pasa por `sanearMensaje`, porque el log
 * también se conserva y también está sujeto a la Ley 1581.
 */
export function detalleTecnico(entrada: unknown): string {
  const causa = (entrada as { cause?: unknown } | null | undefined)?.cause;
  if (causa instanceof Error) return sanearMensaje(`${causa.name}: ${causa.message}`);
  if (entrada instanceof Error) return sanearMensaje(`${entrada.name}: ${entrada.message}`);
  return sanearMensaje(String(entrada));
}

/**
 * ¿Es una violación de índice único (`23505` de Postgres)?
 *
 * Vive aquí, junto al resto de lo que este módulo sabe sobre la FORMA de los errores de drizzle,
 * porque el motivo es el mismo: desde `drizzle-orm` 0.45 `PgSession` envuelve todo error del driver
 * en un `DrizzleQueryError`, así que el código de Postgres ya no está en la raíz sino en `cause`.
 * Mirar `e.code` a secas es código muerto — un `if` que nunca entra y una traducción que nunca
 * ocurre, con el 500 y la fuga del SQL que eso arrastra.
 *
 * Lo usan el mapeo de conceptos (HU #11282/#11283) y la configuración de emisión (HU #11284). Estaba
 * duplicado y se unificó aquí: si drizzle vuelve a cambiar la envoltura, hay un solo sitio que
 * corregir en vez de dos que se desincronizan.
 */
export function esViolacionDeUnico(e: unknown): boolean {
  let actual: unknown = e;
  for (let saltos = 0; actual !== null && actual !== undefined && saltos < 5; saltos += 1) {
    if ((actual as { code?: string }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
