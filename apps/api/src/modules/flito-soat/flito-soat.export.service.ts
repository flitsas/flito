// FLITO SOAT — export a Excel de la cola filtrada (Feature #11908, HU #11909, #11934).
//
// La segunda lectura de `flito_soat` del módulo, y no es la de `cola()`: aquella pagina y devuelve el
// DTO que pinta una pantalla; esta entrega el conjunto entero una sola vez y con las veinticinco
// columnas del archivo. Lo único que comparten —y por eso vive en el servicio del listado, no aquí— es
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
import { flitoCompradores, flitoSoat, flitoTramites, vehicles } from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  celdaTexto, CONSTANTES_COLA_EXPORT, ExportColaDemasiadoGrandeError, nombreArchivoColaExport,
  type FilaColaExport,
} from '../../shared/export/cola-flito-excel.js';
import {
  bloqueTitular, celdaDesdeJson, ciudadDeOrganismo, clavePar, expresionesFlitRaw, parDeClave,
  TITULAR_VACIO, type BloqueTitular,
} from '../../shared/export/cola-flito-derivados.js';
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
  // Los tres datos técnicos salen de `vehicles` y no de `flit_raw`, y es la única vía que sirve: las
  // filas del canal Cliente tienen `vehiculo_id` pero NO trámite, así que no tienen payload. El sync
  // ya los aterriza ahí (HU #11906) y el canal los escribe desde el RUNT (ADR-0008 §1.6).
  carroceria: vehicles.carroceria,
  servicio: vehicles.tipoServicio,
  cilindraje: vehicles.cilindraje,
  // **`flito_soat.organismo_codigo` y NO `flit_raw->>'codigoSecretaria'`** — ver `ciudadDeOrganismo`:
  // el del payload llega sin el cero de relleno en la mitad de las filas y dejaría la ciudad vacía
  // sin que nada fallara. Esta columna la normalizó el sync y existe también en el canal Cliente.
  organismoCodigo: flitoSoat.organismoCodigo,
} as const;

/**
 * Columnas de `flito_compradores` que el archivo necesita.
 *
 * **`nombre_completo` sigue SIN estar, aunque la hoja de la HU #11934 ya publique el nombre del
 * titular.** No es una contradicción: el nombre del archivo sale de `flit_raw` —`nombres` y
 * `apellidos` SEPARADOS, tal como los manda FLIT— y esta columna es lo contrario, los dos fundidos
 * en una sola cadena por `flit-http.adapter.ts:74`. Partirla por el espacio para rellenar
 * `NombrePila` y `Apellidos` sería una heurística sobre un dato que ya viene desagregado en origen, y
 * fallaría en cada nombre compuesto y en cada razón social. Leerla «por si acaso» sería además
 * traerse al proceso una copia peor del mismo dato personal.
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

/** Las ocho expresiones `->>` sobre `flito_tramites.flit_raw`, definidas una sola vez para el repo. */
const RAW = expresionesFlitRaw(flitoTramites.flitRaw);

/**
 * Un trámite del lote: su id (para colgar al propietario), su SOAT y todo lo que el archivo saca de
 * ÉL —tres columnas propias y las ocho claves del payload—.
 *
 * Los ocho campos del `jsonb` se tipan `unknown` y no `string | null` a propósito: `->>` devuelve
 * texto en PostgreSQL, pero el tipo de una expresión `sql<...>` es una promesa de TypeScript que
 * nadie comprueba en ejecución y el origen es JSON de un tercero. `celdaDesdeJson` es quien decide
 * qué llega a la celda; declarar `string` aquí solo serviría para que el compilador dejara pasar un
 * `.trim()` sobre un número.
 */
interface TramiteDeSoat {
  id: string;
  soatId: string | null;
  municipio: string | null;
  organismoDetto: string | null;
  marca: unknown;
  linea: unknown;
  modelo: unknown;
  clase: unknown;
  capacidad: unknown;
  departamento: unknown;
  nombres: unknown;
  apellidos: unknown;
}

