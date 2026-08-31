// FLITO Impuestos — export a Excel de la cola filtrada (Feature #11908, HU #11909).
//
// Gemelo de `flito-soat.export.service.ts` y con las mismas reglas (RN-E1 lista blanca, RN-E2 tope
// duro, RN-E3 `tope + 1`, RN-E4 el 422 antes de la primera fila). Lo que comparten de verdad —las
// once columnas, el sello del nombre y el error del tope— vive en `shared/export/cola-flito-excel.ts`
// y no copiado aquí; lo que cambia entre los dos es de dónde sale cada valor, y eso es justo lo que
// justifica que haya dos servicios en vez de uno genérico:
//
//   · **CIUDAD es directa.** `flito_impuestos.tramite_id` es NOT NULL y UNIQUE, así que un impuesto
//     tiene un trámite y solo uno: la ciudad sale del `innerJoin` que la cola ya hace. En SOAT no se
//     puede —un SOAT es por VIN y sirve a varios trámites— y allí hay que reconciliar con `comun()`.
//   · **El propietario tiene UNA sola vía.** `flito_compradores` cuelga de dos padres desde la 0167,
//     pero las filas del canal Cliente son de SOAT: aquí solo hay `tramite_id`.
//   · **Los tres datos técnicos del vehículo (HU #11906) no estaban en la proyección de esta cola**
//     —el DTO de Impuestos no los publica— y el archivo sí los pide, así que se leen aquí.
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA: es el borde HTTP quien sabe quién pidió
// el archivo. Este servicio no toca `req`.

import { and, asc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoCompradores, flitoImpuestos, flitoTramites, organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  celdaTexto, ExportColaDemasiadoGrandeError, nombreArchivoColaExport, organismoParaExport,
  type FilaColaExport,
} from '../../shared/export/cola-flito-excel.js';
import { conJoinsColaImpuestos, condicionesColaImpuestos, type FiltrosColaImpuestos } from './flito-impuestos.service.js';
import type { ImpuestoCtx } from './flito-factura-venta.service.js';

/**
 * Filtros del export: los de la cola SIN paginación. Un export no pagina —entrega el conjunto
 * entero o responde 422—, así que `page`/`pageSize` no son parámetros que se ignoren, son un 400; y
 * que el tipo los prohíba impide que alguien los pase desde la ruta y el archivo salga con 50 filas
 * presentándose como el conjunto completo.
 */
export type FiltrosExportImpuestos = Omit<FiltrosColaImpuestos, 'page' | 'pageSize'>;

/**
 * Proyección del export, escrita una a una (RN-E1).
 *
 * Deliberadamente más estrecha que `SELECT_COLA`: aquí no se leen `valorLiquidado`, `valorPagado`,
 * `motivoRechazo`, `gestionOperaciones` ni el remitente. Lo que no sale de la base no se puede
 * publicar por descuido más arriba, y esa es la única defensa que sobrevive a que alguien añada una
 * columna a la lista blanca.
 */
const COLUMNAS_CONSULTA = {
  id: flitoImpuestos.id,
  tramiteId: flitoImpuestos.tramiteId,
  placa: vehicles.plate,
  // El VIN del vehículo: en Impuestos no hay copia en la tabla del trámite. Es nullable, así que la
  // celda puede ir vacía (AC7) y eso es correcto — no se rellena con nada.
  vin: vehicles.vin,
  // 1:1 con el trámite (`tramite_id` NOT NULL UNIQUE): sin la ambigüedad del SOAT.
  ciudad: flitoTramites.ciudad,
  // HU #11906. No están en el DTO de esta cola; el archivo sí las pide, y salen del `innerJoin` con
  // `vehicles` que la consulta ya hacía, así que no cuestan una lectura más.
  carroceria: vehicles.carroceria,
  tipoServicio: vehicles.tipoServicio,
  cilindraje: vehicles.cilindraje,
  organismoAlias: organismosTransitoConfig.alias,
  organismoCodigo: organismosTransitoConfig.codigo,
} as const;

/**
 * Columnas de `flito_compradores` que el archivo necesita. **`nombre_completo` NO está**: la hoja
 * lleva la CÉDULA del propietario y no su nombre (AC1, once columnas), así que traérselo al proceso
 * sería leer un dato personal que nadie va a escribir.
 */
const COLUMNAS_COMPRADOR = {
  id: flitoCompradores.id,
  tramiteId: flitoCompradores.tramiteId,
  numeroDocumento: flitoCompradores.numeroDocumento,
  correo: flitoCompradores.correo,
  celular: flitoCompradores.celular,
  direccion: flitoCompradores.direccion,
  orden: flitoCompradores.orden,
} as const;

/**
 * Lo que devuelve esa proyección. Se escribe a mano —y no derivado de las columnas— porque derivarlo
 * pierde la nullabilidad, y aquí la nullabilidad es justo lo que el AC7 obliga a respetar: `correo`,
 * `celular` y `direccion` son opcionales en la tabla y su ausencia tiene que llegar a la celda vacía.
 */
