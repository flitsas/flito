// FLITO comparendos — homologación y merge de las dos fuentes (Feature #11492 17a, HU #11500).
//
// Aquí no se llama a nadie ni se escribe nada: son funciones puras (salvo la que lee el mapa) que
// convierten lo que ENTRA por el cable —`ComparendoCrudoSimit` / `ComparendoCrudoMunicipal`, con su
// vocabulario de proveedor— en el canónico que vive en `flito_comparendos_registros`. Está separado
// del servicio del sync porque es la parte que más se va a tocar cuando el spike #11501 cierre la
// homologación, y porque una función pura se prueba con una tabla de casos y sin base de datos.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-11  La homologación sale de `flito_comparendos_field_map`, NO de un if/else. Se lee la versión
//        MÁXIMA de la tabla y, dentro de un mismo `target_field`, gana el candidato de `prioridad`
//        menor. Es lo que permite corregir el mapa con una fila y una nota en vez de con un
//        despliegue (ADR-0003).
//
// RN-12  El mapa vacío es un ERROR, no un mapa sin candidatos. Sin candidatos, todo ítem se
//        homologaría a un canónico sin número, la corrida leería «cero comparendos» para cada NIT y
//        la inactivación apagaría el histórico entero. Mismo razonamiento que
//        `ComparendosFuenteRespuestaIlegibleError`: cuando no se entiende el dato hay que fallar,
//        nunca devolver vacío.
//
// RN-13  SIMIT prevalece; el municipal solo llena los canónicos que SIMIT no trajo (CF-08). Y lo que
//        NINGUNA fuente reporta en esta corrida no se borra: se conserva lo que ya había en la fila.
//        Un campo que el proveedor deja de mandar es un campo del que no sabemos nada nuevo, no un
//        campo que pasó a estar vacío.
//
//        Corolario que la HU #11712 aprovecha sin añadir regla: esos tres escalones ya son la
//        promoción MONÓTONA de comparendo a multa. Cualquier fuente que presente resolución gana el
//        `??` (así que basta con que UNA hable), y el tercer escalón impide la vuelta atrás por
//        silencio del proveedor (una fila que ya fue multa conserva su resolución).
//
// RN-14  Los ítems crudos vienen de `JSON.parse` y `types.ts` los declara con firma de índice: un
//        `__proto__` PROPIO en la respuesta del proveedor es un vector de contaminación de
//        prototipo. Por eso aquí no hay ni un `Object.assign` sobre ellos, la lectura de campos se
//        hace con `hasOwnProperty` y el canónico se construye campo a campo, nunca por clave
//        calculada.
//
// RN-25  Del ítem crudo se conserva SOLO lo que el mapa vigente sabe leer (HU #11511). El resto —y
//        en SIMIT eso incluye normalmente el NOMBRE y el DOCUMENTO del infractor, una persona
//        natural que no es la empresa monitoreada— no se guarda en `payload_*`. Decisión humana del
//        2026-08-13: podar en vez de cifrar, porque lo que no se guarda no hay que cifrarlo, ni
//        purgarlo, ni auditar quién lo leyó (Ley 1581, principio de minimización).
//
//        La lista blanca se DERIVA de los `source_path` de la versión vigente del `field_map` y no
//        se escribe aparte: dos listas —una en la tabla y otra en el código— se desincronizarían en
//        la primera corrección del mapa, y el síntoma sería silencioso (un candidato nuevo que
//        nunca llega al payload). Corolario deliberado: añadir un campo a la lista blanca es
//        insertar una fila en el `field_map`, sin migración ni despliegue.
//
//        La lista blanca filtra por CLAVE y la poda filtra además por FORMA: solo se persisten
//        valores ESCALARES, que es lo único que `homologar` sabe leer. Un `source_path` permitido
//        cuyo valor sea un subárbol se descartaría entero — es la vía por la que un
//        `valorAPagar: { total, titular: { nombre, documento } }` volvería a meter la PII por una
//        clave autorizada. Y una lista blanca VACÍA nunca significa «bórralo todo»: significa que
//        el mapa vigente no describe este origen, así que no se persiste payload y se deja intacto
//        el que hubiera (ver `podarPayload`).
//
//        Lo que se paga a cambio, y se asume: la red de ADR-0003 encoge. Si el spike #11501
//        descubre que hacía falta un campo que se podó, re-mergear desde el JSONB ya no basta y hay
//        que volver a consultar al proveedor. Se cambia una pérdida de datos recuperable
//        (re-consulta) por una fuga de datos personales que no lo es.
//
// RN-26  La clave de negocio es la MISMA entre fuentes cuando el número es el número único
//        nacional (HU #11806). Si la cadena ya normalizada encaja ENTERA con
//        `^[A-Z]{1,2}[0-9]{20}$`, la clave son esos veinte dígitos; en cualquier otro caso, la
//        cadena tal cual. No se apoya en que «la letra sobre», sino en CF-07: veinte dígitos con la
//        DIVIPOLA delante ya son la identidad completa, así que la letra decora un identificador
//        que ya es único, tanto si es del municipio como si es del tipo de comparendo. Alcance
//        deliberadamente estrecho —separadores, sufijos y otras longitudes NO disparan—, con el
//        porqué entero y el precedente de ADR-0003 §6 en el docblock de `numeroCanonico`.
//
// RN-48  `01/01/1900` es el CENTINELA de «no notificado» de las dos fuentes, NO una fecha, y no se
//        persiste (HU #11794). El criterio vive en `fechaCanonica` y por tanto vale para las DOS
//        columnas de fecha: `fecha_notificacion`, que estrena la HU, y `fecha_comparendo`, que hasta
//        hoy guardaba `1900-01-01` como si fuera un hecho. Ponerlo solo en la columna nueva dejaría
//        que la misma cadena del mismo proveedor significara «no notificado» en un campo y «ocurrió
//        en 1900» en el de al lado.
//
//        Consecuencia asumida y declarada: **cambia salida ya visible en producción**. No se corrige
//        con un `UPDATE` en la migración —eso escribiría la decisión de hoy sobre filas que nadie
//        volvió a medir—, sino en el siguiente sync de cada fila; en las `inactivo`, que ya no se
//        visitan (CF-10), el `1900-01-01` sobrevive.

import { asc } from 'drizzle-orm';
import type { ComparendosTipoRegistro } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComparendosFieldMap } from '../../db/schema.js';
import { ComparendosMapaHomologacionVacioError } from './flito-comparendos.errors.js';
// El MISMO normalizador con el que el catálogo guardó el `codigo_fuente` y con el que el filtro del
// listado normaliza lo que teclea el operador (HU #11878). Con una copia parecida aquí, el día que
// una de las dos cambiara, el municipio derivado dejaría de casar con el filtro que lo busca.
import { normalizarCodigoFuente } from './flito-comparendos.service.js';
import { leerRuta } from './clients/fuente-http.js';
import type { ComparendosOrigenFuente } from './clients/types.js';

// ─────────────────────────────── El canónico ────────────────────────────────────────────────────

/**
 * Los campos que el mapa puede alimentar.
 *
 * Es una lista CERRADA y se usa como filtro al cargar el mapa: `target_field` es una columna de
 * texto, y aceptar cualquier valor significaría escribir en una propiedad cuyo nombre lo decide una
 * fila de la base. `municipioFuente` no está porque no lo trae ningún proveedor — lo pone el sync
 * con el `codigoFuente` del municipio al que se le preguntó.
 *
 * `municipioComparendo` tampoco está, y por el MISMO motivo que `tipoRegistro` (HU #11878): no lo
 * publica ningún proveedor, sale de NUESTRO catálogo de municipios cruzado con el organismo ya
 * resuelto (`municipioDelComparendo`). Si fuera `target_field`, el valor de una columna con la que
 * el listado FILTRA lo elegiría una fila de una tabla de texto libre —bastaría un `source_path`
 * apuntado a cualquier cadena del proveedor para que el municipio dejara de venir del catálogo—, y
 * además se resolvería por origen, antes de los tres escalones de RN-13: el municipio podría salir
 * de SIMIT y el organismo del municipal en la misma fila, contradiciéndose. Derivarlo al final de
 * `resolverCampos` hace imposibles las dos cosas.
 */
export const CAMPOS_CANONICOS = [
  'numeroComparendo',
  'placa',
  'codigoInfraccion',
  'descripcionInfraccion',
  'fechaComparendo',
  // HU #11794. Entra al mapa en la v4 y NO antes: hasta la v3 se dejaba fuera porque el proveedor la
  // manda con el centinela `01/01/1900`, y sin criterio para el centinela mapearla habria guardado
  // una fecha del siglo XIX. Lo que la HU cambia no es el nombre del campo, es que el centinela ya
  // tiene criterio (ver `fechaCanonica`), y con criterio el campo se puede mapear como cualquier
  // otro. Estar aqui es ademas lo que la mete en la lista blanca de la poda (RN-25): sin esta
  // entrada, `camposConservables` la seguiria tirando y la columna no se llenaria nunca.
  'fechaNotificacion',
  'organismo',
  'monto',
  'estadoFuente',
  // HU #11712. `numeroResolucion` e `idResolucion` SÍ los dice el proveedor, así que son campos del
  // mapa como los demás. `tipoRegistro` NO está aquí a propósito: no lo dice nadie, se deduce (ver
  // `tipoDeRegistro`). Si fuera `target_field`, una fila de una tabla de TEXTO podría apuntar
  // cualquier cosa a una columna `enum` y el INSERT reventaría con un `22P02` a mitad de corrida,
  // matando el NIT entero — la misma clase de fallo que el sombreado del `comparendo: true` de la
  // 0158, con peor consecuencia.
  'numeroResolucion',
  'idResolucion',
] as const;

