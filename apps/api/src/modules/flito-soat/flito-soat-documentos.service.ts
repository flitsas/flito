// FLITO — SOAT: documentos adicionales del alta del canal Cliente.
// HU #13362 (Feature #13360, Épica #13201). Diseño: docs/arquitectura/hu-13362-documentos-adicionales-soat.md.
//
// ── Qué vive aquí ───────────────────────────────────────────────────────────────────────────────
//
//   · `clasificarAdicionales` — puro (sin storage ni BD): decide, EN EL ORDEN RECIBIDO, qué
//     adicional se acepta y por qué se descarta cada uno de los demás (D2). Un descarte nunca tumba
//     el alta.
//   · `subirAdicionales` / `compensarAdicionales` — S3 fuera de la transacción y su borrado si la
//     transacción no llega a COMMIT (AC7: nada queda).
//   · `insertarAdicionales` — las filas de `flito_soportes`, DENTRO de la transacción del alta (o del
//     aparcamiento, D3-bis), contra la solicitud o contra la por validar.
//   · `vincularAdicionalesAlSoat` — al completar una por validar, los adicionales ganan `soat_id`.
//   · `listarDocumentosAdicionales` — la lectura de `GET /:id/documentos-adicionales` (AC8).
//   · `cargarDocumentosAdicionales` / `eliminarDocumentoAdicional` — la carga posterior y el borrado
//     definitivo sobre una solicitud existente (HU #13364; diseño
//     docs/arquitectura/hu-13364-cargar-eliminar-documentos-adicionales-soat.md).
//
// ── Regla de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-DA1 Formatos por BYTES, nunca por extensión ni por el mime declarado: PDF, JPG, PNG, WEBP,
//        HEIC/HEIF. Lo que se persiste es el mime DETECTADO.
// RN-DA2 15 MB por archivo (inclusivo), 20 aceptados y 250 MB acumulados por envío, en orden.
// RN-DA3 Un adicional idéntico (sha256) a otro del envío —incluida la factura de venta— se
//        descarta como «documento repetido». En la carga posterior (HU #13364) también el idéntico a
//        un adicional YA guardado en la solicitud o a su factura de venta viva (decisión de David,
//        2026-10-07). Los cupos de RN-DA2 son POR ENVÍO: sin techo acumulado por solicitud.
// RN-DA4 El borrado es DEFINITIVO, en cualquier estado y por cualquiera con la función: primero la
//        fila (ya no se lista ni se descarga), después el objeto, con 3 intentos. Si el objeto no se
//        borra queda registrado (`soat.adicional.objeto_huerfano` + Bitácora), nunca un 5xx.

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  MotivoDescarteDocumentoAdicional, TipoSoporte,
  type DocumentoAdicionalSoat, type ResultadoDocumentosAdicionales,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoSoportes } from '../../db/schema.js';
import {
  deleteEntityDocument, firmarDescargaEntidad, removeEntityDocument, uploadEntityDocument,
} from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { detectMime } from '../pesv/magic-number.js';
import { buscarConAcceso, type SoatCtx } from './flito-soat.service.js';
import { TAMANO_MAX_ARCHIVO, type ArchivoAdicionalRecibido } from './flito-soat-documentos.upload.js';

const MB = 1024 * 1024;
const log = loggerFor('flito-soat-documentos');

/** Los topes de negocio (RN-DA2). Parámetro de `clasificarAdicionales` para poder probarlos en pequeño. */
export interface UmbralesAdicionales { tamanoMax: number; cantidadMax: number; totalMax: number }
export const UMBRALES_ADICIONALES: UmbralesAdicionales = {
  tamanoMax: TAMANO_MAX_ARCHIVO, cantidadMax: 20, totalMax: 250 * MB,
};

/** HEIC/HEIF incluye sus variantes de secuencia (marcas `msf1`/`hevc` de `file-type`): mismo contenedor. */
export const MIMES_ADICIONALES: readonly string[] = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
];

/** Subcarpeta de storage (bajo la carpeta de la compañía), hermana de `soat/facturas-venta`. */
export const CARPETA_ADICIONALES = 'soat/documentos-adicionales';

