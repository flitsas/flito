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
// **Lo que NO detecta, dicho antes de que alguien lo dé por cubierto:** un nombre de pila suelto
// («lo pidió juan»), un nombre entero en minúsculas, un apodo, una dirección escrita en prosa, y
// cualquier identificador de menos de siete dígitos. Un detector de nombres sobre prosa española no
// existe; lo que existe es esta heurística. Por eso el catálogo cerrado de motivos sigue siendo la
// defensa principal y esto es la segunda línea, no al revés.
//
// **Un nombre EN MAYÚSCULAS sí se detecta, y hubo que corregirlo para que fuera cierto** (hallazgo
// del gate de seguridad de la #11340). Hasta entonces `PALABRA_NOMBRE` exigía minúsculas detrás de
// la inicial, de forma que «MARIA GOMEZ» salía intacta mientras «Maria Gomez» se enmascaraba. No era
// un borde: la mayúscula es la forma NORMAL en la que este sistema guarda y pinta los nombres —el
// ejemplo canónico de `shared/utils/pii.ts` es literalmente `"ANALEANDRA HINCAPIE OSPINA"`—, y el
// operador tiene la razón social del cliente delante en la fila mientras teclea la nota, así que
// copiarla es el flujo esperado y no el raro. La lista de huecos de arriba afirmaba lo contrario y
// era falsa.
//
// ── DOS MECANISMOS, Y EL ORDEN IMPORTA ─────────────────────────────────────────────────────────
//
// **1. Coincidencia con el dato conocido (preciso).** La nota se escribe sobre un caso concreto cuyo
// cliente ya está en la fila que quien opera tiene delante. Cotejar el texto contra ESE valor tapa
// exactamente el nombre que se copió de la pantalla, en cualquier caja y sin tocar una sola palabra
// de texto operativo. No tiene falsos positivos en ninguna dirección: o el nombre está escrito, o no.
//
// **2. Heurística por forma (aproximada).** Para lo que una persona teclea de memoria —el contacto
// de contabilidad, el conductor— no hay dato con el que cotejar, así que se detecta por forma. Es
// aproximada por definición y su papel es de SEGUNDO orden: cubre lo que el primero no puede saber.
//
// **Cuando duda, tapa — pero no cuando la duda es sistemática.** La heurística está inclinada a
// enmascarar de más: dos palabras capitalizadas seguidas se tratan como un nombre salvo que TODAS
// estén en la lista de términos conocidos. Esa inclinación tiene un límite descubierto midiendo, no
// razonando: **una nota escrita ENTERA en mayúsculas es un estilo de escritura, no una pista**.
// Escribir así es un hábito extendido en operación, y tratar la mayúscula como señal de nombre
// propio ahí convertía «SE REINTENTO TRES VECES Y SIGUE FALLANDO» en «SE R. T. V. Y. S. F.». Una
// nota mutilada tampoco se puede reescribir: el AC5 pide el motivo, y la explicación libre es lo
// único que dice POR QUÉ se dio por perdido un caso. Por eso, en un texto que ya viene todo en
// altas, la alternativa en mayúsculas se apaga y queda la de Title Case.
//
// Ese apagado sería una fuga si la heurística fuera lo único que hay —una nota en altas que nombre
// al cliente—; no lo es, porque el mecanismo 1 no depende de la caja. **La precisión del primero es
// lo que compra el derecho a relajar el segundo.**

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

/**
 * Palabra con forma de nombre propio: `Maria` **o** `MARIA`.
 *
 * La segunda alternativa invierte la suposición que tenía este módulo. Antes decía que lo que va
 * todo en mayúsculas es una sigla (`DIAN`, `CUFE`, `NIT`) y por eso no lo miraba; pero la mayúscula
 * es también —y sobre todo— cómo se escriben aquí los nombres y las razones sociales. Quedarse con
 * la suposición vieja hacía falsa la regla que este módulo declara: no tapaba cuando dudaba, es que
 * ni siquiera dudaba.
 *
 * Lo que impide que las siglas se enmascaren no es esta regex, son las DOS condiciones de
 * `enmascararNombres`: hacen falta al menos DOS palabras seguidas —una sigla suelta como `DIAN`
 * nunca casa— y basta con que una de ellas sea desconocida para tapar el grupo entero. `{3,}` deja
 * fuera además los pares de letras (`SA`, `CC`, `EU`), que no forman apellidos.
 */
const PALABRA_TITULADA = '[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+';
const PALABRA_EN_ALTAS = '[A-ZÁÉÍÓÚÜÑ]{3,}';

