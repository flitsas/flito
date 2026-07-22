// FLITO Trámites unificado (Fase 5 P3). Porta packages/server/src/tramites/tramites.servicio.ts.
//
// Una sola tabla centrada en el trámite que reemplaza las colas separadas de SOAT e Impuestos y la
// compuerta. NO duplica lógica de negocio: cada acción resuelve tramiteId → soatId/impuestoId y DELEGA
// en el servicio dueño de la regla (SOAT/Impuestos para el envío al gestor, Compuerta para el veredicto
// y la entrega). Aquí solo vive el mapeo y el reporte agregado.

import { and, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import {
  EstadoImpuesto, EstadoTramiteFlito, ESTADOS_TRAMITE_FLITO_TERMINADOS,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoCompradores, flitoImpuestos, flitoProveedoresSoat, flitoSoat, flitoTramiteHistorial,
  flitoTramites, organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { decidir, entregar as entregarCompuerta } from '../flito-compuerta/flito-compuerta.service.js';
import { enviarAlGestor as enviarSoat } from '../flito-soat/flito-soat.service.js';
import { enviarAlGestor as enviarImpuestos } from '../flito-impuestos/flito-impuestos.service.js';

export interface TramitesCtx { userId: number; username: string; role: string }

const soatCtx = (ctx: TramitesCtx) => ({ userId: ctx.userId, username: ctx.username, role: ctx.role, proveedorSoatId: null });
const impuestoCtx = (ctx: TramitesCtx) => ({ userId: ctx.userId, username: ctx.username, role: ctx.role, transitoCodigo: null });

export interface Comprador {
  nombreCompleto: string; numeroDocumento: string; correo: string | null; celular: string | null;
  direccion: string | null; orden: number; porcentajeParticipacion: string | null;
}
export interface FilaSoat {
  id: string; estado: string; proveedorSoatId: string | null; proveedorSoatNombre: string | null;
  valorPagado: number | null; enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
export interface FilaImpuesto {
  id: string; estado: string; tieneFacturaVenta: boolean; coincidenciaFacturaVenta: number | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
/**
 * Semáforo de gestión FLITO del trámite (lo que le falta a FLITO por resolver):
 *   autogestionada — la empresa autogestiona SOAT e impuestos → FLITO no gestiona (gris).
 *   rojo   — ni SOAT ni impuesto resueltos.
 *   amarillo — uno de los dos resuelto.
 *   verde  — ambos resueltos (listo para entregar).
 * "Resuelto" = pagado o no_aplica (mismo criterio que la compuerta).
 */
export type SemaforoTramite = 'autogestionada' | 'rojo' | 'amarillo' | 'verde';

export interface TramiteFila {
  tramiteId: string; idFlit: string;
  semaforo: SemaforoTramite;
  /** Estado crudo de FLIT (todos los estados se muestran). */
  estado: string;
  /** true solo si el estado FLIT es 'Asignado' → habilita SOAT/impuestos. */
  asignado: boolean;
  tipoTramite: string | null; ciudad: string | null; fechaAprobacion: string | null;
  companiaNombre: string | null; empresaExiste: boolean; empresaNit: string | null;
  organismoNombre: string | null; secretariaEmparejada: boolean; transitoNombre: string | null;
  facturaVentaFlitId: string | null;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  compradorPrincipal: Comprador | null; compradores: Comprador[];
  soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
}

export interface HistorialItem {
  id: string; campo: string; valorAnterior: string | null; valorNuevo: string | null;
  origen: string; usuarioNombre: string | null; creadoEn: string;
}

/** Historial de cambios de un trámite (auditoría campo por campo). Más reciente primero. */
export async function historial(tramiteId: string): Promise<HistorialItem[]> {
  const rows = await db.select({
    id: flitoTramiteHistorial.id, campo: flitoTramiteHistorial.campo,
    valorAnterior: flitoTramiteHistorial.valorAnterior, valorNuevo: flitoTramiteHistorial.valorNuevo,
    origen: flitoTramiteHistorial.origen, usuarioNombre: users.name, creadoEn: flitoTramiteHistorial.createdAt,
  }).from(flitoTramiteHistorial)
    .leftJoin(users, eq(flitoTramiteHistorial.usuarioId, users.id))
    .where(eq(flitoTramiteHistorial.tramiteId, tramiteId))
    .orderBy(desc(flitoTramiteHistorial.createdAt));
  return rows.map((r) => ({ ...r, creadoEn: r.creadoEn.toISOString() }));
}

export interface ResultadoCrearEmpresa { companiaId: number; yaExistia: boolean; revinculados: number }

/**
 * Crea la empresa (cliente) de un trámite cuya compañía FLIT no existía aún y la re-vincula: fija
 * `companiaId` en todos los trámites de ese NIT que estaban sin compañía, dejándolos accionables sin
 * esperar a un nuevo sync. El cambio queda en el historial con origen 'usuario'. Idempotente: si ya
 * existe un cliente con ese NIT, lo reutiliza (yaExistia) y solo re-vincula los pendientes.
 */
export async function crearEmpresaDesdeTramite(nombre: string, nit: string, ctx: TramitesCtx): Promise<ResultadoCrearEmpresa> {
  const doc = nit.trim();
  const [existente] = await db.select({ id: clients.id }).from(clients).where(eq(clients.document, doc)).limit(1);
  let companiaId: number;
  let yaExistia = false;
  if (existente) { companiaId = existente.id; yaExistia = true; }
  else {
    const [creada] = await db.insert(clients)
      .values({ name: nombre.trim(), document: doc, documentType: 'NIT' })
      .returning({ id: clients.id });
    companiaId = creada.id;
  }
  const pendientes = await db.select({ id: flitoTramites.id }).from(flitoTramites)
    .where(and(eq(flitoTramites.companiaNit, doc), sql`${flitoTramites.companiaId} is null`));
  if (pendientes.length > 0) {
    const ids = pendientes.map((t) => t.id);
    await db.update(flitoTramites).set({ companiaId }).where(inArray(flitoTramites.id, ids));
    await db.insert(flitoTramiteHistorial).values(ids.map((tid) => ({
      tramiteId: tid, campo: 'compania_id', valorAnterior: null, valorNuevo: String(companiaId),
      origen: 'usuario', usuarioId: ctx.userId,
    })));
  }
  return { companiaId, yaExistia, revinculados: pendientes.length };
}

export interface TramiteReferencia { tramiteId: string; idFlit: string; placa: string | null }
export interface ResultadoSolicitudSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
export interface ResultadoSolicitudImpuestos { enviados: number; yaEnviados: number; requierenFactura: TramiteReferencia[]; noAplica: number; retenidos: TramiteReferencia[] }
export interface ResultadoSolicitudAmbos { soat: ResultadoSolicitudSoat; impuestos: ResultadoSolicitudImpuestos }
export interface ResultadoEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }

function proyeccion() {
  return db.select({
    // Campos que consume decidir() (compuerta) — mismos nombres que FilaCompuerta.
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    estadoTramite: flitoTramites.estado,
    placa: vehicles.plate,
    companiaNombre: clients.name,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    soatEstado: flitoSoat.estado,
    soatValorPagado: flitoSoat.valorPagado,
    soatExtraccion: flitoSoat.extraccion,
    impuestoEstado: flitoImpuestos.estado,
    impuestoValorPagado: flitoImpuestos.valorPagado,
    impuestoMarcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia,
    impuestoExtraccion: flitoImpuestos.extraccion,
    // Integración FLIT (Fase 8): estado crudo, datos del reporte y emparejamientos.
    flitEstado: flitoTramites.flitEstado,
    tipoTramite: flitoTramites.tipoTramite,
    ciudad: flitoTramites.ciudad,
    companiaId: flitoTramites.companiaId,
    companiaNit: flitoTramites.companiaNit,
    transitoNombreFlit: flitoTramites.transitoNombreFlit,
    facturaVentaFlitId: flitoTramites.facturaVentaFlitId,
    fechaAprobacion: flitoTramites.fechaAprobacion,
    // Extras de presentación.
    sincronizadoEn: flitoTramites.sincronizadoEn,
    organismoAlias: organismosTransitoConfig.alias,
    organismoCodigo: flitoTramites.organismoCodigo,
    vin: vehicles.vin,
    marca: vehicles.brand,
    linea: vehicles.model,
    tipoVehiculo: vehicles.tipoVehiculo,
    soatId: flitoSoat.id,
    soatProveedorId: flitoSoat.proveedorSoatId,
    soatProveedorNombre: flitoProveedoresSoat.nombre,
    soatSlaHoras: flitoProveedoresSoat.slaHoras,
    soatEnviadoEn: flitoSoat.enviadoEn,
    soatMotivoRechazo: flitoSoat.motivoRechazo,
    impuestoId: flitoImpuestos.id,
    impuestoExtraccionFacturaVenta: flitoImpuestos.extraccionFacturaVenta,
    impuestoValorLiquidado: flitoImpuestos.valorLiquidado,
    impuestoEnviadoEn: flitoImpuestos.enviadoEn,
    impuestoMotivoRechazo: flitoImpuestos.motivoRechazo,
  }).from(flitoTramites)
    // leftJoin (no inner): compañía y secretaría pueden faltar (empresa inexistente / sin emparejar);
    // el trámite se muestra igual, con su indicador. El vehículo siempre existe (se upserta por VIN).
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id));
}

type FilaCruda = Awaited<ReturnType<ReturnType<typeof proyeccion>['where']>>[number];

function estancadoSoat(estado: string | null, enviadoEn: Date | null, slaHoras: number | null): boolean {
  if (estado !== 'en_adquisicion' || !slaHoras || !enviadoEn) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > slaHoras;
}

function coincidenciaDe(extraccion: unknown): number | null {
  if (!extraccion || typeof extraccion !== 'object') return null;
  const confianzas = Object.values(extraccion as Record<string, { confianza?: number } | undefined>)
    .filter((c): c is { confianza: number } => Boolean(c) && typeof c!.confianza === 'number')
    .map((c) => c.confianza);
  return confianzas.length ? Math.min(...confianzas) : null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function aFila(f: FilaCruda, compradores: Comprador[]): TramiteFila {
  // decidir() (compuerta) exige autogestión booleana; sin compañía emparejada, se asume false.
  const veredicto = decidir({ ...f, soatAutogestionable: f.soatAutogestionable ?? false, impuestosAutogestionable: f.impuestosAutogestionable ?? false, companiaNombre: f.companiaNombre ?? '' });
  const orden = [...compradores].sort((a, b) => a.orden - b.orden);
  const principal = orden[0] ?? null;
  const asignado = (f.flitEstado ?? '').trim().toLowerCase() === 'asignado';
  // Semáforo de gestión: gris si la empresa autogestiona SOAT e impuestos; si no, rojo/amarillo/verde
  // según cuántos de los dos estén resueltos (pagado o no_aplica, según la compuerta).
  const autogestionadaTotal = (f.soatAutogestionable ?? false) && (f.impuestosAutogestionable ?? false);
  const semaforo: SemaforoTramite = autogestionadaTotal ? 'autogestionada'
    : (veredicto.soatResuelto && veredicto.impuestosResueltos) ? 'verde'
      : (veredicto.soatResuelto || veredicto.impuestosResueltos) ? 'amarillo'
        : 'rojo';
  return {
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    semaforo,
    estado: f.flitEstado ?? f.estadoTramite ?? '—',
    asignado,
    tipoTramite: f.tipoTramite,
    ciudad: f.ciudad,
    fechaAprobacion: f.fechaAprobacion ? f.fechaAprobacion.toISOString() : null,
    companiaNombre: f.companiaNombre,
    empresaExiste: f.companiaId !== null,
    empresaNit: f.companiaNit,
    organismoNombre: f.organismoAlias ?? f.transitoNombreFlit,
    secretariaEmparejada: f.organismoCodigo !== null,
    transitoNombre: f.transitoNombreFlit,
    facturaVentaFlitId: f.facturaVentaFlitId,
    vehiculo: { vin: f.vin, placa: f.placa, marca: f.marca, linea: f.linea, tipoVehiculo: f.tipoVehiculo },
    compradorPrincipal: principal,
    compradores: orden,
    soat: f.soatId ? {
      id: f.soatId, estado: f.soatEstado!, proveedorSoatId: f.soatProveedorId, proveedorSoatNombre: f.soatProveedorNombre,
      valorPagado: num(f.soatValorPagado), enviadoEn: f.soatEnviadoEn ? f.soatEnviadoEn.toISOString() : null,
      estancado: estancadoSoat(f.soatEstado, f.soatEnviadoEn, f.soatSlaHoras), motivoRechazo: f.soatMotivoRechazo,
    } : null,
    soatAutogestionado: f.soatAutogestionable ?? false,
    impuesto: f.impuestoId ? {
      id: f.impuestoId, estado: f.impuestoEstado!, tieneFacturaVenta: f.facturaVentaFlitId !== null,
      coincidenciaFacturaVenta: coincidenciaDe(f.impuestoExtraccionFacturaVenta),
      valorLiquidado: num(f.impuestoValorLiquidado), valorPagado: num(f.impuestoValorPagado),
      marcadoPorDiferencia: f.impuestoMarcadoPorDiferencia ?? false,
      enviadoEn: f.impuestoEnviadoEn ? f.impuestoEnviadoEn.toISOString() : null,
      estancado: false, motivoRechazo: f.impuestoMotivoRechazo,
    } : null,
    soatResuelto: veredicto.soatResuelto,
    impuestosResueltos: veredicto.impuestosResueltos,
    listoParaEntregar: veredicto.habilitado,
    valorSoat: veredicto.valorSoat,
    valorImpuesto: veredicto.valorImpuesto,
    sincronizadoEn: f.sincronizadoEn.toISOString(),
  };
}

/**
 * Filas de la tabla unificada. Excluye los trámites terminados (anulado/rechazado). `buscar` es una
 * búsqueda global sobre lo que un humano tiene a mano: id de FLIT, placa, VIN, nombre y documento del
 * comprador. Placa/VIN toleran guiones y espacios.
 */
export async function listar(buscar?: string): Promise<TramiteFila[]> {
  const conds = [notInArray(flitoTramites.estado, [...ESTADOS_TRAMITE_FLITO_TERMINADOS])];

  const termino = buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    const compradorMatch = db.select({ id: flitoCompradores.tramiteId }).from(flitoCompradores)
      .where(or(
        sql`UPPER(${flitoCompradores.nombreCompleto}) LIKE ${patronTexto}`,
        sql`UPPER(${flitoCompradores.numeroDocumento}) LIKE ${patronTexto}`,
      ));
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
      inArray(flitoTramites.id, compradorMatch),
    )!);
  }

  const rows = await proyeccion().where(and(...conds)).orderBy(desc(flitoTramites.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.tramiteId);
  const compradoresRows = await db.select({
    tramiteId: flitoCompradores.tramiteId, nombreCompleto: flitoCompradores.nombreCompleto,
    numeroDocumento: flitoCompradores.numeroDocumento, correo: flitoCompradores.correo,
    celular: flitoCompradores.celular, direccion: flitoCompradores.direccion,
    orden: flitoCompradores.orden, porcentajeParticipacion: flitoCompradores.porcentajeParticipacion,
  }).from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, ids));

  const porTramite = new Map<string, Comprador[]>();
  for (const c of compradoresRows) {
    const lista = porTramite.get(c.tramiteId) ?? [];
    lista.push({
      nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento, correo: c.correo,
      celular: c.celular, direccion: c.direccion, orden: c.orden, porcentajeParticipacion: c.porcentajeParticipacion,
    });
    porTramite.set(c.tramiteId, lista);
  }

  return rows.map((r) => aFila(r, porTramite.get(r.tramiteId) ?? []));
}

