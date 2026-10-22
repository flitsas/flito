// Reporte de costos — el valor DOCUMENTAL de los honorarios (Épica #12245, Feature #12607, HU #12653;
// ADR-0018 §5). Hermano de `finanzas.conciliacion-soat.ts`, y por los mismos motivos: es un bloque
// de columnas autocontenido, el servicio ya ronda el tope de líneas, y cada columna es una subconsulta
// correlacionada —nunca un `leftJoin` en `conJoins`— para que la fila del trámite no se multiplique.
//
// Qué se lee aquí y qué NO:
//   - Trámite digital y logística: el comprobante de pago aplicado MANDA sobre la tarifa (tolerancia
//     0). Eso lo hace `finanzas.service.ts` con `COALESCE(EXPR_DOC_*, tarifa)` en las mismas
//     expresiones que alimentan la celda, los totales, el consolidado y el Excel. Aquí solo se dice
//     de DÓNDE salió el valor (`origenes`) y cuánto difiere de la tarifa (`valorDocumental`).
//   - Servicios adicionales (Bug #12913): el valor de cada comprobante de pago ya ENTRÓ a la puente
//     por tipo, que es lo que suma la celda; aquí solo va la constancia. Un trámite puede tener VARIOS
//     pagos SA (uno por tipo): la celda muestra la SUMA de tarifa de referencia y diferencia, está
//     aceptada solo si todas las marcadas lo están, y id/número/fecha/aceptación salen del
//     «representante» (primero el pendiente de aceptar): «Aceptar» va comprobante por comprobante.
//     Sin `origenes.serviciosAdicionales` en el DTO.
//   - La aceptación de la diferencia (`diferencia_aceptada_*`) y la clave `detalle.<c>.origenValor`
//     del sello las ESCRIBE la HU #12654; aquí se leen. Un sello anterior sin la clave es 'tarifa'.
//
// Sin parámetros: los conceptos y las claves jsonb son texto del template. Drizzle no deduplica
// literales, y en el consolidado (GROUP BY) un parámetro repetido es un 42803 (Bug #12058).

import { sql, type SQL } from 'drizzle-orm';
import { ConceptoCosto, type OrigenValor, type ValorDocumentalConcepto, type ValoresDocumentalesDeFila } from '@operaciones/shared-types';
import { flitoComprobantes, flitoLiquidaciones, flitoTramites } from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import {
  documental, documentalAceptadaPorNombre, EXPR_ACEPTADA_SA, EXPR_DIF_SA, EXPR_DOC_LG, EXPR_DOC_TD, EXPR_TARIFA_SA,
  representanteSa, representanteSaAceptadaPorNombre, type ConceptoHonorario,
} from '../flito-comprobantes/flito-comprobantes.expr.js';

export type { ValoresDocumentalesDeFila };

/** Los tres honorarios con fila documental, con el prefijo de sus columnas en `SELECT_FILA`. */
const CONCEPTOS = {
  td: ConceptoCosto.TRAMITE_DIGITAL, lg: ConceptoCosto.LOGISTICA, sa: ConceptoCosto.SERVICIOS_ADICIONALES,
} as const satisfies Record<string, ConceptoHonorario>;
type Prefijo = keyof typeof CONCEPTOS;

/** Las nueve columnas documentales de UN concepto, cada una por la MISMA fábrica del leaf. */
function columnasDocumentales<P extends Prefijo>(p: P) {
  const c = CONCEPTOS[p];
  return {
    [`${p}ComprobanteId`]: sql<string | null>`${documental(flitoComprobantes.id, c)}`,
    [`${p}ComprobanteNumero`]: sql<string | null>`${documental(flitoComprobantes.numeroDocumento, c)}`,
    [`${p}ComprobanteFecha`]: sql<string | null>`${documental(flitoComprobantes.fechaDocumento, c)}`,
    [`${p}TarifaReferencia`]: sql<string | null>`${documental(flitoComprobantes.tarifaReferencia, c)}`,
    [`${p}Diferencia`]: sql<string | null>`${documental(flitoComprobantes.diferenciaTarifa, c)}`,
    [`${p}AceptadaPorId`]: sql<number | null>`${documental(flitoComprobantes.diferenciaAceptadaPorId, c)}`,
    [`${p}AceptadaEn`]: sql<Date | null>`${documental(flitoComprobantes.diferenciaAceptadaEn, c)}`,
    [`${p}AceptadaMotivo`]: sql<string | null>`${documental(flitoComprobantes.diferenciaAceptadaMotivo, c)}`,
    [`${p}AceptadaPorNombre`]: sql<string | null>`${documentalAceptadaPorNombre(c)}`,
  } as Record<`${P}${'ComprobanteId' | 'ComprobanteNumero' | 'ComprobanteFecha' | 'TarifaReferencia' | 'Diferencia' | 'AceptadaPorId' | 'AceptadaEn' | 'AceptadaMotivo' | 'AceptadaPorNombre'}`, SQL>;
}

/**
 * Servicios adicionales (Bug #12913): las mismas nueve columnas más `saAceptada`, con las fábricas SA
 * del leaf (suma / representante / bool_or) porque hay N filas por trámite.
 */
