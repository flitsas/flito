// Feature #13978, HU #13987 (ADR-0034 D3) — recifrado de los objetos de `flito_bolsas_documentos`.
//
// El dato vive en MinIO y su iv, tag y versión en la fila, así que el cambio no es atómico. Por eso:
//   1. Se descarga y se descifra el objeto actual.
//   2. Se cifra y se sube a una clave NUEVA, sin tocar la actual.
//   3. Se relee el objeto recién subido y se descifra.
//   4. UPDATE con guarda de `storage_key`, `cifrado_iv` y versión. Si la guarda falla, se borra lo subido.
//
// RN-RO6  El objeto anterior queda en `storage_key_previa`: los lectores en vuelo siguen funcionando y
//         restaurar el dump sigue siendo posible. Si la fila ya tenía previa, se conserva solo la
//         inmediatamente anterior y la otra se borra por la cola de borrados pendientes.
// RN-RO7  `--limpiar-objetos` solo borra la previa de filas que ya están en la versión vigente.
//
// Sin claves de objeto en la salida: solo ids de fila y conteos.

import { and, asc, count, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { flitoBolsasDocumentos, flitoStorageBorradosPendientes } from '../../../db/schema.js';
import { getEntityDocumentStream, removeEntityDocument, uploadEntityDocument } from '../../../services/storage.js';
import { esObjetoInexistente, huellaClave, nombreDeError } from '../../../services/storage-errores.js';
import { decryptPiiBuffer, encryptPiiBuffer } from '../../../shared/utils/crypto.js';
import { aadDe, leerTodo, PREFIJO_STORAGE } from '../../flito-bolsas-documentos/flito-bolsas-documentos.service.js';
import { cerrarPendienteTrasBorrado } from '../../flito-soat/flito-soat-borrados-pendientes.service.js';
import { lecturaPorClave } from './lectura.js';
import type { Descriptor, FilaCifrada } from './tipos.js';

const t = flitoBolsasDocumentos;

export const LOTE_OBJETOS = 20;
/** `origen` en `flito_storage_borrados_pendientes`. */
export const ORIGEN_ROTACION_PII = 'rotacion-pii';

export interface CeldaObjeto {
  companiaId: number;
  storageKey: string;
  previa: string | null;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  aadNonce: string;
  /** Texto cifrado aún sin subir. Con él, `descifrar` no baja nada: es lo que deja al dry-run sin escrituras. */
  cipher?: Buffer;
}

function descifrarObjeto(celda: CeldaObjeto, rowKey: string, cipher: Buffer): Buffer {
  return decryptPiiBuffer(
    { cipher, iv: celda.iv, authTag: celda.tag, keyVersion: celda.keyVersion },
    aadDe(rowKey, celda.aadNonce),
  );
}

async function descifrar({ rowKey, celda }: FilaCifrada<CeldaObjeto>): Promise<Buffer> {
  const cipher = celda.cipher ?? await leerTodo(await getEntityDocumentStream(celda.storageKey));
  return descifrarObjeto(celda, rowKey, cipher);
}

/** Un intento; si el almacenamiento falla el pendiente queda abierto y lo reintenta el barrido horario. */
async function borrarPendiente(storageKey: string, pendienteId: string | null): Promise<void> {
  const ahora = new Date();
  try {
    await removeEntityDocument(storageKey);
    await cerrarPendienteTrasBorrado(pendienteId, { borrado: true, motivo: 'borrado', intentos: 1, error: null }, ahora);
  } catch (e) {
    const resultado = esObjetoInexistente(e)
      ? { borrado: true, motivo: 'inexistente' as const, intentos: 1, error: null }
      : { borrado: false, motivo: null, intentos: 1, error: nombreDeError(e) };
    await cerrarPendienteTrasBorrado(pendienteId, resultado, ahora);
  }
}

const valoresPendiente = (storageKey: string) => ({
  storageKey, claveHash: huellaClave(storageKey), origen: ORIGEN_ROTACION_PII,
});

/** Encola y borra un objeto subido que no quedó enlazado: lleva PII. Si el Job o la BD caen antes, queda huérfano. */
async function descartarSubido(storageKey: string): Promise<void> {
  const [p] = await db.insert(flitoStorageBorradosPendientes).values(valoresPendiente(storageKey))
    .returning({ id: flitoStorageBorradosPendientes.id });
  await borrarPendiente(storageKey, p?.id ?? null);
}

async function escribir({ id, rowKey, celda }: FilaCifrada<CeldaObjeto>, valor: CeldaObjeto): Promise<boolean> {
  const nueva = await uploadEntityDocument(
    PREFIJO_STORAGE, celda.companiaId, 'archivo.bin', valor.cipher as Buffer, 'application/octet-stream',
  );
  let r = { enlazada: false, pendientePrevia: null as string | null };
  try {
    // Lo que se enlaza es lo que quedó en el almacenamiento, no lo que se creyó subir.
    descifrarObjeto(valor, rowKey, await leerTodo(await getEntityDocumentStream(nueva)));
    r = await db.transaction(async (tx) => {
      const filas = await tx.update(t)
        .set({
          storageKey: nueva, storageKeyPrevia: celda.storageKey, cifradoIv: valor.iv, cifradoTag: valor.tag,
          cifradoKeyVersion: valor.keyVersion,
        })
        .where(and(
          eq(t.id, id as string),
          eq(t.storageKey, celda.storageKey),
          eq(t.cifradoIv, celda.iv),
          eq(t.cifradoKeyVersion, celda.keyVersion),
          isNull(t.purgadoEn),
        ))
        .returning({ id: t.id });
      if (filas.length === 0) return { enlazada: false, pendientePrevia: null };
      if (!celda.previa) return { enlazada: true, pendientePrevia: null };
      const [p] = await tx.insert(flitoStorageBorradosPendientes).values(valoresPendiente(celda.previa))
        .returning({ id: flitoStorageBorradosPendientes.id });
      return { enlazada: true, pendientePrevia: p?.id ?? null };
    });
  } finally {
    if (!r.enlazada) await descartarSubido(nueva);
  }
  if (r.enlazada && celda.previa) await borrarPendiente(celda.previa, r.pendientePrevia);
  return r.enlazada;
}

export const descriptorObjetosBolsas: Descriptor<CeldaObjeto> = {
  ...lecturaPorClave<CeldaObjeto>({
    id: 'flito_bolsas_documentos.archivo',
    lote: LOTE_OBJETOS,
    tabla: t,
    pk: t.id,
    seleccion: {
      id: t.id, companiaId: t.companiaId, storageKey: t.storageKey, previa: t.storageKeyPrevia, iv: t.cifradoIv,
      tag: t.cifradoTag, keyVersion: t.cifradoKeyVersion, aadNonce: t.aadNonce,
    },
    fila: (r) => ({
      id: r.id as string,
      rowKey: String(r.id),
      celda: {
        companiaId: r.companiaId as number, storageKey: r.storageKey as string, previa: r.previa as string | null,
        iv: r.iv as Buffer, tag: r.tag as Buffer, keyVersion: r.keyVersion as number, aadNonce: r.aadNonce as string,
      },
    }),
    hayDato: and(isNotNull(t.storageKey), isNull(t.purgadoEn)),
    enOtraVersion: (version) => ne(t.cifradoKeyVersion, version),
  }),
  version: ({ celda }) => celda.keyVersion,
  descifrar,
  cifrar: (plano, { rowKey, celda }) => {
    const b = encryptPiiBuffer(plano, aadDe(rowKey, celda.aadNonce));
    return { ...celda, cipher: b.cipher, iv: b.iv, tag: b.authTag, keyVersion: b.keyVersion };
  },
  escribir,
};

// ── Cierre de la ventana de rollback ───────────────────────────────────────────────────────────────

export interface ResultadoLimpieza {
  borrados: number;
  /** La fila cambió entre la lectura y la anulación de la columna. */
  omitido_concurrente: number;
  /** La fila aún no está en la versión vigente: su previa puede ser la única copia legible. */
  omitido_otra_version: number;
  fallo: number;
  idsFallidos: string[];
}

export async function limpiarObjetosPrevios(versionVigente: number): Promise<ResultadoLimpieza> {
  const r: ResultadoLimpieza = { borrados: 0, omitido_concurrente: 0, omitido_otra_version: 0, fallo: 0, idsFallidos: [] };
  let despuesDe: string | null = null;
  for (;;) {
    const lote: { id: string; previa: string | null; keyVersion: number }[] = await db
      .select({ id: t.id, previa: t.storageKeyPrevia, keyVersion: t.cifradoKeyVersion }).from(t)
      .where(and(isNotNull(t.storageKeyPrevia), despuesDe === null ? undefined : gt(t.id, despuesDe)))
      .orderBy(asc(t.id))
      .limit(LOTE_OBJETOS);
    if (lote.length === 0) return r;
    for (const { id, previa, keyVersion } of lote) {
      if (previa === null) continue;
      if (keyVersion !== versionVigente) {
        r.omitido_otra_version += 1;
        continue;
      }
      try {
        // Primero el objeto: si se cae aquí, repetir la corrida lo encuentra otra vez.
        await removeEntityDocument(previa).catch((e: unknown) => {
          if (!esObjetoInexistente(e)) throw e;
        });
        const filas = await db.update(t).set({ storageKeyPrevia: null })
          .where(and(eq(t.id, id), eq(t.storageKeyPrevia, previa)))
          .returning({ id: t.id });
        if (filas.length > 0) r.borrados += 1;
        else r.omitido_concurrente += 1;
      } catch {
        r.fallo += 1;
        r.idsFallidos.push(id);
      }
    }
    despuesDe = lote[lote.length - 1].id;
  }
}

/** Objetos anteriores que siguen en MinIO. Se informan: dependen de la llave que se va a retirar. */
export async function contarObjetosPrevios(): Promise<number> {
  const [fila] = await db.select({ n: count() }).from(t).where(isNotNull(t.storageKeyPrevia));
  return fila?.n ?? 0;
}