export type CampoCanonico = typeof CAMPOS_CANONICOS[number];

/** Candidatos de un origen, por campo canónico, YA ordenados por prioridad (menor gana). */
export type CandidatosPorCampo = ReadonlyMap<CampoCanonico, readonly string[]>;

/** Mapa cargado y listo para homologar. `version`/`provisional` viajan al log de la corrida. */
export interface MapaHomologacion {
  version: number;
  provisional: boolean;
  simit: CandidatosPorCampo;
  municipal: CandidatosPorCampo;
}

/**
 * Un comparendo ya homologado. Todo opcional menos la intención: `numeroComparendo` en `null`
 * significa que el ítem no se puede identificar y el sync lo descarta.
 */
export interface ComparendoCanonico {
  numeroComparendo: string | null;
  placa: string | null;
  codigoInfraccion: string | null;
  descripcionInfraccion: string | null;
  fechaComparendo: string | null;
  /** `YYYY-MM-DD` de la notificación, o `null` si no la hubo / no se sabe (HU #11794). */
  fechaNotificacion: string | null;
  organismo: string | null;
  monto: string | null;
  estadoFuente: string | null;
  /** Número legible de la resolución (HU #11712). `null` mientras el registro sigue siendo comparendo. */
  numeroResolucion: string | null;
  /**
   * Identificador de SISTEMA de la resolución en el proveedor (`115697134`), que no es el número
   * legible y por eso es campo propio y no un respaldo del anterior: como candidato de
   * `numeroResolucion` acabaría pintado en la columna «N.º resolución» de la pantalla.
   *
   * Vale igual que el número como señal del TIPO —los dos vienen nulos mientras es comparendo y con
   * valor cuando ya es multa—, y de ahí que `tipoDeRegistro` acepte cualquiera de los dos.
   */
  idResolucion: string | null;
}

/**
 * Anchos de las columnas `varchar` del canónico.
 *
 * Se recorta aquí y no se deja fallar al INSERT a propósito: un organismo de 130 caracteres es un
 * dato feo, pero un `22001` de PostgreSQL a mitad de corrida tumba el NIT entero y con él la
 * cobertura que autoriza su inactivación. Lo que NO se recorta nunca es el número de comparendo:
 * recortar la llave sería inventarse otro comparendo (ver `numeroCanonico`).
 */
const ANCHO = {
  numeroComparendo: 60,
  placa: 10,
  codigoInfraccion: 20,
  organismo: 120,
  estadoFuente: 80,
  // Los dos de la resolución SÍ se recortan, al revés que el número de comparendo, y el motivo es el
  // que da el párrafo de arriba para NO recortar aquel: recortar la LLAVE inventaría un comparendo
  // que no existe y podría fundir dos deudas. La resolución no es llave de nada —nadie hace join ni
  // unicidad por ella—, así que recortarla degrada un dato de pantalla en vez de fundir dos filas, y
  // eso es preferible a un `22001` que tumba el NIT entero (HU #11712).
  numeroResolucion: 60,
  idResolucion: 60,
} as const;

/** Tope de `numeric(14,2)`: 12 dígitos enteros. Por encima, el INSERT reventaría. */
const MONTO_MAXIMO = 1e12;

// ─────────────────────────────── Carga del mapa (RN-11, RN-12) ──────────────────────────────────

/**
 * Lee el mapa vigente: la versión MÁXIMA de `flito_comparendos_field_map`.
 *
 * Se traen todas las filas y el máximo se calcula en memoria en vez de con dos consultas
 * (`max(version)` + filtro). La tabla es un catálogo de unas decenas de filas por versión y sube de
 * versión con un spike, no con el tráfico: una consulta menos por corrida vale más que el ahorro de
 * transferir dos o tres versiones históricas.
 *
 * @throws ComparendosMapaHomologacionVacioError si no hay ni una fila utilizable (RN-12).
 */
export async function cargarMapaHomologacion(): Promise<MapaHomologacion> {
  const filas = await db.select({
    version: flitoComparendosFieldMap.version,
    origen: flitoComparendosFieldMap.origen,
    sourcePath: flitoComparendosFieldMap.sourcePath,
    targetField: flitoComparendosFieldMap.targetField,
    prioridad: flitoComparendosFieldMap.prioridad,
    provisional: flitoComparendosFieldMap.provisional,
  })
    .from(flitoComparendosFieldMap)
    // El orden lo pone la base y no un `sort` posterior: `prioridad` es exactamente la columna que
    // el diseño creó para no perder el orden de preferencia de los candidatos al insertarlos.
    .orderBy(asc(flitoComparendosFieldMap.prioridad), asc(flitoComparendosFieldMap.sourcePath));

  if (filas.length === 0) throw new ComparendosMapaHomologacionVacioError();

  const version = filas.reduce((max, f) => (f.version > max ? f.version : max), filas[0].version);
  const vigentes = filas.filter((f) => f.version === version);

  const simit = new Map<CampoCanonico, string[]>();
  const municipal = new Map<CampoCanonico, string[]>();

  for (const fila of vigentes) {
    // `target_field` es texto libre en la base: si no está en la lista cerrada, se ignora. Sin este
    // filtro, una fila con `__proto__` o `constructor` decidiría el nombre de una propiedad que este
    // módulo escribe (RN-14).
    if (!esCampoCanonico(fila.targetField)) continue;
    const destino = fila.origen === 'simit' ? simit : fila.origen === 'municipal' ? municipal : null;
    if (destino === null) continue;
    const actuales = destino.get(fila.targetField);
    if (actuales) actuales.push(fila.sourcePath);
    else destino.set(fila.targetField, [fila.sourcePath]);
  }

  // Un mapa con filas pero sin candidato para el NÚMERO es tan inservible como uno vacío: ningún
  // ítem se podría identificar y el efecto sería el mismo apagón del histórico (RN-12).
  if (!simit.has('numeroComparendo') && !municipal.has('numeroComparendo')) {
    throw new ComparendosMapaHomologacionVacioError();
  }

  return {
    version,
    provisional: vigentes.some((f) => f.provisional),
    simit,
    municipal,
  };
}

/** ¿El `target_field` de la fila es uno de los campos que este módulo escribe? */
function esCampoCanonico(valor: string): valor is CampoCanonico {
  return (CAMPOS_CANONICOS as readonly string[]).includes(valor);
}

/** Candidatos del origen pedido. Azúcar para que el sync no se ramifique en cada llamada. */
export function candidatosDe(mapa: MapaHomologacion, origen: ComparendosOrigenFuente): CandidatosPorCampo {
  return origen === 'simit' ? mapa.simit : mapa.municipal;
}

// ─────────────────────────────── Homologación de un ítem ────────────────────────────────────────

/**
 * Primer candidato con valor, en orden de prioridad.
 *
 * La ruta puede ser ANIDADA (`infracciones.0.codigoInfraccion`,
 * `estadoCuenta.secretaria.nombreAutoridadTransito`) y no solo una clave de primer nivel: los
 * payloads reales del 2026-08-20 cuelgan de subobjetos la mitad de lo que el canónico necesita —el
 * código y la descripción de la infracción en SIMIT, el organismo en el UTS— y sin esto el mapa v2
 * no podía nombrarlos.
 *
 * Navega con `leerRuta`, la MISMA función que usan los adapters para sacar la lista del cuerpo, a
 * propósito: si hubiera dos implementaciones de «ruta con puntos», un `source_path` querría decir
 * una cosa al ingerir y otra al homologar. De ahí vienen también las dos garantías de RN-14: cada
 * salto se comprueba con `hasOwnProperty` (un `source_path` como `constructor` o `toString` leería
 * del PROTOTIPO y devolvería una función como si fuera el dato del proveedor) y los segmentos
 * `__proto__`/`constructor`/`prototype` no se navegan nunca.
 *
 * ── Qué cuenta como ausencia, y por qué importa tanto ────────────────────────────────────────────
 *
 * Cuentan como ausencia —y por tanto se SALTAN, dejando hablar al candidato siguiente— cuatro cosas:
 * `undefined`, `null`, la cadena en blanco y **todo lo que no sea un escalar legible**
 * (`esValorHomologable`). Las tres primeras son obvias; la cuarta es la que costó una HU.
 *
 * Un no-escalar en la posición de un candidato **no es un valor: es ruido con forma de valor**. La
 * versión anterior lo devolvía, la normalización de abajo (`texto`, `montoCanonico`, …) lo convertía
 * en `null` —correctamente, de un objeto no se saca un campo— y el candidato de prioridad 2 **nunca
 * llegaba a leerse**. El campo salía vacío teniendo el dato bueno una fila más abajo del mapa.
 *
 * Es exactamente el fallo del `comparendo: true` de SIMIT que documenta la migración 0158, y aquello
 * se ESQUIVÓ sacando esa fila del mapa, no se corrigió aquí. Mientras cada campo tuvo un solo
 * candidato de verdad, esquivarlo bastaba; desde la v3 (HU #11712) hay cadenas de tres y cuatro
 * —`estadoFuente` en los dos orígenes— y un respaldo real detrás del candidato principal
 * (`nroResolucion` p1 / `numeroResolucion` p2 en el municipal), así que el sombreado ya no es una
 * curiosidad: una multa real se quedaría marcada como comparendo porque el proveedor mandó un
 * objeto donde antes mandaba un número.
 *
 * Saltarlo no pierde nada: lo que se salta es justo lo que la normalización iba a tirar de todas
 * formas. Si NO hay candidato siguiente, el resultado es el mismo `null` de antes.
 */
