// FLITO — tarifas negociadas por compañía gestora (HU #10963, Feature #10939 §2.1 y §2.2).
//
// Sustituye a `COSTOS_FIJOS.tramiteDigital` y `COSTOS_FIJOS.logistica`, constantes iguales para
// todos los clientes. Solo cubre los conceptos que SE NEGOCIAN: el SOAT, el impuesto y el derecho
// de trámite son desembolsos reales y se leen del documento pagado, no de una tabla de precios.

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  CONCEPTOS_TARIFA, normalizarTipoTramite, type ConceptoTarifa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoTarifasCompania } from '../../db/schema.js';

export class TarifaError extends Error {}

export interface Tarifa {
  id: string;
  companiaId: number;
  companiaNombre: string | null;
  concepto: ConceptoTarifa;
  /** null = tarifa genérica del concepto. */
  tipoTramite: string | null;
  valor: number;
  activo: boolean;
  actualizadoEn: string;
}

/**
 * Valor de un concepto para un trámite concreto.
 *
 * `valor: null` significa **«No configurado»**, no «gratis». La distinción es el punto entero del
 * requerimiento §2.1: un concepto sin tarifa debe verse como tal en reportes y vistas operativas,
 * y nunca sumar un cero silencioso que haría cuadrar un total falso.
 */
export interface ValorTarifa {
  valor: number | null;
  /** De dónde salió: la tarifa del tipo exacto, la genérica, o ninguna. */
  origen: 'especifica' | 'generica' | 'no_configurada';
}

export const NO_CONFIGURADA: ValorTarifa = { valor: null, origen: 'no_configurada' };

/**
 * Resuelve la tarifa aplicable: primero la del tipo de trámite exacto, y si no existe, la genérica
 * (`tipo_tramite IS NULL`). Las inactivas no cuentan: desactivar una tarifa debe hacer que el
 * concepto vuelva a estar «no configurado», no que caiga a un valor viejo.
 */
export async function tarifaDe(
  companiaId: number | null, concepto: ConceptoTarifa, tipoTramite: string | null,
): Promise<ValorTarifa> {
  if (companiaId === null) return NO_CONFIGURADA;
  const tipo = normalizarTipoTramite(tipoTramite);

  const filas = await db.select({ tipoTramite: flitoTarifasCompania.tipoTramite, valor: flitoTarifasCompania.valor })
    .from(flitoTarifasCompania)
    .where(and(
      eq(flitoTarifasCompania.companiaId, companiaId),
      eq(flitoTarifasCompania.concepto, concepto),
      eq(flitoTarifasCompania.activo, true),
      // Solo las dos que pueden aplicar: la del tipo exacto y la genérica.
      tipo === null
        ? isNull(flitoTarifasCompania.tipoTramite)
        : sql`(${flitoTarifasCompania.tipoTramite} = ${tipo} OR ${flitoTarifasCompania.tipoTramite} IS NULL)`,
    ));

  const especifica = tipo === null ? undefined : filas.find((f) => f.tipoTramite === tipo);
  if (especifica) return { valor: Number(especifica.valor), origen: 'especifica' };
  const generica = filas.find((f) => f.tipoTramite === null);
  if (generica) return { valor: Number(generica.valor), origen: 'generica' };
  return NO_CONFIGURADA;
}

/** Todas las tarifas, con el nombre de su compañía. Orden estable para la pantalla de administración. */
export async function listarTarifas(companiaId?: number): Promise<Tarifa[]> {
  const filas = await db.select({
    id: flitoTarifasCompania.id, companiaId: flitoTarifasCompania.companiaId,
    companiaNombre: clients.name, concepto: flitoTarifasCompania.concepto,
    tipoTramite: flitoTarifasCompania.tipoTramite, valor: flitoTarifasCompania.valor,
    activo: flitoTarifasCompania.activo, actualizadoEn: flitoTarifasCompania.updatedAt,
  }).from(flitoTarifasCompania)
    .leftJoin(clients, eq(flitoTarifasCompania.companiaId, clients.id))
    .where(companiaId ? eq(flitoTarifasCompania.companiaId, companiaId) : undefined)
    .orderBy(asc(clients.name), asc(flitoTarifasCompania.concepto), asc(flitoTarifasCompania.tipoTramite));

  return filas.map((f) => ({
    id: f.id, companiaId: f.companiaId, companiaNombre: f.companiaNombre,
    concepto: f.concepto as ConceptoTarifa, tipoTramite: f.tipoTramite,
    valor: Number(f.valor), activo: f.activo, actualizadoEn: f.actualizadoEn.toISOString(),
  }));
}

