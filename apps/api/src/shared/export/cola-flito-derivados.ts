// FLITO — lo que el Excel de las colas DERIVA, y las NUEVE claves que lee de `flit_raw`
// (Feature #11908, HU #11934, HU #11947).
//
// Vive aparte de `cola-flito-excel.ts` —que dice QUÉ columnas hay— porque esto dice CÓMO se calcula
// el valor de seis de ellas, y ese cálculo tiene que ser comprobable SIN levantar un export entero.
// El motivo es concreto y está medido: el mock de base de datos de las suites de export
// (`__tests__/helpers/keyed-db.ts`) devuelve las filas que el escenario registró y **no evalúa la
// proyección**, así que una expresión `->>` no se ejecuta nunca ahí y una regla escrita dentro del
// `filas.map(...)` de un servicio solo se puede probar a través de un `.xlsx`. Todo lo de este
// archivo es puro y exportado a propósito: se prueba llamándolo, con los valores medidos que llegan
// de verdad (`" "`, `"  "`, la clave ausente, la fila sin `flit_raw`).
//
// ── Por qué se lee de `flit_raw` y no de columnas propias (decisión de arquitectura, slim) ────────
//
// Seis de las columnas nuevas no existen en el modelo de FLITO: viven solo dentro del payload que el
// sync guarda tal cual en `flito_tramites.flit_raw` (`jsonb`). Extraerlas con `->>` en la proyección
// —en vez de hacer crecer el sync y el esquema— tiene una consecuencia que decidió el caso:
// **`Clase`, que hoy NO llega en el reporte de FLIT, se llenará sola el día que FLIT la mande**, sin
// migración y sin despliegue. Una columna `vehicles.clase` alimentada por el sync exigiría las dos
// cosas y, mientras tanto, mentiría con un `NULL` que parece un dato ausente y no un campo que aún
// no existe en origen.
//
// Lo que NO se hace, y es igual de deliberado: **proyectar `flit_raw` entera y extraer en JS**. El
// payload trae 27 claves por trámite; con el tope del export en 2 000 filas eso son 54 000 valores
// en el heap del proceso para escribir seis celdas, y rompe la lista blanca de RN-E1 — lo que no
// sale de la base no se puede publicar por descuido más arriba. Una expresión por clave.

import { sql, type Column } from 'drizzle-orm';
import { getOrganismoByCodigo } from '@operaciones/shared-types';
import { celdaTexto } from './cola-flito-excel.js';

// ── Las nueve claves del payload de FLIT ─────────────────────────────────────────────────────────

/**
 * Qué clave de `flit_raw` alimenta cada campo, con los DOS nombres cruzados escritos aquí una sola
 * vez.
 *
 * **`linea` sale de la clave `modelo` y `modelo` sale de `modeloAno`, no al revés.** No es un
 * despiste al teclear: lo que FLIT llama `modelo` es la LÍNEA comercial del vehículo (`ONIX`,
 * `STONIC`, `Y`), y todo el resto del repo usa «modelo = año» (`certificacion.service.ts`,
 * `DatosRuntCanal.modelo`), así que el mapeo obvio `Modelo ← modelo` es el defecto que sale gratis:
 * mete líneas comerciales en una columna de años, el archivo se abre sin quejarse y **pasa cualquier
 * aserto de cabeceras**. Medido sobre 7 052 filas locales: de los 394 valores distintos de `modelo`,
 * cinco parecen un año y 2 690 son la cadena literal `"Y"`.
 *
 * Está en una constante y no repartido por dos servicios para que los dos archivos no puedan
 * divergir: el `.xlsx` de SOAT y el de Impuestos son EL MISMO documento.
 */
