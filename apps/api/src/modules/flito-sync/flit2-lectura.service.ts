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
// RN-07  La #13091 no creaba compradores, SOAT ni impuestos (ahora los crea la #13093, RN-14…RN-17), ni
//        leía la factura (ahora la #13095, RN-21). `flit_raw` guarda los compradores con lista blanca, sin PII (AC10). Los
//        logs solo llevan `idFlit2`, radicado, contadores, estado HTTP y código.
// RN-08  Cada ítem cae en UNA clase y los contadores cuadran:
//        leidos = nuevos + actualizados + sinCambios + conflictos + sinVehiculo + eliminadosIgnorados + invalidos.
//
// ── HU #13092 (lectura programada). Diseño: `docs/diseno/hu-13092-lectura-programada-flit2.md` ──
//
// RN-09  Candado: la corrida del cron y la del botón pasan por `leerConCandado` (advisory lock de
//        Postgres, `flit2-candado.ts`): nunca dos a la vez, tampoco entre procesos. Si está tomado,
//        `Flit2LecturaEnCursoError` (409). La guarda optimista de RN-02 sigue como segunda defensa.
// RN-10  Topes de tiempo: el cron corta a los 4 min y el botón a los 60 s, SIEMPRE después de guardar la
//        página en curso. `atrasada` = la corrida terminó con `hasMore` (queda feed por leer); la
//        siguiente continúa desde el cursor. `MAX_PAGINAS_SEGURIDAD` es solo un cinturón.
// RN-11  429 del feed: con `Retry-After` ≤ 60 s (60 si falta) se espera y se repite LA MISMA página con
//        el mismo cursor, si la espera cabe en el tope; si pide más o no cabe, la corrida termina sin
//        avanzar (`Flit2EsperaFeedError`, `atrasada=true`) y la siguiente retoma.
// RN-12  400 (`invalid_cursor` u otro) o 403 (`insufficient_scope`) del feed: la posición no avanza, el
//        código de FLIT 2 queda en `ultimo_error_codigo` y no se reintenta en la corrida. La posición
//        nunca se reinicia sola. Las pausas del pase (423, rechazo) las aplica `flit2-pase.service.ts`.
// RN-13  Auditoría solo de las corridas que terminan bien y trajeron ítems (`leidos > 0`), con totales y
//        sin PII. Las vacías o fallidas solo dejan su rastro en la fila de lectura.
//
// ── HU #13093 (compradores y arranque). Diseño: `docs/diseno/hu-13093-compradores-soat-flit2.md` ──
//
// RN-14  Compradores: `compradoresDesdeFlit2` (mapeo propio, no lanza; FLIT 1 sigue con
//        `mapeo-compradores.ts`). Con compradores, se reemplazan en bloque SOLO si difieren de los
//        guardados, y el titular del vehículo sale del principal (orden 0). Uno sin documento o sin
//        nombre no se escribe (la PII enmascarada es la #13094): se cuenta en el log, nada más.
// RN-15  Retroceso sin compradores: un trámite EXISTENTE que llega con `compradores: []` (o con ninguno
//        escribible) CONSERVA los guardados, igual que conserva el vehículo (RN-04, contrato §4 «Bloques
//        en null»). «Sin comprador» es el trámite nuevo o el que nunca tuvo; su lectura no falla.
// RN-16  Historial: el reemplazo en un trámite existente deja UNA fila en `flito_tramite_historial`
//        (campo `compradores`, origen 'api'). FLIT 1 no registra compradores en el historial, así que
//        solo va un resumen: cantidad, orden y porcentaje; nunca documento, nombre ni contacto.
// RN-17  Arranque: SOAT e impuesto por `arrancarSoatEImpuesto`, la MISMA función de FLIT 1, con sus
//        mismas condiciones (flit_estado Asignado, compañía y organismo emparejados) más una: el
//        trámite tiene comprador principal. Sin él, espera sin fallar; la entrega que lo traiga arranca.
//
// ── HU #13094 (PII enmascarada). Diseño: `docs/diseno/hu-13094-pii-enmascarada-flit2.md` ──────────
//
// RN-18  Detección: por el SCOPE del pase con que salió la página (`PaginaFlit2.conPii`, o el de
//        `verificarAcceso` si el adaptador no lo dice), nunca por el patrón del dato. Sin
//        `external.tramites.pii.read`, cada trámite aplicado queda con `flit2_pii_enmascarada = true` y
//        la fila de lectura anota `pii_enmascarada_desde` (solo la primera vez) en la MISMA transacción
//        de la página (AC1). Un trámite que se aplica CON el permiso pierde la marca.
// RN-19  Trámite enmascarado: no se escriben compradores (ni el titular del vehículo) y se conservan los
//        guardados (AC2); SOAT e impuesto no arrancan y la lectura no falla (AC3). El resto del trámite
//        (estado, vehículo, organismo) sí se aplica: no es PII (contrato §4).
// RN-20  Recuperación: si al terminar la lectura normal (sin `hasMore`, con tiempo y con el permiso) hay
//        `pii_enmascarada_desde` o una relectura a medias, en la MISMA corrida y bajo el MISMO candado
//        corre la relectura: desde el arranque (`since_arranque`, «cursor vacío») con su propio cursor
//        (`cursor_relectura`); el cursor normal no se toca. Solo aplica trámites marcados, aunque su
//        versión sea igual a la guardada (nunca una menor). Una página enmascarada en la normal reinicia la
//        relectura. Al terminarla se limpian `pii_enmascarada_desde` y `cursor_relectura` (AC4). Si se
//        corta (tope, 429, error), el cursor queda y la corrida siguiente la retoma; el fallo de la
//        relectura no tumba la lectura normal, ya guardada.
//
// ── HU #13095 (factura para impuestos). Diseño: `docs/diseno/hu-13095-factura-flit2-impuestos.md` ──
//
// RN-21  Factura: `factura_venta_flit_id` guarda el `factura.adjuntoId` que trae CADA entrega (el ítem es
//        el estado completo del trámite). El id cambia en cada reemplazo: no es identidad estable; la
//        descarga usa el que esté guardado al pedirla. `factura: null` BORRA la referencia (confirmado
//        por FLIT el 2026-09-29: el feed solo publica transacciones cerradas y el reemplazo es atómico,
//        así que null = hoy no hay factura confirmada). El cambio queda en el historial. Más largo que
//        la columna (120) → null + warn. Tombstones: RN-05, no llegan aquí.
//
// ── HU #13188 (pulso en el estado). Diseño: `docs/diseno/hu-13188-pulso-lectura-flit2.md` ─────────
//
// RN-22  `enCurso` del estado: `leerConCandado` marca la lectura DENTRO del candado y la desmarca en un
//        `finally` (termine bien o con error). Cubre cron, botón y cualquier origen futuro que pase por
//        aquí. Con el candado tomado no se marca nada (`flit2-programa.ts`).

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Flit2LecturaResultado } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, flitoCompradores, flitoSyncFlit2Lectura, flitoTramites, vehicles } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { companiaPorNit } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import {
  arrancarSoatEImpuesto, escribirTramite, esAsignado, fechaValida, reemplazarCompradores, registrarDiferencias,
  resolverOrganismoDeFlit, upsertVehiculo, type ContadoresArranque, type ValorTramite, type VehiculoFlit,
} from './flito-sync.service.js';
import {
  compradoresDesdeFlit2, ESTADOS_SIN_ESTADO_FLITO, estadoDesdeFlit2, familiaATipoTramite, tipoPropiedadPorConteo,
} from './flit2-mapeo.js';
import type { CompradorMapeado } from './mapeo-compradores.js';
import { getFlit2SyncAdapter } from './flit2-sync.adapter.js';
import type { Flit2SyncPort, ItemFlit2, PaginaFlit2, PosicionLectura } from './flit2-sync.port.js';
import { conCandadoLectura } from './flit2-candado.js';
import { marcarLecturaIniciada, marcarLecturaTerminada } from './flit2-programa.js';
import {
  Flit2EsperaFeedError, Flit2Error, Flit2LecturaConcurrenteError, Flit2LecturaEnCursoError, Flit2RespuestaError,
} from './flit2.errors.js';

