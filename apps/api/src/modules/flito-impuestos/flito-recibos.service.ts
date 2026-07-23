// FLITO Impuestos — carga de recibos de pago → Pagado (Fase 4 P3). Porta procesarRecibo/conciliar/
// evaluarExtraccion de impuestos.servicio.ts sobre drizzle + OCR Anthropic (extraerReciboImpuesto).
//
// El recibo validado por OCR es la vía a PAGADO. Dedup CA-08 en dos frentes: por hash (mismo archivo)
// y por número de recibo (mismo pago, PDF reexportado). El cruce es SOLO contra EN_GESTION del
// organismo del gestor (CA-07/CA-10). Recibos con/sin marca de agua: el limpio (sin marca) concilia;
// el de marca "PAGADO" se adjunta como comprobante al pago ya hecho.

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoImpuestos, flitoRevisiones, flitoSoportes, flitoTramites,
  organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import {
  CampoImpuesto, EstadoImpuesto, FlujoRevision, MotivoRevision, type ExtraccionImpuesto,
} from '@operaciones/shared-types';
import { extraerReciboImpuesto, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import type { ArchivoSubido, ImpuestoCtx } from './flito-factura-venta.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TIPO_RECIBO = 'recibo_impuesto';
const TIPO_RECIBO_SIN_MARCA = 'recibo_impuesto_sin_marca';
const TIPOS_RECIBO = [TIPO_RECIBO, TIPO_RECIBO_SIN_MARCA];

/** Solo el valor total bloquea (la placa se valida aparte, es la llave). Nº recibo/fecha/año no. */
const CAMPOS_REQUERIDOS_RECIBO: readonly CampoImpuesto[] = [CampoImpuesto.VALOR_TOTAL];

const normalizarLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');
const docDe = (a: ArchivoSubido, umbral: number): DocumentoAAnalizar => ({ nombreArchivo: a.originalname, contentType: a.mimetype, contenido: a.buffer, umbral });

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * Decide si el recibo cruza y se lee bien para pagar solo: placa sobre umbral (llave) + valorTotal
 * sobre umbral. El año gravable/nº recibo/fecha se extraen pero NO bloquean (a pedido del negocio).
 */
export function evaluarReciboImpuesto(extraccion: ExtraccionImpuesto, umbral: number): Veredicto {
  const placa = extraccion[CampoImpuesto.PLACA];
  if (!placa || placa.confianza < umbral) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La placa se leyó con confianza ${placa?.confianza ?? 0}, bajo el umbral de ${umbral}.` };
  }
  const dudosos = CAMPOS_REQUERIDOS_RECIBO.filter((c) => { const e = extraccion[c]; return !e || e.valor === null || e.confianza < umbral; });
  if (dudosos.length > 0) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE, detalle: `La lectura no superó el umbral de ${umbral} en: ${dudosos.join(', ')}.` };
  }
  return { aprobada: true };
}

async function auditEnTx(tx: Tx, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail });
}

const aNumero = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);

export interface ItemRecibo { archivo: string; placa: string | null; idFlit: string | null; registroId: string | null; detalle: string }
export interface ResultadoRecibos { conciliados: ItemRecibo[]; enRevision: ItemRecibo[]; duplicados: ItemRecibo[]; complementos: ItemRecibo[]; noAsociados: ItemRecibo[] }

// Datos de un impuesto candidato para conciliar/archivar.
interface Candidato {
  impuestoId: string; estado: string; organismoCodigo: string; tramiteIdFlit: string;
  placa: string | null; companiaId: number; document: string | null; carpeta: string | null; valorLiquidado: string | null;
  // D-5 (Fase 7): activación de diferencia de valor por organismo + tolerancia de la compañía.
  diferenciaActiva: boolean; tolerancia: string;
}
const SELECT_CAND = {
  impuestoId: flitoImpuestos.id, estado: flitoImpuestos.estado, organismoCodigo: flitoImpuestos.organismoCodigo,
  tramiteIdFlit: flitoTramites.idFlit, placa: vehicles.plate, companiaId: clients.id, document: clients.document,
  carpeta: clients.flitoCarpetaStorage, valorLiquidado: flitoImpuestos.valorLiquidado,
  diferenciaActiva: organismosTransitoConfig.flitoDiferenciaValorActiva,
  tolerancia: clients.flitoToleranciaValorImpuesto,
} as const;
function fromCandidatos() {
  return db.select(SELECT_CAND).from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo));
}

/**
 * Carga masiva de recibos. `sinMarcaDeAgua` es el interruptor por defecto para archivos sueltos; en
 * un ZIP la copia (con/sin marca) se deduce de la carpeta. El limpio se procesa primero (concilia);
 * el de marca se adjunta al pago. Un archivo que falla no tumba el lote.
 */
export async function cargarRecibos(archivos: ArchivoSubido[], sinMarcaDeAgua: boolean, ctx: ImpuestoCtx): Promise<ResultadoRecibos> {
  const res: ResultadoRecibos = { conciliados: [], enRevision: [], duplicados: [], complementos: [], noAsociados: [] };
  const expandidos = await expandir(archivos, sinMarcaDeAgua);
  // El SIN marca primero: es el limpio con el que se concilia; el de marca se adjunta después.
  expandidos.sort((a, b) => Number(b.sinMarca) - Number(a.sinMarca));

  // Umbral por organismo del gestor (para operaciones, el defecto).
  const umbral = await umbralDelGestor(ctx);
  const organismoCodigo = ctx.role === 'gestor_impuestos' ? ctx.transitoCodigo : null;

  for (const archivo of expandidos) {
    try {
      await procesarRecibo(archivo, archivo.sinMarca, umbral, organismoCodigo, ctx, res);
    } catch (e) {
      res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: (e as Error).message });
    }
  }
  return res;
}

async function umbralDelGestor(ctx: ImpuestoCtx): Promise<number> {
  if (ctx.role !== 'gestor_impuestos' || !ctx.transitoCodigo) return umbralPara(null);
  const [o] = await db.select({ u: organismosTransitoConfig.flitoUmbralOcr }).from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, ctx.transitoCodigo)).limit(1);
  return umbralPara(o?.u ?? null);
}

async function procesarRecibo(archivo: ArchivoSubido & { sinMarca: boolean }, sinMarca: boolean, umbral: number, organismoCodigo: string | null, ctx: ImpuestoCtx, res: ResultadoRecibos): Promise<void> {
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const tipo = sinMarca ? TIPO_RECIBO_SIN_MARCA : TIPO_RECIBO;

  // CA-08 (1): el mismo archivo, byte por byte, ya está cargado.
  const [dupHash] = await db.select({ impuestoId: flitoSoportes.impuestoId }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.hash, hash), inArray(flitoSoportes.tipo, TIPOS_RECIBO))).limit(1);
  if (dupHash) {
    res.duplicados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: dupHash.impuestoId, detalle: 'Ese pago ya está registrado: el archivo es idéntico a uno cargado antes.' });
    return;
  }

  const extraccion = await extraerReciboImpuesto(docDe(archivo, umbral));
  const placa = extraccion[CampoImpuesto.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);
  if (!placa) {
    res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: 'El recibo no permitió leer la placa, así que no se pudo asociar a ningún trámite.' });
    return;
  }

  // Cruce SOLO contra EN_GESTION del organismo del gestor (CA-07/CA-10).
  const candidato = await buscarCandidato(placa, EstadoImpuesto.SOLICITADO, organismoCodigo);
  if (!candidato) {
    // ¿Es la segunda copia (la otra marca) de un pago ya conciliado? Se adjunta, no se rechaza.
    if (await adjuntarComplemento(archivo, placa, tipo, organismoCodigo, hash, ctx, res)) return;
    res.noAsociados.push({ archivo: archivo.originalname, placa, idFlit: null, registroId: null,
      detalle: `El recibo dice placa ${placa}, pero no hay ningún impuesto en gestión con esa placa en este organismo. No va a revisión: no hay trámite con qué compararlo.` });
    return;
  }

  // CA-08 (2): mismo número de recibo en otro impuesto (PDF reexportado, bytes distintos).
  const numeroRecibo = extraccion[CampoImpuesto.NUMERO_RECIBO]?.valor ?? null;
  if (numeroRecibo) {
    const [mismoNumero] = await db.select({ id: flitoImpuestos.id }).from(flitoImpuestos)
      .where(and(sql`${flitoImpuestos.extraccion} -> 'numeroRecibo' ->> 'valor' = ${numeroRecibo}`, ne(flitoImpuestos.id, candidato.impuestoId))).limit(1);
    if (mismoNumero) {
      res.duplicados.push({ archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: mismoNumero.id, detalle: `El recibo número ${numeroRecibo} ya está registrado en otro impuesto.` });
      return;
    }
  }

  const veredicto = evaluarReciboImpuesto(extraccion, umbral);
  const storageKey = await archivar(candidato, archivo);

  await db.transaction(async (tx) => {
    const soporteId = await insertarSoporte(tx, candidato.impuestoId, archivo, tipo, ctx, storageKey, hash);
    if (veredicto.aprobada) await conciliar(tx, candidato, extraccion, soporteId, ctx);
    else await aRevision(tx, soporteId, extraccion, veredicto, candidato.impuestoId, placa, ctx);
  });

  const item: ItemRecibo = { archivo: archivo.originalname, placa, idFlit: candidato.tramiteIdFlit, registroId: candidato.impuestoId,
    detalle: veredicto.aprobada ? 'Conciliado y pagado sin intervención.' : (veredicto.detalle ?? 'En revisión.') };
  (veredicto.aprobada ? res.conciliados : res.enRevision).push(item);
}

async function buscarCandidato(placa: string, estado: EstadoImpuesto, organismoCodigo: string | null): Promise<Candidato | null> {
  const conds = [
    eq(flitoImpuestos.estado, estado),
    eq(clients.impuestosAutogestionable, false),
    sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarLlave(placa)}`,
  ];
  if (organismoCodigo) conds.push(eq(flitoImpuestos.organismoCodigo, organismoCodigo));
  const [r] = await fromCandidatos().where(and(...conds)).orderBy(desc(flitoImpuestos.pagadoEn)).limit(1);
  return r ?? null;
}

