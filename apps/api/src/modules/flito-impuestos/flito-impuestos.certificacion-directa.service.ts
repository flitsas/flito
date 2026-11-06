// Certificación de impuesto sin trámite. No entra en la cola: no hay envío, pago ni comprobante.
// La factura se sube aquí. El PDF del certificado se arma al descargar y no se archiva.
import { and, desc, eq, ne, or } from 'drizzle-orm';
import type { Request } from 'express';
import type { ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestoCertificacionDirecta, organismosTransitoConfig } from '../../db/schema.js';
import type {
  EstadoCertificacionDirecta, ModalidadConsultaRunt, SnapshotCertificacionDirecta,
} from '../../db/schema/flito-impuesto-certificacion-directa.js';
import { loggerFor } from '../../shared/logger.js';
import { getEntityDocumentStream, removeEntityDocument, uploadEntityDocument } from '../../services/storage.js';
import { extraerVehiculoFacturaVenta, OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { mapTipoDocUiToRunt } from '../runt/runt-tipo-doc.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { ImpuestoError, type ArchivoSubido } from './flito-factura-venta.service.js';
import { compararFacturaConRunt } from './flito-impuestos.comparacion-factura-runt.js';
import { registrarAccesoImpuesto } from './flito-impuestos.pii.js';
import {
  extraerColorCilindrajeRunt, extraerRegistroRunt, extraerVehiculoRunt, runtSinRegistro,
} from './certificacion-runt.js';
import {
  clasificarFalloRunt, esPdf, extraccionDesdeDiligenciado, normalizarClave, seisCoinciden,
  type DatosVehiculoDiligenciados,
} from './flito-impuestos.certificacion-directa.reglas.js';

const log = loggerFor('flito-impuestos.certificacion-directa');
const UMBRAL_OCR = 0.85;
const TOPE_LISTA = 100;
const UNIQUE = '23505';
export const FALTA_TIPO_DOCUMENTO = 'Falta el tipo de documento del propietario';

export interface DatosAlta extends DatosVehiculoDiligenciados {
  organismoCodigo: string;
  placa: string;
  documentoPropietario: string | null;
  tipoDocumentoPropietario: string | null;
  nombrePropietario: string | null;
}

export interface SugerenciaFactura {
  vin: string; marca: string; linea: string; anio: string; color: string; cilindrada: string;
  aviso: string | null;
}

export interface FilaCertificacionDirecta {
  id: string;
  organismoCodigo: string;
  organismoNombre: string;
  placa: string;
  documentoPropietario: string | null;
  tipoDocumentoPropietario: string | null;
  nombrePropietario: string | null;
  vin: string;
  marca: string;
  linea: string;
  anio: string;
  color: string;
  cilindrada: string;
  estado: EstadoCertificacionDirecta;
  comparacion: ComparacionCampoFacturaRunt[] | null;
  certificadoEn: string | null;
  createdAt: string;
}

type Fila = typeof flitoImpuestoCertificacionDirecta.$inferSelect;

function esUnico(e: unknown): boolean {
  const c = e as { code?: string; cause?: { code?: string } };
  return c.code === UNIQUE || c.cause?.code === UNIQUE;
}

function aIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

async function nombresDe(organismoCodigo: string): Promise<{ organismo: string }> {
  const [og] = await db.select({ alias: organismosTransitoConfig.alias }).from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, organismoCodigo)).limit(1);
  if (!og) throw new ImpuestoError(400, 'El organismo de tránsito no existe');
  return { organismo: og.alias?.trim() || organismoCodigo };
}