function primerValor(item: Record<string, unknown>, rutas: readonly string[] | undefined): unknown {
  if (!rutas) return undefined;
  for (const ruta of rutas) {
    const valor = leerRuta(item, ruta);
    if (!esValorHomologable(valor)) continue;
    return valor;
  }
  return undefined;
}

/**
 * ¿Este valor crudo es algo de lo que la normalización pueda sacar un canónico?
 *
 * Solo `string` y `number` — la cadena en blanco aparte, que es ausencia con otra forma. Es lo que
 * aceptan `texto`, `numeroCanonico`, `placaCanonica` y `montoCanonico`.
 *
 * **`fechaCanonica` NO: rechaza los números** (`if (typeof valor !== 'string') return null`), así que
 * en `fechaComparendo` este filtro es más laxo que su normalizadora y queda sombreado residual — una
 * fecha que llegue como `20260719` en prioridad 1 anula el respaldo de prioridad 2 aunque traiga la
 * fecha buena. Medido por el gate de QA de la HU #11712, no deducido. NO está cubierto por el AC6,
 * que habla de «booleano, objeto, array»: esto es un escalar legítimo cuya normalizadora lo rechaza,
 * que es otra clase de caso. Cerrarlo del todo pide un filtro POR CAMPO, no una lista común; queda
 * anotado y sin hacer, que es distinto de estar resuelto.
 * Los proveedores mandan el mismo campo como `"C29"` y como `29` según el endpoint (cabecera de
 * `types.ts`), y **el número tiene que pasar**: el `valor: 633232.0` del UTS es un `number` y es el
 * monto de verdad.
 *
 * **No es `esEscalarPersistible` y no debe fundirse con él**, aunque se parezcan. Aquella responde
 * «¿esto vale la pena guardarlo en el payload podado?» y por eso admite `boolean` y `null`: no
 * llevan PII dentro y son formas legítimas de un campo del proveedor. Esta responde «¿de esto sale
 * un canónico?», y un `boolean` no: `true` no es un número de comparendo ni un estado, es
 * precisamente el valor que sombreaba a los demás. Dos preguntas distintas sobre el mismo dato, en
 * dos sitios distintos del flujo (`homologar` contra `podarPayload`).
 */
function esValorHomologable(valor: unknown): valor is string | number {
  if (typeof valor === 'number') return true;
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Un ítem crudo → canónico. Campo a campo y sin clave calculada (RN-14).
 *
 * Escribirlo desplegado en vez de recorrer `CAMPOS_CANONICOS` no es verbosidad: cada campo tiene su
 * propia normalización (la fecha no se recorta, el monto no se pasa a mayúsculas) y el objeto
 * resultante queda con forma fija, comprobada por el compilador.
 */
export function homologar(item: Record<string, unknown>, candidatos: CandidatosPorCampo): ComparendoCanonico {
  return {
    numeroComparendo: numeroCanonico(primerValor(item, candidatos.get('numeroComparendo'))),
    placa: placaCanonica(primerValor(item, candidatos.get('placa'))),
    codigoInfraccion: texto(primerValor(item, candidatos.get('codigoInfraccion')), ANCHO.codigoInfraccion, true),
    // `descripcion_infraccion` es TEXT: no lleva tope de ancho.
    descripcionInfraccion: texto(primerValor(item, candidatos.get('descripcionInfraccion')), null, false),
    fechaComparendo: fechaCanonica(primerValor(item, candidatos.get('fechaComparendo'))),
    // Por la MISMA normalizadora que la de arriba, y eso es la mitad de la HU #11794: las tres
    // grafías medidas y el centinela se resuelven en un solo sitio, así que no puede haber una
    // columna que entienda `14/05/2026` y otra que no.
    fechaNotificacion: fechaCanonica(primerValor(item, candidatos.get('fechaNotificacion'))),
    organismo: texto(primerValor(item, candidatos.get('organismo')), ANCHO.organismo, false),
    monto: montoCanonico(primerValor(item, candidatos.get('monto'))),
    estadoFuente: texto(primerValor(item, candidatos.get('estadoFuente')), ANCHO.estadoFuente, false),
    // Se homologan los DOS campos de la resolución y NO se deriva aquí el tipo (HU #11712): a esta
    // altura solo se sabe lo que dijo UNA fuente, y el tipo tiene que salir del valor ya resuelto
    // entre las dos y el histórico. Ver `resolverCampos`.
    numeroResolucion: texto(primerValor(item, candidatos.get('numeroResolucion')), ANCHO.numeroResolucion, true),
    idResolucion: texto(primerValor(item, candidatos.get('idResolucion')), ANCHO.idResolucion, true),
  };
}

// ─────────────────────────────── Normalización de valores ───────────────────────────────────────

/**
 * Texto legible: se colapsan los espacios y se recorta al ancho de la columna.
 *
 * Acepta números porque los proveedores de tránsito mandan el mismo campo como `"C29"` y como `29`
 * según el endpoint (ver la cabecera de `types.ts`). Lo que no se acepta es un objeto o un array:
 * eso no es un valor de campo, es otra cosa, y convertirlo con `String()` guardaría
 * `"[object Object]"` en la columna.
 */
function texto(valor: unknown, max: number | null, mayusculas: boolean): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  let s = String(valor).replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  if (mayusculas) s = s.toUpperCase();
  return max === null ? s : s.slice(0, max);
}

/**
 * La FORMA NACIONAL del número de comparendo, decorada con una o dos letras delante (HU #11806).
 *
 * Este literal es la fuente de verdad de la regla y se repite —sin el grupo— en el `UPDATE` de
 * reparación de la migración `0163`. Que las dos copias digan lo mismo NO se deja a la buena
 * voluntad: lo vigila `flito-comparendos-migracion-0163-paridad.test.ts`, que compara el `.source`
 * de esta constante con el literal del `.sql`.
 *
 * El grupo es la única diferencia entre las dos escrituras, y existe para extraer los veinte
 * dígitos SIN recortar por posición: `s.slice(-20)` daría hoy el mismo resultado —el anclaje lo
 * garantiza— pero sobreviviría a que alguien relajara el `{20}`, y entonces sí recortaría.
 */
export const NUMERO_FORMA_NACIONAL = /^[A-Z]{1,2}([0-9]{20})$/;

