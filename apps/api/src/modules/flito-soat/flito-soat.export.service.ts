// FLITO SOAT — export a Excel de la cola filtrada (Feature #11908, HU #11909).
//
// La segunda lectura de `flito_soat` del módulo, y no es la de `cola()`: aquella pagina y devuelve el
// DTO que pinta una pantalla; esta entrega el conjunto entero una sola vez y con las once columnas
// del archivo. Lo único que comparten —y por eso vive en el servicio del listado, no aquí— es
// `condicionesCola`/`conJoinsCola`: qué significa cada filtro y qué ve cada rol se decide en un solo
// sitio, o el `.xlsx` acabaría conteniendo algo distinto de lo que el visor enseña y nadie se
// enteraría hasta que un cliente comparase las dos cosas.
//
// ── Reglas ───────────────────────────────────────────────────────────────────────────────────────
//
// RN-E1  Las columnas son una LISTA BLANCA (`COLUMNAS_COLA_EXPORT`) y la proyección se escribe campo
//        a campo. Un `select()` sin proyección traería la fila entera de `flito_soat` —incluidos
//        `valor_pagado`, `proveedor_soat_id` y `extraccion`— y una columna personal que alguien
//        añada mañana al esquema no puede aparecer en un archivo que sale del perímetro por el mero
//        hecho de existir.
//
// RN-E2  TOPE DURO de filas (`FLITO_COLA_EXPORT_MAX_FILAS`, 2 000 por defecto). Por encima no se
//        entrega un archivo recortado: se lanza y no se genera nada. Un export truncado en silencio
//        es peor que un error — el usuario concilia contra un conjunto que cree completo.
//
// RN-E3  El tope se comprueba pidiendo `tope + 1` filas, no con un `count(*)` sobre el filtro: la
//        fila 2 001 ya contesta la pregunta y ahorra recorrer el filtro dos veces.
//
// RN-E4  La comprobación ocurre ANTES de que exista una sola fila del archivo, y eso no depende del
//        orden en que se escriba la ruta: esta función o devuelve las filas o lanza. Quien escriba
//        la ruta no puede invertirlo aunque quiera, porque `sendExcel` necesita unas filas que solo
//        existen si el tope se cumplió.
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA, como el resto de lecturas del módulo: es
// el borde HTTP quien sabe quién pidió el archivo. Este servicio no toca `req`.

import { and, asc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoCompradores, flitoSoat, flitoTramites, organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  celdaTexto, ExportColaDemasiadoGrandeError, nombreArchivoColaExport,
  organismoParaExport, type FilaColaExport,
} from '../../shared/export/cola-flito-excel.js';
import {
  comun, conJoinsCola, condicionesCola, ORIGEN_CLIENTE,
  type FiltrosCola, type SoatCtx,
} from './flito-soat.service.js';

/**
 * Filtros que admite el export: los mismos de la cola SIN paginación.
 *
 * La resta es el contrato y no una omisión: un export no pagina —entrega el conjunto entero o
 * responde 422—, así que `page` y `pageSize` no son parámetros que se ignoren, son un 400. Que el
 * tipo los prohíba aquí es lo que impide que alguien los pase «por si acaso» desde la ruta y el
 * archivo salga con 50 filas presentándose como el conjunto completo.
 */
export type FiltrosExportSoat = Omit<FiltrosCola, 'page' | 'pageSize'>;

/**
 * Proyección del export, escrita una a una (RN-E1).
 *
 * Es DELIBERADAMENTE más estrecha que la de `cola()`: aquí no se leen `valorPagado`,
 * `proveedorSoatId`, `gestionOperaciones`, `motivoRechazo` ni `enviadoPorNombre`. No es ahorro, es
 * la frontera: lo que no sale de la base no se puede publicar por descuido más arriba, y esa es la
 * única defensa que sobrevive a que alguien añada una columna a `COLUMNAS_COLA_EXPORT`.
 *
 * `origen` sí se lee y no se imprime: decide POR QUÉ PADRE hay que buscar al propietario (ver
 * `propietariosDe`), exactamente como en `ensamblarCola`.
 */
