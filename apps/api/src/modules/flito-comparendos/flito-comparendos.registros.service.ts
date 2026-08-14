// FLITO comparendos — lectura del registro consolidado y de su timeline (Feature #11492 17a,
// HU #11502, CF-09/CF-11).
//
// Es el único archivo del módulo que LEE `flito_comparendos_registros` para devolvérselo a alguien.
// El sync los escribe (`flito-comparendos.sync.service.ts`), la purga los borra
// (`flito-comparendos-purga.cron.ts`) y aquí solo se consultan: **no hay ni un INSERT, ni un UPDATE,
// ni un DELETE en este archivo**, y eso es el CF-09 en su forma más literal — los campos de fuente
// no se editan desde el API (RN-04).
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

import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import type {
  ComparendoEvento,
  ComparendoRegistro,
  ComparendoRegistroDetalle,
  ComparendosRegistrosFiltro,
  ComparendosRegistrosPagina,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComparendosEventos, flitoComparendosRegistros } from '../../db/schema.js';
import {
  ComparendosCursorInvalidoError,
  ComparendosNoEncontradoError,
} from './flito-comparendos.errors.js';
import { placaCanonica } from './flito-comparendos-merge.js';
import { normalizarNit } from './flito-comparendos.service.js';

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
  createdAt: flitoComparendosRegistros.createdAt,
  updatedAt: flitoComparendosRegistros.updatedAt,
} as const;

type FilaRegistro = {
  [K in keyof typeof COLUMNAS_REGISTRO]: (typeof flitoComparendosRegistros.$inferSelect)[K]
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
 * Se escribe como `or(lt, and(eq, lt))` y no como la comparación de tuplas `(a,b) < (x,y)` porque
 * así lo construye drizzle con sus propios parámetros tipados: la tupla obligaría a `sql` crudo y a
 * confiar en que PostgreSQL infiera `timestamptz` y `uuid` de dos parámetros sin tipo.
 */
function despuesDelCursor(c: Cursor): SQL {
  return or(
    lt(flitoComparendosRegistros.createdAt, c.createdAt),
    and(
      eq(flitoComparendosRegistros.createdAt, c.createdAt),
      lt(flitoComparendosRegistros.id, c.id),
    ),
  )!;
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
 * Página de registros consolidados, del alta más reciente a la más antigua.
 *
 * Se piden `limit + 1` filas y la sobrante no se devuelve: es lo que permite saber si hay más
 * páginas sin un `count(*)` sobre el filtro —que en esta tabla es la consulta cara— y sin dejar al
 * cliente pidiendo una última página vacía para descubrir que se acabó.
 */
export async function listarRegistros(filtro: FiltroRegistros): Promise<ComparendosRegistrosPagina> {
  const condiciones: SQL[] = [];

  if (filtro.estado !== undefined) {
    condiciones.push(eq(flitoComparendosRegistros.estado, filtro.estado));
  }
  if (filtro.nit !== undefined) {
    // El mismo normalizador del catálogo: lo guardado son NITs sin puntos ni espacios, así que
    // «900.123.456» tiene que encontrar lo que se guardó como «900123456» (RN-33).
    condiciones.push(eq(flitoComparendosRegistros.nitMonitoreado, normalizarNit(filtro.nit)));
  }
  if (filtro.placa !== undefined) {
    const placa = placaCanonica(filtro.placa);
    // Una placa que al normalizar no deja ni un alfanumérico no puede coincidir con nada. Se
    // responde una página vacía en vez de IGNORAR el filtro: ignorarlo devolvería la lista completa
    // a quien pidió un vehículo concreto.
    if (placa === null) return { items: [], nextCursor: null };
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
    condiciones.push(like(
      flitoComparendosRegistros.numeroComparendo,
      `%${escaparLike(filtro.q.trim().toUpperCase())}%`,
    ));
  }
  if (filtro.cursor !== undefined) {
    condiciones.push(despuesDelCursor(decodificarCursor(filtro.cursor)));
  }

  const filas = await db.select(COLUMNAS_REGISTRO)
    .from(flitoComparendosRegistros)
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

/** Timeline de un registro, del evento más reciente al más antiguo. */
async function eventosDe(registroId: string): Promise<ComparendoEvento[]> {
  const filas = await db.select().from(flitoComparendosEventos)
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
 * @throws ComparendosNoEncontradoError si el id no existe (la ruta lo traduce a 404).
 */
export async function obtenerRegistro(id: string): Promise<ComparendoRegistroDetalle> {
  const [fila] = await db.select(COLUMNAS_REGISTRO)
    .from(flitoComparendosRegistros)
    .where(eq(flitoComparendosRegistros.id, id))
    .limit(1);
  if (!fila) throw new ComparendosNoEncontradoError('El comparendo no existe.');

  return { ...registroDto(fila), eventos: await eventosDe(id) };
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
