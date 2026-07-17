// FLITO Impuestos — workflow (cola, envío al gestor, estados). Porta la parte de gestión de
// packages/server/src/impuestos/impuestos.servicio.ts sobre drizzle. La carga de factura de venta
// (precondición) vive en flito-factura-venta.service.ts; la carga de recibos → Pagado llega en P3.
//
// Dos fronteras innegociables, como en SOAT: compañías que autogestionan quedan fuera SIEMPRE
// (CA-05), y un gestor de impuestos solo ve SU organismo (CA-10) — atadura = users.transito_codigo,
// leída de BD (§9.3), nunca el JWT. El gestor NUNCA ve los Pendiente.

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoCompradores, flitoImpuestos, flitoSoportes, flitoTramites,
  organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { EstadoImpuesto, ESTADO_IMPUESTO_LABEL } from '@operaciones/shared-types';
import { ImpuestoError, type ImpuestoCtx } from './flito-factura-venta.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lo único que ve un gestor de impuestos. Pendiente NO está: su trabajo arranca al recibir el envío. */
const ESTADOS_VISIBLES_GESTOR: readonly EstadoImpuesto[] = [EstadoImpuesto.EN_GESTION, EstadoImpuesto.PAGADO];

const esGestor = (ctx: ImpuestoCtx) => ctx.role === 'gestor_impuestos';

export interface ImpuestoColaItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
}

const SELECT_COLA = {
  id: flitoImpuestos.id, tramiteId: flitoImpuestos.tramiteId, idFlit: flitoTramites.idFlit,
  estado: flitoImpuestos.estado, organismoCodigo: flitoImpuestos.organismoCodigo,
  valorLiquidado: flitoImpuestos.valorLiquidado, valorPagado: flitoImpuestos.valorPagado,
  marcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia, facturaVentaSoporteId: flitoImpuestos.facturaVentaSoporteId,
  enviadoEn: flitoImpuestos.enviadoEn, motivoRechazo: flitoImpuestos.motivoRechazo, createdAt: flitoImpuestos.createdAt,
  placa: vehicles.plate, vin: vehicles.vin, companiaNombre: clients.name,
  organismoNombre: organismosTransitoConfig.alias, organismoSla: organismosTransitoConfig.flitoSlaHoras,
  enviadoPorNombre: users.name,
} as const;

function fromCola() {
  return db.select(SELECT_COLA).from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(users, eq(flitoImpuestos.enviadoPorId, users.id));
}

type FilaCola = Awaited<ReturnType<ReturnType<typeof fromCola>['where']>>[number];

/** Cola de impuestos con las dos fronteras (CA-05 autogestión, CA-10 organismo del gestor). */
export async function colaImpuestos(ctx: ImpuestoCtx, estados?: EstadoImpuesto[], buscar?: string): Promise<ImpuestoColaItem[]> {
  const conds = [eq(clients.impuestosAutogestionable, false)];

  if (esGestor(ctx)) {
    if (!ctx.transitoCodigo) return []; // sin organismo no hay frontera → nada
    conds.push(eq(flitoImpuestos.organismoCodigo, ctx.transitoCodigo));
    const visibles = estados?.length ? estados.filter((e) => ESTADOS_VISIBLES_GESTOR.includes(e)) : [EstadoImpuesto.EN_GESTION];
    if (visibles.length === 0) return [];
    conds.push(inArray(flitoImpuestos.estado, visibles));
  } else if (estados?.length) {
    conds.push(inArray(flitoImpuestos.estado, estados));
  }

  const termino = buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`EXISTS (SELECT 1 FROM ${flitoCompradores} fc WHERE fc.tramite_id = ${flitoTramites.id}
            AND (UPPER(fc.nombre_completo) LIKE ${patronTexto} OR fc.numero_documento LIKE ${patronTexto}))`,
    )!);
  }

  const rows = await fromCola().where(and(...conds)).orderBy(asc(flitoImpuestos.createdAt));
  return ensamblar(rows);
}