/**
 * Número de comparendo: la llave de negocio (CF-07).
 *
 * Mayúsculas y sin espacios internos para que el mismo comparendo escrito por dos proveedores sea
 * una sola fila. **No se recorta:** si no cabe en `varchar(60)` se descarta el ítem entero
 * devolviendo `null`. Recortar la llave crearía un comparendo que no existe y, peor, podría colisionar
 * con otro que comparta prefijo — fundiendo dos deudas distintas en una sola fila.
 *
 * ── La regla de la forma nacional (HU #11806) ───────────────────────────────────────────────────
 *
 * Después de esa normalización, y SOLO si la cadena entera encaja con `^[A-Z]{1,2}[0-9]{20}$`, la
 * clave son esos veinte dígitos. En cualquier otro caso sale la cadena tal cual, que es lo de
 * siempre.
 *
 * **El argumento no es «la `D` sobra».** Es **CF-07**, que ya es premisa del modelo y está escrita
 * en `schema.ts`: el número lo asigna el Estado y es ÚNICO EN EL PAÍS — por eso el único de la tabla
 * es `(numero_comparendo)` y no `(nit, numero)`. Las dos grafías medidas son `05001` + 15 dígitos
 * (DIVIPOLA de Medellín) y `11001` + 15 (Bogotá): veinte dígitos con la DIVIPOLA delante **ya son la
 * identidad completa**.
 *
 * De ahí sale la propiedad que hace segura la regla bajo la incertidumbre que la HU declara: **da
 * igual si la `D` es del municipio o del tipo de comparendo.** Bajo las dos lecturas la letra decora
 * un identificador que ya es único por sí solo; no lo extiende. La regla no apuesta por ninguna de
 * las dos hipótesis, se apoya en la tercera cosa que sí está verificada. Si mañana se descubre que
 * la `D` era de «Detección electrónica», la regla sigue siendo correcta.
 *
 * **Y no es un recorte**, que es lo que el párrafo de arriba y ADR-0003 §6 prohíben: nunca se quita
 * un dígito, solo letras, y solo cuando lo que queda es exactamente la forma nacional de veinte.
 * `D` + 19 dígitos y `D` + 21 **no disparan** y salen intactos, igual que `ABCDE` + 23 dígitos: el
 * peor caso de la regla es no fusionar algo que debería, y eso es el statu quo, no una regresión.
 *
 * ── Alcance, y lo que deliberadamente queda fuera ───────────────────────────────────────────────
 *
 * SOLO esa forma. Separadores (`D-05001…`), sufijos, prefijos numéricos y otras longitudes **no se
 * tocan**, y no por olvido: de ninguna de esas formas hay hoy ni un byte medido, y de los municipios
 * sembrados solo hay muestra de tres. Escribir una regla más ancha sería adivinar separadores, que
 * es justo lo que ADR-0003 §6 cierra. La muestra que falta la trae `formaNumero`, que emite la FORMA
 * de cada número por corrida sin emitir el número.
 *
 * La decisión es además **reversible**: `numeroComparendo` es `source_path` de la v3 del mapa en los
 * dos orígenes, así que la grafía cruda `D…` sobrevive en `payload_municipal` aunque la columna
 * guarde la de veinte (RN-25 la conserva). Si algún día la letra resultara ser identidad, se quita
 * la regla y el municipal vuelve a crear su fila en el siguiente sync.
 *
 * **Se EXPORTA**, por el mismo motivo que `placaCanonica`: el filtro `q` de `GET /registros` tiene
 * que normalizar su entrada exactamente igual que se normalizó lo guardado. Con dos
 * implementaciones parecidas, el día que una cambie el filtro deja de encontrar filas que existen —
 * y aquí el síntoma sería peor que en la placa, porque lo guardado es MÁS CORTO que lo tecleado y la
 * búsqueda es por contenido (`%q%`).
 */
export function numeroCanonico(valor: unknown): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const s = String(valor).replace(/\s+/g, '').toUpperCase();
  if (s === '' || s.length > ANCHO.numeroComparendo) return null;
  const nacional = NUMERO_FORMA_NACIONAL.exec(s);
  return nacional === null ? s : nacional[1];
}

/**
 * La FORMA de un número, sin el número: `D20`, `L1D20`, `L2D18`, `OTRO`… (HU #11806).
 *
 * Existe para responder EN UNA CORRIDA REAL la pregunta que la regla de arriba deja abierta: qué
 * grafías emiten los municipios de los que no hay ni una muestra. Sin esto, la próxima vez que una
 * fuente estrene una forma nos enteramos porque un humano cuenta filas duplicadas.
 *
 * **Cero PII, y ni siquiera el dato**: emite la longitud del bloque de letras y la del bloque de
 * dígitos, nunca el valor. No es el debate de si `numero_comparendo` es publicable en un log — es
 * que el número no sale.
 *
 * Se normaliza igual que `numeroCanonico` (mismos espacios, mismas mayúsculas) pero se mide ANTES de
 * aplicar la regla, a propósito: lo que interesa saber es qué emite el proveedor, no en qué quedó
 * después de normalizarlo — si midiéramos después, la forma prefijada nunca aparecería y el
 * histograma no serviría para lo único que se hizo. Los tokens son de cardinalidad acotada (el
 * número cabe en 60), así que el histograma no puede crecer sin límite.
 */
export function formaNumero(valor: unknown): string {
  if (typeof valor !== 'string' && typeof valor !== 'number') return 'AUSENTE';
  const s = String(valor).replace(/\s+/g, '').toUpperCase();
  if (s === '') return 'VACIO';
  // El descarte por ancho, que ya cuenta `numeroCanonico`, pero aquí como forma propia: si un
  // proveedor empezara a mandar números largos, la corrida lo diría sin cruzar dos contadores.
  if (s.length > ANCHO.numeroComparendo) return 'LARGO';
  const bloques = /^([A-Z]*)([0-9]+)$/.exec(s);
  if (bloques === null) return 'OTRO';
  return bloques[1] === '' ? `D${bloques[2].length}` : `L${bloques[1].length}D${bloques[2].length}`;
}

/**
 * Placa: mayúsculas y solo alfanuméricos.
 *
 * Los proveedores la mandan como `ABC123`, `ABC-123` o `abc 123` y las tres son el mismo vehículo.
 * Normalizarla aquí es lo que hace que el filtro por placa de `GET /registros` encuentre algo.
 *
 * Se EXPORTA por eso mismo: el filtro de la HU #11502 tiene que normalizar su entrada exactamente
 * igual que se normalizó lo guardado. Con dos implementaciones parecidas, el día que una cambie el
 * filtro deja de encontrar filas que existen, y ese fallo se ve como «no hay comparendos».
 */
export function placaCanonica(valor: unknown): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const s = String(valor).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s === '' ? null : s.slice(0, ANCHO.placa);
}

/**
 * El valor con el que las dos fuentes dicen **«no notificado»**, no «el 1 de enero de 1900».
 *
 * La premisa la dejó escrita la migración 0158 al mirar los payloads reales, y hasta la HU #11794
 * servía para NO mapear `fechaNotificacion`: sin criterio para el centinela, mapear el campo habría
 * guardado una fecha del siglo XIX en la columna. Mapearlo obliga a decidir, y lo decidido es
 * descartarlo.
 *
 * Se compara contra la fecha YA NORMALIZADA y no contra la cadena cruda, que es lo que hace que las
 * cuatro escrituras del mismo centinela —`01/01/1900`, `01/01/1900 00:00:00`, `1900-01-01` y
 * `01-01-1900`— caigan por igual sin escribir cuatro literales.
 *
 * **Lo que NO hace, y conviene no creérselo:** un centinela en prioridad 1 **sí sombrea** al
 * candidato de prioridad 2. El filtro que elige candidato es `esValorHomologable`, que corre ANTES y
 * ve una cadena no vacía; para cuando se descubre que es el centinela, `primerValor` ya decidió. Es
 * exactamente el sombreado residual que documenta `esValorHomologable` para las fechas numéricas, y
 * se deja igual y por lo mismo: cerrarlo pide un filtro POR CAMPO y no una lista común.
 *
 * **Y no es inerte en las dos columnas — ese es el error de lectura que hay que evitar, porque desde
 * esta HU el criterio del centinela vale para las dos.** Para `fechaNotificacion` sí lo es: la v4 le
 * da UN solo candidato por origen, así que no hay prioridad 2 a la que sombrear. Para
 * `fechaComparendo` NO: la v4 sí tiene respaldo de prioridad 2 (`fechaImposicion` en SIMIT, `fecha`
 * en municipal), de modo que un centinela en prioridad 1 descarta una fecha real que estaba
 * disponible. Esta HU no lo estrena —antes el centinela también ganaba, solo que se persistía como
 * `1900-01-01`— pero sí lo vuelve MENOS visible: lo que chirriaba como una fecha de 1900 pasa a ser
 * una celda vacía, indistinguible de «no hay dato». Anotado y NO resuelto, que es distinto de estar
 * resuelto.
 *
 * **Alcance estrecho a propósito:** SOLO ese día. `1900-01-02` y `1901-01-01` son fechas y se
 * guardan. No hay ni un byte medido que diga que el proveedor usa un rango como centinela, y una
 * regla más ancha se tragaría fechas legítimas — el error que sí sería irreversible.
 *
 * Se exporta para que la paridad de la migración pueda afirmar que el `.sql` y el código hablan del
 * mismo literal, en vez de dejar dos copias sueltas del mismo hecho.
 */
export const FECHA_CENTINELA_NO_NOTIFICADO = '1900-01-01';