const log = loggerFor('flito-sync-flit2');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FILA = 1;
const PAGE_SIZE = 500;
/**
 * Topes de tiempo (RN-10). FLIT 2 admite 120 peticiones/min por clientId en el feed y 10/min por IP en el
 * token: con el pase en caché, una corrida de 4 min pide a lo sumo una página por respuesta (lejos de
 * 120/min salvo respuestas instantáneas, y entonces el 429 de RN-11 la frena). El cron corre cada 5 min,
 * así que 4 min dejan 1 min de holgura y dos corridas no se pisan ni sin candado.
 */
export const LIMITE_CRON_MS = 4 * 60_000;
export const LIMITE_BOTON_MS = 60_000;
/** Cinturón de seguridad: 200 páginas × 500 = 100 000 ítems por corrida. Los topes reales son de tiempo. */
export const MAX_PAGINAS_SEGURIDAD = 200;
/** 429: la mayor espera que se hace dentro de una corrida, y la que se asume si falta `Retry-After`. */
export const ESPERA_429_MAX_S = 60;
/** 429 seguidos sobre la misma página antes de rendirse (el tope de tiempo suele llegar antes). */
const REINTENTOS_429_MAX = 3;

export type OrigenLectura = 'cron' | 'boton';

export interface OpcionesLectura {
  pageSize?: number;
  maxPaginas?: number;
  /** Tope de tiempo de la corrida (RN-10). Sin él, solo corta el cinturón de páginas. */
  limiteMs?: number;
  ahora?: () => Date;
  /** Espera del 429 (inyectable en tests; por defecto un `setTimeout`). */
  esperar?: (ms: number) => Promise<void>;
}