const COLUMNAS_CONSULTA = {
  id: flitoSoat.id,
  origen: flitoSoat.origen,
  // El VIN de la SOLICITUD (`flito_soat.vin`, NOT NULL) y no el de `vehicles`, que es nullable: son
  // el mismo vehículo, pero solo uno de los dos garantiza que la celda tenga valor.
  vin: flitoSoat.vin,
  placa: vehicles.plate,
  carroceria: vehicles.carroceria,
  tipoServicio: vehicles.tipoServicio,
  cilindraje: vehicles.cilindraje,
  organismoAlias: organismosTransitoConfig.alias,
  organismoCodigo: organismosTransitoConfig.codigo,
} as const;

/**
 * Columnas de `flito_compradores` que el archivo necesita. **`nombre_completo` NO está**, y no es un
 * olvido: la hoja lleva la CÉDULA del propietario y no su nombre (AC1, once columnas), así que
 * leerlo sería traerse al proceso un dato personal que nadie va a escribir. Es la misma disciplina
 * que la proyección de arriba, aplicada a la tabla que más duele.
 */
const COLUMNAS_COMPRADOR = {
  id: flitoCompradores.id,
  tramiteId: flitoCompradores.tramiteId,
  soatId: flitoCompradores.soatId,
  numeroDocumento: flitoCompradores.numeroDocumento,
  correo: flitoCompradores.correo,
  celular: flitoCompradores.celular,
  direccion: flitoCompradores.direccion,
  orden: flitoCompradores.orden,
} as const;

/**
 * Lo que devuelve esa proyección. Se escribe a mano —y no derivado de las columnas— porque derivarlo
 * pierde la nullabilidad (`['_']['data']` da el tipo base, no `string | null`), y aquí la
 * nullabilidad es justo lo que el AC7 obliga a respetar: `correo`, `celular` y `direccion` son
 * opcionales en la tabla y su ausencia tiene que llegar hasta la celda vacía.
 */
interface Comprador {
  id: string;
  tramiteId: string | null;
  soatId: string | null;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  orden: number;
}

/**
 * Ordena los compradores de un mismo padre de forma ESTABLE: `orden asc, id asc`.
 *
 * `flito_compradores.orden` es `notNull().default(0)` y **no es único por trámite**: dos
 * copropietarios pueden compartir el 0. Sin el desempate por `id`, «el principal» sería quien
 * PostgreSQL devolviera primero, y dos exports del mismo filtro podrían traer cédulas distintas en
 * la misma fila sin que nada hubiera cambiado en la base.
 */
function principal(cs: Comprador[]): Comprador | undefined {
  return [...cs].sort((a, b) => (a.orden - b.orden) || a.id.localeCompare(b.id))[0];
}

/**
 * El propietario principal de cada SOAT del lote, por sus DOS vías.
 *
 * `flito_compradores` cuelga de dos padres desde la 0167, con un CHECK de «uno y solo uno»:
 *
 *   · las filas que vienen de un trámite cuelgan de `tramite_id`;
 *   · las del canal Cliente (`origen = 'cliente'`) tienen `tramite_id IS NULL` y cuelgan de
 *     `soat_id`.
 *
 * **Leer solo la primera vía es el fallo silencioso de esta HU**: las filas del canal saldrían en el
 * archivo con CEDULA, CORREO, TELEFONO y DIRECCION vacías, el `.xlsx` se abriría sin problema y
 * ningún aserto de columnas se enteraría. Es el mismo defecto que `ensamblarCola` ya tuvo que cerrar
 * en la cola, y por eso aquí se unen las dos igual que allí.
 *
 * La segunda consulta solo se hace si hay filas del canal en el lote: una selección de puro trámite
 * no paga una lectura más.
 */
