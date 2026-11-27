// Épica #14548 (ADR-0051) — Servicio del visor de solo lectura de consumo de IA (bloque A: catálogos, búsqueda, detalle).
// Reglas del visor:
//   1. Ninguna lectura sale de la ventana `IA_CONSUMO_VISOR_VENTANA_MESES` (D8): búsqueda, detalle y relacionados.
//   2. Las consultas no seleccionan texto. Prompt y respuesta viven en `ia_consumo_detalle` y aquí solo se miden
//      (`octet_length`) o se comprueba si existen (`EXISTS`).
//   3. Cada consulta corre en una transacción de solo lectura con `statement_timeout` de 10 s; SQLSTATE 57014 → 503.
//   4. Los errores son `IaConsumoError`; la ruta los traduce a HTTP. El servicio no toca `req`.
import { createHash } from 'node:crypto';
import { and, desc, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  IA_PAGINA, IA_RANGO_MAX_DIAS, type IaBusquedaRespuesta, type IaCatalogos, type IaRegistroDetalle, type IaRegistroLista,
  type IaVentana,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { iaConsumoDetalle, iaConsumoLog } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { normalizarPlacaIa } from '../../shared/ia-consumo/contexto.js';
import {
  MODULO_DESCONOCIDO, ORIGENES_IA, PROCESOS_IA_FLITO, PROVEEDORES_IA, RESULTADOS_IA, TIPOS_TAREA_IA,
} from '../../shared/ia-consumo/catalogo.js';
import { aIso, createdInRangeCondition, hoyColombia } from '../../shared/utils/fecha-rango.js';
import { esUuid } from '../../shared/utils/uuid.js';
import { IaConsumoError, MENSAJES_IA, mensajeFueraDeVentana } from './ia-consumo.errors.js';
import type { BuscarIaEntrada, FiltrosIaEntrada } from './ia-consumo.esquemas.js';

const log = loggerFor('ia-consumo-visor');

/** Bytes a partir de los que el texto puede venir recortado (la columna guarda hasta 64 KB). Aproximado. */
const UMBRAL_RECORTE_BYTES = 65_533;
/** Metadatos por encima de este tamaño no se devuelven. */
const METADATOS_MAX_BYTES = 4_096;
/** Registros de la misma correlación que acompañan al detalle. */
const RELACIONADOS_MAX = 20;
const DIA_MS = 86_400_000;

/**
 * Columnas de la lista: lista blanca explícita. Sin `error_mensaje` ni `metadatos` (van en el detalle) y sin ninguna
 * columna de `ia_consumo_detalle`.
 */
const COLUMNAS_LISTA = {
  id: iaConsumoLog.id,
  correlacionId: iaConsumoLog.correlacionId,
  intento: iaConsumoLog.intento,
  pasada: iaConsumoLog.pasada,
  fechaInicio: iaConsumoLog.fechaInicio,
  fechaFin: iaConsumoLog.fechaFin,
  latenciaMs: iaConsumoLog.latenciaMs,
  aplicativo: iaConsumoLog.aplicativo,
  servicio: iaConsumoLog.servicio,
  ambiente: iaConsumoLog.ambiente,
  tenantId: iaConsumoLog.tenantId,
  usuarioId: iaConsumoLog.usuarioId,
  usuarioLogin: iaConsumoLog.usuarioLogin,
  origen: iaConsumoLog.origen,
  modulo: iaConsumoLog.modulo,
  proceso: iaConsumoLog.proceso,
  tipoTarea: iaConsumoLog.tipoTarea,
  placa: iaConsumoLog.placa,
  entidadTipo: iaConsumoLog.entidadTipo,
  entidadId: iaConsumoLog.entidadId,
  archivoMime: iaConsumoLog.archivoMime,
  archivoBytes: iaConsumoLog.archivoBytes,
  archivoPaginas: iaConsumoLog.archivoPaginas,
  archivoSha256: iaConsumoLog.archivoSha256,
  proveedor: iaConsumoLog.proveedor,
  modeloSolicitado: iaConsumoLog.modeloSolicitado,
  modeloRespondido: iaConsumoLog.modeloRespondido,
  idRespuestaProveedor: iaConsumoLog.idRespuestaProveedor,
  maxTokens: iaConsumoLog.maxTokens,
  promptCodigo: iaConsumoLog.promptCodigo,
  promptVersion: iaConsumoLog.promptVersion,
  promptHash: iaConsumoLog.promptHash,
  httpStatus: iaConsumoLog.httpStatus,
  resultado: iaConsumoLog.resultado,
  stopReason: iaConsumoLog.stopReason,
  errorCodigo: iaConsumoLog.errorCodigo,
  tokensEntrada: iaConsumoLog.tokensEntrada,
  tokensSalida: iaConsumoLog.tokensSalida,
  tokensCacheLectura: iaConsumoLog.tokensCacheLectura,
  tokensCacheEscritura: iaConsumoLog.tokensCacheEscritura,
  costoUsdEstimado: iaConsumoLog.costoUsdEstimado,
} as const;

const CLAVES_LISTA = Object.keys(COLUMNAS_LISTA) as (keyof typeof COLUMNAS_LISTA)[];

/**
 * Lo que el detalle añade. Los tamaños salen de `octet_length` en la base; el texto nunca se trae. `metadatos` solo se
 * devuelve si su tamaño cabe en `METADATOS_MAX_BYTES`.
 */
const CALCULADAS_DETALLE = {
  bytesPrompt: sql<number | null>`(SELECT octet_length(${iaConsumoDetalle.promptTexto}) FROM ${iaConsumoDetalle} WHERE ${iaConsumoDetalle.consumoId} = ${iaConsumoLog.id})`,
  bytesRespuesta: sql<number | null>`(SELECT octet_length(${iaConsumoDetalle.respuestaTexto}) FROM ${iaConsumoDetalle} WHERE ${iaConsumoDetalle.consumoId} = ${iaConsumoLog.id})`,
  tieneContenido: sql<boolean>`EXISTS (SELECT 1 FROM ${iaConsumoDetalle} WHERE ${iaConsumoDetalle.consumoId} = ${iaConsumoLog.id})`,
  metadatosBytes: sql<number | null>`octet_length(${iaConsumoLog.metadatos}::text)`,
  metadatos: sql<Record<string, unknown> | null>`CASE WHEN octet_length(${iaConsumoLog.metadatos}::text) <= ${METADATOS_MAX_BYTES} THEN ${iaConsumoLog.metadatos} END`,
};

type FilaLog = typeof iaConsumoLog.$inferSelect;
type FilaLista = Pick<FilaLog, keyof typeof COLUMNAS_LISTA>;
type FilaDetalle = FilaLista & Pick<FilaLog, 'errorMensaje'> & {
  bytesPrompt: number | null;
  bytesRespuesta: number | null;
  tieneContenido: boolean;
  metadatosBytes: number | null;
  metadatos: Record<string, unknown> | null;
};
/** Una fila de la lista con el instante exacto en texto (UTC, microsegundos), para el cursor. */
type FilaBusqueda = FilaLista & { fechaCursor: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function codigoPg(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } } | undefined;
  return x?.code ?? x?.cause?.code;
}