export const CLAVES_FLIT_RAW = {
  marca: 'marca',
  /** La LÍNEA comercial. FLIT la llama `modelo`. */
  linea: 'modelo',
  /** El AÑO-modelo. FLIT lo llama `modeloAno`. */
  modelo: 'modeloAno',
  /** Aún NO llega en el reporte. La expresión ya está: el día que llegue, la columna se llena sola. */
  clase: 'clase',
  capacidad: 'capacidad',
  /**
   * El departamento del ORGANISMO DE TRÁNSITO **para las filas de trámite**, no el del domicilio del
   * titular.
   *
   * **Decisión de David, cerrada en el gate de seguridad de la HU #11934, y escrita aquí porque se
   * ejecuta sola:** la clave es `departamentoTransito` y acompaña a `OrganismoDetto` y a
   * `OrganismoDettoCiudad`; **no** se relaciona con `Direccion`.
   *
   * ── Lo que cambió con la HU #11966, y por qué esta clave NO ─────────────────────────────────────
   *
   * Aquel párrafo seguía con «que `Departamento` **NO se declara en `CAMPOS_PII_COLA_EXPORT`**», y
   * dejaba escrito su propio disparador: «si algún día se cambiara por un departamento de la
   * dirección, tendría que entrar aquí en la misma edición». Eso ocurrió: la columna `Departamento`
   * del archivo **se bifurca por `origen`** desde la #11966 y, para una fila `origen='cliente'`,
   * publica `flito_compradores.departamento` — el DOMICILIO del titular. `Departamento` y `Municipio`
   * están declarados ya en `CAMPOS_PII_COLA_EXPORT`.
   *
   * Esta clave, en cambio, sigue significando lo mismo y sigue siendo solo de la mitad de trámite: no
   * se toca, y quien la cambie por una del domicilio tiene que revisar la lista PII otra vez.
   */
  departamento: 'departamentoTransito',
  nombres: 'nombres',
  apellidos: 'apellidos',
  /**
   * **Qué ES el titular, afirmado por el ORIGEN** (HU #11947): `n` · `cc` · `ps` · `ce` · `otro`.
   *
   * Es la clave que sustituye a la heurística de la HU #11934 —«si `apellidos` trae texto, es una
   * persona natural»—, y la sustituye entera: ver {@link clasificacionDeTipoFlit}, que es la única
   * copia de la tabla en el repo.
   *
   * Medido sobre las 7 052 filas locales de `flito_tramites`: **7 052 traen la clave, y las 7 052 con
   * `jsonb_typeof = 'string'`**. `n` 4 634 · `cc` 2 393 · `ce` 22 · `ps` 3. `c` y `otro` no aparecen
   * NUNCA. La cobertura es del 100 %, que es lo que permite que el bloque del titular dependa de esto
   * y no de deducir la clase jurídica de una ausencia.
   */
  tipo: 'tipo',
} as const;

export type CampoFlitRaw = keyof typeof CLAVES_FLIT_RAW;

/**
 * Una expresión por clave, listas para entrar en un `select({...})`.
 *
 * La clave viaja como PARÁMETRO (`->> $1`) y no concatenada en el texto del SQL: es la regla 3 de
 * AGENTS.md y aquí además hace que el test pueda leer QUÉ clave quedó ligada a qué campo, que es lo
 * único que distingue el mapeo correcto del cruzado.
 *
 * `->>` (y no `->`) porque lo que va a una celda es texto: `->` devolvería `jsonb` y un valor de
 * cadena llegaría entrecomillado (`"ONIX"`). Una clave ausente da `NULL`, que es exactamente lo que
 * hace falta para `clase` mientras FLIT no la mande.
 *
 * ── El `case jsonb_typeof`: por qué el `->>` pelado no basta (gate de seguridad, Medium) ─────────
 *
 * **`->>` no falla ante un objeto: lo SERIALIZA.** Medido contra el Postgres 16 local:
 *
 *     select '{"n":{"a":1,"b":"ANA"}}'::jsonb ->> 'n';    →  {"a": 1, "b": "ANA"}   (pg_typeof = text)
 *     select '{"ap":["PEREZ","GOMEZ"]}'::jsonb ->> 'ap';  →  ["PEREZ", "GOMEZ"]
 *
 * O sea que el día que FLIT anide algo bajo una de estas nueve claves —mandar `nombres` como
 * `{primer, segundo}` en vez de una cadena es el cambio más natural del mundo—, el blob entero
 * viajaría a una celda de un archivo que SALE DEL PERÍMETRO, sin error y sin log. Con tres agravantes
 * que se encadenan solos: `pii_access_log` no declara lo que va dentro de ese blob; `bloqueTitular`
 * leería la fila como persona jurídica y pondría el JSON en `RazonSocial`; y este módulo está
 * diseñado a propósito para absorber cambios de forma de FLIT **sin despliegue**, así que no hay
 * ninguna puerta humana entre el cambio en origen y la publicación.
 *
 * **`tipo` no es una excepción y es la que más lo necesita** (HU #11947): un `tipo` que llegara como
 * objeto o como array se serializaría a `{"a": 1}`, y sin el `case` ese texto entraría al lookup de
 * `clasificacionDeTipoFlit` como cualquier otro token. Hoy caería en la rama por defecto —bloque
 * vacío—, pero la garantía que hace falta es que **un valor no escalar no pueda CLASIFICAR nada**, no
 * que hoy no coincida por casualidad con ninguna entrada de la tabla.
 *
 * El descarte va AQUÍ y no en `celdaDesdeJson` porque aquí la garantía es REAL —`jsonb_typeof` mira
 * el tipo del valor en la base— mientras que en TypeScript solo puede ser una inspección del texto ya
 * serializado. Medido: el `case` descarta objeto y array y CONSERVA el escalar (`ANA`), el número
 * (`2021` → `'2021'`), la clave ausente (NULL) y la columna NULL (NULL). No estorba al auto-llenado
 * de `Clase`, que es lo que sostiene la decisión de diseño.
 *
 * @param columna La columna `jsonb` de la que extraer (`flitoTramites.flitRaw`).
 */
