// FLITO sync — lectura automática de FLIT 1: ventana móvil + lectura nocturna (HU #13629, Feature #13612,
// Épica #13576). Diseño: `docs/diseno/hu-13629-lectura-automatica-flit1.md`. Parámetros y estado en la fila
// única `flito_sync_flit1_lectura` (0241 + 0242). El timer de 60 s vive en `flito-sync.cron.ts`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Cada tick: interruptor `flit1` (apagado → no lee y deja `proxima_prevista_en` vacía), luego el
//        candado `[13_629, 1]` (compartido por periódica, nocturna y la ruta manual). Ocupado → se salta y
//        se loguea en `info` (AC5). Con el candado se RELEE la fila: un cambio de parámetros aplica en el
//        siguiente tick sin reiniciar (AC8).
// RN-02  Toca la periódica si nunca corrió o si `ahora ≥ ultima_corrida_en + frecuencia − 30 s` (medio tick
//        de tolerancia: periodo real = frecuencia ± 30 s).
// RN-03  Nocturna pendiente: hora Bogotá ≥ 02:00 y `nocturna_buena_dia ≠ hoy`. Toca si está pendiente y
//        (la última corrida fue antes de las 02:00 de hoy, o toca la periódica): corre en el primer tick
//        ≥ 02:00, o en el primero del día si el proceso estaba caído (AC2); si falla, se reintenta en el
//        siguiente slot de la periódica, no cada minuto. Ocupa el slot de la periódica.
// RN-04  Rango: `finalDate` = mañana (Bogotá, límite exclusivo); `initialDate = max(hoy − 90,
//        min(hoy − N, base))` con N = ventana o nocturna y base = día de la última buena o, si nunca hubo,
//        la semilla (AC3, AC4). Fechas siempre desde UTC con Bogotá en UTC−5 fijo (sin horario de verano).
// RN-05  Semilla (solo con `ultima_buena_en` null): `arranque` guardado › día de
//        `system_kv['flito.ultima_sincronizacion']` (solo lectura) › hace 1 mes. Siempre con tope de 90 días.
// RN-06  Al empezar (ya decidido que toca) se escriben `ultima_corrida_en = inicio` y
//        `proxima_prevista_en = inicio + frecuencia`. Corrida buena: `ultima_buena_en = inicio` (+
//        `nocturna_buena_dia = hoy` si fue nocturna); con trámites fallidos sigue siendo buena y además
//        marca `ultimo_fallo_codigo = 'tramites_con_fallo'`. Corrida fallida: solo `ultimo_fallo_*` (AC4).
// RN-07  Logs sin PII (AC10): totales, rango y códigos. Nunca `err.message` ni el cuerpo de FLIT 1.
//        Códigos de fallo: `flit1_http_<status>`, `flit1_timeout`, `flit1_red`, `flit1_respuesta_invalida`,
//        `base_datos`, `desconocido`.

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSyncFlit1Lectura } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { conCandado, type ResultadoCandado } from './candado-advisory.js';
import { Flit1ReporteError } from './flit-http.adapter.js';
import { arranquePorDefecto } from './flito-sync-flit1-parametros.service.js';
import { fuenteHabilitada } from './flito-sync-interruptor.service.js';
import { leerUltimaSincronizacion, sincronizar } from './flito-sync.service.js';

const log = loggerFor('flito-sync-flit1-lectura');

const ID = 1;

/** Candado de la lectura de FLIT 1 (HU #13629): dos enteros, distinto de `[13_092, 2]` de FLIT 2. */
export const CLAVE_CANDADO_LECTURA_FLIT1 = [13_629, 1] as const;

export function conCandadoLecturaFlit1<T>(fn: () => Promise<T>): Promise<ResultadoCandado<T>> {
  return conCandado(CLAVE_CANDADO_LECTURA_FLIT1, fn, 'lectura FLIT 1', log);
}