export const LARGO_ETIQUETA = 150;
const LARGO_NOMBRE_ARCHIVO = 300;
/** Lo que del nombre de archivo cabe en la Bitácora cuando no hubo etiqueta (AC10). */
export const LARGO_NOMBRE_BITACORA = 40;

/** Texto para la persona de cada motivo de descarte. */
export const MOTIVO_DESCARTE_TEXTO: Record<MotivoDescarteDocumentoAdicional, string> = {
  [MotivoDescarteDocumentoAdicional.SUPERA_TAMANO]: 'supera el tamaño máximo de 15 MB',
  [MotivoDescarteDocumentoAdicional.FORMATO_NO_PERMITIDO]: 'formato no permitido',
  [MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO]: 'documento repetido',
  [MotivoDescarteDocumentoAdicional.SUPERA_CANTIDAD]: 'supera el máximo de 20 documentos por envío',
  [MotivoDescarteDocumentoAdicional.SUPERA_TOTAL]: 'supera el total de 250 MB por envío',
};

export class DocumentoAdicionalError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DocumentoAdicionalError';
  }
}

/** Un adicional que pasó la clasificación: listo para subir. */
export interface AdicionalAceptado {
  path: string;
  nombreArchivo: string;
  etiqueta: string;
  /** La etiqueta vino vacía y se usó el nombre del archivo (AC2): la Bitácora lo trunca (AC10). */
  etiquetaDeNombre: boolean;
  contentType: string;
  tamanoBytes: number;
  hash: string;
}

/** Ya en S3, pendiente de su fila. */
export interface AdicionalSubido extends AdicionalAceptado { storageKey: string }

/** Ya con fila: lo que la ruta necesita para la Bitácora y el 201/202. */
export interface AdicionalGuardado {
  id: string;
  etiqueta: string;
  etiquetaDeNombre: boolean;
  nombreArchivo: string;
  contentType: string;
  tamanoBytes: number;
}

export interface Clasificacion {
  aceptados: AdicionalAceptado[];
  descartados: ResultadoDocumentosAdicionales['descartados'];
}

/** `string | string[] | undefined` del multipart → array de etiquetas alineado por índice. */
export function normalizarEtiquetas(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : ''));
  return typeof v === 'string' ? [v] : [];
}

/** D2 — la primera regla que falla decide; en el orden recibido. Sin E/S de storage ni BD. */
export async function clasificarAdicionales(
  archivos: readonly ArchivoAdicionalRecibido[],
  etiquetasCrudas: unknown,
  /** Huellas contra las que también es «repetido»: la factura del alta, o lo ya guardado (HU #13364). */
  hashesPrevios: string | readonly string[] | null,
  umbrales: UmbralesAdicionales = UMBRALES_ADICIONALES,
): Promise<Clasificacion> {
  const etiquetas = normalizarEtiquetas(etiquetasCrudas);
  const previos = hashesPrevios == null ? [] : typeof hashesPrevios === 'string' ? [hashesPrevios] : hashesPrevios;
  const vistos = new Set<string>(previos.filter((h) => !!h));
  const aceptados: AdicionalAceptado[] = [];
  const descartados: Clasificacion['descartados'] = [];
  let acumulado = 0;

  for (const [i, a] of archivos.entries()) {
    const descartar = (codigo: MotivoDescarteDocumentoAdicional) =>
      descartados.push({ nombreArchivo: a.originalname, codigo, motivo: MOTIVO_DESCARTE_TEXTO[codigo] });

    if (a.excedeTamano || a.size > umbrales.tamanoMax) {
      descartar(MotivoDescarteDocumentoAdicional.SUPERA_TAMANO); continue;
    }
    const mime = a.cabecera.length > 0 ? await detectMime(a.cabecera) : undefined;
    if (!mime || !MIMES_ADICIONALES.includes(mime)) {
      descartar(MotivoDescarteDocumentoAdicional.FORMATO_NO_PERMITIDO); continue;
    }
    // El hash de uno que el motor dejó de escribir (tope de disco) es parcial: no compara.
    if (!a.excedeTotal && vistos.has(a.sha256)) {
      descartar(MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO); continue;
    }
    if (aceptados.length >= umbrales.cantidadMax) {
      descartar(MotivoDescarteDocumentoAdicional.SUPERA_CANTIDAD); continue;
    }
    if (a.excedeTotal || !a.path || acumulado + a.size > umbrales.totalMax) {
      descartar(MotivoDescarteDocumentoAdicional.SUPERA_TOTAL); continue;
    }

    const tecleada = (etiquetas[i] ?? '').trim();
    vistos.add(a.sha256);
    acumulado += a.size;
    aceptados.push({
      path: a.path,
      nombreArchivo: a.originalname.slice(0, LARGO_NOMBRE_ARCHIVO),
      etiqueta: (tecleada || a.originalname).slice(0, LARGO_ETIQUETA),
      etiquetaDeNombre: !tecleada,
      contentType: mime,
      tamanoBytes: a.size,
      hash: a.sha256,
    });
  }
  return { aceptados, descartados };
}