async function propietariosDe(
  filas: { id: string; origen: string }[],
  tramites: TramiteDeSoat[],
): Promise<Map<string, Comprador>> {
  if (filas.length === 0) return new Map();

  const soatPorTramite = new Map(tramites.map((t) => [t.id, t.soatId]));
  const tramiteIds = tramites.map((t) => t.id);

  const porTramite = tramiteIds.length
    ? await db.select(COLUMNAS_COMPRADOR).from(flitoCompradores)
        .where(inArray(flitoCompradores.tramiteId, tramiteIds))
    : [];

  const idsCanal = filas.filter((f) => f.origen === ORIGEN_CLIENTE).map((f) => f.id);
  const porSoat = idsCanal.length
    ? await db.select(COLUMNAS_COMPRADOR).from(flitoCompradores)
        .where(inArray(flitoCompradores.soatId, idsCanal))
    : [];

  // Se AGRUPA primero y se elige después, en vez de quedarse con el primero que llegue: elegir al
  // vuelo dependería del orden en que la base devuelva las filas, que es justo lo que `principal()`
  // existe para no depender.
  const porSoatId = new Map<string, Comprador[]>();
  const acumular = (soatId: string | null | undefined, c: Comprador): void => {
    if (!soatId) return;
    const arr = porSoatId.get(soatId) ?? [];
    arr.push(c); porSoatId.set(soatId, arr);
  };
  for (const c of porTramite) acumular(c.tramiteId ? soatPorTramite.get(c.tramiteId) ?? null : null, c);
  for (const c of porSoat) acumular(c.soatId, c);

  const salida = new Map<string, Comprador>();
  for (const [soatId, cs] of porSoatId) {
    const p = principal(cs);
    if (p) salida.set(soatId, p);
  }
  return salida;
}

/** Los trámites de un lote de SOAT: su id (para buscar compradores) y su ciudad. */
interface TramiteDeSoat { id: string; soatId: string | null; ciudad: string | null }

/**
 * Los trámites de este lote de SOAT, en UNA sola lectura.
 *
 * **Aquí no hay `innerJoin` a `flito_tramites` en la consulta principal, y es la decisión que
 * sostiene la corrección del archivo.** Un SOAT es por VIN y puede servir a VARIOS trámites (RN-01),
 * así que unir allí multiplicaría la fila del SOAT una vez por trámite: el `.xlsx` traería 800 filas
 * para 500 SOAT —pasando todos los asertos de columnas sin despeinarse— y, peor, el conteo contra el
 * tope contaría duplicados, de modo que un filtro legítimo podría recibir un 422.
 *
 * Una sola lectura para las dos cosas que hacen falta —la ciudad y por dónde colgar al propietario—
 * en vez de dos consultas a la misma tabla con el mismo filtro.
 */
async function tramitesDe(ids: string[]): Promise<TramiteDeSoat[]> {
  if (ids.length === 0) return [];
  return db.select({ id: flitoTramites.id, soatId: flitoTramites.soatId, ciudad: flitoTramites.ciudad })
    .from(flitoTramites).where(inArray(flitoTramites.soatId, ids));
}

/**
 * La CIUDAD de cada SOAT, reconciliada con `comun()`.
 *
 * Cuando los trámites de un mismo SOAT discrepan, la ciudad es `null` y la celda va vacía: es la
 * misma respuesta honesta que da la cola con `tipoTramite` y `fechaAprobacion`. Elegir la del primer
 * trámite pondría en el archivo un dato con aspecto de cierto que depende del orden de la consulta.
 * Las filas del canal Cliente no tienen trámite y por tanto tampoco ciudad; eso es lo esperado, no
 * un hueco a rellenar.
 */