export const TOLERANCIA_TICK_MS = 30_000;
export const TOPE_DIAS = 90;
const HORA_NOCTURNA_BOGOTA = 2;
const OFFSET_BOGOTA_MS = 5 * 60 * 60 * 1000; // UTC−5 fijo
const MIN_MS = 60_000;
const DIA_MS = 24 * 60 * 60 * 1000;

// ── Fechas (puras, desde UTC) ───────────────────────────────────────────────────────────────────────

const dos = (n: number) => String(n).padStart(2, '0');

/** Día calendario en Bogotá (`YYYY-MM-DD`) del instante dado. No depende del huso del servidor. */
export function diaBogota(instante: Date): string {
  const b = new Date(instante.getTime() - OFFSET_BOGOTA_MS);
  return `${b.getUTCFullYear()}-${dos(b.getUTCMonth() + 1)}-${dos(b.getUTCDate())}`;
}

function horaBogota(instante: Date): number {
  return new Date(instante.getTime() - OFFSET_BOGOTA_MS).getUTCHours();
}

function aUtc(dia: string): number {
  const [y, m, d] = dia.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function sumarDias(dia: string, n: number): string {
  const f = new Date(aUtc(dia) + n * DIA_MS);
  return `${f.getUTCFullYear()}-${dos(f.getUTCMonth() + 1)}-${dos(f.getUTCDate())}`;
}

/** Instante de las 02:00 de `dia` en Bogotá (= 07:00 UTC). */
function nocturnaDe(dia: string): Date {
  return new Date(aUtc(dia) + HORA_NOCTURNA_BOGOTA * 60 * MIN_MS + OFFSET_BOGOTA_MS);
}

const aYyyymmdd = (dia: string) => dia.replace(/-/g, '');

// ── Planificación (pura) ────────────────────────────────────────────────────────────────────────────

export interface ParametrosPlan { frecuenciaMinutos: number; ventanaDias: number; ventanaNocturnaDias: number; arranque: string | null }
export interface MarcasPlan { ultimaCorridaEn: Date | null; ultimaBuenaEn: Date | null; nocturnaBuenaDia: string | null }
export interface EntradaPlan { ahora: Date; parametros: ParametrosPlan; marcas: MarcasPlan; semillaKv: string | null }

export type PlanLectura =
  | { toca: false; motivo: 'no_toca'; proximaPrevistaEn: Date }
  | { toca: true; tipo: 'periodica' | 'nocturna'; hoy: string; initialDate: string; finalDate: string; proximaPrevistaEn: Date };

/** RN-05: base del rango cuando nunca hubo una corrida buena. */
export function semillaLecturaFlit1(hoy: string, arranque: string | null, semillaKv: string | null): string {
  if (arranque) return arranque;
  if (semillaKv) {
    const t = new Date(semillaKv);
    if (!Number.isNaN(t.getTime())) return diaBogota(t);
  }
  return arranquePorDefecto(hoy);
}

/** RN-02…RN-05. Decide si toca leer, qué tipo y con qué rango. Sin efectos. */
export function planificarLecturaFlit1({ ahora, parametros, marcas, semillaKv }: EntradaPlan): PlanLectura {
  const frecuenciaMs = parametros.frecuenciaMinutos * MIN_MS;
  const hoy = diaBogota(ahora);
  const { ultimaCorridaEn } = marcas;

  const tocaPeriodica = ultimaCorridaEn === null
    || ahora.getTime() >= ultimaCorridaEn.getTime() + frecuenciaMs - TOLERANCIA_TICK_MS;
  const nocturnaPendiente = horaBogota(ahora) >= HORA_NOCTURNA_BOGOTA && marcas.nocturnaBuenaDia !== hoy;
  const tocaNocturna = nocturnaPendiente
    && (ultimaCorridaEn === null || ultimaCorridaEn.getTime() < nocturnaDe(hoy).getTime() || tocaPeriodica);

  if (!tocaPeriodica && !tocaNocturna) {
    return { toca: false, motivo: 'no_toca', proximaPrevistaEn: new Date((ultimaCorridaEn as Date).getTime() + frecuenciaMs) };
  }

  const tipo = tocaNocturna ? 'nocturna' : 'periodica';
  const n = tipo === 'nocturna' ? parametros.ventanaNocturnaDias : parametros.ventanaDias;
  const base = marcas.ultimaBuenaEn ? diaBogota(marcas.ultimaBuenaEn) : semillaLecturaFlit1(hoy, parametros.arranque, semillaKv);
  const desdeVentana = sumarDias(hoy, -n);
  const tope = sumarDias(hoy, -TOPE_DIAS);
  const minimo = base < desdeVentana ? base : desdeVentana;
  const inicial = minimo > tope ? minimo : tope;
  return {
    toca: true, tipo, hoy,
    initialDate: aYyyymmdd(inicial),
    finalDate: aYyyymmdd(sumarDias(hoy, 1)),
    proximaPrevistaEn: new Date(ahora.getTime() + frecuenciaMs),
  };
}

// ── Códigos de fallo ────────────────────────────────────────────────────────────────────────────────

/** RN-07: código técnico del fallo de una corrida. Nunca el mensaje. */
export function codigoFalloFlit1(e: unknown): string {
  if (e instanceof Flit1ReporteError) return e.codigo;
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; code?: unknown };
    if (o.name === 'PostgresError' || (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code))) return 'base_datos';
  }
  return 'desconocido';
}

