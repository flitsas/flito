// FLITO comparendos — export a Excel del consolidado filtrado (Feature #11495 17b, HU #11558,
// CF-07, ADR-0004).
//
// La segunda lectura de `flito_comparendos_registros` que existe en el módulo, y no es la de
// `flito-comparendos.registros.service.ts` con otro formato: aquella pagina y devuelve el DTO que
// consume una pantalla; esta entrega el conjunto entero una sola vez, con las columnas del archivo.
// Lo único que comparten —y por eso vive allí, no aquí— es `condicionesDeFiltro`: qué significa
// cada filtro se decide en un solo sitio, o el `.xlsx` acabaría conteniendo algo distinto de lo que
// el visor enseña y nadie se enteraría hasta que un cliente comparase las dos cosas.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-42  El archivo NO lleva `payload_simit` ni `payload_municipal` (RN-31, ADR-0004 §5). Como en la
//        lectura, la consulta ni los selecciona: lo que no sale de la base no se puede publicar por
//        descuido más arriba. Las columnas son una LISTA BLANCA escrita a mano —no `Object.keys` de
//        la fila—, así que una columna sensible que alguien añada al esquema mañana no aparece en el
//        Excel por el hecho de existir.
//
// RN-43  El export tiene un TOPE DURO de filas (`COMPARENDOS_EXPORT_MAX_FILAS`, 5 000 por defecto,
//        ADR-0004 §2). Por encima no se entrega un archivo recortado: se lanza
//        `ComparendosExportDemasiadoGrandeError` y no se genera nada. Un export truncado en silencio
//        es peor que un error — el usuario concilia contra un conjunto que cree completo.
//
// RN-44  El tope se comprueba pidiendo `tope + 1` filas, no con un `count(*)` sobre el filtro. Es el
//        mismo truco de `listarRegistros`, y por los mismos dos motivos: el `count(*)` es la
//        consulta cara de esta tabla, y obligaría a recorrer el filtro dos veces para responder algo
//        que la fila 5 001 ya contesta.
//
// RN-45  **La comprobación del tope ocurre antes de que exista una sola fila del archivo, y eso no
//        depende del orden en que esté escrita la ruta.** Este servicio o devuelve las filas o
//        lanza; no hay forma de obtener lo primero sin haber pasado lo segundo. Es la garantía
//        estructural que pide el AC4: quien escriba la ruta no puede invertir el orden aunque
//        quiera, porque `sendExcel` necesita unas filas que solo existen si el tope se cumplió.
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA, como en toda lectura del módulo
// (RN-34): es el borde HTTP quien sabe quién pidió el archivo. Este servicio no toca `req`.

import { and, desc, eq } from 'drizzle-orm';
import type { ComparendosExportRequest } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComparendosCausales, flitoComparendosRegistros } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import { ComparendosExportDemasiadoGrandeError } from './flito-comparendos.errors.js';
import { condicionesDeFiltro } from './flito-comparendos.registros.service.js';

/**
 * Columnas del `.xlsx`, en orden y con el ancho con el que se pintan.
 *
 * Son las del visor (`TablaComparendos`) más las tres que allí viven en el panel de detalle y aquí
 * pide el AC2: la causal, la observación y cuándo se gestionó. Nada más entra: la lista es la
 * frontera del RN-42 y se lee de un vistazo, que es justo lo que un `Object.keys` de la fila no
 * permite.
 *
 * Dos decisiones sobre los valores que conviene tener a mano al leer la lista:
 *
 *   · **La causal sale por NOMBRE, no por `causalId`.** El visor pinta el nombre resolviéndolo
 *     contra el catálogo que ya tiene cargado; un archivo con 5 000 UUID no serviría para conciliar
 *     con nadie. De ahí el único `LEFT JOIN` de la consulta.
 *   · **El municipio sale por su `codigoFuente` («ITAGUI»), no por el nombre del catálogo.** Es el
 *     valor que el registro guarda y el mismo con el que se filtra, así que el archivo y la pantalla
 *     hablan del mismo dato aunque alguien renombre el municipio en la parametrización. Si en
 *     revisión se prefiere el nombre, es otro `LEFT JOIN` por `codigo_fuente` y una línea aquí.
 */
