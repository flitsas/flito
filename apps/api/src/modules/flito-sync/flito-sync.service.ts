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
import { registrarCambio } from '../../shared/historial/estado-historial.js';
import { loggerFor } from '../../shared/logger.js';
import {
  EstadoImpuesto, EstadoSoat, EstadoTramiteFlito, flitoGestionaImpuesto, resolverCodigoOrganismoFlit,
  soatBloqueaReencolado,
} from '@operaciones/shared-types';
import {
  companiaPorNit, modalidadVigente, organismoPorCodigo,
  type CompaniaRow,
} from '../flito-parametrizacion/flito-parametrizacion.service.js';
import {
  anioGravableEnCurso, impuestoBloqueantePorVehiculo,
} from '../flito-impuestos/impuesto-por-vehiculo.js';
import { getFlitAdapter } from './flit.adapter.js';
import { mapearCompradores } from './mapeo-compradores.js';
import type { FlitPort, RangoSync, ResultadoSync, TramiteFlit } from './flit.port.js';

const log = loggerFor('flito-sync');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

const ACTOR_SISTEMA = 'sistema';
const numOrNull = (v: number | null): string | null => (v === null ? null : String(v));

/**
 * Fecha de un tercero → Date, o null si no parsea. FLIT manda texto libre y un `Invalid Date` no
 * falla al construirse: revienta después, al insertar, tumbando la sincronización entera por una
 * sola fila mal formada.
 */