async function ensamblar(rows: FilaCola[]): Promise<ImpuestoColaItem[]> {
  const tramiteIds = [...new Set(rows.map((r) => r.tramiteId))];
  const compradores = tramiteIds.length
    ? await db.select().from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, tramiteIds)).orderBy(asc(flitoCompradores.orden))
    : [];
  const principalPorTramite = new Map<string, typeof compradores[number]>();
  for (const c of compradores) if (!principalPorTramite.has(c.tramiteId)) principalPorTramite.set(c.tramiteId, c);

  return rows.map((r) => {
    const p = principalPorTramite.get(r.tramiteId);
    return {
      id: r.id, tramiteId: r.tramiteId, idFlit: r.idFlit, placa: r.placa, vin: r.vin ?? '',
      estado: r.estado as EstadoImpuesto,
      compradorNombre: p?.nombreCompleto ?? null, compradorDocumento: p?.numeroDocumento ?? null,
      companiaNombre: r.companiaNombre, organismoCodigo: r.organismoCodigo, organismoNombre: r.organismoNombre,
      valorLiquidado: r.valorLiquidado === null ? null : Number(r.valorLiquidado),
      valorPagado: r.valorPagado === null ? null : Number(r.valorPagado),
      marcadoPorDiferencia: r.marcadoPorDiferencia, tieneFacturaVenta: r.facturaVentaSoporteId !== null,
      enviadoPorNombre: r.enviadoPorNombre, enviadoEn: r.enviadoEn ? r.enviadoEn.toISOString() : null,
      estancado: estaEstancado(r.estado, r.enviadoEn, r.organismoSla),
      motivoRechazo: r.motivoRechazo, creadoEn: r.createdAt.toISOString(),
    };
  });
}

function estaEstancado(estado: string, enviadoEn: Date | null, slaHoras: number | null): boolean {
  if (estado !== EstadoImpuesto.EN_GESTION || !slaHoras || !enviadoEn) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > slaHoras;
}

/**
 * Busca un impuesto aplicando la frontera del gestor. 404-no-403 (un 403 ya confirma que el id
 * existe): registro autogestionado, de otro organismo, o en estado no visible → null.
 */
export async function buscarConAcceso(id: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect | null> {
  const [row] = await db.select({ imp: flitoImpuestos, autogestion: clients.impuestosAutogestionable })
    .from(flitoImpuestos).innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(eq(flitoImpuestos.id, id)).limit(1);
  if (!row) return null;
  if (row.autogestion) return null;
  if (esGestor(ctx)) {
    if (row.imp.organismoCodigo !== ctx.transitoCodigo) return null;
    if (!ESTADOS_VISIBLES_GESTOR.includes(row.imp.estado as EstadoImpuesto)) return null;
  }
  return row.imp;
}

export interface ImpuestoDetalle extends ImpuestoColaItem {
  extraccion: unknown; extraccionFacturaVenta: unknown; pagadoEn: string | null;
  soportes: Array<{ id: string; tipo: string; nombreArchivo: string; subidoEn: string }>;
}

export async function detalleImpuesto(id: string, ctx: ImpuestoCtx): Promise<ImpuestoDetalle | null> {
  const imp = await buscarConAcceso(id, ctx); // frontera (404-no-403)
  if (!imp) return null;
  const rows = await fromCola().where(eq(flitoImpuestos.id, id)).limit(1);
  const [item] = await ensamblar(rows);
  if (!item) return null;
  const soportes = await db.select({ id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo, subidoEn: flitoSoportes.subidoEn })
    .from(flitoSoportes).where(eq(flitoSoportes.impuestoId, id)).orderBy(asc(flitoSoportes.subidoEn));
  return {
    ...item, extraccion: imp.extraccion, extraccionFacturaVenta: imp.extraccionFacturaVenta,
    pagadoEn: imp.pagadoEn ? imp.pagadoEn.toISOString() : null,
    soportes: soportes.map((s) => ({ ...s, subidoEn: s.subidoEn.toISOString() })),
  };
}

async function auditEnTx(tx: Tx, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail });
}

