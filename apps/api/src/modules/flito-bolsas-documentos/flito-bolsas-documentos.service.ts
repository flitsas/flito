// FLITO — Expediente documental de la COMPAÑÍA en bolsas (HU #13889, Feature #13888, ADR-0028).
//
// RN-BD1  Una fila por versión. La vigente es la única con `vigente = true` por (compañía, tipo); al
//         reemplazar, la anterior pasa a `vigente = false` + `reemplazado_en` en la MISMA transacción, y
//         la nueva entra con `version = max + 1`. Dos cargas simultáneas chocan en el índice parcial →
//         409 (D1).
// RN-BD2  Los 5 tipos se cifran en reposo (AES-256-GCM con `PII_ENC_KEY`, AAD ligada al id de la fila y
//         a su `aad_nonce`), ADR-0028 D5 y §14. El objeto en MinIO es el texto cifrado; su clave no lleva
//         PII y no se guarda el nombre original del archivo (D7).
// RN-BD3  La vigencia se CALCULA al leer (D2): se guarda la fecha de expedición, nunca el estado.
// RN-BD4  Cargar exige bolsa de compañía (404 si no la hay — incluye compañías solo con bolsa de
//         tránsito) y bolsa activa (409, decisión cerrada del 2026-10-23). Leer y descargar no lo exigen.
// RN-BD5  OCR: los 3 tipos con vigencia nacen con `ocr_estado = 'validando'` (D3) y la cédula y el
//         adicional con `no_aplica` (D8: nunca van al OCR). Desde la HU #13890 la ruta lanza el OCR
//         DESPUÉS de responder (`flito-bolsas-documentos.ocr.ts`) y un cron de rescate retoma toda fila
//         en `validando` de más de 3 min. Mientras tanto el estado se muestra como `validando` (D4).
// RN-BD6  Fecha manual (E4, HU #13890): solo sobre la versión VIGENTE de un tipo con vigencia, con bolsa
//         activa (409 si no), y deja quién y cuándo (`fecha_manual_por/_en`). El OCR nunca la pisa
//         (`WHERE fecha_origen IS DISTINCT FROM 'manual'`). La regla de 30 días se aplica igual sobre ella.
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  DIAS_VIGENCIA_DOCUMENTO_BOLSA, TIPOS_DOCUMENTO_BOLSA, TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA,
  TIPOS_DOCUMENTO_BOLSA_PRINCIPALES,
  type DocumentoBolsaDto, type DocumentoBolsaVersionDto, type EstadoDocumentoBolsa, type EstadoExpedienteLoteDto,
  type ExpedienteCompaniaDto, type TipoDocumentoBolsaPrincipal,
  type MimeDocumentoBolsa, type OrigenFechaExpedicion, type TipoDocumentoBolsa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoBolsasDocumentos, users } from '../../db/schema.js';
import { decryptPiiBuffer, encryptPiiBuffer, newUuid, type AadParts } from '../../shared/utils/crypto.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';
import { esCodigoPg } from '../../shared/utils/pg-error.js';
import { deleteEntityDocument, getEntityDocumentStream, uploadEntityDocument } from '../../services/storage.js';
import { estadoBolsaDeCompania } from './flito-bolsas-documentos.bolsa-compania.js';

/** Prefijo de las claves en el almacenamiento: `flito-bolsas-documentos/<companiaId>/<ts>_<uuid>.bin`. */
export const PREFIJO_STORAGE = 'flito-bolsas-documentos';

/** Error de negocio: la ruta lo traduce a `{ error }` con `estado`. El mensaje es copy de producto. */
export class BolsaDocumentoError extends Error {
  constructor(readonly estado: number, mensaje: string) {
    super(mensaje);
    this.name = 'BolsaDocumentoError';
  }
}

const t = flitoBolsasDocumentos;
const cargador = alias(users, 'cargador');
const fijador = alias(users, 'fijador');
const CON_VIGENCIA = new Set<string>(TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA);

/** La AAD de una fila: liga el texto cifrado a ESTE documento (un blob de otra fila no descifra aquí). */
function aadDe(documentoId: string, aadNonce: string): AadParts {
  return { table: 'flito_bolsas_documentos', column: 'archivo', empresaNit: documentoId, aadNonce };
}

// ── Vigencia (RN-BD3) ───────────────────────────────────────────────────────────────────────────

interface FilaVigencia {
  tipo: string;
  fechaExpedicion: string | null;
  ocrEstado: string;
}

