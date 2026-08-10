// Reporte de costos — en qué punto está la factura electrónica de cada trámite (HU #11336).
//
// Vive aparte de `finanzas.service.ts` a propósito: ese archivo ya ronda las 600 líneas y esta
// historia le añadiría lo suyo justo cuando la HU #11337 va a añadirle la pantalla. Separarlo ahora
// cuesta un import; separarlo después cuesta un refactor con el trabajo encima.
//
// DOS DECISIONES
//
//   1. **UNA sola definición de qué estado tiene un trámite.** La misma expresión SQL alimenta los
//      contadores y el filtro. Si fueran dos, el día que se ajuste una —y se ajustará, porque el
//      catálogo de estados va a crecer— el filtro y los números dirían cosas distintas sobre la
//      misma fila. Ese es el tipo de bicho que nadie encuentra: no falla, solo miente.
//   2. **El estado se DERIVA, no se guarda.** Es la combinación de dos ejes que el sistema mantiene
//      por separado y con razón: si salió de FLITO (`siigo_facturas.estado`) y qué dijo la DIAN
//      (el historial). Una columna `estado_reporte` habría que sincronizarla desde los dos, y una
//      columna que se olvida de actualizarse es exactamente lo que este reporte viene a evitar.
//
// Nada de esto llama a Siigo (AC5). La pantalla consulta el resumen cada vez que se abre; si cada
// apertura gastara peticiones de la ventana de 100 por minuto, mirar el reporte frenaría la emisión.

import { sql, type SQL } from 'drizzle-orm';
import {
  SIIGO_ESTADOS_REPORTE,
  type SiigoEstadoReporte,
  type SiigoResumenReporte,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoTramites } from '../../db/schema.js';

/**
 * El estado de facturación electrónica de un trámite, como expresión SQL.
 *
 * **Correlacionada y no un join** porque el reporte ya arrastra ocho joins y añadir dos más
 * multiplicaría filas: un trámite puede tener varias facturas a lo largo del tiempo —un intento
 * fallido y una emisión posterior— y el conteo `distinct` que hoy cuadra los totales dejaría de
 * cuadrarlos sin que nada avise. La subconsulta devuelve exactamente un valor por trámite.
 *
 * **`sft.activo` NO sirve como único filtro, y por poco cuesta el AC4.** El disparador de la
 * migración 0135 define `activo = (estado <> 'fallida')`: es el espejo exacto de «su factura no
 * falló». Filtrar solo por `activo` eliminaba precisamente las filas que la rama `'fallido'`
 * pretende clasificar, así que esa rama era inalcanzable, el contador habría marcado CERO para
 * siempre y toda emisión fallida se habría contado como `no_enviado` — que es literalmente lo que
 * el AC4 prohíbe. Verificado contra PostgreSQL 16: con el filtro viejo el mismo trámite devolvía
 * `no_enviado`; con este, `fallido`.
 *
 * De ahí las dos piezas: la condición deja pasar las fallidas explícitamente, y el orden pone
 * `activo` primero para que una emisión posterior con éxito gane a un intento fallido anterior. La
 * fecha desempata dentro de cada grupo — si hubo varios intentos, manda el último, que es lo que
 * alguien quiere saber cuando pregunta «¿ya salió?».
 *
 * El orden de las ramas del CASE es el de la pregunta que responde, no el del ciclo:
 *   1. ¿Falló al salir? — un fallo de emisión manda sobre cualquier cosa que diga la DIAN, porque
 *      si no salió, la DIAN no tiene nada que decir.
 *   2. ¿Sigue en curso?
 *   3. ¿Qué dijo la DIAN? — solo entonces, y solo si llegó a emitirse.
 *
 * (No hay rama para «no hay factura»: `factura_id` es `NOT NULL`, así que dentro de esta
 * subconsulta siempre hay una. El caso de un trámite sin ninguna fila lo resuelve el `COALESCE` de
 * abajo, que es donde de verdad ocurre.)
 */
