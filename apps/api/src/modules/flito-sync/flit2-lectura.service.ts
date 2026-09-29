// FLITO sync — lectura incremental de trámites de FLIT 2 (HU #13091, Feature #13059, Épica #12736).
// Diseño: `docs/diseno/hu-13091-lectura-incremental-flit2.md`. Contrato: `docs/integraciones/flit2-api.md` v3.1.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Posición de lectura: una fila (`flito_sync_flit2_lectura`, id=1). Sin cursor, la lectura va
//        con `since = since_arranque`; ese instante se fija UNA vez (`UPDATE … WHERE since_arranque
//        IS NULL`) ANTES de llamar, así un primer intento fallido reutiliza el mismo `since`. Con
//        cursor, se llama con cursor. Nunca los dos (AC1).
// RN-02  Página atómica: el fetch va fuera de toda transacción; aplicar sus ítems y avanzar el cursor
//        a `nextCursor` van en LA MISMA transacción. El cursor solo avanza si la página se guardó
//        (AC2). El UPDATE del cursor lleva guarda optimista (`cursor IS NOT DISTINCT FROM` el leído):
//        si otra corrida lo movió, la página se revierte con `lectura_concurrente` (409).
// RN-03  Identidad: el trámite se busca por `id_flit2`. Con versión guardada ≥ la recibida no se
//        escribe (AC3). Un radicado que ya existe con otra identidad (FLIT 1, u otro `id_flit2`) es
//        conflicto: se cuenta y no se toca (AC4).
// RN-04  Vehículo: un trámite NUEVO sin vehículo o sin VIN no se guarda («sin vehículo», AC5); uno
//        existente conserva su vehículo. Una placa que llega null no borra la conocida.
// RN-05  Tombstones (`eliminado: true`): se ignoran siempre y solo se cuentan (AC8).
// RN-06  Retroceso: un trámite EXISTENTE que llega en `borrador`, `preparado`, `preasignacion` o en un
//        estado desconocido actualiza `flit_estado`, pero NO cambia su estado FLITO: la logística, el
//        SOAT y los impuestos en marcha no retroceden. Solo un trámite NUEVO en esos estados nace con
//        estado FLITO null (AC6). `revocado` → estado FLITO `anulado`, `flit_estado = 'Revocado'` (AC7).
// RN-07  Esta HU no crea compradores, SOAT ni impuestos (#13093), ni lee la factura (#13095). `flit_raw`
//        guarda los compradores con lista blanca, sin PII (AC10). Los logs solo llevan `idFlit2`,
//        radicado, contadores, estado HTTP y código.
// RN-08  Cada ítem cae en UNA clase y los contadores cuadran:
//        leidos = nuevos + actualizados + sinCambios + conflictos + sinVehiculo + eliminadosIgnorados + invalidos.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Flit2LecturaResultado } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSyncFlit2Lectura, flitoTramites, vehicles } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { companiaPorNit } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import {
  escribirTramite, fechaValida, resolverOrganismoDeFlit, upsertVehiculo, type ValorTramite, type VehiculoFlit,
} from './flito-sync.service.js';
import { ESTADOS_SIN_ESTADO_FLITO, estadoDesdeFlit2, familiaATipoTramite, tipoPropiedadPorConteo } from './flit2-mapeo.js';
import { getFlit2SyncAdapter } from './flit2-sync.adapter.js';
import type { Flit2SyncPort, ItemFlit2, PosicionLectura } from './flit2-sync.port.js';
import { Flit2Error, Flit2LecturaConcurrenteError } from './flit2.errors.js';

const log = loggerFor('flito-sync-flit2');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FILA = 1;
const PAGE_SIZE = 500;
/** Tope por pulsación (5000 ítems con 500 por página). El definitivo es de la #13092. */
const MAX_PAGINAS = 10;

export interface OpcionesLectura {
  pageSize?: number;
  maxPaginas?: number;
  ahora?: () => Date;
}

type Contadores = Pick<Flit2LecturaResultado,
  'leidos' | 'nuevos' | 'actualizados' | 'sinCambios' | 'conflictos' | 'sinVehiculo' | 'eliminadosIgnorados'
  | 'invalidos' | 'companiasFaltantes' | 'organismosSinEmparejar'>;

const CLAVES_CONTADOR: (keyof Contadores)[] = [
  'leidos', 'nuevos', 'actualizados', 'sinCambios', 'conflictos', 'sinVehiculo', 'eliminadosIgnorados',
  'invalidos', 'companiasFaltantes', 'organismosSinEmparejar',
];

const contadoresEnCero = (): Contadores => ({
  leidos: 0, nuevos: 0, actualizados: 0, sinCambios: 0, conflictos: 0, sinVehiculo: 0, eliminadosIgnorados: 0,
  invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0,
});

/** Resultado parcial de una lectura que falló después de guardar alguna página. */
const parciales = new WeakMap<object, Flit2LecturaResultado>();
export function parcialDe(e: unknown): Flit2LecturaResultado | null {
  return e && typeof e === 'object' ? parciales.get(e) ?? null : null;
}

