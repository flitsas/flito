// Reporte de costos — qué SOAT ya se descontó de bolsa al conciliar (HU #11679, Feature #11623).
//
// El reporte de costos dice cuánto cuesta cada trámite, pero no decía si ese SOAT YA se pagó por
// fuera y ya se descontó de la bolsa del cliente. Sin esa marca, quien cierra el periodo persigue un
// cobro que ya ocurrió, o lo cuenta dos veces. Cada fila conciliada viaja ahora con la boleta de la
// que salió el dinero (CF-05).
//
// Vive aparte de `finanzas.service.ts` por el mismo motivo que `finanzas.facturacion-electronica.ts`
// —su precedente exacto—: ese archivo ya ronda las 700 líneas y este bloque de columnas es
// autocontenido. Separarlo ahora cuesta un import.
//
// ── LA DECISIÓN: subconsulta correlacionada, NO un join ──────────────────────────────────────────
//
// La nota técnica de la historia proponía «un `leftJoin` más» en `conJoins`. No se hizo, por dos
// razones que son la historia entera:
//
//   1. **El abanico de filas.** `flito_conciliacion_lineas` tiene VARIAS líneas por el mismo SOAT en
//      cuanto una boleta se carga mal y se rehace: la descartada conserva su línea. Un
//      `leftJoin ... ON l.soat_id = t.soat_id` sin más multiplicaría la fila del trámite, y con ella
//      los totales de dinero, el `count(distinct)` de la paginación y el CSV. Lo único que impide el
//      abanico es el predicado `l.conciliada_en IS NOT NULL`, porque el índice único parcial
//      `idx_flito_concil_linea_soat_unica` solo cubre las líneas selladas: un SOAT se concilia como
//      mucho UNA vez en toda la base, pero eso solo vale entre las conciliadas. Y ese predicado no
//      puede ir en el `WHERE` —convertiría el `LEFT` en `INNER` y borraría del reporte todos los
//      trámites sin conciliar—, así que tendría que ir en el `ON`, donde es fácil de perder de vista.
//   2. **El radio de `conJoins`.** Lo comparten SIETE consultas de DOS módulos: la página, el conteo,
//      los agregados de dinero, las facetas, la exportación y la elegibilidad de facturación de
//      Siigo. Meter ahí un join pone a esta historia a responder por los totales del reporte y por
//      qué trámites se pueden facturar ante la DIAN, que no es su alcance. Una subconsulta
//      correlacionada devuelve exactamente un valor por fila POR CONSTRUCCIÓN y no toca a ninguno de
//      los otros seis llamadores: el AC2 («ninguna otra columna cambia») deja de ser una promesa que
//      hay que revisar a mano y pasa a ser una propiedad de la forma de la consulta.

import { sql, type SQL } from 'drizzle-orm';
import { flitoTramites } from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';

/**
 * La línea de conciliación SELLADA del SOAT de este trámite, proyectando lo que se le pida.
 *
 * Existe como función y no como subconsultas copiadas por lo mismo que `deLaFacturaQueManda` en el
 * archivo vecino: «qué línea cuenta» tiene UNA sola respuesta y el día que se ajuste tiene que
 * ajustarse para las dos columnas a la vez. Con dos copias, la referencia podría venir de una
 * boleta y la fecha de otra, y una fila que dice «BOL-000123» con la fecha de otra conciliación es
 * peor que no decir nada.
 *
 * **Sin `LIMIT 1`, a propósito.** El índice único parcial `idx_flito_concil_linea_soat_unica`
 * garantiza que como mucho hay una línea sellada por SOAT. Si esa garantía dejara de existir, un
 * `LIMIT 1` elegiría una boleta al azar y el reporte diría en silencio de qué boleta salió el dinero
 * —cuando en realidad habría salido dos veces—; sin él, PostgreSQL levanta la mano («more than one
 * row returned by a subquery used as an expression»). En trazabilidad contable, el fallo ruidoso es
 * el correcto. Es también lo que hace que las dos proyecciones sean provablemente de la MISMA fila.
 *
 * **`l.conciliada_en IS NOT NULL` es la mitad del sentido y la mitad de la seguridad.** Del sentido,
 * porque una línea de una boleta cargada o descartada NO movió dinero y marcarla como conciliada
 * mandaría a no cobrar algo que sigue pendiente. De la seguridad, porque es el predicado del índice
 * único: sin él la subconsulta puede devolver varias filas y la consulta entera revienta.
 */
function deLaBoletaDelSoat(proyeccion: SQL): SQL {
  return sql`(
  SELECT ${proyeccion}
    FROM flito_conciliacion_lineas l
    JOIN flito_conciliacion_boletas b ON b.id = l.boleta_id
   WHERE l.soat_id = ${flitoTramites.soatId}
     AND l.conciliada_en IS NOT NULL
)`;
}

