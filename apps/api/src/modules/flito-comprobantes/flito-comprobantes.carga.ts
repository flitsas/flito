// Comprobantes universales (Épica #12245, Feature #12605, ADR-0018) — HU #12611: la carga en lotes.
//
// Un envío son 1..5 archivos con un `loteId` que genera el navegador; el lote entero son N envíos y
// su resumen es una consulta por `lote_id`. Cada archivo se procesa por su cuenta (AC2): lo que un
// envío persistió queda aunque el siguiente nunca llegue, y un archivo dañado no arrastra a los demás.
// Por eso NO hay una transacción por envío: hay una por ARCHIVO, y solo alrededor del INSERT del
// soporte y sus comprobantes, después de que S3 ya tenga el objeto (AC3: un soporte sin objeto es
// una fila que apunta a nada; un objeto sin fila es basura que se puede barrer).
//
// Orden por archivo: cabecera real → sha256 y dedup (en el envío y contra `flito_soportes` vivos de
// CUALQUIER puerta) → partición → lectura de cada sub-documento (concurrencia 5; OCR caído = sin
// lectura, no error) → S3 → BD. Los duplicados y los fallidos no se persisten: viven en el resultado.
// Ningún log lleva contenido leído (Habeas Data): cuentas, motivos y banderas.

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  MOTIVO_PENDIENTE_COMPROBANTE_LABEL, TipoSoporte, type ConceptoCosto, type ItemCargaComprobante,
  type MotivoPendienteComprobante, type ResultadoCargaComprobantes, type TipoDocumentoComprobante,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComprobantes, flitoSoportes } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { PdfDemasiadoGrandeError } from '../../shared/pdf/separar-paginas.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { leerSubDocumento, particionar, type LecturaSubDocumento, type SubDocumentoApi } from './flito-comprobantes.ocr.js';
import { columnasDeLectura, type ComprobanteCtx } from './flito-comprobantes.service.js';

const log = loggerFor('flito-comprobantes-carga');

/** Sub-documentos en vuelo a la vez por archivo (mismo tope que la carga masiva de recibos). */
export const OCR_CONCURRENCIA_CARGA = 5;

/** Carpeta S3 de la puerta: no hay compañía conocida al cargar, así que cuelga del lote. */
export const CARPETA_COMPROBANTES = 'flito/comprobantes';

/** Copy FIJADO de los fallidos (ficha UX §6.2; el front lo pinta tal cual). */
export const DETALLE_FALLIDO = {
  NO_ADMITIDO: 'No es PDF ni imagen admitida',
  DEMASIADAS_PAGINAS: 'PDF de más de 150 páginas: pártelo',
  DANADO: 'El archivo está dañado o cifrado',
  PESO: 'Pesa más de 15 MB',
  /** No está en la ficha: es un fallo de infraestructura (S3 o BD), no del documento. */
  NO_GUARDADO: 'No se pudo guardar el archivo',
} as const;