function aFila(r: Fila, organismo: string): FilaCertificacionDirecta {
  return {
    id: r.id, organismoCodigo: r.organismoCodigo,
    organismoNombre: organismo, placa: r.placa, documentoPropietario: r.documentoPropietario,
    tipoDocumentoPropietario: r.tipoDocumentoPropietario, nombrePropietario: r.nombrePropietario, vin: r.vin, marca: r.marca, linea: r.linea, anio: r.anio,
    color: r.color, cilindrada: r.cilindrada, estado: r.estado, comparacion: r.comparacion ?? null,
    certificadoEn: aIso(r.certificadoEn), createdAt: r.createdAt.toISOString(),
  };
}

async function filaVisible(r: Fila): Promise<FilaCertificacionDirecta> {
  const n = await nombresDe(r.organismoCodigo);
  return aFila(r, n.organismo);
}

/** VIN o placa ya certificados en ESTA pantalla. La cola con trámite no cuenta. */
async function duplicadoCertificado(vinNorm: string, placaNorm: string, exceptoId?: string): Promise<'vin' | 'placa' | 'ambos' | null> {
  const filtro = and(
    eq(flitoImpuestoCertificacionDirecta.estado, 'certificado'),
    or(
      eq(flitoImpuestoCertificacionDirecta.vinNorm, vinNorm),
      eq(flitoImpuestoCertificacionDirecta.placaNorm, placaNorm),
    ),
    exceptoId ? ne(flitoImpuestoCertificacionDirecta.id, exceptoId) : undefined,
  );
  const rows = await db.select({
    vin: flitoImpuestoCertificacionDirecta.vinNorm,
    placa: flitoImpuestoCertificacionDirecta.placaNorm,
  }).from(flitoImpuestoCertificacionDirecta).where(filtro);
  const vin = rows.some((r) => r.vin === vinNorm);
  const placa = rows.some((r) => r.placa === placaNorm);
  if (vin && placa) return 'ambos';
  if (vin) return 'vin';
  if (placa) return 'placa';
  return null;
}

function mensajeDuplicado(cual: 'vin' | 'placa' | 'ambos'): string {
  if (cual === 'ambos') return 'Ya existe una certificación para este VIN y esta placa';
  if (cual === 'vin') return 'Ya existe una certificación para este VIN';
  return 'Ya existe una certificación para esta placa';
}

async function exigirLibre(vinNorm: string, placaNorm: string, exceptoId?: string): Promise<void> {
  const d = await duplicadoCertificado(vinNorm, placaNorm, exceptoId);
  if (d) throw new ImpuestoError(409, mensajeDuplicado(d));
}

function clavesDe(datos: DatosAlta): { placa: string; placaNorm: string; vin: string; vinNorm: string } {
  const placaNorm = normalizarClave(datos.placa);
  const vinNorm = normalizarClave(datos.vin);
  if (placaNorm.length < 5 || placaNorm.length > 10) throw new ImpuestoError(400, 'La placa no es válida');
  if (vinNorm.length < 5 || vinNorm.length > 17) throw new ImpuestoError(400, 'El VIN no es válido');
  return { placa: placaNorm, placaNorm, vin: vinNorm, vinNorm };
}

async function guardarFactura(id: string, archivo: ArchivoSubido): Promise<string> {
  if (archivo.mimetype !== 'application/pdf' || !esPdf(archivo.buffer)) {
    throw new ImpuestoError(400, 'La factura de venta debe ser un PDF');
  }
  return uploadEntityDocument('impuesto-certificacion-directa', id, 'factura.pdf', archivo.buffer, 'application/pdf');
}

export async function catalogoCertificacionDirecta(): Promise<{
  organismos: { codigo: string; nombre: string }[];
}> {
  const organismos = await db.select({
    codigo: organismosTransitoConfig.codigo, alias: organismosTransitoConfig.alias,
  }).from(organismosTransitoConfig).where(eq(organismosTransitoConfig.activo, true)).orderBy(organismosTransitoConfig.codigo);
  return {
    organismos: organismos.map((o) => ({ codigo: o.codigo, nombre: o.alias?.trim() || o.codigo })),
  };
}