/** Corre `fn` en una transacción de solo lectura con `statement_timeout` de 10 s. */
async function enLecturaAcotada<R>(fn: (tx: Tx) => Promise<R>): Promise<R> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      return fn(tx);
    });
  } catch (e) {
    const code = codigoPg(e);
    if (code === '57014') throw new IaConsumoError('consulta_demasiado_lenta', MENSAJES_IA.consulta_demasiado_lenta);
    log.error({ code }, 'consulta del visor de consumo de IA falló');
    throw e;
  }
}

/** Días naturales entre dos `YYYY-MM-DD`, ambos extremos incluidos. */
function diasInclusivos(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
}

/**
 * Ventana de `meses` meses hasta `hoy`. Si el día no existe en el mes de inicio, se usa el último día de ese mes
 * (`2026-05-31` − 3 meses = `2026-02-28`).
 */
export function calcularVentana(hoy: string, meses: number): IaVentana {
  const [anio, mes, dia] = hoy.split('-').map(Number) as [number, number, number];
  const primerDia = new Date(Date.UTC(anio, mes - 1 - meses, 1));
  const anioInicio = primerDia.getUTCFullYear();
  const mesInicio = primerDia.getUTCMonth();
  const ultimoDia = new Date(Date.UTC(anioInicio, mesInicio + 1, 0)).getUTCDate();
  const desde = new Date(Date.UTC(anioInicio, mesInicio, Math.min(dia, ultimoDia))).toISOString().slice(0, 10);
  return { desde, hasta: hoy, meses };
}

/** La ventana vigente: `IA_CONSUMO_VISOR_VENTANA_MESES` meses hasta hoy en Colombia. */
export function ventanaVigente(ahora: Date = new Date()): IaVentana {
  return calcularVentana(hoyColombia(ahora), env.IA_CONSUMO_VISOR_VENTANA_MESES);
}

/**
 * Valida el rango de una consulta. No intercambia fechas: `desde > hasta` es un error (no se corrige en silencio).
 * El orden de las comprobaciones es el de §8.5 del diseño.
 */