/**
 * Los trámites de este lote de SOAT, en UNA sola lectura.
 *
 * **Aquí no hay `innerJoin` a `flito_tramites` en la consulta principal, y es la decisión que
 * sostiene la corrección del archivo.** Un SOAT es por VIN y puede servir a VARIOS trámites (RN-01),
 * así que unir allí multiplicaría la fila del SOAT una vez por trámite: el `.xlsx` traería 800 filas
 * para 500 SOAT —pasando todos los asertos de columnas sin despeinarse— y, peor, el conteo contra el
 * tope contaría duplicados, de modo que un filtro legítimo podría recibir un 422.
 *
 * **La HU #11934 no cambió eso: colgó de esta MISMA lectura las nueve columnas nuevas del trámite.**
 * Añadir aquí ocho expresiones y un campo cuesta cero consultas más; tocar `conJoinsCola` para traer
 * lo mismo habría metido el join que este comentario existe para no tener, y además habría cambiado
 * el predicado que el export comparte con la pantalla.
 *
 * `flit_raw` **no se proyecta entera**: una expresión `->>` por clave (RN-E1). Traerla completa serían
 * 27 claves × 2 000 filas en el heap para escribir seis celdas.
 */
async function tramitesDe(ids: string[]): Promise<TramiteDeSoat[]> {
  if (ids.length === 0) return [];
  return db.select({
    id: flitoTramites.id,
    soatId: flitoTramites.soatId,
    // `Municipio` es el mismo `flito_tramites.ciudad` que la hoja de once columnas rotulaba
    // `CIUDAD`: cambia la cabecera, no el origen ni la reconciliación.
    municipio: flitoTramites.ciudad,
    // `OrganismoDetto` = el nombre CRUDO que manda FLIT, no el alias configurado en FLITO.
    organismoDetto: flitoTramites.transitoNombreFlit,
    ...RAW,
  }).from(flitoTramites).where(inArray(flitoTramites.soatId, ids));
}

/** Lo que el archivo saca del trámite, ya reconciliado para UN SOAT. */
interface DatosDeTramite {
  municipio: string | null;
  organismoDetto: string | null;
  marca: string | null;
  linea: string | null;
  modelo: string | null;
  clase: string | null;
  capacidad: string | null;
  departamento: string | null;
  titular: BloqueTitular;
}

/** Lo que se escribe cuando un SOAT no tiene trámite: el canal Cliente. */
const SIN_TRAMITE: DatosDeTramite = {
  municipio: null, organismoDetto: null, marca: null, linea: null, modelo: null,
  clase: null, capacidad: null, departamento: null, titular: TITULAR_VACIO,
};

/**
 * Los datos de trámite de cada SOAT, cada campo reconciliado con `comun()`.
 *
 * Cuando los trámites de un mismo SOAT discrepan en un campo, ese campo es `null` y la celda va
 * vacía: es la misma respuesta honesta que da la cola con `tipoTramite` y `fechaAprobacion`. Elegir
 * el del primer trámite pondría en el archivo un dato con aspecto de cierto que depende del orden de
 * la consulta. Las filas del canal Cliente no tienen trámite y por tanto no tienen ninguno de estos
 * nueve valores; eso es lo esperado y no un hueco a rellenar — sus otras doce columnas sí se llenan
 * y la fila sale igual.
 *
 * ── `nombres` y `apellidos` se reconcilian COMO PAR, con UN solo `comun()` ───────────────────────
 *
 * Es la trampa cara de esta mitad de la HU. Dos `comun()` independientes sobre dos trámites que
 * coinciden en `nombres` y difieren en `apellidos` devolverían el nombre con el apellido en blanco,
 * y **esa fila se clasificaría como persona JURÍDICA metiendo el nombre de pila de alguien en la
 * columna `RazonSocial`** — con su `ClaseId` diciendo `NIT`. No lanza, no avisa y no lo ve ningún
 * aserto de columnas. Se reconcilia la TUPLA (`clavePar`) y se clasifica después (`bloqueTitular`).
 */