/** Texto que no cabe en su columna se descarta a null (truncar cambia el dato). */
const acotado = (v: string | null, max: number): string | null => (v && v.length <= max ? v : null);

/** Placa a escribir en el vehículo: la que llega o, si viene null, la que ya conocíamos (RN-04). */
async function placaConocida(tx: Tx, vin: string, placa: string | null): Promise<string | null> {
  if (placa) return placa;
  const [v] = await tx.select({ plate: vehicles.plate }).from(vehicles).where(eq(vehicles.vin, vin)).limit(1);
  return v?.plate ?? null;
}

/** Clasifica y aplica UN ítem dentro de la transacción de su página (RN-03…RN-06). */
async function aplicarItem(tx: Tx, it: ItemFlit2, r: Contadores, ahora: Date): Promise<void> {
  if (it.eliminado) { r.eliminadosIgnorados += 1; return; }

  const [porId] = await tx.select().from(flitoTramites).where(eq(flitoTramites.idFlit2, it.idFlit2)).limit(1);
  if (porId && porId.syncVersion !== null && it.syncVersion <= porId.syncVersion) { r.sinCambios += 1; return; }

  if (!porId) {
    const [porRadicado] = await tx.select({ id: flitoTramites.id }).from(flitoTramites)
      .where(eq(flitoTramites.idFlit, it.radicado)).limit(1);
    if (porRadicado) {
      r.conflictos += 1;
      log.warn({ idFlit2: it.idFlit2, radicado: it.radicado }, 'radicado de FLIT 2 que ya existe con otra identidad: no se toca');
      return;
    }
    if (!it.vehiculo) { r.sinVehiculo += 1; return; }
  }

  const compania = it.companiaNit ? await companiaPorNit(it.companiaNit) : null;
  if (it.companiaNit && !compania) r.companiasFaltantes += 1;
  const org = it.organismo;
  const organismo = org
    ? await resolverOrganismoDeFlit({ organismoCodigo: org.codigoSecretaria, ciudad: org.ciudad, transitoNombre: org.nombre })
    : null;
  if (org && (org.codigoSecretaria || org.ciudad || org.nombre) && !organismo) r.organismosSinEmparejar += 1;

  let vehiculoId: number;
  let plateComplete: string | null;
  if (it.vehiculo) {
    const placa = await placaConocida(tx, it.vehiculo.vin, it.vehiculo.placa);
    // Sin compradores: esta HU no pone propietario (los spreads conservan el que había, #13093).
    const vf: VehiculoFlit = { ...it.vehiculo, placa, compradores: [] };
    vehiculoId = await upsertVehiculo(tx, vf, compania?.id ?? null);
    plateComplete = placa ?? porId?.plateComplete ?? null;
  } else {
    // Solo llega aquí un trámite existente (el nuevo sin vehículo salió arriba): conserva el suyo.
    vehiculoId = porId!.vehiculoId;
    plateComplete = porId!.plateComplete;
  }

  const mapeo = estadoDesdeFlit2(it.estado);
  const retrocede = ESTADOS_SIN_ESTADO_FLITO.has(it.estado) || mapeo.desconocido;
  const valores: ValorTramite = {
    estado: porId && retrocede ? porId.estado : mapeo.estado,
    flitEstado: mapeo.flitEstado,
    tipoTramite: familiaATipoTramite(it.familia),
    ciudad: acotado(org?.ciudad ?? null, 120),
    tipoPropiedad: tipoPropiedadPorConteo(it.compradores.length) ?? porId?.tipoPropiedad ?? null,
    companiaId: compania?.id ?? null,
    companiaNit: acotado(it.companiaNit, 30),
    organismoCodigo: organismo?.codigo ?? null,
    transitoNombreFlit: acotado(org?.nombre ?? null, 200),
    vehiculoId,
    // Los escriben otras piezas (#13095 la factura; el impuesto su módulo): se conservan.
    valorImpuestoLiquidado: porId?.valorImpuestoLiquidado ?? null,
    facturaVentaFlitId: porId?.facturaVentaFlitId ?? null,
    fechaAprobacion: fechaValida(it.fechaAprobacion),
    fechaCreacionFlit: fechaValida(it.fechaCreacion),
    flitRaw: it.raw,
    processStatus: porId?.processStatus ?? null,
    plateComplete,
    sincronizadoEn: ahora,
    fuente: 'flit2',
    idFlit2: it.idFlit2,
    syncVersion: it.syncVersion,
  };

  const { esNuevo, huboCambios } = await escribirTramite(tx, porId ?? null, it.radicado, valores);
  if (esNuevo) r.nuevos += 1;
  else if (huboCambios) r.actualizados += 1;
  else r.sinCambios += 1;
}

/** Aplica los ítems de una página. Los desenlaces esperados se cuentan; solo un fallo de BD lanza. */
export async function aplicarPagina(tx: Tx, items: ItemFlit2[], r: Contadores, ahora: Date = new Date()): Promise<void> {
  for (const it of items) await aplicarItem(tx, it, r, ahora);
}