export interface ResultadoEnvio { enviados: string[]; yaEnviados: string[] }

/**
 * Envía impuestos al gestor del organismo: Pendiente → En gestión. Solo Operaciones. Atómico
 * (CA-04): con dos usuarios despachando la misma cola, FOR UPDATE OF flito_impuestos SKIP LOCKED
 * evita que ambos manden el mismo registro. Solo cuenta con factura de venta cargada (estado
 * PENDIENTE ya lo garantiza: sin_factura no llega aquí).
 */
export async function enviarAlGestor(ids: string[], ctx: ImpuestoCtx): Promise<ResultadoEnvio> {
  if (ids.length === 0) return { enviados: [], yaEnviados: [] };
  const enviados = await db.transaction(async (tx) => {
    const locked = await tx.select({ id: flitoImpuestos.id }).from(flitoImpuestos)
      .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
      .where(and(inArray(flitoImpuestos.id, ids), eq(flitoImpuestos.estado, EstadoImpuesto.PENDIENTE), eq(clients.impuestosAutogestionable, false)))
      .for('update', { of: flitoImpuestos, skipLocked: true });
    const idsEnviados = locked.map((r) => r.id);
    if (idsEnviados.length === 0) return [];
    await tx.update(flitoImpuestos).set({ estado: EstadoImpuesto.EN_GESTION, enviadoPorId: ctx.userId, enviadoEn: new Date(), updatedAt: new Date() })
      .where(inArray(flitoImpuestos.id, idsEnviados));
    for (const id of idsEnviados) await auditEnTx(tx, ctx, id, 'Envío al gestor (pendiente→en_gestion).');
    return idsEnviados;
  });
  return { enviados, yaEnviados: ids.filter((id) => !enviados.includes(id)) };
}

/** Rechazo del gestor. Solo desde En gestión; motivo obligatorio. */
export async function rechazar(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const imp = await buscarConAcceso(id, ctx);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (imp.estado !== EstadoImpuesto.EN_GESTION) throw new ImpuestoError(400, 'Solo se puede rechazar un impuesto en gestión');
  if (!motivo?.trim()) throw new ImpuestoError(400, 'El motivo del rechazo es obligatorio');
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: EstadoImpuesto.RECHAZADO, motivoRechazo: motivo.trim(), updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Rechazo (en_gestion→rechazado): ${motivo.trim()}`);
    return u;
  });
}

/** Devuelve un impuesto rechazado a la cola. Solo Operaciones, solo desde Rechazado. */
export async function reactivar(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (imp.estado !== EstadoImpuesto.RECHAZADO) throw new ImpuestoError(400, `Solo un impuesto rechazado vuelve a Pendiente. Este está en "${ESTADO_IMPUESTO_LABEL[imp.estado as EstadoImpuesto]}".`);
  if (!motivo?.trim()) throw new ImpuestoError(400, 'El motivo de la corrección es obligatorio');
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: EstadoImpuesto.PENDIENTE, enviadoPorId: null, enviadoEn: null, motivoRechazo: null, updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Reactivación (rechazado→pendiente): ${motivo.trim()}`);
    return u;
  });
}

/** Reversa manual por Operaciones. Motivo ≥5. Reversar a Pendiente limpia envío/pago/marca. */
export async function reversar(id: string, estadoDestino: EstadoImpuesto, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (!motivo?.trim() || motivo.trim().length < 5) throw new ImpuestoError(400, 'La reversa exige un motivo que explique el porqué');
  if (imp.estado === estadoDestino) throw new ImpuestoError(400, 'El impuesto ya está en ese estado');
  const limpiar = estadoDestino === EstadoImpuesto.PENDIENTE
    ? { enviadoPorId: null, enviadoEn: null, pagadoEn: null, motivoRechazo: null, marcadoPorDiferencia: false }
    : {};
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: estadoDestino, ...limpiar, updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Reversa ${imp.estado}→${estadoDestino}: ${motivo.trim()}`);
    return u;
  });
}

// Reexport para las rutas.
export { ImpuestoError };
