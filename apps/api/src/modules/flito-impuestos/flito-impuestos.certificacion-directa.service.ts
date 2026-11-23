// Certificación de impuesto sin trámite. No entra en la cola: no hay envío, pago ni comprobante.
// La factura se sube aquí. El PDF del certificado se arma al descargar y no se archiva.
import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import type { Request } from 'express';
import type { ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestoCertificacionDirecta, organismosTransitoConfig } from '../../db/schema.js';
import type {
  EstadoCertificacionDirecta, ModalidadConsultaRunt, SnapshotCertificacionDirecta,
} from '../../db/schema/flito-impuesto-certificacion-directa.js';
import { loggerFor } from '../../shared/logger.js';
import { audit } from '../../shared/middleware/audit.js';
import { getEntityDocumentStream, removeEntityDocument, uploadEntityDocument } from '../../services/storage.js';
import { extraerVehiculoFacturaVenta, OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
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
/**
 * Mensaje de validación del FORMULARIO: si se diligencia el documento del propietario hay que decir
 * de qué tipo es. Independiente de la modalidad de consulta RUNT (HU #14665: esa ya no se decide con
 * el documento), sigue haciendo falta para que el PDF no rotule un documento sin su tipo.
 */
export const FALTA_TIPO_DOCUMENTO = 'Falta el tipo de documento del propietario';

export interface DatosAlta extends DatosVehiculoDiligenciados {
  /** Opcional desde la HU #14665 (segundo lote): la Épica #14163 nunca lo pidió en el formulario. */
  organismoCodigo: string | null;
  /** Opcional desde la HU #14665: la consulta RUNT ya no depende de la placa, solo del VIN. */
  placa: string | null;
  documentoPropietario: string | null;
  tipoDocumentoPropietario: string | null;
  nombrePropietario: string | null;
}

export interface SugerenciaFactura {
  vin: string; marca: string; linea: string; anio: string; color: string; cilindrada: string;
  /** Identidad del propietario leída de la factura (HU #14665). Cadena vacía si no se pudo leer. */
  tipoDocumentoPropietario: string; documentoPropietario: string; nombrePropietario: string;
  aviso: string | null;
}

export interface FilaCertificacionDirecta {
  id: string;
  /** Opcional desde la HU #14665 (segundo lote): el organismo ya no es un campo del formulario. */
  organismoCodigo: string | null;
  organismoNombre: string | null;
  placa: string | null;
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

export type Fila = typeof flitoImpuestoCertificacionDirecta.$inferSelect;

function esUnico(e: unknown): boolean {
  const c = e as { code?: string; cause?: { code?: string } };
  return c.code === UNIQUE || c.cause?.code === UNIQUE;
}

function aIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Sin código (opcional desde la HU #14665, segundo lote): no hay nada que resolver, ni se consulta la
 * BD. Con código (caso legado, o si se reintrodujera) sigue validando contra el catálogo igual que hoy.
 */
async function nombresDe(organismoCodigo: string | null): Promise<{ organismo: string | null }> {
  if (!organismoCodigo) return { organismo: null };
  const [og] = await db.select({ alias: organismosTransitoConfig.alias }).from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, organismoCodigo)).limit(1);
  if (!og) throw new ImpuestoError(400, 'El organismo de tránsito no existe');
  return { organismo: og.alias?.trim() || organismoCodigo };
}

function aFila(r: Fila, organismo: string | null): FilaCertificacionDirecta {
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

/**
 * VIN o placa ya certificados en ESTA pantalla. La cola con trámite no cuenta.
 *
 * Sin placa (opcional desde la HU #14665), el filtro compara SOLO por VIN: varios registros sin
 * placa no se podrían distinguir entre sí comparando contra una placa nula de otro registro, y el
 * índice único parcial (`WHERE estado = 'certificado'`) ya permite varios NULL de todas formas.
 */
async function duplicadoCertificado(vinNorm: string, placaNorm: string | null, exceptoId?: string): Promise<'vin' | 'placa' | 'ambos' | null> {
  const filtro = and(
    eq(flitoImpuestoCertificacionDirecta.estado, 'certificado'),
    placaNorm
      ? or(
          eq(flitoImpuestoCertificacionDirecta.vinNorm, vinNorm),
          eq(flitoImpuestoCertificacionDirecta.placaNorm, placaNorm),
        )
      : eq(flitoImpuestoCertificacionDirecta.vinNorm, vinNorm),
    exceptoId ? ne(flitoImpuestoCertificacionDirecta.id, exceptoId) : undefined,
  );
  const rows = await db.select({
    vin: flitoImpuestoCertificacionDirecta.vinNorm,
    placa: flitoImpuestoCertificacionDirecta.placaNorm,
  }).from(flitoImpuestoCertificacionDirecta).where(filtro);
  const vin = rows.some((r) => r.vin === vinNorm);
  const placa = placaNorm ? rows.some((r) => r.placa === placaNorm) : false;
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

async function exigirLibre(vinNorm: string, placaNorm: string | null, exceptoId?: string): Promise<void> {
  const d = await duplicadoCertificado(vinNorm, placaNorm, exceptoId);
  if (d) throw new ImpuestoError(409, mensajeDuplicado(d));
}

/** Sin placa diligenciada, `placa`/`placaNorm` quedan `null` sin validar longitud (HU #14665). */
function clavesDe(datos: DatosAlta): { placa: string | null; placaNorm: string | null; vin: string; vinNorm: string } {
  const placaNorm = datos.placa ? normalizarClave(datos.placa) : null;
  if (placaNorm && (placaNorm.length < 5 || placaNorm.length > 10)) throw new ImpuestoError(400, 'La placa no es válida');
  const vinNorm = normalizarClave(datos.vin);
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
  const vacio: SugerenciaFactura = {
    vin: '', marca: '', linea: '', anio: '', color: '', cilindrada: '',
    tipoDocumentoPropietario: '', documentoPropietario: '', nombrePropietario: '', aviso: null,
  };
  if (archivo.mimetype !== 'application/pdf' || !esPdf(archivo.buffer)) {
    throw new ImpuestoError(400, 'La factura de venta debe ser un PDF');
  }
  try {
    const leido = await extraerVehiculoFacturaVenta({
      nombreArchivo: 'factura.pdf', contentType: 'application/pdf', contenido: archivo.buffer, umbral: UMBRAL_OCR,
    });
    const v = (k: keyof typeof leido) => (leido[k]?.valor ?? '').trim();
    // Persona natural (nombres y/o apellidos) vs. jurídica (razón social): excluyentes, igual que
    // `extraerFacturaVenta`. Si viene razón social, manda; si no, se compone con nombres + apellidos.
    const razonSocial = v('razonSocial');
    const nombrePropietario = razonSocial || [v('nombres'), v('apellidos')].filter(Boolean).join(' ').trim();
    const sugerido = {
      vin: v('vin'), marca: v('marca'), linea: v('linea'), anio: v('anioVehiculo'),
      color: v('color'), cilindrada: v('cilindrada'),
      tipoDocumentoPropietario: v('tipoDocumento'), documentoPropietario: v('numeroDocumento'),
      nombrePropietario,
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

/**
 * `modalidad` es para la auditoría de la ruta: no sale al cliente. Desde la HU #14665 la consulta es
 * SIEMPRE por VIN (reemplaza al Bug #14406, que decidía placa+documento o VIN según hubiera
 * documento del propietario): la placa y el documento quedan como datos de FLITO que no viajan al RUNT.
 */
export async function consultarRuntCertificacionDirecta(
  id: string, actor: { userId: number; username: string },
): Promise<{ fila: FilaCertificacionDirecta; modalidad: ModalidadConsultaRunt }> {
  const actual = await cargar(id);
  if (actual.estado === 'certificado') throw new ImpuestoError(409, 'Este registro ya está certificado');
  // Dos registros pueden compartir VIN (o placa) mientras ninguno esté certificado: sin esto, el otro
  // enviaría los datos del titular al RUNT en cada reintento para acabar chocando con el índice único.
  await exigirLibre(actual.vinNorm, actual.placaNorm, id);
  const modalidad: ModalidadConsultaRunt = 'vin';
  const consulta: { ok?: boolean; data?: unknown; message?: string; httpStatus?: number } = await consultarVehiculoRunt(undefined, actual.vin);
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

export async function bytesFacturaCertificacionDirecta(id: string, req: Request): Promise<{ bytes: Buffer; placa: string | null; vin: string }> {
  const row = await cargar(id);
  const bytes = await aBuffer(await getEntityDocumentStream(row.facturaStorageKey) as AsyncIterable<Uint8Array>);
  await registrarAccesoImpuesto(req, {
    accion: 'export', impuestoId: id, filas: 1, resultado: 'factura_certificacion_directa', campos: ['placa', 'vin'],
  });
  return { bytes, placa: row.placa, vin: row.vin };
}

/**
 * Elimina un registro (AC6). Mismo guardián que `actualizarCertificacionDirecta`: un certificado ya
 * emitido no se borra desde aquí. Mutación → se audita con `audit()` (AGENTS.md §16: las mutaciones
 * NO van a `pii_access_log`, solo las lecturas que proyectan columnas del titular); el detalle nombra
 * las COLUMNAS del titular que llevaba el registro, nunca sus valores.
 */
export async function eliminarCertificacionDirecta(id: string, req: Request): Promise<void> {
  const row = await cargar(id);
  if (row.estado === 'certificado') throw new ImpuestoError(409, 'Este registro ya está certificado');
  await removeEntityDocument(row.facturaStorageKey).catch(() => undefined);
  await db.delete(flitoImpuestoCertificacionDirecta).where(eq(flitoImpuestoCertificacionDirecta.id, id));
  await audit(req, {
    action: 'delete', resource: 'flito_impuesto', resourceId: id,
    detail: 'Eliminación de certificación sin trámite (datos de titular: placa, vin, documento_propietario, nombre_propietario)',
  });
}

/**
 * Eliminación en lote (AC7): lo certificado NO tumba el lote, se reporta como omitido. Un id que no
 * existe se trata igual (omitido): el lote no es una transacción, cada id se resuelve por su cuenta.
 */
export async function eliminarCertificacionDirectaLote(
  ids: readonly string[], req: Request,
): Promise<{ eliminados: string[]; omitidos: string[] }> {
  const eliminados: string[] = [];
  const omitidos: string[] = [];
  for (const id of ids) {
    try {
      await eliminarCertificacionDirecta(id, req);
      eliminados.push(id);
    } catch (e) {
      if (e instanceof ImpuestoError) { omitidos.push(id); continue; }
      throw e;
    }
  }
  return { eliminados, omitidos };
}

/** Filas por id, para el ZIP de certificados (AC8). Sin orden: lo decide quien planifica. */
export async function filasCertificacionDirectaPorIds(ids: readonly string[]): Promise<Fila[]> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return [];
  return db.select().from(flitoImpuestoCertificacionDirecta)
    .where(inArray(flitoImpuestoCertificacionDirecta.id, unicos));
}

/** Alias de organismo por código, en lote (para no consultar uno por uno al armar el ZIP). */
export async function organismosAliasPorCodigos(codigos: readonly string[]): Promise<Map<string, string>> {
  const unicos = [...new Set(codigos)];
  if (unicos.length === 0) return new Map();
  const rows = await db.select({
    codigo: organismosTransitoConfig.codigo, alias: organismosTransitoConfig.alias,
  }).from(organismosTransitoConfig).where(inArray(organismosTransitoConfig.codigo, unicos));
  return new Map(rows.map((r) => [r.codigo, r.alias?.trim() || r.codigo]));
}

export async function datosCertificadoDirecto(id: string): Promise<{
  fila: Fila; snapshot: SnapshotCertificacionDirecta; organismo: string | null;
}> {
  const fila = await cargar(id);
  if (fila.estado !== 'certificado' || !fila.snapshot || !fila.certificadoEn) {
    throw new ImpuestoError(409, 'Este registro todavía no tiene certificado');
  }
  const n = await nombresDe(fila.organismoCodigo);
  return { fila, snapshot: fila.snapshot, organismo: n.organismo };
}