/**
 * Fecha → `YYYY-MM-DD`, o `null` si no se entiende **o si es el centinela**.
 *
 * Se parsea con expresiones regulares y NO con `new Date(...)`: el constructor interpreta
 * `'2026-06-02'` como medianoche UTC y, al formatearlo en un servidor en `America/Bogota` (UTC-5),
 * devolvería el día anterior. Un comparendo con la fecha corrida un día es un dato mal registrado
 * que nadie ata a un problema de zona horaria.
 *
 * Se admiten las tres formas que aparecen en los portales de tránsito: ISO, `DD/MM/YYYY` y
 * `DD-MM-YYYY`, las tres **con hora detrás o sin ella**. Lo que no encaje se descarta — una fecha
 * inventada es peor que ninguna.
 *
 * La hora en la rama local no es hipotética: Verifik manda `"11/05/2026 14:20:00"` (capturado el
 * 2026-08-20) y el ancla `$` sin más la descartaba entera, así que los cinco comparendos reales del
 * NIT se homologaban con `fechaComparendo: null`. Lo que sigue detrás del día se ignora a
 * propósito: la hora no cabe en un `date` y, si se usara, arrastraría la zona horaria que el
 * párrafo de arriba evita.
 *
 * **Y que la hora sea OPCIONAL tampoco es cosmética desde la HU #11794**: las tres grafías medidas
 * el 2026-08-24 sobre el NIT 901789698 son `DD/MM/YYYY HH:MM:SS` (SIMIT), `YYYY-MM-DD` (UTS
 * Medellín) y **`DD/MM/YYYY` sin hora (UTS Bogotá)**. Exigir la hora en la rama con barras dejaría
 * a Bogotá entera en `null`, y el síntoma —una ciudad con la columna llena y otra vacía— no lo ve
 * ningún test escrito contra Medellín.
 *
 * ── El centinela (HU #11794) ─────────────────────────────────────────────────────────────────────
 *
 * `01/01/1900` sale `null`, y sale igual **para las dos columnas de fecha**. Que el criterio viva
 * aquí y no en la línea de `fechaNotificacion` de `homologar` es la decisión: un centinela no cambia
 * de significado según la columna en la que caiga, y ponerlo solo en la columna nueva dejaría que la
 * misma cadena del mismo proveedor fuese «no notificado» en un campo y «ocurrió en 1900» en el de al
 * lado.
 *
 * **Esto CAMBIA salida que ya se ve en producción**: un `fechaComparendo` que llegue `01/01/1900`
 * pasa de guardarse `1900-01-01` a guardarse `null`. Es un AC de la HU y no un efecto colateral. No
 * hay backfill: las filas ya escritas se corrigen en el siguiente sync que las visite (ver la
 * cabecera de la migración 0164), y las `inactivo` no se visitan (CF-10).
 */
function fechaCanonica(valor: unknown): string | null {
  const fecha = fechaParseada(valor);
  // Un único punto de descarte, después de normalizar: cubre las cuatro escrituras del centinela sin
  // repetir literales, y es la línea que hay que borrar para reintroducir el defecto.
  return fecha === FECHA_CENTINELA_NO_NOTIFICADO ? null : fecha;
}

/** Las tres gramáticas admitidas, sin opinión sobre el centinela. Ver {@link fechaCanonica}. */
function fechaParseada(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const s = valor.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (iso) return fechaValida(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // La hora es OPCIONAL (`(?:[T ].*)?`) y ese signo de interrogación es Bogotá: sin él,
  // `14/05/2026` no encaja y la ciudad entera se queda sin fecha de notificación.
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ].*)?$/.exec(s);
  if (local) return fechaValida(Number(local[3]), Number(local[2]), Number(local[1]));

  return null;
}

/** Comprueba que el trío existe de verdad (rechaza 31/02) y lo formatea. */
function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Importe → cadena decimal para `numeric(14,2)`, o `null`.
 *
 * El trabajo de verdad es decidir qué separador es el decimal, porque los proveedores mandan
 * `604100`, `"604.100"`, `"$ 1.160.500,00"` y `"1160500.50"` para cosas del mismo tipo. La
 * convención colombiana es punto para miles y coma para decimales, así que:
 *
 *   · Si aparecen los dos, el ÚLTIMO en aparecer es el decimal (`1.160.500,00`).
 *   · Si uno aparece más de una vez, es separador de miles (`1.160.500`).
 *   · Si aparece una sola vez y le siguen EXACTAMENTE tres dígitos, es de miles (`604.100` son
 *     604 100 pesos, no 604 pesos con 10 centavos). Con otra cantidad de dígitos, es decimal.
 *
 * Es una heurística y está admitido que lo sea: el spike #11501 la reemplazará por lo que de verdad
 * mande cada proveedor. Lo importante es que el caso ambiguo se resuelva hacia el lado colombiano y
 * que lo ininteligible sea `null` y no un número inventado.
 */
function montoCanonico(valor: unknown): string | null {
  let numero: number | null;

  if (typeof valor === 'number') numero = valor;
  else if (typeof valor === 'string') numero = parsearImporte(valor);
  else return null;

  if (numero === null || !Number.isFinite(numero)) return null;
  // Fuera del rango de la columna: guardar `null` pierde un dato, pero intentarlo tumbaría el INSERT
  // del NIT completo y con él la cobertura que autoriza su inactivación.
  if (Math.abs(numero) >= MONTO_MAXIMO) return null;
  return numero.toFixed(2);
}

/** Aplica la heurística de separadores descrita en `montoCanonico`. `null` si no hay número dentro. */
function parsearImporte(bruto: string): number | null {
  const limpio = bruto.replace(/[^\d,.-]/g, '');
  if (!/\d/.test(limpio)) return null;

  const negativo = limpio.startsWith('-');
  const sinSigno = limpio.replace(/-/g, '');
  const ultimaComa = sinSigno.lastIndexOf(',');
  const ultimoPunto = sinSigno.lastIndexOf('.');
  const separadores = (sinSigno.match(/[.,]/g) ?? []).length;

  // Índice del separador DECIMAL, o -1 si todos son de miles.
  let corte = -1;
  if (ultimaComa >= 0 && ultimoPunto >= 0) corte = Math.max(ultimaComa, ultimoPunto);
  else if (separadores === 1 && !/[.,]\d{3}$/.test(sinSigno)) corte = Math.max(ultimaComa, ultimoPunto);

  const entero = (corte >= 0 ? sinSigno.slice(0, corte) : sinSigno).replace(/[.,]/g, '');
  const decimales = (corte >= 0 ? sinSigno.slice(corte + 1) : '').replace(/[.,]/g, '');
  if (entero === '' && decimales === '') return null;

  const numero = Number(`${entero === '' ? '0' : entero}.${decimales === '' ? '0' : decimales}`);
  if (!Number.isFinite(numero)) return null;
  return negativo ? -numero : numero;
}

// ─────────────────────────────── Poda del payload crudo (RN-25) ─────────────────────────────────

/**
 * La lista blanca de un origen: los `source_path` que el mapa vigente sabe leer.
 *
 * Sale de `candidatos`, que es exactamente lo que `primerValor` puede consultar, así que el payload
 * guardado queda con la forma mínima que permite re-homologar: ni un campo de más (nombre y
 * documento del infractor se caen aquí), ni uno de menos.
 *
 * Se calcula UNA vez por origen y corrida —no por ítem— porque la lista es la misma para los miles
 * de comparendos de una corrida y recorrer el mapa por ítem sería trabajo repetido sin motivo.
 */
export function camposConservables(candidatos: CandidatosPorCampo): ReadonlySet<string> {
  const permitidos = new Set<string>();
  for (const rutas of candidatos.values()) {
    for (const ruta of rutas) permitidos.add(ruta);
  }
  return permitidos;
}

/**
 * Claves que NUNCA se copian al payload, esté o no `source_path` en el mapa (RN-14).
 *
 * `podarPayload` ya escribe con `defineProperty`, así que un `__proto__` no contamina el objeto que
 * este módulo construye. Lo que se evita aquí es lo otro: que la clave llegue VIVA al JSONB y se
 * quede ahí esperando a un consumidor futuro —el visor de 17b, un `GET /registros`— que rehidrate la
 * fila con `Object.assign` o un spread y sí monte el gadget. Un `__proto__` no es un campo legítimo
 * de un proveedor de tránsito bajo ninguna versión del mapa, así que no hay nada que perder.
 */
const CLAVES_NUNCA_PERSISTIDAS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * ¿El valor es un escalar que el merge sabe leer y que por tanto vale la pena guardar?
 *
 * La lista blanca filtra por CLAVE; esto filtra por FORMA. Sin este segundo filtro quedaba una
 * grieta entre «la lista blanca es lo que el merge sabe leer» y lo que de verdad se escribía: un
 * `source_path` permitido cuyo valor fuese un subárbol —`"valorAPagar": { "total": 604100,
 * "titular": { "nombre": …, "documento": … } }`— se persistía ENTERO, con los datos de persona
 * dentro, aunque `homologar` (`texto`, `montoCanonico`, …) no pueda extraer nada de un objeto y
 * devuelva `null`. Guardar lo que ningún re-merge puede aprovechar no es red de ADR-0003: es la
 * misma fuga con otra ruta.
 *
 * `boolean` y `null` se admiten aunque el canónico no los use hoy: no llevan PII dentro y son formas
 * legítimas de un campo del proveedor («pagado: false»). `undefined` no, porque no sobrevive a
 * `JSON.stringify` dentro de un objeto y guardarlo sería guardar una clave que desaparece al leerla
 * de vuelta del JSONB.
 */
function esEscalarPersistible(valor: unknown): boolean {
  return valor === null
    || typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean';
}