// ── Base ────────────────────────────────────────────────────────────────────────────────────────────

async function leerFilaLectura() {
  const [fila] = await db.select({
    frecuenciaMinutos: flitoSyncFlit1Lectura.frecuenciaMinutos,
    ventanaDias: flitoSyncFlit1Lectura.ventanaDias,
    ventanaNocturnaDias: flitoSyncFlit1Lectura.ventanaNocturnaDias,
    arranque: flitoSyncFlit1Lectura.arranque,
    ultimaCorridaEn: flitoSyncFlit1Lectura.ultimaCorridaEn,
    ultimaBuenaEn: flitoSyncFlit1Lectura.ultimaBuenaEn,
    nocturnaBuenaDia: flitoSyncFlit1Lectura.nocturnaBuenaDia,
    proximaPrevistaEn: flitoSyncFlit1Lectura.proximaPrevistaEn,
  }).from(flitoSyncFlit1Lectura).where(eq(flitoSyncFlit1Lectura.id, ID)).limit(1);
  return fila;
}

/** RN-05: la clave de la ruta manual, de solo lectura. Ilegible = ausente (warn sin el valor). */
async function leerSemillaKv(): Promise<string | null> {
  const at = await leerUltimaSincronizacion();
  if (at !== null && Number.isNaN(new Date(at).getTime())) {
    log.warn('semilla de la lectura de FLIT 1 ilegible en system_kv: se ignora');
    return null;
  }
  return at;
}

const actualizarFila = (set: Partial<typeof flitoSyncFlit1Lectura.$inferInsert>) =>
  db.update(flitoSyncFlit1Lectura).set(set).where(eq(flitoSyncFlit1Lectura.id, ID));

async function registrarFallo(codigo: string): Promise<void> {
  try {
    await actualizarFila({ ultimoFalloEn: new Date(), ultimoFalloCodigo: codigo });
  } catch (e) {
    log.warn({ codigo: codigoFalloFlit1(e) }, 'no se pudo registrar el fallo de la lectura de FLIT 1');
  }
}

// ── Corrida ─────────────────────────────────────────────────────────────────────────────────────────

export type DesenlaceLecturaFlit1 = 'apagada' | 'candado_ocupado' | 'sin_fila' | 'no_toca' | 'buena' | 'fallo';