/** Borra de S3 lo ya subido. Nunca lanza: es la compensación de un error que sí se relanza. */
export async function compensarAdicionales(subidos: readonly { storageKey: string }[]): Promise<void> {
  await Promise.allSettled(subidos.map((s) => deleteEntityDocument(s.storageKey)));
}

/**
 * Sube los aceptados, en orden y de uno en uno (cada temporal ≤15 MB a memoria). Si una subida
 * falla, borra las ya subidas y relanza: el alta falla igual que cuando falla la subida de la
 * factura — un fallo de infraestructura no es un «descarte».
 */
export async function subirAdicionales(
  carpeta: string, entityId: string, aceptados: readonly AdicionalAceptado[],
): Promise<AdicionalSubido[]> {
  const subidos: AdicionalSubido[] = [];
  try {
    for (const a of aceptados) {
      const buffer = await readFile(a.path);
      const storageKey = await uploadEntityDocument(carpeta, entityId, a.nombreArchivo, buffer, a.contentType);
      subidos.push({ ...a, storageKey });
    }
  } catch (e) {
    await compensarAdicionales(subidos);
    throw e;
  }
  return subidos;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Contra la solicitud (alta normal) o contra la por validar (RUNT caído, D3-bis). */
export type DestinoAdicionales = { soatId: string } | { soatIncompletaId: string };

/** Las filas de `flito_soportes`, dentro de la transacción de quien llama. */
export async function insertarAdicionales(
  tx: Tx, subidos: readonly AdicionalSubido[], destino: DestinoAdicionales,
  autor: { id: number; nombre: string },
): Promise<AdicionalGuardado[]> {
  const guardados: AdicionalGuardado[] = [];
  for (const s of subidos) {
    const [fila] = await tx.insert(flitoSoportes).values({
      tipo: TipoSoporte.DOCUMENTO_ADICIONAL_SOAT,
      etiqueta: s.etiqueta,
      nombreArchivo: s.nombreArchivo,
      contentType: s.contentType,
      storageKey: s.storageKey,
      hash: s.hash,
      tamanoBytes: s.tamanoBytes,
      soatId: 'soatId' in destino ? destino.soatId : null,
      soatIncompletaId: 'soatIncompletaId' in destino ? destino.soatIncompletaId : null,
      subidoPorId: autor.id,
      subidoPorNombre: autor.nombre,
    }).returning({ id: flitoSoportes.id });
    guardados.push({
      id: fila.id, etiqueta: s.etiqueta, etiquetaDeNombre: s.etiquetaDeNombre,
      nombreArchivo: s.nombreArchivo, contentType: s.contentType, tamanoBytes: s.tamanoBytes,
    });
  }
  return guardados;
}

/**
 * D3-bis §3 — al completar una por validar, sus adicionales pasan a la solicitud nacida. Acotado a
 * la incompleta Y al tipo; `soat_incompleta_id` se conserva como rastro, igual que el comprador.
 */
export async function vincularAdicionalesAlSoat(tx: Tx, soatIncompletaId: string, soatId: string): Promise<void> {
  await tx.update(flitoSoportes).set({ soatId }).where(and(
    eq(flitoSoportes.soatIncompletaId, soatIncompletaId),
    eq(flitoSoportes.tipo, TipoSoporte.DOCUMENTO_ADICIONAL_SOAT),
  ));
}

/** El bloque `documentosAdicionales` del 201/202. */
export function resultadoAdicionales(
  guardados: readonly AdicionalGuardado[], descartados: Clasificacion['descartados'],
): ResultadoDocumentosAdicionales {
  return {
    aceptados: guardados.map((g) => ({
      id: g.id, etiqueta: g.etiqueta, nombreArchivo: g.nombreArchivo,
      tipoContenido: g.contentType, tamanoBytes: g.tamanoBytes,
    })),
    descartados: [...descartados],
  };
}

/**
 * AC10 (#13362) / AC9 (#13364) — el `detail` de la Bitácora: sin contenido y sin el nombre completo
 * del archivo. El verbo cambia con la acción; `pendienteDeBorrar` deja rastro del objeto huérfano.
 */
export function detalleBitacoraAdicional(
  g: Pick<AdicionalGuardado, 'id' | 'etiqueta' | 'etiquetaDeNombre' | 'nombreArchivo'>,
  accion: 'cargado' | 'eliminado' = 'cargado',
  pendienteDeBorrar = false,
): string {
  const extra = pendienteDeBorrar ? ', objeto pendiente de borrar' : '';
  if (!g.etiquetaDeNombre) return `Documento adicional ${accion} (soporte=${g.id}, etiqueta=${g.etiqueta}${extra})`;
  const nombre = g.nombreArchivo.length > LARGO_NOMBRE_BITACORA
    ? `${g.nombreArchivo.slice(0, LARGO_NOMBRE_BITACORA)}…`
    : g.nombreArchivo;
  return `Documento adicional ${accion} (soporte=${g.id}, nombre=${nombre}${extra})`;
}

/**
 * AC8 — los adicionales de una solicitud. La frontera es la del detalle: sin acceso a la solicitud
 * → 404 (no 403), para no confirmar que existe. Nunca devuelve la clave de storage: solo la URL
 * firmada y temporal.
 */
export async function listarDocumentosAdicionales(id: string, ctx: SoatCtx): Promise<DocumentoAdicionalSoat[]> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) throw new DocumentoAdicionalError('Solicitud de SOAT no encontrada', 404);
  const filas = await db.select({
    id: flitoSoportes.id, etiqueta: flitoSoportes.etiqueta, contentType: flitoSoportes.contentType,
    tamanoBytes: flitoSoportes.tamanoBytes, subidoEn: flitoSoportes.subidoEn,
    subidoPorNombre: flitoSoportes.subidoPorNombre, storageKey: flitoSoportes.storageKey,
  }).from(flitoSoportes).where(and(
    eq(flitoSoportes.soatId, soat.id),
    eq(flitoSoportes.tipo, TipoSoporte.DOCUMENTO_ADICIONAL_SOAT),
    eq(flitoSoportes.descartado, false),
  )).orderBy(asc(flitoSoportes.subidoEn), asc(flitoSoportes.id));
  return filas.map((f) => ({
    id: f.id, etiqueta: f.etiqueta ?? '', tipoContenido: f.contentType, tamanoBytes: Number(f.tamanoBytes),
    subidoEn: new Date(f.subidoEn).toISOString(), subidoPorNombre: f.subidoPorNombre,
    url: firmarDescargaEntidad(f.storageKey),
  }));
}

