// FLITO — sincronización de trámites desde FLIT. Portado de
// packages/server/src/sincronizacion/sincronizacion.servicio.ts.
//
// Reemplaza la descarga de Excel y el concepto de "corte": la cola la gobierna el estado
// que FLITO ya persistió, así que sincronizar dos veces seguidas no produce trabajo
// repetido. Es idempotente por diseño — la única forma de que un job cada 5 min no genere
// basura. Cada trámite va en su propia transacción: uno corrupto no tumba a los demás.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  flitoCompradores,
  flitoImpuestos,
  flitoSoat,
  flitoTramites,
  vehicles,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  EstadoImpuesto,
  EstadoSoat,
  EstadoTramiteFlito,
  ModalidadOrganismo,
  soatBloqueaReencolado,
} from '@operaciones/shared-types';
import {
  companiaPorNit,
  modalidadVigente,
  organismoPorCodigo,
  resolverProveedor,
  type CompaniaRow,
} from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { estadoDesdeProcessStatus } from './flit-mock.adapter.js';
import { getFlitAdapter } from './flit.adapter.js';
import { mapearCompradores } from './mapeo-compradores.js';
import type { FlitPort, ResultadoSync, TramiteFlit } from './flit.port.js';

const log = loggerFor('flito-sync');

// Tipo exacto de la transacción que provee db.transaction (para tipar los helpers).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

const ACTOR_SISTEMA = 'sistema';

/** Bitácora de acción automática (sin usuario). Se escribe en la misma tx que el cambio. */
async function auditSistema(
  exec: DbOrTx,
  entry: { action: 'create' | 'update' | 'delete'; resource: string; resourceId: string; detail: string },
): Promise<void> {
  await exec.insert(auditLogs).values({
    userId: null,
    userEmail: ACTOR_SISTEMA,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    detail: entry.detail,
  });
}

const numOrNull = (v: number | null): string | null => (v === null ? null : String(v));

/**
 * Decide el estado inicial del impuesto (RN-01 Impuestos). La modalidad decide y
 * `sin_clasificar` NO es un default sino una retención (CA-03). Nunca se asume modalidad.
 * Compañía autogestionada o organismo autogestionado → no aplica; sin clasificar → retenido;
 * requiere gestión → sin factura (espera la factura de venta como precondición del envío).
 */
export function decidirEstadoImpuesto(
  impuestosAutogestionable: boolean,
  modalidad: ModalidadOrganismo,
): EstadoImpuesto {
  if (impuestosAutogestionable) return EstadoImpuesto.NO_APLICA;
  if (modalidad === ModalidadOrganismo.AUTOGESTIONADO) return EstadoImpuesto.NO_APLICA;
  if (modalidad === ModalidadOrganismo.SIN_CLASIFICAR) return EstadoImpuesto.RETENIDO;
  return EstadoImpuesto.SIN_FACTURA;
}

export async function sincronizar(flit: FlitPort = getFlitAdapter()): Promise<ResultadoSync> {
  const inicio = Date.now();
  const tramites = await flit.obtenerTramitesAsignados();

  const r: ResultadoSync = {
    tramitesLeidos: tramites.length,
    tramitesNuevos: 0,
    tramitesActualizados: 0,
    soatCreados: 0,
    soatBloqueadosPorVin: 0,
    impuestosCreados: 0,
    impuestosRetenidos: 0,
    impuestosNoAplica: 0,
    tramitesReconciliados: 0,
    ejecutadoEn: new Date().toISOString(),
  };

  for (const tf of tramites) {
    try {
      await db.transaction(async (tx) => { await sincronizarUno(tx, tf, r); });
    } catch (error) {
      log.error({ idFlit: tf.idFlit, err: (error as Error).message }, 'no se pudo sincronizar el trámite');
    }
  }

  r.tramitesReconciliados = await reconciliarSalidos(flit, tramites);

  log.info(
    {
      leidos: r.tramitesLeidos, nuevos: r.tramitesNuevos, soatCreados: r.soatCreados,
      bloqueadosPorVin: r.soatBloqueadosPorVin, retenidos: r.impuestosRetenidos, ms: Date.now() - inicio,
    },
    'sincronización FLIT',
  );
  return r;
}

async function sincronizarUno(tx: Tx, tf: TramiteFlit, r: ResultadoSync): Promise<void> {
  const compania = await companiaPorNit(tf.companiaNit);
  if (!compania) throw new Error(`La compañía con NIT ${tf.companiaNit} no existe en FLITO`);

  const organismo = await organismoPorCodigo(tf.organismoCodigo);
  if (!organismo) throw new Error(`El organismo con código ${tf.organismoCodigo} no existe en FLITO`);

  const vehiculoId = await upsertVehiculo(tx, tf, compania.id);
  const { tramiteId, esNuevo, soatId } = await upsertTramite(tx, tf, vehiculoId, compania.id, organismo.codigo);

  if (esNuevo) r.tramitesNuevos += 1;
  else r.tramitesActualizados += 1;

  await resolverSoat(tx, tf, tramiteId, soatId, vehiculoId, compania, organismo.codigo, r);
  await resolverImpuesto(tx, tf, tramiteId, compania, organismo.codigo, r);
}

