// FLITO comparendos — lectura del registro consolidado y de su timeline (Feature #11492 17a,
// HU #11502, CF-09/CF-11), con los filtros de listado por municipio, fuente y causal que añadió la
// HU #11555 (Feature #11495 17b, RN-36).
//
// Es el archivo que LEE `flito_comparendos_registros` para devolvérselo a una PANTALLA. El sync los
// escribe (`flito-comparendos.sync.service.ts`), la purga los borra
// (`flito-comparendos-purga.cron.ts`), la gestión de 17b escribe sus dos únicas columnas editables
// —causal y observación— desde `flito-comparendos.gestion.service.ts` (HU #11557), y aquí solo se
// consultan: **no hay ni un INSERT, ni un UPDATE, ni un DELETE en este archivo**, y eso es el CF-09
// en su forma más literal — los campos de fuente no se editan desde el API (RN-04).
//
// Desde la HU #11558 hay una segunda lectura de la tabla —el export a Excel, en
// `flito-comparendos.export.service.ts`—, y no es una copia de esta: proyecta otras columnas (las
// del archivo) y no pagina. Lo que SÍ comparten, y por eso vive aquí, es `condicionesDeFiltro`: qué
// significa cada filtro se decide en un solo sitio, o el archivo acabaría conteniendo algo distinto
// de lo que la pantalla enseña.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-31  La lectura NO devuelve `payload_simit` ni `payload_municipal`. Desde la HU #11511 esos
//        payloads están podados a la lista blanca del `field_map`, pero siguen siendo la respuesta
//        de un tercero sobre un tercero y su razón de existir es poder re-mergear sin volver a
//        llamar al proveedor — no alimentar una pantalla. Ninguna consulta de este archivo los
//        selecciona siquiera: lo que no sale de la base no se puede filtrar por descuido más arriba.
//
// RN-32  La paginación es por CURSOR sobre `(created_at, id)`, y las dos mitades importan.
//        Que sea cursor y no `offset`: entre dos páginas puede correr un sync e insertar filas, y
//        con `offset` eso desplaza la ventana —un registro se repite, o se salta, sin que nadie lo
//        note—. Que el orden sea `created_at` y no `ultimo_visto_en`: el segundo lo reescribe cada
//        corrida y SIEMPRE hacia arriba, así que una fila que todavía no se ha alcanzado puede
//        saltar por encima del cursor y no aparecer nunca. `created_at` se escribe en el alta y no
//        se vuelve a tocar (ver `insertarRegistro`, que lo excluye del UPDATE de la carrera), así
//        que el orden no se mueve bajo los pies de quien pagina. El desempate por `id` existe
//        porque dos altas de la misma corrida comparten `created_at` al milisegundo: sin él, el
//        orden entre ellas lo decidiría PostgreSQL y el cursor las repetiría o las saltaría.
//
// RN-33  Los filtros de IDENTIDAD son exactos: `nit` y `placa` comparan por igualdad contra el
//        valor normalizado (el mismo normalizador con el que se guardó, no uno parecido). Una
//        búsqueda parcial por placa o por NIT es una forma de barrer datos personales de a poco
//        —`placa=A` devolvería el parque entero—, y este módulo consulta deudas de terceros. Lo
//        único que admite coincidencia parcial es `q`, que busca sobre el NÚMERO de comparendo: es
//        un consecutivo del Estado y no identifica a una persona.
//        Esos dos filtros entran por el CUERPO de `POST /registros/buscar` y no por la query de un
//        GET (AGENTS.md §14): un NIT o una placa en la URL sobrevive en el access log del proxy, en
//        el historial del navegador y en el `Referer`, tres sitios fuera de la retención y del
//        registro de acceso que la Ley 1581 exige aquí. Para este archivo da igual de dónde vengan
//        —recibe el filtro ya validado—, pero la regla se escribe donde vive la consulta.
//
// RN-34  El registro de acceso (Ley 1581 art. 17) lo pone la RUTA, con
//        `registrarAccesoComparendos`, y no este archivo: es el borde HTTP quien sabe QUIÉN pidió
//        la lectura. Este servicio no toca `req`.
//
// RN-35  El `detalle` de un evento sale por LISTA BLANCA (`origen`, `motivo`), no tal cual está en
//        la columna. Es JSONB —lo único de la respuesta que no está enumerado campo a campo—, y
//        devolverlo entero significaría que cualquier clave que alguien escriba ahí en el futuro se
//        publica por el API sin que nadie lo haya decidido. Hoy el sync solo escribe esas dos
//        (RN-20), así que la lista blanca no quita nada; lo que hace es que siga siendo verdad.
//
// RN-36  Los filtros que NO identifican a nadie —`municipio`, `fuente` y la causal (HU #11555)—
//        entran por la QUERY, y no son una excepción al RN-33 sino su otra mitad: un código de
//        municipio, un origen de merge y el id de una causal describen al COMPARENDO y a cómo se
//        gestiona, no a su titular, así que ninguno de los tres convierte la URL en un rastro de
//        datos personales. `municipio` compara por IGUALDAD contra `municipio_fuente` normalizado
//        con `normalizarCodigoFuente` —el mismo normalizador con el que el catálogo guardó el
//        código y con el que el sync lo escribió en el registro—, y NO se valida contra el
//        catálogo a propósito: un municipio desactivado sigue teniendo comparendos en la base, y no
//        poder listarlos sería perder de vista deuda viva por un cambio de parametrización.
//        `sinCausal` es `causal_id IS NULL` y no una comparación contra vacío: la columna es `uuid`
//        y no tiene cadena vacía que comparar. Que `causalId` y `sinCausal` juntos sean un 400 lo
//        decide la RUTA (son dos parámetros contradictorios, y eso es validación de entrada); aquí,
//        si llegaran los dos, el AND devuelve la página vacía que la lógica pide.
//
// RN-46  `gestionActualizadaPor` sale RESUELTO a `{ id, nombre }` (HU #11562), no como el id suelto
//        con el que nació en la #11556. El único uso del campo es escribir «gestionado por X» en
//        una pantalla, y no hay directorio de usuarios que la pantalla pueda consultar para
//        resolverlo — así que el id suelto se pintaba tal cual («usuario 5»). El nombre se trae con
//        un `leftJoin` a `users`, la misma forma y el mismo criterio que
//        `ComparendosTokenSimitMeta.actualizadoPor`.
//        `LEFT` y no `INNER`: la columna es nula en todo comparendo sin gestionar —que es la
//        mayoría— y un join interno los dejaría FUERA del listado entero, no sin nombre.
//        El nombre es dato de una persona identificable (personal interno): se publica a quien ya
//        puede ver el comparendo, y no entra en el `detail` de `audit_logs`, ni en el `motivo` del
//        `pii_access_log`, ni en ningún log. El EXPORT no lo lleva y sigue con el id (RN-42): ese
//        archivo sale del perímetro.