/**
 * La factura de venta ya no cruza con un EN_GESTION: puede ser la segunda copia (otra marca) de un
 * pago ya conciliado. Se adjunta al PAGADO si ese impuesto no tiene ya esa misma copia. Devuelve
 * true si se adjuntó.
 */
async function adjuntarComplemento(archivo: ArchivoSubido, placa: string, tipo: string, organismoCodigo: string | null, hash: string, ctx: ImpuestoCtx, res: ResultadoRecibos): Promise<boolean> {
  const pagado = await buscarCandidato(placa, EstadoImpuesto.PAGADO, organismoCodigo);
  if (!pagado) return false;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(flitoSoportes).where(and(eq(flitoSoportes.impuestoId, pagado.impuestoId), eq(flitoSoportes.tipo, tipo)));
  if (Number(n) > 0) return false; // ya tiene esa copia: es duplicado, no complemento
  const cual = tipo === TIPO_RECIBO_SIN_MARCA ? 'sin' : 'con';
  const storageKey = await archivar(pagado, archivo);
  await db.transaction(async (tx) => {
    const soporteId = await insertarSoporte(tx, pagado.impuestoId, archivo, tipo, ctx, storageKey, hash);
    await auditEnTx(tx, ctx, pagado.impuestoId, `Comprobante complementario (${cual} marca de agua) adjuntado al pago de ${pagado.tramiteIdFlit}. Soporte ${soporteId}.`);
  });
  res.complementos.push({ archivo: archivo.originalname, placa, idFlit: pagado.tramiteIdFlit, registroId: pagado.impuestoId, detalle: `Comprobante ${cual} marca de agua adjuntado al pago de ${pagado.tramiteIdFlit}.` });
  return true;
}