// ── HU #13364 — carga posterior y borrado definitivo ────────────────────────────────────────────

const NO_ENCONTRADA = 'Solicitud de SOAT no encontrada';
export const MENSAJE_SIN_ARCHIVOS = 'Adjunta al menos un documento';
export const MENSAJE_DOCUMENTO_NO_ENCONTRADO = 'Documento adicional no encontrado';

/**
 * El predicado del índice único parcial `uq_flito_soportes_adicional_soat_hash` (migración 0223).
 * El `ON CONFLICT … WHERE` de la carga debe repetirlo: si no, Postgres responde 42P10.
 */
export const PREDICADO_INDICE_ADICIONAL_HASH = sql`tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL`;

/**
 * Huellas contra las que un adicional nuevo es «repetido»: los adicionales vivos de la solicitud Y
 * su factura de venta viva (decisión de David, 2026-10-07: igual que en el alta).
 */
export async function hashesPreviosDeSolicitud(soatId: string): Promise<string[]> {
  const filas = await db.select({ hash: flitoSoportes.hash }).from(flitoSoportes).where(and(
    eq(flitoSoportes.soatId, soatId),
    inArray(flitoSoportes.tipo, [TipoSoporte.DOCUMENTO_ADICIONAL_SOAT, TipoSoporte.FACTURA_VENTA]),
    eq(flitoSoportes.descartado, false),
  ));
  return filas.map((f) => f.hash);
}