export const COLUMNAS_EXPORT: { header: string; key: string; width: number }[] = [
  { header: 'N.º comparendo', key: 'numeroComparendo', width: 24 },
  // Las dos de la HU #11712, pegadas al número porque son parte de la IDENTIDAD de la fila: dicen
  // qué es y con qué acto administrativo se convirtió en eso. `id_resolucion` no sale al archivo,
  // igual que no sale al API: es un identificador de sistema del proveedor.
  { header: 'Tipo', key: 'tipoRegistro', width: 12 },
  { header: 'N.º resolución', key: 'numeroResolucion', width: 20 },
  { header: 'Placa', key: 'placa', width: 12 },
  { header: 'NIT monitoreado', key: 'nitMonitoreado', width: 16 },
  { header: 'Fecha del comparendo', key: 'fechaComparendo', width: 18 },
  { header: 'Código infracción', key: 'codigoInfraccion', width: 14 },
  { header: 'Infracción', key: 'descripcionInfraccion', width: 40 },
  { header: 'Municipio', key: 'municipioFuente', width: 16 },
  { header: 'Organismo', key: 'organismo', width: 30 },
  { header: 'Monto', key: 'monto', width: 14 },
  { header: 'Estado', key: 'estado', width: 10 },
  { header: 'Estado en la fuente', key: 'estadoFuente', width: 18 },
  { header: 'Origen', key: 'origenMerge', width: 12 },
  { header: 'Causal', key: 'causal', width: 26 },
  { header: 'Observación', key: 'observacion', width: 50 },
  { header: 'Última gestión', key: 'gestionActualizadaEn', width: 18 },
  { header: 'Gestionado por (id usuario)', key: 'gestionActualizadaPor', width: 14 },
  { header: 'Registrado', key: 'primeraVistoEn', width: 18 },
  { header: 'Visto por última vez', key: 'ultimoVistoEn', width: 18 },
  { header: 'Inactivado', key: 'inactivadoEn', width: 18 },
];

/**
 * Proyección de la consulta. Escrita una a una como `COLUMNAS_REGISTRO` y por lo mismo (RN-42):
 * `select()` traería la fila entera con los dos payloads dentro.
 */
const COLUMNAS_CONSULTA = {
  numeroComparendo: flitoComparendosRegistros.numeroComparendo,
  tipoRegistro: flitoComparendosRegistros.tipoRegistro,
  numeroResolucion: flitoComparendosRegistros.numeroResolucion,
  placa: flitoComparendosRegistros.placa,
  nitMonitoreado: flitoComparendosRegistros.nitMonitoreado,
  fechaComparendo: flitoComparendosRegistros.fechaComparendo,
  codigoInfraccion: flitoComparendosRegistros.codigoInfraccion,
  descripcionInfraccion: flitoComparendosRegistros.descripcionInfraccion,
  municipioFuente: flitoComparendosRegistros.municipioFuente,
  organismo: flitoComparendosRegistros.organismo,
  monto: flitoComparendosRegistros.monto,
  estado: flitoComparendosRegistros.estado,
  estadoFuente: flitoComparendosRegistros.estadoFuente,
  origenMerge: flitoComparendosRegistros.origenMerge,
  causalNombre: flitoComparendosCausales.nombre,
  observacion: flitoComparendosRegistros.observacion,
  gestionActualizadaEn: flitoComparendosRegistros.gestionActualizadaEn,
  gestionActualizadaPor: flitoComparendosRegistros.gestionActualizadaPor,
  primeraVistoEn: flitoComparendosRegistros.primeraVistoEn,
  ultimoVistoEn: flitoComparendosRegistros.ultimoVistoEn,
  inactivadoEn: flitoComparendosRegistros.inactivadoEn,
} as const;

/** Etiquetas de `origen_merge`, las mismas que pinta el visor: el archivo no inventa vocabulario. */
const ETIQUETA_ORIGEN: Record<string, string> = {
  simit: 'SIMIT',
  municipal: 'Municipal',
  ambos: 'Ambos',
};

