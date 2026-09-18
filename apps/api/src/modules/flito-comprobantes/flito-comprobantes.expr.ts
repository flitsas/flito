// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12631: las expresiones
// SQL de la fila documental de los honorarios, para que F3 (#12607) las lleve al reporte de costos y
// a la liquidación sin volver a leer el documento.
//
// Es un LEAF (AC4): no importa nada del módulo de finanzas (reporte de costos) ni del de liquidación
// —son ellos quienes lo importan: el reporte desde la HU #12653 (F3), vía
// `finanzas.valores-documentales.ts`; la liquidación en la HU #12654—. Cada expresión es una subconsulta
// escalar sobre `flito_comprobantes` correlacionada con `flito_tramites.id` (la tabla base del reporte
// y de la liquidación), por concepto, con `estado = 'aplicado' AND es_pago = true`: el índice único
// parcial `idx_flito_comprobantes_valor_documental` garantiza a lo sumo UNA fila por (trámite, concepto).
//
// El literal del concepto va como texto del template (`sql.raw`), nunca como parámetro: Drizzle no
// deduplica literales y en un `GROUP BY` un parámetro repetido es un 42803 (Bug #12058). Ninguna de
// estas expresiones lleva parámetros.

import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ConceptoCosto } from '@operaciones/shared-types';
import { flitoComprobantes, flitoTramites, users } from '../../db/schema.js';

/**
 * Carpeta S3 de la puerta (HU #12611): no hay compañía conocida al cargar, así que cuelga del lote.
 * Vive aquí, en el leaf, desde la HU #12632: `carga.ts` → `auto.ts` → `aplicar.ts` forman un ciclo y
 * una constante leída al evaluar el módulo (`CARPETA_APLICADOS`) no puede colgar de un módulo del ciclo.
 */
export const CARPETA_COMPROBANTES = 'flito/comprobantes';

export type ConceptoHonorario =
  | typeof ConceptoCosto.TRAMITE_DIGITAL | typeof ConceptoCosto.LOGISTICA | typeof ConceptoCosto.SERVICIOS_ADICIONALES;

/** Los conceptos cuyo pago vive en la propia fila del comprobante (ADR-0018 §4): sin dueño aparte. */
export const CONCEPTOS_HONORARIO: readonly ConceptoCosto[] = [ConceptoCosto.TRAMITE_DIGITAL, ConceptoCosto.LOGISTICA, ConceptoCosto.SERVICIOS_ADICIONALES];

export function esHonorario(concepto: ConceptoCosto): concepto is ConceptoHonorario {
  return CONCEPTOS_HONORARIO.includes(concepto);
}

/** El filtro de la fila documental de UN concepto: el pago aplicado de ese trámite y concepto. */
function filaDocumental(concepto: ConceptoHonorario): SQL {
  return sql`${flitoComprobantes.tramiteId} = ${flitoTramites.id} and ${flitoComprobantes.concepto} = ${sql.raw(`'${concepto}'`)} and ${flitoComprobantes.estado} = 'aplicado' and ${flitoComprobantes.esPago} = true`;
}

/**
 * `(SELECT <columna> FROM flito_comprobantes WHERE tramite_id = flito_tramites.id AND concepto = '<c>'
 * AND estado = 'aplicado' AND es_pago = true LIMIT 1)`. El `LIMIT 1` es cinturón sobre el índice único.
 *
 * Exportada desde la HU #12653: el reporte de costos proyecta por concepto la referencia, el número,
 * la fecha y la aceptación de la diferencia (`finanzas.valores-documentales.ts`) con ESTA fábrica, no
 * con una copia — «qué fila documental cuenta» tiene una sola respuesta.
 */
export function documental(columna: AnyPgColumn, concepto: ConceptoHonorario): SQL {
  return sql`(select ${columna} from ${flitoComprobantes} where ${filaDocumental(concepto)} limit 1)`;
}

/**
 * El `username` de quien ACEPTÓ la diferencia de ese concepto (HU #12654 escribe
 * `diferencia_aceptada_por_id`; aquí solo se lee), o NULL. Es el usuario interno, no PII del cliente.
 */
export function documentalAceptadaPorNombre(concepto: ConceptoHonorario): SQL {
  return sql`(select ${users.username} from ${flitoComprobantes} join ${users} on ${users.id} = ${flitoComprobantes.diferenciaAceptadaPorId} where ${filaDocumental(concepto)} limit 1)`;
}


/** El `valor` documental del trámite digital (lo que dice el comprobante de pago aplicado), o NULL. */
export const EXPR_DOC_TD: SQL = documental(flitoComprobantes.valor, ConceptoCosto.TRAMITE_DIGITAL);
/** El `valor` documental de la logística, o NULL. */
export const EXPR_DOC_LG: SQL = documental(flitoComprobantes.valor, ConceptoCosto.LOGISTICA);

/** `diferencia_tarifa` (valor − tarifa de referencia, tolerancia 0) por concepto; NULL sin fila documental. */
export const EXPR_DIF_TD: SQL = documental(flitoComprobantes.diferenciaTarifa, ConceptoCosto.TRAMITE_DIGITAL);
export const EXPR_DIF_LG: SQL = documental(flitoComprobantes.diferenciaTarifa, ConceptoCosto.LOGISTICA);
/** Servicios adicionales: su valor documental NO manda (el sellado sigue leyendo el catálogo); solo aporta la diferencia. */
export const EXPR_DIF_SA: SQL = documental(flitoComprobantes.diferenciaTarifa, ConceptoCosto.SERVICIOS_ADICIONALES);

/** `marcado_por_diferencia` por concepto (tarifa sin configurar o diferencia ≠ 0); NULL sin fila documental. */
export const EXPR_MARCADO_TD: SQL = documental(flitoComprobantes.marcadoPorDiferencia, ConceptoCosto.TRAMITE_DIGITAL);
export const EXPR_MARCADO_LG: SQL = documental(flitoComprobantes.marcadoPorDiferencia, ConceptoCosto.LOGISTICA);
export const EXPR_MARCADO_SA: SQL = documental(flitoComprobantes.marcadoPorDiferencia, ConceptoCosto.SERVICIOS_ADICIONALES);
