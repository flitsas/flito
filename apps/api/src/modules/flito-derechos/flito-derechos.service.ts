// FLITO Derechos de trámite — carga de recibos y cruce con el trámite (HU #10950).
//
// El derecho de trámite es lo que el organismo cobra por radicar. Hasta esta HU era una constante
// quemada en el reporte de costos; aquí se convierte en un dato leído del recibo del organismo.
//
// El pipeline es hermano del de recibos de impuestos (flito-recibos.service.ts): expandir → dedup por
// hash → OCR → cruce por placa → registrar o mandar a revisión. Dos diferencias que importan:
//
//  1. NO hay máquina de estados. El recibo llega ya pagado; no existe un "solicitado" contra el que
//     conciliar. Por eso el cruce es contra cualquier trámite vivo de esa placa, no contra un estado.
//  2. Una placa puede tener varios trámites. El concepto del recibo ("MATRICULA INICIAL", "PRENDA")
//     desempata; si aun así quedan varios, decide Operaciones en la cola de revisión — nunca el
//     sistema por su cuenta, porque asociar el pago al trámite equivocado descuadra la liquidación.

import { createHash } from 'crypto';
import { and, desc, eq, notInArray, or, isNull, sql } from 'drizzle-orm';
import {
  CampoDerechoTramite, CAMPOS_REQUERIDOS_DERECHO, ESTADOS_TRAMITE_FLITO_TERMINADOS,
  FlujoRevision, MotivoRevision, type ExtraccionDerechoTramite,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoDerechosPendientes, flitoDerechosTramite, flitoRevisiones, flitoSoportes,
  flitoTramites, organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { extraerDerechoTramite, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { expandirZips, type ArchivoPlano } from '../../shared/archivos/expandir-zip.js';
import { separarPaginas, nombrePagina, PdfDemasiadoGrandeError } from '../../shared/pdf/separar-paginas.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-derechos');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TIPO_SOPORTE_DERECHO = 'derecho_tramite';

/** Carpeta de los soportes que aún no cuelgan de una compañía (sin trámite o en revisión). */
const CARPETA_SIN_ASOCIAR = '_derechos-sin-asociar';

export type OrigenDerecho = 'manual' | 'drive';

export interface DerechoCtx { userId: number; username: string; role: string }

export class DerechoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ItemDerecho {
  archivo: string;
  placa: string | null;
  idFlit: string | null;
  registroId: string | null;
  valor: string | null;
  detalle: string;
}

export interface ResultadoDerechos {
  registrados: ItemDerecho[];
  enRevision: ItemDerecho[];
  duplicados: ItemDerecho[];
  pendientes: ItemDerecho[];
  /** Páginas que no eran una cuenta individual (portadas, resúmenes, hojas en blanco). */
  omitidas: ItemDerecho[];
  /** Archivos que no se pudieron procesar (corruptos, ilegibles). Nunca tumban el lote. */
  fallidos: ItemDerecho[];
}

const vacio = (): ResultadoDerechos => ({
  registrados: [], enRevision: [], duplicados: [], pendientes: [], omitidas: [], fallidos: [],
});

const item = (archivo: string, extra: Partial<ItemDerecho> = {}): ItemDerecho => ({
  archivo, placa: null, idFlit: null, registroId: null, valor: null, detalle: '', ...extra,
});

/** Comparación de llaves de texto: sin tildes, sin separadores, en mayúsculas. */
export function normalizarTexto(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * ¿Se leyó lo suficiente para registrar el pago? La placa es la llave del cruce y el valor es el
 * dato que va a la liquidación: ambos deben superar el umbral. Radicado, organismo y tipo se
 * extraen pero no bloquean — varían de formato entre organismos y su ausencia no impide saber
 * cuánto se pagó.
 */
export function evaluarDerecho(extraccion: ExtraccionDerechoTramite, umbral: number): Veredicto {
  const placa = extraccion[CampoDerechoTramite.PLACA];
  if (!placa?.valor || placa.confianza < umbral) {
    return {
      aprobada: false,
      motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La placa se leyó con confianza ${placa?.confianza ?? 0}, bajo el umbral de ${umbral}.`,
    };
  }
  const dudosos = CAMPOS_REQUERIDOS_DERECHO.filter((c) => {
    const e = extraccion[c];
    return !e || e.valor === null || e.confianza < umbral;
  });
  if (dudosos.length > 0) {
    return {
      aprobada: false,
      motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La lectura no superó el umbral de ${umbral} en: ${dudosos.join(', ')}.`,
    };
  }
  return { aprobada: true };
}

/**
 * ¿La página era una cuenta de cobro individual? El prompt devuelve todo en null ante un resumen o
 * una portada; sin placa NI valor no hay nada que registrar y tampoco es un error del usuario.
 */
function esPaginaSinContenido(e: ExtraccionDerechoTramite): boolean {
  return !e[CampoDerechoTramite.PLACA]?.valor && !e[CampoDerechoTramite.VALOR_TOTAL]?.valor;
}

// ─────────────────────────── Cruce con el trámite ────────────────────────────

export interface CandidatoTramite {
  tramiteId: string;
  idFlit: string;
  tipoTramite: string | null;
  organismoCodigo: string | null;
  companiaId: number | null;
  document: string | null;
  carpeta: string | null;
  yaTieneDerecho: boolean;
}

/** Trámites vivos de esa placa. `estado` nulo cuenta como vivo: aún no se ha clasificado. */
export async function buscarCandidatos(placa: string): Promise<CandidatoTramite[]> {
  return db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId,
    document: clients.document,
    carpeta: clients.flitoCarpetaStorage,
    yaTieneDerecho: sql<boolean>`${flitoDerechosTramite.id} is not null`,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(and(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarTexto(placa)}`,
      or(
        isNull(flitoTramites.estado),
        notInArray(flitoTramites.estado, [...ESTADOS_TRAMITE_FLITO_TERMINADOS]),
      ),
    ))
    .orderBy(desc(flitoTramites.createdAt));
}

/**
 * Desempata por el concepto del recibo cuando la placa tiene varios trámites. La comparación es por
 * contención en cualquier sentido porque el rótulo del organismo ("INSCRIPCION DE PRENDA") rara vez
 * coincide literal con el tipo que reporta FLIT ("PRENDA"). Si el concepto no discrimina —no está,
 * no casa con ninguno o casa con varios— devuelve la lista entera: decidirá una persona.
 */
export function desempatarPorTipo(candidatos: CandidatoTramite[], tipoRecibo: string | null): CandidatoTramite[] {
  const tipo = normalizarTexto(tipoRecibo);
  if (!tipo || candidatos.length <= 1) return candidatos;
  const casan = candidatos.filter((c) => {
    const t = normalizarTexto(c.tipoTramite);
    return t.length > 0 && (t.includes(tipo) || tipo.includes(t));
  });
  return casan.length === 1 ? casan : candidatos;
}

// ─────────────────────────── Carga ───────────────────────────────────────────

export interface OpcionesCarga {
  /** Organismo declarado por quien carga. Fija el umbral y la pista de prompt. Opcional. */
  organismoCodigo?: string | null;
  origen: OrigenDerecho;
}

/**
 * Carga masiva de recibos de derecho de trámite. Un archivo que falla no tumba el lote: se reporta
 * y se sigue con el resto (AC8).
 */
export async function cargarDerechos(
  archivos: ArchivoPlano[],
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<ResultadoDerechos> {
  const res = vacio();
  const { umbral, promptHint } = await parametrosOrganismo(opciones.organismoCodigo ?? null);

  const expandidos = await expandirZips(archivos);
  for (const archivo of expandidos) {
    try {
      for (const doc of await documentosDe(archivo)) {
        try {
          await procesarDocumento(doc, umbral, promptHint, opciones, ctx, res);
        } catch (e) {
          res.fallidos.push(item(doc.originalname, { detalle: (e as Error).message }));
        }
      }
    } catch (e) {
      const detalle = e instanceof PdfDemasiadoGrandeError
        ? e.message
        : `No se pudo leer el archivo: ${(e as Error).message}`;
      res.fallidos.push(item(archivo.originalname, { detalle }));
    }
  }
  return res;
}

/** Umbral y pista de prompt del organismo. Sin organismo declarado, los valores por defecto. */
async function parametrosOrganismo(codigo: string | null): Promise<{ umbral: number; promptHint: string | null }> {
  if (!codigo) return { umbral: umbralPara(null), promptHint: null };
  const [o] = await db.select({
    umbral: organismosTransitoConfig.flitoUmbralOcr,
    hint: organismosTransitoConfig.flitoOcrPromptHint,
  }).from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  return { umbral: umbralPara(o?.umbral ?? null), promptHint: o?.hint ?? null };
}

/** Un PDF consolidado se parte en páginas; lo demás viaja como un único documento. */
async function documentosDe(archivo: ArchivoPlano): Promise<ArchivoPlano[]> {
  if (!archivo.mimetype.includes('pdf')) return [archivo];
  const paginas = await separarPaginas(archivo.buffer);
  if (paginas.length <= 1) return [archivo];
  return paginas.map((p) => ({
    originalname: nombrePagina(archivo.originalname, p.numero),
    mimetype: 'application/pdf',
    buffer: p.buffer,
    size: p.buffer.length,
    rutaEnZip: archivo.rutaEnZip,
  }));
}

/** ¿Este archivo, byte por byte, ya está cargado y sin descartar? Devuelve el derecho al que fue. */
async function duplicadoPorHash(hash: string): Promise<{ derechoId: string | null } | null> {
  const [dup] = await db.select({ derechoId: flitoSoportes.derechoId })
    .from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.hash, hash),
      eq(flitoSoportes.tipo, TIPO_SOPORTE_DERECHO),
      eq(flitoSoportes.descartado, false),
    )).limit(1);
  return dup ?? null;
}

async function procesarDocumento(
  archivo: ArchivoPlano,
  umbral: number,
  promptHint: string | null,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
  res: ResultadoDerechos,
): Promise<void> {
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');

  const dupHash = await duplicadoPorHash(hash);
  if (dupHash) {
    res.duplicados.push(item(archivo.originalname, {
      registroId: dupHash.derechoId,
      detalle: 'Ese recibo ya está cargado: el archivo es idéntico a uno registrado antes.',
    }));
    return;
  }

  const doc: DocumentoAAnalizar = {
    nombreArchivo: archivo.originalname,
    contentType: archivo.mimetype,
    contenido: archivo.buffer,
    umbral,
  };
  const extraccion = await extraerDerechoTramite(doc, promptHint);
  await procesarExtraccion(archivo, hash, extraccion, umbral, opciones, ctx, res);
}

/**
 * Registra una lectura YA hecha, sin volver a pasar por el OCR.
 *
 * La usa el procesador de cuentas de cobro de Drive, que tiene su propio OCR página a página (y
 * genera además el Excel y los PDF por placa que Operaciones usa hoy): re-analizar cada página con
 * el extractor de este módulo duplicaría el gasto de OCR para llegar al mismo dato.
 */
export async function registrarDesdeExtraccion(
  archivo: ArchivoPlano,
  extraccion: ExtraccionDerechoTramite,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<ResultadoDerechos> {
  const res = vacio();
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');

  const dupHash = await duplicadoPorHash(hash);
  if (dupHash) {
    res.duplicados.push(item(archivo.originalname, {
      registroId: dupHash.derechoId,
      detalle: 'Ese recibo ya está cargado: el archivo es idéntico a uno registrado antes.',
    }));
    return res;
  }

  const { umbral } = await parametrosOrganismo(opciones.organismoCodigo ?? null);
  await procesarExtraccion(archivo, hash, extraccion, umbral, opciones, ctx, res);
  return res;
}

async function procesarExtraccion(
  archivo: ArchivoPlano,
  hash: string,
  extraccion: ExtraccionDerechoTramite,
  umbral: number,
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
  res: ResultadoDerechos,
): Promise<void> {
  // Portada, resumen o página en blanco: no es un error, simplemente no hay recibo que registrar.
  if (esPaginaSinContenido(extraccion)) {
    res.omitidas.push(item(archivo.originalname, {
      detalle: 'La página no es una cuenta de cobro individual (portada, resumen o en blanco).',
    }));
    return;
  }

  const placa = extraccion[CampoDerechoTramite.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);
  const valor = extraccion[CampoDerechoTramite.VALOR_TOTAL]?.valor ?? null;

  // Sin placa no hay llave de cruce y tampoco se puede dejar en pendientes (la placa es su índice):
  // el documento se archiva y se manda a revisión para que una persona diga a qué trámite pertenece.
  if (!placa) {
    const soporteId = await archivarSuelto(archivo, opciones, hash, ctx);
    await aRevision(soporteId, extraccion, {
      aprobada: false,
      motivo: MotivoRevision.SIN_LLAVE_DE_CRUCE,
      detalle: 'El recibo no permitió leer la placa, así que no se pudo asociar a ningún trámite.',
    }, null, null, ctx);
    res.enRevision.push(item(archivo.originalname, { valor, detalle: 'Sin placa legible: enviado a revisión.' }));
    return;
  }

  const candidatos = await buscarCandidatos(placa);

  // Sin trámite todavía: el recibo del organismo suele llegar antes que el trámite desde FLIT. Se
  // guarda con su archivo y sus datos, y la sincronización reintenta el cruce sola.
  if (candidatos.length === 0) {
    const soporteId = await archivarSuelto(archivo, opciones, hash, ctx);
    await guardarPendiente(soporteId, placa, extraccion, opciones);
    res.pendientes.push(item(archivo.originalname, {
      placa, valor,
      detalle: `El recibo dice placa ${placa}, que aún no corresponde a ningún trámite. Queda pendiente y se reintenta en cada sincronización.`,
    }));
    return;
  }

  const veredicto = evaluarDerecho(extraccion, umbral);
  const finalistas = desempatarPorTipo(candidatos, extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null);

  if (!veredicto.aprobada) {
    const unico = finalistas.length === 1 ? finalistas[0] : null;
    const soporteId = unico
      ? await archivar(unico, archivo, hash, ctx)
      : await archivarSuelto(archivo, opciones, hash, ctx);
    await aRevision(soporteId, extraccion, veredicto, unico?.tramiteId ?? null, placa, ctx);
    res.enRevision.push(item(archivo.originalname, {
      placa, valor, idFlit: unico?.idFlit ?? null, detalle: veredicto.detalle ?? 'En revisión.',
    }));
    return;
  }

  if (finalistas.length > 1) {
    const soporteId = await archivarSuelto(archivo, opciones, hash, ctx);
    const lista = finalistas.map((c) => c.idFlit).join(', ');
    await aRevision(soporteId, extraccion, {
      aprobada: false,
      motivo: MotivoRevision.CRUCE_AMBIGUO,
      detalle: `La placa ${placa} tiene ${finalistas.length} trámites vivos (${lista}) y el concepto del recibo no permite decidir cuál. Elige a cuál corresponde el pago.`,
    }, null, placa, ctx);
    res.enRevision.push(item(archivo.originalname, {
      placa, valor,
      detalle: `Varios trámites con la placa ${placa}: requiere que Operaciones elija.`,
    }));
    return;
  }

  const elegido = finalistas[0];

  // El derecho es uno por trámite: si ya tiene, este recibo es una segunda copia del mismo pago.
  if (elegido.yaTieneDerecho) {
    res.duplicados.push(item(archivo.originalname, {
      placa, valor, idFlit: elegido.idFlit,
      detalle: `El trámite ${elegido.idFlit} ya tiene registrado su derecho de trámite.`,
    }));
    return;
  }

  const advertencias = advertenciasDe(elegido, extraccion);
  const soporteId = await archivar(elegido, archivo, hash, ctx);
  const derechoId = await registrar(elegido, extraccion, soporteId, advertencias, opciones, ctx);

  res.registrados.push(item(archivo.originalname, {
    placa, valor, idFlit: elegido.idFlit, registroId: derechoId,
    detalle: advertencias.length > 0
      ? `Registrado con advertencias: ${advertencias.join(' ')}`
      : 'Registrado y asociado al trámite.',
  }));
}

/**
 * Discrepancias que no impiden registrar pero deben quedar trazadas. El tipo de trámite advierte y
 * no bloquea a propósito: los conceptos varían tanto entre organismos que exigir coincidencia
 * mandaría a revisión asociaciones que son correctas.
 */
export function advertenciasDe(cand: CandidatoTramite, extraccion: ExtraccionDerechoTramite): string[] {
  const out: string[] = [];
  const tipoRecibo = extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor;
  const t = normalizarTexto(tipoRecibo);
  const tc = normalizarTexto(cand.tipoTramite);
  if (t && tc && !t.includes(tc) && !tc.includes(t)) {
    out.push(`El concepto del recibo dice "${tipoRecibo}" y el trámite es "${cand.tipoTramite}".`);
  }
  const organismoRecibo = extraccion[CampoDerechoTramite.ORGANISMO]?.valor;
  if (organismoRecibo && cand.organismoCodigo === null) {
    out.push(`El recibo lo emite "${organismoRecibo}" y el trámite no tiene organismo emparejado.`);
  }
  return out;
}

// ─────────────────────────── Persistencia ────────────────────────────────────

async function archivar(cand: CandidatoTramite, archivo: ArchivoPlano, hash: string, ctx: DerechoCtx): Promise<string> {
  const carpeta = cand.companiaId !== null
    ? carpetaDe({ id: cand.companiaId, document: cand.document, flitoCarpetaStorage: cand.carpeta }, 'derechos-tramite')
    : `${CARPETA_SIN_ASOCIAR}/sin-compania`;
  const storageKey = await uploadEntityDocument(carpeta, cand.tramiteId, archivo.originalname, archivo.buffer, archivo.mimetype);
  return insertarSoporte(archivo, storageKey, hash, ctx);
}

/** Soporte que aún no cuelga de un trámite (pendiente o en revisión). */
async function archivarSuelto(archivo: ArchivoPlano, opciones: OpcionesCarga, hash: string, ctx: DerechoCtx): Promise<string> {
  const carpeta = `${CARPETA_SIN_ASOCIAR}/${opciones.organismoCodigo ?? 'sin-organismo'}`;
  const storageKey = await uploadEntityDocument(carpeta, opciones.origen, archivo.originalname, archivo.buffer, archivo.mimetype);
  return insertarSoporte(archivo, storageKey, hash, ctx);
}

async function insertarSoporte(archivo: ArchivoPlano, storageKey: string, hash: string, ctx: DerechoCtx): Promise<string> {
  const [s] = await db.insert(flitoSoportes).values({
    tipo: TIPO_SOPORTE_DERECHO,
    nombreArchivo: archivo.originalname,
    contentType: archivo.mimetype,
    storageKey,
    hash,
    tamanoBytes: archivo.size,
    subidoPorId: ctx.userId,
    subidoPorNombre: ctx.username,
  }).returning({ id: flitoSoportes.id });
  return s.id;
}

async function registrar(
  cand: CandidatoTramite,
  extraccion: ExtraccionDerechoTramite,
  soporteId: string,
  advertencias: string[],
  opciones: OpcionesCarga,
  ctx: DerechoCtx,
): Promise<string> {
  const valor = extraccion[CampoDerechoTramite.VALOR_TOTAL]?.valor ?? null;
  const fechaPago = extraccion[CampoDerechoTramite.FECHA_PAGO]?.valor ?? null;
  const radicado = extraccion[CampoDerechoTramite.NUMERO_RADICADO]?.valor ?? null;
  const tipoRecibo = extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null;

  return db.transaction(async (tx) => {
    const [d] = await tx.insert(flitoDerechosTramite).values({
      tramiteId: cand.tramiteId,
      organismoCodigo: cand.organismoCodigo,
      companiaId: cand.companiaId,
      valor,
      fechaPago,
      numeroRadicado: radicado,
      tipoTramiteRecibo: tipoRecibo,
      origen: opciones.origen,
      soporteId,
      extraccion,
      advertencias: advertencias.length > 0 ? advertencias : null,
      registradoPorId: ctx.userId,
    }).returning({ id: flitoDerechosTramite.id });

    await tx.update(flitoSoportes).set({ derechoId: d.id }).where(eq(flitoSoportes.id, soporteId));
    await auditEnTx(tx, ctx, d.id,
      `Derecho de trámite registrado (${opciones.origen}) para ${cand.idFlit}. Valor ${valor ?? '—'}, ` +
      `fecha ${fechaPago ?? '—'}, radicado ${radicado ?? '—'}. Soporte ${soporteId}.` +
      (advertencias.length > 0 ? ` Advertencias: ${advertencias.join(' ')}` : ''));
    return d.id;
  });
}

async function guardarPendiente(
  soporteId: string,
  placa: string,
  extraccion: ExtraccionDerechoTramite,
  opciones: OpcionesCarga,
): Promise<void> {
  await db.insert(flitoDerechosPendientes).values({
    placa: normalizarTexto(placa),
    soporteId,
    organismoCodigo: opciones.organismoCodigo ?? null,
    valor: extraccion[CampoDerechoTramite.VALOR_TOTAL]?.valor ?? null,
    fechaPago: extraccion[CampoDerechoTramite.FECHA_PAGO]?.valor ?? null,
    numeroRadicado: extraccion[CampoDerechoTramite.NUMERO_RADICADO]?.valor ?? null,
    tipoTramiteRecibo: extraccion[CampoDerechoTramite.TIPO_TRAMITE]?.valor ?? null,
    extraccion,
    origen: opciones.origen,
  });
}

async function aRevision(
  soporteId: string,
  extraccion: ExtraccionDerechoTramite,
  veredicto: Veredicto,
  registroId: string | null,
  placa: string | null,
  ctx: DerechoCtx,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(flitoRevisiones).values({
      modulo: FlujoRevision.DERECHOS,
      motivo: veredicto.motivo!,
      detalle: veredicto.detalle!,
      registroId,
      soporteId,
      placaSugerida: placa,
      extraccion,
      resuelto: false,
    });
    await auditEnTx(tx, ctx, registroId ?? soporteId,
      `Recibo de derecho de trámite a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
  });
}

async function auditEnTx(tx: Tx, ctx: DerechoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update',
    resource: 'flito_derecho_tramite', resourceId, detail,
  });
}