async function corridaConCandado(ahora: Date): Promise<DesenlaceLecturaFlit1> {
  let fila: Awaited<ReturnType<typeof leerFilaLectura>>;
  let semillaKv: string | null = null;
  try {
    fila = await leerFilaLectura();
    if (fila && fila.ultimaBuenaEn === null && fila.arranque === null) semillaKv = await leerSemillaKv();
  } catch (e) {
    // Falla el `select` de la fila: es la base, aunque el error no traiga código de Postgres.
    const codigo = codigoFalloFlit1(e) === 'desconocido' ? 'base_datos' : codigoFalloFlit1(e);
    log.warn({ codigo }, 'lectura FLIT 1 automática: no se pudo leer su estado');
    await registrarFallo(codigo);
    return 'fallo';
  }
  if (!fila) {
    // La 0241 la siembra; si alguien la borró, no se corre (sin marca, correría cada minuto).
    log.warn('lectura FLIT 1 automática: falta la fila de parámetros, no corre');
    return 'sin_fila';
  }

  const plan = planificarLecturaFlit1({ ahora, parametros: fila, marcas: fila, semillaKv });

  if (!plan.toca) {
    // Parámetros cambiados sin corrida: la próxima prevista se recalcula con la frecuencia nueva.
    if (fila.proximaPrevistaEn?.getTime() !== plan.proximaPrevistaEn.getTime()) {
      await actualizarFila({ proximaPrevistaEn: plan.proximaPrevistaEn });
    }
    return 'no_toca';
  }

  const { tipo, initialDate, finalDate } = plan;
  await actualizarFila({ ultimaCorridaEn: ahora, proximaPrevistaEn: plan.proximaPrevistaEn });
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof sincronizar>>;
  try {
    r = await sincronizar({ initialDate, finalDate });
  } catch (e) {
    const codigo = codigoFalloFlit1(e);
    log.warn({ tipo, initialDate, finalDate, codigo, ms: Date.now() - t0 }, 'lectura FLIT 1 automática falló');
    await registrarFallo(codigo);
    return 'fallo';
  }

  await actualizarFila({
    ultimaBuenaEn: ahora,
    ...(tipo === 'nocturna' ? { nocturnaBuenaDia: plan.hoy } : {}),
    ...(r.tramitesFallidos > 0 ? { ultimoFalloEn: new Date(), ultimoFalloCodigo: 'tramites_con_fallo' } : {}),
  });
  log.info({
    tipo, initialDate, finalDate, leidos: r.tramitesLeidos, nuevos: r.tramitesNuevos,
    actualizados: r.tramitesActualizados, sinCambios: r.tramitesSinCambios,
    omitidosOtraFuente: r.tramitesOmitidosOtraFuente, fallidos: r.tramitesFallidos, ms: Date.now() - t0,
  }, 'lectura FLIT 1 automática');
  return 'buena';
}

/**
 * Un tick de la lectura automática de FLIT 1 (RN-01). Nunca lanza: el desenlace queda en la fila y en el
 * log sin PII. `ahora` se inyecta para el test.
 */
export async function correrLecturaFlit1Programada(ahora: Date = new Date()): Promise<DesenlaceLecturaFlit1> {
  try {
    if (!(await fuenteHabilitada('flit1'))) {
      // Una sola escritura condicional: el estado no debe mostrar una «próxima» que no va a pasar.
      await db.update(flitoSyncFlit1Lectura).set({ proximaPrevistaEn: null })
        .where(and(eq(flitoSyncFlit1Lectura.id, ID), isNotNull(flitoSyncFlit1Lectura.proximaPrevistaEn)));
      log.debug('lectura FLIT 1 automática: la fuente está apagada en este ambiente, no corre');
      return 'apagada';
    }
    const r = await conCandadoLecturaFlit1(() => corridaConCandado(ahora));
    if (!r.tomado) {
      log.info('lectura FLIT 1 automática: otra corrida tiene el candado, se salta este tick');
      return 'candado_ocupado';
    }
    return r.valor;
  } catch (e) {
    const codigo = codigoFalloFlit1(e);
    log.warn({ codigo }, 'lectura FLIT 1 automática interrumpida');
    return 'fallo';
  }
}
