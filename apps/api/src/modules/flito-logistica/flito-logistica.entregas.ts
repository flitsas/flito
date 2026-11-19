// HU #14125 — pestaña Entregas. Lectura de todos los viajes, sin alcance de mensajero ni de compañía.
// La placa solo filtra (igualdad de `normPlaca`); no sale en el DTO. Sin migración.

import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  CompaniaConViajeLogistica, DestinoTrasladoLogistica, EstadoTrasladoLogistica,
  FilaEntregaLogistica, ListadoEntregasLogistica,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoLogisticaDocumentos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados, vehicles,
} from '../../db/schema.js';
import { normPlaca } from './flito-logistica.aprobado.js';

/** Tope del listado. El cliente no lo manda: se leen 201 y, si sobra una, `truncado`. */
export const TOPE_ENTREGAS = 200;

export interface FiltroEntregas {
  placa?: string;
  estado?: EstadoTrasladoLogistica;
  destino?: DestinoTrasladoLogistica;
  companiaId?: number;
}

/** `normPlaca(vehicles.plate)`: mayúsculas, sin espacios ni guiones. */
function placaIgual(placa: string): SQL {
  return sql`exists (
    select 1
    from ${flitoLogisticaTrasladoLts}
    inner join ${flitoLogisticaDocumentos}
      on ${flitoLogisticaDocumentos.id} = ${flitoLogisticaTrasladoLts.documentoId}
    inner join ${vehicles}
      on ${vehicles.id} = ${flitoLogisticaDocumentos.vehiculoId}
    where ${flitoLogisticaTrasladoLts.trasladoId} = ${flitoLogisticaTraslados.id}
      and upper(replace(replace(${vehicles.plate}, ' ', ''), '-', '')) = ${placa}
  )`;
}

/**
 * Todos los traslados (también `legado`), de todas las compañías. No filtra por mensajero.
 * `cantidadLt` cuenta todas las líneas del viaje (también devueltas y anuladas), en subselect
 * para no duplicar la fila. `companias` ignora los filtros del body.
 */
export async function listarEntregas(filtro: FiltroEntregas): Promise<ListadoEntregasLogistica> {
  const placa = filtro.placa !== undefined ? normPlaca(filtro.placa) : '';
  const condiciones: SQL[] = [];
  if (filtro.estado) condiciones.push(eq(flitoLogisticaTraslados.estado, filtro.estado));
  if (filtro.destino) condiciones.push(eq(flitoLogisticaTraslados.destino, filtro.destino));
  if (filtro.companiaId !== undefined) condiciones.push(eq(flitoLogisticaTraslados.companiaId, filtro.companiaId));
  if (placa) condiciones.push(placaIgual(placa));

  const viajesQ = db.select({
    id: flitoLogisticaTraslados.id,
    companiaId: flitoLogisticaTraslados.companiaId,
    companiaNombre: clients.name,
    destino: flitoLogisticaTraslados.destino,
    estado: flitoLogisticaTraslados.estado,
    cantidadLt: sql<number>`(select count(*)::int from ${flitoLogisticaTrasladoLts} where ${flitoLogisticaTrasladoLts.trasladoId} = ${flitoLogisticaTraslados.id})`,
    registradoEn: flitoLogisticaTraslados.registradoEn,
  }).from(flitoLogisticaTraslados)
    .leftJoin(clients, eq(clients.id, flitoLogisticaTraslados.companiaId))
    .$dynamic();
  if (condiciones.length > 0) viajesQ.where(and(...condiciones)!);

  const filas = await viajesQ
    .orderBy(desc(flitoLogisticaTraslados.registradoEn), desc(flitoLogisticaTraslados.id))
    .limit(TOPE_ENTREGAS + 1);

  const companias = await db.selectDistinct({
    companiaId: flitoLogisticaTraslados.companiaId,
    nombre: clients.name,
  }).from(flitoLogisticaTraslados)
    .leftJoin(clients, eq(clients.id, flitoLogisticaTraslados.companiaId))
    .orderBy(asc(clients.name));

  const truncado = filas.length > TOPE_ENTREGAS;
  return {
    viajes: (truncado ? filas.slice(0, TOPE_ENTREGAS) : filas).map(filaDe),
    companias: companias.map((c): CompaniaConViajeLogistica => ({ companiaId: c.companiaId, nombre: c.nombre ?? null })),
    truncado,
  };
}

function filaDe(r: {
  id: string; companiaId: number; companiaNombre: string | null;
  destino: string; estado: string; cantidadLt: number; registradoEn: Date;
}): FilaEntregaLogistica {
  return {
    id: r.id,
    companiaId: r.companiaId,
    companiaNombre: r.companiaNombre ?? null,
    destino: r.destino as DestinoTrasladoLogistica,
    estado: r.estado as EstadoTrasladoLogistica,
    cantidadLt: Number(r.cantidadLt),
    registradoEn: r.registradoEn instanceof Date ? r.registradoEn.toISOString() : new Date(r.registradoEn).toISOString(),
  };
}