function columnasDocumentalesSa() {
  return {
    saComprobanteId: sql<string | null>`${representanteSa(flitoComprobantes.id)}`,
    saComprobanteNumero: sql<string | null>`${representanteSa(flitoComprobantes.numeroDocumento)}`,
    saComprobanteFecha: sql<string | null>`${representanteSa(flitoComprobantes.fechaDocumento)}`,
    saTarifaReferencia: sql<string | null>`${EXPR_TARIFA_SA}`,
    saDiferencia: sql<string | null>`${EXPR_DIF_SA}`,
    saAceptadaPorId: sql<number | null>`${representanteSa(flitoComprobantes.diferenciaAceptadaPorId)}`,
    saAceptadaEn: sql<Date | null>`${representanteSa(flitoComprobantes.diferenciaAceptadaEn)}`,
    saAceptadaMotivo: sql<string | null>`${representanteSa(flitoComprobantes.diferenciaAceptadaMotivo)}`,
    saAceptadaPorNombre: sql<string | null>`${representanteSaAceptadaPorNombre()}`,
    saAceptada: sql<boolean | null>`${EXPR_ACEPTADA_SA}`,
  };
}

/**
 * De dónde salió el valor (AC6). Sellada: lo que dejó escrito el sello
 * (`detalle -> '<concepto>' ->> 'origenValor'`), y 'tarifa' si el sello es anterior a F3 y no trae la
 * clave —el dinero sellado sigue siendo el sellado; aquí solo se etiqueta—. Sin sellar: 'documental'
 * si hay comprobante de pago aplicado, 'tarifa' si no. Nunca NULL desde SQL: el NULL de «no aplica»
 * (logística autogestionada) lo pone `valoresDocumentalesDeFila` con `gestionaLogistica`, que es la
 * misma bandera que deja la celda en blanco.
 */
function origen(clave: 'tramiteDigital' | 'logistica', doc: SQL): SQL {
  return sql`CASE WHEN ${flitoLiquidaciones.id} IS NOT NULL
    THEN COALESCE(${flitoLiquidaciones.detalle} -> ${sql.raw(`'${clave}'`)} ->> 'origenValor', 'tarifa')
    WHEN ${doc} IS NOT NULL THEN 'documental' ELSE 'tarifa' END`;
}

/**
 * Las columnas documentales de una fila, **en la MISMA consulta** que el resto (29 subconsultas
 * escalares por fila, todas sobre `idx_flito_comprobantes_valor_documental`).
 */
export const SELECT_VALORES_DOCUMENTALES = {
  origenTd: sql<string>`${origen('tramiteDigital', EXPR_DOC_TD)}`,
  origenLg: sql<string>`${origen('logistica', EXPR_DOC_LG)}`,
  ...columnasDocumentales('td'),
  ...columnasDocumentales('lg'),
  ...columnasDocumentalesSa(),
} as const;

/**
 * Filtro «Con diferencias» (AC5): al menos un pago aplicado marcado por diferencia cuya aceptación
 * sigue en NULL. Se compone con los demás filtros en `condiciones()`; sin parámetros.
 */
export const EXPR_CON_DIFERENCIAS: SQL = sql`EXISTS (SELECT 1 FROM ${flitoComprobantes}
  WHERE ${flitoComprobantes.tramiteId} = ${flitoTramites.id}
    AND ${flitoComprobantes.estado} = 'aplicado' AND ${flitoComprobantes.esPago} = true
    AND ${flitoComprobantes.marcadoPorDiferencia} = true
    AND ${flitoComprobantes.diferenciaAceptadaPorId} IS NULL)`;

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function conceptoDe(r: Record<string, unknown>, p: Prefijo): ValorDocumentalConcepto | null {
  const comprobanteId = s(r[`${p}ComprobanteId`]);
  if (!comprobanteId) return null;
  return {
    comprobanteId,
    numero: s(r[`${p}ComprobanteNumero`]),
    // `date` sin hora: viaja tal cual (yyyy-mm-dd), sin inventarle un instante.
    fecha: s(r[`${p}ComprobanteFecha`]),
    tarifaReferencia: n(r[`${p}TarifaReferencia`]),
    diferencia: n(r[`${p}Diferencia`]),
    // «Aceptada» es que alguien la aceptó (`diferencia_aceptada_por_id` NOT NULL), no la fecha. En SA
    // (N filas, Bug #12913) es que TODAS las marcadas lo están: `saAceptada`.
    aceptada: p === 'sa' ? r.saAceptada === true : n(r[`${p}AceptadaPorId`]) !== null,
    aceptadaPorNombre: s(r[`${p}AceptadaPorNombre`]),
    aceptadaEn: aIso(r[`${p}AceptadaEn`]),
    aceptadaMotivo: s(r[`${p}AceptadaMotivo`]),
  };
}

const esOrigen = (v: unknown): OrigenValor => (v === 'documental' || v === 'tarifa' ? v : 'tarifa');

/**
 * `origenes` y `valorDocumental` de una fila a partir de la proyección de arriba más
 * `gestionaLogistica` (ya en `SELECT_FILA`).
 *
 * La logística autogestionada sin excepción (AC3) da `origenes.logistica = null`: no hay valor del
 * que decir de dónde salió. Su `valorDocumental.logistica` SÍ viaja —la pantalla puede decir
 * «soporte del trámite»—, pero no entra al valor, al total ni al consolidado: eso lo garantiza el
 * `WHEN NOT GESTIONA_LOGISTICA THEN NULL` que precede al `COALESCE` en `RAMAS_LOGISTICA_ESTIMADA`.
 */
export function valoresDocumentalesDeFila(r: Record<string, unknown>): ValoresDocumentalesDeFila {
  const gestionaLogistica = Boolean(r.gestionaLogistica);
  return {
    origenes: {
      tramiteDigital: esOrigen(r.origenTd),
      logistica: gestionaLogistica ? esOrigen(r.origenLg) : null,
    },
    valorDocumental: {
      tramiteDigital: conceptoDe(r, 'td'),
      logistica: conceptoDe(r, 'lg'),
      serviciosAdicionales: conceptoDe(r, 'sa'),
    },
  };
}