/**
 * Y las de `tipo_registro` (HU #11712). **No lleva entrada para `null`**: una fila sin tipo deja la
 * celda VACÍA y nunca dice «Comparendo». `null` es «no se sabe» —el histórico anterior a la 0160, y
 * de las filas `inactivo` nadie va a volver a saberlo (CF-10)—, así que escribir ahí la palabra
 * convertiría una laguna en un dato verificado dentro de un archivo que sale del perímetro y que
 * alguien va a conciliar. Vacío es además lo que Excel sabe filtrar.
 */
const ETIQUETA_TIPO_REGISTRO: Record<string, string> = {
  comparendo: 'Comparendo',
  multa: 'Multa',
};

/** Y las de `estado`, que en la pantalla son un chip y aquí tienen que ser una palabra. */
const ETIQUETA_ESTADO: Record<string, string> = {
  activo: 'Activo',
  inactivo: 'Inactivo',
};

/**
 * Instantes en hora de COLOMBIA y no en la del servidor (que es UTC).
 *
 * Es la misma decisión que tomó el visor: quien abre el archivo lee «09:00» y entiende las nueve de
 * la mañana de su jornada. Escribirlos en UTC desplazaría cada gestión cinco horas sin avisar, y en
 * un archivo —a diferencia de una pantalla— no hay nada alrededor que delate la zona.
 *
 * Sale como TEXTO `YYYY-MM-DD HH:mm` y no como celda de fecha de Excel: una celda de fecha se
 * reinterpreta con la zona y el formato regional de quien la abre, que es exactamente lo que aquí no
 * se quiere. El orden ISO conserva además la ordenación alfabética = cronológica.
 */