const esperarReal = (ms: number): Promise<void> => new Promise((ok) => { setTimeout(ok, ms); });

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

/** Porcentaje comparable: la BD devuelve el numeric como texto ('60.00') y FLIT 2 como número. */
const pct = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** Resumen SIN PII de unos compradores para el historial (RN-16): cantidad, orden y porcentaje. */
export function resumenCompradores(cs: { orden: number; porcentajeParticipacion: string | number | null }[]): string {
  if (cs.length === 0) return '0 compradores';
  const partes = [...cs].sort((a, b) => a.orden - b.orden)
    .map((c) => `orden ${c.orden} ${pct(c.porcentajeParticipacion) ?? 's/p'}${c.porcentajeParticipacion === null ? '' : ' %'}`);
  return `${cs.length} comprador${cs.length === 1 ? '' : 'es'}: ${partes.join(', ')}`;
}

const huella = (c: {
  orden: number; numeroDocumento: string; nombreCompleto: string; correo: string | null; celular: string | null;
  direccion: string | null; porcentajeParticipacion: string | number | null;
}): string => JSON.stringify([c.orden, c.numeroDocumento, c.nombreCompleto, c.correo, c.celular, c.direccion, pct(c.porcentajeParticipacion)]);

/**
 * Escribe los compradores de un trámite de FLIT 2 (RN-14…RN-16). Devuelve si cambiaron y si, tras
 * escribir o conservar, el trámite tiene comprador principal (condición de arranque, RN-17).
 */
