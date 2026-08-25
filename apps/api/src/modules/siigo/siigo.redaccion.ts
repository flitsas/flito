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

import { maskDocument, maskEmail, maskName } from '../../shared/utils/pii.js';

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

// ── PII escrita por una PERSONA en texto libre ──────────────────────────────
//
// `sanearMensaje` corta volcados de SQL y recorta filtros con forma `clave=valor`. Eso cubre lo que
// escribe una MÁQUINA. **No cubre nada de lo que escribe una persona**: «lo pidió Juan Pérez, cédula
// 79123456» no lleva ninguna marca de SQL ni ningún `=`, así que salía intacto — y el sitio donde
// acaba es `siigo_operaciones.mensaje`, WORM por disparador desde la `0126`. Una vez escrito ahí, los
// derechos de rectificación y supresión (Ley 1581, art. 8 lit. d y e) ya no se pueden ejercer.
//
// **Por qué no basta con `maskPII`.** El catálogo canónico de `shared/utils/pii.ts` decide POR EL
// NOMBRE DE LA CLAVE (`{ cedula: '79123456' }` → `maskDocument`). Un texto libre no tiene claves:
// `maskPII({ nota })` devolvería la nota tal cual, porque «nota» no casa con ninguna rama. Lo que
// falta en texto libre es la DETECCIÓN, no el enmascarado. Así que aquí se detecta por FORMA y se
// enmascara con las MISMAS funciones canónicas (`maskDocument`, `maskEmail`, `maskName`): no hay un
// segundo criterio de enmascarado que pueda divergir del de todo el repositorio.
//
// ── DOS MECANISMOS, Y EL PRECISO ES EL PRINCIPAL ───────────────────────────────────────────────
//
// **1. Coincidencia con el dato conocido.** La nota se escribe sobre un caso concreto cuyo cliente
// está en la fila que quien opera tiene delante, así que copiarlo a la nota es el flujo esperado.
// Cotejar el texto contra ESE valor tapa exactamente lo que se copió, **en cualquier caja**, y sin
// tocar una sola palabra de texto operativo. No tiene falsos positivos en ninguna dirección: o el
// nombre está escrito, o no lo está. Es la defensa principal de este módulo.
//
// **2. Heurística por forma, solo Title Case.** Dos palabras capitalizadas seguidas se tratan como
// un nombre salvo que TODAS estén en la lista de términos conocidos. Cubre lo que se teclea de
// memoria —«lo pidió Ana Ramírez»— y su papel es de segundo orden.
//
// ── POR QUÉ LA HEURÍSTICA NO MIRA LAS MAYÚSCULAS ───────────────────────────────────────────────
//
// Hubo un tercer mecanismo que sí las miraba, y **se retiró a propósito** tras medirlo. La historia
// completa, porque el impulso de volver a añadirlo es fuerte y conviene que quien lo tenga sepa lo
// que ya se probó:
//
// La mayúscula es una forma normal de escribir aquí un nombre —el ejemplo canónico de
// `shared/utils/pii.ts` es literalmente `"ANALEANDRA HINCAPIE OSPINA"`—, así que tratarla como señal
// parecía obligado. El problema es que también es una forma normal de escribir una NOTA ENTERA: en
// operación se teclea en altas por costumbre. Medido sobre casos reales, la fracción de mayúsculas
// de lo que había que tapar (27 %, 55 %, 70 %) y la de lo que había que respetar (17 %, 26 %, 100 %)
// se solapan enteras, y `CLIENTE PIDIO ANULAR` es formalmente idéntico a `MARIA GOMEZ RESTREPO`.
// Cualquier umbral que separe los dos —fracción de altas, longitud mínima— parte notas legítimas por
// un lado y deja pasar nombres por el otro con solo añadir una palabra en minúsculas. Y el error
// caro no es simétrico: el destino es `siigo_operaciones`, que no admite UPDATE ni DELETE, así que
// una nota mutilada es la pérdida DEFINITIVA de la única explicación de por qué se dio un caso por
// perdido —justo lo que el AC5 existe para conservar—.
//
// Lo que queda cubierto sin ese mecanismo es lo que motivó el hallazgo: el nombre COPIADO DE LA
// FILA, que el mecanismo 1 tapa venga como venga escrito.
//
// **Lo que NO detecta, dicho antes de que alguien lo dé por cubierto:** un nombre de pila suelto
// («lo pidió juan»), un nombre entero en minúsculas, un apodo, una dirección escrita en prosa,
// cualquier identificador de menos de siete dígitos y —decisión explícita, no olvido— **un nombre
// escrito en MAYÚSCULAS que no sea el del cliente del caso**. Un detector de nombres sobre prosa
// española no existe; lo que existe es esta heurística. Por eso el catálogo cerrado de motivos sigue
// siendo la defensa principal del AC5 y esto es la segunda línea, no al revés.