/**
 * Enlaces de un nombre compuesto: «Juan de la Cruz» es UN nombre, no dos palabras sueltas.
 *
 * **También en mayúsculas**, y no es simetría cosmética: `JUAN DE LA CRUZ` es la forma en que este
 * sistema guarda ese nombre. Sin las variantes altas, `DE` y `LA` no son ni nexo ni palabra de
 * nombre —tienen dos letras—, así que rompían la cadena y el nombre entero salía intacto. Se veía
 * como una incoherencia absurda: `MARIA DEL PILAR RESTREPO` sí se tapaba (porque `DEL` tiene tres
 * letras y colaba como palabra de nombre) y `JUAN DE LA CRUZ` no.
 */
const NEXOS_DE_NOMBRE = ['de', 'del', 'la', 'las', 'los', 'y', 'da', 'di', 'van', 'von'];
const NEXO_DE_NOMBRE =
  `(?:${[...NEXOS_DE_NOMBRE, ...NEXOS_DE_NOMBRE.map((n) => n.toUpperCase())].join('|')})`;
/** Dos o más palabras de nombre seguidas, con sus nexos. Una sola palabra NUNCA casa. */
function nombresHechosDe(palabra: string): RegExp {
  const p = `${palabra}${FIN_DE_PALABRA}`;
  return new RegExp(`${p}(?:\\s+(?:${NEXO_DE_NOMBRE}\\s+)*${p})+`, 'g');
}

/** Texto normal: `Maria Gomez` y `MARIA GOMEZ` cuentan las dos. */
const NOMBRE_EN_TEXTO = nombresHechosDe(`(?:${PALABRA_TITULADA}|${PALABRA_EN_ALTAS})`);
/** Texto ya escrito entero en altas: ahí la mayúscula no distingue nada y solo queda Title Case. */
const NOMBRE_TITULADO_EN_TEXTO = nombresHechosDe(PALABRA_TITULADA);

/**
 * ¿El texto está escrito ENTERO en mayúsculas?
 *
 * Los dos umbrales salen de medir los casos reales, no de elegir un número redondo. La prosa
 * operativa que hay que respetar viene al 100 % de altas; las notas con un nombre dentro que hay que
 * tapar medían 27 %, 55 % y 70 %. El corte va en 85 % porque el hueco entre 70 y 100 es donde no hay
 * ningún caso, y no porque 85 signifique nada.
 *
 * El suelo de letras es la otra mitad, y protege el caso corto: una nota que dice solo
 * «JOSE PEREZ» también es 100 % de altas, pero con diez letras no hay estilo de escritura que
 * deducir —hay un nombre—. Por debajo del suelo la heurística sigue mirando las mayúsculas.
 */
const LETRAS_PARA_HABLAR_DE_ESTILO = 20;
const FRACCION_DE_ALTAS_PARA_ESTILO = 0.85;

function escritoEnteroEnAltas(texto: string): boolean {
  const letras = texto.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) ?? [];
  if (letras.length < LETRAS_PARA_HABLAR_DE_ESTILO) return false;
  const altas = letras.filter((l) => /[A-ZÁÉÍÓÚÜÑ]/.test(l)).length;
  return altas / letras.length >= FRACCION_DE_ALTAS_PARA_ESTILO;
}

/** Para no exigirle a un nexo que esté en el catálogo del dominio. Ver `enmascararNombres`. */
const NEXOS_EN_MINUSCULA = new Set(NEXOS_DE_NOMBRE);

/**
 * Términos del dominio que pueden ir capitalizados sin nombrar a nadie.
 *
 * **Su incompletitud NO es gratis, y decir lo contrario era la premisa que había que corregir.** El
 * comentario anterior afirmaba que olvidar un término «solo cuesta legibilidad», y eso era cierto
 * mientras la heurística solo miraba Title Case: lo que se perdía era un «Nota Crédito» ilegible de
 * vez en cuando. Al admitir mayúsculas, lo que se perdía pasó a ser prosa operativa entera, y en un
 * destino que no admite UPDATE ni DELETE: una nota mutilada no es un inconveniente de lectura, es la
 * pérdida definitiva de la única explicación de por qué alguien dio un caso por perdido.
 *
 * Por eso la lista tiene ahora dos naturalezas, y conviene no confundirlas:
 *
 *   · **Cerrada y segura** — las palabras funcionales del español (artículos, preposiciones,
 *     conjunciones, negaciones). Son un conjunto finito y ninguna es un apellido, así que añadirlas
 *     no puede ocultar a nadie: un grupo formado SOLO por palabras funcionales no es un nombre.
 *   · **Abierta e incompleta por naturaleza** — los términos del dominio. El espacio de prosa
 *     operativa en mayúsculas no se puede enumerar, así que esta mitad NO es la defensa: lo que
 *     impide que la prosa en altas se enmascare es la regla de estilo de `escritoEnteroEnAltas`, y
 *     esta lista solo recorta el error en el tramo mixto.
 *
 * Ampliarla sigue siendo una decisión consciente de dejar pasar una pareja de palabras.
 *
 * El segundo bloque son las siglas y las formas societarias que hasta la corrección de las
 * mayúsculas no hacían falta —quedaban fuera por la propia regex— y ahora sí: son justo las que
 * aparecen pegadas a otra palabra en mayúsculas («NOTA CREDITO», «SIIGO NUBE», «NIT SAS»). La
 * comparación se hace en minúsculas, así que una sola entrada cubre `SAS` y `Sas`. Las de dos
 * letras (`cc`, `sa`, `eu`) solo sirven para la forma capitalizada: en mayúsculas no las mira nadie,
 * porque `PALABRA_NOMBRE` exige tres.
 */
