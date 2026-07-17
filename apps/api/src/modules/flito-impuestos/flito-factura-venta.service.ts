// FLITO Impuestos — factura de venta (precondición del envío). Porta
// packages/server/src/impuestos/factura-venta.servicio.ts sobre el stack del grande (drizzle +
// motor OCR Anthropic modules/flito-ocr + storage S3). Ver docs §6.5.
//
// Por qué existe: el organismo liquida el impuesto sobre el VALOR DEL VEHÍCULO (base gravable), que
// vive en la factura de venta del concesionario. Sin ella no hay nada que enviar al gestor: es la
// precondición para pasar un impuesto de SIN_FACTURA a PENDIENTE.
//
// Cruce por DOBLE LLAVE: el VIN identifica el vehículo físico y la placa el trámite. Con una sola,
// una factura con la placa correcta y el VIN de otro carro pasaría sin que nadie lo note.

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoImpuestos, flitoRevisiones, flitoSoportes, flitoTramites,
  organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import {
  CampoFacturaVenta, EstadoImpuesto, ESTADO_IMPUESTO_LABEL, FlujoRevision, MotivoRevision,
  type ExtraccionFacturaVenta,
} from '@operaciones/shared-types';
import { extraerFacturaVenta, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';

export class ImpuestoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ArchivoSubido { originalname: string; mimetype: string; buffer: Buffer; size: number }

export interface ImpuestoCtx { userId: number; username: string; role: string; transitoCodigo: string | null }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TIPO_FACTURA_VENTA = 'factura_venta';

/** Campos que la factura de venta debe entregar con confianza. Placa/VIN van aparte (llave). */
const CAMPOS_REQUERIDOS_FV: readonly CampoFacturaVenta[] = [
  CampoFacturaVenta.NUMERO_FACTURA, CampoFacturaVenta.FECHA_FACTURA, CampoFacturaVenta.VALOR_VEHICULO,
];

const normalizarLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');

const docDe = (a: ArchivoSubido, umbral: number): DocumentoAAnalizar => ({
  nombreArchivo: a.originalname, contentType: a.mimetype, contenido: a.buffer, umbral,
});

interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * Verifica que la factura corresponda a ESTE trámite. Dos controles de identidad y uno de
 * legibilidad, en orden (el motivo cambia el mensaje y la acción): VIN obligatorio (SIN_LLAVE), VIN
 * cruza (LLAVE_NO_CRUZA), placa —del documento o del nombre— si existe cruza, y campos requeridos +
 * VIN sobre el umbral. Compara confianza numérica vs umbral (no el flag).
 */
export function verificarFacturaVenta(
  extraccion: ExtraccionFacturaVenta,
  esperado: { vin: string; placa: string | null },
  umbral: number,
  placaRespaldo: string | null,
): Veredicto {
  const vin = extraccion[CampoFacturaVenta.VIN];
  if (!vin?.valor) {
    return { aprobada: false, motivo: MotivoRevision.SIN_LLAVE_DE_CRUCE,
      detalle: 'La factura no permitió leer el VIN, que es la llave de cruce.' };
  }
  if (normalizarLlave(vin.valor) !== normalizarLlave(esperado.vin)) {
    return { aprobada: false, motivo: MotivoRevision.LLAVE_NO_CRUZA,
      detalle: `El VIN de la factura (${vin.valor}) no corresponde al trámite (VIN ${esperado.vin}).` };
  }
  const placa = extraccion[CampoFacturaVenta.PLACA]?.valor ?? placaRespaldo;
  if (placa && normalizarLlave(placa) !== normalizarLlave(esperado.placa)) {
    return { aprobada: false, motivo: MotivoRevision.LLAVE_NO_CRUZA,
      detalle: `La placa ${placa} no corresponde al VIN del trámite (placa ${esperado.placa ?? '—'}).` };
  }
  const dudosos = [
    ...(vin.confianza < umbral ? ['vin'] : []),
    ...CAMPOS_REQUERIDOS_FV.filter((c) => { const e = extraccion[c]; return !e || e.valor === null || e.confianza < umbral; }),
  ];
  if (dudosos.length > 0) {
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La lectura no superó el umbral de ${umbral} en: ${dudosos.join(', ')}.` };
  }
  return { aprobada: true };
}

async function auditEnTx(tx: Tx, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail,
  });
}

// Datos de un impuesto para leer/archivar su factura de venta.
interface DatosImpuesto {
  impuestoId: string; estado: EstadoImpuesto; tramiteIdFlit: string;
  vin: string; placa: string | null; companiaId: number; document: string | null; carpeta: string | null;
  umbralOcr: string | null; facturaVentaSoporteId: string | null;
}

const SELECT_DATOS = {
  impuestoId: flitoImpuestos.id, estado: flitoImpuestos.estado, tramiteIdFlit: flitoTramites.idFlit,
  vin: vehicles.vin, placa: vehicles.plate, companiaId: clients.id, document: clients.document,
  carpeta: clients.flitoCarpetaStorage, umbralOcr: organismosTransitoConfig.flitoUmbralOcr,
  facturaVentaSoporteId: flitoImpuestos.facturaVentaSoporteId,
} as const;

function fromImpuestos() {
  return db.select(SELECT_DATOS).from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo));
}

// vehicles.vin es nullable en el esquema; en un trámite siempre viene, pero si faltara un '' nunca
// cruza (→ LLAVE_NO_CRUZA), que es el comportamiento seguro.
type FilaDatos = Awaited<ReturnType<ReturnType<typeof fromImpuestos>['limit']>>[number];
const aDatos = (r: FilaDatos): DatosImpuesto => ({ ...r, estado: r.estado as EstadoImpuesto, vin: r.vin ?? '' });

async function porId(impuestoId: string): Promise<DatosImpuesto | null> {
  const [r] = await fromImpuestos().where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  return r ? aDatos(r) : null;
}

/** Trámites (con impuesto) cuyo vehículo coincide por VIN o placa. Incluye los que ya tienen factura. */
async function buscarPorLlave(vin: string | null, placa: string | null): Promise<DatosImpuesto[]> {
  const llave: ReturnType<typeof sql>[] = [];
  if (vin) llave.push(sql`UPPER(${vehicles.vin}) = ${normalizarLlave(vin)}`);
  if (placa) llave.push(sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarLlave(placa)}`);
  if (llave.length === 0) return [];
  const rows = await fromImpuestos().where(and(eq(clients.impuestosAutogestionable, false), or(...llave)!));
  return rows.map(aDatos);
}

/** Sube la factura de venta a S3 e inserta el soporte (en tx). Devuelve el id del soporte. */
async function guardar(tx: Tx, datos: DatosImpuesto | null, archivo: ArchivoSubido, ctx: ImpuestoCtx, storageKey: string, hash: string): Promise<string> {
  const [soporte] = await tx.insert(flitoSoportes).values({
    tipo: TIPO_FACTURA_VENTA, nombreArchivo: archivo.originalname, contentType: archivo.mimetype,
    storageKey, hash, tamanoBytes: archivo.size, impuestoId: datos?.impuestoId ?? null,
    subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
  }).returning({ id: flitoSoportes.id });
  return soporte.id;
}

async function archivar(datos: DatosImpuesto | null, archivo: ArchivoSubido): Promise<string> {
  const carpeta = datos
    ? carpetaDe({ id: datos.companiaId, document: datos.document, flitoCarpetaStorage: datos.carpeta }, 'impuestos/facturas-venta')
    : '_sin-clasificar/impuestos/facturas-venta';
  return uploadEntityDocument(carpeta, datos?.impuestoId ?? 'sin-clasificar', archivo.originalname, archivo.buffer, archivo.mimetype);
}

/** La factura queda atada al registro y este pasa a PENDIENTE (ya se puede enviar al gestor). */
async function aceptar(tx: Tx, datos: DatosImpuesto, soporteId: string, extraccion: ExtraccionFacturaVenta, ctx: ImpuestoCtx): Promise<void> {
  await tx.update(flitoImpuestos).set({
    facturaVentaSoporteId: soporteId,
    extraccionFacturaVenta: extraccion, // el gestor la recibe con el trámite, sin abrir el PDF
    estado: EstadoImpuesto.PENDIENTE,
    updatedAt: new Date(),
  }).where(eq(flitoImpuestos.id, datos.impuestoId));

  await auditEnTx(tx, ctx, datos.impuestoId,
    `Factura de venta cargada (sin_factura→pendiente). Trámite ${datos.tramiteIdFlit}, ` +
    `factura ${extraccion[CampoFacturaVenta.NUMERO_FACTURA]?.valor ?? '—'}, ` +
    `valor vehículo ${extraccion[CampoFacturaVenta.VALOR_VEHICULO]?.valor ?? '—'}. Soporte ${soporteId}. Placa y VIN cruzan.`);
}

async function aRevision(tx: Tx, soporteId: string, extraccion: ExtraccionFacturaVenta, veredicto: { motivo?: MotivoRevision; detalle?: string }, impuestoId: string | null, ctx: ImpuestoCtx): Promise<void> {
  await tx.insert(flitoRevisiones).values({
    modulo: FlujoRevision.FACTURA_VENTA, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
    registroId: impuestoId, soporteId, placaSugerida: extraccion[CampoFacturaVenta.PLACA]?.valor ?? null,
    extraccion, resuelto: false,
  });
  if (impuestoId) {
    await auditEnTx(tx, ctx, impuestoId, `Factura de venta a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporteId}.`);
  }
}

/**
 * Carga la factura de venta de UN impuesto concreto. Aunque el usuario diga a qué registro
 * pertenece, el OCR igual verifica: el punto es corroborar que la factura corresponde al trámite
 * (cargar la del carro equivocado es el error que este paso atrapa). Solo desde SIN_FACTURA.
 */
export async function cargarFacturaVentaIndividual(impuestoId: string, archivo: ArchivoSubido, ctx: ImpuestoCtx): Promise<void> {
  const datos = await porId(impuestoId);
  if (!datos) throw new ImpuestoError(404, 'El impuesto no existe');
  if (datos.estado !== EstadoImpuesto.SIN_FACTURA) {
    throw new ImpuestoError(400, `Este impuesto ya está en "${ESTADO_IMPUESTO_LABEL[datos.estado]}": la factura de venta solo se carga antes de enviarlo al gestor.`);
  }

  const umbral = umbralPara(datos.umbralOcr);
  const extraccion = await extraerFacturaVenta(docDe(archivo, umbral));
  const veredicto = verificarFacturaVenta(extraccion, { vin: datos.vin, placa: datos.placa }, umbral, placaDesdeNombre(archivo.originalname));

  // No corresponde a este trámite (sin llave o llave que contradice): se descarta sin guardarla.
  if (!veredicto.aprobada && (veredicto.motivo === MotivoRevision.SIN_LLAVE_DE_CRUCE || veredicto.motivo === MotivoRevision.LLAVE_NO_CRUZA)) {
    throw new ImpuestoError(400, `${veredicto.detalle} No corresponde a este trámite, así que no se guardó.`);
  }

  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await archivar(datos, archivo);

  await db.transaction(async (tx) => {
    const soporteId = await guardar(tx, datos, archivo, ctx, storageKey, hash);
    if (veredicto.aprobada) await aceptar(tx, datos, soporteId, extraccion, ctx);
    else await aRevision(tx, soporteId, extraccion, veredicto, datos.impuestoId, ctx); // cruza pero dudosa: se guarda y va a revisión
  });

  // Coincide pero con baja confianza: se avisa (quedó cargada y en revisión), pero NO es error 4xx duro.
  if (!veredicto.aprobada) {
    throw new ImpuestoError(409, `${veredicto.detalle} La factura quedó cargada y en la cola de revisión de Operaciones.`);
  }
}

// ─────────────────────────── Carga masiva ────────────────────────────────────

export interface ItemFV { archivo: string; placa: string | null; idFlit: string | null; registroId: string | null; detalle: string }
export interface ResultadoFacturasVenta { conciliados: ItemFV[]; enRevision: ItemFV[]; duplicados: ItemFV[]; noAsociados: ItemFV[] }

/**
 * Carga masiva: N facturas sueltas, un ZIP, o mezcla. Nadie clasifica: el OCR lee VIN (y la placa
 * del nombre del archivo como respaldo, §8.4) y cruza cada factura con su trámite. No se descarta
 * por archivo repetido (recargar reprocesa); el único "ya existe" que importa es a nivel de trámite.
 */
export async function cargarFacturasVentaMasivo(archivos: ArchivoSubido[], ctx: ImpuestoCtx): Promise<ResultadoFacturasVenta> {
  const res: ResultadoFacturasVenta = { conciliados: [], enRevision: [], duplicados: [], noAsociados: [] };
  const expandidos = await expandir(archivos);

  for (const archivo of expandidos) {
    try {
      await procesarUna(archivo, ctx, res);
    } catch (e) {
      res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null, detalle: e instanceof ImpuestoError ? e.message : 'Error procesando el archivo.' });
    }
  }
  return res;
}