export function expresionesFlitRaw(columna: Column): Record<CampoFlitRaw, ReturnType<typeof sql<string | null>>> {
  // La clave se liga DOS veces —una para comprobar la forma, otra para extraer— y tienen que ser la
  // misma: comprobar la forma de una clave y extraer otra sería un descarte que no descarta nada.
  // Hay un aserto que fija esa igualdad.
  const extraer = (clave: string) => sql<string | null>`case jsonb_typeof(${columna} -> ${clave}) when 'object' then null when 'array' then null else ${columna} ->> ${clave} end`;
  return {
    marca: extraer(CLAVES_FLIT_RAW.marca),
    linea: extraer(CLAVES_FLIT_RAW.linea),
    modelo: extraer(CLAVES_FLIT_RAW.modelo),
    clase: extraer(CLAVES_FLIT_RAW.clase),
    capacidad: extraer(CLAVES_FLIT_RAW.capacidad),
    departamento: extraer(CLAVES_FLIT_RAW.departamento),
    nombres: extraer(CLAVES_FLIT_RAW.nombres),
    apellidos: extraer(CLAVES_FLIT_RAW.apellidos),
    tipo: extraer(CLAVES_FLIT_RAW.tipo),
  };
}

// ── El valor de una celda que viene de un jsonb ──────────────────────────────────────────────────

/**
 * Un valor salido de `flit_raw`, tal como va a la celda.
 *
 * Delega en {@link celdaTexto} para las cadenas —de modo que `" "` sigue siendo ausencia, con la
 * misma regla ya probada— y añade lo único que `celdaTexto` no puede prometer: **que un valor que
 * no es una cadena no tumbe el export**.
 *
 * No es una precaución teórica. En PostgreSQL `->>` devuelve siempre texto, así que en producción
 * esto recibe cadenas; pero `flit_raw` es `jsonb` de un tercero, el tipo `string | null` de la
 * expresión es una promesa de TypeScript que nadie comprueba en ejecución, y `modeloAno` es
 * justamente el campo que un proveedor manda como número (`2021`, no `"2021"`). Un `.trim()` sobre
 * ese número sería un `TypeError` dentro del `map` de las filas: **el export entero devolvería 500
 * por UNA fila**, y las otras 1 999 legítimas se perderían con él.
 *
 * ── Lo que esta función NO es, corregido tras el gate de seguridad ──────────────────────────────
 *
 * Aquí decía que «los objetos y los arrays dan `null`», y era falso: `->>` **serializa** el objeto
 * antes de que esto lo vea (`{"a": 1, "b": "ANA"}`, tipo `text`), así que la rama de cadena se lo
 * tragaba entero y lo escribía en la celda. La rama `return null` del final era inalcanzable desde la
 * proyección, y un test la certificaba en verde pasándole un objeto JS que nunca ocurre.
 *
 * **El descarte de verdad vive en `expresionesFlitRaw`**, en SQL, donde `jsonb_typeof` puede mirar el
 * tipo real. Lo de aquí abajo es defensa en profundidad para cualquier otro llamador, y es EXACTA a
 * propósito: solo descarta lo que de verdad parsea como objeto o array, no todo lo que empiece por
 * llave. Una heurística borraría en silencio una razón social como `TRANSPORTES [ABC] SAS`, que es el
 * mismo pecado —publicar algo que no se decidió— con el signo cambiado.
 */
export function celdaDesdeJson(valor: unknown): string | null {
  if (typeof valor === 'string') {
    const texto = celdaTexto(valor);
    return texto !== null && esBlobJson(texto) ? null : texto;
  }
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null;
  if (typeof valor === 'boolean') return String(valor);
  return null;
}