// ─────────────────────────── Pendientes ──────────────────────────────────────

export interface ResultadoReintento { revisados: number; asociados: number }

/**
 * Reintenta el cruce de los recibos que quedaron sin trámite. Se llama tras cada sincronización con
 * FLIT: el trámite que faltaba pudo haber llegado. Solo asocia cuando el cruce es inequívoco (un
 * único candidato sin derecho); si hay varios, el recibo sigue esperando en vez de arriesgar una
 * asociación equivocada — la misma regla que en la carga.
 */
export async function reintentarPendientes(ctx: DerechoCtx): Promise<ResultadoReintento> {
  const pendientes = await db.select().from(flitoDerechosPendientes)
    .where(eq(flitoDerechosPendientes.resuelto, false))
    .orderBy(flitoDerechosPendientes.createdAt);

  let asociados = 0;
  for (const p of pendientes) {
    const candidatos = await buscarCandidatos(p.placa);
    const finalistas = desempatarPorTipo(candidatos, p.tipoTramiteRecibo).filter((c) => !c.yaTieneDerecho);
    if (finalistas.length !== 1) {
      await db.update(flitoDerechosPendientes)
        .set({ intentos: p.intentos + 1, ultimoIntentoEn: new Date() })
        .where(eq(flitoDerechosPendientes.id, p.id));
      continue;
    }
    const elegido = finalistas[0];
    const extraccion = (p.extraccion ?? {}) as ExtraccionDerechoTramite;
    const derechoId = await registrar(
      elegido, extraccion, p.soporteId, advertenciasDe(elegido, extraccion),
      { origen: p.origen as OrigenDerecho, organismoCodigo: p.organismoCodigo }, ctx,
    );
    await db.update(flitoDerechosPendientes)
      .set({ resuelto: true, resueltoTramiteId: elegido.tramiteId, intentos: p.intentos + 1, ultimoIntentoEn: new Date() })
      .where(eq(flitoDerechosPendientes.id, p.id));
    asociados += 1;
    log.info({ pendienteId: p.id, derechoId, idFlit: elegido.idFlit }, 'Pendiente de derecho asociado a su trámite');
  }
  return { revisados: pendientes.length, asociados };
}