function datosDeTramitePorSoat(tramites: TramiteDeSoat[]): Map<string, DatosDeTramite> {
  const porSoat = new Map<string, TramiteDeSoat[]>();
  for (const t of tramites) {
    if (!t.soatId) continue;
    const arr = porSoat.get(t.soatId) ?? [];
    arr.push(t); porSoat.set(t.soatId, arr);
  }

  const salida = new Map<string, DatosDeTramite>();
  for (const [soatId, ts] of porSoat) {
    salida.set(soatId, {
      municipio: comun(ts, (t) => celdaTexto(t.municipio)),
      organismoDetto: comun(ts, (t) => celdaTexto(t.organismoDetto)),
      marca: comun(ts, (t) => celdaDesdeJson(t.marca)),
      linea: comun(ts, (t) => celdaDesdeJson(t.linea)),
      modelo: comun(ts, (t) => celdaDesdeJson(t.modelo)),
      clase: comun(ts, (t) => celdaDesdeJson(t.clase)),
      capacidad: comun(ts, (t) => celdaDesdeJson(t.capacidad)),
      departamento: comun(ts, (t) => celdaDesdeJson(t.departamento)),
      titular: bloqueTitular(parDeClave(comun(ts, (t) => clavePar(t.nombres, t.apellidos)))),
    });
  }
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
  const datos = datosDeTramitePorSoat(tramites);
  const propietarios = await propietariosDe(
    filas.map((f) => ({ id: f.id, origen: f.origen })),
    tramites,
  );

  return filas.map((f) => {
    const p = propietarios.get(f.id);
    const d = datos.get(f.id) ?? SIN_TRAMITE;
    // El orden de las claves es el de `COLUMNAS_COLA_EXPORT` para que las dos listas se lean juntas,
    // pero NO es lo que ordena el archivo: ExcelJS empareja por `key`, y quien mueva una columna allí
    // sin moverla aquí no rompe nada — solo cambia el sitio en que se lee esta.
    return {
      vin: celdaTexto(f.vin),
      placa: celdaTexto(f.placa),
      modelo: d.modelo,
      servicio: celdaTexto(f.servicio),
      marca: d.marca,
      linea: d.linea,
      clase: d.clase,
      carroceria: celdaTexto(f.carroceria),
      cilindraje: celdaTexto(f.cilindraje),
      capacidadCargaOPasajeros: d.capacidad,
      puertas: CONSTANTES_COLA_EXPORT.puertas,
      organismoDetto: d.organismoDetto,
      nI: CONSTANTES_COLA_EXPORT.nI,
      // Las cinco del titular se escriben JUNTAS desde un solo objeto y no campo a campo: son una
      // decisión única de tres estados (ver `bloqueTitular`) y repartirlas aquí volvería a abrir la
      // puerta a que una fila salga `PJUR` con la razón social vacía.
      claseDeInterlocutor: d.titular.claseDeInterlocutor,
      nombrePila: d.titular.nombrePila,
      apellidos: d.titular.apellidos,
      razonSocial: d.titular.razonSocial,
      claseId: d.titular.claseId,
      // Sin propietario registrado, estas cuatro celdas van vacías y **la fila SALE igual**. Es el
      // motivo por el que el propietario se lee en una consulta aparte y no con un JOIN: un `INNER
      // JOIN` sobre `flito_compradores` borraría del archivo, en silencio, cada SOAT al que le
      // falte el comprador — y son justo los que hay que revisar.
      numeroId: celdaTexto(p?.numeroDocumento),
      direccion: celdaTexto(p?.direccion),
      municipio: d.municipio,
      departamento: d.departamento,
      celular: celdaTexto(p?.celular),
      correo: celdaTexto(p?.correo),
      organismoDettoCiudad: ciudadDeOrganismo(f.organismoCodigo),
    };
  });
}

/** `soat_YYYYMMDD-HHmm.xlsx`, con la hora de Colombia y sin nada del filtro dentro. */
export function nombreArchivoExportSoat(ahora: Date = new Date()): string {
  return nombreArchivoColaExport('soat', ahora);
}