function ciudadesDe(tramites: TramiteDeSoat[]): Map<string, string | null> {
  const porSoat = new Map<string, { ciudad: string | null }[]>();
  for (const t of tramites) {
    if (!t.soatId) continue;
    const arr = porSoat.get(t.soatId) ?? [];
    arr.push({ ciudad: t.ciudad }); porSoat.set(t.soatId, arr);
  }

  const salida = new Map<string, string | null>();
  for (const [soatId, ts] of porSoat) salida.set(soatId, comun(ts, (t) => t.ciudad));
  return salida;
}

/**
 * Las filas del archivo, o el 422 (RN-E2, RN-E4).
 *
 * @param ctx El contexto REAL del actor (`contextoSoat`, que lee el proveedor de la BD y no del
 *            JWT). No es decorativo: es lo que aplica las tres fronteras dentro de
 *            `condicionesCola`.
 * @param filtros Los mismos del visor, ya validados, sin paginación.
 * @throws ExportColaDemasiadoGrandeError si el filtro devuelve más del tope. Se lanza ANTES de
 *         construir una sola fila, que es lo que hace imposible entregar un archivo truncado.
 */
export async function construirFilasExportSoat(
  ctx: SoatCtx,
  filtros: FiltrosExportSoat = {},
): Promise<FilaColaExport[]> {
  const tope = env.FLITO_COLA_EXPORT_MAX_FILAS;

  // El MISMO predicado del listado, incluidas las tres fronteras. `null` = este actor no puede ver
  // nada (un gestor sin proveedor): archivo vacío, nunca la tabla entera.
  const conds = condicionesCola(ctx, filtros);
  if (conds === null) return [];

  const filas = await conJoinsCola(db.select(COLUMNAS_CONSULTA).from(flitoSoat).$dynamic())
    .where(and(...conds))
    // El mismo orden del listado: el archivo tiene que leerse como la pantalla, de lo más antiguo a
    // lo más nuevo. El desempate por `id` importa igual aquí — sin él, dos altas del mismo instante
    // saldrían en el orden que quisiera PostgreSQL y dos descargas del mismo filtro no coincidirían.
    .orderBy(asc(flitoSoat.createdAt), asc(flitoSoat.id))
    // Tope + 1 (RN-E3): la fila sobrante no se entrega, solo demuestra que hay más.
    .limit(tope + 1);

  if (filas.length > tope) throw new ExportColaDemasiadoGrandeError(tope);

  const tramites = await tramitesDe(filas.map((f) => f.id));
  const ciudades = ciudadesDe(tramites);
  const propietarios = await propietariosDe(
    filas.map((f) => ({ id: f.id, origen: f.origen })),
    tramites,
  );

  return filas.map((f) => {
    const p = propietarios.get(f.id);
    return {
      placa: celdaTexto(f.placa),
      // Sin propietario registrado, las cuatro celdas van vacías y **la fila SALE igual**. Es el
      // motivo por el que el propietario se lee en una consulta aparte y no con un JOIN: un `INNER
      // JOIN` sobre `flito_compradores` borraría del archivo, en silencio, cada SOAT al que le
      // falte el comprador — y son justo los que hay que revisar.
      cedula: celdaTexto(p?.numeroDocumento),
      correo: celdaTexto(p?.correo),
      telefono: celdaTexto(p?.celular),
      direccion: celdaTexto(p?.direccion),
      vin: celdaTexto(f.vin),
      ciudad: celdaTexto(ciudades.get(f.id)),
      carroceria: celdaTexto(f.carroceria),
      tipoServicio: celdaTexto(f.tipoServicio),
      cilindraje: celdaTexto(f.cilindraje),
      organismoTransito: organismoParaExport(f.organismoAlias, f.organismoCodigo),
    };
  });
}

/** `soat_YYYYMMDD-HHmm.xlsx`, con la hora de Colombia y sin nada del filtro dentro. */
export function nombreArchivoExportSoat(ahora: Date = new Date()): string {
  return nombreArchivoColaExport('soat', ahora);
}