// ─────────────────────────── Consultas ───────────────────────────────────────

export interface FiltrosDerechos { buscar?: string; page?: number; pageSize?: number }

export async function listarDerechos(f: FiltrosDerechos = {}) {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
  const texto = f.buscar?.trim();
  const where = texto
    ? or(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${`%${normalizarTexto(texto)}%`}`,
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${`%${texto.toUpperCase()}%`}`,
    )
    : undefined;

  const base = db.select({
    id: flitoDerechosTramite.id,
    tramiteId: flitoDerechosTramite.tramiteId,
    idFlit: flitoTramites.idFlit,
    placa: vehicles.plate,
    organismoCodigo: flitoDerechosTramite.organismoCodigo,
    empresa: clients.name,
    valor: flitoDerechosTramite.valor,
    fechaPago: flitoDerechosTramite.fechaPago,
    numeroRadicado: flitoDerechosTramite.numeroRadicado,
    tipoTramiteRecibo: flitoDerechosTramite.tipoTramiteRecibo,
    origen: flitoDerechosTramite.origen,
    advertencias: flitoDerechosTramite.advertencias,
    soporteId: flitoDerechosTramite.soporteId,
    createdAt: flitoDerechosTramite.createdAt,
  }).from(flitoDerechosTramite)
    .innerJoin(flitoTramites, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoDerechosTramite.companiaId, clients.id));

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(flitoDerechosTramite)
    .innerJoin(flitoTramites, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .where(where);

  const items = await base.where(where)
    .orderBy(desc(flitoDerechosTramite.createdAt))
    .limit(pageSize).offset((page - 1) * pageSize);

  return { items, total: Number(total ?? 0), page, pageSize };
}

