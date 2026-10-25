// FLITO — sincronización de trámites desde FLIT (real, solo lectura). Ver docs/integracion/integracionFlit.md.
//
// El reporte de FLIT es la FUENTE DE VERDAD y trae TODOS los trámites en cualquier estado. Cada uno se
// UPSERTA por id_flit (insertar si no existe, actualizar si ya existe: estado y fecha de aprobación
// cambian). Nunca se marca "salido" por ausencia (la consulta es por rango de fechas). SOAT e impuestos
// solo se resuelven para trámites 'Asignado' con compañía y secretaría ya emparejadas. Cada diferencia
// detectada deja historial (origen 'api'). Idempotente; cada trámite en su propia transacción.
//
// HU #13091: un trámite con `fuente='flit2'` (lo trajo FLIT 2) NO lo toca este sync, ni el trámite
// ni su vehículo: se cuenta en `tramitesOmitidosOtraFuente`. `escribirTramite`, `upsertVehiculo` y
// `setVehiculoDesdeFlit` se exportan para que la lectura de FLIT 2 herede historial y audit sin copiarlos.
// HU #13093: también `arrancarSoatEImpuesto`, `reemplazarCompradores` y `registrarDiferencias`, por lo mismo.
//
// Bug #13585: un trámite ANULADO (FLIT 1 «Anulado»; FLIT 2 `anulado`/`revocado`) no modifica el vehículo
// que ya existe con su VIN: `upsertVehiculo(…, { soloAlta: true })` devuelve su id sin UPDATE. Un VIN
// anulado y recreado convive con el trámite vigente, y el anulado (sin placa, con otro titular) pisaba
// los datos del vigente según el orden del reporte. Si el VIN no existe, el alta se hace igual.
//
// HU #13626: cada trámite creado o cambiado deja UNA entrada en la Bitácora (`audit_logs`,
// `flito_tramite`) desde `bitacora-sync.ts`, la misma función para FLIT 1 y FLIT 2. Reemplaza el audit
// «Estado FLIT: …» de `escribirTramite`; el historial campo por campo no cambia.
// HU #13627: un trámite que falla deja su entrada «falló» (RN-B5…B8 de `bitacora-sync.ts`) y el resto sigue.
//
// HU #13629 (lectura automática de FLIT 1, diseño §D5/§D6):
//   - `sincronizar` cuenta los trámites que fallaron (`tramitesFallidos`, tipo local `ResultadoCorrida`):
//     la corrida sigue siendo «buena», pero el estado marca `tramites_con_fallo`.
//   - FLIT 1 escribe con `soloSiCambia`: vehículo, trámite y compradores idénticos no se reescriben (no
//     mueven `updated_at` ni dejan historial). El vehículo se decide DESPUÉS de `soloAlta` (Bug #13585).
//     Consecuencia: `flito_tramites.sincronizado_en` pasa a ser «última vez que cambió». FLIT 2 no cambia.
//
// HU #13946 (FLIT 1 y FLIT 2, predicado `companiaRetiene`) — RN-RET-1: un trámite NUEVO cuya compañía cruzada existe y está inactiva (`clients.active = false`) se
// guarda con `retenido = true` y NO arranca SOAT/impuesto. RN-RET-2: `retenido` solo se escribe en el alta; un
// update de FLIT no lo toca (un retenido sigue retenido aunque llegue con la compañía ya activa: solo la activación
// libera, en `liberar-retenidos.ts`). RN-RET-3: con la compañía inactiva tampoco arranca SOAT/impuesto un trámite
// que ya existía sin retener (no nacen procesos para un cliente inactivo); el siguiente sync tras activarlo lo arranca.

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
import { mapearCompradores, type CompradorMapeado } from './mapeo-compradores.js';
import {
  diferenciasCompradores, diferenciasTramite, registrarBitacoraSync, registrarFalloBitacoraSync, tipoDeError, vistaHistorial,
  vistaTramite, type Diferencia,
} from './bitacora-sync.js';
import type { FlitPort, RangoSync, ResultadoSync, TramiteFlit } from './flit.port.js';
import { compradoresIguales, parcheVehiculo, tramiteCambia } from './solo-si-cambia.js';

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