import { and, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import type {
  ComparendoEvento,
  ComparendoRegistro,
  ComparendoRegistroDetalle,
  ComparendosRegistrosFiltro,
  ComparendosRegistrosPagina,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComparendosEventos, flitoComparendosRegistros, users } from '../../db/schema.js';
import {
  ComparendosCursorInvalidoError,
  ComparendosNoEncontradoError,
} from './flito-comparendos.errors.js';
import { numeroCanonico, placaCanonica } from './flito-comparendos-merge.js';
import { normalizarCodigoFuente, normalizarNit } from './flito-comparendos.service.js';

/**
 * Columnas que salen a la respuesta. Escritas una a una y no con `select()` a propósito (RN-31):
 * `select()` trae la fila entera y bastaría con que alguien devolviera el objeto sin proyectar para
 * publicar los dos payloads. Enumerarlas hace que añadir una columna sensible al esquema NO la
 * exponga por omisión.
 */
const COLUMNAS_REGISTRO = {
  id: flitoComparendosRegistros.id,
  numeroComparendo: flitoComparendosRegistros.numeroComparendo,
  nitMonitoreado: flitoComparendosRegistros.nitMonitoreado,
  placa: flitoComparendosRegistros.placa,
  codigoInfraccion: flitoComparendosRegistros.codigoInfraccion,
  descripcionInfraccion: flitoComparendosRegistros.descripcionInfraccion,
  fechaComparendo: flitoComparendosRegistros.fechaComparendo,
  organismo: flitoComparendosRegistros.organismo,
  municipioFuente: flitoComparendosRegistros.municipioFuente,
  monto: flitoComparendosRegistros.monto,
  estadoFuente: flitoComparendosRegistros.estadoFuente,
  // HU #11712. `id_resolucion` NO sale por aquí y no es un olvido: es un identificador de sistema
  // del proveedor, ilegible fuera de él, y su único uso —saber si la fila ya es multa— ya viaja
  // resuelto en `tipoRegistro`. Publicarlo daría una segunda columna que nadie sabría leer.
  tipoRegistro: flitoComparendosRegistros.tipoRegistro,
  numeroResolucion: flitoComparendosRegistros.numeroResolucion,
  origenMerge: flitoComparendosRegistros.origenMerge,
  vistoEnSimit: flitoComparendosRegistros.vistoEnSimit,
  vistoEnMunicipal: flitoComparendosRegistros.vistoEnMunicipal,
  estado: flitoComparendosRegistros.estado,
  primeraVistoEn: flitoComparendosRegistros.primeraVistoEn,
  ultimoVistoEn: flitoComparendosRegistros.ultimoVistoEn,
  inactivadoEn: flitoComparendosRegistros.inactivadoEn,
  ultimoSyncRunId: flitoComparendosRegistros.ultimoSyncRunId,
  causalId: flitoComparendosRegistros.causalId,
  observacion: flitoComparendosRegistros.observacion,
  // Auditoría de la gestión (HU #11556). Sale por la lista blanca como todo lo demás: la columna
  // nueva no se publica por existir, se publica porque está escrita aquí.
  gestionActualizadaEn: flitoComparendosRegistros.gestionActualizadaEn,
  gestionActualizadaPor: flitoComparendosRegistros.gestionActualizadaPor,
  createdAt: flitoComparendosRegistros.createdAt,
  updatedAt: flitoComparendosRegistros.updatedAt,
} as const;

/**
 * La proyección que se le pide a la base: la lista blanca de la tabla **más el nombre del autor de
 * la gestión**, que vive en `users` y llega por el `leftJoin` (RN-46).
 *
 * Está separada de {@link COLUMNAS_REGISTRO} y no fundida con ella para que la lista blanca siga
 * siendo exactamente «las columnas del registro que se publican» (RN-31) y `FilaRegistro` pueda
 * seguir derivándose de `$inferSelect` de esa tabla: una columna de `users` metida ahí dentro haría
 * que ese tipo mintiera sobre de dónde sale cada campo.
 */
const SELECCION_REGISTRO = {
  ...COLUMNAS_REGISTRO,
  /**
   * `users.name` del autor de la gestión, o `null` si la fila no está gestionada — el `leftJoin` no
   * casa nada cuando `gestion_actualizada_por` es nulo.
   *
   * Del join sale SOLO el nombre. Ni el `username`, ni el correo, ni el rol: es la lista blanca de
   * la otra tabla, y el criterio del RN-31 no cambia porque las columnas vengan de un join.
   */
  gestionAutorNombre: users.name,
} as const;

/** Condición del `leftJoin` a `users`. Una sola definición para las dos lecturas (RN-46). */
const JOIN_AUTOR_GESTION = eq(users.id, flitoComparendosRegistros.gestionActualizadaPor);

type FilaRegistro = {
  [K in keyof typeof COLUMNAS_REGISTRO]: (typeof flitoComparendosRegistros.$inferSelect)[K]
} & {
  /** `string | null`: lo que devuelve un `LEFT JOIN` que puede no casar, aunque la columna sea `NOT NULL`. */
  gestionAutorNombre: string | null;
};
type FilaEvento = typeof flitoComparendosEventos.$inferSelect;

function registroDto(f: FilaRegistro): ComparendoRegistro {
  return {
    id: f.id,
    numeroComparendo: f.numeroComparendo,
    nitMonitoreado: f.nitMonitoreado,
    placa: f.placa,
    codigoInfraccion: f.codigoInfraccion,
    descripcionInfraccion: f.descripcionInfraccion,
    fechaComparendo: f.fechaComparendo,
    organismo: f.organismo,
    municipioFuente: f.municipioFuente,
    monto: f.monto,
    estadoFuente: f.estadoFuente,
    // `null` se publica tal cual: es «no se sabe» y NO «comparendo» (HU #11712). Traducirlo aquí a
    // un valor por defecto convertiría el histórico anterior a la 0160 en un dato verificado.
    tipoRegistro: f.tipoRegistro,
    numeroResolucion: f.numeroResolucion,
    origenMerge: f.origenMerge,
    vistoEnSimit: f.vistoEnSimit,
    vistoEnMunicipal: f.vistoEnMunicipal,
    estado: f.estado,
    primeraVistoEn: f.primeraVistoEn.toISOString(),
    ultimoVistoEn: f.ultimoVistoEn.toISOString(),
    inactivadoEn: f.inactivadoEn?.toISOString() ?? null,
    ultimoSyncRunId: f.ultimoSyncRunId,
    causalId: f.causalId,
    observacion: f.observacion,
    // `timestamptz` → ISO, igual que `inactivadoEn`: `null` cuando nadie ha gestionado la fila, que
    // es el caso de todo lo anterior a la HU #11556. Pedir la columna en `COLUMNAS_REGISTRO` y
    // olvidarla aquí devolvería `undefined` sin que ninguna aserción de proyección lo notara.
    gestionActualizadaEn: f.gestionActualizadaEn?.toISOString() ?? null,
    // El id Y el nombre, resueltos aquí (RN-46, HU #11562): la pantalla no tiene con qué resolver
    // un id suelto. Misma forma y misma comprobación que `ComparendosTokenSimitMeta.actualizadoPor`.
    //
    // Hacen falta los dos para publicar el objeto: sin nombre no se puede escribir «gestionado por
    // X», y devolver `{ id, nombre: null }` obligaría a la pantalla a pintar el número otra vez. El
    // caso es teórico —la FK es `ON DELETE RESTRICT`, así que el usuario referenciado existe— y por
    // eso se resuelve como el «no gestionado»: `null`, que la pantalla ya sabe pintar.
    gestionActualizadaPor: f.gestionActualizadaPor !== null && f.gestionAutorNombre !== null
      ? { id: f.gestionActualizadaPor, nombre: f.gestionAutorNombre }
      : null,
    creadoEn: f.createdAt.toISOString(),
    actualizadoEn: f.updatedAt.toISOString(),
  };
}

function eventoDto(f: FilaEvento): ComparendoEvento {
  return {
    id: f.id,
    tipo: f.tipo,
    syncRunId: f.syncRunId,
    detalle: detalleDto(f.detalle),
    ocurridoEn: f.createdAt.toISOString(),
  };
}

/**
 * Claves que un `detalle` puede publicar (RN-35). Son las dos que escribe el sync (RN-20): `origen`
 * en el alta y la reaparición, `motivo` en la inactivación.
 */
const CLAVES_DETALLE = ['origen', 'motivo'] as const;

/**
 * Proyecta el `detalle` de un evento igual que `COLUMNAS_REGISTRO` proyecta la fila: por lista
 * blanca (RN-35).
 *
 * La columna es JSONB y drizzle la tipa como `unknown`, así que primero se exige un objeto —un
 * valor suelto (número, cadena) en `detalle` sería una fila escrita por algo que no es este
 * módulo— y después se copian solo las claves conocidas. Sin ese segundo paso, `detalle` sería el
 * único hueco por el que algo no enumerado llegaría a la respuesta: basta con que un proceso futuro
 * guarde ahí la placa, la respuesta del proveedor o el token con el que se llamó.
 *
 * Un `detalle` del que no sobrevive ninguna clave vuelve como `null` y no como `{}`: «este evento
 * no trae contexto conocido» tiene una sola representación y la pantalla no distingue dos vacíos.
 */
function detalleDto(valor: unknown): Record<string, unknown> | null {
  if (!esObjeto(valor)) return null;

  const limpio: Record<string, unknown> = {};
  for (const clave of CLAVES_DETALLE) {
    if (valor[clave] !== undefined) limpio[clave] = valor[clave];
  }
  return Object.keys(limpio).length > 0 ? limpio : null;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

// ─────────────────────────────── Cursor de paginación (RN-32) ───────────────────────────────────

/**
 * El cursor viaja como base64url de `<createdAt ISO>|<uuid>`.
 *
 * Se codifica —en vez de mandar los dos valores en la query— para que sea OPACO: un cursor legible
 * invita a construirlo a mano, y en cuanto alguien lo hace el orden de la lista deja de ser un
 * detalle interno y pasa a ser contrato. No es cifrado ni pretende serlo: no protege nada que la
 * propia respuesta no lleve ya (la fecha de alta y el id del último registro de la página).
 */
const SEPARADOR = '|';

/** UUID en cualquiera de sus versiones. El `id` del cursor va a una comparación contra `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  createdAt: Date;
  id: string;
}

export function codificarCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}${SEPARADOR}${id}`, 'utf8').toString('base64url');
}

/**
 * Decodifica y VALIDA. Base64 mal formado no lanza en Node —devuelve basura—, así que la validación
 * es lo único que separa un cursor corrupto de una consulta con una fecha inventada.
 *
 * @throws ComparendosCursorInvalidoError si no es un cursor emitido por este módulo.
 */
function decodificarCursor(valor: string): Cursor {
  const plano = Buffer.from(valor, 'base64url').toString('utf8');
  const corte = plano.indexOf(SEPARADOR);
  if (corte < 0) throw new ComparendosCursorInvalidoError();

  const id = plano.slice(corte + 1);
  if (!UUID.test(id)) throw new ComparendosCursorInvalidoError();

  const createdAt = new Date(plano.slice(0, corte));
  if (Number.isNaN(createdAt.getTime())) throw new ComparendosCursorInvalidoError();

  return { createdAt, id };
}

/**
 * «Estrictamente después en el orden `(created_at DESC, id DESC)`».
 *
 * Comparación de TUPLAS, y no el `or(lt, and(eq, lt))` con el que nació en la #11502. Las dos
 * formas seleccionan exactamente las mismas filas, pero PostgreSQL solo reconoce la tupla como un
 * RANGO del índice: la forma con `or` sale como `Filter`, de modo que cada página vuelve a leer y a
 * descartar todo lo que ya se paginó, y el coste crece de forma lineal con la profundidad.
 *
 * Medido sobre 200.000 filas al sostener el AC5 de la #11555, en la página ~200 del filtro por
 * municipio: con `or`, `Rows Removed by Filter: 10000` y 10.105 buffers (8,9 ms); con la tupla,
 * `Index Cond` y 55 buffers (0,15 ms). El `ORDER BY` ya lo servía el índice en los dos casos — lo
 * que la tupla arregla no es el orden, es el salto.
 *
 * El precio es `sql` crudo, y de ahí los dos casts explícitos: `::timestamptz` y `::uuid` son justo
 * el reparo que documentaba la #11502 —que PostgreSQL tuviera que inferir el tipo de un parámetro
 * suelto— resuelto en vez de esquivado. La fecha se serializa aquí a ISO y no se deja al driver
 * dentro de una plantilla cruda, donde ya no pasa por el mapeador tipado de la columna.
 */
function despuesDelCursor(c: Cursor): SQL {
  // El alias es solo para que la tupla quepa en una línea: un salto dentro de la plantilla acaba
  // DENTRO del SQL, y con él en cada aserción que compare la consulta.
  const t = flitoComparendosRegistros;
  return sql`(${t.createdAt}, ${t.id}) < (${c.createdAt.toISOString()}::timestamptz, ${c.id}::uuid)`;
}

// ─────────────────────────────── Listado (CF-09) ────────────────────────────────────────────────

/**
 * El filtro que ya está validado. Es el compartido, con `limit` obligatorio: la ruta siempre lo
 * resuelve —por el parámetro o por el defecto—, así que aquí no hay «sin límite» que contemplar.
 *
 * `nit` y `placa` llegan del cuerpo de `POST /registros/buscar` y el resto de la query; este
 * archivo no distingue entre los dos orígenes ni tiene por qué (RN-33).
 */
export interface FiltroRegistros extends ComparendosRegistrosFiltro {
  limit: number;
}

/** `%` y `_` son comodines de LIKE: sin escaparlos, `q=%` devolvería la tabla entera. */
function escaparLike(valor: string): string {
  return valor.replace(/[%_\\]/g, '\\$&');
}

/**
 * Traduce el filtro ya validado a condiciones `WHERE`.
 *
 * Está aparte de {@link listarRegistros} desde la HU #11558 porque el export a Excel consulta
 * EXACTAMENTE el mismo conjunto —«lo que el visor está mostrando», sin paginar— y dos copias de este
 * armado serían dos definiciones de qué significa cada filtro: el día que una cambie, el archivo
 * dejaría de contener lo que la pantalla enseña y nadie lo notaría hasta que un cliente comparase.
 * El export no manda `cursor` ni `limit`, así que la rama del cursor simplemente no entra.
 *
 * Devuelve `null` —y no una lista vacía de condiciones, que sería «sin filtros»— cuando el filtro no
 * PUEDE casar con nada: una placa que al normalizar no deja ni un alfanumérico. La diferencia
 * importa, porque confundirlas devolvería la tabla entera a quien pidió un vehículo concreto.
 */
export function condicionesDeFiltro(filtro: ComparendosRegistrosFiltro): SQL[] | null {
  const condiciones: SQL[] = [];

  if (filtro.estado !== undefined) {
    condiciones.push(eq(flitoComparendosRegistros.estado, filtro.estado));
  }
  if (filtro.municipio !== undefined) {
    // El mismo normalizador del catálogo (RN-36): lo guardado es el `codigoFuente` con el que se le
    // preguntó al proveedor —mayúsculas y sin tildes—, así que «Itagüí» tiene que encontrar
    // «ITAGUI». Se normaliza aquí aunque la ruta ya lo haya hecho: el normalizador es idempotente y
    // este servicio no puede depender de que su llamador se acuerde.
    condiciones.push(eq(flitoComparendosRegistros.municipioFuente, normalizarCodigoFuente(filtro.municipio)));
  }
  if (filtro.fuente !== undefined) {
    // `origen_merge`, que es «qué fuentes lo han visto» y no «de qué municipio es» (CF-08). Lo
    // calcula el merge y por eso el filtro es por igualdad contra el enum, sin traducción.
    condiciones.push(eq(flitoComparendosRegistros.origenMerge, filtro.fuente));
  }
  if (filtro.causalId !== undefined) {
    condiciones.push(eq(flitoComparendosRegistros.causalId, filtro.causalId));
  }
  if (filtro.sinCausal === true) {
    // La cola de trabajo de la pantalla de gestión: lo que falta por clasificar. `IS NULL` y no una
    // igualdad contra vacío —la columna es `uuid`—, y solo con `=== true` para que `sinCausal=false`
    // signifique «no filtres por causal» y no «los que SÍ tienen una», que es otra pregunta y
    // tendría que pedirse de otra forma.
    condiciones.push(isNull(flitoComparendosRegistros.causalId));
  }
  if (filtro.nit !== undefined) {
    // El mismo normalizador del catálogo: lo guardado son NITs sin puntos ni espacios, así que
    // «900.123.456» tiene que encontrar lo que se guardó como «900123456» (RN-33).
    condiciones.push(eq(flitoComparendosRegistros.nitMonitoreado, normalizarNit(filtro.nit)));
  }
  if (filtro.placa !== undefined) {
    const placa = placaCanonica(filtro.placa);
    // Una placa que al normalizar no deja ni un alfanumérico no puede coincidir con nada: el filtro
    // es imposible, no inexistente (ver la nota de `null` en la cabecera).
    if (placa === null) return null;
    condiciones.push(eq(flitoComparendosRegistros.placa, placa));
  }
  if (filtro.q !== undefined) {
    // `like` y no `ilike`: el número se guarda ya normalizado en mayúsculas (`numeroCanonico`), así
    // que basta con subir la búsqueda y se evita el `lower()` sobre la columna en cada fila.
    //
    // Es una búsqueda por CONTENIDO (`%q%`) porque el número que un operador tiene a mano suele ser
    // el que aparece en un correo o en una foto, con el prefijo del organismo por delante o sin él.
    // El precio es que el único de `numero_comparendo` no sirve para esta consulta; con el volumen
    // de 17a no compensa un índice de trigramas, que sería la solución si algún día pesa.
    const escrito = filtro.q.trim().toUpperCase();
    // HU #11806, y es la mitad que se olvida: la búsqueda es por contenido, así que normalizar solo
    // lo GUARDADO no basta. Quien copie `D05001000000054652201` del portal de Medellín teclea algo
    // MÁS LARGO que la fila, y `%D05001…%` no casa con `05001…` por mucho que la fila exista. Se
    // pasa por el MISMO `numeroCanonico` del merge —no por una copia— justamente por lo que dice su
    // docblock: dos implementaciones parecidas se separan y el filtro deja de encontrar filas.
    //
    // Y solo se sustituye si la función cambió algo, que con la entrada ya recortada y en mayúsculas
    // significa una de dos: la forma nacional prefijada, o espacios internos. Las dos son
    // sustituciones seguras porque lo guardado no puede tener ni prefijo ni espacios. Una `q`
    // PARCIAL —los tres caracteres del mínimo, un trozo del número— sale igual que entró, y si
    // `numeroCanonico` devolviera `null` (una `q` de más de 60) tampoco se toca: el filtro sigue
    // siendo el literal del operador y no una búsqueda que nadie pidió.
    const canonico = numeroCanonico(escrito);
    const buscado = canonico !== null && canonico !== escrito ? canonico : escrito;
    condiciones.push(like(
      flitoComparendosRegistros.numeroComparendo,
      `%${escaparLike(buscado)}%`,
    ));
  }
  if (filtro.cursor !== undefined) {
    condiciones.push(despuesDelCursor(decodificarCursor(filtro.cursor)));
  }

  return condiciones;
}

/**
 * Página de registros consolidados, del alta más reciente a la más antigua.
 *
 * Se piden `limit + 1` filas y la sobrante no se devuelve: es lo que permite saber si hay más
 * páginas sin un `count(*)` sobre el filtro —que en esta tabla es la consulta cara— y sin dejar al
 * cliente pidiendo una última página vacía para descubrir que se acabó.
 */
export async function listarRegistros(filtro: FiltroRegistros): Promise<ComparendosRegistrosPagina> {
  const condiciones = condicionesDeFiltro(filtro);
  if (condiciones === null) return { items: [], nextCursor: null };

  const filas = await db.select(SELECCION_REGISTRO)
    .from(flitoComparendosRegistros)
    // El autor de la gestión (RN-46). No multiplica filas —casa por la clave primaria de `users`—,
    // así que el `limit + 1` de abajo sigue significando lo mismo.
    .leftJoin(users, JOIN_AUTOR_GESTION)
    .where(condiciones.length === 0 ? undefined : and(...condiciones))
    .orderBy(desc(flitoComparendosRegistros.createdAt), desc(flitoComparendosRegistros.id))
    .limit(filtro.limit + 1);

  const hayMas = filas.length > filtro.limit;
  const pagina = hayMas ? filas.slice(0, filtro.limit) : filas;
  const ultimo = pagina.at(-1);

  return {
    items: pagina.map(registroDto),
    nextCursor: hayMas && ultimo ? codificarCursor(ultimo.createdAt, ultimo.id) : null,
  };
}

// ─────────────────────────────── Detalle y timeline (CF-11) ─────────────────────────────────────

/**
 * Quién ejecuta la consulta: la conexión de siempre o una transacción en curso.
 *
 * Existe para que la escritura de la gestión (HU #11557) pueda construir su respuesta DENTRO de su
 * propia transacción, con este mismo código y sin una segunda copia de la proyección. Leer fuera
 * dejaba una ventana real: entre el COMMIT y la lectura cabe la purga por retención, y el endpoint
 * habría respondido 404 con el cambio ya escrito y sin llegar a dejar sus dos rastros.
 *
 * Por defecto es `db`, así que las tres lecturas del módulo no cambian en nada.
 */
type Ejecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Timeline de un registro, del evento más reciente al más antiguo. */
async function eventosDe(registroId: string, ejecutor: Ejecutor = db): Promise<ComparendoEvento[]> {
  const filas = await ejecutor.select().from(flitoComparendosEventos)
    .where(eq(flitoComparendosEventos.registroId, registroId))
    // El desempate por `id` no es cosmético: los eventos de una misma corrida se insertan en un
    // único statement y comparten `created_at`, así que sin él su orden sería el que quisiera
    // PostgreSQL y el timeline bailaría entre dos peticiones idénticas.
    .orderBy(desc(flitoComparendosEventos.createdAt), desc(flitoComparendosEventos.id));
  return filas.map(eventoDto);
}

/**
 * Un registro con su timeline.
 *
 * @param ejecutor Transacción en curso, cuando quien lee es el mismo que acaba de escribir: así ve
 *                 sus propios cambios y no hay ventana entre el COMMIT y la lectura. Por defecto,
 *                 `db`.
 * @throws ComparendosNoEncontradoError si el id no existe (la ruta lo traduce a 404).
 */
export async function obtenerRegistro(
  id: string,
  ejecutor: Ejecutor = db,
): Promise<ComparendoRegistroDetalle> {
  const [fila] = await ejecutor.select(SELECCION_REGISTRO)
    .from(flitoComparendosRegistros)
    // Misma proyección y mismo join que el listado (RN-46): las dos superficies que devuelven un
    // registro tienen que devolver la misma forma, y el PATCH de gestión construye su respuesta con
    // esta lectura.
    .leftJoin(users, JOIN_AUTOR_GESTION)
    .where(eq(flitoComparendosRegistros.id, id))
    .limit(1);
  if (!fila) throw new ComparendosNoEncontradoError('El comparendo no existe.');

  return { ...registroDto(fila), eventos: await eventosDe(id, ejecutor) };
}

/**
 * Timeline suelto, para refrescarlo sin volver a traer el registro entero.
 *
 * Comprueba primero que el registro EXISTE en vez de devolver la lista vacía que daría la consulta
 * de eventos: una lista vacía es una respuesta legítima —un registro recién dado de alta puede no
 * tener eventos si su `primera_llegada` se perdió— y confundirla con «ese comparendo no existe»
 * dejaría a la pantalla sin poder distinguir un id equivocado de un timeline sin nada.
 *
 * @throws ComparendosNoEncontradoError si el id no existe.
 */
export async function listarEventos(registroId: string): Promise<ComparendoEvento[]> {
  const [fila] = await db.select({ id: flitoComparendosRegistros.id })
    .from(flitoComparendosRegistros)
    .where(eq(flitoComparendosRegistros.id, registroId))
    .limit(1);
  if (!fila) throw new ComparendosNoEncontradoError('El comparendo no existe.');

  return eventosDe(registroId);
}
