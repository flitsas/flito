// Siigo — registro de acceso a datos personales del padrón de clientes (HU #11299).
//
// El informe de facturabilidad (HU #11296) devuelve NOMBRE e IDENTIFICACIÓN de clientes —la cédula
// cuando el cliente es persona natural, el NIT cuando es jurídica— y las listas de equivalencia de
// ciudad (HU #11294) devuelven el nombre de cada cliente pendiente. Ley 1581 art. 17 — el titular
// puede preguntar «¿quién consultó mis datos y para qué?», y hasta esta HU el módulo `siigo/` entero
// no escribía una sola línea en `pii_access_log`, mientras `drivers/`, `flito-comparendos/`,
// `flito-conciliacion/` y `pesv/` sí lo hacían (AGENTS.md §16).
//
// Es deuda preexistente —las rutas son de las HU #11294 y #11296— y se cierra AHORA porque el panel
// de Terceros las convierte en su fuente de datos: pasan de consulta puntual a barrido rutinario de
// hasta 500 fichas identificadas por llamada, y las de ciudad ni siquiera tenían tope hasta la
// segunda tanda de esta HU. El control de acceso ya estaba bien
// (`requireRole('admin','auditor','financiera')`); lo que faltaba era poder reconstruir QUIÉN leyó
// el padrón.
//
// El corte del alcance: este archivo cubre las rutas **del módulo `siigo/`** que el panel de esta
// HU usa — las tres del informe de facturabilidad, las dos listas de equivalencia de ciudad y el
// `POST /terceros/cliente/:id`, que no es una lectura sino una SALIDA de datos hacia Siigo
// (`accion: 'export'`).
//
// **No cubre todo lo que el panel alcanza**, y decirlo importa: la primera versión de este párrafo
// afirmaba cubrir «todo lo que el panel hace con identidades», que era falso y por tanto peor que
// no decir nada — un inventario que se declara completo es el que hace que nadie vuelva a mirar.
//
// Ya NO queda fuera `GET /clients` (`clients/clients.routes.ts`), que era la mayor de todas: la
// segunda tanda de esta HU le puso proyección explícita y rastro de acceso, y el contrato de ESTE
// archivo es el que reutiliza —`registrarAccesoCliente`— para que las seis rutas que leen fichas de
// cliente escriban el mismo `resource_tipo` y el mismo formato de motivo. Qué entrega y qué declara
// está en `clients/clients.pii.ts`, derivado de su proyección.
//
// Queda fuera, inventariado para la HU de seguimiento y descrito como es —un inventario que
// exagera o que se equivoca hace que la HU que lo recoja se dimensione sobre algo que no existe—:
//
//   · `POST /clients` y `PATCH /clients/:id` — son escrituras y `audit()` ya las anota, pero las
//     dos devuelven la fila COMPLETA (`.returning()` sin proyección), y el PATCH además lee una
//     fila completa antes de escribir. No entran aquí porque quien recibe esos datos acaba de
//     escribirlos y porque proyectar una respuesta de escritura es otro cambio, con otro riesgo.
//   · `GET /clientes-ciudades/:id/propuesta` — NO devuelve el nombre (proyecta solo `clients.city`),
//     pero sí devuelve esa ciudad en `textoOrigen`. Es de la ficha fiscal (HU #11298), no de este
//     panel.
//   · `GET /terceros/cliente/:clienteId` — `select()` sin proyección sobre `siigo_terceros`:
//     devuelve `identificacion`, la copia del documento. Cualquier columna que se añada mañana sale
//     sola. El panel usa el POST, no este GET.
//   · `siigo.archivo-documentos.service.ts` — lee `clients.document` para resolver la carpeta de
//     storage. Es un job sin `req`, así que es de otra naturaleza: `logPiiAccess` se apoya en una
//     petición.
//
// Y queda fuera por no tener nada que registrar, que es distinto de quedar pendiente:
//
//   · `GET /terceros/resumen` (HU #11299, AC3) — devuelve `{ totalClientes, conTercero }`: dos
//     enteros contados con `count(distinct …)` en la base. No proyecta ni una columna personal, no
//     devuelve identificadores de cliente y no recorre fichas —a diferencia del resumen de
//     facturabilidad, que sí las evalúa una a una y por eso SÍ registra con `CAMPOS_PII_RESUMEN`
//     vacío—. Registrar aquí escribiría una fila de «acceso a datos personales» por cada vez que
//     alguien abre el panel, sin que nadie haya mirado a nadie: exactamente el ruido que la nota de
//     `CAMPOS_PII_RESUMEN` explica que hace inservible la consulta «¿quién ha leído documentos?».
//
// Existe aparte del router por el mismo motivo que `flito-conciliacion.pii.ts` y
// `flito-comparendos.pii.ts`, que son sus precedentes exactos: son varios endpoints que devuelven lo
// mismo, y si cada uno arma su llamada a `logPiiAccess` por su cuenta, `resource_tipo` y
// `campos_accedidos` acaban escritos de tres maneras distintas y el log deja de ser consultable —
// que es lo único que un registro de acceso tiene que ser (ADR-0006 §7.5).
//
// ── Lo que NO hace ───────────────────────────────────────────────────────────────────────────────
//
// No sustituye a `audit()`: la bitácora responde «quién CAMBIÓ qué» —el recálculo de duplicados, la
// corrección de una ficha— y esto responde «quién MIRÓ datos personales».
//
// Y no cambia lo que las rutas devuelven. Añadir el rastro no altera ni una clave del DTO.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { maskPII } from '../../shared/utils/pii.js';

