// Finanzas — Desglose de solo lectura de los viajes de logística de un trámite (HU #12627, Feature
// #12618, Épica #12244).
//
// La columna «Logística» del reporte es la tarifa (viaje 1) MÁS los viajes adicionales, y una celda
// no cuenta de qué se compone. Este archivo arma ese desglose SIN recalcular nada: lo que la
// liquidación ya resuelve —`liquidacionDe` si está sellada, `calcular` si no— es la única fuente,
// así que la celda del reporte, la previsualización y este desglose dicen lo mismo. Ninguna
// consulta a `flito_tramite_viajes_logistica` aquí: la lectura de la tabla viva y la del snapshot
// ya están en `flito-liquidacion.service.ts`, y una tercera copia divergiría.
//
// Lectura, no mutación: sin `audit`; el rastro de quién mira el reporte lo lleva el reporte.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoTramites, vehicles } from '../../db/schema.js';
import { esUuid } from '../../shared/utils/uuid.js';
import {
  calcular, liquidacionDe, LiquidacionError, type ConceptoLogistica,
} from '../flito-liquidacion/flito-liquidacion.service.js';
import type { DesgloseViajesLogistica } from '@operaciones/shared-types';

/** El trámite no existe (404). Un id que no es uuid es el mismo caso: el id es opaco. */
export class TramiteNoEncontradoError extends Error {
  constructor() {
    super('El trámite no existe');
    this.name = 'TramiteNoEncontradoError';
  }
}

/**
 * El desglose de `logistica` de la liquidación (sellada o calculada) como respuesta del GET.
 *
 * Pura para poder afirmarla sola. Reglas (HU #12627):
 *  - `sin_desglose` ⇔ sellada con `viajes === null` (sello anterior a la HU #12626): solo el total.
 *  - `gestionaLogistica`: con lo vigente, `totalViajes !== 0` (`conceptoLogistica` pone 0 cuando la
 *    compañía autogestiona); con lo sellado, `valor !== null` (un sello sin logística la dejó en NULL).
 *  - `totalLogistica` es `valor` tal cual: tarifa + Σ viajes, o null si no gestiona / falta tarifa.
 */
export function desgloseDe(
  base: { tramiteId: string; idFlit: string; placa: string | null },
  logistica: ConceptoLogistica, liquidadoEn: string | null,
): DesgloseViajesLogistica {
  const liquidado = liquidadoEn !== null;
  if (liquidado && logistica.viajes === null) {
    return {
      ...base, gestionaLogistica: logistica.valor !== null, liquidado, liquidadoEn, origen: 'sin_desglose',
      tarifa: null, totalViajes: null, totalLogistica: logistica.valor, items: null,
    };
  }
  const gestionaLogistica = liquidado ? logistica.valor !== null : logistica.totalViajes !== 0;
  if (!gestionaLogistica) {
    return {
      ...base, gestionaLogistica: false, liquidado, liquidadoEn, origen: liquidado ? 'sellado' : 'vigente',
      tarifa: null, totalViajes: 0, totalLogistica: null, items: [],
    };
  }
  return {
    ...base, gestionaLogistica: true, liquidado, liquidadoEn, origen: liquidado ? 'sellado' : 'vigente',
    tarifa: logistica.tarifa, totalViajes: logistica.totalViajes, totalLogistica: logistica.valor,
    items: logistica.viajes ?? [],
  };
}

/** GET: el desglose del trámite. `TramiteNoEncontradoError` si no existe o el id no es uuid. */
export async function desgloseViajesLogistica(tramiteId: string): Promise<DesgloseViajesLogistica> {
  if (!esUuid(tramiteId)) throw new TramiteNoEncontradoError();
  const [t] = await db.select({ tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, placa: vehicles.plate })
    .from(flitoTramites).leftJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!t) throw new TramiteNoEncontradoError();
  try {
    // Sellada manda: lo congelado, sin reconsultar la tabla viva. Sin sello, la previsualización.
    const sellada = await liquidacionDe(tramiteId);
    const calculo = sellada ?? await calcular(tramiteId);
    return desgloseDe(
      { tramiteId: t.tramiteId, idFlit: t.idFlit, placa: t.placa ?? null },
      calculo.logistica, sellada?.liquidadoEn ?? null,
    );
  } catch (e) {
    // `calcular` dice «El trámite no existe» si desapareció entre la lectura de arriba y esta.
    if (e instanceof LiquidacionError && e.message === 'El trámite no existe') throw new TramiteNoEncontradoError();
    throw e;
  }
}