async function escribirCompradoresFlit2(
  tx: Tx, tramiteId: string, esNuevo: boolean, nuevos: CompradorMapeado[],
): Promise<{ cambiaron: boolean; tienePrincipal: boolean }> {
  const tienePrincipalNuevo = nuevos.some((c) => c.orden === 0);
  if (esNuevo) {
    if (nuevos.length > 0) await reemplazarCompradores(tx, tramiteId, nuevos);
    return { cambiaron: false, tienePrincipal: tienePrincipalNuevo };
  }
  const guardados = await tx.select({
    orden: flitoCompradores.orden, numeroDocumento: flitoCompradores.numeroDocumento,
    nombreCompleto: flitoCompradores.nombreCompleto, correo: flitoCompradores.correo, celular: flitoCompradores.celular,
    direccion: flitoCompradores.direccion, porcentajeParticipacion: flitoCompradores.porcentajeParticipacion,
  }).from(flitoCompradores).where(eq(flitoCompradores.tramiteId, tramiteId));
  // RN-15: sin compradores escribibles, se conservan los guardados.
  if (nuevos.length === 0) return { cambiaron: false, tienePrincipal: guardados.some((c) => c.orden === 0) };

  const antes = guardados.map(huella).sort().join('|');
  const despues = nuevos.map(huella).sort().join('|');
  if (antes === despues) return { cambiaron: false, tienePrincipal: tienePrincipalNuevo };

  await reemplazarCompradores(tx, tramiteId, nuevos);
  const resumenAntes = resumenCompradores(guardados);
  let resumenDespues = resumenCompradores(nuevos);
  // Mismo resumen y otra persona o contacto: el rastro dice que cambió sin decir qué dato (RN-16).
  if (resumenDespues === resumenAntes) resumenDespues += ' (cambian datos de persona)';
  await registrarDiferencias(tx, tramiteId, { compradores: resumenAntes }, { compradores: resumenDespues });
  return { cambiaron: true, tienePrincipal: tienePrincipalNuevo };
}

/**
 * Cómo se aplica una página (HU #13094). `conPii`: el pase traía el scope de datos personales (RN-18).
 * `relectura`: la de recuperación (RN-20), que solo toca trámites marcados, aunque su versión sea igual.
 */
export interface ModoAplicar {
  conPii: boolean;
  relectura?: boolean;
}

const MODO_NORMAL: ModoAplicar = { conPii: true };