/**
 * `resource_tipo` de una lectura de fichas de cliente.
 *
 * El literal es el MISMO con el que `audit()` anota las escrituras sobre clientes
 * (`clients.routes.ts` y `ciudades-mapeo.routes.ts` usan `resource: 'client'`), y no por descuido de
 * nombres: quien tenga que responder por un cliente concreto necesita cruzar «quién lo modificó»
 * (bitácora) con «quién leyó su ficha» (registro de acceso), y dos literales distintos para el mismo
 * objeto obligarían a traducir entre las dos tablas para hacer esa consulta. Que las dos preguntas
 * sean distintas ya lo dice la columna `accion`; el recurso es el mismo. Es el criterio que
 * `flito-comparendos.pii.ts` deja escrito para `RECURSO_NIT`.
 */
export const RECURSO_CLIENTE = 'client';

/**
 * Columnas personales que devuelve un `VeredictoCliente`: el listado y la ficha puntual.
 *
 * Se nombran las columnas de `clients`, no las claves del DTO (`nombre`, `documento`): el log tiene
 * que poder cruzarse con la tabla real. `document` es cédula o NIT según el tipo de persona —una
 * cédula es un documento de identidad y un NIT de persona natural TAMBIÉN lo es—, y `name` es el
 * nombre de esa persona cuando el cliente no es una compañía.
 *
 * El resto del veredicto (`facturable`, `pendienteClasificacion`, `faltantes`) NO va aquí: nombra
 * campos y motivos de un catálogo estático, no valores de la ficha.
 */
export const CAMPOS_PII_VEREDICTO = ['name', 'document'] as const;

/**
 * Lo personal que entrega `GET /clientes-ciudades/propuestas`: el nombre del cliente y su ciudad.
 *
 * La lista era la única que iba COMPLETA, sin paginar y sin tope; desde la segunda tanda de esta HU
 * está acotada a 500 como el informe de facturabilidad. En volumen sigue siendo la lectura de
 * identidades más grande del módulo, y por eso `filas` cuenta lo que se entregó de verdad.
 *
 * `city` está aquí desde la re-auditoría de la HU #11299 y su ausencia era un error, no una
 * omisión discutible: la respuesta trae `ciudadTexto` —que ES `clients.city`— y además lo repite
 * dentro de `propuesta.textoOrigen`. Por el mismo criterio que fija el resto de este archivo —lo
 * que decide es si la RESPUESTA entrega datos personales—, la ubicación del titular lo es;
 * AGENTS.md §14 nombra la dirección en esa lista. La identificación, en cambio, NO sale por aquí, y
 * por eso `document` no está: declararlo señalaría a quien solo vio nombres y ciudades.
 *
 * Que un nombre sea dato personal no depende de si el cliente es una empresa: `clients` mezcla
 * personas naturales y jurídicas en la misma tabla —es justo lo que el validador tiene que
 * clasificar—, así que la lista lleva nombres de persona sí o sí.
 */
export const CAMPOS_PII_PROPUESTA_CIUDAD = ['name', 'city'] as const;

/**
 * Lo que entrega `GET /clientes-ciudades/obsoletas`: lo anterior MÁS el texto de origen confirmado.
 *
 * Devuelve `ciudadActual` (`clients.city`) y `textoConfirmado` (`clients.city_texto_origen`), que
 * son dos ubicaciones del mismo titular en dos momentos distintos — precisamente lo que hace útil
 * la lista. Se declaran las dos columnas y no una: el log tiene que poder decir qué se leyó.
 */