/**
 * ¿Este texto ES un objeto o un array de JSON serializado?
 *
 * El prefiltro por el primer carácter no es un atajo de elegancia, es de coste: sin él habría que
 * intentar `JSON.parse` sobre las nueve claves de cada una de las 2 000 filas del tope —18 000
 * excepciones lanzadas por export— para descartar textos que ni siquiera lo parecen. Con él, casi
 * todo sale por la primera línea y el `parse` solo corre sobre lo que podría serlo.
 *
 * Un texto que empieza por `{` o `[` pero no parsea NO se descarta: es un dato legítimo con una
 * llave delante, y esta función no está para adivinar.
 */
function esBlobJson(texto: string): boolean {
  const inicio = texto[0];
  if (inicio !== '{' && inicio !== '[') return false;
  try {
    const valor: unknown = JSON.parse(texto);
    return typeof valor === 'object' && valor !== null;
  } catch {
    return false;
  }
}

// ── El bloque del titular: lo decide el `tipo` del origen ────────────────────────────────────────

/** `ClaseDeInterlocutor`, el vocabulario de la plantilla del cliente. */
export const CLASE_INTERLOCUTOR = { natural: 'PNAT', juridica: 'PJUR' } as const;

/**
 * `ClaseId`, el vocabulario de la plantilla del cliente. Va emparejado con
 * {@link CLASE_INTERLOCUTOR} y nunca se decide por separado: los dos salen del mismo lookup.
 *
 * ── `PP` y NUNCA `PAS`: esto NO es `TIPOS_DOCUMENTO_RUNT` ────────────────────────────────────────
 *
 * `packages/shared-types/src/flito-estados.ts` tiene otro catálogo de tipos de documento —el del
 * canal Cliente y el de la certificación RUNT—, y allí el pasaporte es `PAS`. **Son dos vocabularios
 * distintos de dos consumidores distintos** y esta constante es la de la plantilla del CLIENTE, que
 * pide `PP`. No se tipa contra `TipoDocumentoRunt` a propósito: si lo estuviera, el primero que
 * viniera a «unificar» corregiría `PP` a `PAS`, la plantilla del cliente dejaría de cargar y no
 * fallaría nada en el repo. El AC8 de la HU #11947 deja el catálogo del RUNT intacto.
 *
 * Las claves son por DOCUMENTO y no por clase de interlocutor (`natural`/`juridica`, como estaban
 * hasta la HU #11934): desde esta HU la persona natural tiene TRES documentos posibles —`CC`, `PP`,
 * `CE`— y un `CLASE_ID.natural` seguiría diciendo `CC`, que es exactamente la afirmación falsa que
 * esta HU viene a quitar del archivo.
 */
export const CLASE_ID = { cedula: 'CC', nit: 'NIT', pasaporte: 'PP', extranjeria: 'CE' } as const;

/** Las cinco columnas que se deciden juntas o no se deciden. */
export interface BloqueTitular {
  claseDeInterlocutor: string | null;
  nombrePila: string | null;
  apellidos: string | null;
  razonSocial: string | null;
  claseId: string | null;
}

/**
 * Las cinco columnas vacías: **el origen no dice qué es este titular**.
 *
 * Es un estado propio y no «persona jurídica sin razón social», que es la confusión cara de esta
 * hoja. Desde la HU #11947 lo produce UNA sola causa —`tipo` ausente o desconocido (AC5)— y ya no
 * la falta de nombre: ver {@link bloqueTitular}.
 */
export const TITULAR_VACIO: BloqueTitular = {
  claseDeInterlocutor: null,
  nombrePila: null,
  apellidos: null,
  razonSocial: null,
  claseId: null,
};

/** Lo que el `tipo` de FLIT decide, y que nunca se decide por separado. */
export interface ClasificacionTitular {
  claseDeInterlocutor: string;
  /** `null` = clase conocida sin documento que declarar (`otro`), NO «sin clasificar». */
  claseId: string | null;
}

/**
 * **LA tabla del AC2, y la única copia que hay en el repo** (AC6).
 *
 * | `tipo` normalizado | `ClaseDeInterlocutor` | `ClaseId` |
 * |---|---|---|
 * | `n`    | `PJUR` | `NIT`   |
 * | `cc`   | `PNAT` | `CC`    |
 * | `ps`   | `PNAT` | `PP`    |
 * | `ce`   | `PNAT` | `CE`    |
 * | `otro` | `PNAT` | *vacío* |
 *
 * Un `Map` y no un objeto literal indexado: la clave viene de un `jsonb` de un TERCERO, y
 * `TABLA['constructor']` sobre un objeto literal devuelve algo que no es `undefined`. Con un `Map`,
 * lo que no se puso no está — que es la propiedad que esta tabla necesita para que su rama por
 * defecto signifique de verdad «no lo sé».
 *
 * ── `cc`, y NO `c` (decisión de David, 2026-09-01) ───────────────────────────────────────────────
 *
 * La lectura es ESTRICTA contra el origen medido: de las 7 052 filas locales, `cc` aparece en 2 393
 * y **`c` no aparece ni una vez**. Aceptar `c` «por si acaso» sería añadir a la tabla un token que
 * nadie ha visto nunca y que, si algún día llegara, significaría algo que no sabemos. Cae en la rama
 * por defecto, igual que cualquier otro desconocido (AC5).
 */