export const EXPR_ESTADO_FACTURACION: SQL<string> = sql<string>`(
  SELECT CASE
    WHEN sf.estado = 'fallida'      THEN 'fallido'
    WHEN sf.estado = 'en_proceso'   THEN 'en_proceso'
    WHEN dian.estado = 'aceptada'   THEN 'aceptado'
    WHEN dian.estado = 'rechazada'  THEN 'rechazado'
    WHEN dian.estado = 'anulada'    THEN 'anulado'
    -- 'en_validacion' y la ausencia de pronunciamiento caen aquí: la factura salió y la DIAN
    -- todavía no ha dicho nada definitivo.
    ELSE 'emitido'
  END
  FROM siigo_factura_tramites sft
  JOIN siigo_facturas sf ON sf.id = sft.factura_id
  LEFT JOIN LATERAL (
    SELECT estado
      FROM siigo_factura_estados_dian d
     WHERE d.factura_id = sf.id
     ORDER BY d.secuencia DESC
     LIMIT 1
  ) dian ON true
  WHERE sft.tramite_id = ${flitoTramites.id}
    AND (sft.activo OR sf.estado = 'fallida')
  ORDER BY sft.activo DESC, sf.created_at DESC
  LIMIT 1
)`;

/**
 * Lo mismo, pero contemplando que el trámite no tenga NINGUNA fila en la tabla puente.
 *
 * La subconsulta de arriba devuelve `NULL` —no `'no_enviado'`— cuando no hay ni enlace, porque un
 * `SELECT` sin filas no ejecuta su `CASE`. Sin este `COALESCE`, un trámite al que nunca se le pidió
 * factura no encajaría en ningún grupo y la suma de los contadores no cuadraría con el total, que
 * es justo lo que el AC1 exige comprobar.
 */
export const EXPR_ESTADO_FACTURACION_COMPLETA: SQL<string> =
  sql<string>`COALESCE(${EXPR_ESTADO_FACTURACION}, 'no_enviado')`;

/** Condición para filtrar por estado (AC2). Se compone con las demás, no las sustituye. */
export function condicionEstadoFacturacion(estado: SiigoEstadoReporte): SQL {
  return sql`${EXPR_ESTADO_FACTURACION_COMPLETA} = ${estado}`;
}

/** Un resumen con todos los estados a cero. El punto de partida, para que ninguno falte. */
export function resumenVacio(): SiigoResumenReporte {
  const base = Object.fromEntries(SIIGO_ESTADOS_REPORTE.map((e) => [e, 0]));
  return { ...base, total: 0 } as SiigoResumenReporte;
}

/**
 * Convierte las filas agrupadas en el resumen (AC1).
 *
 * Parte de todos los estados a cero y suma encima: así un estado sin trámites sale como `0` y no
 * desaparece. Un contador que desaparece se lee como «no aplica», que no es lo mismo que «ninguno»,
 * y en una pantalla de control esa diferencia importa.
 */
export function componerResumen(filas: Array<{ estado: string; cuantos: number }>): SiigoResumenReporte {
  const resumen = resumenVacio();
  for (const f of filas) {
    const n = Number(f.cuantos) || 0;
    // Un estado que no está en el catálogo no se descarta en silencio: se suma al total igual, para
    // que la suma siga cuadrando y la incoherencia se vea en vez de esconderse en un cuadre falso.
    if ((SIIGO_ESTADOS_REPORTE as readonly string[]).includes(f.estado)) {
      resumen[f.estado as SiigoEstadoReporte] += n;
    }
    resumen.total += n;
  }
  return resumen;
}

/**
 * Los contadores, sobre EL MISMO conjunto filtrado que ve la tabla (AC3).
 *
 * Recibe el `where` ya compuesto por el reporte y los joins ya aplicados, en vez de rehacerlos: si
 * contara sobre el universo completo, la pantalla mostraría números que no corresponden a lo que
 * hay debajo, y quien filtre por una empresa vería el total de todas.
 */
export async function resumenFacturacionElectronica(
  aplicarJoins: <Q>(q: Q) => Q,
  where: SQL | undefined,
): Promise<SiigoResumenReporte> {
  const base = db
    .select({
      estado: sql<string>`${EXPR_ESTADO_FACTURACION_COMPLETA}`.as('estado'),
      cuantos: sql<number>`count(distinct ${flitoTramites.id})::int`,
    })
    .from(flitoTramites)
    .$dynamic();

  const filas = await (aplicarJoins(base) as typeof base)
    .where(where)
    .groupBy(sql`1`);

  return componerResumen(filas as Array<{ estado: string; cuantos: number }>);
}