/**
 * Conciliación → PAGADO. La diferencia de valor (CA-09) está APAGADA por defecto (D-5): el
 * valorLiquidado de FLIT no siempre es fiable y el total pagado incluye el servicio de FLITO. Se
 * ACTIVA por organismo (`flitoDiferenciaValorActiva`, Fase 7) donde la fuente sí lo es: si el
 * |pagado - liquidado| supera la tolerancia de la compañía, se MARCA para revisión (marcadoPorDiferencia)
 * pero NO bloquea el pago. El valor se guarda siempre (lo consume Liquidaciones).
 */
async function conciliar(tx: Tx, cand: Candidato, extraccion: ExtraccionImpuesto, soporteId: string, ctx: ImpuestoCtx): Promise<void> {
  const valorPagado = aNumero(extraccion[CampoImpuesto.VALOR_TOTAL]?.valor);
  const marcadoPorDiferencia = evaluarDiferencia(cand, valorPagado);
  await tx.update(flitoImpuestos).set({
    estado: EstadoImpuesto.PAGADO, extraccion, valorPagado, marcadoPorDiferencia,
    pagadoEn: new Date(), motivoRechazo: null, updatedAt: new Date(),
  }).where(eq(flitoImpuestos.id, cand.impuestoId));
  const notaDiferencia = marcadoPorDiferencia
    ? ` MARCADO por diferencia de valor: pagado ${valorPagado ?? '—'} vs liquidado ${cand.valorLiquidado ?? '—'} supera la tolerancia ${cand.tolerancia}.`
    : '';
  await auditEnTx(tx, ctx, cand.impuestoId,
    `Pago conciliado (solicitado→pagado). Valor pagado ${valorPagado ?? '—'}, liquidado ${cand.valorLiquidado ?? '—'}, ` +
    `recibo ${extraccion[CampoImpuesto.NUMERO_RECIBO]?.valor ?? '—'}. Soporte ${soporteId}. Trámite ${cand.tramiteIdFlit}.${notaDiferencia}`);
}

