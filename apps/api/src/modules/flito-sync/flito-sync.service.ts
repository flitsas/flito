// FLITO — sincronización de trámites desde FLIT (real, solo lectura). Ver docs/integracion/integracionFlit.md.
//
// El reporte de FLIT es la FUENTE DE VERDAD y trae TODOS los trámites en cualquier estado. Cada uno se
// UPSERTA por id_flit (insertar si no existe, actualizar si ya existe: estado y fecha de aprobación
// cambian). Nunca se marca "salido" por ausencia (la consulta es por rango de fechas). SOAT e impuestos
// solo se resuelven para trámites 'Asignado' con compañía y secretaría ya emparejadas. Cada diferencia
// detectada deja historial (origen 'api'). Idempotente; cada trámite en su propia transacción.

import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, flitoCompradores, flitoImpuestos, flitoSoat, flitoTramiteHistorial, flitoTramites, systemKv, vehicles,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  EstadoImpuesto, EstadoSoat, EstadoTramiteFlito, ModalidadOrganismo, resolverCodigoOrganismoFlit,
  soatBloqueaReencolado,
} from '@operaciones/shared-types';
import {
  companiaPorNit, modalidadVigente, organismoPorCodigo, resolverProveedor,
  type CompaniaRow,
} from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { getFlitAdapter } from './flit.adapter.js';
import { mapearCompradores } from './mapeo-compradores.js';
import type { FlitPort, RangoSync, ResultadoSync, TramiteFlit } from './flit.port.js';

const log = loggerFor('flito-sync');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

const ACTOR_SISTEMA = 'sistema';
const numOrNull = (v: number | null): string | null => (v === null ? null : String(v));
export const esAsignado = (estadoFlit: string): boolean => estadoFlit.trim().toLowerCase() === 'asignado';

/** Mapea el estado crudo de FLIT al enum interno FLITO cuando aplica; null si no tiene equivalente. */
export function estadoEnumDesdeFlit(estadoFlit: string): EstadoTramiteFlito | null {
  const n = estadoFlit.trim().toLowerCase();
  const mapa: Record<string, EstadoTramiteFlito> = {
    asignado: EstadoTramiteFlito.ASIGNADO, entregado: EstadoTramiteFlito.ENTREGADO,
    aprobado: EstadoTramiteFlito.APROBADO, rechazado: EstadoTramiteFlito.RECHAZADO,
    anulado: EstadoTramiteFlito.ANULADO,
  };
  return mapa[n] ?? null;
}

async function auditSistema(exec: DbOrTx, entry: { action: 'create' | 'update'; resource: string; resourceId: string; detail: string }): Promise<void> {
  await exec.insert(auditLogs).values({ userId: null, userEmail: ACTOR_SISTEMA, action: entry.action, resource: entry.resource, resourceId: entry.resourceId, detail: entry.detail });
}

/**
 * Estado inicial del impuesto (RN-01 Impuestos). La modalidad decide y `sin_clasificar` NO es un
 * default sino una retención (CA-03). Compañía/organismo autogestionado → no aplica; sin clasificar →
 * retenido; requiere gestión → sin factura (a la espera de la factura de venta, que ahora llega de FLIT).
 */
export function decidirEstadoImpuesto(impuestosAutogestionable: boolean, modalidad: ModalidadOrganismo): EstadoImpuesto {
  if (impuestosAutogestionable) return EstadoImpuesto.NO_APLICA;
  if (modalidad === ModalidadOrganismo.AUTOGESTIONADO) return EstadoImpuesto.NO_APLICA;
  if (modalidad === ModalidadOrganismo.SIN_CLASIFICAR) return EstadoImpuesto.RETENIDO;
  return EstadoImpuesto.SIN_FACTURA;
}

function nuevoResultado(): ResultadoSync {
  return {
    tramitesLeidos: 0, tramitesNuevos: 0, tramitesActualizados: 0, tramitesSinCambios: 0, soatCreados: 0, soatBloqueadosPorVin: 0,
    impuestosCreados: 0, impuestosRetenidos: 0, impuestosNoAplica: 0, companiasFaltantes: 0,
    organismosSinEmparejar: 0, ejecutadoEn: new Date().toISOString(),
  };
}