export const CAMPOS_PII_EQUIVALENCIA_OBSOLETA = ['name', 'city', 'city_texto_origen'] as const;

/**
 * Lo que SALE HACIA SIIGO al asegurar un tercero, que es un tercero externo (`accion: 'export'`).
 *
 * `POST /siigo/terceros/cliente/:clienteId` no es una lectura interna: `armarTercero` compone el
 * cuerpo del `POST`/`PUT` a `/v1/customers` con la ficha del cliente, y ahí van nombre, nombre
 * comercial, identificación, dirección, ubicación, teléfono y los datos del contacto. Que el dato
 * cruce la frontera del sistema es exactamente la distinción que la columna `accion` existe para
 * poder reconstruir, y `audit()` no la cubre: la bitácora anota la operación de negocio («tercero
 * creado»), no qué datos personales salieron.
 *
 * Se nombran las columnas de `clients`, no las claves del JSON de Siigo (`identification`,
 * `commercial_name`), por lo mismo de siempre: el log tiene que cruzarse con la tabla real.
 */
export const CAMPOS_PII_TERCERO_EXPORTADO = [
  'name', 'commercial_name', 'document', 'address',
  'country_code', 'state_code', 'city_code',
  'phone_indicative', 'phone_number',
  'contact_first_name', 'contact_last_name', 'contact_email',
] as const;

/**
 * Solo la identificación, para cuando eso es lo ÚNICO que sale.
 *
 * Es el caso de `desenlace: 'sin_cambios'` —la rama más frecuente de asegurar un tercero: la huella
 * coincide, no se hace ni una petición a Siigo— y el de `'vinculado_existente'`, donde lo que viajó
 * fuera fue la identificación dentro del `GET /v1/customers?identification=…`. En los dos, el
 * cuerpo devuelve `identificacion` en claro a quien preguntó. Declarar aquí los doce campos del
 * export completo diría que salió una ficha entera que no salió.
 */
export const CAMPOS_PII_IDENTIFICACION = ['document'] as const;

/**
 * Lo que entrega el resumen de facturabilidad: **nada personal**, y por eso la lista va vacía.
 *
 * No es un olvido ni una lista pendiente de llenar. El resumen recorre el padrón para contar, pero
 * lo que devuelve son conteos por motivo: ni un nombre, ni una identificación, ni un identificador
 * de cliente. Declarar `name` y `document` aquí haría que el log afirmara que alguien leyó
 * identidades que nunca salieron de la base, y un registro de acceso que exagera es tan inservible
 * como uno que falta: la consulta «¿quién ha leído documentos?» devolvería a todo el que abrió el
 * panel. Es el mismo criterio con el que `flito-conciliacion.pii.ts` deja fuera la columna «Nombre»
 * del Excel y con el que `flito-comparendos.routes.ts` distingue las dos escrituras de `/nits`: lo
 * que decide no es la ruta ni el verbo, sino si la RESPUESTA entrega datos personales.
 *
 * Se registra igual, con la lista vacía, porque el barrido del padrón sí ocurrió y `motivo` deja
 * constancia de cuántas fichas se evaluaron. `pii_access_log.campos_accedidos` tiene
 * `DEFAULT ARRAY[]::text[]` (mig. 0059): el vacío es un valor previsto, no un hueco.
 */
export const CAMPOS_PII_RESUMEN: readonly string[] = [];