/**
 * HU #13946 (RN-RET-1/3): ¿la compañía cruzada retiene? Sí si existe y está inactiva. Predicado ÚNICO de FLIT 1 y
 * FLIT 2: un trámite nuevo nace `retenido` y, mientras siga inactiva, ningún trámite suyo arranca SOAT/impuesto.
 */
export const companiaRetiene = (compania: Pick<CompaniaRow, 'active'> | null): boolean =>
  compania !== null && compania.active === false;
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
export async function resolverOrganismoDeFlit(tf: Pick<TramiteFlit, 'organismoCodigo' | 'ciudad' | 'transitoNombre'>) {
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
    organismosSinEmparejar: 0, tramitesOmitidosOtraFuente: 0, ejecutadoEn: new Date().toISOString(),
  };
}

/** Resultado de una corrida de FLIT 1: el de siempre + cuántos trámites fallaron (HU #13629, D5). */
export type ResultadoCorrida = ResultadoSync & { tramitesFallidos: number };

export async function sincronizar(rango: RangoSync, flit: FlitPort = getFlitAdapter()): Promise<ResultadoCorrida> {
  const inicio = Date.now();
  const tramites = await flit.obtenerTramites(rango);
  const r: ResultadoCorrida = { ...nuevoResultado(), tramitesFallidos: 0 };
  r.tramitesLeidos = tramites.length;

  for (const tf of tramites) {
    try {
      await db.transaction(async (tx) => { await sincronizarUno(tx, tf, r); });
    } catch (error) {
      // HU #13627: el tipo del error, nunca su mensaje (puede llevar PII); y la entrada de fallo en la
      // Bitácora, con `db` porque la transacción del trámite ya se revirtió. No lanza: la corrida sigue.
      r.tramitesFallidos += 1;
      log.error({ idFlit: tf.idFlit, err: tipoDeError(error) }, 'no se pudo sincronizar el trámite');
      await registrarFalloBitacoraSync(db, { fuente: 'FLIT 1', radicado: tf.idFlit, error });
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
  // HU #13091 (AC4): un trámite de FLIT 2 con el mismo radicado no es de este sync. Va antes de
  // `upsertVehiculo` para que FLIT 1 tampoco pise el vehículo de ese trámite.
  const [previo] = await tx.select({ fuente: flitoTramites.fuente }).from(flitoTramites)
    .where(eq(flitoTramites.idFlit, tf.idFlit)).limit(1);
  if (previo?.fuente === 'flit2') { r.tramitesOmitidosOtraFuente += 1; return; }

  // Match compañía por NIT y secretaría por nombre (o código, si el adaptador ya lo trae). Ambos
  // pueden faltar: el trámite se guarda igual, pero sin SOAT/impuesto hasta emparejarlos.
  const compania = tf.companiaNit ? await companiaPorNit(tf.companiaNit) : null;
  if (tf.companiaNit && !compania) r.companiasFaltantes += 1;

  const organismo = await resolverOrganismoDeFlit(tf);
  if ((tf.organismoCodigo || tf.ciudad || tf.transitoNombre) && !organismo) r.organismosSinEmparejar += 1;

  // Bug #13585: un anulado no modifica el vehículo (solo lo da de alta si no existe).
  const anulado = estadoEnumDesdeFlit(tf.estadoFlit) === EstadoTramiteFlito.ANULADO;
  // HU #13629: FLIT 1 solo escribe lo que cambió (`soloSiCambia`), siempre después de `soloAlta`.
  const vehiculoId = await upsertVehiculo(tx, tf, compania?.id ?? null, { soloAlta: anulado, soloSiCambia: true });
  const companiaInactiva = companiaRetiene(compania);
  const { tramiteId, esNuevo, huboCambios, soatId, retenido } = await upsertTramite(
    tx, tf, vehiculoId, compania?.id ?? null, organismo?.codigo ?? null, companiaInactiva,
  );

  // Nuevo / actualizado (llegó con diferencias, deja rastro) / sin cambios (idéntico, sin rastro).
  if (esNuevo) r.tramitesNuevos += 1;
  else if (huboCambios) r.tramitesActualizados += 1;
  else r.tramitesSinCambios += 1;

  // SOAT/impuestos requieren compañía y organismo emparejados y estado Asignado; nunca para un retenido ni
  // para una compañía inactiva (HU #13946, RN-RET-1/3).
  if (esAsignado(tf.estadoFlit) && compania && organismo && !retenido && !companiaInactiva) {
    await arrancarSoatEImpuesto(tx, tf, { tramiteId, soatId, vehiculoId, compania, organismoCodigo: organismo.codigo }, r);
  }

  // Logística: los trámites aprobados son la fuente de la consola (se listan directo desde
  // flito_tramites); la LT NO nace aquí, sino del escaneo del PDF417 por el mensajero en campo.
}

/** Lo que el sync escribe en `vehicles`. FLIT 1 pasa su `TramiteFlit` completo; FLIT 2 arma el suyo. */
export type VehiculoFlit = Pick<TramiteFlit,
  'vin' | 'placa' | 'marca' | 'linea' | 'cilindraje' | 'carroceria' | 'tipoServicio' | 'numMotor' | 'numSerie' | 'compradores'>;

/**
 * Titular que se guarda en el vehículo: el comprador principal (el primero que trae FLIT, `cedulanit`
 * en el reporte crudo).
 *
 * El dato ya se guardaba en `flito_compradores` desde el principio, pero NO en el vehículo, y hay
 * módulos que preguntan por el propietario al vehículo y no al trámite: la certificación contra el
 * RUNT (HU #11165) y el refresco de SOAT. Sin esto, esos módulos ven un propietario vacío en
 * prácticamente toda la flota y se bloquean solos.
 */
function titularDe(tf: VehiculoFlit): { nombre: string | null; documento: string | null } {
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
 * `plate` sigue la misma política (Bug #13585). Antes era la excepción con la premisa de que «FLIT
 * siempre la trae», y es falsa: un trámite anulado y recreado sobre el mismo VIN llega anulado y SIN
 * placa, y si el reporte lo traía después del vigente, `vehicles.plate` quedaba en NULL y la bandeja
 * perdía la placa. Además, un anulado ya ni llega aquí con un VIN existente (`soloAlta` de
 * `upsertVehiculo`); el spread protege igual contra cualquier otro reporte sin placa.
 *
 * `updatedAt` lo pone `upsertVehiculo`, no esta función, para que el valor sea comparable en test.
 *
 * El retorno se tipa contra el esquema (`vehicles.$inferInsert`) y NO como `Record<string, unknown>`:
 * al extraer el objeto del `.set()` se perdía la comprobación de nombres de columna que drizzle hacía
 * cuando iba inline, y un `cilindaje:` mal escrito habría compilado y no habría escrito nada.
 */
export function setVehiculoDesdeFlit(tf: VehiculoFlit): Partial<typeof vehicles.$inferInsert> {
  const titular = titularDe(tf);
  return {
    ...(tf.placa ? { plate: tf.placa } : {}),
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
    // Bug #12643: motor y serie, misma política. Un reporte sin ellos tampoco borra lo que ya puso
    // el RUNT (HU #12401) en estas dos columnas; con valor, FLIT es la fuente por defecto.
    ...(tf.numMotor ? { numMotor: tf.numMotor } : {}),
    ...(tf.numSerie ? { numSerie: tf.numSerie } : {}),
  };
}

/** Las 10 columnas que puede escribir `setVehiculoDesdeFlit`: lo que `soloSiCambia` compara. */
const COLUMNAS_VEHICULO_FLIT = {
  plate: vehicles.plate, brand: vehicles.brand, model: vehicles.model,
  ownerName: vehicles.ownerName, ownerDocument: vehicles.ownerDocument,
  cilindraje: vehicles.cilindraje, carroceria: vehicles.carroceria, tipoServicio: vehicles.tipoServicio,
  numMotor: vehicles.numMotor, numSerie: vehicles.numSerie,
};

/**
 * Alta o actualización del vehículo del trámite, por VIN.
 *
 * **Es el único punto del sync que corre para TODOS los trámites en TODAS las corridas**: se llama
 * desde `sincronizarUno` sin guarda previa, antes de que el estado, la compañía y el organismo
 * decidan nada. Por eso es aquí donde aterrizan el cilindraje, la carrocería y el tipo de servicio de
 * FLIT (HU #11906) —y, por la misma razón, el número de motor y de serie (Bug #12643), que comparten
 * columna con lo que escribe el RUNT— y no en `flito_soat`: `resolverSoat()` sale sin actualizar campos cuando el SOAT
 * ya existe, así que un SOAT sincronizado antes de esa HU no se completaría nunca. Guardarlo aquí es
 * lo que hace que el AC3 (el próximo sync completa el histórico) se cumpla solo, sin backfill.
 *
 * Las dos ramas escriben con reglas DISTINTAS y a propósito: el UPDATE delega en
 * `setVehiculoDesdeFlit` (spreads condicionales: un vacío no borra), y el INSERT asigna los cinco tal
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
 *
 * `soloAlta` (Bug #13585): lo pasan FLIT 1 y FLIT 2 cuando el trámite está ANULADO. Con el VIN ya
 * existente devuelve su id SIN UPDATE: el vehículo es del trámite vigente que comparte VIN, no del
 * anulado. Sin vehículo previo, el alta se hace igual, porque el trámite necesita su `vehiculo_id`.
 *
 * `soloSiCambia` (HU #13629, solo FLIT 1): tras `soloAlta` (que va primero y no lee más), se leen las
 * columnas que escribe `setVehiculoDesdeFlit` y se actualizan SOLO las que difieren; sin diferencias, no
 * hay UPDATE ni se mueve `updated_at`.
 */
export async function upsertVehiculo(
  tx: Tx, tf: VehiculoFlit, companiaId: number | null, opciones: { soloAlta?: boolean; soloSiCambia?: boolean } = {},
): Promise<number> {
  const [existente] = await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, tf.vin)).limit(1);
  const titular = titularDe(tf);
  if (existente) {
    if (opciones.soloAlta) return existente.id;
    const set = setVehiculoDesdeFlit(tf);
    if (opciones.soloSiCambia) {
      const [guardado] = await tx.select(COLUMNAS_VEHICULO_FLIT).from(vehicles).where(eq(vehicles.id, existente.id)).limit(1);
      const parche = guardado ? parcheVehiculo(guardado, set) : set;
      if (Object.keys(parche).length === 0) return existente.id;
      await tx.update(vehicles).set({ ...parche, updatedAt: new Date() }).where(eq(vehicles.id, existente.id));
      return existente.id;
    }
    await tx.update(vehicles).set({ ...set, updatedAt: new Date() }).where(eq(vehicles.id, existente.id));
    return existente.id;
  }
  const [creado] = await tx.insert(vehicles)
    .values({
      vin: tf.vin, plate: tf.placa, brand: tf.marca ?? null, model: tf.linea ?? null, clientId: companiaId,
      ownerName: titular.nombre, ownerDocument: titular.documento,
      // En el alta sí van los cinco tal cual: no hay nada previo que preservar, y `null` es la forma
      // correcta de decir «FLIT no lo trajo» en una fila nueva.
      cilindraje: tf.cilindraje, carroceria: tf.carroceria, tipoServicio: tf.tipoServicio,
      numMotor: tf.numMotor, numSerie: tf.numSerie,
    })
    .returning({ id: vehicles.id });
  return creado.id;
}

/**
 * Escribe los compradores de un trámite (FLIT 1 los reemplaza en bloque; FLIT 2 también, HU #13093).
 * Borra los que había y pone los nuevos: quien llama decide si hay que reemplazar.
 */
export async function reemplazarCompradores(tx: Tx, tramiteId: string, compradores: CompradorMapeado[]): Promise<void> {
  await tx.delete(flitoCompradores).where(eq(flitoCompradores.tramiteId, tramiteId));
  if (compradores.length > 0) {
    await tx.insert(flitoCompradores).values(compradores.map((c) => ({
      tramiteId, nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento,
      correo: c.correo, celular: c.celular, direccion: c.direccion, orden: c.orden,
      porcentajeParticipacion: c.porcentajeParticipacion === null ? null : String(c.porcentajeParticipacion),
    })));
  }
}

/** Compradores guardados de un trámite, para compararlos con los de la fuente (FLIT 1 y FLIT 2). */
export async function leerCompradores(tx: Tx, tramiteId: string): Promise<{
  orden: number; numeroDocumento: string; nombreCompleto: string; correo: string | null; celular: string | null;
  direccion: string | null; porcentajeParticipacion: string | null;
}[]> {
  return tx.select({
    orden: flitoCompradores.orden, numeroDocumento: flitoCompradores.numeroDocumento,
    nombreCompleto: flitoCompradores.nombreCompleto, correo: flitoCompradores.correo, celular: flitoCompradores.celular,
    direccion: flitoCompradores.direccion, porcentajeParticipacion: flitoCompradores.porcentajeParticipacion,
  }).from(flitoCompradores).where(eq(flitoCompradores.tramiteId, tramiteId));
}

// Diferencias que quedan en el historial (auditoría campo por campo, origen 'api').
export async function registrarDiferencias(tx: Tx, tramiteId: string, previo: Record<string, string | null>, nuevo: Record<string, string | null>): Promise<string[]> {
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

/** Valores de `flito_tramites` que arma cada fuente (FLIT 1 o FLIT 2) antes de escribir. */
export type ValorTramite = Omit<typeof flitoTramites.$inferInsert, 'id' | 'createdAt' | 'idFlit'>;

/**
 * Escritura del trámite común a FLIT 1 y FLIT 2: historial de diferencias (origen 'api') y UPDATE o
 * INSERT. Las columnas del historial se leen de `valores`, así que cada fuente hereda el mismo rastro
 * sin copiarlo. El INSERT es `{ idFlit, ...valores }`: FLIT 1 no manda `fuente`/`idFlit2`/`syncVersion`
 * y la fila nace con el default `'flit'`. Devuelve las diferencias para la Bitácora (HU #13626), que
 * escribe quien llama tras comparar también los compradores; aquí ya no se audita el «Estado FLIT».
 *
 * `soloSiCambia` (HU #13629, solo FLIT 1): si ninguna columna de `valores` difiere de lo guardado (salvo
 * `sincronizadoEn`), no hay UPDATE, ni historial, ni diferencias para la Bitácora.
 */
export async function escribirTramite(
  tx: Tx, existente: typeof flitoTramites.$inferSelect | null, idFlit: string, valores: ValorTramite,
  opciones: { soloSiCambia?: boolean } = {},
): Promise<{ row: typeof flitoTramites.$inferSelect; esNuevo: boolean; huboCambios: boolean; diferencias: Diferencia[] }> {
  if (!existente) {
    const [row] = await tx.insert(flitoTramites).values({ idFlit, ...valores }).returning();
    return { row, esNuevo: true, huboCambios: false, diferencias: [] };
  }
  if (opciones.soloSiCambia && !tramiteCambia(existente, valores)) {
    return { row: existente, esNuevo: false, huboCambios: false, diferencias: [] };
  }
  const antes = vistaTramite(existente);
  const despues = vistaTramite(valores);
  // Historial de campos observables antes de pisar (origen 'api'): las 7 claves de siempre (AC8).
  const cambios = await registrarDiferencias(tx, existente.id, vistaHistorial(antes), vistaHistorial(despues));
  const [row] = await tx.update(flitoTramites).set({ ...valores, updatedAt: new Date() }).where(eq(flitoTramites.id, existente.id)).returning();
  return { row, esNuevo: false, huboCambios: cambios.length > 0, diferencias: diferenciasTramite(antes, despues) };
}

async function upsertTramite(
  tx: Tx, tf: TramiteFlit, vehiculoId: number, companiaId: number | null, organismoCodigo: string | null,
  retenerSiEsNuevo: boolean,
): Promise<{ tramiteId: string; esNuevo: boolean; huboCambios: boolean; soatId: string | null; retenido: boolean }> {
  const [existente] = await tx.select().from(flitoTramites).where(eq(flitoTramites.idFlit, tf.idFlit)).limit(1);

  const valores: ValorTramite = {
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
    fechaAprobacion: tf.fechaAprobacion ? new Date(tf.fechaAprobacion) : null,
    fechaCreacionFlit: fechaValida(tf.fechaCreacionFlit),
    flitRaw: tf.raw,
    processStatus: tf.processStatus ?? null,
    plateComplete: tf.placa,
    sincronizadoEn: new Date(),
    // HU #13946 (RN-RET-2): solo en el alta. En un update la clave no va, así que ni se pisa ni cuenta como cambio.
    ...(existente ? {} : { retenido: retenerSiEsNuevo }),
  };

  const { row, esNuevo, huboCambios, diferencias } = await escribirTramite(tx, existente ?? null, tf.idFlit, valores, { soloSiCambia: true });

  // Compradores se reemplazan en bloque: FLIT es la fuente de verdad. Los guardados se leen antes, en
  // la misma tx, para que la Bitácora diga qué cambió (HU #13626). HU #13629: si son exactamente los
  // mismos, no se borran ni se insertan.
  const nuevos = mapearCompradores(tf);
  const guardados = esNuevo ? [] : await leerCompradores(tx, row.id);
  if (esNuevo || !compradoresIguales(guardados, nuevos)) await reemplazarCompradores(tx, row.id, nuevos);
  await registrarBitacoraSync(tx, {
    fuente: 'FLIT 1', radicado: tf.idFlit, tramiteId: row.id, esNuevo,
    diferencias: [...diferencias, ...diferenciasCompradores(guardados, nuevos)],
  });

  return { tramiteId: row.id, esNuevo, huboCambios, soatId: row.soatId, retenido: row.retenido };
}

/** Lo que el arranque de SOAT e impuesto lee del trámite de origen (FLIT 1 o FLIT 2). */
export type TramiteArranque = Pick<TramiteFlit, 'vin' | 'idFlit' | 'valorImpuestoLiquidado'>;
/** Contadores que mueve el arranque. FLIT 1 pasa su `ResultadoSync`; FLIT 2, los suyos. */
export type ContadoresArranque = Pick<ResultadoSync,
  'soatCreados' | 'soatBloqueadosPorVin' | 'impuestosCreados' | 'impuestosBloqueadosPorVehiculo'>;
export interface DestinoArranque {
  tramiteId: string; soatId: string | null; vehiculoId: number; compania: CompaniaRow; organismoCodigo: string;
}

/**
 * Arranque de SOAT e impuesto de un trámite ya guardado. Quien llama comprueba antes las condiciones
 * (estado Asignado, compañía y organismo emparejados; FLIT 2 además exige comprador, HU #13093): esta
 * función es la MISMA para FLIT 1 y FLIT 2, así que las reglas de las dos fuentes no se desalinean.
 */
export async function arrancarSoatEImpuesto(
  tx: Tx, tf: TramiteArranque, d: DestinoArranque, r: ContadoresArranque,
): Promise<void> {
  await resolverSoat(tx, tf, d.tramiteId, d.soatId, d.vehiculoId, d.compania, d.organismoCodigo, r);
  await resolverImpuesto(tx, tf, d.tramiteId, d.vehiculoId, d.compania, d.organismoCodigo, r);
}

/** Resuelve el SOAT (RN-01: por VIN, exento si la compañía autogestiona). Igual que el mock. */
async function resolverSoat(
  tx: Tx, tf: TramiteArranque, tramiteId: string, soatIdActual: string | null,
  vehiculoId: number, compania: CompaniaRow, organismoCodigo: string, r: ContadoresArranque,
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
async function resolverImpuesto(
  tx: Tx, tf: TramiteArranque, tramiteId: string, vehiculoId: number, compania: CompaniaRow, organismoCodigo: string,
  r: ContadoresArranque,
): Promise<void> {
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