export async function sincronizar(rango: RangoSync, flit: FlitPort = getFlitAdapter()): Promise<ResultadoSync> {
  const inicio = Date.now();
  const tramites = await flit.obtenerTramites(rango);
  const r = nuevoResultado();
  r.tramitesLeidos = tramites.length;

  for (const tf of tramites) {
    try {
      await db.transaction(async (tx) => { await sincronizarUno(tx, tf, r); });
    } catch (error) {
      log.error({ idFlit: tf.idFlit, err: (error as Error).message }, 'no se pudo sincronizar el trámite');
    }
  }

  log.info({ ...r, ms: Date.now() - inicio }, 'sincronización FLIT');
  return r;
}

// ── Estado de sincronización (persistido en system_kv) ───────────────────────
// Guarda cuándo se sincronizó por última vez para (a) mostrar "última actualización" y (b) usar esa
// fecha como initialDate del próximo sync (incremental): traer solo lo aparecido/cambiado desde entonces.
const KV_ULTIMA_SYNC = 'flito.ultima_sincronizacion';

/** ISO del último sync exitoso, o null si nunca se sincronizó. */
export async function leerUltimaSincronizacion(): Promise<string | null> {
  const [row] = await db.select({ v: systemKv.v }).from(systemKv).where(eq(systemKv.k, KV_ULTIMA_SYNC)).limit(1);
  const at = (row?.v as { at?: string } | undefined)?.at;
  return typeof at === 'string' ? at : null;
}

export async function guardarUltimaSincronizacion(atIso: string): Promise<void> {
  await db.insert(systemKv).values({ k: KV_ULTIMA_SYNC, v: { at: atIso } })
    .onConflictDoUpdate({ target: systemKv.k, set: { v: { at: atIso }, updatedAt: new Date() } });
}

/** ¿Ya hay trámites FLITO en local? (para saber si es la primera sincronización). */
export async function hayTramites(): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(flitoTramites).limit(1);
  return Number(row?.n ?? 0) > 0;
}

async function sincronizarUno(tx: Tx, tf: TramiteFlit, r: ResultadoSync): Promise<void> {
  // Match compañía por NIT y secretaría por nombre (o código, si el adaptador ya lo trae). Ambos
  // pueden faltar: el trámite se guarda igual, pero sin SOAT/impuesto hasta emparejarlos.
  const compania = tf.companiaNit ? await companiaPorNit(tf.companiaNit) : null;
  if (tf.companiaNit && !compania) r.companiasFaltantes += 1;

  // FLIT no trae el código DIVIPOLA: se resuelve por ciudad (respaldo: nombre) contra el catálogo
  // nacional y luego se busca la config del organismo. Si ese organismo no está configurado, el
  // trámite queda sin emparejar (no se auto-provisiona): al configurarlo, el próximo sync lo enlaza.
  const codigoOrganismo = tf.organismoCodigo ?? resolverCodigoOrganismoFlit({ ciudad: tf.ciudad, nombre: tf.transitoNombre });
  const organismo = codigoOrganismo ? await organismoPorCodigo(codigoOrganismo) : null;
  if ((tf.ciudad || tf.transitoNombre) && !organismo) r.organismosSinEmparejar += 1;

  const vehiculoId = await upsertVehiculo(tx, tf, compania?.id ?? null);
  const { tramiteId, esNuevo, huboCambios, soatId } = await upsertTramite(tx, tf, vehiculoId, compania?.id ?? null, organismo?.codigo ?? null, r);

  // Nuevo / actualizado (llegó con diferencias, deja rastro) / sin cambios (idéntico, sin rastro).
  if (esNuevo) r.tramitesNuevos += 1;
  else if (huboCambios) r.tramitesActualizados += 1;
  else r.tramitesSinCambios += 1;

  // SOAT/impuestos requieren compañía y organismo emparejados y estado Asignado.
  if (esAsignado(tf.estadoFlit) && compania && organismo) {
    await resolverSoat(tx, tf, tramiteId, soatId, vehiculoId, compania, organismo.codigo, r);
    await resolverImpuesto(tx, tf, tramiteId, compania, organismo.codigo, r);
  }
}

async function upsertVehiculo(tx: Tx, tf: TramiteFlit, companiaId: number | null): Promise<number> {
  const [existente] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, tf.vin)).limit(1);
  const set = { plate: tf.placa, ...(tf.marca ? { brand: tf.marca } : {}), ...(tf.linea ? { model: tf.linea } : {}), updatedAt: new Date() };
  if (existente) {
    await tx.update(vehicles).set(set).where(eq(vehicles.id, existente.id));
    return existente.id;
  }
  const [creado] = await tx.insert(vehicles)
    .values({ vin: tf.vin, plate: tf.placa, brand: tf.marca ?? null, model: tf.linea ?? null, clientId: companiaId })
    .returning({ id: vehicles.id });
  return creado.id;
}