const CORREO_EN_TEXTO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Placa colombiana: tres letras y tres caracteres (`ABC123` de particular, `ABC12D` de moto).
 * AGENTS.md §14 la nombra junto a la cédula y el NIT: identifica al titular por su vehículo.
 *
 * **Insensible a mayúsculas** (`i`): quien teclea una nota escribe «placa abc123» tan a menudo como
 * «ABC123», y sin la bandera el minúsculo salía entero. La forma es lo bastante específica —tres
 * letras pegadas a dos dígitos y un alfanumérico, todo en la misma palabra— para que la bandera no
 * arrastre texto operativo: «error 429» y «van 5 intentos» no tienen letras pegadas a los dígitos.
 */
const PLACA_EN_TEXTO = /\b[A-Z]{3}[ -]?\d{2}[A-Z0-9]\b/gi;

/**
 * Fin de palabra que NO admite el resto de un identificador.
 *
 * `\b` no sirve aquí: entre la `J` y el `2` de `FAJ26` no hay frontera de palabra, así que una tira
 * de mayúsculas sin este freno se comería el prefijo de un código y dejaría `R. F.26` donde el
 * operador necesita leer `Regla FAJ26`. Se exige que detrás no venga NINGÚN carácter de palabra:
 * ni letra, ni dígito, ni guion bajo (`INVALID_DIAN_RESOLUTION` queda fuera por la misma razón).
 */
const FIN_DE_PALABRA = '(?![\\wÁÉÍÓÚÜÑáéíóúüñ])';

/** El simétrico, para cuando lo que se busca puede caer en MITAD de otra palabra. */
const INICIO_DE_PALABRA = '(?<![\\wÁÉÍÓÚÜÑáéíóúüñ])';

/**
 * Palabra con forma de nombre propio: inicial alta y el resto en minúsculas.
 *
 * **Las tiras en mayúsculas quedan fuera a propósito** (`DIAN`, `CUFE`, `MARIA`). Hubo una versión
 * que las miraba y se retiró midiendo: el razonamiento está en la cabecera del bloque. Lo que tapa
 * un nombre en altas es el mecanismo de coincidencia, no esta regex.
 */
const PALABRA_NOMBRE = '[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+';

/**
 * Enlaces de un nombre compuesto: «Juan de la Cruz» es UN nombre, no dos palabras sueltas.
 *
 * Se admiten también en mayúsculas porque quien escribe «Juan De La Cruz» capitaliza los nexos tan a
 * menudo como no, y sin eso la cadena se rompe y el nombre sale entero.
 */
const NEXOS_DE_NOMBRE = ['de', 'del', 'la', 'las', 'los', 'y', 'da', 'di', 'van', 'von'];
const NEXO_DE_NOMBRE =
  `(?:${[...NEXOS_DE_NOMBRE, ...NEXOS_DE_NOMBRE.map((n) => n.toUpperCase())].join('|')})`;

/** Dos o más palabras de nombre seguidas, con sus nexos. Una sola palabra NUNCA casa. */
const NOMBRE_EN_TEXTO = new RegExp(
  `${PALABRA_NOMBRE}${FIN_DE_PALABRA}`
  + `(?:\\s+(?:${NEXO_DE_NOMBRE}\\s+)*${PALABRA_NOMBRE}${FIN_DE_PALABRA})+`, 'g',
);

/** Para no exigirle a un nexo que esté en el catálogo del dominio. Ver `enmascararNombres`. */
const NEXOS_EN_MINUSCULA = new Set(NEXOS_DE_NOMBRE);