export interface DatosTarifa {
  companiaId: number;
  concepto: ConceptoTarifa;
  tipoTramite?: string | null;
  valor: number;
  activo?: boolean;
}

function validar(d: DatosTarifa): void {
  if (!CONCEPTOS_TARIFA.includes(d.concepto)) throw new TarifaError('Concepto de tarifa desconocido');
  if (!Number.isFinite(d.valor) || d.valor < 0) throw new TarifaError('El valor debe ser un número mayor o igual a cero');
}

/** Alta de tarifa. La combinación compañía + concepto + tipo es única (la impone el índice). */
export async function crearTarifa(d: DatosTarifa, usuarioId: number | null): Promise<Tarifa> {
  validar(d);
  const tipo = normalizarTipoTramite(d.tipoTramite);

  const [compania] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, d.companiaId)).limit(1);
  if (!compania) throw new TarifaError('La compañía no existe');

  try {
    const [fila] = await db.insert(flitoTarifasCompania).values({
      companiaId: d.companiaId, concepto: d.concepto, tipoTramite: tipo,
      valor: String(d.valor), activo: d.activo ?? true, actualizadoPorId: usuarioId,
    }).returning({ id: flitoTarifasCompania.id });
    const [creada] = await listarTarifasPorId(fila.id);
    return creada;
  } catch (e) {
    // 23505 = unique_violation. Se traduce a un mensaje que dice qué hacer, no el error de Postgres.
    if ((e as { code?: string }).code === '23505') {
      throw new TarifaError('Ya existe una tarifa para esa compañía, concepto y tipo de trámite. Edítala en vez de crear otra.');
    }
    throw e;
  }
}

/** Cambio de valor o de estado. No se permite mover la llave (compañía/concepto/tipo): eso es otra tarifa. */
export async function actualizarTarifa(
  id: string, cambios: { valor?: number; activo?: boolean }, usuarioId: number | null,
): Promise<Tarifa> {
  if (cambios.valor !== undefined && (!Number.isFinite(cambios.valor) || cambios.valor < 0)) {
    throw new TarifaError('El valor debe ser un número mayor o igual a cero');
  }
  const [fila] = await db.update(flitoTarifasCompania).set({
    ...(cambios.valor !== undefined ? { valor: String(cambios.valor) } : {}),
    ...(cambios.activo !== undefined ? { activo: cambios.activo } : {}),
    actualizadoPorId: usuarioId, updatedAt: new Date(),
  }).where(eq(flitoTarifasCompania.id, id)).returning({ id: flitoTarifasCompania.id });
  if (!fila) throw new TarifaError('La tarifa no existe');
  const [actualizada] = await listarTarifasPorId(fila.id);
  return actualizada;
}

export async function eliminarTarifa(id: string): Promise<void> {
  const filas = await db.delete(flitoTarifasCompania).where(eq(flitoTarifasCompania.id, id))
    .returning({ id: flitoTarifasCompania.id });
  if (filas.length === 0) throw new TarifaError('La tarifa no existe');
}

async function listarTarifasPorId(id: string): Promise<Tarifa[]> {
  const filas = await db.select({
    id: flitoTarifasCompania.id, companiaId: flitoTarifasCompania.companiaId,
    companiaNombre: clients.name, concepto: flitoTarifasCompania.concepto,
    tipoTramite: flitoTarifasCompania.tipoTramite, valor: flitoTarifasCompania.valor,
    activo: flitoTarifasCompania.activo, actualizadoEn: flitoTarifasCompania.updatedAt,
  }).from(flitoTarifasCompania)
    .leftJoin(clients, eq(flitoTarifasCompania.companiaId, clients.id))
    .where(eq(flitoTarifasCompania.id, id)).limit(1);

  return filas.map((f) => ({
    id: f.id, companiaId: f.companiaId, companiaNombre: f.companiaNombre,
    concepto: f.concepto as ConceptoTarifa, tipoTramite: f.tipoTramite,
    valor: Number(f.valor), activo: f.activo, actualizadoEn: f.actualizadoEn.toISOString(),
  }));
}