export async function sugerirDesdeFactura(archivo: ArchivoSubido): Promise<SugerenciaFactura> {
  const vacio: SugerenciaFactura = { vin: '', marca: '', linea: '', anio: '', color: '', cilindrada: '', aviso: null };
  if (archivo.mimetype !== 'application/pdf' || !esPdf(archivo.buffer)) {
    throw new ImpuestoError(400, 'La factura de venta debe ser un PDF');
  }
  try {
    const leido = await extraerVehiculoFacturaVenta({
      nombreArchivo: 'factura.pdf', contentType: 'application/pdf', contenido: archivo.buffer, umbral: UMBRAL_OCR,
    });
    const v = (k: keyof typeof leido) => (leido[k]?.valor ?? '').trim();
    const sugerido = {
      vin: v('vin'), marca: v('marca'), linea: v('linea'), anio: v('anioVehiculo'),
      color: v('color'), cilindrada: v('cilindrada'),
    };
    const alguno = Object.values(sugerido).some((x) => x.length > 0);
    return { ...sugerido, aviso: alguno ? null : 'No se pudo leer la factura. Completa los datos del vehículo.' };
  } catch (e) {
    if (!(e instanceof OcrNoDisponibleError)) log.warn('extraccion de factura no disponible');
    return { ...vacio, aviso: 'No se pudo leer la factura. Completa los datos del vehículo.' };
  }
}

export async function crearCertificacionDirecta(datos: DatosAlta, archivo: ArchivoSubido, creadoPorId: number): Promise<FilaCertificacionDirecta> {
  const claves = clavesDe(datos);
  await nombresDe(datos.organismoCodigo);
  await exigirLibre(claves.vinNorm, claves.placaNorm);
  const id = crypto.randomUUID();
  const key = await guardarFactura(id, archivo);
  try {
    const [row] = await db.insert(flitoImpuestoCertificacionDirecta).values({
      id, organismoCodigo: datos.organismoCodigo,
      placa: claves.placa, placaNorm: claves.placaNorm,
      documentoPropietario: datos.documentoPropietario?.trim() || null,
      tipoDocumentoPropietario: datos.tipoDocumentoPropietario,
      nombrePropietario: datos.nombrePropietario?.trim() || null,
      vin: claves.vin, vinNorm: claves.vinNorm,
      marca: datos.marca.trim(), linea: datos.linea.trim(), anio: datos.anio.trim(),
      color: datos.color.trim(), cilindrada: datos.cilindrada.trim(),
      facturaStorageKey: key, facturaNombre: 'factura.pdf', facturaMime: 'application/pdf', facturaBytes: archivo.size,
      estado: 'radicado', creadoPorId,
    }).returning();
    return filaVisible(row!);
  } catch (e) {
    await removeEntityDocument(key).catch(() => undefined);
    if (esUnico(e)) throw new ImpuestoError(409, 'Ya existe una certificación para este VIN o esta placa');
    throw e;
  }
}

export async function listarCertificacionDirecta(req: Request): Promise<FilaCertificacionDirecta[]> {
  const rows = await db.select().from(flitoImpuestoCertificacionDirecta)
    .orderBy(desc(flitoImpuestoCertificacionDirecta.createdAt)).limit(TOPE_LISTA);
  const salida: FilaCertificacionDirecta[] = [];
  for (const r of rows) salida.push(await filaVisible(r));
  await registrarAccesoImpuesto(req, {
    accion: 'search', filas: salida.length, campos: ['placa', 'vin', 'documento_propietario'],
  });
  return salida;
}

async function cargar(id: string): Promise<Fila> {
  const [row] = await db.select().from(flitoImpuestoCertificacionDirecta)
    .where(eq(flitoImpuestoCertificacionDirecta.id, id)).limit(1);
  if (!row) throw new ImpuestoError(404, 'No se encontró el registro');
  return row;
}