async function procesarUna(archivo: ArchivoSubido, ctx: ImpuestoCtx, res: ResultadoFacturasVenta): Promise<void> {
  const extraccion = await extraerFacturaVenta(docDe(archivo, umbralPara(null)));
  const vin = extraccion[CampoFacturaVenta.VIN]?.valor ?? null;
  const placa = extraccion[CampoFacturaVenta.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);

  if (!vin && !placa) {
    res.noAsociados.push({ archivo: archivo.originalname, placa: null, idFlit: null, registroId: null,
      detalle: 'No se pudo leer el VIN ni la placa (tampoco del nombre del archivo): no se asoció a ningún trámite.' });
    return;
  }

  const candidatos = await buscarPorLlave(vin, placa);
  if (candidatos.length === 0) {
    res.noAsociados.push({ archivo: archivo.originalname, placa, idFlit: null, registroId: null,
      detalle: `El VIN ${vin ?? '—'} / placa ${placa ?? '—'} no corresponde a ningún trámite. No va a revisión: no hay trámite con qué compararla.` });
    return;
  }

  const sinFactura = candidatos.filter((c) => c.estado === EstadoImpuesto.SIN_FACTURA);

  // Todos los trámites del vehículo ya tienen factura: se avisa (solo si ya hay una válida asociada).
  if (sinFactura.length === 0) {
    const ref = candidatos.find((c) => c.facturaVentaSoporteId !== null) ?? candidatos[0];
    res.duplicados.push({ archivo: archivo.originalname, placa: ref.placa, idFlit: ref.tramiteIdFlit, registroId: ref.impuestoId,
      detalle: `El trámite ${ref.tramiteIdFlit} ya tiene una factura de venta asociada.` });
    return;
  }

  // Dos trámites del mismo vehículo esperando factura: el VIN/placa identifica el carro, no el
  // trámite. Va a revisión con soporte huérfano para que una persona decida (CRUCE_AMBIGUO).
  if (sinFactura.length > 1) {
    const detalle = `El vehículo (VIN ${vin ?? placa}) tiene ${sinFactura.length} trámites esperando factura (${sinFactura.map((c) => c.tramiteIdFlit).join(', ')}). Resuélvelo en Revisiones.`;
    const hash = createHash('sha256').update(archivo.buffer).digest('hex');
    const storageKey = await archivar(null, archivo);
    await db.transaction(async (tx) => {
      const soporteId = await guardar(tx, null, archivo, ctx, storageKey, hash);
      await aRevision(tx, soporteId, extraccion, { motivo: MotivoRevision.CRUCE_AMBIGUO, detalle }, null, ctx);
    });
    res.enRevision.push({ archivo: archivo.originalname, placa, idFlit: null, registroId: null, detalle });
    return;
  }

  const datos = sinFactura[0];
  const umbral = umbralPara(datos.umbralOcr);
  const veredicto = verificarFacturaVenta(extraccion, { vin: datos.vin, placa: datos.placa }, umbral, placa);
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await archivar(datos, archivo);

  await db.transaction(async (tx) => {
    const soporteId = await guardar(tx, datos, archivo, ctx, storageKey, hash);
    if (veredicto.aprobada) await aceptar(tx, datos, soporteId, extraccion, ctx);
    else await aRevision(tx, soporteId, extraccion, veredicto, datos.impuestoId, ctx);
  });

  const item: ItemFV = { archivo: archivo.originalname, placa: datos.placa, idFlit: datos.tramiteIdFlit, registroId: datos.impuestoId,
    detalle: veredicto.aprobada ? `VIN coincide con el trámite ${datos.tramiteIdFlit}. Factura asociada, lista para enviar.` : (veredicto.detalle ?? 'En revisión.') };
  (veredicto.aprobada ? res.conciliados : res.enRevision).push(item);
}

/** Un ZIP es una caja: se abre y se procesa cada archivo (PDF/imagen). */
async function expandir(archivos: ArchivoSubido[]): Promise<ArchivoSubido[]> {
  const salida: ArchivoSubido[] = [];
  for (const archivo of archivos) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    if (!esZip) { salida.push(archivo); continue; }
    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf'
        : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg'
        : lower.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length });
    }
  }
  return salida;
}