async function upsertVehiculo(tx: Tx, tf: TramiteFlit, companiaId: number): Promise<number> {
  // vin/placa/marca/línea → vin/plate/brand/model. cilindraje/capacidad/tipoVehiculo no tienen
  // columna en `vehicles` y no los usa la resolución SOAT/impuestos; viajan en flito_mock_tramite
  // por si un día se necesitan. clientId se fija solo al crear (el VIN puede compartirse).
  const [existente] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, tf.vin)).limit(1);
  if (existente) {
    await tx.update(vehicles)
      .set({ plate: tf.placa, brand: tf.marca, model: tf.linea, updatedAt: new Date() })
      .where(eq(vehicles.id, existente.id));
    return existente.id;
  }
  const [creado] = await tx.insert(vehicles)
    .values({ vin: tf.vin, plate: tf.placa, brand: tf.marca, model: tf.linea, clientId: companiaId })
    .returning({ id: vehicles.id });
  return creado.id;
}

async function upsertTramite(
  tx: Tx, tf: TramiteFlit, vehiculoId: number, companiaId: number, organismoCodigo: string,
): Promise<{ tramiteId: string; esNuevo: boolean; soatId: string | null }> {
  const estado = estadoDesdeProcessStatus(tf.processStatus);
  const [existente] = await tx.select().from(flitoTramites).where(eq(flitoTramites.idFlit, tf.idFlit)).limit(1);

  const valores = {
    estado,
    tipoPropiedad: tf.tipoPropiedad,
    companiaId,
    organismoCodigo,
    vehiculoId,
    valorImpuestoLiquidado: numOrNull(tf.valorImpuestoLiquidado),
    processStatus: tf.processStatus,
    plateComplete: tf.plateComplete,
    sincronizadoEn: new Date(),
  };

  let row: typeof flitoTramites.$inferSelect;
  if (existente) {
    [row] = await tx.update(flitoTramites).set({ ...valores, updatedAt: new Date() })
      .where(eq(flitoTramites.id, existente.id)).returning();
  } else {
    [row] = await tx.insert(flitoTramites).values({ idFlit: tf.idFlit, ...valores }).returning();
  }

  // Compradores se reemplazan en bloque: FLIT es la fuente de verdad y un merge campo a campo
  // dejaría copropietarios fantasma si el trámite se corrigió.
  const compradores = mapearCompradores(tf);
  await tx.delete(flitoCompradores).where(eq(flitoCompradores.tramiteId, row.id));
  if (compradores.length > 0) {
    await tx.insert(flitoCompradores).values(compradores.map((c) => ({
      tramiteId: row.id,
      nombreCompleto: c.nombreCompleto,
      numeroDocumento: c.numeroDocumento,
      correo: c.correo,
      celular: c.celular,
      direccion: c.direccion,
      orden: c.orden,
      porcentajeParticipacion: c.porcentajeParticipacion === null ? null : String(c.porcentajeParticipacion),
    })));
  }

  return { tramiteId: row.id, esNuevo: !existente, soatId: row.soatId };
}

/**
 * Resuelve el SOAT del trámite. Aquí vive RN-01: el registro se busca por VIN, no por
 * trámite. Si ya existe en `en_adquisicion` o `pagado`, el trámite nuevo se cuelga del
 * existente y el VIN NO vuelve a la cola, sin importar cuántas veces se anule/recree
 * (CA-02/CA-03). Las compañías que autogestionan SOAT no generan registro (RN-02): la
 * exención se representa con la ausencia del registro, no con un estado.
 */
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
    // CA-02: el intento bloqueado queda registrado con el motivo. Sin esto la regla se
    // cumple pero nadie puede demostrar que se cumplió.
    if (soatBloqueaReencolado(existente.estado as EstadoSoat)) {
      r.soatBloqueadosPorVin += 1;
      await auditSistema(tx, {
        action: 'update',
        resource: 'flito_soat',
        resourceId: existente.id,
        detail: `Reencolado bloqueado (RN-01): el VIN ${tf.vin} ya tiene SOAT en "${existente.estado}". Trámite ${tf.idFlit}.`,
      });
    }
    return;
  }

  const proveedor = await resolverProveedor(compania.id, organismoCodigo);

  const [soat] = await tx.insert(flitoSoat).values({
    vin: tf.vin,
    vehiculoId,
    estado: EstadoSoat.PENDIENTE,
    companiaId: compania.id,
    organismoCodigo,
    proveedorSoatId: proveedor?.id ?? null,
    proveedorSobrescrito: false,
  }).returning();

  await tx.update(flitoTramites).set({ soatId: soat.id, updatedAt: new Date() }).where(eq(flitoTramites.id, tramiteId));
  r.soatCreados += 1;

  await auditSistema(tx, {
    action: 'create',
    resource: 'flito_soat',
    resourceId: soat.id,
    detail: `SOAT creado para VIN ${tf.vin} (trámite ${tf.idFlit}). Proveedor: ${proveedor?.nombre ?? 'sin asignar'}.`,
  });

  if (!proveedor) log.warn({ vin: tf.vin }, 'SOAT quedó sin proveedor: no hay regla que aplique');
}