export function fechaValida(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const esAsignado = (estadoFlit: string): boolean => estadoFlit.trim().toLowerCase() === 'asignado';
/** Logística arranca cuando el trámite está aprobado y el organismo emitió los documentos (§8). */
export const esAprobado = (estadoFlit: string): boolean => estadoFlit.trim().toLowerCase() === 'aprobado';

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

/**
 * Empareja el trámite con un organismo configurado en FLITO, por orden de fiabilidad:
 *
 *   1. `codigoSecretaria` del reporte (campo nuevo, 2026-07). Es el DIVIPOLA autoritativo.
 *   2. La ciudad del trámite contra la ciudad del catálogo nacional.
 *   3. El nombre de la secretaría contra el nombre del catálogo.
 *
 * Los pasos 2 y 3 son RESPALDO del 1 y no alternativas: se intentan también cuando el código llegó
 * pero no corresponde a ningún organismo configurado. Antes, un código presente cortaba la búsqueda
 * y el trámite quedaba "sin emparejar" aunque su ciudad sí fuera reconocible.
 *
 * No se auto-provisiona la configuración del organismo: si el código es real pero nadie lo ha
 * configurado en FLITO, el trámite queda sin emparejar a propósito y se enlaza solo en el siguiente
 * sync una vez alguien lo configure. Auto-crearlo escondería el hecho de que falta parametrizarlo.
 */
export async function resolverOrganismoDeFlit(tf: TramiteFlit) {
  const candidatos = [
    tf.organismoCodigo,
    resolverCodigoOrganismoFlit({ ciudad: tf.ciudad }),
    resolverCodigoOrganismoFlit({ nombre: tf.transitoNombre }),
  ];
  for (const codigo of candidatos) {
    if (!codigo) continue;
    const organismo = await organismoPorCodigo(codigo.trim());
    if (organismo) return organismo;
  }
  return null;
}

async function auditSistema(exec: DbOrTx, entry: { action: 'create' | 'update'; resource: string; resourceId: string; detail: string }): Promise<void> {
  await exec.insert(auditLogs).values({ userId: null, userEmail: ACTOR_SISTEMA, action: entry.action, resource: entry.resource, resourceId: entry.resourceId, detail: entry.detail });
}

// RN-01 Impuestos (`flitoGestionaImpuesto`) vive ahora en shared-types: la liquidación y el reporte
// de costos necesitan la misma respuesta y no pueden depender de si aquí se creó o no el registro.
// Se re-exporta porque este módulo era su sitio y hay quien la importa desde aquí.
export { flitoGestionaImpuesto };

function nuevoResultado(): ResultadoSync {
  return {
    tramitesLeidos: 0, tramitesNuevos: 0, tramitesActualizados: 0, tramitesSinCambios: 0, soatCreados: 0, soatBloqueadosPorVin: 0, impuestosBloqueadosPorVehiculo: 0,
    impuestosCreados: 0, companiasFaltantes: 0,
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

  const organismo = await resolverOrganismoDeFlit(tf);
  if ((tf.organismoCodigo || tf.ciudad || tf.transitoNombre) && !organismo) r.organismosSinEmparejar += 1;

  const vehiculoId = await upsertVehiculo(tx, tf, compania?.id ?? null);
  const { tramiteId, esNuevo, huboCambios, soatId } = await upsertTramite(tx, tf, vehiculoId, compania?.id ?? null, organismo?.codigo ?? null, r);

  // Nuevo / actualizado (llegó con diferencias, deja rastro) / sin cambios (idéntico, sin rastro).
  if (esNuevo) r.tramitesNuevos += 1;
  else if (huboCambios) r.tramitesActualizados += 1;
  else r.tramitesSinCambios += 1;

  // SOAT/impuestos requieren compañía y organismo emparejados y estado Asignado.
  if (esAsignado(tf.estadoFlit) && compania && organismo) {
    await resolverSoat(tx, tf, tramiteId, soatId, vehiculoId, compania, organismo.codigo, r);
    await resolverImpuesto(tx, tf, tramiteId, vehiculoId, compania, organismo.codigo, r);
  }

  // Logística: los trámites aprobados son la fuente de la consola (se listan directo desde
  // flito_tramites); la LT NO nace aquí, sino del escaneo del PDF417 por el mensajero en campo.
}

/**
 * Titular que se guarda en el vehículo: el comprador principal (el primero que trae FLIT, `cedulanit`
 * en el reporte crudo).
 *
 * El dato ya se guardaba en `flito_compradores` desde el principio, pero NO en el vehículo, y hay
 * módulos que preguntan por el propietario al vehículo y no al trámite: la certificación contra el
 * RUNT (HU #11165) y el refresco de SOAT. Sin esto, esos módulos ven un propietario vacío en
 * prácticamente toda la flota y se bloquean solos.
 */
function titularDe(tf: TramiteFlit): { nombre: string | null; documento: string | null } {
  const [principal] = tf.compradores;
  const documento = principal?.numeroDocumento?.trim() || null;
  return {
    nombre: principal?.nombreCompleto?.trim().slice(0, 200) || null,
    // `flito_compradores.numero_documento` admite 30 y `vehicles.owner_document` solo 20. Recortar un
    // documento lo convertiría en otro documento, así que uno más largo se descarta: consultar el RUNT
    // con un número mutilado es peor que consultarlo por VIN, que es a lo que se cae sin documento.
    documento: documento && documento.length <= 20 ? documento : null,
  };
}

/**
 * El `SET` del UPDATE de `upsertVehiculo()`, aparte para poder afirmarlo sin base de datos.
 *
 * **No es un helper de conveniencia: es la política de escritura del sync sobre `vehicles`.** Todo
 * campo que FLIT pueda dejar vacío se escribe SOLO si trae valor, y por eso son spreads
 * condicionales y no asignaciones. Una asignación directa convierte «FLIT no me lo mandó esta vez»
 * en un `SET columna = NULL`, es decir, en borrar el dato que ya teníamos.
 *
 * `plate` es la excepción y ya lo era: FLIT siempre la trae y es la clave por la que el resto del
 * sistema reconoce el vehículo.
 *
 * `updatedAt` lo pone `upsertVehiculo`, no esta función, para que el valor sea comparable en test.
 *
 * El retorno se tipa contra el esquema (`vehicles.$inferInsert`) y NO como `Record<string, unknown>`:
 * al extraer el objeto del `.set()` se perdía la comprobación de nombres de columna que drizzle hacía
 * cuando iba inline, y un `cilindaje:` mal escrito habría compilado y no habría escrito nada.
 */
export function setVehiculoDesdeFlit(tf: TramiteFlit): Partial<typeof vehicles.$inferInsert> {
  const titular = titularDe(tf);
  return {
    plate: tf.placa,
    ...(tf.marca ? { brand: tf.marca } : {}),
    ...(tf.linea ? { model: tf.linea } : {}),
    // El titular solo se escribe cuando FLIT lo trae: un reporte sin comprador no puede borrar el
    // propietario que ya conocíamos (p. ej. el que dejó el OCR de la tarjeta de propiedad).
    ...(titular.nombre ? { ownerName: titular.nombre } : {}),
    ...(titular.documento ? { ownerDocument: titular.documento } : {}),
    // Misma política que el propietario, y a propósito (HU #11906): un reporte con el campo vacío no
    // borra el cilindraje / la carrocería / el tipo de servicio que ya conocíamos. Dos reglas
    // opuestas en la misma función serían una trampa para el siguiente que la lea.
    ...(tf.cilindraje ? { cilindraje: tf.cilindraje } : {}),
    ...(tf.carroceria ? { carroceria: tf.carroceria } : {}),
    ...(tf.tipoServicio ? { tipoServicio: tf.tipoServicio } : {}),
  };
}

/**
 * Alta o actualización del vehículo del trámite, por VIN.
 *
 * **Es el único punto del sync que corre para TODOS los trámites en TODAS las corridas**: se llama
 * desde `sincronizarUno` sin guarda previa, antes de que el estado, la compañía y el organismo
 * decidan nada. Por eso es aquí donde aterrizan el cilindraje, la carrocería y el tipo de servicio de
 * FLIT (HU #11906) y no en `flito_soat`: `resolverSoat()` sale sin actualizar campos cuando el SOAT
 * ya existe, así que un SOAT sincronizado antes de esa HU no se completaría nunca. Guardarlo aquí es
 * lo que hace que el AC3 (el próximo sync completa el histórico) se cumpla solo, sin backfill.
 *
 * Las dos ramas escriben con reglas DISTINTAS y a propósito: el UPDATE delega en
 * `setVehiculoDesdeFlit` (spreads condicionales: un vacío no borra), y el INSERT asigna los tres tal
 * cual, porque en una fila nueva no hay nada previo que preservar y `null` es la forma correcta de
 * decir «FLIT no lo trajo».
 *
 * RIESGO ASUMIDO, escrito para que nadie lo descubra en producción: los campos que FLIT puede dejar
 * vacíos se escriben **solo cuando traen valor**. La consecuencia es que si FLIT *corrige* un dato a
 * vacío —un cilindraje que estaba mal y ahora no se sabe—, FLITO conserva el viejo indefinidamente y
 * no hay forma de distinguirlo de un dato vivo. Se acepta porque la alternativa (pisar siempre)
 * borra con cada reporte incompleto lo que ya sabíamos, que es exactamente lo que el bloque del
 * propietario existe para impedir. Y no queda rastro: `registrarDiferencias` solo lleva historial de
 * `flito_tramites`, no de `vehicles`; corregir un valor a vacío es hoy trabajo manual sobre la fila.
 */
async function upsertVehiculo(tx: Tx, tf: TramiteFlit, companiaId: number | null): Promise<number> {
  const [existente] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, tf.vin)).limit(1);
  const titular = titularDe(tf);
  if (existente) {
    await tx.update(vehicles).set({ ...setVehiculoDesdeFlit(tf), updatedAt: new Date() }).where(eq(vehicles.id, existente.id));
    return existente.id;
  }
  const [creado] = await tx.insert(vehicles)
    .values({
      vin: tf.vin, plate: tf.placa, brand: tf.marca ?? null, model: tf.linea ?? null, clientId: companiaId,
      ownerName: titular.nombre, ownerDocument: titular.documento,
      // En el alta sí van los tres tal cual: no hay nada previo que preservar, y `null` es la forma
      // correcta de decir «FLIT no lo trajo» en una fila nueva.
      cilindraje: tf.cilindraje, carroceria: tf.carroceria, tipoServicio: tf.tipoServicio,
    })
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
  const fechaCreacionFlit = fechaValida(tf.fechaCreacionFlit);

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
    fechaCreacionFlit,
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

  // El SOAT nace SIN proveedor (HU #10979). Antes lo pre-asignaba una regla de enrutamiento por
  // ámbito; esas reglas se retiraron porque el proveedor real se decide al enviar el SOAT al gestor,
  // que es cuando alguien mira la carga de cada uno. Una pre-asignación que nadie revisaba solo
  // servía para que el envío pareciera decidido cuando no lo estaba.
  const [soat] = await tx.insert(flitoSoat).values({
    vin: tf.vin, vehiculoId, estado: EstadoSoat.PENDIENTE, companiaId: compania.id,
    organismoCodigo, proveedorSoatId: null, proveedorSobrescrito: false,
  }).returning();
  await tx.update(flitoTramites).set({ soatId: soat.id, updatedAt: new Date() }).where(eq(flitoTramites.id, tramiteId));
  r.soatCreados += 1;
  await auditSistema(tx, { action: 'create', resource: 'flito_soat', resourceId: soat.id, detail: `SOAT creado para VIN ${tf.vin} (trámite ${tf.idFlit}). El proveedor se asigna al enviarlo al gestor.` });
  // Primer eslabón de la línea de tiempo. Sin él, el historial de un SOAT recién nacido empezaría
  // en su primer cambio y no se vería cuándo entró en la cola, que es la mitad de la pregunta.
  await registrarCambio(tx, {
    concepto: 'soat', registroId: soat.id,
    estadoAnterior: null, estadoNuevo: EstadoSoat.PENDIENTE,
    motivo: `Alta desde FLIT (trámite ${tf.idFlit}).`, origen: 'sistema',
  });
}