export interface AccesoCliente {
  /**
   * `search` = barrido o listado; `read` = la ficha de un cliente concreto; `export` = los datos
   * SALEN del sistema hacia Siigo, que es un tercero externo.
   */
  accion: 'read' | 'search' | 'export';
  /** Columnas personales que la RESPUESTA devuelve. Usar las constantes de este archivo. */
  campos: readonly string[];
  /**
   * `clients.id` cuando la lectura es de un cliente concreto.
   *
   * Aquí sí cabe —a diferencia de comparendos y conciliación, cuyos identificadores son uuid—:
   * `pii_access_log.resource_id` es `integer` y `clients.id` también. Un listado va con `null`: no
   * apunta a una ficha sino a un tramo del padrón.
   */
  clienteId?: number | null;
  /** Cuántas fichas se entregaron. Un listado de 500 no es la misma lectura que uno de 1. */
  filas?: number;
  /** Cuántas fichas se recorrieron para un agregado, cuando no se entregó ninguna. */
  evaluados?: number;
  /** Filtros aplicados. Se enmascaran aquí: el llamador pasa los valores tal cual los recibió. */
  filtros?: Record<string, unknown>;
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/** Lo que cabe de un filtro en el motivo, ya enmascarado. `motivo` es `varchar(200)` en total. */
const VALOR_MAX = 40;

/** Lo que cabe de la CLAVE de un filtro. Una clave más larga que esto no nombra un criterio. */
const CLAVE_MAX = 40;

/**
 * ── El formato de `motivo`, que es una decisión de bitácora y no un detalle ─────────────────────
 *
 * `motivo` se lee como una lista de parejas `clave=valor` separadas por espacios:
 *
 *     Lectura de fichas de cliente — filas=500 cliente=41 pais="Co" documento="79***612"
 *
 * y de ahí sale la regla: **el espacio separa parejas, así que nada que venga de la petición puede
 * producir uno que se lea como separador**. Cerrar `\n`, `\r`, los caracteres de control y
 * `U+2028/29` subió el listón contra el visor que pinta renglones, pero dejaba abierto el mismo
 * ataque contra quien parsea parejas: un espacio corriente dentro de un valor —o un `=` dentro de
 * una clave— fabrica una pareja entera. `estado=activo filas=0` no necesita ni un carácter raro
 * para mentir, y el rastro forjado se lee igual de bien que el legítimo.
 *
 * Se cierra DELIMITANDO en vez de recortando, que es lo que además conserva el dato:
 *
 *   · **El valor va entrecomillado**, con sus `"` y sus `\` escapados. Lo de dentro puede llevar
 *     espacios —de hecho los lleva: `maskName` produce «P. A. G.» y `maskAddress` «*** (13 car.)»,
 *     así que colapsarlos habría mutilado nuestro propio enmascarado— y aun así no puede cerrar la
 *     comilla ni empezar una pareja nueva.
 *   · **La clave se reduce a un identificador** (`[A-Za-z0-9_.-]`): sin espacios, sin `=`, sin
 *     comillas. Una clave no es texto libre; es el nombre de un criterio.
 *   · **Los contadores que pone el código —`filas`, `cliente`, `evaluados`— van SIN comillas**, y
 *     eso no es inconsistencia de estilo: es lo que los distingue de un filtro que se llamara
 *     igual. El día que alguien registre `req.query`, un `?filas=999` sale como `filas="999"` y
 *     nunca como `filas=999`, así que el conteo real del servidor sigue siendo reconocible por su
 *     forma y no solo por su posicion.
 *
 * Los caracteres de control se siguen colapsando a un espacio: dentro de las comillas ya no forjan
 * ninguna pareja, pero un `\n` en `motivo` seguiría partiendo el renglón de cualquier visor.
 */

/**
 * Aplana un texto a una sola línea, colapsando todo lo que un visor pinte como salto.
 *
 * `U+2028` y `U+2029` —separador de línea y de párrafo de Unicode— entran aunque NO sean caracteres
 * de control: quedan fuera de los dos rangos y aun así muchísimos visores de logs los pintan como
 * un salto de línea de verdad.
 */
function aplanar(texto: string): string {
  // eslint-disable-next-line no-control-regex -- son EXACTAMENTE lo que hay que quitar, no un descuido.
  return texto.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
}

/**
 * El valor de una pareja, ya delimitado: `"…"` con las comillas y las barras de dentro escapadas.
 *
 * El orden importa y por eso se deja escrito: se RECORTA antes de escapar. Al revés, el recorte
 * podría partir una secuencia de escape por la mitad y dejar la comilla de cierre fuera de sitio,
 * que es exactamente el hueco que este formato viene a cerrar.
 */
function valorDelimitado(valor: string): string {
  const plano = aplanar(valor).trim().slice(0, VALOR_MAX);
  return `"${plano.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * La clave de una pareja, reducida a identificador.
 *
 * Cada tramo de lo que no sea `[A-Za-z0-9_.-]` se sustituye por un `_`, así que no queda nada capaz
 * de separar parejas ni de abrir una nueva. Nunca se enmascara: saber que alguien buscó «por
 * documento» es justamente lo que hace útil el registro.
 */
function claveIdentificador(clave: string): string {
  const limpia = clave.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, CLAVE_MAX);
  return limpia === '' ? '_' : limpia;
}

/**
 * Resume los filtros para el motivo, enmascarando los valores personales.
 *
 * **Delega en `maskPII`** (`shared/utils/pii.ts`) en vez de llevar su propia lista de claves
 * sensibles, y esto es una corrección, no una preferencia de estilo. La versión anterior tenía un
 * regex local —más corto que el canónico: no cubría correo, teléfono ni apellido— y, peor, solo
 * enmascaraba la rama `typeof valor === 'string'`: un `?documento=` declarado con
 * `z.coerce.number()` —el patrón que `informeSchema` ya usa dos líneas más arriba para `limit` y
 * `offset`— llegaba aquí como `number`, se saltaba el enmascarado entero y escribía la cédula
 * literal dentro de la tabla que existe para protegerla. No era el caso rebuscado: era el más
 * probable.
 *
 * De ahí el `String(valor)` ANTES de enmascarar: `maskPII` solo toca `string` a propósito —un
 * booleano no identifica a nadie—, así que normalizar es lo que cierra la rama de tipo. Y delegar
 * es lo que hace que la lista no vuelva a quedarse corta: cuando alguien añada una clave al
 * catálogo canónico, este módulo la hereda sin acordarse de este archivo.
 *
 * Se conserva la CLAVE siempre: saber que alguien buscó «por documento» es justamente lo que hace
 * útil el registro. Los objetos y arrays no se vuelcan.
 *
 * La clave se sanea igual que el valor, y no es simetría decorativa: hasta la re-auditoría solo el
 * VALOR se saneaba, así que la mitad de cada pareja que se escribe en `motivo` llegaba cruda desde
 * el llamador. Las llamadas de hoy pasan claves literales escritas en el código, pero lo que este
 * archivo protege es el CAMINO, no los llamadores de hoy: el atajo evidente el día que alguien
 * quiera registrar los filtros de verdad es `filtros: req.query`, y ahí las claves las elige quien
 * hace la petición. Con la mitad sin sanear, la defensa anti-forja se esquivaba por el lado que
 * nadie había mirado.
 *
 * Cada una se sanea según lo que ES: la clave a identificador, el valor entre comillas. El porqué
 * —y por qué colapsar el separador no bastaba— está arriba, con el formato de `motivo`.
 */
function resumirFiltros(filtros: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const [claveCruda, valor] of Object.entries(filtros)) {
    if (valor === undefined || valor === null || valor === '') continue;
    // La clave NO se enmascara —nombrar el criterio es lo que hace útil el registro— pero se reduce
    // a identificador: en `motivo` no puede entrar por el lado de la clave nada que parezca un
    // renglón nuevo ni una pareja nueva.
    const clave = claveIdentificador(claveCruda);
    if (typeof valor === 'object') {
      // Constancia de que el filtro se usó, sin volcar su contenido: no cabría en 200 caracteres y
      // enmascararlo campo a campo aquí sería reimplementar `maskPII` para un caso que no existe.
      // Va entrecomillado como cualquier otro valor: el formato de las parejas es uno solo.
      partes.push(`${clave}="[…]"`);
      continue;
    }
    // Se enmascara con la clave CRUDA: `maskPII` decide por el nombre del campo, y sanearlo antes
    // podría cambiar qué rama del catálogo casa. El saneado es para lo que se ESCRIBE.
    const enmascarado = maskPII({ [claveCruda]: String(valor) })[claveCruda];
    partes.push(`${clave}=${valorDelimitado(String(enmascarado))}`);
  }
  return partes.join(' ');
}

/**
 * Deja el registro de acceso a fichas de cliente en `pii_access_log` (Ley 1581 art. 17).
 *
 * Es `await` y no fuego-y-olvido a propósito: `logPiiAccess` ya es best-effort —atrapa su propio
 * error y nunca tumba la operación principal—, así que esperar cuesta una inserción y garantiza que
 * el rastro está escrito ANTES de que la respuesta salga. Un registro de acceso que se pierde porque
 * el proceso murió entre la respuesta y el INSERT no es un registro de acceso.
 *
 * Lo que se escribe son NOMBRES DE CAMPO y el identificador del cliente. Nunca los valores leídos:
 * un log de accesos que copiara las cédulas que se consultaron sería una segunda base de datos de
 * identidades, y encima append-only.
 */
export async function registrarAccesoCliente(req: Request, acceso: AccesoCliente): Promise<void> {
  const detalles = [
    acceso.filas === undefined ? null : `filas=${acceso.filas}`,
    acceso.evaluados === undefined ? null : `evaluados=${acceso.evaluados}`,
    acceso.clienteId === undefined || acceso.clienteId === null ? null : `cliente=${acceso.clienteId}`,
    acceso.filtros ? resumirFiltros(acceso.filtros) : null,
  ].filter((p): p is string => p !== null && p !== '');

  const motivo = `Lectura de fichas de cliente${detalles.length > 0 ? ` — ${detalles.join(' ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: RECURSO_CLIENTE,
    resourceId: acceso.clienteId ?? null,
    accion: acceso.accion,
    camposAccedidos: [...acceso.campos],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}