/**
 * D4 — como `insertarAdicionales`, pero el índice único parcial cierra la carrera de dos cargas
 * simultáneas del mismo archivo: el que pierde no vuelve en `returning` y sale en `perdedores`, sin
 * abortar la transacción.
 */
export async function insertarAdicionalesDeCarga(
  tx: Tx, subidos: readonly AdicionalSubido[], soatId: string, autor: { id: number; nombre: string },
): Promise<{ guardados: AdicionalGuardado[]; perdedores: AdicionalSubido[] }> {
  const guardados: AdicionalGuardado[] = [];
  const perdedores: AdicionalSubido[] = [];
  for (const s of subidos) {
    const filas = await tx.insert(flitoSoportes).values({
      tipo: TipoSoporte.DOCUMENTO_ADICIONAL_SOAT,
      etiqueta: s.etiqueta,
      nombreArchivo: s.nombreArchivo,
      contentType: s.contentType,
      storageKey: s.storageKey,
      hash: s.hash,
      tamanoBytes: s.tamanoBytes,
      soatId,
      soatIncompletaId: null,
      subidoPorId: autor.id,
      subidoPorNombre: autor.nombre,
    }).onConflictDoNothing({
      target: [flitoSoportes.soatId, flitoSoportes.hash],
      where: PREDICADO_INDICE_ADICIONAL_HASH,
    }).returning({ id: flitoSoportes.id });
    const fila = filas[0];
    if (!fila) { perdedores.push(s); continue; }
    guardados.push({
      id: fila.id, etiqueta: s.etiqueta, etiquetaDeNombre: s.etiquetaDeNombre,
      nombreArchivo: s.nombreArchivo, contentType: s.contentType, tamanoBytes: s.tamanoBytes,
    });
  }
  return { guardados, perdedores };
}

async function carpetaAdicionalesDe(companiaId: number): Promise<string> {
  const [c] = await db.select({ carpeta: clients.flitoCarpetaStorage }).from(clients)
    .where(eq(clients.id, companiaId)).limit(1);
  return carpetaDe({ id: companiaId, flitoCarpetaStorage: c?.carpeta ?? null }, CARPETA_ADICIONALES);
}

/**
 * AC1/AC2 (#13364) — carga posterior sobre una solicitud existente, en CUALQUIER estado. Mismas
 * reglas que el alta (`clasificarAdicionales`), cupos por envío, y repetido también contra lo ya
 * guardado. S3 fuera de la transacción; si la transacción falla, nada queda (compensación).
 */
export async function cargarDocumentosAdicionales(
  id: string, ctx: SoatCtx, archivos: readonly ArchivoAdicionalRecibido[], etiquetas: unknown,
): Promise<{ guardados: AdicionalGuardado[]; resultado: ResultadoDocumentosAdicionales }> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) throw new DocumentoAdicionalError(NO_ENCONTRADA, 404);
  if (archivos.length === 0) throw new DocumentoAdicionalError(MENSAJE_SIN_ARCHIVOS, 400);

  const previos = await hashesPreviosDeSolicitud(soat.id);
  const clasificacion = await clasificarAdicionales(archivos, etiquetas, previos);
  if (clasificacion.aceptados.length === 0) {
    return { guardados: [], resultado: resultadoAdicionales([], clasificacion.descartados) };
  }
  const carpeta = await carpetaAdicionalesDe(soat.companiaId);
  const subidos = await subirAdicionales(carpeta, soat.id, clasificacion.aceptados);
  let insercion: Awaited<ReturnType<typeof insertarAdicionalesDeCarga>>;
  try {
    insercion = await db.transaction((tx) =>
      insertarAdicionalesDeCarga(tx, subidos, soat.id, { id: ctx.userId, nombre: ctx.username }));
  } catch (e) {
    await compensarAdicionales(subidos);
    throw e;
  }
  // Los que perdieron la carrera: su objeto sobra y salen como repetidos.
  await compensarAdicionales(insercion.perdedores);
  const repetido = MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO;
  const descartados = [
    ...clasificacion.descartados,
    ...insercion.perdedores.map((p) => ({ nombreArchivo: p.nombreArchivo, codigo: repetido, motivo: MOTIVO_DESCARTE_TEXTO[repetido] })),
  ];
  return { guardados: insercion.guardados, resultado: resultadoAdicionales(insercion.guardados, descartados) };
}