/**
 * D-5: ¿hay que marcar diferencia de valor? Solo si el organismo la tiene activa, hay valor
 * liquidado (fuente fiable) y pagado, y su diferencia absoluta excede la tolerancia de la compañía.
 * No bloquea el pago; solo levanta la marca para que Operaciones la revise.
 */
export function evaluarDiferencia(cand: Pick<Candidato, 'diferenciaActiva' | 'valorLiquidado' | 'tolerancia'>, valorPagado: string | null): boolean {
  if (!cand.diferenciaActiva || cand.valorLiquidado === null || valorPagado === null) return false;
  const liquidado = Number(cand.valorLiquidado);
  const pagado = Number(valorPagado);
  const tolerancia = Number(cand.tolerancia) || 0;
  if (!Number.isFinite(liquidado) || !Number.isFinite(pagado)) return false;
  return Math.abs(pagado - liquidado) > tolerancia;
}

async function aRevision(tx: Tx, soporteId: string, extraccion: ExtraccionImpuesto, veredicto: Veredicto, impuestoId: string, placa: string | null, ctx: ImpuestoCtx): Promise<void> {
  await tx.insert(flitoRevisiones).values({
    modulo: FlujoRevision.IMPUESTOS, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
    registroId: impuestoId, soporteId, placaSugerida: placa, extraccion, resuelto: false,
  });
  await auditEnTx(tx, ctx, impuestoId, `Recibo a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
}

async function insertarSoporte(tx: Tx, impuestoId: string, archivo: ArchivoSubido, tipo: string, ctx: ImpuestoCtx, storageKey: string, hash: string): Promise<string> {
  const [s] = await tx.insert(flitoSoportes).values({
    tipo, nombreArchivo: archivo.originalname, contentType: archivo.mimetype, storageKey, hash, tamanoBytes: archivo.size,
    impuestoId, subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
  }).returning({ id: flitoSoportes.id });
  return s.id;
}

async function archivar(cand: Candidato, archivo: ArchivoSubido): Promise<string> {
  const carpeta = carpetaDe({ id: cand.companiaId, document: cand.document, flitoCarpetaStorage: cand.carpeta }, 'impuestos/recibos');
  return uploadEntityDocument(carpeta, cand.impuestoId, archivo.originalname, archivo.buffer, archivo.mimetype);
}

/** Expande ZIP marcando cada recibo con/sin marca de agua por su carpeta; sueltos usan el defecto. */
async function expandir(archivos: ArchivoSubido[], defectoSinMarca: boolean): Promise<Array<ArchivoSubido & { sinMarca: boolean }>> {
  const salida: Array<ArchivoSubido & { sinMarca: boolean }> = [];
  for (const archivo of archivos) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    if (!esZip) { salida.push({ ...archivo, sinMarca: defectoSinMarca }); continue; }
    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf' : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg' : lower.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length, sinMarca: esSinMarcaDeAgua(entrada.name, defectoSinMarca) });
    }
  }
  return salida;
}

/** Copia sin marca de agua a partir de la ruta dentro del ZIP; si nada lo indica, el defecto. */
function esSinMarcaDeAgua(ruta: string, defecto: boolean): boolean {
  const t = ruta.toLowerCase();
  if (/sin[\s_-]*marca|sin[\s_-]*agua|limpi|original/.test(t)) return true;
  if (/con[\s_-]*marca|marca[\s_-]*de[\s_-]*agua|con[\s_-]*agua|pagad/.test(t)) return false;
  return defecto;
}