const TABLA_TIPO_FLIT = new Map<string, ClasificacionTitular>([
  ['n', { claseDeInterlocutor: CLASE_INTERLOCUTOR.juridica, claseId: CLASE_ID.nit }],
  ['cc', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.cedula }],
  ['ps', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.pasaporte }],
  ['ce', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.extranjeria }],
  // Clase conocida, documento NO: `otro` dice «es una persona natural con un documento que no está
  // en el catálogo». `ClaseId` vacío es la respuesta honesta; poner `CC` sería inventarse el número
  // de cédula de alguien que no la tiene.
  ['otro', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: null }],
]);

/**
 * El `tipo` de FLIT tal como se busca en la tabla: recortado y en minúsculas.
 *
 * Vive en UNA función porque {@link clasificacionDeTipoFlit} y {@link claveTitular} tienen que
 * normalizar IGUAL: si la reconciliación de SOAT comparara `"CC"` con `"cc"` como valores distintos,
 * dos trámites que dicen lo mismo con otro formato dejarían la fila sin titular.
 *
 * Normaliza el FORMATO, no el vocabulario: `" CC "` es la misma cadena que `cc`; `c` es un token
 * DISTINTO y sigue siendo desconocido.
 *
 * Pasa por `celdaDesdeJson` y no por un `.trim()` propio para que «vacío» tenga una sola definición
 * en el archivo —`" "` es ausencia— y para que un valor no escalar (o el blob que `->>` serializaría
 * si alguien quitara el `case jsonb_typeof`) no llegue nunca al lookup.
 */
function normalizarTipoFlit(tipo: unknown): string | null {
  const texto = celdaDesdeJson(tipo);
  return texto === null ? null : texto.toLowerCase();
}

/**
 * Qué clase de titular afirma el origen, o `null` si no lo afirma (AC5).
 *
 * `null` es un valor de dominio y no un error: significa que `tipo` no llegó, llegó vacío, o llegó
 * con un token que no está en la tabla. Los cinco campos del bloque van entonces vacíos —ver
 * {@link bloqueTitular}—, y es lo que mantiene al canal Cliente fuera de la clasificación **por la
 * rama por defecto y sin un `if` propio**: una fila del canal no tiene trámite, luego no tiene
 * `flit_raw`, luego no tiene `tipo`.
 *
 * Es la ÚNICA copia de la tabla en el repo, y por eso el API emite el código YA RESUELTO (`CC`,
 * `NIT`, `PP`, `CE`, `null`) en las tres colas en vez del `tipo` crudo: si `n`/`cc`/`ps`/`ce` viajaran
 * al navegador, cada una de las tres páginas necesitaría su propia copia de esta tabla y las cuatro
 * podrían divergir sin que nada fallara.
 */
export function clasificacionDeTipoFlit(tipo: unknown): ClasificacionTitular | null {
  const clave = normalizarTipoFlit(tipo);
  if (clave === null) return null;
  return TABLA_TIPO_FLIT.get(clave) ?? null;
}

/** El titular tal como llega del jsonb, antes de limpiarse. */
export interface ParTitular { tipo: unknown; nombres: unknown; apellidos: unknown }

