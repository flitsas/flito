// FLITO — bandeja de recibos que aún no cruzan con ningún registro (HU #10982).
//
// Los derechos de tránsito ya guardaban el archivo cuando el recibo llegaba antes que el trámite, y
// reintentaban el cruce solos en cada sincronización. SOAT e impuestos NO: un comprobante que no
// cruzaba se informaba y se DESCARTABA, así que el gestor tenía que volver a pedírselo al proveedor
// o al organismo. Este módulo generaliza aquella bandeja a los tres conceptos.
//
// Por qué se reusa `flito_derechos_pendientes` en vez de crear dos tablas más: la maquinaria que
// importa —archivar el documento, contar intentos, reintentar por placa, marcar resuelto— es
// idéntica, y tres copias de lo mismo se desincronizan.
//
// El archivo se guarda SIEMPRE que se haya podido leer algo, incluso sin placa. Ese es justamente el
// caso en el que más caro sale perderlo: sin placa nadie lo puede volver a buscar.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoDerechosPendientes, flitoSoportes } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-pendientes');

export const CONCEPTO_PENDIENTE = { DERECHO: 'derecho', SOAT: 'soat', IMPUESTO: 'impuesto' } as const;
export type ConceptoPendiente = (typeof CONCEPTO_PENDIENTE)[keyof typeof CONCEPTO_PENDIENTE];

const CONCEPTOS: readonly string[] = Object.values(CONCEPTO_PENDIENTE);
export const esConceptoPendiente = (v: unknown): v is ConceptoPendiente =>
  typeof v === 'string' && CONCEPTOS.includes(v);

/** Carpeta de los soportes que todavía no cuelgan de ningún registro. */
const CARPETA_SIN_CRUCE = '_pendientes-sin-cruce';