interface Comprador {
  id: string;
  tramiteId: string | null;
  numeroDocumento: string;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  orden: number;
}

/**
 * El propietario principal de cada trámite del lote: `orden asc, id asc`.
 *
 * `flito_compradores.orden` es `notNull().default(0)` y **no es único por trámite**: dos
 * copropietarios pueden compartir el 0. Sin el desempate por `id`, «el principal» sería quien
 * PostgreSQL devolviera primero y dos exports del mismo filtro podrían traer cédulas distintas en la
 * misma fila sin que nada hubiera cambiado en la base.
 *
 * Consulta aparte y no un JOIN, por dos motivos que se leen en el archivo: un `INNER JOIN` borraría
 * en silencio las filas sin comprador —justo las que hay que revisar— y un `LEFT JOIN` DUPLICARÍA la
 * fila del impuesto una vez por copropietario, entregando más filas de las que hay y falseando de
 * paso el conteo contra el tope.
 */
async function propietariosDe(tramiteIds: string[]): Promise<Map<string, Comprador>> {
  if (tramiteIds.length === 0) return new Map();
  const compradores = await db.select(COLUMNAS_COMPRADOR).from(flitoCompradores)
    .where(inArray(flitoCompradores.tramiteId, tramiteIds));

  const porTramite = new Map<string, Comprador[]>();
  for (const c of compradores) {
    // La consulta filtró por `tramite_id IN (…)`, así que el descarte no puede ocurrir: está para
    // que lo compruebe el compilador en vez de taparlo con un `!` (`tramiteId` es nullable desde la
    // 0167).
    if (!c.tramiteId) continue;
    const arr = porTramite.get(c.tramiteId) ?? [];
    arr.push(c); porTramite.set(c.tramiteId, arr);
  }

  const salida = new Map<string, Comprador>();
  for (const [tramiteId, cs] of porTramite) {
    const p = [...cs].sort((a, b) => (a.orden - b.orden) || a.id.localeCompare(b.id))[0];
    if (p) salida.set(tramiteId, p);
  }
  return salida;
}

/**
 * Las filas del archivo, o el 422 (RN-E2, RN-E4).
 *
 * @param ctx El contexto REAL del actor (`contextoImpuesto`, que lee el organismo de la BD y no del
 *            JWT). Es lo que aplica las dos fronteras dentro de `condicionesColaImpuestos`.
 * @throws ExportColaDemasiadoGrandeError si el filtro devuelve más del tope. Se lanza ANTES de
 *         construir una sola fila: no hay valor de retorno que escribir cuando el tope se pasa.
 */
export async function construirFilasExportImpuestos(
  ctx: ImpuestoCtx,
  filtros: FiltrosExportImpuestos = {},
): Promise<FilaColaExport[]> {
  const tope = env.FLITO_COLA_EXPORT_MAX_FILAS;

  const conds = condicionesColaImpuestos(ctx, filtros);
  if (conds === null) return [];

  const filas = await conJoinsColaImpuestos(db.select(COLUMNAS_CONSULTA).from(flitoImpuestos).$dynamic())
    .where(and(...conds))
    // El mismo orden del listado, con el desempate por `id`: sin él, dos impuestos creados en el
    // mismo instante saldrían en el orden que quisiera PostgreSQL y dos descargas del mismo filtro
    // no coincidirían.
    .orderBy(asc(flitoImpuestos.createdAt), asc(flitoImpuestos.id))
    // Tope + 1 (RN-E3): la fila sobrante no se entrega, solo demuestra que hay más.
    .limit(tope + 1);

  if (filas.length > tope) throw new ExportColaDemasiadoGrandeError(tope);

  const propietarios = await propietariosDe([...new Set(filas.map((f) => f.tramiteId))]);

  return filas.map((f) => {
    const p = propietarios.get(f.tramiteId);
    return {
      placa: celdaTexto(f.placa),
      // Sin propietario registrado las cuatro celdas van vacías y la fila SALE igual (AC7).
      cedula: celdaTexto(p?.numeroDocumento),
      correo: celdaTexto(p?.correo),
      telefono: celdaTexto(p?.celular),
      direccion: celdaTexto(p?.direccion),
      vin: celdaTexto(f.vin),
      ciudad: celdaTexto(f.ciudad),
      carroceria: celdaTexto(f.carroceria),
      tipoServicio: celdaTexto(f.tipoServicio),
      cilindraje: celdaTexto(f.cilindraje),
      organismoTransito: organismoParaExport(f.organismoAlias, f.organismoCodigo),
    };
  });
}

/** `impuestos_YYYYMMDD-HHmm.xlsx`, con la hora de Colombia y sin nada del filtro dentro. */
export function nombreArchivoExportImpuestos(ahora: Date = new Date()): string {
  return nombreArchivoColaExport('impuestos', ahora);
}