/**
 * Reparte lo que FLIT manda del titular en las cinco columnas del archivo.
 *
 * ── La regla: la clase la AFIRMA el origen, no se deduce de una ausencia (HU #11947) ─────────────
 *
 * | `tipo` | `ClaseDeInterlocutor` | `NombrePila` | `Apellidos` | `RazonSocial` | `ClaseId` |
 * |---|---|---|---|---|---|
 * | `n`                              | `PJUR` | vacío      | vacío       | `nombres` | `NIT`   |
 * | `cc`                             | `PNAT` | `nombres`  | `apellidos` | vacío     | `CC`    |
 * | `ps`                             | `PNAT` | `nombres`  | `apellidos` | vacío     | `PP`    |
 * | `ce`                             | `PNAT` | `nombres`  | `apellidos` | vacío     | `CE`    |
 * | `otro`                           | `PNAT` | `nombres`  | `apellidos` | vacío     | vacío   |
 * | ausente · `""` · cualquier otro  | vacío  | vacío      | vacío       | vacío     | vacío   |
 *
 * ── Lo que esta HU BORRA, y por qué ──────────────────────────────────────────────────────────────
 *
 * La HU #11934 decidía la clase por si `apellidos` traía texto. **Esa heurística ya no está**, y con
 * ella se va la guarda `if (nombres === null && apellidos === null) return TITULAR_VACIO`: lo ÚNICO
 * que produce el bloque vacío es que el `tipo` sea desconocido o ausente.
 *
 * El caso que lo hace visible está medido y son 7 filas de 7 052: `tipo` explícito con `nombres` y
 * `apellidos` vacíos (1 con `n`, 6 con `cc`). Con la guarda vieja saldrían sin clasificar; sin ella,
 * la del `n` sale **`PJUR` + `NIT` con la `RazonSocial` vacía**, y eso es deliberado (AC1 literal,
 * decisión de David del 2026-09-01). La diferencia con el defecto que la #11934 corrigió es exacta:
 * allí la clase se DEDUCÍA de una ausencia —el canal Cliente, sin payload ninguno, salía marcado
 * `PJUR`—; aquí la AFIRMA el origen y lo que falta es solo el nombre.
 *
 * ── Por qué el predicado es `tipo` y no `apellidos` ni `tipo_documento` ──────────────────────────
 *
 * Sustituye al párrafo de la #11934 que justificaba el par de nombres, y lo sustituye por medición:
 *
 *   · **`flit_raw->>'tipo'` está en 7 052 de 7 052 filas**, las 7 052 como cadena. Cobertura total:
 *     no hay una sola fila que hoy dependa de adivinar.
 *   · **`flito_compradores.tipo_documento` sigue a 0 de 7 052** para las filas del sync —el mapeo no
 *     lo escribe, solo lo hace el canal Cliente—, así que un predicado sobre esa columna clasificaría
 *     el parque entero como una sola cosa. No es una alternativa; sigue sin serlo.
 *   · **El par de nombres no distingue lo que hay que distinguir.** `apellidos` llega como `" "` en
 *     3 510 filas, y «sin apellido» no es «empresa»: hay 2 393 filas `cc` y 4 634 `n`, y el reparto
 *     no coincide con el del apellido en blanco. La HU #11934 clasificaba por la forma del dato; esta
 *     clasifica por lo que el origen dice que es.
 *
 * `celdaDesdeJson` sigue siendo quien limpia `nombres` y `apellidos` —`" "` es ausencia, una sola
 * definición de celda vacía en el archivo—, pero ya no DECIDE nada: un `cc` con el apellido en
 * blanco es una persona natural con el apellido vacío, no una empresa.
 */
export function bloqueTitular(par: ParTitular | null | undefined): BloqueTitular {
  if (par === null || par === undefined) return TITULAR_VACIO;

  // Lo ÚNICO que vacía el bloque. Sin `tipo` no hay nada que afirmar, y decir `PJUR`/`NIT` a partir
  // de esa ausencia sería inventarse el dato más comprometido de la hoja.
  const clase = clasificacionDeTipoFlit(par.tipo);
  if (clase === null) return TITULAR_VACIO;

  const nombres = celdaDesdeJson(par.nombres);
  const apellidos = celdaDesdeJson(par.apellidos);

  if (clase.claseDeInterlocutor === CLASE_INTERLOCUTOR.juridica) {
    return {
      claseDeInterlocutor: clase.claseDeInterlocutor,
      nombrePila: null,
      apellidos: null,
      razonSocial: nombres,
      claseId: clase.claseId,
    };
  }

  return {
    claseDeInterlocutor: clase.claseDeInterlocutor,
    nombrePila: nombres,
    apellidos,
    razonSocial: null,
    claseId: clase.claseId,
  };
}