/**
 * Solicita SOAT: envía al gestor los seleccionados fijando el proveedor. Deduplica por SOAT — dos
 * trámites del mismo VIN comparten registro (RN-01), así que se envía una sola vez.
 */
export async function solicitarSoat(tramiteIds: string[], proveedorSoatId: string, ctx: TramitesCtx): Promise<ResultadoSolicitudSoat> {
  const tramites = await db.select({
    soatId: flitoTramites.soatId, soatAutogestionable: clients.soatAutogestionable,
  }).from(flitoTramites)
    .innerJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(inArray(flitoTramites.id, tramiteIds));

  let autogestionados = 0;
  let sinRegistro = 0;
  const soatIds = new Set<string>();
  for (const t of tramites) {
    if (t.soatAutogestionable) { autogestionados += 1; continue; }
    if (!t.soatId) { sinRegistro += 1; continue; }
    soatIds.add(t.soatId);
  }

  const { enviados, yaEnviados } = await enviarSoat([...soatIds], soatCtx(ctx), proveedorSoatId);
  return { enviados: enviados.length, yaEnviados: yaEnviados.length, autogestionados, sinRegistro };
}

/**
 * Solicita impuestos: envía los que ya tienen factura de venta (Pendiente) y reporta los que aún no la
 * tienen o no aplican, en vez de bloquear toda la acción.
 */
