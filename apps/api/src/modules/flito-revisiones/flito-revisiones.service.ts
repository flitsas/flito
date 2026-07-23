// FLITO Revisiones — cola de resolución del OCR (Fase 5 P1). Porta
// packages/server/src/revision/revision.servicio.ts.
//
// La regla que gobierna todo el servicio: un dato extraído bajo el umbral NUNCA se persiste como
// válido sin confirmación humana (RN-04 de SOAT, RN-05 de Impuestos). Resolver no es "aceptar lo que
// dijo el OCR": es que una persona escriba o confirme cada campo, y ese acto queda firmado en el
// propio campo (`confirmadoPor`, `confirmadoEn`). Los gestores NO resuelven esta cola: si el gestor
// que cargó la factura pudiera resolver su propia revisión, el umbral de OCR no serviría de nada.

import { and, desc, eq } from 'drizzle-orm';
import {
  CampoFacturaVenta, CampoImpuesto, CampoSoat, EstadoImpuesto, EstadoSoat,
  FlujoRevision,
  type CampoExtraido, type ExtraccionFacturaVenta, type ExtraccionImpuesto, type ExtraccionSoat,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, flitoImpuestos, flitoRevisiones, flitoSoat, flitoSoportes } from '../../db/schema.js';
import { marcarPagado } from '../flito-soat/flito-soat.service.js';

export interface RevisionCtx { userId: number; username: string; role: string }

export class RevisionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Extraccion = ExtraccionSoat | ExtraccionImpuesto | ExtraccionFacturaVenta;

async function auditEnTx(tx: Tx, ctx: RevisionCtx, resource: string, resourceId: string, detail: string, action: 'update' | 'delete' = 'update'): Promise<void> {
  await tx.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action, resource, resourceId, detail });
}

export interface RevisionItem {
  id: string;
  modulo: string;
  motivo: string;
  detalle: string;
  registroId: string | null;
  placaSugerida: string | null;
  extraccion: unknown;
  resuelto: boolean;
  creadoEn: string;
  soporte: {
    id: string;
    nombreArchivo: string;
    contentType: string;
    tipo: string;
    subidoPorNombre: string;
    subidoEn: string;
  };
}

