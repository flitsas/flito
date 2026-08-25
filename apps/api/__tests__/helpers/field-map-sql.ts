// FLITO comparendos — leer el `field_map` DESDE los `.sql` de las migraciones (HU #11877).
//
// El mapa de homologación vive en la BASE (`flito_comparendos_field_map`), así que ningún test
// unitario lo puede consultar. Lo que sí es verificable sin base es su ÚNICA fuente: las migraciones
// que lo siembran. Este helper existe para que esa lectura sea UNA y no una copia por archivo de
// test — hasta la HU #11877 el mismo extractor estaba escrito dos veces (la paridad de la 0164 y el
// test de la fecha de notificación), y dos copias del mismo parser son dos oportunidades de que una
// se quede atrás y su test pase por vacuidad.
//
// Lo que NO afirma este helper, y conviene tenerlo claro: que la migración esté REALMENTE aplicada
// en un ambiente. Eso lo dice `db:apply`, no un `readFileSync`. Aquí se comprueba lo que la cadena
// de migraciones ORDENA, que es lo que cualquier ambiente acabará teniendo.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Una tupla del `INSERT INTO flito_comparendos_field_map`, tal como está escrita en el `.sql`. */
export interface FilaFieldMap {
  version: number;
  origen: string;
  sourcePath: string;
  targetField: string;
  prioridad: number;
  provisional: boolean;
}

const DIRECTORIO = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));

/** Ruta absoluta de una migración por nombre de archivo. */
export function rutaMigracion(nombre: string): string {
  return `${DIRECTORIO}${nombre}`;
}

/**
 * Quita los `--` que no vivan dentro de una cadena SQL.
 *
 * Hace falta porque las cabeceras de estas migraciones son prosa larga que NOMBRA lo que el archivo
 * no hace («ni un UPDATE», «sin backfill») y, sin podarla, el texto alimentaría las búsquedas que
 * existen justo para comprobar que esas sentencias no están.
 */
export function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (!enCadena && c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    if (c === "'") enCadena = !enCadena;
    salida += c;
  }
  return salida;
}

/**
 * Las tuplas del `INSERT` de `field_map` de UN `.sql`.
 *
 * Extractor ESTRICTO a propósito: una tupla con una forma que no se entienda no se ignora en
 * silencio — no casa, y el guardarraíl de conteo que cada test pone delante se cae. Un extractor
 * permisivo devolvería la lista vacía y TODAS las aserciones de cobertura pasarían por vacuidad.
 */
export function filasSembradas(sql: string): FilaFieldMap[] {
  const tupla = /\(\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)\s*,\s*(true|false)\s*,\s*(?:NULL|'(?:[^']*)')\s*\)/gi;
  return [...podarComentarios(sql).matchAll(tupla)].map((m) => ({
    version: Number(m[1]),
    origen: m[2],
    sourcePath: m[3],
    targetField: m[4],
    prioridad: Number(m[5]),
    provisional: m[6].toLowerCase() === 'true',
  }));
}

/** Las filas que siembra una migración concreta, por nombre de archivo. */
export function filasDeMigracion(nombre: string): FilaFieldMap[] {
  return filasSembradas(readFileSync(rutaMigracion(nombre), 'utf8'));
}

/**
 * El nombre de la tabla. Es lo que decide qué `.sql` participa en los barridos de abajo.
 */
const TABLA_FIELD_MAP = 'flito_comparendos_field_map';