/** Clasifica y aplica UN ítem dentro de la transacción de su página (RN-03…RN-06, RN-18…RN-20). */
async function aplicarItem(tx: Tx, it: ItemFlit2, r: Contadores, ahora: Date, modo: ModoAplicar): Promise<void> {
  if (it.eliminado) { r.eliminadosIgnorados += 1; return; }

  const [porId] = await tx.select().from(flitoTramites).where(eq(flitoTramites.idFlit2, it.idFlit2)).limit(1);
  const marcadoAntes = porId?.flit2PiiEnmascarada === true;
  if (modo.relectura) {
    // RN-20: la relectura no crea ni toca trámites sin marca; con la marca, versión igual sí, menor nunca.
    if (!porId || !marcadoAntes || (porId.syncVersion !== null && it.syncVersion < porId.syncVersion)) {
      r.sinCambios += 1; return;
    }
  } else if (porId && porId.syncVersion !== null && it.syncVersion <= porId.syncVersion) { r.sinCambios += 1; return; }

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

  // RN-19: sin el permiso, los compradores llegan enmascarados: no se mapean (se conservan los guardados).
  const { compradores, omitidos } = modo.conPii ? compradoresDesdeFlit2(it.compradores) : { compradores: [], omitidos: 0 };
  if (omitidos > 0) {
    log.warn({ idFlit2: it.idFlit2, omitidos }, 'compradores de FLIT 2 sin documento o sin nombre: no se escriben');
  }
  // El titular solo sale del principal (orden 0): sin él, los spreads conservan el que había (RN-14).
  const paraTitular = compradores[0]?.orden === 0 ? compradores : [];

  let vehiculoId: number;
  let plateComplete: string | null;
  let vin: string | null;
  if (it.vehiculo) {
    vin = it.vehiculo.vin;
    const placa = await placaConocida(tx, it.vehiculo.vin, it.vehiculo.placa);
    const vf: VehiculoFlit = { ...it.vehiculo, placa, compradores: paraTitular };
    vehiculoId = await upsertVehiculo(tx, vf, compania?.id ?? null);
    plateComplete = placa ?? porId?.plateComplete ?? null;
  } else {
    // Solo llega aquí un trámite existente (el nuevo sin vehículo salió arriba): conserva el suyo.
    vehiculoId = porId!.vehiculoId;
    plateComplete = porId!.plateComplete;
    vin = null; // se lee solo si hace falta arrancar (RN-17)
  }

  const mapeo = estadoDesdeFlit2(it.estado);
  const retrocede = ESTADOS_SIN_ESTADO_FLITO.has(it.estado) || mapeo.desconocido;
  const facturaAdjuntoId = acotado(it.facturaAdjuntoId, 120);
  if (it.facturaAdjuntoId && !facturaAdjuntoId) {
    log.warn({ idFlit2: it.idFlit2, campo: 'facturaAdjuntoId', longitud: it.facturaAdjuntoId.length }, 'adjunto de factura más largo que su columna: se descarta');
  }
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
    // Lo escribe el módulo de impuestos: se conserva.
    valorImpuestoLiquidado: porId?.valorImpuestoLiquidado ?? null,
    // RN-21: el adjuntoId de ESTA entrega. `factura: null` → null borra la referencia (confirmado por FLIT
    // el 2026-09-29: null = sin factura confirmada; el feed solo publica transacciones cerradas).
    facturaVentaFlitId: facturaAdjuntoId,
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

  const { row, esNuevo, huboCambios } = await escribirTramite(tx, porId ?? null, it.radicado, valores);
  const { cambiaron, tienePrincipal } = await escribirCompradoresFlit2(tx, row.id, esNuevo, compradores);
  // RN-18: la marca sigue al scope de ESTA entrega; solo se escribe si cambia.
  const marca = !modo.conPii;
  const cambiaMarca = marca !== marcadoAntes;
  if (cambiaMarca) await tx.update(flitoTramites).set({ flit2PiiEnmascarada: marca }).where(eq(flitoTramites.id, row.id));
  if (esNuevo) r.nuevos += 1;
  else if (huboCambios || cambiaron || cambiaMarca) r.actualizados += 1;
  else r.sinCambios += 1;

  // RN-17: las mismas condiciones y la misma función que FLIT 1, más el comprador principal.
  // RN-19: enmascarado, no arranca (espera la relectura, RN-20).
  if (modo.conPii && esAsignado(row.flitEstado ?? '') && compania && organismo && tienePrincipal) {
    vin ??= (await tx.select({ vin: vehicles.vin }).from(vehicles).where(eq(vehicles.id, vehiculoId)).limit(1))[0]?.vin ?? null;
    if (!vin) return; // un vehículo sin VIN no puede llevar SOAT (el SOAT va por VIN, RN-01 de FLIT 1)
    const liquidado = row.valorImpuestoLiquidado === null ? null : Number(row.valorImpuestoLiquidado);
    // Los contadores del arranque no están en el resultado de FLIT 2: lo creado deja su audit, como en FLIT 1.
    const arranque: ContadoresArranque = { soatCreados: 0, soatBloqueadosPorVin: 0, impuestosCreados: 0, impuestosBloqueadosPorVehiculo: 0 };
    await arrancarSoatEImpuesto(
      tx,
      { vin, idFlit: it.radicado, valorImpuestoLiquidado: liquidado },
      { tramiteId: row.id, soatId: row.soatId, vehiculoId, compania, organismoCodigo: organismo.codigo },
      arranque,
    );
  }
}

/** Aplica los ítems de una página. Los desenlaces esperados se cuentan; solo un fallo de BD lanza. */
export async function aplicarPagina(
  tx: Tx, items: ItemFlit2[], r: Contadores, ahora: Date = new Date(), modo: ModoAplicar = MODO_NORMAL,
): Promise<void> {
  for (const it of items) await aplicarItem(tx, it, r, ahora, modo);
}

/** Scope de la página: el que dijo el adaptador o, si no lo sabe, el del acceso (RN-18). */
const conPiiDe = (p: PaginaFlit2, delAcceso: boolean): boolean => p.conPii ?? delAcceso;

/**
 * RN-18: una página enmascarada anota desde cuándo (solo si no estaba anotado) y reinicia la relectura,
 * en la transacción de la página: si la página se revierte, la anotación también.
 */
