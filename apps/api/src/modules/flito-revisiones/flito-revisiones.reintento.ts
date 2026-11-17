// FLITO Revisiones — reintentar la lectura OCR de una revisión abierta (Bug #14569, punto 9).
//
// Vuelve a pasar el soporte YA guardado por el mismo flujo de OCR de la carga (`extraer`: motor IA si
// está configurado, local si no) con el extractor y el umbral que usó la carga original de ese módulo
// y tipo de documento, y reemplaza en la revisión los campos leídos (`extraccion`) y lo que depende de
// ellos para la cola (`placaSugerida`, `motivo`/`detalle` si el veredicto del módulo sigue sin aprobar).
//
// La regla que no se toca (RN-04 de SOAT, RN-05 de Impuestos): la revisión SIGUE ABIERTA. Nada se
// paga, concilia ni resuelve solo, aunque la nueva lectura cruce y supere el umbral: este archivo no
// importa la vía de resolver y no escribe más tabla que `flito_revisiones`.
//
// Cómo se eligen extractor y umbral (se lee de cómo se CREÓ la revisión, no se adivina):
//   · SOAT (`flito-soat.service` `cargarFactura`/carga masiva): `extraerFacturaSoat` con el umbral del
//     proveedor SOAT del registro (`umbralPara(proveedor.umbralOcr)`) y `evaluarExtraccionSoat` contra
//     su VIN y placa.
//   · Impuestos (`flito-recibos.service`): el recibo de caja (`tipo = recibo_caja_impuesto`) se lee con
//     `extraerReciboCaja` y `evaluarReciboCaja`; el resto (fase de pago) con `extraerReciboImpuesto` y
//     `evaluarReciboImpuesto`. Umbral: el de Operaciones (`umbralPara(null)`), que es el que aplica a
//     quien carga desde Operaciones; el del organismo solo aplicaba al gestor y quién cargó no se guarda.
//   · Derechos (`flito-derechos.service`): `extraerDerechoTramite` + `evaluarDerecho` con el umbral por
//     defecto y sin pista de prompt: el organismo declarado en la carga no se persiste.
//   · Factura de venta: `extraerFacturaVenta`, recortada a los cinco campos de esta cola
//     (`CAMPOS_REVISION_FACTURA_VENTA`): los del comprador NO se persisten aquí. No hay veredicto del
//     módulo para esta cola, así que motivo y detalle no cambian.
//
// Lectura vacía (ningún campo con valor) → la revisión NO se toca: nunca se sobrescribe una extracción
// con otra vacía. Un soporte cifrado guardado no se descifra: no leerá y cae en ese caso.

import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import {
  CAMPOS_REVISION_FACTURA_VENTA, CampoDerechoTramite, CampoFacturaVenta, CampoSoat, FlujoRevision, TipoSoporte,
  type CampoExtraido, type MotivoRevision,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoProveedoresSoat, flitoRevisiones, flitoSoat, flitoSoportes, vehicles } from '../../db/schema.js';
import { getEntityDocumentStream } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import {
  extraerDerechoTramite, extraerFacturaSoat, extraerFacturaVenta, extraerReciboCaja, extraerReciboImpuesto,
  type DocumentoAAnalizar,
} from '../flito-ocr/flito-ocr.service.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { evaluarExtraccionSoat } from '../flito-soat/flito-soat.service.js';
import { evaluarReciboCaja, evaluarReciboImpuesto } from '../flito-impuestos/flito-recibos.service.js';
import { evaluarDerecho } from '../flito-derechos/flito-derechos.service.js';
import { obtenerItem, RevisionError, type RevisionItem } from './flito-revisiones.service.js';

const log = loggerFor('flito-revisiones-reintento');

/** Copy del 503 cuando el soporte guardado no se pudo leer del almacenamiento. */
export const MENSAJE_SOPORTE_NO_DISPONIBLE = 'No se pudo abrir el documento guardado de esta revisión. Intenta de nuevo en unos minutos.';

export interface ResultadoReintento {
  /** La revisión como la entrega el listado (con `registroActual`), ya actualizada o intacta. */
  revision: RevisionItem;
  /** true: la nueva lectura no trajo ningún campo y la revisión quedó intacta. */
  sinLectura: boolean;
  /** Campos con valor en la nueva lectura (0 cuando `sinLectura`). */
  camposLeidos: number;
  modulo: string;
}

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }
interface Lectura { extraccion: Record<string, CampoExtraido>; veredicto: Veredicto | null; placa: string | null | undefined }

async function contenidoDe(storageKey: string): Promise<Buffer> {
  try {
    const stream = await getEntityDocumentStream(storageKey);
    const partes: Buffer[] = [];
    for await (const parte of stream as Readable) partes.push(Buffer.isBuffer(parte) ? parte : Buffer.from(parte));
    return Buffer.concat(partes);
  } catch (e) {
    // Sin la llave en el log (lleva la carpeta de la compañía y el id del registro).
    log.warn({ err: e instanceof Error ? e.name : 'desconocido' }, 'Reintento OCR: no se pudo leer el soporte del almacenamiento');
    throw new RevisionError(503, MENSAJE_SOPORTE_NO_DISPONIBLE);
  }
}

type Doc = (umbral: number) => DocumentoAAnalizar;

async function leerSoat(doc: Doc, registroId: string | null): Promise<Lectura> {
  const [soat] = registroId
    ? await db.select({ vin: flitoSoat.vin, placa: vehicles.plate, umbralOcr: flitoProveedoresSoat.umbralOcr })
      .from(flitoSoat)
      .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
      .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
      .where(eq(flitoSoat.id, registroId)).limit(1)
    : [];
  const umbral = umbralPara(soat?.umbralOcr ?? null);
  const extraccion = await extraerFacturaSoat(doc(umbral));
  const veredicto = soat ? evaluarExtraccionSoat(extraccion, { vin: soat.vin, placa: soat.placa }, umbral) : null;
  return { extraccion: extraccion as Record<string, CampoExtraido>, veredicto, placa: extraccion[CampoSoat.PLACA]?.valor };
}