/** `yyyy-mm-dd` + n días, en calendario (sin husos: es una fecha civil). */
function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Estado de un tipo del expediente (ADR-0028 §5, tabla de cálculo). El día 30 es inclusivo. */
export function estadoDe(fila: FilaVigencia | null, hoy: string = hoyColombia()): EstadoDocumentoBolsa {
  if (!fila) return 'pendiente';
  if (!CON_VIGENCIA.has(fila.tipo)) return 'valido';
  if (fila.fechaExpedicion === null) return fila.ocrEstado === 'validando' ? 'validando' : 'no_validado';
  return hoy <= sumarDias(fila.fechaExpedicion, DIAS_VIGENCIA_DOCUMENTO_BOLSA) ? 'valido' : 'vencido';
}

// ── Lectura ─────────────────────────────────────────────────────────────────────────────────────

const columnasDto = {
  id: t.id, tipo: t.tipo, version: t.version, vigente: t.vigente, mime: t.mime, tamanoBytes: t.tamanoBytes,
  storageKey: t.storageKey, fechaExpedicion: t.fechaExpedicion, fechaOrigen: t.fechaOrigen,
  fechaManualEn: t.fechaManualEn, ocrEstado: t.ocrEstado, cargadoEn: t.cargadoEn, reemplazadoEn: t.reemplazadoEn,
  cargadoPorNombre: cargador.name, fechaManualPorNombre: fijador.name,
};

interface FilaDto {
  id: string; tipo: string; version: number; vigente: boolean; mime: string; tamanoBytes: number;
  storageKey: string | null; fechaExpedicion: string | null; fechaOrigen: string | null;
  fechaManualEn: Date | null; ocrEstado: string; cargadoEn: Date; reemplazadoEn: Date | null;
  cargadoPorNombre: string | null; fechaManualPorNombre: string | null;
}

function consultaDto() {
  return db.select(columnasDto).from(t)
    .leftJoin(cargador, eq(cargador.id, t.cargadoPor))
    .leftJoin(fijador, eq(fijador.id, t.fechaManualPor));
}

/** DTO sin PII: ni clave de almacenamiento, ni nombre de archivo, ni hash (ADR-0028 §5). */
function aDto(f: FilaDto, hoy: string): DocumentoBolsaDto {
  return {
    id: f.id,
    tipo: f.tipo as TipoDocumentoBolsa,
    version: f.version,
    estado: estadoDe(f, hoy),
    fechaExpedicion: f.fechaExpedicion,
    fechaOrigen: f.fechaOrigen as OrigenFechaExpedicion | null,
    venceEl: f.fechaExpedicion && CON_VIGENCIA.has(f.tipo)
      ? sumarDias(f.fechaExpedicion, DIAS_VIGENCIA_DOCUMENTO_BOLSA) : null,
    fechaManual: f.fechaManualEn ? { por: f.fechaManualPorNombre, en: f.fechaManualEn.toISOString() } : null,
    mime: f.mime as MimeDocumentoBolsa,
    tamanoBytes: f.tamanoBytes,
    cargadoPor: f.cargadoPorNombre,
    cargadoEn: f.cargadoEn.toISOString(),
  };
}

function aVersionDto(f: FilaDto, hoy: string): DocumentoBolsaVersionDto {
  return {
    ...aDto(f, hoy),
    vigente: f.vigente,
    reemplazadoEn: f.reemplazadoEn ? f.reemplazadoEn.toISOString() : null,
    archivoDisponible: f.storageKey !== null,
  };
}

async function exigirCompania(companiaId: number): Promise<void> {
  const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, companiaId)).limit(1);
  if (!c) throw new BolsaDocumentoError(404, 'La compañía no existe.');
}

/** E1 — El expediente: un renglón por tipo, con su vigente o `pendiente`. El `adicional` es opcional (AC4). */
export async function expedienteDe(companiaId: number, hoy: string = hoyColombia()): Promise<ExpedienteCompaniaDto> {
  await exigirCompania(companiaId);
  const filas = await consultaDto().where(and(eq(t.companiaId, companiaId), eq(t.vigente, true))) as FilaDto[];
  const porTipo = new Map(filas.map((f) => [f.tipo, f]));
  const documentos = TIPOS_DOCUMENTO_BOLSA.map((tipo) => {
    const f = porTipo.get(tipo) ?? null;
    return {
      tipo,
      estado: estadoDe(f, hoy),
      opcional: !(TIPOS_DOCUMENTO_BOLSA_PRINCIPALES as readonly string[]).includes(tipo),
      vigente: f ? aDto(f, hoy) : null,
    };
  });
  const completo = documentos.filter((d) => !d.opcional).every((d) => d.estado === 'valido');
  return { companiaId, completo, documentos };
}

/**
 * E6 — Estado agregado de un lote de compañías (chip del listado, HU #13893). UNA sola consulta para todo
 * el lote (sin N+1) y la vigencia con el mismo `estadoDe` del expediente. Solo los 4 principales: el
 * `adicional` no cuenta. Un id sin bolsa, sin documentos o inexistente sale con `completo: false` y los 4
 * en `pendiente`; no se filtra, para no revelar qué compañías existen (ADR-0028 §5). Sin PII: ids y estados.
 * El orden de la respuesta es el de los ids pedidos.
 */
