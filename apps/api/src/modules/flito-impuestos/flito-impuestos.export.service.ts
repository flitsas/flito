// FLITO Impuestos — export a Excel de la cola filtrada (Feature #11908, HU #11909, #11934).
//
// Gemelo de `flito-soat.export.service.ts` y con las mismas reglas (RN-E1 lista blanca, RN-E2 tope
// duro, RN-E3 `tope + 1`, RN-E4 el 422 antes de la primera fila). Lo que comparten de verdad —las
// veinticinco columnas, el sello del nombre y el error del tope— vive en
// `shared/export/cola-flito-excel.ts`, y cómo se derivan las columnas calculadas, en
// `shared/export/cola-flito-derivados.ts`. Nada de eso está copiado aquí; lo que cambia entre los dos
// servicios es de dónde sale cada valor, y eso es justo lo que justifica que haya dos:
//
//   · **Los datos del trámite son DIRECTOS.** `flito_impuestos.tramite_id` es NOT NULL y UNIQUE, así
//     que un impuesto tiene un trámite y solo uno: el municipio, el organismo crudo y las ocho claves
//     de `flit_raw` salen del `innerJoin` que la cola ya hace, como ocho expresiones más en la
//     proyección y CERO joins nuevos. En SOAT no se puede —un SOAT es por VIN y sirve a varios
//     trámites— y allí hay que leer por lote y reconciliar campo a campo con `comun()`.
//   · **El propietario tiene UNA sola vía.** `flito_compradores` cuelga de dos padres desde la 0167,
//     pero las filas del canal Cliente son de SOAT: aquí solo hay `tramite_id`.
//   · **Los tres datos técnicos del vehículo (HU #11906) no estaban en la proyección de esta cola**
//     —el DTO de Impuestos no los publica— y el archivo sí los pide, así que se leen aquí.
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA: es el borde HTTP quien sabe quién pidió
// el archivo. Este servicio no toca `req`.

import { and, asc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoImpuestos, flitoTramites, vehicles } from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  celdaTexto, CONSTANTES_COLA_EXPORT, ExportColaDemasiadoGrandeError, nombreArchivoColaExport,
  type FilaColaExport,
} from '../../shared/export/cola-flito-excel.js';
import {
  bloqueTitular, celdaDesdeJson, ciudadDeOrganismo, expresionesFlitRaw,
} from '../../shared/export/cola-flito-derivados.js';
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
  // 1:1 con el trámite (`tramite_id` NOT NULL UNIQUE): sin la ambigüedad del SOAT. Antes se rotulaba
  // `CIUDAD`; desde la HU #11934 la cabecera es `Municipio` y el origen es el mismo.
  municipio: flitoTramites.ciudad,
  // `OrganismoDetto` = el nombre CRUDO que manda FLIT, no el alias configurado en FLITO.
  organismoDetto: flitoTramites.transitoNombreFlit,
  // HU #11906. No están en el DTO de esta cola; el archivo sí las pide, y salen del `innerJoin` con
  // `vehicles` que la consulta ya hacía, así que no cuestan una lectura más.
  carroceria: vehicles.carroceria,
  servicio: vehicles.tipoServicio,
  cilindraje: vehicles.cilindraje,
  // **`flito_impuestos.organismo_codigo` y NO `flit_raw->>'codigoSecretaria'`** — ver
  // `ciudadDeOrganismo`: el del payload llega sin el cero de relleno en la mitad de las filas y
  // dejaría `OrganismoDettoCiudad` vacía sin que nada fallara.
  organismoCodigo: flitoImpuestos.organismoCodigo,
  // HU #11934: las ocho claves del payload de FLIT, una expresión `->>` cada una. Entran en la
  // proyección que ya existía porque `conJoinsColaImpuestos` ya une `flito_tramites` 1:1 — cero joins
  // nuevos, cero consultas nuevas, y `flit_raw` NO se proyecta entera (RN-E1).
  ...expresionesFlitRaw(flitoTramites.flitRaw),
} as const;

/**
 * Columnas de `flito_compradores` que el archivo necesita.
 *
 * **`nombre_completo` sigue SIN estar, aunque la hoja de la HU #11934 ya publique el nombre del
 * titular.** El nombre del archivo sale de `flit_raw` —`nombres` y `apellidos` SEPARADOS, tal como
 * los manda FLIT— y esta columna es lo contrario: los dos fundidos en una cadena por
 * `flit-http.adapter.ts:74`. Partirla por el espacio sería una heurística sobre un dato que ya viene
 * desagregado en origen, y fallaría en cada nombre compuesto y en cada razón social.
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
    // Las cinco columnas del titular se deciden JUNTAS y en un solo sitio: son una regla de tres
    // estados, no un `if` por columna (ver `bloqueTitular`). Aquí no hay que reconciliar nada —el
    // impuesto tiene un trámite y solo uno—, así que el par entra tal cual.
    const titular = bloqueTitular({ nombres: f.nombres, apellidos: f.apellidos });
    // El orden de las claves es el de `COLUMNAS_COLA_EXPORT` para que las dos listas se lean juntas,
    // pero NO es lo que ordena el archivo: ExcelJS empareja por `key`.
    return {
      vin: celdaTexto(f.vin),
      placa: celdaTexto(f.placa),
      modelo: celdaDesdeJson(f.modelo),
      servicio: celdaTexto(f.servicio),
      marca: celdaDesdeJson(f.marca),
      linea: celdaDesdeJson(f.linea),
      clase: celdaDesdeJson(f.clase),
      carroceria: celdaTexto(f.carroceria),
      cilindraje: celdaTexto(f.cilindraje),
      capacidadCargaOPasajeros: celdaDesdeJson(f.capacidad),
      puertas: CONSTANTES_COLA_EXPORT.puertas,
      organismoDetto: celdaTexto(f.organismoDetto),
      nI: CONSTANTES_COLA_EXPORT.nI,
      claseDeInterlocutor: titular.claseDeInterlocutor,
      nombrePila: titular.nombrePila,
      apellidos: titular.apellidos,
      razonSocial: titular.razonSocial,
      claseId: titular.claseId,
      // Sin propietario registrado estas cuatro celdas van vacías y la fila SALE igual (AC7).
      numeroId: celdaTexto(p?.numeroDocumento),
      direccion: celdaTexto(p?.direccion),
      municipio: celdaTexto(f.municipio),
      departamento: celdaDesdeJson(f.departamento),
      celular: celdaTexto(p?.celular),
      correo: celdaTexto(p?.correo),
      organismoDettoCiudad: ciudadDeOrganismo(f.organismoCodigo),
    };
  });
}

/** `impuestos_YYYYMMDD-HHmm.xlsx`, con la hora de Colombia y sin nada del filtro dentro. */
export function nombreArchivoExportImpuestos(ahora: Date = new Date()): string {
  return nombreArchivoColaExport('impuestos', ahora);
}