const TERMINOS_NO_PERSONALES = new Set([
  'nota', 'notas', 'crédito', 'credito', 'débito', 'debito', 'factura', 'facturas', 'documento',
  'documentos', 'electrónico', 'electronica', 'electrónica', 'electronico', 'resolución',
  'resolucion', 'siigo', 'nube', 'flito', 'bandeja', 'trámite', 'tramite', 'trámites', 'tramites',
  'cliente', 'clientes', 'correo', 'correos', 'emisión', 'emision', 'envío', 'envio', 'error',
  'rechazo', 'regla', 'validación', 'validacion', 'contabilidad', 'operaciones', 'ambiente',
  'producción', 'produccion', 'pruebas', 'sistema', 'soporte', 'mesa', 'ayuda',
  // Siglas y formas societarias.
  'dian', 'cufe', 'nit', 'rut', 'cc', 'iva', 'sas', 'ltda', 'sa', 'eu', 'pdf', 'xml', 'api', 'url',
  // Estados y modos que el propio catálogo de errores nombra en mayúsculas dentro de una frase.
  'solo', 'lectura', 'modo', 'cuenta', 'nube', 'token', 'plan',
  // Palabras funcionales: el bloque CERRADO. Ninguna es un apellido.
  'el', 'la', 'lo', 'los', 'las', 'un', 'una', 'unos', 'unas', 'este', 'esta', 'estos', 'estas',
  'ese', 'esa', 'no', 'ni', 'ya', 'se', 'su', 'sus', 'al', 'del', 'de', 'y', 'o', 'u', 'por', 'para',
  'con', 'sin', 'que', 'qué', 'pero', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde', 'hay',
  'es', 'son', 'está', 'esta', 'están', 'fue', 'hasta', 'desde', 'sobre', 'entre', 'muy', 'más',
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
 * parece). Es el único camino que tapa un nombre escrito dentro de una nota redactada entera en
 * mayúsculas, donde la heurística por forma se apaga a propósito.
 *
 * Lo que NO cubre, dicho aquí: una versión ABREVIADA del nombre («Transportes La Sabana» sin el
 * «SAS», o solo el apellido). Para eso queda la heurística, con su margen de error.
 */
function enmascararConocidos(texto: string, nombres: readonly (string | null | undefined)[]): string {
  let salida = texto;
  for (const bruto of nombres) {
    const nombre = (bruto ?? '').trim().replace(/\s+/g, ' ');
    if (nombre.length < LARGO_MINIMO_CONOCIDO) continue;
    const patron = new RegExp(escaparParaRegExp(nombre).replace(/ /g, '\\s+'), 'gi');
    salida = salida.replace(patron, (encontrado) => maskName(encontrado));
  }
  return salida;
}

function enmascararNombres(texto: string): string {
  // La regla de estilo se decide sobre el texto que llega AQUÍ, es decir, después de tapar los
  // nombres conocidos: una razón social ya convertida en iniciales deja de inflar la cuenta de
  // mayúsculas, y la nota vuelve a parecer lo que es.
  const patron = escritoEnteroEnAltas(texto) ? NOMBRE_TITULADO_EN_TEXTO : NOMBRE_EN_TEXTO;
  return texto.replace(patron, (bruto: string) => {
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
 * El orden no es casual y ahora tiene una razón más:
 *   1. el correo, porque lleva dentro puntos y dígitos que las otras reglas trocearían;
 *   2. la placa;
 *   3. **los nombres conocidos, ANTES de la heurística**, para que la regla de estilo de
 *      `enmascararNombres` decida sobre un texto del que ya se quitó la razón social;
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