/** Lo que el reporte añade a cada fila sobre la conciliación de su SOAT (CF-05). */
export interface ConciliacionSoatDeFila {
  /** `true` = ese SOAT ya se descontó de la bolsa en una boleta. Nunca `null`: o pasó o no pasó. */
  soatConciliado: boolean;
  /**
   * Referencia legible de la boleta ('BOL-000123'). `null` si no está conciliado.
   *
   * Es el identificador que se expone, y no el uuid: es único, es el que ve quien concilia y es el
   * que el propio módulo de conciliación ya considera seguro para salir (no es PII, a diferencia de
   * la póliza y la placa, que no aparecen por aquí).
   */
  boletaReferencia: string | null;
  // NO se expone el nombre del archivo de la boleta (`flito_conciliacion_boletas.archivo_nombre`), y
  // no es un olvido: es el `originalname` de multer —texto libre del cliente, solo recortado a 300—
  // y una boleta agrupa SOAT de muchos trámites, así que puede traer placa, nombre o NIT de un
  // tercero; `auditor` lee este reporte pero recibe 403 en `/flito-conciliacion/*`, y este módulo no
  // registra acceso PII, así que nadie sabría quién lo miró. Mismo criterio que la HU #11678 al
  // negarse a propagarlo (`flito-conciliacion.comprobante.service.ts`). La referencia basta para ir
  // a la boleta. (`placa` sí sale del reporte sin rastro PII: hueco preexistente, anotado aparte;
  // esta columna no lo amplía.)
  /**
   * Cuándo se selló la conciliación de ESTE SOAT, en ISO. `null` si no está conciliado.
   *
   * Se lee de la LÍNEA y no de la boleta a propósito. Hoy dan el mismo instante —`conciliar()` sella
   * las líneas y su boleta con el mismo `ahora`, dentro de la misma transacción—, así que la
   * diferencia no se nota; pero la pregunta que responde la columna es «¿cuándo se descontó ESTE
   * SOAT?», y esa la contesta la línea. Si algún día se admitiera reconciliar una línea suelta, la
   * fecha de la boleta pasaría a ser la de otra cosa sin que nadie tuviera que cambiar nada aquí.
   */
  soatConciliadoEn: string | null;
}

/**
 * Las columnas de conciliación de una fila, **en la MISMA consulta** que el resto.
 *
 * Se resuelven con subconsultas correlacionadas y no con una llamada por fila: la página pinta hasta
 * 200 trámites y la exportación hasta 20.000, así que preguntar por cada uno serían 20.000 consultas
 * para armar un CSV. Las dos pegan sobre `idx_flito_concil_linea_soat_unica`, que es justo el
 * índice que cubre el filtro (`soat_id = ? AND conciliada_en IS NOT NULL`).
 *
 * Son DOS y no tres: `b.archivo_nombre` se dejó fuera a propósito (ver `ConciliacionSoatDeFila`).
 */
export const SELECT_CONCILIACION_SOAT = {
  boletaReferencia: sql<string | null>`${deLaBoletaDelSoat(sql`b.referencia`)}`,
  boletaConciliadaEn: sql<Date | null>`${deLaBoletaDelSoat(sql`l.conciliada_en`)}`,
} as const;

/**
 * Traduce esas dos columnas a la fila del reporte.
 *
 * `soatConciliado` se DERIVA de que haya referencia en vez de venir en su propia columna: son la
 * misma pregunta hecha dos veces, y dos columnas podrían contradecirse —una fila marcada como
 * conciliada sin boleta a la que ir a mirar es exactamente el dato que esta historia viene a evitar—.
 * `referencia` es `NOT NULL` en la tabla, así que «hay referencia» y «hay línea sellada» son lo mismo.
 */
export function conciliacionDeFila(r: Record<string, unknown>): ConciliacionSoatDeFila {
  const referencia = texto(r.boletaReferencia);
  return {
    soatConciliado: referencia !== null,
    boletaReferencia: referencia,
    // Sin conciliación no hay nada que enseñar: la fecha sale `null`, no una cadena vacía que la
    // pantalla pintaría como una conciliación sin fecha.
    soatConciliadoEn: referencia === null ? null : aIso(r.boletaConciliadaEn),
  };
}

/** Una cadena con contenido, o `null`. La vacía cuenta como ausencia, no como valor. */
function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * La celda del CSV que distingue los dos casos y nombra la boleta (AC4).
 *
 * Una sola columna, y con la referencia DENTRO del valor: en una hoja de cálculo eso permite filtrar
 * por «No» para quedarse con lo que todavía hay que cobrar, y ordenar por la columna agrupa los
 * trámites de una misma boleta. Dejar la celda vacía para los no conciliados —la alternativa
 * evidente— se lee igual que un dato que no se pudo calcular, que es lo contrario de lo que el CSV
 * tiene que dejar claro cuando se usa para cuadrar un cierre.
 */
export function celdaConciliacionCsv(f: ConciliacionSoatDeFila): string {
  if (!f.soatConciliado) return 'No';
  return f.boletaReferencia === null ? 'Sí' : `Sí (${f.boletaReferencia})`;
}