/**
 * El titular ya limpio, en UNA cadena, para poder reconciliarlo con un solo `comun()`.
 *
 * Existe por la asimetría de SOAT: un SOAT es por VIN y puede servir a VARIOS trámites (RN-01), así
 * que sus datos de trámite se reconcilian —el valor que comparten todos, o vacío—. Hacerlo con un
 * `comun()` por campo produce un fallo silencioso y concreto: dos trámites que coinciden en `nombres`
 * y difieren en `apellidos` devolverían el nombre y un apellido en blanco.
 *
 * **Desde la HU #11947 la tupla es una TRIPLA y `tipo` va DENTRO.** Reconciliar el `tipo` con un
 * `comun()` aparte es el mismo defecto con el dato peor: dos trámites del mismo VIN que coinciden en
 * el nombre y discrepan en el tipo —uno `n`, otro `cc`— darían un nombre reconciliado y un tipo
 * vacío... o, según el orden, un `PJUR` + `NIT` construido con el nombre de una persona natural. Se
 * reconcilia la TRIPLA y se clasifica después.
 *
 * El `tipo` viaja NORMALIZADO (la misma función que usa el lookup): dos trámites que dicen `cc` y
 * `CC` dicen lo mismo y tienen que reconciliar, o el formato de una cadena dejaría la fila sin
 * titular.
 *
 * `null` = no hay titular (ninguno de los TRES campos trae nada).
 */
export function claveTitular(tipo: unknown, nombres: unknown, apellidos: unknown): string | null {
  const t = normalizarTipoFlit(tipo);
  const n = celdaDesdeJson(nombres);
  const a = celdaDesdeJson(apellidos);
  if (t === null && n === null && a === null) return null;
  return JSON.stringify([t, n, a]);
}

/** La vuelta de {@link claveTitular}, ya lista para {@link bloqueTitular}. */
export function titularDeClave(clave: string | null): ParTitular | null {
  if (clave === null) return null;
  const [tipo, nombres, apellidos] = JSON.parse(clave) as [string | null, string | null, string | null];
  return { tipo, nombres, apellidos };
}

// ── El bloque del titular del CANAL CLIENTE: lo decide `tipo_documento` ──────────────────────────

/**
 * La tabla del canal (HU #11966), hermana de {@link TABLA_TIPO_FLIT} y **deliberadamente separada**.
 *
 * Son dos vocabularios de dos orígenes distintos: allí el `tipo` de FLIT (`n`/`cc`/`ps`/`ce`/`otro`,
 * medido sobre 7 052 filas) y aquí `flito_compradores.tipo_documento`, que es el catálogo
 * `TIPOS_DOCUMENTO_RUNT` que el Cliente elige en el formulario. Fundirlas obligaría a inventar una
 * traducción entre dos listas que nadie ha cruzado, y el primer token nuevo de cualquiera de las dos
 * clasificaría filas de la otra.
 *
 * | `tipo_documento` | `ClaseDeInterlocutor` | `ClaseId` |
 * |---|---|---|
 * | `NIT`                       | `PJUR` | `NIT`   |
 * | `CC`                        | `PNAT` | `CC`    |
 * | `CE`                        | `PNAT` | `CE`    |
 * | `PAS`                       | `PNAT` | `PP`    |
 * | `TI` · `PPT` · `RC` · `PT`  | `PNAT` | *vacío* |
 * | ausente · desconocido       | *el bloque entero vacío* |
 *
 * ── `PP` y no `PAS`: el mismo aviso que {@link CLASE_ID} ────────────────────────────────────────
 *
 * La CLAVE de esta tabla es `PAS` —así lo escribe `TIPOS_DOCUMENTO_RUNT`— y su VALOR es `PP`, que es
 * lo que pide la plantilla del cliente. Son dos catálogos distintos y el AC8 de la #11947 lo dejó
 * escrito: quien «unifique» los dos rompe la carga en el sistema del cliente sin que falle nada aquí.
 *
 * ── Las cuatro sin equivalente: `ClaseId` vacío, nunca `CC` ─────────────────────────────────────
 *
 * `TI`, `PPT`, `RC` y `PT` son personas naturales declaradas cuyo documento no tiene casilla en la
 * plantilla. Es la misma decisión que ya toma `otro` en {@link TABLA_TIPO_FLIT}: vacío es la
 * respuesta honesta, y poner `CC` sería inventarse el número de cédula de alguien que no la tiene.
 *
 * Un `Map` y no un objeto literal, por lo mismo que allí: lo que no se puso, no está.
 */
const TABLA_TIPO_DOCUMENTO_CANAL = new Map<string, ClasificacionTitular>([
  ['NIT', { claseDeInterlocutor: CLASE_INTERLOCUTOR.juridica, claseId: CLASE_ID.nit }],
  ['CC', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.cedula }],
  ['CE', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.extranjeria }],
  ['PAS', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: CLASE_ID.pasaporte }],
  ['TI', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: null }],
  ['PPT', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: null }],
  ['RC', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: null }],
  ['PT', { claseDeInterlocutor: CLASE_INTERLOCUTOR.natural, claseId: null }],
]);