/** Cola de revisión, opcionalmente filtrada por módulo. Las resueltas se ocultan salvo que se pidan. */
export async function listar(modulo?: FlujoRevision, incluirResueltas = false): Promise<RevisionItem[]> {
  const conds = [];
  if (modulo) conds.push(eq(flitoRevisiones.modulo, modulo));
  if (!incluirResueltas) conds.push(eq(flitoRevisiones.resuelto, false));

  const rows = await db.select({
    id: flitoRevisiones.id,
    modulo: flitoRevisiones.modulo,
    motivo: flitoRevisiones.motivo,
    detalle: flitoRevisiones.detalle,
    registroId: flitoRevisiones.registroId,
    placaSugerida: flitoRevisiones.placaSugerida,
    extraccion: flitoRevisiones.extraccion,
    resuelto: flitoRevisiones.resuelto,
    creadoEn: flitoRevisiones.createdAt,
    soporteId: flitoSoportes.id,
    nombreArchivo: flitoSoportes.nombreArchivo,
    contentType: flitoSoportes.contentType,
    tipo: flitoSoportes.tipo,
    subidoPorNombre: flitoSoportes.subidoPorNombre,
    subidoEn: flitoSoportes.subidoEn,
  }).from(flitoRevisiones)
    .innerJoin(flitoSoportes, eq(flitoRevisiones.soporteId, flitoSoportes.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(flitoRevisiones.createdAt);

  return rows.map((r) => ({
    id: r.id,
    modulo: r.modulo,
    motivo: r.motivo,
    detalle: r.detalle,
    registroId: r.registroId,
    placaSugerida: r.placaSugerida,
    extraccion: r.extraccion,
    resuelto: r.resuelto,
    creadoEn: r.creadoEn.toISOString(),
    soporte: {
      id: r.soporteId,
      nombreArchivo: r.nombreArchivo,
      contentType: r.contentType,
      tipo: r.tipo,
      subidoPorNombre: r.subidoPorNombre,
      subidoEn: r.subidoEn.toISOString(),
    },
  }));
}

/** Campos que la interfaz debe pedir según el flujo, para no adivinar en el cliente. */
export function camposEsperados(modulo: FlujoRevision): string[] {
  if (modulo === FlujoRevision.SOAT) return Object.values(CampoSoat);
  if (modulo === FlujoRevision.FACTURA_VENTA) return Object.values(CampoFacturaVenta);
  return Object.values(CampoImpuesto);
}

/**
 * Marca como confirmados por una persona los campos que esa persona escribió.
 *
 * `confianza: 1` no dice "el OCR estuvo seguro": dice que ya no depende del OCR. `confirmadoPor` es lo
 * que separa un dato validado de uno adivinado, y por eso viaja pegado al campo y no en una bandera
 * del registro. Los campos que el humano no tocó conservan su confianza original y siguen sin ser
 * confiables: confirmarlos en bloque sería el "dar por válido sin confirmación" que la regla prohíbe.
 */
export function confirmar(original: Extraccion, campos: Record<string, string>, userId: number): Extraccion {
  const ahora = new Date().toISOString();
  const resultado: Record<string, CampoExtraido> = { ...(original as Record<string, CampoExtraido>) };
  for (const [campo, valor] of Object.entries(campos)) {
    resultado[campo] = {
      valor: valor === '' ? null : valor,
      confianza: 1,
      confiable: valor !== '',
      confirmadoPor: String(userId),
      confirmadoEn: ahora,
    };
  }
  return resultado as Extraccion;
}

function aNumero(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = Number(String(valor).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(limpio) ? String(limpio) : null;
}

/**
 * Resuelve una revisión: la persona confirma a qué registro pertenece el documento y qué dice. Ramifica
 * por módulo y delega en el flujo correspondiente sin duplicar la vía a Pagado.
 */
export async function resolver(id: string, registroId: string, campos: Record<string, string>, motivo: string, ctx: RevisionCtx): Promise<void> {
  const [revision] = await db.select().from(flitoRevisiones).where(eq(flitoRevisiones.id, id)).limit(1);
  if (!revision) throw new RevisionError(404, 'La revisión no existe');
  if (revision.resuelto) throw new RevisionError(400, 'Esa revisión ya fue resuelta');
  if (!motivo?.trim()) throw new RevisionError(400, 'Deja constancia de qué validaste y con base en qué');
  if (!registroId) throw new RevisionError(400, 'Indica a qué registro pertenece el documento');

  const extraccion = confirmar(revision.extraccion as Extraccion, campos, ctx.userId);

  if (revision.modulo === FlujoRevision.SOAT) {
    await resolverSoat(revision.id, revision.soporteId, registroId, extraccion as ExtraccionSoat, motivo, ctx);
  } else if (revision.modulo === FlujoRevision.FACTURA_VENTA) {
    await resolverFacturaVenta(revision.id, revision.soporteId, revision.motivo, registroId, extraccion as ExtraccionFacturaVenta, motivo, ctx);
  } else {
    await resolverImpuesto(revision.id, revision.soporteId, revision.motivo, registroId, extraccion as ExtraccionImpuesto, motivo, ctx);
  }

  await db.update(flitoRevisiones).set({
    resuelto: true, resueltoPorId: ctx.userId, resueltoEn: new Date(),
    extraccion, registroId,
  }).where(eq(flitoRevisiones.id, id));
}

async function resolverSoat(revisionId: string, soporteId: string, soatId: string, extraccion: ExtraccionSoat, motivo: string, ctx: RevisionCtx): Promise<void> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, soatId)).limit(1);
  if (!soat) throw new RevisionError(404, 'El SOAT indicado no existe');
  if (soat.estado !== EstadoSoat.SOLICITADO) {
    throw new RevisionError(400, 'Solo se puede conciliar un documento contra un SOAT en adquisición');
  }

  // El soporte pudo cargarse sin saber a qué registro pertenecía (llave ilegible). Al resolver, se ata
  // a su SOAT; marcarPagado lo localiza por soatId+tipo y hace el pago atómico en su propia tx.
  await db.transaction(async (tx) => {
    await tx.update(flitoSoportes).set({ soatId }).where(eq(flitoSoportes.id, soporteId));
    await auditEnTx(tx, ctx, 'flito_soat', soatId, `Revisión resuelta a mano (${revisionId}): documento atado al SOAT. ${motivo.trim()}`);
  });

  await marcarPagado(soatId, extraccion, { userId: ctx.userId, username: ctx.username, role: ctx.role, proveedorSoatId: null });
}

/**
 * Resuelve una factura de venta que el OCR no pudo cruzar sola: la persona dice a qué trámite pertenece.
 * Aquí no se vuelve a verificar el cruce contra el registro — el humano ya decidió, y volver a exigir
 * que el OCR concuerde haría imposible resolver justo los casos que llegan aquí porque el OCR no cruzó.
 */
