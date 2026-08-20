// FLITO Conciliación — el comprobante del pago PSE (HU #11678, Feature #11623, CF-06).
//
// Una boleta se paga en el portal del banco y el portal emite **un** comprobante por ese pago, no
// uno por SOAT. De ahí sale todo lo que este archivo decide:
//
//   · El soporte cuelga de la BOLETA (`flito_soportes.conciliacion_boleta_id`, quinta FK nullable
//     del patrón, ya en la base desde la HU #11673), no de los N movimientos que la conciliación
//     asentó ni de los N SOAT que agrupa.
//   · Solo hay UNO vivo: lo afirma `idx_flito_soportes_boleta_tipo` —único parcial sobre
//     `(conciliacion_boleta_id, tipo) WHERE conciliacion_boleta_id IS NOT NULL AND descartado =
//     false`—. Reemplazar es marcar `descartado = true` el anterior y subir el nuevo, como ya hace
//     el módulo de revisiones; nunca un UPDATE de la fila, que borraría la prueba de lo que se vio.
//   · Solo se admite con la boleta **conciliada**. Antes de conciliar no existe el pago que el
//     archivo documentaría, y —lo que decide— «boleta cargada con comprobante» sería un estado que
//     la alerta del tablero (AC6) no sabe leer: ni pendiente ni resuelta.
//
// ── Sin objeto huérfano (AC1) ────────────────────────────────────────────────────────────────────
//
// El orden es el de `flito-bolsas.routes.ts`: validar → subir → registrar → y si el registro no
// cuaja, borrar el objeto. Aquí se añade un paso barato antes de todo: `destinoComprobante()`
// rechaza la boleta que no admite comprobante y la que ya tiene uno **antes de tocar el
// almacenamiento**, de modo que el caso frecuente (subir dos veces por doble clic) ni siquiera
// llega a crear el objeto que habría que borrar. El borrado de la ruta sigue estando: es la red
// para la carrera que este pre-chequeo no puede cubrir.
//
// ── Quién lo ve, y por qué NO va por la ruta genérica de soportes (AC7) ──────────────────────────
//
// El comprobante se sirve por rutas que nombran a su dueño en el path —`…/boletas/:id/comprobante`
// para Financiera, y `GET /flito/soat/:id/soportes` para el gestor, que pasa por la frontera
// 404-no-403 del SOAT—. Nunca por `GET /flito/bolsas/soportes/:soporteId`, que resolvía cualquier
// soporte por id con solo tener el rol de bolsas: ver la nota de `storageKeySoporteDeBolsa` en
// `flito-bolsas.service.ts`, donde esa ruta pasó a validar pertenencia.
//
// Diseño: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md §7.4 y §7.5
// Copy y estados de la ficha: docs/ux/flito-conciliacion.md, «Pantalla 4 — Comprobante del pago PSE»

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import {
  CodigoErrorConciliacion, EstadoBoleta, TipoSoporte,
  type ComprobanteBoletaDto, type ComprobanteDescargaDto,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoConciliacionBoletas, flitoSoportes } from '../../db/schema.js';
import { firmarDescargaEntidad } from '../../services/storage.js';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import type { CtxUsuario, Tx } from '../flito-bolsas/flito-bolsas.service.js';
import { ConciliacionError } from './flito-conciliacion.errores.js';

type DbOrTx = typeof db | Tx;

/** Subcarpeta del almacenamiento, bajo la carpeta configurada del cliente. */
const SUBCARPETA = 'conciliacion-comprobantes';

/** Extensión por tipo real del archivo. La lista es la misma lista blanca del router. */
const EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Nombre con el que el comprobante se guarda en el ALMACENAMIENTO — nunca el que subió el usuario.
 *
 * `uploadEntityDocument` mete el nombre saneado dentro de la clave, y `firmarDescargaEntidad` mete
 * esa clave en el query string del enlace. Un archivo llamado `comprobante-ABC123.pdf` acabaría con
 * una **placa en la URL**: en los logs de nginx, en el historial del navegador y en la cabecera
 * `Referer` de cualquier recurso que se cargue después. Es el mismo riesgo por el que el `detail` de
 * la bitácora tampoco copia `originalname`, y quedaba abierto por el otro lado.
 *
 * El nombre original **no se pierde**: vive en `flito_soportes.nombre_archivo`, que es lo que la
 * ficha pinta y lo que la descarga devuelve. Lo que cambia es solo la clave del objeto.
 *
 * Se normaliza SOLO aquí y no en `uploadEntityDocument`: aquel helper lo comparten bolsas, SOAT,
 * derechos e impuestos, y cambiarlo sería un cambio transversal que no pertenece a este Feature.
 * La deuda queda registrada aparte.
 */