export async function detalleCertificacionDirecta(id: string, req: Request): Promise<FilaCertificacionDirecta> {
  const row = await cargar(id);
  await registrarAccesoImpuesto(req, {
    accion: 'read', impuestoId: id, filas: 1, campos: ['placa', 'vin', 'documento_propietario', 'nombre_propietario'],
  });
  return filaVisible(row);
}

export async function actualizarCertificacionDirecta(
  id: string, datos: DatosAlta, archivo: ArchivoSubido | null,
): Promise<FilaCertificacionDirecta> {
  const actual = await cargar(id);
  if (actual.estado === 'certificado') throw new ImpuestoError(409, 'Este registro ya está certificado');
  const claves = clavesDe(datos);
  await nombresDe(datos.organismoCodigo);
  await exigirLibre(claves.vinNorm, claves.placaNorm, id);
  let key = actual.facturaStorageKey;
  let bytes = actual.facturaBytes;
  if (archivo) {
    key = await guardarFactura(id, archivo);
    bytes = archivo.size;
  }
  try {
    const [row] = await db.update(flitoImpuestoCertificacionDirecta).set({
      organismoCodigo: datos.organismoCodigo,
      placa: claves.placa, placaNorm: claves.placaNorm,
      documentoPropietario: datos.documentoPropietario?.trim() || null,
      tipoDocumentoPropietario: datos.tipoDocumentoPropietario,
      nombrePropietario: datos.nombrePropietario?.trim() || null,
      vin: claves.vin, vinNorm: claves.vinNorm,
      marca: datos.marca.trim(), linea: datos.linea.trim(), anio: datos.anio.trim(),
      color: datos.color.trim(), cilindrada: datos.cilindrada.trim(),
      facturaStorageKey: key, facturaBytes: bytes,
      estado: 'radicado', comparacion: null, updatedAt: new Date(),
    }).where(eq(flitoImpuestoCertificacionDirecta.id, id)).returning();
    if (archivo && key !== actual.facturaStorageKey) {
      await removeEntityDocument(actual.facturaStorageKey).catch(() => undefined);
    }
    return filaVisible(row!);
  } catch (e) {
    if (archivo && key !== actual.facturaStorageKey) await removeEntityDocument(key).catch(() => undefined);
    if (esUnico(e)) throw new ImpuestoError(409, 'Ya existe una certificación para este VIN o esta placa');
    throw e;
  }
}

/** La pasarela exige el código RUNT. Lanza antes de salir: un registro anterior a Bug #14406 tiene documento y no tipo. */
function codigoRuntDe(tipoDocumento: string | null): string {
  const codigo = mapTipoDocUiToRunt(tipoDocumento);
  if (!codigo) throw new ImpuestoError(400, FALTA_TIPO_DOCUMENTO);
  return codigo;
}