// Diferencias que quedan en el historial (auditoría campo por campo, origen 'api').
async function registrarDiferencias(tx: Tx, tramiteId: string, previo: Record<string, string | null>, nuevo: Record<string, string | null>): Promise<string[]> {
  const cambios: string[] = [];
  for (const campo of Object.keys(nuevo)) {
    const a = previo[campo] ?? null;
    const b = nuevo[campo] ?? null;
    if (a === b) continue;
    cambios.push(campo);
    await tx.insert(flitoTramiteHistorial).values({ tramiteId, campo, valorAnterior: a, valorNuevo: b, origen: 'api', usuarioId: null });
  }
  return cambios;
}

async function upsertTramite(
  tx: Tx, tf: TramiteFlit, vehiculoId: number, companiaId: number | null, organismoCodigo: string | null, r: ResultadoSync,
): Promise<{ tramiteId: string; esNuevo: boolean; huboCambios: boolean; soatId: string | null }> {
  const [existente] = await tx.select().from(flitoTramites).where(eq(flitoTramites.idFlit, tf.idFlit)).limit(1);
  const fechaAprobacion = tf.fechaAprobacion ? new Date(tf.fechaAprobacion) : null;

  const valores = {
    estado: estadoEnumDesdeFlit(tf.estadoFlit),
    flitEstado: tf.estadoFlit,
    tipoTramite: tf.tipoTramite,
    ciudad: tf.ciudad,
    tipoPropiedad: tf.tipoPropiedad,
    companiaId,
    companiaNit: tf.companiaNit,
    organismoCodigo,
    transitoNombreFlit: tf.transitoNombre,
    vehiculoId,
    valorImpuestoLiquidado: numOrNull(tf.valorImpuestoLiquidado),
    facturaVentaFlitId: tf.facturaVentaFlitId,
    fechaAprobacion,
    flitRaw: tf.raw,
    processStatus: tf.processStatus ?? null,
    plateComplete: tf.placa,
    sincronizadoEn: new Date(),
  };

  let row: typeof flitoTramites.$inferSelect;
  let huboCambios = false;
  if (existente) {
    // Historial de campos observables antes de pisar (origen 'api').
    const cambios = await registrarDiferencias(tx, existente.id, {
      flit_estado: existente.flitEstado, factura_venta_flit_id: existente.facturaVentaFlitId,
      fecha_aprobacion: existente.fechaAprobacion ? existente.fechaAprobacion.toISOString() : null,
      compania_id: existente.companiaId === null ? null : String(existente.companiaId),
      organismo_codigo: existente.organismoCodigo, tipo_tramite: existente.tipoTramite, ciudad: existente.ciudad,
    }, {
      flit_estado: tf.estadoFlit, factura_venta_flit_id: tf.facturaVentaFlitId,
      fecha_aprobacion: fechaAprobacion ? fechaAprobacion.toISOString() : null,
      compania_id: companiaId === null ? null : String(companiaId),
      organismo_codigo: organismoCodigo, tipo_tramite: tf.tipoTramite, ciudad: tf.ciudad,
    });
    huboCambios = cambios.length > 0;
    [row] = await tx.update(flitoTramites).set({ ...valores, updatedAt: new Date() }).where(eq(flitoTramites.id, existente.id)).returning();
    if (cambios.includes('flit_estado')) {
      await auditSistema(tx, { action: 'update', resource: 'flito_tramite', resourceId: row.id, detail: `Estado FLIT: "${existente.flitEstado ?? '—'}" → "${tf.estadoFlit}" (trámite ${tf.idFlit}).` });
    }
  } else {
    [row] = await tx.insert(flitoTramites).values({ idFlit: tf.idFlit, ...valores }).returning();
  }

  // Compradores se reemplazan en bloque: FLIT es la fuente de verdad.
  const compradores = mapearCompradores(tf);
  await tx.delete(flitoCompradores).where(eq(flitoCompradores.tramiteId, row.id));
  if (compradores.length > 0) {
    await tx.insert(flitoCompradores).values(compradores.map((c) => ({
      tramiteId: row.id, nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento,
      correo: c.correo, celular: c.celular, direccion: c.direccion, orden: c.orden,
      porcentajeParticipacion: c.porcentajeParticipacion === null ? null : String(c.porcentajeParticipacion),
    })));
  }

  return { tramiteId: row.id, esNuevo: !existente, huboCambios, soatId: row.soatId };
}