export function nombreEnAlmacen(contentType: string): string {
  return `comprobante-${randomUUID()}.${EXTENSION[contentType] ?? 'bin'}`;
}

/** El archivo ya subido, listo para registrarse. Misma forma que `SoporteRecarga` de bolsas. */
export interface ArchivoComprobante {
  nombreArchivo: string;
  contentType: string;
  storageKey: string;
  hash: string;
  tamanoBytes: number;
}

/** Fila de `flito_soportes` con lo que la ficha necesita pintar. */
interface FilaSoporte {
  id: string;
  nombreArchivo: string;
  contentType: string;
  storageKey: string;
  tamanoBytes: number;
  subidoEn: Date;
  subidoPorNombre: string;
}

const SELECCION_SOPORTE = {
  id: flitoSoportes.id,
  nombreArchivo: flitoSoportes.nombreArchivo,
  contentType: flitoSoportes.contentType,
  storageKey: flitoSoportes.storageKey,
  tamanoBytes: flitoSoportes.tamanoBytes,
  subidoEn: flitoSoportes.subidoEn,
  subidoPorNombre: flitoSoportes.subidoPorNombre,
};

/**
 * El comprobante VIVO de una boleta.
 *
 * Las tres condiciones son las mismas que las del índice único parcial que garantiza que solo haya
 * uno: la boleta, el tipo y `descartado = false`. Filtrar por menos haría que un comprobante
 * reemplazado volviera a aparecer el día que alguien mirara la ficha.
 */
async function soporteVivo(dbx: DbOrTx, boletaId: string): Promise<FilaSoporte | null> {
  const [s] = await dbx.select(SELECCION_SOPORTE)
    .from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.conciliacionBoletaId, boletaId),
      eq(flitoSoportes.tipo, TipoSoporte.COMPROBANTE_PSE),
      eq(flitoSoportes.descartado, false),
    ))
    .limit(1);
  return s ?? null;
}

/**
 * La fila de la base, ya con su enlace firmado.
 *
 * El DTO **no lleva `storageKey`**, pero conviene ser exacto: `url` sí contiene la clave, como
 * `?key=…` dentro del enlace firmado —así funciona `firmarDescargaEntidad` en todo el monorepo—.
 * Lo que no sale es una ruta de almacenamiento CRUDA y utilizable sin la firma HMAC ni su caducidad.
 * Por eso importa lo otro: que esa clave no lleve datos personales dentro (ver `nombreEnAlmacen`).
 */
function comprobanteDto(s: FilaSoporte): ComprobanteBoletaDto {
  return {
    id: s.id,
    nombreArchivo: s.nombreArchivo,
    contentType: s.contentType,
    tamanoBytes: s.tamanoBytes,
    subidoEn: s.subidoEn.toISOString(),
    subidoPorNombre: s.subidoPorNombre,
    url: firmarDescargaEntidad(s.storageKey),
  };
}

/**
 * El comprobante de una boleta para el DETALLE (AC2), o `null` si todavía no se ha adjuntado.
 *
 * Se exporta para que `detalleBoleta` lo cuelgue de `BoletaDetalleDto` sin conocer la tabla de
 * soportes: quien decide qué es «el comprobante vivo» es este archivo y nadie más.
 */
export async function comprobanteDeBoleta(
  dbx: DbOrTx, boletaId: string,
): Promise<ComprobanteBoletaDto | null> {
  const s = await soporteVivo(dbx, boletaId);
  return s ? comprobanteDto(s) : null;
}

/**
 * Firma FRESCA para abrir el archivo (`GET …/boletas/:id/comprobante`).
 *
 * Existe además de `comprobanteDeBoleta` porque la firma caduca a los cinco minutos: el enlace que
 * viajó con el detalle sirve para saber que hay comprobante, no para pulsarlo media hora después.
 */
export async function descargaComprobante(boletaId: string): Promise<ComprobanteDescargaDto> {
  await boletaExistente(db, boletaId);
  const s = await soporteVivo(db, boletaId);
  if (!s) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.COMPROBANTE_NO_EXISTE,
      'Esta boleta todavía no tiene comprobante.',
    );
  }
  return {
    url: firmarDescargaEntidad(s.storageKey),
    nombreArchivo: s.nombreArchivo,
    contentType: s.contentType,
  };
}

/** Estado y cliente de la boleta. 404 con el mismo código que el resto del módulo si no existe. */
async function boletaExistente(
  dbx: DbOrTx, boletaId: string,
): Promise<{ estado: string; companiaId: number }> {
  const [b] = await dbx.select({
    estado: flitoConciliacionBoletas.estado,
    companiaId: flitoConciliacionBoletas.companiaId,
  }).from(flitoConciliacionBoletas)
    .where(eq(flitoConciliacionBoletas.id, boletaId))
    .limit(1);
  if (!b) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.BOLETA_NO_EXISTE, 'Esa boleta no existe o se descartó.',
    );
  }
  return b;
}