async function anotarEnmascarada(tx: Tx, ahora: Date): Promise<void> {
  await tx.update(flitoSyncFlit2Lectura).set({ piiEnmascaradaDesde: ahora })
    .where(and(eq(flitoSyncFlit2Lectura.id, FILA), isNull(flitoSyncFlit2Lectura.piiEnmascaradaDesde)));
  await tx.update(flitoSyncFlit2Lectura).set({ cursorRelectura: null }).where(eq(flitoSyncFlit2Lectura.id, FILA));
}

async function leerFila() {
  const [fila] = await db.select().from(flitoSyncFlit2Lectura).where(eq(flitoSyncFlit2Lectura.id, FILA)).limit(1);
  return fila ?? null;
}

async function anotar(set: Partial<typeof flitoSyncFlit2Lectura.$inferInsert>, ahora: Date): Promise<void> {
  await db.update(flitoSyncFlit2Lectura).set({ ...set, updatedAt: ahora }).where(eq(flitoSyncFlit2Lectura.id, FILA));
}

/** Código que queda en `ultimo_error_codigo` (≤ 40): el de FLIT 2 si el feed lo dio (RN-12), si no el nuestro. */
function codigoAnotado(e: unknown): string {
  if (e instanceof Flit2RespuestaError && e.codigoFlit2) return e.codigoFlit2;
  return e instanceof Flit2Error ? e.codigo : 'error_interno';
}

/**
 * Pide una página y, ante un 429 del feed, espera y repite LA MISMA posición (RN-11). Cualquier otro
 * error se propaga sin reintento (RN-12): la corrida termina sin avanzar.
 */
async function leerPaginaConEsperas(
  port: Flit2SyncPort, pos: PosicionLectura, pageSize: number,
  restanteMs: () => number, esperar: (ms: number) => Promise<void>,
) {
  for (let intento = 0; ; intento++) {
    try {
      return await port.leerPagina(pos, pageSize);
    } catch (e) {
      if (!(e instanceof Flit2RespuestaError) || e.statusFlit2 !== 429) throw e;
      const segundos = e.reintentarEnS ?? ESPERA_429_MAX_S;
      if (segundos > ESPERA_429_MAX_S || segundos * 1000 >= restanteMs() || intento >= REINTENTOS_429_MAX) {
        throw new Flit2EsperaFeedError(segundos);
      }
      log.info({ segundos, intento: intento + 1 }, 'FLIT 2 pidió esperar (429): se repite la misma página');
      await esperar(segundos * 1000);
    }
  }
}

/**
 * Una corrida de lectura: páginas hasta `hasMore=false`, hasta el tope de tiempo (RN-10) o hasta
 * `maxPaginas` (RN-01, RN-02).
 * Lanza `Flit2Error` (sin acceso, rechazado, bloqueado, respuesta inesperada, lectura concurrente…);
 * si ya había páginas guardadas, `parcialDe(error)` devuelve los totales de lo guardado.
 */