/** Esperas antes de cada intento de borrado del objeto (D6): 3 intentos. */
export const ESPERAS_BORRADO_MS: readonly number[] = [0, 200, 800];

/**
 * Borra el objeto con reintentos. `false` si los 3 fallan: queda `soat.adicional.objeto_huerfano`
 * en el log con el `soporteId` y un hash corto de la clave (`claveHash`). La clave NO va al log: lleva
 * la carpeta de la compañía (suele ser el NIT) y puede llevar el nombre del archivo (PII, AGENTS.md §14).
 * Nunca lanza.
 */
export async function borrarObjetoConReintento(
  soporteId: string, storageKey: string, esperas: readonly number[] = ESPERAS_BORRADO_MS,
): Promise<boolean> {
  for (const ms of esperas) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    try { await removeEntityDocument(storageKey); return true; } catch { /* siguiente intento */ }
  }
  const claveHash = createHash('sha256').update(storageKey).digest('hex').slice(0, 16);
  log.error({ evento: 'soat.adicional.objeto_huerfano', soporteId, claveHash },
    'No se pudo borrar de storage el objeto de un documento adicional eliminado');
  return false;
}

export interface AdicionalEliminado {
  id: string; etiqueta: string; etiquetaDeNombre: boolean; nombreArchivo: string;
  /** El objeto no se pudo borrar de storage tras los reintentos. */
  objetoPendiente: boolean;
}

/**
 * AC5–AC8 (#13364) — borrado DEFINITIVO de un adicional de la solicitud. Sin acceso → 404; la fila
 * debe ser de ESA solicitud y de tipo adicional (la factura u otra solicitud → 404). No filtra por
 * autor (AC6) ni por estado. Primero la fila, después el objeto (D6).
 */
export async function eliminarDocumentoAdicional(
  id: string, soporteId: string, ctx: SoatCtx, esperas: readonly number[] = ESPERAS_BORRADO_MS,
): Promise<AdicionalEliminado> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) throw new DocumentoAdicionalError(NO_ENCONTRADA, 404);
  const [fila] = await db.delete(flitoSoportes).where(and(
    eq(flitoSoportes.id, soporteId),
    eq(flitoSoportes.soatId, soat.id),
    eq(flitoSoportes.tipo, TipoSoporte.DOCUMENTO_ADICIONAL_SOAT),
    eq(flitoSoportes.descartado, false),
  )).returning({
    id: flitoSoportes.id, storageKey: flitoSoportes.storageKey,
    etiqueta: flitoSoportes.etiqueta, nombreArchivo: flitoSoportes.nombreArchivo,
  });
  if (!fila) throw new DocumentoAdicionalError(MENSAJE_DOCUMENTO_NO_ENCONTRADO, 404);
  const borrado = await borrarObjetoConReintento(fila.id, fila.storageKey, esperas);
  const { nombreArchivo } = fila;
  const etiqueta = fila.etiqueta ?? '';
  return {
    id: fila.id, etiqueta, nombreArchivo,
    // La fila no guarda si la etiqueta salió del nombre: se reconstruye (D7).
    etiquetaDeNombre: etiqueta === nombreArchivo.slice(0, LARGO_ETIQUETA),
    objetoPendiente: !borrado,
  };
}