/**
 * Copia del ítem con SOLO los campos de la lista blanca (RN-25). Lo demás no se persiste.
 *
 * Devuelve `null` —y no `{}`— cuando la lista blanca del origen viene VACÍA. La diferencia no es
 * cosmética y es el hallazgo del gate: `{}` significa «de este ítem no se conserva nada» y, al
 * llegar al UPSERT, PISA el payload que ya estaba en la fila; `null` significa «no sé qué conservar
 * de este origen» y el sync lo trata como «esta corrida no trajo payload», dejando intacto lo
 * escrito (ver el UPDATE de `flito-comparendos.sync.service.ts`). Una lista blanca vacía es la señal
 * de que el mapa vigente no describe este origen —una v2 que solo cubre SIMIT, exactamente lo que el
 * spike #11501 va a sembrar—, y de un mapa que no describe el origen no se sigue que sus datos
 * sobren: se sigue que no sabemos leerlos. Ante la duda, no borrar.
 *
 * Hoy ese caso además implica que ningún ítem del origen se puede identificar (sin candidatos,
 * `numeroComparendo` sale `null` y `acumular*` lo descarta antes de llegar aquí), así que el `null`
 * es cinturón sobre tirantes. Se pone igual porque esa coincidencia es un acoplamiento a distancia
 * con `homologar`: el día que el número se derive de otro sitio, o que alguien reutilice
 * `podarPayload`, el vaciado silencioso volvería sin que nada lo avise.
 *
 * Tres detalles que no son estilo:
 *
 *   · Se itera sobre la LISTA BLANCA y no sobre las claves del ítem. Recorrer el ítem y descartar
 *     lo que no esté permitido da el mismo resultado hoy, pero invierte la carga de la prueba: la
 *     versión que recorre lo permitido no puede dejar pasar un campo nuevo del proveedor ni aunque
 *     alguien se equivoque en la condición.
 *
 *   · Se descarta lo que no sea escalar (`esEscalarPersistible`) y las claves de RN-14
 *     (`CLAVES_NUNCA_PERSISTIDAS`).
 *
 *   · La escritura va con `defineProperty` y no con `podado[clave] = valor` (RN-14). `source_path`
 *     es una columna de texto: una fila con `__proto__` haría que la asignación normal invocara el
 *     setter heredado y cambiara el PROTOTIPO del objeto en vez de crear una propiedad.
 *     `defineProperty` siempre crea una propiedad propia.
 *
 * ── Rutas ANIDADAS: se reconstruye la HOJA, jamás el subárbol ────────────────────────────────────
 *
 * Desde el mapa v2 hay `source_path` con puntos, y ahí la poda tiene que ser más fina que «copiar
 * la clave». `estadoCuenta.secretaria.nombreAutoridadTransito` autoriza UN string; el subárbol
 * `estadoCuenta` del payload real del UTS lleva dentro una `direccion` de la vía pública donde se
 * impuso el comparendo (dato de persona) y más cosas. Copiar el contenedor porque su hoja esté autorizada sería la fuga
 * de RN-25 con otra ruta, así que lo que se hace es construir el esqueleto mínimo —`estadoCuenta`
 * con solo `secretaria`, y `secretaria` con solo `nombreAutoridadTransito`— y poner ahí la hoja.
 *
 * El filtro de forma (`esEscalarPersistible`) se aplica a la HOJA: una ruta cuya hoja sea a su vez
 * un objeto no se guarda, igual que antes. Y los contenedores intermedios imitan la forma del
 * original (array si en el ítem era array) para que `infracciones.0.codigoInfraccion` siga leyendo
 * igual al re-homologar.
 */
export function podarPayload(
  item: Record<string, unknown>, permitidos: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (permitidos.size === 0) return null;

  const podado: Record<string, unknown> = {};
  for (const ruta of permitidos) injertarHoja(item, podado, ruta);
  return podado;
}

/** Escritura segura: propiedad PROPIA siempre, nunca el setter heredado (RN-14). */
function fijar(destino: object, clave: string, valor: unknown): void {
  Object.defineProperty(destino, clave, {
    value: valor, enumerable: true, writable: true, configurable: true,
  });
}

/**
 * Copia en `podado` la hoja de UNA ruta autorizada, creando por el camino solo los contenedores
 * que esa hoja necesita.
 *
 * La lectura va por `leerRuta` —la misma que `primerValor`—, así que un segmento prohibido o una
 * ruta que el ítem no tiene se resuelven en `undefined` y aquí no se escribe nada. La comprobación
 * explícita de `CLAVES_NUNCA_PERSISTIDAS` se mantiene porque esto además ESCRIBE: una ruta como
 * `datos.__proto__` no debe llegar viva al JSONB aunque su hoja fuese legible.
 */
function injertarHoja(
  item: Record<string, unknown>, podado: Record<string, unknown>, ruta: string,
): void {
  const segmentos = ruta.split('.');
  if (segmentos.some((s) => s === '' || CLAVES_NUNCA_PERSISTIDAS.has(s))) return;

  const hoja = leerRuta(item, ruta);
  if (hoja === undefined || !esEscalarPersistible(hoja)) return;

  let origen: unknown = item;
  let destino: object = podado;
  for (let i = 0; i < segmentos.length - 1; i++) {
    const segmento = segmentos[i]!;
    origen = leerRuta(origen, segmento);
    const yaCreado = Object.prototype.hasOwnProperty.call(destino, segmento)
      ? (destino as Record<string, unknown>)[segmento]
      : undefined;
    let hijo: object;
    if (yaCreado !== null && typeof yaCreado === 'object') {
      // Otra ruta autorizada ya abrió este contenedor (`estadoCuenta.infraccion.0.codigoInfraccion`
      // y `…0.descripcion` comparten los tres primeros saltos): se sigue dentro del mismo.
      hijo = yaCreado;
    } else {
      hijo = Array.isArray(origen) ? [] : {};
      fijar(destino, segmento, hijo);
    }
    destino = hijo;
  }
  fijar(destino, segmentos[segmentos.length - 1]!, hoja);
}

// ─────────────────────────────── Merge de las dos fuentes (RN-13) ───────────────────────────────

/**
 * Un comparendo visto en esta corrida, con lo que aportó cada fuente antes de decidir.
 *
 * Se guardan las dos versiones por separado —y no un canónico ya fusionado— porque el orden de
 * preferencia es una decisión del merge y quererla aplicar «según llega» obligaría a saber si la
 * otra fuente va a hablar después.
 */
export interface ConsolidadoComparendo {
  numero: string;
  simit: ComparendoCanonico | null;
  /** Ítem crudo YA PODADO a la lista blanca (RN-25). El original no sale de esta función. */
  payloadSimit: unknown;
  municipal: ComparendoCanonico | null;
  /** Ídem para el municipal. */
  payloadMunicipal: unknown;
  /** `codigo_fuente` del municipio que lo devolvió. No lo trae el proveedor: lo pone el sync. */
  municipioFuente: string | null;
}

/**
 * Acumulador de una corrida para UN NIT: número de comparendo → lo aportado por cada fuente.
 *
 * Es un `Map` normal y la llave es un número de comparendo venido del proveedor. Se documenta porque
 * la duda es legítima: un `Map` no tiene prototipo que contaminar —a diferencia de un objeto plano,
 * donde una llave `__proto__` sí sería un problema (RN-14)—, así que es la estructura correcta aquí.
 */
export type AcumuladorNit = Map<string, ConsolidadoComparendo>;

/**
 * Lo que un `acumular*` cuenta de paso, sin mirar ni un valor.
 *
 * Era un `number` pelado —los ítems ignorados— hasta la HU #11806. Ahora viaja también el histograma
 * de FORMAS (`formaNumero`), que es lo único que puede decirnos, en una corrida de verdad, qué
 * grafías emiten los municipios de los que no hay muestra. Va en el retorno y no en un parámetro de
 * salida para que estas funciones sigan siendo puras respecto de todo lo que no sea el acumulador.
 */
export interface ConteoAcumulacion {
  /** Ítems descartados por no traer un número reconocible (la señal del spike #11501). */
  ignorados: number;
  /** Forma del número CRUDO → cuántas veces se vio. Nunca lleva el número (RN-25 y Ley 1581). */
  formas: Map<string, number>;
}

/** Suma uno al token del histograma. Sale a función para que los dos acumuladores no la copien. */
function contarForma(formas: Map<string, number>, item: Record<string, unknown>, candidatos: CandidatosPorCampo): void {
  const forma = formaNumero(primerValor(item, candidatos.get('numeroComparendo')));
  formas.set(forma, (formas.get(forma) ?? 0) + 1);
}

/**
 * Suma lo que devolvió SIMIT para un NIT.
 *
 * Gana el PRIMER ítem de cada número: si el proveedor repite un comparendo en la misma respuesta, la
 * segunda copia no aporta nada y sobrescribirla solo haría depender el resultado del orden de la
 * lista. Devuelve cuántos ítems se descartaron por no traer número reconocible, que es justamente la
 * señal que el spike #11501 necesita ver, y el histograma de formas de la HU #11806.
 *
 * El payload se PODA aquí (RN-25), en el mismo sitio en que se decide conservarlo. Podar más tarde
 * —al escribir— dejaría el ítem íntegro vivo en el acumulador de toda la corrida y bastaría con que
 * alguien logueara ese objeto para publicar los datos del infractor.
 */