/** El titular del canal Cliente, tal como sale de `flito_compradores`. */
export interface TitularComprador {
  tipoDocumento: string | null;
  nombres: string | null;
  apellidos: string | null;
  razonSocial: string | null;
}

/**
 * Las cinco columnas del titular para una fila `origen = 'cliente'` (HU #11966, AC6).
 *
 * ── Por qué existe, en vez de reusar {@link bloqueTitular} ──────────────────────────────────────
 *
 * Aquella lee `flit_raw`, que una fila del canal NO TIENE: sin trámite no hay payload, así que
 * `bloqueTitular` cae en su rama por defecto y devuelve {@link TITULAR_VACIO}. Eso era lo correcto
 * hasta esta HU —no había dónde leer el nombre— y deja de serlo ahora que el canal guarda el titular
 * PARTIDO en columnas propias. Las dos funciones deciden lo mismo desde orígenes distintos y por eso
 * comparten el vocabulario ({@link CLASE_INTERLOCUTOR}, {@link CLASE_ID}) sin ampliarlo.
 *
 * ── Por qué es PURA y vive aquí ────────────────────────────────────────────────────────────────
 *
 * El motivo que declara la cabecera de este archivo: el mock de BD de las suites de export devuelve
 * lo que el escenario registró y no evalúa la proyección, así que una regla escrita dentro del
 * `filas.map(...)` de un servicio solo se puede probar generando un `.xlsx`. Aquí se prueba
 * llamándola, con `" "`, con la clave ausente y con un tipo desconocido.
 *
 * `celdaTexto` limpia los tres textos —`" "` es ausencia, una sola definición de celda vacía en el
 * archivo— pero **no decide nada**: un `CC` con el apellido en blanco es una persona natural con el
 * apellido vacío, exactamente igual que en {@link bloqueTitular}.
 */
export function bloqueTitularDesdeComprador(c: TitularComprador | null | undefined): BloqueTitular {
  if (c === null || c === undefined) return TITULAR_VACIO;

  // Lo ÚNICO que vacía el bloque: sin tipo de documento no hay nada que AFIRMAR sobre el titular, y
  // deducir `PJUR`/`NIT` de una ausencia es el defecto que la #11947 sacó de este archivo.
  const tipo = celdaTexto(c.tipoDocumento);
  const clase = tipo === null ? null : TABLA_TIPO_DOCUMENTO_CANAL.get(tipo.toUpperCase()) ?? null;
  if (clase === null) return TITULAR_VACIO;

  if (clase.claseDeInterlocutor === CLASE_INTERLOCUTOR.juridica) {
    return {
      claseDeInterlocutor: clase.claseDeInterlocutor,
      nombrePila: null,
      apellidos: null,
      razonSocial: celdaTexto(c.razonSocial),
      claseId: clase.claseId,
    };
  }

  return {
    claseDeInterlocutor: clase.claseDeInterlocutor,
    nombrePila: celdaTexto(c.nombres),
    apellidos: celdaTexto(c.apellidos),
    razonSocial: null,
    claseId: clase.claseId,
  };
}

// ── La ciudad del organismo ──────────────────────────────────────────────────────────────────────

/**
 * `OrganismoDettoCiudad`: la ciudad del organismo, sacada del catálogo por su código.
 *
 * **El código tiene que ser `flito_{soat,impuestos}.organismo_codigo`, NUNCA
 * `flit_raw->>'codigoSecretaria'`.** Los dos parecen el mismo dato y no lo son: el del payload llega
 * SIN el cero de relleno en 3 650 de 7 052 filas (`5001` donde el catálogo tiene `05001`), y el
 * índice del catálogo es por la cadena de cinco caracteres. `getOrganismoByCodigo('5001')` devuelve
 * `undefined`, así que **el 51,8 % de las filas saldría con la ciudad vacía sin que nada fallara**:
 * ni un error, ni un log, ni un test en rojo. La columna de la tabla ya la normalizó el sync, y
 * además existe en las filas del canal Cliente, que no tienen payload ninguno.
 *
 * Un código que no está en el catálogo deja la celda VACÍA y no lanza: el catálogo es una lista fija
 * compilada en `shared-types` y un organismo nuevo en la base llegaría antes que su entrada allí. Un
 * export de 2 000 filas no puede caerse entero por una.
 */
export function ciudadDeOrganismo(codigo: string | null | undefined): string | null {
  const cod = celdaTexto(codigo);
  if (cod === null) return null;
  return celdaTexto(getOrganismoByCodigo(cod)?.ciudad);
}