/**
 * Resuelve el impuesto del trámite. Aquí vive RN-01 de Impuestos: la modalidad del
 * organismo decide, y `sin_clasificar` no es un default sino una retención. Nunca se asume
 * modalidad — asumir "autogestionado" dejaría pasar trámites sin impuesto por la compuerta,
 * el peor de los dos errores (§6.1).
 */
async function resolverImpuesto(
  tx: Tx, tf: TramiteFlit, tramiteId: string, compania: CompaniaRow, organismoCodigo: string, r: ResultadoSync,
): Promise<void> {
  const [existente] = await tx.select().from(flitoImpuestos).where(eq(flitoImpuestos.tramiteId, tramiteId)).limit(1);

  // El impuesto ya existe: su estado es del módulo, no de la sincronización. Recalcularlo
  // aquí pisaría el trabajo del gestor en cada ciclo. Solo se completa el valor liquidado.
  if (existente) {
    if (existente.valorLiquidado === null && tf.valorImpuestoLiquidado !== null) {
      await tx.update(flitoImpuestos).set({ valorLiquidado: numOrNull(tf.valorImpuestoLiquidado), updatedAt: new Date() })
        .where(eq(flitoImpuestos.id, existente.id));
    }
    return;
  }

  const modalidad = await modalidadVigente(organismoCodigo);
  const estado = decidirEstadoImpuesto(compania.impuestosAutogestionable, modalidad);

  const [impuesto] = await tx.insert(flitoImpuestos).values({
    tramiteId,
    estado,
    organismoCodigo,
    companiaId: compania.id,
    modalidadAplicada: modalidad,
    valorLiquidado: numOrNull(tf.valorImpuestoLiquidado),
  }).returning();

  if (estado === EstadoImpuesto.RETENIDO) r.impuestosRetenidos += 1;
  else if (estado === EstadoImpuesto.NO_APLICA) r.impuestosNoAplica += 1;
  else r.impuestosCreados += 1;

  await auditSistema(tx, {
    action: 'create',
    resource: 'flito_impuesto',
    resourceId: impuesto.id,
    detail: estado === EstadoImpuesto.RETENIDO
      ? `Impuesto RETENIDO: el organismo ${organismoCodigo} no tiene modalidad clasificada (trámite ${tf.idFlit}). No resuelve la compuerta hasta que Operaciones lo clasifique.`
      : `Impuesto creado en "${estado}" (trámite ${tf.idFlit}, modalidad ${modalidad}).`,
  });
}

/**
 * Actualiza los trámites que FLITO cree Asignado pero que ya no vienen en el lote de FLIT
 * (los anularon, rechazaron o movieron por otra vía). Sin esto un trámite que SALE de
 * asignado se congela como asignado para siempre y se podría entregar algo que FLIT ya anuló.
 * Reconciliar el estado del trámite NO toca el SOAT ni el impuesto (RN-01).
 */
async function reconciliarSalidos(flit: FlitPort, tramitesEnFlit: TramiteFlit[]): Promise<number> {
  const idsEnFlit = new Set(tramitesEnFlit.map((t) => t.idFlit));

  const locales = await db.select({ id: flitoTramites.id, idFlit: flitoTramites.idFlit })
    .from(flitoTramites).where(eq(flitoTramites.estado, EstadoTramiteFlito.ASIGNADO));

  const sospechosos = locales.filter((l) => !idsEnFlit.has(l.idFlit));
  if (sospechosos.length === 0) return 0;

  let reconciliados = 0;
  for (const local of sospechosos) {
    try {
      const enFlit = await flit.obtenerTramite(local.idFlit);
      if (!enFlit) {
        // Desapareció de FLIT: no se inventa un estado, se avisa y se deja señalado.
        log.warn({ idFlit: local.idFlit }, 'FLITO lo tiene Asignado pero FLIT no lo devuelve');
        await auditSistema(db, {
          action: 'update', resource: 'flito_tramite', resourceId: local.id,
          detail: 'FLITO lo tiene Asignado, pero FLIT no lo devuelve. Requiere revisión.',
        });
        continue;
      }

      const estadoReal = estadoDesdeProcessStatus(enFlit.processStatus);
      if (estadoReal === EstadoTramiteFlito.ASIGNADO) continue;

      await db.update(flitoTramites)
        .set({ estado: estadoReal, processStatus: enFlit.processStatus, sincronizadoEn: new Date(), updatedAt: new Date() })
        .where(eq(flitoTramites.id, local.id));

      await auditSistema(db, {
        action: 'update', resource: 'flito_tramite', resourceId: local.id,
        detail: `Estado reconciliado: asignado → ${estadoReal}. Sale de la compuerta de entrega.`,
      });

      reconciliados += 1;
      log.info({ idFlit: local.idFlit, estadoReal }, 'trámite reconciliado');
    } catch (error) {
      log.error({ idFlit: local.idFlit, err: (error as Error).message }, 'no se pudo reconciliar');
    }
  }
  return reconciliados;
}