async function leerImpuesto(doc: Doc, tipoSoporte: string): Promise<Lectura> {
  const umbral = umbralPara(null);
  if (tipoSoporte === TipoSoporte.RECIBO_CAJA_IMPUESTO) {
    const extraccion = await extraerReciboCaja(doc(umbral));
    return { extraccion: extraccion as Record<string, CampoExtraido>, veredicto: evaluarReciboCaja(extraccion, umbral), placa: undefined };
  }
  const extraccion = await extraerReciboImpuesto(doc(umbral));
  // La placa sugerida de impuestos es la del registro candidato (`aRevision(…, cand.placa)`), no la leída.
  return { extraccion: extraccion as Record<string, CampoExtraido>, veredicto: evaluarReciboImpuesto(extraccion, umbral), placa: undefined };
}

async function leerDerecho(doc: Doc): Promise<Lectura> {
  const umbral = umbralPara(null);
  const extraccion = await extraerDerechoTramite(doc(umbral), null);
  return { extraccion: extraccion as Record<string, CampoExtraido>, veredicto: evaluarDerecho(extraccion, umbral), placa: extraccion[CampoDerechoTramite.PLACA]?.valor };
}

async function leerFacturaVenta(doc: Doc): Promise<Lectura> {
  const completa = await extraerFacturaVenta(doc(umbralPara(null))) as Record<string, CampoExtraido>;
  const extraccion: Record<string, CampoExtraido> = {};
  for (const c of CAMPOS_REVISION_FACTURA_VENTA) if (completa[c]) extraccion[c] = completa[c];
  return { extraccion, veredicto: null, placa: extraccion[CampoFacturaVenta.PLACA]?.valor };
}

function contarLeidos(extraccion: Record<string, CampoExtraido>): number {
  return Object.values(extraccion).filter((c) => c && c.valor !== null && c.valor !== undefined && String(c.valor).trim() !== '').length;
}

/**
 * Reintenta la lectura OCR del soporte de una revisión abierta. Lanza `RevisionError` 404/409/503 y
 * deja pasar `OcrNoDisponibleError` (la ruta la traduce a 503). En ningún error la revisión cambia: el
 * único `update` va al final, tras una lectura con al menos un campo.
 */
export async function reintentarLectura(id: string): Promise<ResultadoReintento> {
  const [r] = await db.select({
    modulo: flitoRevisiones.modulo, resuelto: flitoRevisiones.resuelto, registroId: flitoRevisiones.registroId,
    placaSugerida: flitoRevisiones.placaSugerida,
    storageKey: flitoSoportes.storageKey, nombreArchivo: flitoSoportes.nombreArchivo,
    contentType: flitoSoportes.contentType, tipo: flitoSoportes.tipo,
  }).from(flitoRevisiones)
    .innerJoin(flitoSoportes, eq(flitoRevisiones.soporteId, flitoSoportes.id))
    .where(eq(flitoRevisiones.id, id)).limit(1);
  if (!r) throw new RevisionError(404, 'La revisión no existe');
  if (r.resuelto) throw new RevisionError(409, 'La revisión ya está resuelta');

  const contenido = await contenidoDe(r.storageKey);
  const doc: Doc = (umbral) => ({ nombreArchivo: r.nombreArchivo, contentType: r.contentType, contenido, umbral });

  let lectura: Lectura;
  if (r.modulo === FlujoRevision.SOAT) lectura = await leerSoat(doc, r.registroId);
  else if (r.modulo === FlujoRevision.DERECHOS) lectura = await leerDerecho(doc);
  else if (r.modulo === FlujoRevision.FACTURA_VENTA) lectura = await leerFacturaVenta(doc);
  else lectura = await leerImpuesto(doc, r.tipo);

  const camposLeidos = contarLeidos(lectura.extraccion);
  if (camposLeidos === 0) {
    const revision = await obtenerItem(id);
    if (!revision) throw new RevisionError(404, 'La revisión no existe');
    return { revision, sinLectura: true, camposLeidos: 0, modulo: r.modulo };
  }

  // Si el veredicto del módulo ahora aprueba, motivo y detalle se conservan: la revisión sigue abierta
  // y la razón original (p. ej. varios trámites para la placa) no la borra una lectura mejor.
  const cambiaMotivo = lectura.veredicto && !lectura.veredicto.aprobada && lectura.veredicto.motivo && lectura.veredicto.detalle;
  const actualizadas = await db.update(flitoRevisiones).set({
    extraccion: lectura.extraccion,
    placaSugerida: lectura.placa === undefined ? r.placaSugerida : (lectura.placa ?? r.placaSugerida),
    ...(cambiaMotivo ? { motivo: lectura.veredicto!.motivo!, detalle: lectura.veredicto!.detalle! } : {}),
  }).where(and(eq(flitoRevisiones.id, id), eq(flitoRevisiones.resuelto, false)))
    .returning({ id: flitoRevisiones.id });
  // La resolvieron mientras el OCR leía: lo ganado por la otra persona no se pisa.
  if (actualizadas.length === 0) throw new RevisionError(409, 'La revisión ya está resuelta');

  const revision = await obtenerItem(id);
  if (!revision) throw new RevisionError(404, 'La revisión no existe');
  return { revision, sinLectura: false, camposLeidos, modulo: r.modulo };
}