export interface ArchivoPendiente {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface CtxPendiente { userId: number; username: string }

export interface DatosSinCruce {
  concepto: ConceptoPendiente;
  /** Null si el recibo no permitió leerla. El archivo se guarda igual. */
  placa: string | null;
  archivo: ArchivoPendiente;
  hash: string;
  /** Tipo con el que se registra el soporte, para que el visor lo etiquete bien. */
  tipoSoporte: string;
  extraccion: unknown;
  organismoCodigo: string | null;
  origen: string;
}

/**
 * Archiva un recibo que no cruzó y lo deja en la bandeja. Devuelve el id del soporte por si quien
 * llama quiere referenciarlo en su propio resultado.
 *
 * El soporte se inserta SIN `soatId` ni `impuestoId`: todavía no se sabe de quién es. El reintento
 * es el que los rellena cuando el registro aparece.
 */
export async function archivarSinCruce(d: DatosSinCruce, ctx: CtxPendiente): Promise<string> {
  const carpeta = `${CARPETA_SIN_CRUCE}/${d.concepto}/${d.organismoCodigo ?? 'sin-organismo'}`;
  const storageKey = await uploadEntityDocument(
    carpeta, d.placa ?? 'sin-placa', d.archivo.originalname, d.archivo.buffer, d.archivo.mimetype,
  );

  const soporteId = await db.transaction(async (tx) => {
    const [s] = await tx.insert(flitoSoportes).values({
      tipo: d.tipoSoporte,
      nombreArchivo: d.archivo.originalname,
      contentType: d.archivo.mimetype,
      storageKey,
      hash: d.hash,
      tamanoBytes: d.archivo.size,
      subidoPorId: ctx.userId,
      subidoPorNombre: ctx.username,
    }).returning({ id: flitoSoportes.id });

    await tx.insert(flitoDerechosPendientes).values({
      concepto: d.concepto,
      placa: d.placa,
      soporteId: s.id,
      organismoCodigo: d.organismoCodigo,
      // Los campos propios del recibo de derechos se dejan nulos: para SOAT e impuestos el detalle
      // vive en `extraccion`, y duplicarlo en columnas que no aplican solo invita a leerlas mal.
      extraccion: d.extraccion as never,
      origen: d.origen,
    }).returning({ id: flitoDerechosPendientes.id });

    return s.id;
  });

  log.info({ concepto: d.concepto, placa: d.placa, soporteId }, 'Recibo sin cruce archivado en la bandeja');
  return soporteId;
}

export interface FilaPendiente {
  id: string; concepto: string; placa: string | null; valor: string | null; fechaPago: string | null;
  tipoTramiteRecibo: string | null; organismoCodigo: string | null; origen: string;
  intentos: number; ultimoIntentoEn: string; soporteId: string; nombreArchivo: string;
  createdAt: string;
}

/** Bandeja sin resolver. Sin `concepto` devuelve los tres, para no romper a quien ya la consume. */
export async function listarPendientes(concepto?: ConceptoPendiente): Promise<FilaPendiente[]> {
  const conds = [eq(flitoDerechosPendientes.resuelto, false)];
  if (concepto) conds.push(eq(flitoDerechosPendientes.concepto, concepto));

  const rows = await db.select({
    id: flitoDerechosPendientes.id,
    concepto: flitoDerechosPendientes.concepto,
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
    .where(and(...conds))
    .orderBy(asc(flitoDerechosPendientes.createdAt));

  return rows.map((r) => ({
    ...r,
    fechaPago: r.fechaPago ?? null,
    ultimoIntentoEn: r.ultimoIntentoEn.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Qué se asoció en un reintento, y con qué. Los tres conceptos devuelven esta misma forma.
 *
 * Un «2 asociados» no es verificable: quien lo lee no puede comprobar que el cruce fue el correcto
 * sin ir a buscar los recibos uno a uno, que es justo lo que el reintento venía a evitar (HU #11023).
 */
export interface PendienteAsociado {
  pendienteId: string;
  concepto: ConceptoPendiente;
  placa: string | null;
  /** Identificador FLIT del trámite al que fue a parar. Null si el concepto no cuelga de uno. */
  idFlit: string | null;
  tramiteId: string | null;
  /** El registro que quedó dueño del soporte: el derecho, el SOAT o el impuesto. */
  registroId: string | null;
  /** Qué le pasó: «Pagado», «A revisión: …», «Registrado». */
  detalle: string;
}

/** Conteos más el detalle de cada cruce. */
export interface ResultadoReintento {
  revisados: number;
  asociados: number;
  detalle: PendienteAsociado[];
}

export interface PendienteParaReintento {
  id: string; placa: string | null; soporteId: string; organismoCodigo: string | null;
  extraccion: unknown;
}

/**
 * Lo que necesita un reintento: la llave del cruce y la lectura YA hecha. La extracción se reusa a
 * propósito en vez de volver a pasar el archivo por el OCR — es la misma imagen, y el OCR se cobra.
 */
export async function pendientesParaReintento(concepto: ConceptoPendiente): Promise<PendienteParaReintento[]> {
  return db.select({
    id: flitoDerechosPendientes.id,
    placa: flitoDerechosPendientes.placa,
    soporteId: flitoDerechosPendientes.soporteId,
    organismoCodigo: flitoDerechosPendientes.organismoCodigo,
    extraccion: flitoDerechosPendientes.extraccion,
  }).from(flitoDerechosPendientes)
    .where(and(
      eq(flitoDerechosPendientes.resuelto, false),
      eq(flitoDerechosPendientes.concepto, concepto),
    ))
    .orderBy(asc(flitoDerechosPendientes.createdAt));
}

/** Suma un intento sin resolver: el registro sigue sin aparecer. */
export async function anotarIntento(pendienteId: string): Promise<void> {
  await db.update(flitoDerechosPendientes)
    .set({ intentos: sql`${flitoDerechosPendientes.intentos} + 1`, ultimoIntentoEn: new Date() })
    .where(eq(flitoDerechosPendientes.id, pendienteId));
}

/** El recibo por fin encontró su registro. */
export async function marcarResuelto(pendienteId: string, tramiteId: string | null): Promise<void> {
  await db.update(flitoDerechosPendientes)
    .set({
      resuelto: true,
      resueltoTramiteId: tramiteId,
      intentos: sql`${flitoDerechosPendientes.intentos} + 1`,
      ultimoIntentoEn: new Date(),
    })
    .where(eq(flitoDerechosPendientes.id, pendienteId));
}