/**
 * Resuelve el impuesto. La modalidad decide (RN-01, sin default silencioso). La factura de venta ya
 * NO se carga a mano: viene de FLIT. Si el organismo requiere gestión y el trámite trae factura, el
 * impuesto arranca en 'pendiente' (listo para enviar); sin factura, en 'sin_factura'.
 */
async function resolverImpuesto(tx: Tx, tf: TramiteFlit, tramiteId: string, vehiculoId: number, compania: CompaniaRow, organismoCodigo: string, r: ResultadoSync): Promise<void> {
  const [existente] = await tx.select().from(flitoImpuestos).where(eq(flitoImpuestos.tramiteId, tramiteId)).limit(1);
  if (existente) {
    // El estado es del módulo, no del sync. Solo se completa el valor liquidado si llega.
    if (existente.valorLiquidado === null && tf.valorImpuestoLiquidado !== null) {
      await tx.update(flitoImpuestos).set({ valorLiquidado: numOrNull(tf.valorImpuestoLiquidado), updatedAt: new Date() }).where(eq(flitoImpuestos.id, existente.id));
    }
    return;
  }

  const modalidad = await modalidadVigente(organismoCodigo);
  // Autogestionado (compañía o organismo) → exento: no se crea registro (como el SOAT autogestionado).
  if (!flitoGestionaImpuesto(compania.impuestosAutogestionable, modalidad)) return;

  // El impuesto es del VEHÍCULO y del año, no del trámite. Si otro trámite del mismo vehículo ya lo
  // pidió o lo pagó este año, crear otro registro abriría la puerta a un segundo desembolso real por
  // el mismo concepto — que es justo lo que `resolverSoat` evita por VIN desde el principio.
  const anio = anioGravableEnCurso();
  const bloqueante = await impuestoBloqueantePorVehiculo(tx, vehiculoId, anio, tramiteId);
  if (bloqueante) {
    r.impuestosBloqueadosPorVehiculo += 1;
    await auditSistema(tx, {
      action: 'update', resource: 'flito_impuesto', resourceId: bloqueante.id,
      detail: `Alta bloqueada (impuesto por vehículo): el vehículo del trámite ${tf.idFlit} ya tiene impuesto en "${bloqueante.estado}" para ${anio} en el trámite ${bloqueante.tramiteId}.`,
    });
    return;
  }

  const [impuesto] = await tx.insert(flitoImpuestos).values({
    tramiteId, estado: EstadoImpuesto.PENDIENTE, organismoCodigo, companiaId: compania.id, modalidadAplicada: modalidad,
    valorLiquidado: numOrNull(tf.valorImpuestoLiquidado),
  }).returning();
  r.impuestosCreados += 1;

  await auditSistema(tx, {
    action: 'create', resource: 'flito_impuesto', resourceId: impuesto.id,
    detail: `Impuesto creado en "pendiente" (trámite ${tf.idFlit}, organismo ${organismoCodigo}).`,
  });
  await registrarCambio(tx, {
    concepto: 'impuesto', registroId: impuesto.id,
    estadoAnterior: null, estadoNuevo: EstadoImpuesto.PENDIENTE,
    motivo: `Alta desde FLIT (trámite ${tf.idFlit}, organismo ${organismoCodigo}).`, origen: 'sistema',
  });
}