export async function leerIncremental(
  op: OpcionesLectura = {}, port: Flit2SyncPort = getFlit2SyncAdapter(),
): Promise<Flit2LecturaResultado> {
  const reloj = op.ahora ?? (() => new Date());
  const pageSize = op.pageSize ?? PAGE_SIZE;
  const maxPaginas = op.maxPaginas ?? MAX_PAGINAS_SEGURIDAD;
  const esperar = op.esperar ?? esperarReal;
  const inicio = reloj();
  const restanteMs = (): number => (op.limiteMs === undefined ? Infinity : op.limiteMs - (reloj().getTime() - inicio.getTime()));
  const r: Flit2LecturaResultado = {
    ...contadoresEnCero(), paginas: 0, hasMore: false, modo: 'since', ejecutadoEn: inicio.toISOString(),
  };

  // Sin acceso utilizable no se fija el arranque ni se llama al feed (AC1).
  const piiDelAcceso = (await port.verificarAcceso())?.conPii ?? true;
  let piiAlFinal = piiDelAcceso;

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
      const pagina = await leerPaginaConEsperas(port, pos, pageSize, restanteMs, esperar);
      const parcial = contadoresEnCero();
      const esperado = cursorLeido;
      const conPii = conPiiDe(pagina, piiDelAcceso);
      await db.transaction(async (tx) => {
        await aplicarPagina(tx, pagina.items, parcial, inicio, { conPii });
        if (!conPii) await anotarEnmascarada(tx, inicio);
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
      piiAlFinal = conPii;
      if (!conPii && pagina.items.length > 0) {
        log.warn({ items: pagina.items.length }, 'FLIT 2 entregó trámites sin permiso de datos personales: quedan marcados, sin compradores ni arranque');
      }
      if (!pagina.hasMore) break;
      pos = { cursor: pagina.nextCursor };
      // RN-10: el tope se mira DESPUÉS de guardar la página, nunca a mitad de una.
      if (restanteMs() <= 0) break;
    }

    await anotar({ ultimaExitosaEn: reloj(), ultimoErrorCodigo: null, atrasada: r.hasMore }, reloj());
    log.info({ ...r, ms: reloj().getTime() - inicio.getTime() }, 'lectura FLIT 2');
    // RN-20: la relectura, solo con la normal al día, con tiempo y con el permiso de vuelta.
    if (!r.hasMore && piiAlFinal && restanteMs() > 0) {
      await releerEnmascarados(port, { pageSize, maxPaginas, restanteMs, esperar, inicio, piiDelAcceso });
    }
    return r;
  } catch (e) {
    const codigo = codigoAnotado(e);
    // Solo se sabe que queda feed si alguna página se guardó (su `hasMore`) o si FLIT 2 pidió esperar.
    const atrasada = e instanceof Flit2EsperaFeedError ? true : r.paginas > 0 ? r.hasMore : undefined;
    if (e instanceof Flit2EsperaFeedError) r.hasMore = true;
    try {
      await anotar({ ultimoErrorCodigo: codigo, ...(atrasada === undefined ? {} : { atrasada }) }, reloj());
    } catch (e2) {
      log.error({ err: e2 instanceof Error ? e2.name : typeof e2 }, 'no se pudo anotar el error de la lectura FLIT 2');
    }
    log.warn({ codigo, paginas: r.paginas, leidos: r.leidos }, 'lectura FLIT 2 interrumpida');
    if (r.paginas > 0 && e && typeof e === 'object') parciales.set(e, r);
    throw e;
  }
}

interface OpcionesRelectura {
  pageSize: number;
  maxPaginas: number;
  restanteMs: () => number;
  esperar: (ms: number) => Promise<void>;
  inicio: Date;
  piiDelAcceso: boolean;
}

/** Resumen de una relectura de recuperación (RN-20): solo contadores, para el log. */
export interface ResultadoRelectura extends Contadores {
  paginas: number;
  terminada: boolean;
}

/**
 * Relectura de recuperación (RN-20). Se llama con el candado de la corrida ya tomado. No lanza: su fallo
 * deja el cursor de relectura donde iba y la siguiente corrida la retoma. Devuelve null si no había nada
 * que recuperar.
 */