/**
 * Comprueba que la boleta admite comprobante y devuelve el prefijo donde va el archivo.
 *
 * Se llama ANTES de subir nada. Los tres rechazos —boleta inexistente, no conciliada y
 * comprobante ya presente— cuestan dos SELECT y ahorran un objeto de hasta 15 MB en el
 * almacenamiento que después habría que ir a borrar.
 */
export async function destinoComprobante(
  boletaId: string, reemplazar: boolean,
): Promise<{ prefijo: string }> {
  const boleta = await boletaExistente(db, boletaId);
  exigirConciliada(boleta.estado);

  if (!reemplazar && await soporteVivo(db, boletaId)) {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.COMPROBANTE_YA_EXISTE,
      'Esta boleta ya tiene un comprobante.',
    );
  }

  const [compania] = await db
    .select({ id: clients.id, document: clients.document, flitoCarpetaStorage: clients.flitoCarpetaStorage })
    .from(clients)
    .where(eq(clients.id, boleta.companiaId))
    .limit(1);
  if (!compania) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.COMPANIA_NO_EXISTE, 'El cliente de la boleta no existe.',
    );
  }
  return { prefijo: carpetaDe(compania, SUBCARPETA) };
}

/** El comprobante solo tiene sentido sobre un pago ya asentado. Los otros dos estados, con su código. */
function exigirConciliada(estado: string): void {
  if (estado === EstadoBoleta.CONCILIADA) return;
  if (estado === EstadoBoleta.DESCARTADA) {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.BOLETA_DESCARTADA,
      'Esta boleta se descartó: no admite comprobante.',
    );
  }
  throw new ConciliacionError(
    409, CodigoErrorConciliacion.BOLETA_NO_CONCILIADA,
    'El comprobante se adjunta después de conciliar la boleta.',
  );
}

/** `23505`: el índice único parcial ganó la carrera con otra subida simultánea. */
function esClaveDuplicada(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * Registra el archivo ya subido y devuelve el comprobante de la boleta.
 *
 * Todo dentro de UNA transacción: el descarte del anterior y el alta del nuevo son un solo acto —si
 * el alta fallara con el descarte ya escrito, la boleta se quedaría sin comprobante vivo y sin
 * archivo nuevo, que es la única forma de perder una prueba de pago en este flujo—.
 *
 * El estado de la boleta se vuelve a mirar aquí, dentro de la transacción, aunque
 * `destinoComprobante` ya lo hizo: entre las dos llamadas cabe un descarte. Lo mismo con el
 * comprobante vivo, cuya carrera de verdad la corta el `23505` del índice único.
 */
export async function registrarComprobante(
  boletaId: string,
  archivo: ArchivoComprobante,
  ctx: CtxUsuario,
  opciones: { reemplazar: boolean },
): Promise<ComprobanteBoletaDto> {
  try {
    return await db.transaction(async (tx) => {
      const boleta = await boletaExistente(tx, boletaId);
      exigirConciliada(boleta.estado);

      const previo = await soporteVivo(tx, boletaId);
      if (previo && !opciones.reemplazar) {
        throw new ConciliacionError(
          409, CodigoErrorConciliacion.COMPROBANTE_YA_EXISTE,
          'Esta boleta ya tiene un comprobante.',
        );
      }
      if (previo) {
        // Descartar y no borrar: el comprobante reemplazado es la prueba de lo que se adjuntó antes,
        // y el índice único parcial solo mira los vivos, así que el nuevo cabe sin colisionar.
        await tx.update(flitoSoportes)
          .set({ descartado: true })
          .where(eq(flitoSoportes.id, previo.id));
      }

      // Se trunca a lo que aguantan las columnas: un nombre de archivo largo no puede tumbar la
      // subida con un 22001 DESPUÉS de haber dejado el objeto en el almacenamiento.
      const [s] = await tx.insert(flitoSoportes).values({
        tipo: TipoSoporte.COMPROBANTE_PSE,
        nombreArchivo: archivo.nombreArchivo.slice(0, 300),
        contentType: archivo.contentType.slice(0, 100),
        storageKey: archivo.storageKey,
        hash: archivo.hash,
        tamanoBytes: archivo.tamanoBytes,
        conciliacionBoletaId: boletaId,
        subidoPorId: ctx.userId,
        subidoPorNombre: ctx.nombre.slice(0, 150),
      }).returning(SELECCION_SOPORTE);

      return comprobanteDto(s);
    });
  } catch (e) {
    if (esClaveDuplicada(e)) {
      throw new ConciliacionError(
        409, CodigoErrorConciliacion.COMPROBANTE_YA_EXISTE,
        'Esta boleta ya tiene un comprobante.',
      );
    }
    throw e;
  }
}