export async function estadoLoteDe(companiaIds: readonly number[], hoy: string = hoyColombia()): Promise<EstadoExpedienteLoteDto[]> {
  if (companiaIds.length === 0) return [];
  const filas = await db.select({
    companiaId: t.companiaId, tipo: t.tipo, fechaExpedicion: t.fechaExpedicion, ocrEstado: t.ocrEstado,
  }).from(t).where(and(
    inArray(t.companiaId, [...companiaIds]),
    eq(t.vigente, true),
    inArray(t.tipo, [...TIPOS_DOCUMENTO_BOLSA_PRINCIPALES]),
  ));
  const porCompania = new Map<number, Map<string, FilaVigencia>>();
  for (const f of filas) {
    const m = porCompania.get(f.companiaId) ?? new Map<string, FilaVigencia>();
    m.set(f.tipo, f);
    porCompania.set(f.companiaId, m);
  }
  return companiaIds.map((companiaId) => {
    const m = porCompania.get(companiaId);
    const estados = Object.fromEntries(TIPOS_DOCUMENTO_BOLSA_PRINCIPALES.map((tipo) => [
      tipo, estadoDe(m?.get(tipo) ?? null, hoy),
    ])) as Record<TipoDocumentoBolsaPrincipal, EstadoDocumentoBolsa>;
    const completo = Object.values(estados).every((e) => e === 'valido');
    return { companiaId, completo, estados };
  });
}

/** E2 — Historial de un tipo, de la versión más nueva a la más vieja (purgadas sin archivo). */
export async function historialDe(
  companiaId: number, tipo: TipoDocumentoBolsa, hoy: string = hoyColombia(),
): Promise<DocumentoBolsaVersionDto[]> {
  await exigirCompania(companiaId);
  const filas = await consultaDto()
    .where(and(eq(t.companiaId, companiaId), eq(t.tipo, tipo)))
    .orderBy(desc(t.version), asc(t.cargadoEn)) as FilaDto[];
  return filas.map((f) => aVersionDto(f, hoy));
}

// ── Carga y reemplazo (E3) ──────────────────────────────────────────────────────────────────────

export interface CargaDocumento {
  companiaId: number;
  tipo: TipoDocumentoBolsa;
  buffer: Buffer;
  mime: MimeDocumentoBolsa;
  userId: number | null;
}

/**
 * Sube la versión nueva y la deja vigente. Orden (ADR-0028 §12): cifrar → subir → transacción; si la
 * transacción no cuaja, se borra el objeto subido para no dejar huérfanos de hasta 15 MB.
 */
export async function cargarDocumento(c: CargaDocumento): Promise<DocumentoBolsaDto> {
  await exigirCompania(c.companiaId);
  const bolsa = await estadoBolsaDeCompania(c.companiaId);
  if (!bolsa.existe) {
    throw new BolsaDocumentoError(404, 'La compañía no tiene bolsa de compañía: no se le pueden cargar documentos.');
  }
  if (!bolsa.activa) {
    throw new BolsaDocumentoError(409, 'La bolsa de la compañía está inactiva: reactívala para cargar o reemplazar documentos.');
  }

  const id = newUuid();
  const aadNonce = newUuid();
  const cifrado = encryptPiiBuffer(c.buffer, aadDe(id, aadNonce));
  const storageKey = await uploadEntityDocument(
    PREFIJO_STORAGE, c.companiaId, 'archivo.bin', cifrado.cipher, 'application/octet-stream',
  );

  try {
    await db.transaction(async (tx) => {
      const [ultima] = await tx.select({ n: max(t.version) }).from(t)
        .where(and(eq(t.companiaId, c.companiaId), eq(t.tipo, c.tipo)));
      const ahora = new Date();
      await tx.update(t).set({ vigente: false, reemplazadoEn: ahora })
        .where(and(eq(t.companiaId, c.companiaId), eq(t.tipo, c.tipo), eq(t.vigente, true)));
      await tx.insert(t).values({
        id,
        companiaId: c.companiaId,
        tipo: c.tipo,
        version: (ultima?.n ?? 0) + 1,
        vigente: true,
        storageKey,
        mime: c.mime,
        tamanoBytes: c.buffer.length,
        cifradoIv: cifrado.iv,
        cifradoTag: cifrado.authTag,
        cifradoKeyVersion: cifrado.keyVersion,
        aadNonce,
        // RN-BD5: estado inicial del OCR; la ruta lo lanza después de responder.
        ocrEstado: CON_VIGENCIA.has(c.tipo) ? 'validando' : 'no_aplica',
        cargadoPor: c.userId,
      });
    });
  } catch (e) {
    await deleteEntityDocument(storageKey).catch(() => undefined);
    // 23505 en el índice de vigente o de versión: otra carga del mismo tipo ganó la carrera.
    if (esCodigoPg(e, '23505')) {
      throw new BolsaDocumentoError(409, 'Otra persona acaba de cargar este documento. Actualiza e intenta de nuevo.');
    }
    throw e;
  }

  const [fila] = await consultaDto().where(eq(t.id, id)).limit(1) as FilaDto[];
  if (!fila) throw new Error('La versión recién cargada no se pudo leer');
  return aDto(fila, hoyColombia());
}

