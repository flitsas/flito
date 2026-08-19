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
  esEstadoReporte,
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
const CASO_ESTADO_FACTURA: SQL = sql`CASE
    WHEN sf.estado = 'fallida'      THEN 'fallido'
    WHEN sf.estado = 'en_proceso'   THEN 'en_proceso'
    WHEN dian.estado = 'aceptada'   THEN 'aceptado'
    WHEN dian.estado = 'rechazada'  THEN 'rechazado'
    WHEN dian.estado = 'anulada'    THEN 'anulado'
    -- 'en_validacion' y la ausencia de pronunciamiento caen aquí: la factura salió y la DIAN
    -- todavía no ha dicho nada definitivo.
    ELSE 'emitido'
  END`;

/**
 * La factura que MANDA para un trámite, proyectando lo que se le pida.
 *
 * Existe como función y no como subconsultas copiadas porque «cuál de las facturas de este trámite
 * es la que cuenta» tiene una sola respuesta —la del `WHERE` y el `ORDER BY`— y el día que se ajuste
 * tiene que ajustarse para todos los que preguntan. Con dos copias, el estado vendría de una factura
 * y el número que se muestra al lado, de otra: una fila del reporte diciendo «Emitida» con el número
 * del intento anterior es peor que no mostrar número.
 *
 * El estado ante la DIAN se pide APARTE y no siempre: solo lo necesita el `CASE` del estado. Dejarlo
 * fijo añadiría a cada proyección un acceso al historial que esa proyección no lee —200 por página,
 * y a expensas de que el planificador se dé cuenta—. Lo que no puede variar entre llamadas es qué
 * factura se elige, y eso vive aquí; de dónde saca cada una sus columnas, sí.
 */
function deLaFacturaQueManda(proyeccion: SQL, conEstadoDian = false): SQL {
  const dian = conEstadoDian ? sql`
  LEFT JOIN LATERAL (
    SELECT estado
      FROM siigo_factura_estados_dian d
     WHERE d.factura_id = sf.id
     ORDER BY d.secuencia DESC
     LIMIT 1
  ) dian ON true` : sql.empty();

  return sql`(
  SELECT ${proyeccion}
  FROM siigo_factura_tramites sft
  JOIN siigo_facturas sf ON sf.id = sft.factura_id${dian}
  WHERE sft.tramite_id = ${flitoTramites.id}
    AND (sft.activo OR sf.estado = 'fallida')
  ORDER BY sft.activo DESC, sf.created_at DESC
  LIMIT 1
)`;
}

export const EXPR_ESTADO_FACTURACION: SQL<string> =
  sql<string>`${deLaFacturaQueManda(CASO_ESTADO_FACTURA, true)}`;

/**
 * ¿Hay trabajo en la cola para este trámite y todavía no ha salido nada? (HU #11328).
 *
 * Sin esto, un trámite recién encolado se pintaba `no_enviado`: exactamente igual que uno al que
 * nadie ha tocado. Mientras nada en el repositorio podía encolar, la distinción no existía; desde
 * que la ruta de esta historia lo permite, decir «Sin enviar» sobre algo que está en cola es una
 * afirmación falsa en una pantalla de control, y lleva a volver a pulsar sobre lo que ya está en
 * marcha.
 *
 * **Solo `pendiente` y `error`**, que son los dos estados con los que el trabajador vuelve a
 * mirarla. `enviado` no hace falta —hay factura, y la subconsulta de arriba manda—, y
 * `fallido_definitivo` se deja fuera a propósito: se sale del alcance de esta historia y tocaría
 * decidir si un lote dado por perdido SIN ninguna factura debe contarse como `fallido`, que es una
 * pregunta con consecuencias en la bandeja de fallidos (HU #11340).
 *
 * **No filtra por ambiente**, igual que la subconsulta de facturas: el despliegue tiene un solo
 * `SIIGO_AMBIENTE` y el reporte no recibe ninguno, así que filtrar aquí y no allá sería incoherente
 * —y para hacerlo en los dos sitios habría que meter configuración dentro de una expresión SQL
 * compartida—. Si algún día conviven ambientes en la misma base, se cambian las dos a la vez.
 */
const EXPR_ENCOLADO: SQL<string> = sql<string>`(
  SELECT 'encolado'::text
    FROM siigo_cola_facturacion c
    JOIN siigo_lote_tramites lt ON lt.lote_id = c.lote_id
   WHERE lt.tramite_id = ${flitoTramites.id}
     AND c.estado IN ('pendiente', 'error')
   LIMIT 1
)`;

