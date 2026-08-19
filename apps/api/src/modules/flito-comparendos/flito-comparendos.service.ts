// FLITO comparendos — catálogos de parametrización (Feature #11492 17a, HU #11497).
//
// Los tres catálogos que deciden QUÉ se sincroniza y CÓMO se clasifica lo que llegue: los NITs que
// se monitorean, los municipios que se le preguntan a UTS y las causales con las que 17b gestionará
// cada comparendo. Aquí no se consulta a ningún proveedor ni se escribe un solo registro de
// comparendo: eso es de las HUs #11498–#11500.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Un NIT aparece UNA vez en el catálogo. Dos filas con el mismo NIT harían que cada corrida
//        lo consultara dos veces —el doble de cuota gastada contra Verifik— y dejarían la
//        inactivación indecidible: dos filas pueden estar una activa y otra no.
//
// RN-02  El NIT no se edita. Es la llave con la que se le preguntó al proveedor y con la que quedó
//        marcado cada comparendo traído (`registros.nit_monitoreado`, que no es una FK sino el dato
//        tal cual se consultó). Cambiarlo reescribiría la pregunta dejando intactas las respuestas.
//        Para dejar de monitorear un NIT se desactiva; para monitorear otro se crea otra fila.
//
// RN-03  `codigoFuente` es un valor de TRANSPORTE, no una etiqueta: viaja literal en `?fuente=` a
//        UTS. Se normaliza a mayúsculas sin tildes al crearlo —el seed de la 0150 usa esa forma— y
//        tampoco se edita después, porque cambiarlo re-apuntaría la sincronización a otro municipio
//        conservando el histórico del anterior. Lo que sí se edita es `nombre`, que es lo que lee un
//        humano, y `activo`, que es lo que decide si se le pregunta.
//
// RN-04  Los datos de fuente son inmutables desde el API. Este módulo solo LEE
//        `flito_comparendos_registros` —y únicamente para contar, al decidir si un NIT se puede
//        borrar—: quien los escribe es el sync.
//
// RN-05  Borrar un NIT es SOFT (`activo=false`). El borrado duro solo se admite si nunca trajo
//        comparendos; con histórico detrás se rechaza (409 `nit_en_uso`).
//
// RN-06  El nombre de una causal es único SIN distinguir mayúsculas ni espacios de sobra.
//        «Registrado» y «registrado» son la misma causal escrita por dos personas distintas, y dos
//        filas para lo mismo parten en dos cualquier conteo que 17b haga por causal.

import { asc, eq, ne, sql } from 'drizzle-orm';
import type {
  ComparendosCausal,
  ComparendosMunicipio,
  ComparendosNit,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoComparendosCausales,
  flitoComparendosMunicipios,
  flitoComparendosNits,
  flitoComparendosRegistros,
} from '../../db/schema.js';
import {
  ComparendosDuplicadoError,
  ComparendosNitEnUsoError,
  ComparendosNoEncontradoError,
  esViolacionDeUnicidad,
} from './flito-comparendos.errors.js';

type FilaNit = typeof flitoComparendosNits.$inferSelect;
type FilaMunicipio = typeof flitoComparendosMunicipios.$inferSelect;
type FilaCausal = typeof flitoComparendosCausales.$inferSelect;

// ─────────────────────────────── Normalización de llaves ────────────────────────────────────────

/**
 * NIT tal como se va a guardar y a preguntar (RN-01, RN-02).
 *
 * Se quitan puntos y espacios porque es lo que trae un NIT copiado de un RUT («900.123.456») y
 * porque esos caracteres no significan nada para el proveedor: dejarlos pasar guardaría dos filas
 * distintas para la misma empresa y ninguna de las dos consultaría bien.
 *
 * NO se exige que sean solo dígitos ni se separa el dígito de verificación: hay NITs que se
 * consultan con DV y otros sin él, y qué espera cada proveedor se cierra en el spike de
 * homologación (#11501). Hasta entonces, lo que escriba quien parametriza es lo que viaja.
 */
export function normalizarNit(valor: string): string {
  return valor.replace(/[\s.]/g, '');
}