/** Un archivo tal como lo entrega multer (memoryStorage). */
export interface ArchivoCargado {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export type ContentTypeAdmitido = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * El tipo REAL del archivo, leído de sus primeros bytes y no del MIME que declaró el cliente (que es
 * lo que multer ve): un `.pdf` que es texto plano no es un PDF, y el content-type que se guarde en
 * `flito_soportes` es el que luego sirve la descarga (XSS almacenado con un .html disfrazado).
 */
export function contentTypePorCabecera(buf: Buffer): ContentTypeAdmitido | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** «10/09/2026»: la fecha del duplicado, en el huso del negocio. */
const fechaCorta = (d: Date): string =>
  d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Por qué puerta entró un soporte que no tiene comprobante, derivado de su `tipo` (y, para los tipos
 * que comparten dos puertas, de a qué registro cuelga). Sin placa: el duplicado de otra puerta se
 * informa sin identificar el vehículo.
 */
export function puertaDelSoporte(s: { tipo: string; soatId: string | null; impuestoId: string | null; derechoId: string | null }): string | null {
  switch (s.tipo) {
    case TipoSoporte.FACTURA_SOAT:
    case TipoSoporte.COMPROBANTE_PSE:
      return 'SOAT';
    case TipoSoporte.RECIBO_IMPUESTO:
    case TipoSoporte.RECIBO_IMPUESTO_SIN_MARCA_AGUA:
    case TipoSoporte.RECIBO_CAJA_IMPUESTO:
      return 'Impuestos';
    case 'derecho_tramite':
      return 'Derechos';
    default:
      if (s.soatId) return 'SOAT';
      if (s.impuestoId) return 'Impuestos';
      if (s.derechoId) return 'Derechos';
      return null;
  }
}

/** «p. 7 no leída: portada o resumen» / «pp. 1, 7 no leídas: portada o resumen». */
export function textoNoLeidas(paginas: number[]): string | null {
  if (paginas.length === 0) return null;
  return paginas.length === 1
    ? `p. ${paginas[0]} no leída: portada o resumen`
    : `pp. ${paginas.join(', ')} no leídas: portada o resumen`;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Lo que el envío ya persistió con ese hash: para que el segundo archivo idéntico sea duplicado del primero. */
interface VistoEnEnvio { comprobanteId: string; en: Date }

interface Persistido { soporteId: string; comprobanteIds: string[] }

/**
 * CF-C5: el mismo archivo, byte por byte, ya está vivo en `flito_soportes` — de esta puerta o de
 * SOAT, Impuestos o Derechos (cualquier `tipo`; solo cuenta `descartado = false`, porque un descarte
 * libera el hash para recargar).
 */
async function duplicadoEnBase(hash: string): Promise<ItemCargaComprobante | null> {
  const [dup] = await db.select({
    id: flitoSoportes.id, tipo: flitoSoportes.tipo, subidoEn: flitoSoportes.subidoEn,
    soatId: flitoSoportes.soatId, impuestoId: flitoSoportes.impuestoId, derechoId: flitoSoportes.derechoId,
  }).from(flitoSoportes).where(and(eq(flitoSoportes.hash, hash), eq(flitoSoportes.descartado, false))).limit(1);
  if (!dup) return null;
  const [original] = await db.select({ id: flitoComprobantes.id }).from(flitoComprobantes)
    .where(eq(flitoComprobantes.soporteId, dup.id)).limit(1);
  const fecha = fechaCorta(dup.subidoEn ?? new Date());
  const puerta = original ? null : puertaDelSoporte(dup);
  return {
    archivo: '', comprobanteId: original?.id ?? null, paginas: null, tipoDocumento: null, concepto: null, idFlit: null, placa: null, motivo: null,
    detalle: puerta ? `Ya cargado el ${fecha} en ${puerta}` : `Ya cargado el ${fecha}`,
  };
}

/** Lee un sub-documento; el OCR caído no es un error del archivo, es «sin lectura» (AC5). */
async function leerOSinLectura(sub: SubDocumentoApi): Promise<LecturaSubDocumento | null> {
  try {
    return await leerSubDocumento(sub);
  } catch (e) {
    if (e instanceof OcrNoDisponibleError) {
      log.warn({ paginas: sub.paginas?.length ?? null, status: e.status }, 'Sub-documento sin lectura: OCR no disponible');
      return null;
    }
    throw e;
  }
}

/**
 * S3 primero, BD después, y la BD en UNA transacción por archivo: el soporte (uno por archivo, con
 * el `tipo` que dice si trae uno o varios documentos) y una fila de `flito_comprobantes` por
 * sub-documento, todas `pendiente`, ninguna cruzada.
 */
async function persistir(
  archivo: ArchivoCargado, contentType: ContentTypeAdmitido, hash: string,
  docs: SubDocumentoApi[], lecturas: (LecturaSubDocumento | null)[], loteId: string, ctx: ComprobanteCtx,
): Promise<Persistido> {
  const storageKey = await uploadEntityDocument(CARPETA_COMPROBANTES, loteId, archivo.originalname, archivo.buffer, contentType);
  return db.transaction(async (tx) => {
    const [s] = await tx.insert(flitoSoportes).values({
      tipo: docs.length > 1 ? TipoSoporte.CONSOLIDADO_COMPROBANTES : TipoSoporte.COMPROBANTE_PAGO,
      nombreArchivo: archivo.originalname, contentType, storageKey, hash, tamanoBytes: archivo.size,
      subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
    }).returning({ id: flitoSoportes.id });
    const comprobanteIds: string[] = [];
    for (let i = 0; i < docs.length; i++) {
      const [c] = await tx.insert(flitoComprobantes).values({
        loteId, soporteId: s.id, paginas: docs[i].paginas, estado: 'pendiente',
        ...columnasDeLectura(lecturas[i]),
        subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
      }).returning({ id: flitoComprobantes.id });
      comprobanteIds.push(c.id);
    }
    return { soporteId: s.id, comprobanteIds };
  });
}

function itemPendiente(
  sub: SubDocumentoApi, lectura: LecturaSubDocumento | null, comprobanteId: string, noLeidas: number[],
): ItemCargaComprobante {
  const cols = columnasDeLectura(lectura);
  const motivo = cols.motivoPendiente as MotivoPendienteComprobante;
  const extra = textoNoLeidas(noLeidas);
  return {
    archivo: sub.nombre, comprobanteId, paginas: sub.paginas,
    tipoDocumento: (cols.tipoDocumento as TipoDocumentoComprobante | null) ?? null,
    concepto: (cols.concepto as ConceptoCosto | null) ?? null,
    idFlit: cols.idFlitLeido, placa: cols.placaLeida, motivo,
    detalle: `${MOTIVO_PENDIENTE_COMPROBANTE_LABEL[motivo]}${extra ? ` · ${extra}` : ''}`,
  };
}

const fallido = (archivo: string, detalle: string): ItemCargaComprobante =>
  ({ archivo, comprobanteId: null, paginas: null, tipoDocumento: null, concepto: null, idFlit: null, placa: null, motivo: null, detalle });

/**
 * Procesa un envío (1..5 archivos) de un lote. `aplicados` es siempre `[]` en este Feature: la puerta
 * lee y conserva; asociar y aplicar llegan con F2.
 */
export async function cargarLote(archivos: ArchivoCargado[], loteId: string, ctx: ComprobanteCtx): Promise<ResultadoCargaComprobantes> {
  const res: ResultadoCargaComprobantes = { aplicados: [], pendientes: [], duplicados: [], fallidos: [], documentos: 0 };
  const vistos = new Map<string, VistoEnEnvio>();

  for (const archivo of archivos) {
    const nombre = archivo.originalname;
    const contentType = contentTypePorCabecera(archivo.buffer);
    if (!contentType) { res.fallidos.push(fallido(nombre, DETALLE_FALLIDO.NO_ADMITIDO)); continue; }

    const hash = sha256(archivo.buffer);
    const visto = vistos.get(hash);
    if (visto) {
      res.duplicados.push({ ...fallido(nombre, `Ya cargado el ${fechaCorta(visto.en)}`), comprobanteId: visto.comprobanteId });
      continue;
    }
    const dup = await duplicadoEnBase(hash);
    if (dup) { res.duplicados.push({ ...dup, archivo: nombre }); continue; }

    let particion;
    try {
      particion = await particionar({ nombre, contentType, buffer: archivo.buffer });
    } catch (e) {
      if (e instanceof PdfDemasiadoGrandeError) { res.fallidos.push(fallido(nombre, DETALLE_FALLIDO.DEMASIADAS_PAGINAS)); continue; }
      log.warn({ motivo: (e as Error).name }, 'Archivo no partible: dañado o cifrado');
      res.fallidos.push(fallido(nombre, DETALLE_FALLIDO.DANADO));
      continue;
    }

    try {
      const lecturas = await conConcurrencia(particion.documentos, OCR_CONCURRENCIA_CARGA, leerOSinLectura);
      const { comprobanteIds } = await persistir(archivo, contentType, hash, particion.documentos, lecturas, loteId, ctx);
      vistos.set(hash, { comprobanteId: comprobanteIds[0]!, en: new Date() });
      particion.documentos.forEach((sub, i) => {
        res.pendientes.push(itemPendiente(sub, lecturas[i] ?? null, comprobanteIds[i]!, particion.paginasNoLeidas));
      });
      res.documentos += particion.documentos.length;
      log.info({ loteId, documentos: particion.documentos.length, metodo: particion.metodo, sinLectura: lecturas.filter((l) => l === null).length }, 'Archivo cargado');
    } catch (e) {
      log.error({ loteId, err: (e as Error).message }, 'Archivo no guardado');
      res.fallidos.push(fallido(nombre, DETALLE_FALLIDO.NO_GUARDADO));
    }
  }
  return res;
}