async function leerFila() {
  const [fila] = await db.select().from(flitoSyncFlit2Lectura).where(eq(flitoSyncFlit2Lectura.id, FILA)).limit(1);
  return fila ?? null;
}

async function anotar(set: Partial<typeof flitoSyncFlit2Lectura.$inferInsert>, ahora: Date): Promise<void> {
  await db.update(flitoSyncFlit2Lectura).set({ ...set, updatedAt: ahora }).where(eq(flitoSyncFlit2Lectura.id, FILA));
}

/**
 * Una corrida de lectura: páginas hasta `hasMore=false` o hasta `maxPaginas` (RN-01, RN-02).
 * Lanza `Flit2Error` (sin acceso, rechazado, bloqueado, respuesta inesperada, lectura concurrente…);
 * si ya había páginas guardadas, `parcialDe(error)` devuelve los totales de lo guardado.
 */
export async function leerIncremental(
  op: OpcionesLectura = {}, port: Flit2SyncPort = getFlit2SyncAdapter(),
): Promise<Flit2LecturaResultado> {
  const reloj = op.ahora ?? (() => new Date());
  const pageSize = op.pageSize ?? PAGE_SIZE;
  const maxPaginas = op.maxPaginas ?? MAX_PAGINAS;
  const inicio = reloj();
  const r: Flit2LecturaResultado = {
    ...contadoresEnCero(), paginas: 0, hasMore: false, modo: 'since', ejecutadoEn: inicio.toISOString(),
  };

  // Sin acceso utilizable no se fija el arranque ni se llama al feed (AC1).
  await port.verificarAcceso();

  try {
    let fila = await leerFila();
    if (!fila) {
      // La 0215 siembra la fila; si alguien la borró a mano, se recrea vacía (id=1, CHECK).
      await db.insert(flitoSyncFlit2Lectura).values({ id: FILA }).onConflictDoNothing();
      fila = await leerFila();
    }
    if (!fila?.cursor && !fila?.sinceArranque) {
      await db.update(flitoSyncFlit2Lectura).set({ sinceArranque: inicio, updatedAt: inicio })
        .where(and(eq(flitoSyncFlit2Lectura.id, FILA), isNull(flitoSyncFlit2Lectura.sinceArranque)));
      fila = await leerFila();
    }
    if (!fila || (!fila.cursor && !fila.sinceArranque)) throw new Error('posición de lectura de FLIT 2 ausente');

    let cursorLeido: string | null = fila.cursor;
    r.modo = cursorLeido ? 'cursor' : 'since';
    let pos: PosicionLectura = cursorLeido ? { cursor: cursorLeido } : { since: fila.sinceArranque! };
    await anotar({ ultimoIntentoEn: inicio }, inicio);

    while (r.paginas < maxPaginas) {
      const pagina = await port.leerPagina(pos, pageSize);
      const parcial = contadoresEnCero();
      const esperado = cursorLeido;
      await db.transaction(async (tx) => {
        await aplicarPagina(tx, pagina.items, parcial, inicio);
        const movidas = await tx.update(flitoSyncFlit2Lectura)
          .set({ cursor: pagina.nextCursor, updatedAt: inicio })
          .where(and(
            eq(flitoSyncFlit2Lectura.id, FILA),
            sql`${flitoSyncFlit2Lectura.cursor} IS NOT DISTINCT FROM ${esperado}`,
          ))
          .returning({ id: flitoSyncFlit2Lectura.id });
        if (movidas.length === 0) throw new Flit2LecturaConcurrenteError();
      });
      // Solo tras el commit: los totales cuentan lo que quedó guardado.
      parcial.leidos = pagina.items.length + pagina.invalidos;
      parcial.invalidos = pagina.invalidos;
      for (const k of CLAVES_CONTADOR) r[k] += parcial[k];
      r.paginas += 1;
      r.hasMore = pagina.hasMore;
      cursorLeido = pagina.nextCursor;
      if (!pagina.hasMore) break;
      pos = { cursor: pagina.nextCursor };
    }

    await anotar({ ultimaExitosaEn: reloj(), ultimoErrorCodigo: null }, reloj());
    log.info({ ...r, ms: reloj().getTime() - inicio.getTime() }, 'lectura FLIT 2');
    return r;
  } catch (e) {
    const codigo = e instanceof Flit2Error ? e.codigo : 'error_interno';
    try {
      await anotar({ ultimoErrorCodigo: codigo }, reloj());
    } catch (e2) {
      log.error({ err: e2 instanceof Error ? e2.name : typeof e2 }, 'no se pudo anotar el error de la lectura FLIT 2');
    }
    log.warn({ codigo, paginas: r.paginas, leidos: r.leidos }, 'lectura FLIT 2 interrumpida');
    if (r.paginas > 0 && e && typeof e === 'object') parciales.set(e, r);
    throw e;
  }
}