export function validarRango(
  rango: { desde?: string; hasta?: string },
  ventana: IaVentana,
  hoy: string,
): { desde: string; hasta: string } {
  const { desde, hasta } = rango;
  if (!desde || !hasta) throw new IaConsumoError('rango_invalido', MENSAJES_IA.rango_invalido);
  if (desde > hasta || hasta > hoy) throw new IaConsumoError('rango_invalido', MENSAJES_IA.rango_invalido);
  if (desde < ventana.desde) throw new IaConsumoError('fuera_de_ventana', mensajeFueraDeVentana(ventana.desde, ventana.meses));
  if (diasInclusivos(desde, hasta) > IA_RANGO_MAX_DIAS) {
    throw new IaConsumoError('rango_demasiado_amplio', MENSAJES_IA.rango_demasiado_amplio);
  }
  return { desde, hasta };
}

const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Condiciones de los filtros, con los valores bindeados. `usuario` casa el login o el id, exacto y sin distinguir
 * mayúsculas. `modelo` casa el respondido o, si no hay, el solicitado, con o sin sufijo de fecha (`-20251001`).
 */
export function condicionesDeFiltros(filtros: FiltrosIaEntrada = {}): SQL[] {
  const condiciones: SQL[] = [];
  if (filtros.usuario !== undefined) {
    condiciones.push(or(
      sql`lower(${iaConsumoLog.usuarioLogin}) = lower(${filtros.usuario})`,
      sql`lower(${iaConsumoLog.usuarioId}) = lower(${filtros.usuario})`,
    )!);
  }
  if (filtros.placa !== undefined) condiciones.push(eq(iaConsumoLog.placa, normalizarPlacaIa(filtros.placa)!));
  if (filtros.entidad !== undefined) condiciones.push(eq(iaConsumoLog.entidadId, filtros.entidad));
  if (filtros.origen !== undefined) condiciones.push(eq(iaConsumoLog.origen, filtros.origen));
  if (filtros.modulo !== undefined) condiciones.push(eq(iaConsumoLog.modulo, filtros.modulo));
  if (filtros.proceso !== undefined) condiciones.push(eq(iaConsumoLog.proceso, filtros.proceso));
  if (filtros.tipoTarea !== undefined) condiciones.push(eq(iaConsumoLog.tipoTarea, filtros.tipoTarea));
  if (filtros.proveedor !== undefined) condiciones.push(eq(iaConsumoLog.proveedor, filtros.proveedor));
  if (filtros.resultado !== undefined) condiciones.push(eq(iaConsumoLog.resultado, filtros.resultado));
  if (filtros.modelo !== undefined) {
    const patron = `^${escaparRegex(filtros.modelo)}(-[0-9]{8})?$`;
    condiciones.push(sql`coalesce(${iaConsumoLog.modeloRespondido}, ${iaConsumoLog.modeloSolicitado}) ~ ${patron}`);
  }
  return condiciones;
}

/** Huella de la búsqueda: un cursor solo vale con las mismas fechas y los mismos filtros. */
function firmaBusqueda(desde: string, hasta: string, filtros: FiltrosIaEntrada = {}): string {
  const ordenados = Object.fromEntries(
    Object.entries(filtros).filter(([, valor]) => valor !== undefined).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify({ desde, hasta, filtros: ordenados })).digest('hex').slice(0, 16);
}

/**
 * Instante en UTC con microsegundos (`2026-11-20T20:03:12.123789Z`), en formato fijo que produce `to_char` en la base.
 * No depende del `DateStyle` ni de la zona de la sesión, y conserva la precisión de PostgreSQL (el JS solo llega al ms).
 */
const FECHA_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function codificarCursor(fecha: string, id: string, firma: string): string {
  return Buffer.from(JSON.stringify({ f: fecha, i: id, h: firma })).toString('base64url');
}

function decodificarCursor(cursor: string, firma: string): { fecha: string; id: string } {
  const invalido = (): IaConsumoError => new IaConsumoError('cursor_invalido', MENSAJES_IA.cursor_invalido);
  let datos: unknown;
  try {
    datos = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalido();
  }
  const { f, i, h } = (datos ?? {}) as { f?: unknown; i?: unknown; h?: unknown };
  if (typeof f !== 'string' || !FECHA_CURSOR.test(f) || !esUuid(i) || h !== firma) throw invalido();
  return { fecha: f, id: i };
}

/** Catálogos cerrados y la ventana vigente. Sin datos de registros. */
export function catalogosVisor(ahora: Date = new Date()): IaCatalogos {
  const procesos = Object.entries(PROCESOS_IA_FLITO).map(([proceso, { modulo }]) => ({ proceso, modulo }));
  const modulos = [...new Set([...procesos.map((p) => p.modulo), MODULO_DESCONOCIDO])].sort();
  return {
    origenes: [...ORIGENES_IA],
    resultados: [...RESULTADOS_IA],
    tiposTarea: [...TIPOS_TAREA_IA],
    proveedores: [...PROVEEDORES_IA],
    procesos,
    modulos,
    ventana: ventanaVigente(ahora),
  };
}