async function resolverFacturaVenta(revisionId: string, soporteId: string, motivoOriginal: string, impuestoId: string, extraccion: ExtraccionFacturaVenta, motivo: string, ctx: RevisionCtx): Promise<void> {
  const [impuesto] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  if (!impuesto) throw new RevisionError(404, 'El impuesto indicado no existe');
  if (impuesto.estado !== EstadoImpuesto.PENDIENTE) {
    throw new RevisionError(400, 'La factura de venta solo se ata antes del envío (impuesto en Pendiente).');
  }

  await db.transaction(async (tx) => {
    await tx.update(flitoSoportes).set({ impuestoId }).where(eq(flitoSoportes.id, soporteId));
    await tx.update(flitoImpuestos).set({
      facturaVentaSoporteId: soporteId, extraccionFacturaVenta: extraccion, updatedAt: new Date(),
    }).where(eq(flitoImpuestos.id, impuestoId));
    await auditEnTx(tx, ctx, 'flito_impuesto', impuestoId,
      `Factura de venta atada a mano. Revisión ${revisionId} (${motivoOriginal}). Soporte ${soporteId}. ${motivo.trim()}`);
  });
}

async function resolverImpuesto(revisionId: string, soporteId: string, motivoOriginal: string, impuestoId: string, extraccion: ExtraccionImpuesto, motivo: string, ctx: RevisionCtx): Promise<void> {
  const [impuesto] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  if (!impuesto) throw new RevisionError(404, 'El impuesto indicado no existe');

  // Una diferencia de valor ya está pagada: la revisión es contable y solo se cierra, sin tocar estado.
  if (impuesto.estado === EstadoImpuesto.PAGADO) {
    await db.transaction(async (tx) => {
      await auditEnTx(tx, ctx, 'flito_impuesto', impuestoId, `Revisión contable cerrada (${revisionId}, ${motivoOriginal}). ${motivo.trim()}`);
    });
    return;
  }

  if (impuesto.estado !== EstadoImpuesto.SOLICITADO) {
    throw new RevisionError(400, 'Solo se puede conciliar un documento contra un impuesto en gestión');
  }

  const valorPagado = aNumero(extraccion[CampoImpuesto.VALOR_TOTAL]?.valor);
  await db.transaction(async (tx) => {
    await tx.update(flitoSoportes).set({ impuestoId }).where(eq(flitoSoportes.id, soporteId));
    // Comparación de diferencias apagada por ahora (D-5, ver conciliar() en recibos).
    await tx.update(flitoImpuestos).set({
      estado: EstadoImpuesto.PAGADO, extraccion, valorPagado, marcadoPorDiferencia: false,
      pagadoEn: new Date(), updatedAt: new Date(),
    }).where(eq(flitoImpuestos.id, impuestoId));
    await auditEnTx(tx, ctx, 'flito_impuesto', impuestoId,
      `Revisión resuelta (en_gestion→pagado). Valor pagado ${valorPagado ?? '—'}, liquidado ${impuesto.valorLiquidado ?? '—'}. ` +
      `Revisión ${revisionId} (${motivoOriginal}). Soporte ${soporteId}. ${motivo.trim()}`);
  });
}

/**
 * Descarta un documento que no debía estar ahí — un archivo suelto, un recibo de otro trámite, un PDF
 * equivocado. El soporte NO se borra: se deja huérfano y trazado. Borrarlo eliminaría la evidencia de
 * que alguien cargó algo que no correspondía.
 */
export async function descartar(id: string, motivo: string, ctx: RevisionCtx): Promise<void> {
  const [revision] = await db.select().from(flitoRevisiones).where(eq(flitoRevisiones.id, id)).limit(1);
  if (!revision) throw new RevisionError(404, 'La revisión no existe');
  if (revision.resuelto) throw new RevisionError(400, 'Esa revisión ya fue resuelta');
  if (!motivo?.trim() || motivo.trim().length < 5) throw new RevisionError(400, 'Descartar un documento exige explicar por qué');

  await db.transaction(async (tx) => {
    await tx.update(flitoRevisiones).set({
      resuelto: true, resueltoPorId: ctx.userId, resueltoEn: new Date(),
    }).where(eq(flitoRevisiones.id, id));
    await auditEnTx(tx, ctx, 'flito_revision', revision.id,
      `Descarte de documento en revisión (${revision.modulo}, ${revision.motivo}). Soporte ${revision.soporteId}. ${motivo.trim()}`, 'delete');
  });
}

/** Storage key del soporte para servir su archivo (visor PDF de la cola). null si no existe. */
export async function storageKeySoporte(soporteId: string): Promise<{ storageKey: string; nombreArchivo: string; contentType: string } | null> {
  const [s] = await db.select({
    storageKey: flitoSoportes.storageKey, nombreArchivo: flitoSoportes.nombreArchivo, contentType: flitoSoportes.contentType,
  }).from(flitoSoportes).where(eq(flitoSoportes.id, soporteId)).limit(1);
  return s ?? null;
}