export function acumularSimit(
  acumulador: AcumuladorNit, items: readonly Record<string, unknown>[], candidatos: CandidatosPorCampo,
): ConteoAcumulacion {
  let ignorados = 0;
  const formas = new Map<string, number>();
  const permitidos = camposConservables(candidatos);
  for (const item of items) {
    contarForma(formas, item, candidatos);
    const canonico = homologar(item, candidatos);
    if (canonico.numeroComparendo === null) { ignorados++; continue; }
    const previo = acumulador.get(canonico.numeroComparendo);
    if (previo) {
      if (previo.simit === null) {
        previo.simit = canonico;
        previo.payloadSimit = podarPayload(item, permitidos);
      }
      continue;
    }
    acumulador.set(canonico.numeroComparendo, {
      numero: canonico.numeroComparendo,
      simit: canonico,
      payloadSimit: podarPayload(item, permitidos),
      municipal: null,
      payloadMunicipal: null,
      municipioFuente: null,
    });
  }
  return { ignorados, formas };
}

/**
 * Suma lo que devolvió UN municipio para un NIT.
 *
 * Si dos municipios devuelven el mismo comparendo, se conserva el del primero que lo trajo: el
 * `municipio_fuente` es una pista de dónde se vio, y cambiarla en cada corrida según el orden en que
 * respondan los UTS —que con el pool de paralelismo no está garantizado— haría bailar el dato sin
 * que nada hubiera cambiado en la realidad.
 *
 * Aquí es donde la regla de la forma nacional (HU #11806) hace su trabajo: el ítem de Medellín llega
 * con la grafía `D` + 20 dígitos y cae sobre la entrada que SIMIT ya creó con los mismos veinte
 * dígitos, así que rellena huecos en vez de abrir una segunda deuda.
 */
export function acumularMunicipal(
  acumulador: AcumuladorNit, items: readonly Record<string, unknown>[],
  candidatos: CandidatosPorCampo, codigoFuente: string,
): ConteoAcumulacion {
  let ignorados = 0;
  const formas = new Map<string, number>();
  const permitidos = camposConservables(candidatos);
  for (const item of items) {
    contarForma(formas, item, candidatos);
    const canonico = homologar(item, candidatos);
    if (canonico.numeroComparendo === null) { ignorados++; continue; }
    const previo = acumulador.get(canonico.numeroComparendo);
    if (previo) {
      if (previo.municipal === null) {
        previo.municipal = canonico;
        previo.payloadMunicipal = podarPayload(item, permitidos);
        previo.municipioFuente = codigoFuente;
      }
      continue;
    }
    acumulador.set(canonico.numeroComparendo, {
      numero: canonico.numeroComparendo,
      simit: null,
      payloadSimit: null,
      municipal: canonico,
      payloadMunicipal: podarPayload(item, permitidos),
      municipioFuente: codigoFuente,
    });
  }
  return { ignorados, formas };
}

/** Lo que ya había guardado, para no perder campos que esta corrida no trajo (RN-13). */
export type CanonicoExistente = Partial<Record<Exclude<CampoCanonico, 'numeroComparendo'>, string | null>>;

/**
 * El canónico que se va a escribir, sin el número (que es la llave y no cambia).
 *
 * Escrito como interfaz y no como `Record<Exclude<CampoCanonico, 'numeroComparendo'>, string|null>`
 * desde la HU #11712: `tipoRegistro` sale de aquí y NO es un `CampoCanonico` (no lo alimenta el
 * mapa) ni es `string | null` (es la unión de dos literales). El mapeado automático no podía
 * expresar ninguna de las dos cosas.
 */
export interface CamposResueltos {
  placa: string | null;
  codigoInfraccion: string | null;
  descripcionInfraccion: string | null;
  fechaComparendo: string | null;
  fechaNotificacion: string | null;
  organismo: string | null;
  monto: string | null;
  estadoFuente: string | null;
  numeroResolucion: string | null;
  idResolucion: string | null;
  /** Derivado de las dos líneas de arriba, nunca homologado ni elegido. Ver `tipoDeRegistro`. */
  tipoRegistro: ComparendosTipoRegistro;
  /**
   * De qué municipio ES el comparendo (HU #11878). Derivado igual que `tipoRegistro` y por el mismo
   * motivo: no lo publica nadie. Se calcula sobre el `organismo` YA RESUELTO por los tres escalones
   * de RN-13, así que municipio y organismo no pueden contradecirse dentro de la misma fila.
   */
  municipioComparendo: string | null;
}

/**
 * Comparendo o multa, a partir de la resolución YA RESUELTA (HU #11712).
 *
 * La regla de negocio es de una línea —sin resolución sigue siendo un comparendo; con resolución ya
 * es una multa— y la disyunción está en que el proveedor manda DOS campos que se comportan igual: el
 * número legible y el identificador de sistema. Cualquiera de los dos con valor es una resolución.
 *
 * Lo interesante es dónde se llama, y es en `resolverCampos`: sobre el valor que ya pasó por
 * `simit ?? municipal ?? previo`. De ahí salen tres propiedades que NO habría si el tipo se
 * homologara por origen y se eligiera después como un campo más:
 *
 *   1. **Coherencia por construcción.** `elegir('tipoRegistro')` y `elegir('numeroResolucion')`
 *      podrían salir de fuentes distintas en la misma fila —SIMIT sin resolución gana el tipo por
 *      RN-13, el municipal aporta el número por el segundo escalón— y dejar un `comparendo` CON
 *      número de resolución. Derivando del valor resuelto, el CHECK de la base no puede fallar por
 *      un camino que este módulo escriba.
 *   2. **Promoción MONÓTONA.** Que una fuente calle no es la afirmación «no hay resolución»: es
 *      indistinguible de que no publique el campo. Como cualquier fuente que presente resolución
 *      gana el `??`, cualquiera de las dos promueve la fila a multa, sin regla nueva.
 *   3. **Sin regresión por silencio.** El tercer escalón (`previo`) conserva la resolución ya
 *      guardada, así que una fila que ya fue multa no vuelve a comparendo porque el proveedor deje
 *      de mandar el campo.
 *
 * **Riesgo abierto y declarado, no deuda escondida:** no hay regreso multa → comparendo. Una
 * resolución revocada existe en la realidad, pero registrarla exigiría una señal POSITIVA del
 * proveedor y hoy ninguna de las dos fuentes la publica. `estadoFuente` no sirve: es texto crudo sin
 * normalizar. Si algún día una fuente la publique, entra aquí y no en el visor.
 *
 * Y una premisa que conviene tener escrita: devolver `comparendo` cuando no hay resolución es una
 * afirmación, y se apoya en que el mapa vigente NOMBRE los campos de resolución. Se sostiene porque
 * las columnas y la v3 del mapa nacen en la MISMA migración (0160): una base capaz de guardar
 * `tipo_registro` es una base cuyo mapa máximo pregunta por la resolución.
 */
export function tipoDeRegistro(
  numeroResolucion: string | null, idResolucion: string | null,
): ComparendosTipoRegistro {
  return numeroResolucion !== null || idResolucion !== null ? 'multa' : 'comparendo';
}

/**
 * El límite de palabra con el que un `codigo_fuente` se busca dentro del organismo (HU #11878).
 *
 * **`\b` NO sirve y no es una preferencia de estilo:** los códigos del catálogo admiten espacios
 * (`SANTA FE DE ANTIOQUIA`), y `\b` colocado alrededor de una alternativa con espacios no delimita
 * el TÉRMINO, delimita cada trozo. Lo que se quiere es «el código, y a los lados algo que no sea
 * alfanumérico o el borde del texto», que es exactamente esto.
 *
 * Se exporta para que la paridad con la migración 0165 compare el literal del código con el literal
 * del `.sql`, en vez de dejar dos copias sueltas del mismo criterio.
 */
export const LIMITE_PALABRA_MUNICIPIO = { antes: '(^|[^A-Z0-9])', despues: '([^A-Z0-9]|$)' } as const;

/**
 * De qué municipio ES el comparendo, que **no** es a qué municipio se le preguntó (HU #11878).
 *
 * Función pura, sin I/O: recibe el catálogo ya cargado. Vive aquí y no en el servicio del sync por
 * lo mismo que `tipoDeRegistro` — es criterio de negocio y se prueba con una tabla de casos.
 *
 * ── Los dos escalones ────────────────────────────────────────────────────────────────────────────
 *
 *   1. **`municipioFuente !== null` → ese, y FIN.** Ni se mira el organismo. Si a Medellín se le
 *      preguntó y Medellín devolvió la fila, no hay nada que deducir: el hecho vence a la
 *      heurística, y así una discrepancia entre el catálogo y cómo se escribe el organismo nunca
 *      puede empeorar un dato que ya era cierto.
 *   2. **Si no, se lee el ORGANISMO.** `null` → `null`. Si hay texto, se normaliza con
 *      `normalizarCodigoFuente` (el mismo del catálogo y del filtro) y se busca cada `codigo` con
 *      límite de palabra explícito.
 *
 * ── Por qué la ambigüedad cae a `null` ───────────────────────────────────────────────────────────
 *
 * **Exactamente un código distinto casa → ese. Cero, o dos o más → `null`.** Sin desempate por
 * longitud ni «gana el primero»: los dos serían una decisión inventada sobre un texto libre del
 * proveedor, y el precio de equivocarse es enseñarle a un operador un comparendo de otro municipio
 * (o esconderle el suyo) sin que nada lo delate. `null` es el lado seguro y además el que ya
 * significa «no se sabe» en esta tabla.
 *
 * Cuenta CÓDIGOS DISTINTOS y no coincidencias: un catálogo con la misma fila repetida —que el único
 * de `codigo_fuente` impide hoy— no convertiría un acierto en ambigüedad.
 *
 * ── El catálogo entra COMPLETO, no solo `activo = true` ──────────────────────────────────────────
 *
 * Desactivar una fuente deja de consultarla; no borra de dónde eran los comparendos que ya trajo. Es
 * el mismo argumento con el que `condicionAusente` no acota por los municipios activos y con el que
 * el filtro del listado no valida su `municipio` contra el catálogo: perder de vista deuda viva por
 * un cambio de parametrización sería el peor de los desenlaces posibles.
 *
 * ── Por qué NO se escapa el código antes de meterlo en la regex ──────────────────────────────────
 *
 * Porque `codigo_fuente` está validado en la RUTA del catálogo contra `^[A-Z0-9 _-]+$`, así que no
 * puede contener metacaracteres: ni `.`, ni `*`, ni `(`, ni `\`. **Si esa validación se relaja, esto
 * se rompe en silencio** —un código con `.` empezaría a casar de más, y nadie vería un error, solo
 * municipios mal atribuidos—. Queda escrito aquí a propósito: es la premisa de la que depende, y el
 * `-` va al final de la clase de caracteres allí por la misma razón.
 */