/**
 * Términos del dominio que pueden ir capitalizados sin nombrar a nadie.
 *
 * **Es corta a propósito y su incompletitud es segura**: lo que no esté aquí se enmascara. Olvidar
 * un término cuesta un «Nota Crédito» ilegible de vez en cuando; el error contrario es un nombre en
 * una fila que nadie puede borrar.
 *
 * Que ese balance sea aceptable depende de que la heurística mire SOLO Title Case, y conviene
 * dejarlo escrito porque durante un tiempo no fue así: mientras miró también las mayúsculas, el
 * precio de un olvido pasó a ser prosa operativa entera mutilada —«NO APLICA REINTENTO» convertido
 * en iniciales— y esta lista tuvo que crecer con siglas y palabras funcionales para tapar el
 * agujero. Nada de eso hace falta ahora: `NOTA CREDITO` o `SOLO LECTURA` no casan con la regex, así
 * que no hay que enumerarlos. Si alguien vuelve a meter las altas, esta lista volverá a quedarse
 * corta el primer día — y esa es la señal de que el problema no estaba en la lista.
 */
const TERMINOS_NO_PERSONALES = new Set([
  'nota', 'notas', 'crédito', 'credito', 'débito', 'debito', 'factura', 'facturas', 'documento',
  'documentos', 'electrónico', 'electronica', 'electrónica', 'electronico', 'resolución',
  'resolucion', 'siigo', 'nube', 'flito', 'bandeja', 'trámite', 'tramite', 'trámites', 'tramites',
  'cliente', 'clientes', 'correo', 'correos', 'emisión', 'emision', 'envío', 'envio', 'error',
  'rechazo', 'regla', 'validación', 'validacion', 'contabilidad', 'operaciones', 'ambiente',
  'producción', 'produccion', 'pruebas', 'sistema', 'soporte', 'mesa', 'ayuda',
]);

/** Una tira de dígitos con sus separadores. `\b` no vale: los separadores son parte del número. */
const NUMERO_EN_TEXTO = /\d[\d.\-/\s]*\d/g;

/**
 * Fechas, que NO se enmascaran: el motivo `resolucion_dian_vencida` se explica con una, y taparlas
 * dejaría la nota sin lo único que la hace útil. Ninguna cédula ni NIT del país se escribe con esta
 * forma —dos grupos de uno o dos dígitos y un año—, así que el hueco no es una puerta de entrada.
 */