const FORMATO_INSTANTE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_COLOMBIA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function instanteColombia(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  // No siempre es un `Date` aunque la columna lo sea: una fila que venga de una expresión cruda
  // llega como la cadena del driver (ver `aIso` en `shared/utils/fecha-rango.ts`).
  const fecha = valor instanceof Date ? valor : new Date(String(valor));
  if (Number.isNaN(fecha.getTime())) return null;

  // Se arma por PARTES y no recortando el `format()`: entre versiones de ICU el separador de
  // «2026-08-19, 09:00» cambia —coma, espacio estrecho, espacio duro—, y un `replace(', ', ' ')`
  // que un día no case dejaría la coma dentro de todas las celdas de fecha sin romper nada más.
  const p: Record<string, string> = {};
  for (const parte of FORMATO_INSTANTE.formatToParts(fecha)) p[parte.type] = parte.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * `numeric(14,2)` → número de Excel, para que el archivo se pueda SUMAR.
 *
 * El API entrega `monto` como cadena a propósito (pasar un `numeric` por el `double` de JavaScript
 * es cómo un importe pierde el último centavo), pero un Excel de conciliación con la columna de
 * importes en texto no suma, no ordena y no filtra por rango — deja de servir para lo que se pidió.
 * La conversión se hace aquí, en el borde donde el destino ya no es JSON.
 *
 * El guardia no es ceremonia: por encima de `MAX_SAFE_INTEGER / 100` la conversión sí perdería
 * centavos, así que ese valor —que ningún comparendo alcanza, pero la columna admite— se queda como
 * texto en lugar de convertirse en un número redondeado en silencio.
 */
const MONTO_MAX_EXACTO = Number.MAX_SAFE_INTEGER / 100;

function montoExcel(valor: string | null): number | string | null {
  if (valor === null || valor.trim() === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || Math.abs(n) > MONTO_MAX_EXACTO) return valor;
  return n;
}

/** Una fila del archivo, con las claves de {@link COLUMNAS_EXPORT}. */
export type FilaExport = Record<string, string | number | null>;

/**
 * Las filas del export, o el 422 (RN-43, RN-45).
 *
 * @param filtro El mismo del visor, ya validado, sin `limit` ni `cursor`: un export no pagina.
 * @throws ComparendosExportDemasiadoGrandeError si el filtro devuelve más del tope configurado. Se
 *         lanza ANTES de construir una sola fila, que es lo que hace imposible entregar un archivo
 *         truncado: no hay valor de retorno que escribir cuando el tope se pasa.
 */
export async function construirFilasExport(filtro: ComparendosExportRequest): Promise<FilaExport[]> {
  const tope = env.COMPARENDOS_EXPORT_MAX_FILAS;
  const condiciones = condicionesDeFiltro(filtro);
  // Filtro imposible (una placa que al normalizar no deja nada): archivo vacío, no tabla entera.
  if (condiciones === null) return [];

  const filas = await db.select(COLUMNAS_CONSULTA)
    .from(flitoComparendosRegistros)
    // `LEFT` y no `INNER`: la mayoría de los comparendos no tiene causal todavía, y un `INNER` los
    // dejaría fuera del archivo — el export de «lo que falta por gestionar» saldría vacío.
    .leftJoin(
      flitoComparendosCausales,
      eq(flitoComparendosRegistros.causalId, flitoComparendosCausales.id),
    )
    .where(condiciones.length === 0 ? undefined : and(...condiciones))
    // El mismo orden del listado (RN-32): el archivo tiene que leerse como la pantalla, del alta más
    // reciente a la más antigua. El desempate por `id` importa igual aquí — sin él, dos altas de la
    // misma corrida saldrían en el orden que quisiera PostgreSQL.
    .orderBy(desc(flitoComparendosRegistros.createdAt), desc(flitoComparendosRegistros.id))
    // Tope + 1 (RN-44): la fila sobrante no se entrega, solo demuestra que hay más.
    .limit(tope + 1);

  if (filas.length > tope) throw new ComparendosExportDemasiadoGrandeError(tope);

  return filas.map((f) => ({
    numeroComparendo: f.numeroComparendo,
    // El `null` se comprueba ANTES de buscar etiqueta, y por eso no basta con `?? f.tipoRegistro`:
    // sin tipo la celda va vacía (ver `ETIQUETA_TIPO_REGISTRO`). El `??` de la derecha es otra cosa
    // —un valor del enum que algún día no tenga etiqueta se pinta crudo en vez de desaparecer—.
    tipoRegistro: f.tipoRegistro === null ? null : ETIQUETA_TIPO_REGISTRO[f.tipoRegistro] ?? f.tipoRegistro,
    numeroResolucion: f.numeroResolucion,
    placa: f.placa,
    nitMonitoreado: f.nitMonitoreado,
    fechaComparendo: f.fechaComparendo,
    codigoInfraccion: f.codigoInfraccion,
    descripcionInfraccion: f.descripcionInfraccion,
    municipioFuente: f.municipioFuente,
    organismo: f.organismo,
    monto: montoExcel(f.monto),
    estado: ETIQUETA_ESTADO[f.estado] ?? f.estado,
    estadoFuente: f.estadoFuente,
    origenMerge: ETIQUETA_ORIGEN[f.origenMerge] ?? f.origenMerge,
    // `null` y no «Sin gestión»: una celda vacía es filtrable en Excel y un texto de relleno no.
    causal: f.causalNombre ?? null,
    observacion: f.observacion,
    gestionActualizadaEn: instanteColombia(f.gestionActualizadaEn),
    gestionActualizadaPor: f.gestionActualizadaPor,
    primeraVistoEn: instanteColombia(f.primeraVistoEn),
    ultimoVistoEn: instanteColombia(f.ultimoVistoEn),
    inactivadoEn: instanteColombia(f.inactivadoEn),
  }));
}

/**
 * Nombre del archivo: `comparendos_YYYYMMDD-HHmm.xlsx`, con la hora de Colombia (ADR-0004).
 *
 * Lleva marca de tiempo porque un export se repite —se afina el filtro y se vuelve a bajar— y tres
 * archivos llamados igual en la carpeta de descargas se convierten en `comparendos (2).xlsx`, que no
 * dice cuál es cuál. No lleva el filtro en el nombre a propósito: el NIT y la placa acabarían
 * escritos en el sistema de archivos del usuario y en cualquier adjunto que reenvíe.
 */
export function nombreArchivoExport(ahora: Date = new Date()): string {
  const sello = (instanteColombia(ahora) ?? '')
    .replace(/-/g, '').replace(':', '').replace(' ', '-');
  return `comparendos_${sello}.xlsx`;
}