export async function listarPendientes() {
  return db.select({
    id: flitoDerechosPendientes.id,
    placa: flitoDerechosPendientes.placa,
    valor: flitoDerechosPendientes.valor,
    fechaPago: flitoDerechosPendientes.fechaPago,
    tipoTramiteRecibo: flitoDerechosPendientes.tipoTramiteRecibo,
    organismoCodigo: flitoDerechosPendientes.organismoCodigo,
    origen: flitoDerechosPendientes.origen,
    intentos: flitoDerechosPendientes.intentos,
    ultimoIntentoEn: flitoDerechosPendientes.ultimoIntentoEn,
    soporteId: flitoDerechosPendientes.soporteId,
    nombreArchivo: flitoSoportes.nombreArchivo,
    createdAt: flitoDerechosPendientes.createdAt,
  }).from(flitoDerechosPendientes)
    .innerJoin(flitoSoportes, eq(flitoDerechosPendientes.soporteId, flitoSoportes.id))
    .where(eq(flitoDerechosPendientes.resuelto, false))
    .orderBy(desc(flitoDerechosPendientes.createdAt));
}

/** Trámites candidatos de una placa, para que la cola de revisión ofrezca entre cuáles elegir. */
export async function candidatosDePlaca(placa: string) {
  const candidatos = await buscarCandidatos(placa);
  return candidatos.map((c) => ({
    tramiteId: c.tramiteId, idFlit: c.idFlit, tipoTramite: c.tipoTramite,
    organismoCodigo: c.organismoCodigo, yaTieneDerecho: c.yaTieneDerecho,
  }));
}

