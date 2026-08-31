// FLITO — lo que el Excel de las colas DERIVA, y las ocho claves que lee de `flit_raw`
// (Feature #11908, HU #11934).
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

// ── Las ocho claves del payload de FLIT ──────────────────────────────────────────────────────────

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
  departamento: 'departamentoTransito',
  nombres: 'nombres',
  apellidos: 'apellidos',
} as const;

export type CampoFlitRaw = keyof typeof CLAVES_FLIT_RAW;

/**
 * Una expresión `->>` por clave, listas para entrar en un `select({...})`.
 *
 * La clave viaja como PARÁMETRO (`->> $1`) y no concatenada en el texto del SQL: es la regla 3 de
 * AGENTS.md y aquí además hace que el test pueda leer QUÉ clave quedó ligada a qué campo, que es lo
 * único que distingue el mapeo correcto del cruzado.
 *
 * `->>` (y no `->`) porque lo que va a una celda es texto: `->` devolvería `jsonb` y un valor de
 * cadena llegaría entrecomillado (`"ONIX"`). Una clave ausente da `NULL` en las dos formas, que es
 * exactamente lo que hace falta para `clase` mientras FLIT no la mande.
 *
 * @param columna La columna `jsonb` de la que extraer (`flitoTramites.flitRaw`).
 */