export async function releerEnmascarados(port: Flit2SyncPort, op: OpcionesRelectura): Promise<ResultadoRelectura | null> {
  const res: ResultadoRelectura = { ...contadoresEnCero(), paginas: 0, terminada: false };
  try {
    const fila = await leerFila();
    if (!fila || (!fila.piiEnmascaradaDesde && !fila.cursorRelectura)) return null;
    let esperado: string | null = fila.cursorRelectura;
    // «Cursor vacío»: desde el mismo arranque de la lectura normal, que cubre todo lo que FLITO leyó.
    let pos: PosicionLectura | null = esperado ? { cursor: esperado } : fila.sinceArranque ? { since: fila.sinceArranque } : null;
    if (!pos) return null;

    while (res.paginas < op.maxPaginas) {
      const pagina = await leerPaginaConEsperas(port, pos, op.pageSize, op.restanteMs, op.esperar);
      if (!conPiiDe(pagina, op.piiDelAcceso)) {
        log.warn('relectura FLIT 2 sin permiso de datos personales: se deja para otra corrida');
        break;
      }
      const parcial = contadoresEnCero();
      const guarda = esperado;
      await db.transaction(async (tx) => {
        await aplicarPagina(tx, pagina.items, parcial, op.inicio, { conPii: true, relectura: true });
        const fin = !pagina.hasMore;
        const movidas = await tx.update(flitoSyncFlit2Lectura)
          .set(fin ? { cursorRelectura: null, piiEnmascaradaDesde: null } : { cursorRelectura: pagina.nextCursor })
          .where(and(
            eq(flitoSyncFlit2Lectura.id, FILA),
            sql`${flitoSyncFlit2Lectura.cursorRelectura} IS NOT DISTINCT FROM ${guarda}`,
          ))
          .returning({ id: flitoSyncFlit2Lectura.id });
        if (movidas.length === 0) throw new Flit2LecturaConcurrenteError();
      });
      parcial.leidos = pagina.items.length + pagina.invalidos;
      parcial.invalidos = pagina.invalidos;
      for (const k of CLAVES_CONTADOR) res[k] += parcial[k];
      res.paginas += 1;
      if (!pagina.hasMore) { res.terminada = true; break; }
      esperado = pagina.nextCursor;
      pos = { cursor: pagina.nextCursor };
      if (op.restanteMs() <= 0) break;
    }
    log.info({ ...res }, 'relectura FLIT 2 de trámites enmascarados');
  } catch (e) {
    log.warn({ codigo: codigoAnotado(e), paginas: res.paginas }, 'relectura FLIT 2 interrumpida: la siguiente corrida la retoma');
  }
  return res;
}

/**
 * La corrida de verdad (cron o botón): toma el candado (RN-09) y lee con el tope de su origen (RN-10).
 * Lanza `Flit2LecturaEnCursoError` (409) si otra corrida lo tiene, en este o en otro proceso.
 */
export async function leerConCandado(
  origen: OrigenLectura, port?: Flit2SyncPort, op: OpcionesLectura = {},
): Promise<Flit2LecturaResultado> {
  const limiteMs = origen === 'cron' ? LIMITE_CRON_MS : LIMITE_BOTON_MS;
  // RN-22: la marca va DENTRO del candado; si está tomado, `enCurso` nunca pasa a true.
  const res = await conCandadoLectura(async () => {
    marcarLecturaIniciada();
    try {
      return await leerIncremental({ limiteMs, ...op }, port);
    } finally {
      marcarLecturaTerminada();
    }
  });
  if (!res.tomado) throw new Flit2LecturaEnCursoError();
  return res.valor;
}

/** ¿Se audita esta corrida? Solo si terminó bien y trajo ítems (RN-13). */
export const debeAuditarse = (r: Flit2LecturaResultado): boolean => r.leidos > 0;

/** Detalle de `audit_logs`: solo totales, ningún radicado ni dato de persona (RN-13). */
export function detalleAuditoria(r: Flit2LecturaResultado, origen: OrigenLectura): string {
  return `Sync FLIT 2 ${origen === 'cron' ? 'programada' : 'manual'} (${r.modo}): ${r.leidos} leídos, ${r.nuevos} nuevos, `
    + `${r.actualizados} actualizados, ${r.sinCambios} sin cambios, ${r.conflictos} conflictos, `
    + `${r.sinVehiculo} sin vehículo, ${r.eliminadosIgnorados} eliminados, ${r.invalidos} inválidos; `
    + `${r.paginas} páginas${r.hasMore ? ' (quedan más)' : ''}.`;
}

/**
 * Auditoría de la corrida del cron: no hay `req`, así que va como los demás procesos del sistema
 * (`userId` null, `userEmail` 'sistema', como la vigencia SOAT). Un fallo al auditar no tumba el cron.
 */
export async function auditarLecturaProgramada(r: Flit2LecturaResultado): Promise<void> {
  if (!debeAuditarse(r)) return;
  try {
    await db.insert(auditLogs).values({
      userId: null,
      userEmail: 'sistema',
      action: 'update',
      resource: 'flito_sincronizacion_flit2',
      detail: detalleAuditoria(r, 'cron'),
    });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.name : typeof e }, 'no se pudo auditar la lectura programada de FLIT 2');
  }
}
