// FLITO SOAT — QUÉ ES «un SOAT con comprobante cargado», en un solo sitio.
//
// Este archivo existe por una razón concreta y medible: desde el Feature #12075 hay TRES lectores de
// ese predicado y viven en dos módulos distintos.
//
//   1. El CENSO de la verificación diaria (`flito-soat-vigencia.service.ts`, AC2 de la HU #12096):
//      qué vehículos se consultan al RUNT cada madrugada.
//   2. La PROYECCIÓN de la cola (`flito-soat.service.ts`): qué filas llevan el bloque `vigencia` y
//      cuáles no llevan nada (HU #12097).
//   3. La carga y el borrado de la propia factura, que ya usaban la constante del tipo.
//
// Dos copias del mismo `EXISTS` empiezan idénticas y divergen en el primer matiz que se añada a una
// —el `descartado = false`, por ejemplo—, y la divergencia NO se ve: las dos devuelven filas. El
// síntoma sería que la cola pinta la vigencia de un SOAT que la corrida nunca consulta, o al revés.
//
// Vive aparte de `flito-soat.service.ts` (y no exportado desde allí) para que el servicio de
// vigencia no tenga que importar 2 000 líneas con JSZip, el motor OCR y el storage S3 detrás para
// leer una constante y una expresión.

import { and, eq, exists, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { flitoSoat, flitoSoportes } from '../../db/schema.js';

/**
 * El `flito_soportes.tipo` del comprobante de compra del SOAT: la factura de la aseguradora.
 *
 * Es el documento cuyo OCR lleva el SOAT a `pagado` (RN-03) y el único que prueba que FLITO compró
 * la póliza. No confundir con `factura_venta`, que es la del concesionario en el canal Cliente.
 */
export const TIPO_FACTURA_SOAT = 'factura_soat';

/**
 * Constructor de consultas SIN conexión: solo conoce el dialecto.
 *
 * `db.select(...)` habría servido igual en producción, pero ataría esta expresión —que se evalúa al
 * IMPORTAR el módulo— al cliente de base de datos, que en la suite está mockeado y devuelve un chain
 * falso en vez de una subconsulta. Con `QueryBuilder` el predicado es el mismo objeto en producción y
 * en los tests, que es lo que permite comprobarlo sobre el SQL renderizado.
 */
const qb = new QueryBuilder();

/**
 * «Este SOAT tiene comprobante de compra cargado y vivo» — el censo del AC2 de la HU #12096.
 *
 * ── Por qué ESTE criterio y no `flito_soat.estado = 'pagado'` (decisión del humano) ──────────────
 *
 * `pagado` es un SUBCONJUNTO ESTRICTO: un SOAT cuya factura acaba de subirse y está esperando en la
 * cola de revisión OCR tiene el comprobante cargado y NO está `pagado` todavía. Ese es justo un
 * vehículo por el que FLITO ya pagó una póliza y del que conviene saber si el RUNT la reconoce. Y
 * hay una razón más de fondo: `estado` afirma sobre el FLUJO INTERNO de FLITO —dónde va la
 * solicitud—, mientras que la existencia del comprobante afirma sobre el DOCUMENTO, que es lo que la
 * pregunta «¿lo que compramos sigue estando?» necesita. El criterio descartado queda escrito aquí, y
 * no solo el elegido, porque el AC2 exige que el criterio quede escrito y un criterio sin su
 * alternativa no se puede revisar.
 *
 * ── `EXISTS` y NO un `JOIN` ─────────────────────────────────────────────────────────────────────
 *
 * `factura_soat` PUEDE repetirse por SOAT: el único índice único parcial de `flito_soportes` por
 * `soat_id` acota `factura_venta`, no este tipo. Un `innerJoin` duplicaría la fila del SOAT una vez
 * por comprobante, inflaría el `total` de la corrida y consultaría el RUNT dos veces por el mismo
 * vehículo. El `EXISTS` no puede multiplicar filas por construcción.
 *
 * ── `descartado = false` no es opcional ─────────────────────────────────────────────────────────
 *
 * Un comprobante descartado en la revisión OCR es un documento RECHAZADO. Sin esta condición, un
 * SOAT cuya única factura se descartó entraría en el censo cada noche y se consultaría al RUNT para
 * siempre, aunque nadie haya comprado nada.
 *
 * Los tres valores viajan como PARÁMETROS ENLAZADOS (`eq`, no `sql\`= 'factura_soat'\``): es la
 * regla 3 de AGENTS.md y, además, es lo que permite comprobar sobre el SQL renderizado QUÉ quedó
 * ligado a QUÉ comparación (`__tests__/helpers/sql-ligado.ts`) en vez de buscar una subcadena.
 */
export const EXISTS_COMPROBANTE_SOAT: SQL = exists(
  qb.select({ n: sql`1` }).from(flitoSoportes).where(and(
    eq(flitoSoportes.soatId, flitoSoat.id),
    eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT),
    eq(flitoSoportes.descartado, false),
  )),
);