export async function solicitarImpuestos(tramiteIds: string[], ctx: TramitesCtx): Promise<ResultadoSolicitudImpuestos> {
  const tramites = await db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, placa: vehicles.plate,
    impuestoId: flitoImpuestos.id, impuestoEstado: flitoImpuestos.estado,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .where(inArray(flitoTramites.id, tramiteIds));

  const enviables: string[] = [];
  const requierenFactura: TramiteReferencia[] = [];
  const retenidos: TramiteReferencia[] = [];
  let noAplica = 0;

  for (const t of tramites) {
    if (!t.impuestoId) continue;
    const ref = { tramiteId: t.tramiteId, idFlit: t.idFlit, placa: t.placa };
    switch (t.impuestoEstado) {
      case EstadoImpuesto.PENDIENTE: enviables.push(t.impuestoId); break;
      case EstadoImpuesto.SIN_FACTURA: requierenFactura.push(ref); break;
      case EstadoImpuesto.RETENIDO: retenidos.push(ref); break;
      case EstadoImpuesto.NO_APLICA: noAplica += 1; break;
      default: break; // en gestión / pagado / rechazado: ya se movió.
    }
  }

  const { enviados, yaEnviados } = await enviarImpuestos(enviables, impuestoCtx(ctx));
  return { enviados: enviados.length, yaEnviados: yaEnviados.length, requierenFactura, noAplica, retenidos };
}