/**
 * La escalera completa: la factura manda, después la cola, y al final «nunca se pidió».
 *
 * **El orden ES la regla, no una preferencia de escritura.** La factura va primero porque cualquier
 * cosa que ya haya pasado con el documento —que falló, que está en curso, que la DIAN se pronunció—
 * es más específica que «hay algo en cola»: una fila de cola en `error` acompaña a una factura
 * `fallida`, y ahí lo que hay que enseñar es el fallo, no que se reintentará. Poner `encolado`
 * delante taparía `fallido`, que es justo el estado sobre el que alguien tiene que actuar.
 *
 * El `COALESCE` de dos tramos existe porque cada subconsulta devuelve `NULL` —no una cadena— cuando
 * no encuentra filas: un `SELECT` sin filas no ejecuta su `CASE`. Sin el último tramo, un trámite
 * al que nunca se le pidió factura no encajaría en ningún grupo y la suma de los contadores no
 * cuadraría con el total, que es lo que el AC1 de la HU #11336 exige comprobar.
 */
export const EXPR_ESTADO_FACTURACION_COMPLETA: SQL<string> =
  sql<string>`COALESCE(${EXPR_ESTADO_FACTURACION}, ${EXPR_ENCOLADO}, 'no_enviado')`;

/** Condición para filtrar por estado (AC2). Se compone con las demás, no las sustituye. */
export function condicionEstadoFacturacion(estado: SiigoEstadoReporte): SQL {
  return sql`${EXPR_ESTADO_FACTURACION_COMPLETA} = ${estado}`;
}

// ── Lo que cada fila del reporte lleva de su factura (HU #11328, AC4) ───────

/** Lo que el reporte añade a cada fila sobre su factura electrónica. */
export interface FacturacionDeFila {
  /** El punto del ciclo en que está. Nunca `null`: un trámite sin factura es `no_enviado`. */
  estadoFacturacion: SiigoEstadoReporte;
  /** El número del documento, cuando ya lo hay. `null` mientras no exista factura o no tenga número. */
  facturaNumero: string | null;
  /**
   * Marca APARTE del estado: una factura emitida cuyo total no cuadra con la liquidación SIGUE
   * emitida —el documento existe ante la DIAN— y además necesita que alguien la mire. Como estado
   * se habría perdido la primera mitad, y quien concilia el cierre necesita las dos.
   */
  facturaRequiereRevision: boolean;
}

/**
 * Las columnas de facturación electrónica de una fila, **en la MISMA consulta** que el resto (AC4).
 *
 * Se resuelve con subconsultas correlacionadas y no con una llamada por fila: la página pinta hasta
 * 200 trámites, y preguntar por cada uno serían 200 consultas para dibujar una tabla. Tampoco con
 * joins, por la razón que ya explica `EXPR_ESTADO_FACTURACION`: un trámite puede tener varias
 * facturas y el `count(distinct)` que hoy cuadra los totales dejaría de cuadrar sin que nada avise.
 *
 * Son DOS subconsultas y no una sola que devuelva las tres cosas, a propósito. El estado se proyecta
 * con **la misma expresión** que filtra y que alimenta los contadores: si se leyera de un `jsonb`
 * armado aparte, la celda de la fila y el filtro serían dos definiciones del mismo estado, y el día
 * que una cambiara la tabla mostraría un estado que el filtro no encuentra. El precio es un índice
 * más por fila; el de la alternativa es que la pantalla mienta.
 */
export const SELECT_FACTURACION_ELECTRONICA = {
  estadoFacturacion: sql<string>`${EXPR_ESTADO_FACTURACION_COMPLETA}`,
  // `jsonb` y no dos subconsultas más: los dos datos salen de LA MISMA factura —la que manda—, y
  // pedirlos por separado abriría la puerta a que cada uno viniera de una distinta.
  facturaDatos: sql<unknown>`${deLaFacturaQueManda(
    sql`jsonb_build_object('numero', sf.numero, 'requiereRevision', sf.requiere_revision)`,
  )}`,
} as const;

/**
 * Traduce esas dos columnas a la fila del reporte.
 *
 * Un estado que no esté en el catálogo cae a `no_enviado` en vez de viajar en crudo: el tipo dice
 * `SiigoEstadoReporte` y la pantalla indexa con él un `Record` de etiquetas, así que un valor
 * inesperado pintaría `undefined` en una celda. La expresión SQL solo produce valores del catálogo,
 * de modo que esto es un cinturón sobre tirantes — y el sitio donde se notaría si dejara de serlo.
 */
export function facturacionDeFila(r: Record<string, unknown>): FacturacionDeFila {
  const estado = String(r.estadoFacturacion ?? '');
  const datos = objeto(r.facturaDatos);
  return {
    estadoFacturacion: esEstadoReporte(estado) ? estado : 'no_enviado',
    facturaNumero: typeof datos.numero === 'string' && datos.numero !== '' ? datos.numero : null,
    facturaRequiereRevision: datos.requiereRevision === true,
  };
}

/** El `jsonb` como objeto, venga ya parseado por el driver o como texto. */
function objeto(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch { /* un jsonb ilegible es «no hay factura», no un 500 en mitad del reporte. */ }
  }
  return {};
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