export function expresionesFlitRaw(columna: Column): Record<CampoFlitRaw, ReturnType<typeof sql<string | null>>> {
  const extraer = (clave: string) => sql<string | null>`${columna} ->> ${clave}`;
  return {
    marca: extraer(CLAVES_FLIT_RAW.marca),
    linea: extraer(CLAVES_FLIT_RAW.linea),
    modelo: extraer(CLAVES_FLIT_RAW.modelo),
    clase: extraer(CLAVES_FLIT_RAW.clase),
    capacidad: extraer(CLAVES_FLIT_RAW.capacidad),
    departamento: extraer(CLAVES_FLIT_RAW.departamento),
    nombres: extraer(CLAVES_FLIT_RAW.nombres),
    apellidos: extraer(CLAVES_FLIT_RAW.apellidos),
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
 * Los objetos y los arrays dan `null` y no `"[object Object]"`: una celda no es el sitio donde
 * enterarse de que el payload cambió de forma.
 */
export function celdaDesdeJson(valor: unknown): string | null {
  if (typeof valor === 'string') return celdaTexto(valor);
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null;
  if (typeof valor === 'boolean') return String(valor);
  return null;
}

// ── El bloque del titular: TRES estados, no dos ──────────────────────────────────────────────────

/** `ClaseDeInterlocutor`, el vocabulario de la plantilla del cliente. */
export const CLASE_INTERLOCUTOR = { natural: 'PNAT', juridica: 'PJUR' } as const;

/** `ClaseId`. Va emparejado con {@link CLASE_INTERLOCUTOR} y nunca se decide por separado. */
export const CLASE_ID = { natural: 'CC', juridica: 'NIT' } as const;

/** Las cinco columnas que se deciden juntas o no se deciden. */
export interface BloqueTitular {
  claseDeInterlocutor: string | null;
  nombrePila: string | null;
  apellidos: string | null;
  razonSocial: string | null;
  claseId: string | null;
}

/**
 * Las cinco columnas vacías: no hay titular que clasificar.
 *
 * Es un estado propio y no «persona jurídica sin razón social», que es la confusión cara de esta
 * HU — ver {@link bloqueTitular}.
 */
export const TITULAR_VACIO: BloqueTitular = {
  claseDeInterlocutor: null,
  nombrePila: null,
  apellidos: null,
  razonSocial: null,
  claseId: null,
};

/** El par de nombres tal como llega del jsonb, antes de limpiarse. */
export interface ParTitular { nombres: unknown; apellidos: unknown }

/**
 * Reparte `nombres`/`apellidos` de FLIT en las cinco columnas del titular.
 *
 * ── La regla, que tiene TRES estados y no dos ────────────────────────────────────────────────────
 *
 * | Entrada | `ClaseDeInterlocutor` | `NombrePila` | `Apellidos` | `RazonSocial` | `ClaseId` |
 * |---|---|---|---|---|---|
 * | sin par (no hay `flit_raw`, o los trámites discrepan) | vacío | vacío | vacío | vacío | vacío |
 * | con apellidos | `PNAT` | `nombres` | `apellidos` | vacío | `CC` |
 * | sin apellidos | `PJUR` | vacío | vacío | `nombres` | `NIT` |
 *
 * **El primer estado es el que se olvida, y olvidarlo no rompe nada a la vista.** Escribir
 * `if (!apellidos) → PJUR/NIT` colapsa los dos primeros casos: cada fila del canal Cliente —que
 * tiene `vehiculo_id` pero no trámite, así que no tiene `flit_raw`— saldría marcada `PJUR` + `NIT`
 * con la razón social VACÍA. El archivo se abre, las 25 cabeceras están, ningún aserto de columnas
 * se entera, y lo que se publica es una afirmación falsa sobre la naturaleza jurídica de un titular.
 *
 * ── Por qué el predicado es `apellidos` y no `tipo_documento` ────────────────────────────────────
 *
 * `flito_compradores.tipo_documento` existe y está a 0 de 7 052 para las filas del sync: el mapeo no
 * lo escribe, solo lo hace el canal Cliente. Un predicado sobre esa columna clasificaría el parque
 * entero como una sola cosa y funcionaría —al revés— justo en las filas que no tienen el resto del
 * bloque. La señal disponible es el par de nombres.
 *
 * ── Por qué `celdaTexto` como predicado y no un `.trim()` nuevo ──────────────────────────────────
 *
 * `apellidos` llega como `" "` cuando no hay apellido: medido, 3 510 filas de «solo espacios», 3 542
 * con valor, **cero vacías y cero nulas**. Un `if (apellidos)` sobre la cadena cruda las daría todas
 * por presentes y clasificaría el parque entero como persona natural. `celdaTexto` ya trata `" "`
 * como ausencia, ya está probado, y usarlo aquí es lo que mantiene una sola definición de «celda
 * vacía» en el archivo.
 */
export function bloqueTitular(par: ParTitular | null | undefined): BloqueTitular {
  if (par === null || par === undefined) return TITULAR_VACIO;

  const nombres = celdaDesdeJson(par.nombres);
  const apellidos = celdaDesdeJson(par.apellidos);

  // Sin ninguno de los dos no hay nada que clasificar, y eso NO es una persona jurídica anónima:
  // es una fila cuyo `flit_raw` no trae el bloque. Decir `PJUR`/`NIT` aquí sería inventarse el dato
  // más comprometido de la hoja a partir de su ausencia.
  if (nombres === null && apellidos === null) return TITULAR_VACIO;

  if (apellidos !== null) {
    return {
      claseDeInterlocutor: CLASE_INTERLOCUTOR.natural,
      nombrePila: nombres,
      apellidos,
      razonSocial: null,
      claseId: CLASE_ID.natural,
    };
  }

  return {
    claseDeInterlocutor: CLASE_INTERLOCUTOR.juridica,
    nombrePila: null,
    apellidos: null,
    razonSocial: nombres,
    claseId: CLASE_ID.juridica,
  };
}

/**
 * El par ya limpio, en UNA cadena, para poder reconciliarlo con un solo `comun()`.
 *
 * Existe por la asimetría de SOAT: un SOAT es por VIN y puede servir a VARIOS trámites (RN-01), así
 * que sus datos de trámite se reconcilian —el valor que comparten todos, o vacío—. Hacerlo con dos
 * `comun()` independientes, uno por `nombres` y otro por `apellidos`, produce un fallo silencioso y
 * concreto: dos trámites que coinciden en `nombres` y difieren en `apellidos` devolverían el nombre
 * y un apellido en blanco, y esa fila **se clasificaría como jurídica metiendo el nombre de pila de
 * una persona en la columna `RazonSocial`**. El par se reconcilia como TUPLA y se clasifica después.
 *
 * `null` = no hay par (ninguno de los dos campos trae nada), que es el primer estado de
 * {@link bloqueTitular}.
 */
export function clavePar(nombres: unknown, apellidos: unknown): string | null {
  const n = celdaDesdeJson(nombres);
  const a = celdaDesdeJson(apellidos);
  if (n === null && a === null) return null;
  return JSON.stringify([n, a]);
}

/** La vuelta de {@link clavePar}, ya lista para {@link bloqueTitular}. */
export function parDeClave(clave: string | null): ParTitular | null {
  if (clave === null) return null;
  const [nombres, apellidos] = JSON.parse(clave) as [string | null, string | null];
  return { nombres, apellidos };
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