export async function solicitarAmbos(tramiteIds: string[], proveedorSoatId: string, ctx: TramitesCtx): Promise<ResultadoSolicitudAmbos> {
  return {
    soat: await solicitarSoat(tramiteIds, proveedorSoatId, ctx),
    impuestos: await solicitarImpuestos(tramiteIds, ctx),
  };
}

/**
 * Entrega en lote. Reutiliza la compuerta, que revalida cada trámite y solo ejecuta los habilitados;
 * los demás se reportan con su motivo. Un fallo no aborta el lote.
 */
export async function entregar(tramiteIds: string[], ctx: TramitesCtx): Promise<ResultadoEntrega> {
  let entregados = 0;
  const noHabilitados: ResultadoEntrega['noHabilitados'] = [];
  for (const tramiteId of tramiteIds) {
    try {
      await entregarCompuerta(tramiteId, { userId: ctx.userId, username: ctx.username, role: ctx.role });
      entregados += 1;
    } catch (error) {
      const [t] = await db.select({ idFlit: flitoTramites.idFlit, placa: vehicles.plate })
        .from(flitoTramites).innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
        .where(eq(flitoTramites.id, tramiteId)).limit(1);
      noHabilitados.push({
        tramiteId, idFlit: t?.idFlit ?? tramiteId, placa: t?.placa ?? '—',
        motivo: error instanceof Error ? error.message : 'No habilitado',
      });
    }
  }
  return { entregados, noHabilitados };
}