/** Resuelve el SOAT (RN-01: por VIN, exento si la compañía autogestiona). Igual que el mock. */
async function resolverSoat(
  tx: Tx, tf: TramiteFlit, tramiteId: string, soatIdActual: string | null,
  vehiculoId: number, compania: CompaniaRow, organismoCodigo: string, r: ResultadoSync,
): Promise<void> {
  if (compania.soatAutogestionable) return;

  const [existente] = await tx.select().from(flitoSoat).where(eq(flitoSoat.vin, tf.vin)).limit(1);
  if (existente) {
    if (soatIdActual !== existente.id) {
      await tx.update(flitoTramites).set({ soatId: existente.id, updatedAt: new Date() }).where(eq(flitoTramites.id, tramiteId));
    }
    if (soatBloqueaReencolado(existente.estado as EstadoSoat)) {
      r.soatBloqueadosPorVin += 1;
      await auditSistema(tx, { action: 'update', resource: 'flito_soat', resourceId: existente.id, detail: `Reencolado bloqueado (RN-01): el VIN ${tf.vin} ya tiene SOAT en "${existente.estado}". Trámite ${tf.idFlit}.` });
    }
    return;
  }

  const proveedor = await resolverProveedor(compania.id, organismoCodigo);
  const [soat] = await tx.insert(flitoSoat).values({
    vin: tf.vin, vehiculoId, estado: EstadoSoat.PENDIENTE, companiaId: compania.id,
    organismoCodigo, proveedorSoatId: proveedor?.id ?? null, proveedorSobrescrito: false,
  }).returning();
  await tx.update(flitoTramites).set({ soatId: soat.id, updatedAt: new Date() }).where(eq(flitoTramites.id, tramiteId));
  r.soatCreados += 1;
  await auditSistema(tx, { action: 'create', resource: 'flito_soat', resourceId: soat.id, detail: `SOAT creado para VIN ${tf.vin} (trámite ${tf.idFlit}). Proveedor: ${proveedor?.nombre ?? 'sin asignar'}.` });
}

/**
 * Resuelve el impuesto. La modalidad decide (RN-01, sin default silencioso). La factura de venta ya
 * NO se carga a mano: viene de FLIT. Si el organismo requiere gestión y el trámite trae factura, el
 * impuesto arranca en 'pendiente' (listo para enviar); sin factura, en 'sin_factura'.
 */
async function resolverImpuesto(tx: Tx, tf: TramiteFlit, tramiteId: string, compania: CompaniaRow, organismoCodigo: string, r: ResultadoSync): Promise<void> {
  const [existente] = await tx.select().from(flitoImpuestos).where(eq(flitoImpuestos.tramiteId, tramiteId)).limit(1);
  if (existente) {
    // El estado es del módulo, no del sync. Solo se completa el valor liquidado si llega.
    if (existente.valorLiquidado === null && tf.valorImpuestoLiquidado !== null) {
      await tx.update(flitoImpuestos).set({ valorLiquidado: numOrNull(tf.valorImpuestoLiquidado), updatedAt: new Date() }).where(eq(flitoImpuestos.id, existente.id));
    }
    return;
  }

  const modalidad = await modalidadVigente(organismoCodigo);
  let estado = decidirEstadoImpuesto(compania.impuestosAutogestionable, modalidad);
  // La factura de venta de FLIT es la precondición: con factura, el impuesto está listo para enviar.
  if (estado === EstadoImpuesto.SIN_FACTURA && tf.facturaVentaFlitId) estado = EstadoImpuesto.PENDIENTE;

  const [impuesto] = await tx.insert(flitoImpuestos).values({
    tramiteId, estado, organismoCodigo, companiaId: compania.id, modalidadAplicada: modalidad,
    valorLiquidado: numOrNull(tf.valorImpuestoLiquidado),
    ...(tf.facturaVentaFlitId ? { extraccionFacturaVenta: null } : {}),
  }).returning();

  if (estado === EstadoImpuesto.RETENIDO) r.impuestosRetenidos += 1;
  else if (estado === EstadoImpuesto.NO_APLICA) r.impuestosNoAplica += 1;
  else r.impuestosCreados += 1;

  await auditSistema(tx, {
    action: 'create', resource: 'flito_impuesto', resourceId: impuesto.id,
    detail: estado === EstadoImpuesto.RETENIDO
      ? `Impuesto RETENIDO: el organismo ${organismoCodigo} no tiene modalidad clasificada (trámite ${tf.idFlit}).`
      : `Impuesto creado en "${estado}" (trámite ${tf.idFlit}, modalidad ${modalidad}).`,
  });
}