// ── Fecha de expedición manual (E4, RN-BD6) ─────────────────────────────────────────────────────

/**
 * Fija a mano la fecha de expedición de la versión vigente. La fecha ya llega validada por la ruta
 * (`yyyy-mm-dd` de calendario, no futura). Devuelve el DTO con la vigencia recalculada sobre ella.
 */
export async function fijarFechaManual(
  documentoId: string, fecha: string, userId: number | null,
): Promise<DocumentoBolsaDto> {
  const [f] = await db.select({ companiaId: t.companiaId, tipo: t.tipo, vigente: t.vigente })
    .from(t).where(eq(t.id, documentoId)).limit(1);
  if (!f) throw new BolsaDocumentoError(404, 'El documento no existe.');
  if (!CON_VIGENCIA.has(f.tipo)) {
    throw new BolsaDocumentoError(422, 'Este documento no tiene vigencia: no lleva fecha de expedición.');
  }
  if (!f.vigente) {
    throw new BolsaDocumentoError(409, 'Esta versión ya fue reemplazada: la fecha se fija sobre el documento vigente.');
  }
  const bolsa = await estadoBolsaDeCompania(f.companiaId);
  if (!bolsa.activa) {
    throw new BolsaDocumentoError(409, 'La bolsa de la compañía está inactiva: reactívala para cambiar la fecha del documento.');
  }

  const actualizadas = await db.update(t).set({
    fechaExpedicion: fecha, fechaOrigen: 'manual', fechaManualPor: userId, fechaManualEn: new Date(),
  }).where(and(eq(t.id, documentoId), eq(t.vigente, true))).returning({ id: t.id });
  // Entre la lectura y el UPDATE otra carga pudo reemplazarla.
  if (actualizadas.length === 0) {
    throw new BolsaDocumentoError(409, 'Esta versión ya fue reemplazada: la fecha se fija sobre el documento vigente.');
  }

  const [fila] = await consultaDto().where(eq(t.id, documentoId)).limit(1) as FilaDto[];
  if (!fila) throw new Error('El documento recién actualizado no se pudo leer');
  return aDto(fila, hoyColombia());
}

// ── Descarga (E5) ───────────────────────────────────────────────────────────────────────────────

export interface ArchivoDocumento {
  companiaId: number;
  tipo: TipoDocumentoBolsa;
  version: number;
  mime: MimeDocumentoBolsa;
  contenido: Buffer;
}

async function leerTodo(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const p of stream) partes.push(Buffer.isBuffer(p) ? p : Buffer.from(p as string));
  return Buffer.concat(partes);
}

/** Metadatos de la fila (sin descifrar). 404 si no existe o si su archivo ya se purgó. */
async function filaDeArchivo(documentoId: string) {
  const [f] = await db.select({
    companiaId: t.companiaId, tipo: t.tipo, version: t.version, mime: t.mime, storageKey: t.storageKey,
    iv: t.cifradoIv, tag: t.cifradoTag, keyVersion: t.cifradoKeyVersion, aadNonce: t.aadNonce,
  }).from(t).where(eq(t.id, documentoId)).limit(1);
  if (!f || f.storageKey === null) throw new BolsaDocumentoError(404, 'El documento no existe o su archivo ya no está disponible.');
  return { ...f, storageKey: f.storageKey };
}

/** E5 — Descarga y descifra. Nunca firma una URL: la descarga pasa siempre por la API (D6). */
export async function archivoDe(documentoId: string): Promise<ArchivoDocumento> {
  const f = await filaDeArchivo(documentoId);
  const cifrado = await leerTodo(await getEntityDocumentStream(f.storageKey));
  const contenido = decryptPiiBuffer(
    { cipher: cifrado, iv: f.iv, authTag: f.tag, keyVersion: f.keyVersion },
    aadDe(documentoId, f.aadNonce),
  );
  return {
    companiaId: f.companiaId, tipo: f.tipo as TipoDocumentoBolsa, version: f.version,
    mime: f.mime as MimeDocumentoBolsa, contenido,
  };
}