/** Lista paginada (50 por página, sin total) ordenada por `(fecha_inicio, id)` descendente. */
export async function buscarRegistros(entrada: BuscarIaEntrada, ahora: Date = new Date()): Promise<IaBusquedaRespuesta> {
  const ventana = ventanaVigente(ahora);
  const rango = validarRango({ desde: entrada.desde, hasta: entrada.hasta }, ventana, hoyColombia(ahora));
  const firma = firmaBusqueda(rango.desde, rango.hasta, entrada.filtros);
  const condiciones: SQL[] = [createdInRangeCondition(iaConsumoLog.fechaInicio, rango)!, ...condicionesDeFiltros(entrada.filtros)];
  if (entrada.cursor !== undefined) {
    const { fecha, id } = decodificarCursor(entrada.cursor, firma);
    condiciones.push(sql`(${iaConsumoLog.fechaInicio}, ${iaConsumoLog.id}) < (${fecha}::timestamptz, ${id}::uuid)`);
  }
  const filas: FilaBusqueda[] = await enLecturaAcotada((tx) => tx
    .select({
      ...COLUMNAS_LISTA,
      fechaCursor: sql<string>`to_char(${iaConsumoLog.fechaInicio} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(iaConsumoLog)
    .where(and(...condiciones))
    .orderBy(desc(iaConsumoLog.fechaInicio), desc(iaConsumoLog.id))
    .limit(IA_PAGINA + 1));
  const pagina = filas.slice(0, IA_PAGINA);
  const ultima = pagina.at(-1);
  return {
    items: pagina.map(aRegistroLista),
    siguienteCursor: filas.length > IA_PAGINA && ultima ? codificarCursor(ultima.fechaCursor, ultima.id, firma) : null,
  };
}

/** Detalle de un registro dentro de la ventana. Fuera de ella, o inexistente: el mismo 404. */
export async function detalleRegistro(id: string, ahora: Date = new Date()): Promise<IaRegistroDetalle> {
  const ventana = ventanaVigente(ahora);
  const enVentana = createdInRangeCondition(iaConsumoLog.fechaInicio, { desde: ventana.desde, hasta: ventana.hasta })!;
  const encontrado = await enLecturaAcotada(async (tx) => {
    const [fila] = await tx
      .select({ ...COLUMNAS_LISTA, errorMensaje: iaConsumoLog.errorMensaje, ...CALCULADAS_DETALLE })
      .from(iaConsumoLog)
      .where(and(eq(iaConsumoLog.id, id), enVentana))
      .limit(1);
    if (!fila) return null;
    const relacionados: FilaLista[] = await tx
      .select(COLUMNAS_LISTA)
      .from(iaConsumoLog)
      .where(and(eq(iaConsumoLog.correlacionId, fila.correlacionId), ne(iaConsumoLog.id, id), enVentana))
      .orderBy(desc(iaConsumoLog.fechaInicio), desc(iaConsumoLog.id))
      .limit(RELACIONADOS_MAX);
    return { fila, relacionados };
  });
  if (!encontrado) throw new IaConsumoError('no_encontrado', MENSAJES_IA.no_encontrado);
  return aRegistroDetalle(encontrado.fila, encontrado.relacionados);
}

/** Solo las columnas de la lista blanca; las fechas, en ISO. Ningún campo de detalle se cuela aquí. */
function aRegistroLista(fila: FilaLista): IaRegistroLista {
  const campos = Object.fromEntries(CLAVES_LISTA.map((clave) => [clave, fila[clave]])) as Omit<FilaLista, 'fechaInicio' | 'fechaFin'>;
  return {
    ...campos,
    fechaInicio: aIso(fila.fechaInicio) ?? '',
    fechaFin: aIso(fila.fechaFin) ?? '',
  };
}

function aRegistroDetalle(fila: FilaDetalle, relacionados: FilaLista[]): IaRegistroDetalle {
  const posiblementeRecortado = (fila.bytesPrompt ?? 0) >= UMBRAL_RECORTE_BYTES || (fila.bytesRespuesta ?? 0) >= UMBRAL_RECORTE_BYTES;
  return {
    ...aRegistroLista(fila),
    errorMensaje: fila.errorMensaje,
    metadatos: fila.metadatos,
    metadatosBytes: fila.metadatosBytes,
    tieneContenido: fila.tieneContenido,
    bytesPrompt: fila.bytesPrompt,
    bytesRespuesta: fila.bytesRespuesta,
    posiblementeRecortado,
    relacionados: relacionados.map(aRegistroLista),
  };
}