/**
 * Código de fuente tal como lo espera UTS (RN-03).
 *
 * Mayúsculas y sin tildes, que es la forma de los ocho municipios que sembró la 0150 (BELLO,
 * ITAGUI, MEDELLIN…). El pliegue de acentos es deliberado: escribir «Itagüí» aquí crearía un
 * municipio que el proveedor no reconoce, y el fallo aparecería mucho después, en una corrida de
 * sync, como un municipio que «no devuelve nada». Que el nombre bonito viva en `nombre` es
 * justamente para poder aplastar este.
 */
export function normalizarCodigoFuente(valor: string): string {
  return valor
    .normalize('NFD')
    // Marcas diacríticas combinantes que deja sueltas el NFD, escritas como escape: en literal son
    // caracteres invisibles que cualquier editor puede comerse sin que nadie lo note.
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

/** Texto opcional: se recorta y el vacío se guarda como ausencia, no como cadena vacía. */
function textoOpcional(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

// ─────────────────────────────── Proyecciones al contrato público ───────────────────────────────

function nitDto(f: FilaNit): ComparendosNit {
  return {
    id: f.id,
    nit: f.nit,
    alias: f.alias,
    activo: f.activo,
    creadoEn: f.createdAt.toISOString(),
    actualizadoEn: f.updatedAt.toISOString(),
  };
}

function municipioDto(f: FilaMunicipio): ComparendosMunicipio {
  return {
    id: f.id,
    codigoFuente: f.codigoFuente,
    nombre: f.nombre,
    activo: f.activo,
    creadoEn: f.createdAt.toISOString(),
    actualizadoEn: f.updatedAt.toISOString(),
  };
}

function causalDto(f: FilaCausal): ComparendosCausal {
  return {
    id: f.id,
    nombre: f.nombre,
    activo: f.activo,
    orden: f.orden,
    creadoEn: f.createdAt.toISOString(),
    actualizadoEn: f.updatedAt.toISOString(),
  };
}

// ─────────────────────────────── NITs monitoreados (CF-01) ──────────────────────────────────────

export interface CrearNitDatos {
  nit: string;
  alias?: string | null;
  activo?: boolean;
}

export interface ActualizarNitDatos {
  alias?: string | null;
  activo?: boolean;
}

/**
 * Todos los NITs, activos e inactivos.
 *
 * Sin filtro de `activo` a propósito: la pantalla de parametrización necesita ver los apagados para
 * poder volver a encenderlos. Quien sincroniza filtra por su cuenta.
 */
export async function listarNits(): Promise<ComparendosNit[]> {
  const filas = await db.select().from(flitoComparendosNits).orderBy(asc(flitoComparendosNits.nit));
  return filas.map(nitDto);
}

export async function crearNit(datos: CrearNitDatos, actorId: number | null): Promise<ComparendosNit> {
  const nit = normalizarNit(datos.nit);

  const [existente] = await db.select({ id: flitoComparendosNits.id })
    .from(flitoComparendosNits)
    .where(eq(flitoComparendosNits.nit, nit))
    .limit(1);
  if (existente) throw new ComparendosDuplicadoError('nit_duplicado', `El NIT ${nit} ya está en el catálogo de monitoreo.`);

  try {
    const [creado] = await db.insert(flitoComparendosNits).values({
      nit,
      alias: textoOpcional(datos.alias),
      ...(datos.activo === undefined ? {} : { activo: datos.activo }),
      createdBy: actorId,
      updatedBy: actorId,
    }).returning();
    return nitDto(creado);
  } catch (e) {
    if (esViolacionDeUnicidad(e)) throw new ComparendosDuplicadoError('nit_duplicado', `El NIT ${nit} ya está en el catálogo de monitoreo.`);
    throw e;
  }
}

/** Solo `alias` y `activo`: el NIT no se edita (RN-02). */
export async function actualizarNit(
  id: string, cambios: ActualizarNitDatos, actorId: number | null,
): Promise<ComparendosNit> {
  const set: Partial<typeof flitoComparendosNits.$inferInsert> = { updatedAt: new Date(), updatedBy: actorId };
  if (cambios.alias !== undefined) set.alias = textoOpcional(cambios.alias);
  if (cambios.activo !== undefined) set.activo = cambios.activo;

  const [actualizado] = await db.update(flitoComparendosNits).set(set)
    .where(eq(flitoComparendosNits.id, id))
    .returning();
  if (!actualizado) throw new ComparendosNoEncontradoError('El NIT no existe en el catálogo de monitoreo.');
  return nitDto(actualizado);
}

/**
 * Borrado duro, permitido solo mientras el NIT no haya traído nada (RN-05).
 *
 * Devuelve la fila borrada para que la ruta pueda dejar en la bitácora QUÉ se borró: después del
 * DELETE no hay dónde ir a buscarlo.
 */
export async function eliminarNit(id: string): Promise<ComparendosNit> {
  const [fila] = await db.select().from(flitoComparendosNits)
    .where(eq(flitoComparendosNits.id, id))
    .limit(1);
  if (!fila) throw new ComparendosNoEncontradoError('El NIT no existe en el catálogo de monitoreo.');

  // `nit_monitoreado` guarda el NIT tal cual se consultó, no una FK: se cuenta por valor.
  const [conteo] = await db.select({ total: sql<number>`count(*)::int` })
    .from(flitoComparendosRegistros)
    .where(eq(flitoComparendosRegistros.nitMonitoreado, fila.nit));
  const total = Number(conteo?.total ?? 0);
  if (total > 0) throw new ComparendosNitEnUsoError(total);

  await db.delete(flitoComparendosNits).where(eq(flitoComparendosNits.id, id));
  return nitDto(fila);
}

// ─────────────────────────────── Municipios fuente (CF-02) ──────────────────────────────────────

export interface CrearMunicipioDatos {
  codigoFuente: string;
  nombre?: string;
  activo?: boolean;
}

export interface ActualizarMunicipioDatos {
  nombre?: string;
  activo?: boolean;
}

export async function listarMunicipios(): Promise<ComparendosMunicipio[]> {
  const filas = await db.select().from(flitoComparendosMunicipios)
    .orderBy(asc(flitoComparendosMunicipios.nombre));
  return filas.map(municipioDto);
}

export async function crearMunicipio(datos: CrearMunicipioDatos): Promise<ComparendosMunicipio> {
  const codigoFuente = normalizarCodigoFuente(datos.codigoFuente);
  // Sin nombre se usa el propio código. La columna es NOT NULL y un municipio sin etiqueta es
  // preferible a rechazar el alta por un campo que el AC marca opcional; renombrarlo es un PATCH.
  const nombre = textoOpcional(datos.nombre) ?? codigoFuente;

  const [existente] = await db.select({ id: flitoComparendosMunicipios.id })
    .from(flitoComparendosMunicipios)
    .where(eq(flitoComparendosMunicipios.codigoFuente, codigoFuente))
    .limit(1);
  if (existente) throw new ComparendosDuplicadoError('municipio_duplicado', `El municipio ${codigoFuente} ya está en el catálogo.`);

  try {
    const [creado] = await db.insert(flitoComparendosMunicipios).values({
      codigoFuente,
      nombre,
      ...(datos.activo === undefined ? {} : { activo: datos.activo }),
    }).returning();
    return municipioDto(creado);
  } catch (e) {
    if (esViolacionDeUnicidad(e)) throw new ComparendosDuplicadoError('municipio_duplicado', `El municipio ${codigoFuente} ya está en el catálogo.`);
    throw e;
  }
}

/** Solo `nombre` y `activo`: el código de fuente no se edita (RN-03). */
export async function actualizarMunicipio(
  id: string, cambios: ActualizarMunicipioDatos,
): Promise<ComparendosMunicipio> {
  const set: Partial<typeof flitoComparendosMunicipios.$inferInsert> = { updatedAt: new Date() };
  if (cambios.nombre !== undefined) set.nombre = cambios.nombre.trim();
  if (cambios.activo !== undefined) set.activo = cambios.activo;

  const [actualizado] = await db.update(flitoComparendosMunicipios).set(set)
    .where(eq(flitoComparendosMunicipios.id, id))
    .returning();
  if (!actualizado) throw new ComparendosNoEncontradoError('El municipio no existe en el catálogo.');
  return municipioDto(actualizado);
}

// ─────────────────────────────── Causales de gestión (CF-04) ────────────────────────────────────

export interface CrearCausalDatos {
  nombre: string;
  activo?: boolean;
  orden?: number;
}

export interface ActualizarCausalDatos {
  nombre?: string;
  activo?: boolean;
  orden?: number;
}

/** Por `orden` y, a igualdad, por nombre: sin el desempate el listado bailaría entre peticiones. */
export async function listarCausales(): Promise<ComparendosCausal[]> {
  const filas = await db.select().from(flitoComparendosCausales)
    .orderBy(asc(flitoComparendosCausales.orden), asc(flitoComparendosCausales.nombre));
  return filas.map(causalDto);
}

/**
 * ¿Hay ya una causal con ese nombre? (RN-06)
 *
 * `lower(...)` en los dos lados vía `sql` parametrizado: la comparación es insensible a mayúsculas
 * aunque el índice único de la 0150 sea exacto. El índice sigue siendo la última palabra ante una
 * carrera; esto es lo que evita el duplicado «de verdad», el que se escribe distinto.
 *
 * `excluirId` sirve al PATCH: al renombrar, la propia fila no es un duplicado de sí misma.
 */
async function causalConNombre(nombre: string, excluirId?: string): Promise<boolean> {
  const filas = await db.select({ id: flitoComparendosCausales.id })
    .from(flitoComparendosCausales)
    .where(
      excluirId === undefined
        ? sql`lower(${flitoComparendosCausales.nombre}) = lower(${nombre})`
        : sql`lower(${flitoComparendosCausales.nombre}) = lower(${nombre}) AND ${ne(flitoComparendosCausales.id, excluirId)}`,
    )
    .limit(1);
  return filas.length > 0;
}

export async function crearCausal(datos: CrearCausalDatos): Promise<ComparendosCausal> {
  const nombre = datos.nombre.trim();
  if (await causalConNombre(nombre)) {
    throw new ComparendosDuplicadoError('causal_duplicada', `Ya existe una causal llamada "${nombre}".`);
  }

  try {
    const [creada] = await db.insert(flitoComparendosCausales).values({
      nombre,
      ...(datos.activo === undefined ? {} : { activo: datos.activo }),
      ...(datos.orden === undefined ? {} : { orden: datos.orden }),
    }).returning();
    return causalDto(creada);
  } catch (e) {
    if (esViolacionDeUnicidad(e)) throw new ComparendosDuplicadoError('causal_duplicada', `Ya existe una causal llamada "${nombre}".`);
    throw e;
  }
}

export async function actualizarCausal(
  id: string, cambios: ActualizarCausalDatos,
): Promise<ComparendosCausal> {
  const set: Partial<typeof flitoComparendosCausales.$inferInsert> = { updatedAt: new Date() };
  if (cambios.nombre !== undefined) {
    const nombre = cambios.nombre.trim();
    // El renombrado también choca contra el único: sin esto sería un 500 en vez del 409 que es.
    if (await causalConNombre(nombre, id)) {
      throw new ComparendosDuplicadoError('causal_duplicada', `Ya existe una causal llamada "${nombre}".`);
    }
    set.nombre = nombre;
  }
  if (cambios.activo !== undefined) set.activo = cambios.activo;
  if (cambios.orden !== undefined) set.orden = cambios.orden;

  try {
    const [actualizada] = await db.update(flitoComparendosCausales).set(set)
      .where(eq(flitoComparendosCausales.id, id))
      .returning();
    if (!actualizada) throw new ComparendosNoEncontradoError('La causal no existe en el catálogo.');
    return causalDto(actualizada);
  } catch (e) {
    if (esViolacionDeUnicidad(e)) {
      throw new ComparendosDuplicadoError('causal_duplicada', 'Ya existe una causal con ese nombre.');
    }
    throw e;
  }
}