export function municipioDelComparendo(
  municipioFuente: string | null, organismo: string | null, catalogo: readonly string[],
): string | null {
  // Escalón 1. El municipio consultado manda y corta la evaluación aquí (AC1).
  if (municipioFuente !== null) return municipioFuente;
  // Escalón 2. Sin organismo no hay nada de donde deducir; no es un error, es no saber.
  if (organismo === null) return null;

  const texto = normalizarCodigoFuente(organismo);
  const casados = new Set<string>();
  for (const codigo of catalogo) {
    const patron = new RegExp(`${LIMITE_PALABRA_MUNICIPIO.antes}${codigo}${LIMITE_PALABRA_MUNICIPIO.despues}`);
    if (patron.test(texto)) casados.add(codigo);
  }
  // Uno y solo uno. Cero es «no reconocible» y dos o más es «ambiguo»: las dos cosas se saben con la
  // misma honestidad, y las dos son `null`.
  return casados.size === 1 ? [...casados][0]! : null;
}

/**
 * Decide el valor final de cada campo: **SIMIT → municipal → lo que ya había** (RN-13, CF-08).
 *
 * Los tres escalones, en ese orden exacto, y cada uno responde a una pregunta distinta:
 *
 *   1. `simit` primero porque es la fuente autorizada del CF-08. Si SIMIT dice algo, eso es.
 *   2. `municipal` después: **solo rellena huecos**, nunca pisa a SIMIT. Es el caso del mock de la
 *      HU #11499, donde el mismo comparendo llega sin descripción por SIMIT y con ella por el UTS.
 *   3. `existente` al final, y no en medio: si el valor viejo tuviera prioridad sobre el municipal,
 *      un `estado_fuente` que pasó de «Pendiente de pago» a «Pagado» en el municipio se quedaría
 *      congelado para siempre en la fila. Y estar al final, en vez de no estar, es lo que impide que
 *      una corrida en la que ninguna fuente reportó el campo lo ponga en `null`: dejar de recibir un
 *      dato no es recibir que está vacío.
 *
 * ── El tercer parámetro (HU #11878) ─────────────────────────────────────────────────────────────
 *
 * `ctx` es REQUERIDO y no opcional con default, y esa es una decisión y no una omisión: un
 * `ctx = { municipioFuente: null, catalogoMunicipios: [] }` por defecto compilaría en el próximo
 * llamador que se olvidara de pasarlo y devolvería `municipioComparendo: null` para SIEMPRE, sin un
 * solo error. Un parámetro requerido convierte ese olvido en un fallo de compilación.
 *
 * `ctx.municipioFuente` es el MISMO valor que se escribe en la columna `municipio_fuente` —el
 * llamador lo saca a una const y la usa para las dos cosas—, porque si la columna vieja y la
 * derivación leyeran expresiones distintas podrían discrepar dentro de la misma fila.
 */
export function resolverCampos(
  consolidado: ConsolidadoComparendo, existente: CanonicoExistente | null,
  ctx: { municipioFuente: string | null; catalogoMunicipios: readonly string[] },
): CamposResueltos {
  const simit = consolidado.simit;
  const municipal = consolidado.municipal;
  const previo = existente ?? {};

  const elegir = (campo: Exclude<CampoCanonico, 'numeroComparendo'>): string | null =>
    simit?.[campo] ?? municipal?.[campo] ?? previo[campo] ?? null;

  /**
   * Igual que `elegir`, pero el tercer escalón **no puede devolver el centinela** (HU #11794).
   *
   * Hace falta, y es el hallazgo de la HU: sin esto, el AC «las filas guardadas con `1900-01-01` se
   * corrigen en el siguiente sync» sería falso. `01/01/1900` que llega de la fuente se convierte en
   * `null` en `homologar`, así que los dos primeros escalones se quedan mudos y el `??` cae en
   * `previo`, que trae el `1900-01-01` de la corrida anterior. Resultado: la fila se re-escribiría a
   * sí misma con el defecto para siempre, y como la migración tampoco hace backfill, el valor no lo
   * corregiría NADIE.
   *
   * No contradice el tercer escalón de RN-13 («dejar de recibir un dato no es recibir que está
   * vacío»): eso protege VALORES, y el centinela no lo es —es la forma que tiene el proveedor de
   * decir que no hay dato—. Conservarlo no conserva información, conserva un error de lectura.
   *
   * Y por eso la corrección no depende de que la fuente vuelva a mandar el centinela: basta con que
   * el sync visite la fila. Lo único que se queda con el `1900-01-01` es lo que ya no se visita (las
   * filas `inactivo`, CF-10), y eso está declarado en la cabecera de la migración 0164.
   */
  const elegirFecha = (campo: 'fechaComparendo' | 'fechaNotificacion'): string | null => {
    const guardada = previo[campo] ?? null;
    return simit?.[campo]
      ?? municipal?.[campo]
      ?? (guardada === FECHA_CENTINELA_NO_NOTIFICADO ? null : guardada);
  };

  // Los dos de la resolución se resuelven ANTES para poder derivar el tipo de ellos (HU #11712).
  const numeroResolucion = elegir('numeroResolucion');
  const idResolucion = elegir('idResolucion');
  // Y el organismo ANTES que el municipio, por el mismo motivo (HU #11878): el municipio se deduce
  // del organismo YA RESUELTO entre las dos fuentes y el histórico, nunca del que trajo un origen
  // suelto. Así la fila no puede decir «Medellín» al lado de un organismo de Bello.
  const organismo = elegir('organismo');

  return {
    placa: elegir('placa'),
    codigoInfraccion: elegir('codigoInfraccion'),
    descripcionInfraccion: elegir('descripcionInfraccion'),
    fechaComparendo: elegirFecha('fechaComparendo'),
    // Los MISMOS tres escalones, sin regla propia (HU #11794): SIMIT prevalece y el municipal solo
    // llena el hueco (CF-08). Que en la muestra del NIT 901789698 las dos fuentes coincidan en
    // `30/07/2026` no vuelve inerte la precedencia — la vuelve invisible, que es distinto, y por eso
    // se prueba con un caso donde SÍ discrepan.
    fechaNotificacion: elegirFecha('fechaNotificacion'),
    organismo,
    monto: elegir('monto'),
    estadoFuente: elegir('estadoFuente'),
    numeroResolucion,
    idResolucion,
    // Derivado, nunca elegido: es lo que hace que el CHECK de la 0160 se cumpla por construcción.
    tipoRegistro: tipoDeRegistro(numeroResolucion, idResolucion),
    // Ídem (HU #11878), y se re-deriva ENTERO en cada corrida: no hay escalón «lo que ya había». Es
    // deliberado y lo sostiene una premisa del catálogo —no hay endpoint que borre municipios, solo
    // crece—, así que re-derivar solo puede reconocer más, nunca menos. Y es lo que hace que añadir
    // un municipio a la parametrización arregle el histórico que se visita, sin migración.
    municipioComparendo: municipioDelComparendo(ctx.municipioFuente, organismo, ctx.catalogoMunicipios),
  };
}

/**
 * `origen_merge` a partir de dónde se ha visto el comparendo, contando también las corridas
 * anteriores.
 *
 * Acumulativo y no «lo de esta corrida»: un comparendo que alguna vez llegó por SIMIT sigue siendo
 * de origen SIMIT aunque hoy solo lo haya devuelto el municipio. Lo que se vio POR ÚLTIMA VEZ ya lo
 * cuentan `ultimo_visto_en` y `estado`; duplicar esa información aquí solo daría dos respuestas
 * distintas a la misma pregunta.
 */
export function origenMerge(vistoEnSimit: boolean, vistoEnMunicipal: boolean): 'simit' | 'municipal' | 'ambos' {
  if (vistoEnSimit && vistoEnMunicipal) return 'ambos';
  return vistoEnSimit ? 'simit' : 'municipal';
}