const FECHA_EN_TEXTO = /^(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/;

/**
 * A partir de cuántos dígitos seguidos una tira deja de ser una cantidad y pasa a ser un
 * identificador. Siete es el mínimo de una cédula colombiana; por debajo están los consecutivos, los
 * conteos y los códigos de error, que no identifican a nadie.
 */
const DIGITOS_DE_IDENTIFICADOR = 7;

function enmascararNumeros(texto: string): string {
  return texto.replace(NUMERO_EN_TEXTO, (bruto, desplazamiento: number) => {
    // Un importe lleva marca delante y una cédula no. Es la única excepción por contexto, y va
    // acotada al símbolo: «$1.250.000» se lee, «cédula $79123456» no lo escribe nadie.
    if (texto.slice(0, desplazamiento).trimEnd().endsWith('$')) return bruto;
    const compacto = bruto.replace(/\s+/g, '');
    if (FECHA_EN_TEXTO.test(compacto)) return bruto;
    const digitos = bruto.replace(/\D/g, '');
    return digitos.length >= DIGITOS_DE_IDENTIFICADOR ? maskDocument(digitos) : bruto;
  });
}

/**
 * Largo mínimo de un nombre conocido para cotejarlo.
 *
 * Cotejar tiras cortas sería peor que no cotejar: una razón social de tres letras convertiría en
 * máscara cualquier aparición de esas tres letras dentro de otra palabra.
 */
const LARGO_MINIMO_CONOCIDO = 4;

/** Lo que hay que neutralizar para meter un nombre dentro de una expresión regular. */
function escaparParaRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mecanismo 1 — tapa los nombres que YA conocemos del caso.
 *
 * Sin heurística ninguna: se busca el valor exacto, insensible a mayúsculas y tolerante con los
 * espacios (una razón social copiada de una tabla llega con espacios de más más veces de las que
 * parece). Es el único camino que tapa un nombre escrito en MAYÚSCULAS, que la heurística por forma
 * no mira —y no por descuido: ver la cabecera del bloque—.
 *
 * **Con límites de palabra a los dos lados**, y no es teórico: sin ellos un cliente que se llame
 * `SURA` convierte «quedó en CLAUSURA definitiva» en «quedó en CLAUS. definitiva». El largo mínimo
 * acota ese daño pero no lo elimina —hay razones sociales cortas de verdad—, así que la frontera se
 * exige explícitamente. Se usan las mismas clases que la heurística, porque `\b` no sirve con
 * acentos: la `é` no es carácter de palabra para JavaScript.
 *
 * Lo que NO cubre, dicho aquí: una versión ABREVIADA del nombre («Transportes La Sabana» sin el
 * «SAS», o solo el apellido). Para eso queda la heurística, con su margen de error.
 */
function enmascararConocidos(texto: string, nombres: readonly (string | null | undefined)[]): string {
  let salida = texto;
  for (const bruto of nombres) {
    const nombre = (bruto ?? '').trim().replace(/\s+/g, ' ');
    if (nombre.length < LARGO_MINIMO_CONOCIDO) continue;
    const cuerpo = escaparParaRegExp(nombre).replace(/ /g, '\\s+');
    const patron = new RegExp(`${INICIO_DE_PALABRA}${cuerpo}${FIN_DE_PALABRA}`, 'gi');
    salida = salida.replace(patron, (encontrado) => maskName(encontrado));
  }
  return salida;
}

function enmascararNombres(texto: string): string {
  return texto.replace(NOMBRE_EN_TEXTO, (bruto: string) => {
    const capitalizadas = bruto.split(/\s+/)
      .filter((p) => /^[A-ZÁÉÍÓÚÜÑ]/.test(p))
      // Los nexos se descuentan: son estructura del nombre, no identidad, y desde que se admiten en
      // mayúsculas entran en este filtro. Exigirles estar en el catálogo del dominio habría tapado
      // «NOTA CREDITO DE LA DIAN» por culpa del `DE` y del `LA`, que no nombran a nadie.
      .filter((p) => !NEXOS_EN_MINUSCULA.has(p.toLowerCase()));
    const todasDelDominio = capitalizadas
      .every((p) => TERMINOS_NO_PERSONALES.has(p.toLowerCase()));
    return todasDelDominio ? bruto : maskName(bruto);
  });
}

/**
 * Enmascara los datos personales que una persona escribió en un texto libre.
 *
 * Se aplica a lo que se ESCRIBE en la bitácora WORM (la nota de un descarte) y a lo que se ENTREGA
 * en un listado junto a la razón social (el detalle de un rechazo de la DIAN). En los dos casos el
 * dato que sobra es el mismo: una identificación al lado de un nombre.
 *
 * `nombresConocidos` son los del CASO sobre el que se escribe —hoy, la razón social del cliente que
 * quien opera tiene delante en su fila—. Es opcional porque no todos los llamadores tienen un caso
 * detrás, pero cuando se puede pasar hay que pasarlo: es el único mecanismo exacto de los dos.
 *
 * El orden no es casual:
 *   1. el correo, porque lleva dentro puntos y dígitos que las otras reglas trocearían;
 *   2. la placa;
 *   3. los nombres conocidos, antes de la heurística, para que esta no vuelva a partir un nombre
 *      que ya quedó en iniciales;
 *   4. la heurística por forma;
 *   5. los números al final, porque las máscaras que dejan las demás ya no contienen tiras largas
 *      de dígitos.
 */
export function redactarPIIEnTextoLibre(
  texto: string, nombresConocidos: readonly (string | null | undefined)[] = [],
): string {
  const sinCorreos = texto.replace(CORREO_EN_TEXTO, (c) => maskEmail(c));
  const sinPlacas = sinCorreos.replace(PLACA_EN_TEXTO, (p) => maskDocument(p));
  const sinConocidos = enmascararConocidos(sinPlacas, nombresConocidos);
  return enmascararNumeros(enmascararNombres(sinConocidos));
}