/**
 * Los `.sql` del directorio que SIEMBRAN el `field_map`, ya sin comentarios.
 *
 * El filtro por nombre de tabla no es una optimización: es correccion. `filasSembradas` reconoce una
 * FORMA —`(int, 'txt', 'txt', 'txt', int, bool, NULL|'txt')`— y no sabe de qué `INSERT` viene. Hoy en
 * el directorio (166 archivos) esa forma solo la tienen las cuatro migraciones que SIEMBRAN el mapa
 * —0150, 0158, 0160 y 0164, comprobado una a una—, pero cualquier migración futura con una tupla
 * de siete columnas de esa forma entraría en el barrido y su primer entero se leería como «versión del mapa». Con un
 * número mayor que 4, `mapaVigenteSembrado()` pasaría a devolver la versión de una tabla que no es
 * esta y los guardarraíles del módulo empezarían a hablar de otra cosa **en verde**.
 *
 * El filtro deja pasar CINCO archivos, no cuatro: además de los cuatro sembradores entra la 0151,
 * que nombra la tabla en código (`SELECT max(version) … FROM flito_comparendos_field_map`) sin
 * sembrar ni una fila. Es inofensivo —`filasSembradas` no encuentra tuplas en ella— y se dice aquí
 * para que el conteo no sorprenda a quien depure el barrido.
 *
 * Se filtra sobre el cuerpo PODADO y no sobre el texto crudo por prevención, NO por un caso vivo:
 * hoy ningún `.sql` nombra la tabla únicamente en su prosa, y podar o no podar selecciona los mismos
 * cinco archivos. Se poda igual porque el día que una cabecera explique en prosa lo que el archivo
 * NO le hace al mapa —el estilo de cabecera de este módulo—, el texto crudo la metería en el barrido.
 */
function archivosDelFieldMap(): { archivo: string; cuerpo: string }[] {
  return readdirSync(DIRECTORIO)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((archivo) => ({
      archivo,
      cuerpo: podarComentarios(readFileSync(rutaMigracion(archivo), 'utf8')),
    }))
    .filter((x) => x.cuerpo.toLowerCase().includes(TABLA_FIELD_MAP));
}

/**
 * TODAS las filas que la cadena de migraciones siembra, de todas las versiones.
 *
 * Es lo que una base al día tiene DE VERDAD en la tabla: `field_map` es acumulativa —cada versión se
 * inserta, ninguna borra a la anterior—. Sembrar un mock con esto y no solo con la última versión es
 * lo que hace que RN-11 («se lee la versión máxima y no se hereda») se pueda observar en un test en
 * vez de darse por supuesta.
 */
export function todasLasFilasSembradas(): FilaFieldMap[] {
  return archivosDelFieldMap().flatMap((x) => filasSembradas(x.cuerpo));
}

/** Lo que devuelve {@link mapaVigenteSembrado}. */
export interface MapaSembrado {
  /** La versión MÁXIMA que la cadena de migraciones siembra: la que `cargarMapaHomologacion` leerá. */
  version: number;
  /** Solo las filas de esa versión. */
  filas: FilaFieldMap[];
  /** Los `.sql` que la siembran, para que un fallo diga dónde mirar. */
  archivos: string[];
}

/**
 * El mapa VIGENTE según la cadena entera de migraciones, no según un archivo elegido a mano.
 *
 * Esta es la diferencia que importa: `cargarMapaHomologacion` se queda con la versión MÁXIMA de la
 * tabla y **no hereda** de las anteriores (RN-11). Un test que solo lea la 0164 afirma lo que la
 * 0164 escribió, no lo que el módulo va a usar; el día que una migración nueva siembre una v5 sin
 * `fechaNotificacion`, aquel test seguiría verde con la columna vacía en producción. Barriendo el
 * directorio, la v5 entra sola en el cálculo y el guardarraíl se pone rojo el mismo día.
 *
 * Se barre el DIRECTORIO —filtrado a los `.sql` que nombran la tabla, ver `archivosDelFieldMap`— y
 * no una lista de nombres: una lista escrita a mano vuelve a poner a un humano en el camino que este
 * helper existe para quitar, y es justo el humano que se olvidaría de añadir la v5.
 */
export function mapaVigenteSembrado(): MapaSembrado {
  const todas: { archivo: string; fila: FilaFieldMap }[] = [];
  for (const { archivo, cuerpo } of archivosDelFieldMap()) {
    for (const fila of filasSembradas(cuerpo)) todas.push({ archivo, fila });
  }
  if (todas.length === 0) return { version: 0, filas: [], archivos: [] };

  const version = todas.reduce((max, x) => (x.fila.version > max ? x.fila.version : max), todas[0].fila.version);
  const vigentes = todas.filter((x) => x.fila.version === version);

  return {
    version,
    filas: vigentes.map((x) => x.fila),
    archivos: [...new Set(vigentes.map((x) => x.archivo))],
  };
}