/** Registro de un trámite, si ya lo tiene. Lo usa la cola de revisión para no duplicar. */
export async function derechoDeTramite(tramiteId: string) {
  const [d] = await db.select().from(flitoDerechosTramite)
    .where(eq(flitoDerechosTramite.tramiteId, tramiteId)).limit(1);
  return d ?? null;
}

/** Alta desde la cola de revisión: una persona ya decidió a qué trámite pertenece el recibo. */
export async function registrarDesdeRevision(
  tramiteId: string,
  extraccion: ExtraccionDerechoTramite,
  soporteId: string,
  ctx: DerechoCtx,
): Promise<string> {
  const [cand] = await db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId,
    document: clients.document,
    carpeta: clients.flitoCarpetaStorage,
    yaTieneDerecho: sql<boolean>`${flitoDerechosTramite.id} is not null`,
  }).from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);

  if (!cand) throw new DerechoError(404, 'El trámite indicado no existe');
  if (cand.yaTieneDerecho) throw new DerechoError(400, 'Ese trámite ya tiene registrado su derecho de trámite');

  const derechoId = await registrar(
    cand, extraccion, soporteId, advertenciasDe(cand, extraccion),
    { origen: 'manual', organismoCodigo: cand.organismoCodigo }, ctx,
  );
  // El soporte pudo cargarse sin saber a qué trámite pertenecía; al resolver, queda atado.
  await db.update(flitoSoportes).set({ derechoId }).where(eq(flitoSoportes.id, soporteId));
  return derechoId;
}

/** Marca como resueltos los pendientes de una placa ya asociada (evita reintentos eternos). */
export async function cerrarPendientesDePlaca(placa: string, tramiteId: string): Promise<void> {
  await db.update(flitoDerechosPendientes)
    .set({ resuelto: true, resueltoTramiteId: tramiteId })
    .where(and(
      eq(flitoDerechosPendientes.placa, normalizarTexto(placa)),
      eq(flitoDerechosPendientes.resuelto, false),
    ));
}