/** `modalidad` es para la auditoría de la ruta: no sale al cliente. */
export async function consultarRuntCertificacionDirecta(
  id: string, actor: { userId: number; username: string },
): Promise<{ fila: FilaCertificacionDirecta; modalidad: ModalidadConsultaRunt }> {
  const actual = await cargar(id);
  if (actual.estado === 'certificado') throw new ImpuestoError(409, 'Este registro ya está certificado');
  // Dos registros pueden compartir VIN o placa mientras ninguno esté certificado: sin esto, el otro
  // enviaría los datos del titular al RUNT en cada reintento para acabar chocando con el índice único.
  await exigirLibre(actual.vinNorm, actual.placaNorm, id);
  // Decide el documento. Placa y VIN nunca viajan juntos: el cliente RUNT descartaría el VIN.
  // Sin reintento: si esta consulta falla no se prueba la otra modalidad. El gestor decide si borra el documento.
  const documento = actual.documentoPropietario?.trim() || null;
  const modalidad: ModalidadConsultaRunt = documento ? 'placa_documento' : 'vin';
  const consulta: { ok?: boolean; data?: unknown; message?: string; httpStatus?: number } = documento
    ? await consultarVehiculoRunt(actual.placa, undefined, documento, codigoRuntDe(actual.tipoDocumentoPropietario))
    : await consultarVehiculoRunt(undefined, actual.vin);
  const ahora = new Date();
  // Una placa que el RUNT no conoce responde ok:true con los campos en null: tampoco hay vehículo.
  if (!consulta.ok || runtSinRegistro(consulta.data)) {
    const estado = consulta.ok ? 'sin_vehiculo' : clasificarFalloRunt(consulta.message ?? '', consulta.httpStatus);
    const [row] = await db.update(flitoImpuestoCertificacionDirecta).set({
      estado, comparacion: null, updatedAt: ahora,
    }).where(eq(flitoImpuestoCertificacionDirecta.id, id)).returning();
    log.info({ id, estado, modalidad }, 'consulta RUNT sin certificado');
    return { fila: await filaVisible(row!), modalidad };
  }
  const veh = extraerVehiculoRunt(consulta.data);
  const colorCc = extraerColorCilindrajeRunt(consulta.data);
  const comparado = compararFacturaConRunt(extraccionDesdeDiligenciado({
    vin: actual.vin, marca: actual.marca, linea: actual.linea, anio: actual.anio,
    color: actual.color, cilindrada: actual.cilindrada,
  }), {
    vin: veh.vin, marca: veh.marca, linea: veh.linea, modelo: veh.modelo,
    color: colorCc.color, cilindraje: colorCc.cilindraje,
  }, ahora);
  if (!seisCoinciden(comparado.comparacion.campos)) {
    const [row] = await db.update(flitoImpuestoCertificacionDirecta).set({
      estado: 'sin_coincidencia', comparacion: comparado.comparacion.campos, updatedAt: ahora,
    }).where(eq(flitoImpuestoCertificacionDirecta.id, id)).returning();
    return { fila: await filaVisible(row!), modalidad };
  }
  const snapshot: SnapshotCertificacionDirecta = {
    campos: comparado.comparacion.campos,
    registroRunt: extraerRegistroRunt(consulta.data),
    modalidadConsulta: modalidad,
  };
  try {
    const [row] = await db.update(flitoImpuestoCertificacionDirecta).set({
      estado: 'certificado', comparacion: comparado.comparacion.campos, snapshot,
      certificadoEn: ahora, certificadoPorId: actor.userId, certificadoPorNombre: actor.username,
      updatedAt: ahora,
    }).where(eq(flitoImpuestoCertificacionDirecta.id, id)).returning();
    return { fila: await filaVisible(row!), modalidad };
  } catch (e) {
    if (esUnico(e)) throw new ImpuestoError(409, 'Ya existe una certificación para este VIN o esta placa');
    throw e;
  }
}

async function aBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const c of stream) partes.push(Buffer.from(c));
  return Buffer.concat(partes);
}

export async function bytesFacturaCertificacionDirecta(id: string, req: Request): Promise<{ bytes: Buffer; placa: string }> {
  const row = await cargar(id);
  const bytes = await aBuffer(await getEntityDocumentStream(row.facturaStorageKey) as AsyncIterable<Uint8Array>);
  await registrarAccesoImpuesto(req, {
    accion: 'export', impuestoId: id, filas: 1, resultado: 'factura_certificacion_directa', campos: ['placa', 'vin'],
  });
  return { bytes, placa: row.placa };
}

export async function datosCertificadoDirecto(id: string): Promise<{
  fila: Fila; snapshot: SnapshotCertificacionDirecta; organismo: string;
}> {
  const fila = await cargar(id);
  if (fila.estado !== 'certificado' || !fila.snapshot || !fila.certificadoEn) {
    throw new ImpuestoError(409, 'Este registro todavía no tiene certificado');
  }
  const n = await nombresDe(fila.organismoCodigo);
  return { fila, snapshot: fila.snapshot, organismo: n.organismo };
}
