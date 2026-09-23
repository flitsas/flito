// FLITO Impuestos — análisis post-envío en segundo plano (HU #12825, Épica #12809, Feature #12821).
//
// Al enviar impuestos al gestor, cada uno queda `analisis_estado = en_curso` DENTRO de la transacción
// del envío y, ya confirmada, se encola un job por id en una cola en memoria (AC1). El trabajo del job
// son PASOS que registran otras HUs (12826 extracción de la factura, 12827 semáforo contra el RUNT,
// 12828 autocertificación): esta HU solo pone la cola, el estado, la recuperación y el reintento.
//
// Reglas (AC):
//   AC2  Idempotencia: `analizado_en >= analisis_encolado_en` → el job no ejecuta ningún paso. El
//        reintento manual y la recuperación mueven `analisis_encolado_en` a «ahora», y por eso sí corren.
//   AC3  Las consultas al RUNT de los pasos van por `limitadorRunt` (tope global, compartido con la
//        certificación). Un paso que falla marca `error_analisis` en SU impuesto y no toca los demás.
//   AC4  `en_curso` > 10 min sin job vivo → se re-encola UNA vez; si vuelve a quedarse, error_analisis.
//   AC5  Reintento manual: solo `solicitado`, sin certificación vigente y con análisis terminado.
//
// Cola en memoria: la API corre en UN proceso (ver runt-limitador.ts). Nada de PII en los logs: solo
// el id del impuesto y el mensaje del error.

import { and, eq, gte, inArray, isNull, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoImpuestoCertificaciones, flitoImpuestos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  AnalisisEstadoImpuesto, CONCURRENCIA_CERTIFICACION, EstadoImpuesto, type ResultadoReanalisis,
} from '@operaciones/shared-types';
import { limitadorRunt, type LimitadorRunt } from './runt-limitador.js';

const log = loggerFor('flito-impuestos.analisis');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Un `en_curso` más viejo que esto, sin job vivo en el proceso, se considera huérfano (AC4). */
export const HUERFANO_ANALISIS_MS = 10 * 60_000;

/** Un paso del análisis. Lanza para marcar el impuesto `error_analisis`. */
export type PasoAnalisis = (c: { impuestoId: string; runt: LimitadorRunt }) => Promise<void>;

const pasos = new Map<string, PasoAnalisis>();

/** Punto de extensión: las HUs 12826/12827/12828 registran aquí sus pasos, en orden de registro. */
export function registrarPasoAnalisis(nombre: string, paso: PasoAnalisis): void {
  pasos.set(nombre, paso);
}

// ─────────────────────────────── Cola en memoria ───────────────────────────────

const pendientes: string[] = [];
/** Ids con job en la cola o corriendo: un id nunca tiene dos jobs a la vez en el proceso. */
const enCola = new Set<string>();
const corriendo = new Set<string>();
/** Ids re-encolados mientras su job corría: se vuelven a encolar al terminar (no se pierden). */
const repetir = new Set<string>();
let obreros = 0;
let drenadoProgramado = false;
let esperandoVacia: Array<() => void> = [];

/** Síncrona: no espera a nada. Descarta los ids que ya tienen job pendiente. */
export function encolarAnalisis(ids: string[]): void {
  for (const id of ids) {
    if (corriendo.has(id)) { repetir.add(id); continue; }
    if (enCola.has(id)) continue;
    enCola.add(id);
    pendientes.push(id);
  }
  if (pendientes.length > 0 && !drenadoProgramado) {
    drenadoProgramado = true;
    setImmediate(drenar);
  }
}

function drenar(): void {
  drenadoProgramado = false;
  while (obreros < CONCURRENCIA_CERTIFICACION && pendientes.length > 0) {
    const id = pendientes.shift()!;
    obreros++;
    corriendo.add(id);
    ejecutarAnalisis(id)
      .catch((e) => { log.warn({ impuestoId: id, err: (e as Error)?.message }, 'analisis: job falló fuera de los pasos'); })
      .finally(() => {
        obreros--;
        corriendo.delete(id);
        enCola.delete(id);
        if (repetir.delete(id)) encolarAnalisis([id]);
        if (pendientes.length > 0) drenar();
        else if (obreros === 0) { const w = esperandoVacia; esperandoVacia = []; w.forEach((r) => r()); }
      });
  }
}

/** Solo tests: resuelve cuando la cola no tiene jobs pendientes ni corriendo. */
export function __colaAnalisisVacia(): Promise<void> {
  if (obreros === 0 && pendientes.length === 0 && !drenadoProgramado) return Promise.resolve();
  return new Promise((r) => { esperandoVacia.push(r); });
}

/** Solo tests. */
export function __resetColaAnalisis(): void {
  pendientes.length = 0;
  enCola.clear(); corriendo.clear(); repetir.clear(); pasos.clear();
  obreros = 0; drenadoProgramado = false; esperandoVacia = [];
}

// ─────────────────────────────── Job ───────────────────────────────

const enCursoDe = (id: string): SQL =>
  and(eq(flitoImpuestos.id, id), eq(flitoImpuestos.analisisEstado, AnalisisEstadoImpuesto.EN_CURSO))!;

export async function ejecutarAnalisis(id: string): Promise<'completado' | 'error_analisis' | 'omitido'> {
  const [fila] = await db.select({
    analisisEstado: flitoImpuestos.analisisEstado,
    analisisEncoladoEn: flitoImpuestos.analisisEncoladoEn,
    analizadoEn: flitoImpuestos.analizadoEn,
  }).from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);

  if (!fila || fila.analisisEstado !== AnalisisEstadoImpuesto.EN_CURSO) return 'omitido';
  // AC2: ya analizado después del último encolado explícito → ni OCR ni RUNT.
  if (fila.analizadoEn && fila.analisisEncoladoEn && fila.analizadoEn >= fila.analisisEncoladoEn) return 'omitido';

  let corridos = 0;
  for (const [nombre, paso] of pasos) {
    try {
      await paso({ impuestoId: id, runt: limitadorRunt });
      corridos++;
    } catch (e) {
      log.warn({ impuestoId: id, paso: nombre, err: (e as Error)?.message }, 'analisis: paso falló');
      await db.update(flitoImpuestos).set({ analisisEstado: AnalisisEstadoImpuesto.ERROR }).where(enCursoDe(id));
      return 'error_analisis';
    }
  }

  // Sin pasos (esta HU, antes de la 12826) `analizado_en` NO se escribe: si no, los impuestos
  // enviados en ese intervalo quedarían «ya analizados» sin haberlo sido.
  await db.update(flitoImpuestos).set({
    analisisEstado: AnalisisEstadoImpuesto.COMPLETADO,
    ...(corridos > 0 ? { analizadoEn: new Date() } : {}),
  }).where(enCursoDe(id));
  return 'completado';
}

// ─────────────────────────────── Envío (AC1) ───────────────────────────────

/**
 * Dentro de la transacción del envío: pone `en_curso` a los que nunca se analizaron y devuelve sus
 * ids, que el llamador encola DESPUÉS del commit. Los ya analizados (reenvío tras reversa) no se tocan.
 */
export async function marcarEnCursoEnTx(
  tx: Tx, filas: ReadonlyArray<{ id: string; analizadoEn: Date | null }>, ahora: Date,
): Promise<string[]> {
  const ids = filas.filter((f) => !f.analizadoEn).map((f) => f.id);
  if (ids.length === 0) return [];
  await tx.update(flitoImpuestos).set({
    analisisEstado: AnalisisEstadoImpuesto.EN_CURSO, analisisEncoladoEn: ahora, analisisReencolados: 0,
  }).where(and(inArray(flitoImpuestos.id, ids), isNull(flitoImpuestos.analizadoEn)));
  return ids;
}

// ─────────────────────────────── Recuperación (AC4) ───────────────────────────────

/** Condiciones del barrido. Exportada para asertar el SQL renderizado sin base. */
export function condicionesHuerfanos(ahora: Date, vivos: readonly string[], yaReencolado: boolean): SQL {
  const corte = new Date(ahora.getTime() - HUERFANO_ANALISIS_MS);
  return and(
    eq(flitoImpuestos.analisisEstado, AnalisisEstadoImpuesto.EN_CURSO),
    lt(flitoImpuestos.analisisEncoladoEn, corte),
    yaReencolado ? gte(flitoImpuestos.analisisReencolados, 1) : eq(flitoImpuestos.analisisReencolados, 0),
    // Un job lento pero vivo en este proceso no es huérfano.
    ...(vivos.length > 0 ? [notInArray(flitoImpuestos.id, [...vivos])] : []),
  )!;
}

export async function barrerAnalisisHuerfanos(ahora = new Date()): Promise<{ reencolados: number; fallidos: number }> {
  const vivos = [...enCola];
  // 1) Ya se re-encoló una vez y volvió a quedarse: error, y no se re-encola solo.
  const fallidos = await db.update(flitoImpuestos)
    .set({ analisisEstado: AnalisisEstadoImpuesto.ERROR })
    .where(condicionesHuerfanos(ahora, vivos, true))
    .returning({ id: flitoImpuestos.id });
  // 2) Primera vez: se re-encola una sola vez.
  const reencolados = await db.update(flitoImpuestos)
    .set({ analisisReencolados: sql`${flitoImpuestos.analisisReencolados} + 1`, analisisEncoladoEn: ahora })
    .where(condicionesHuerfanos(ahora, vivos, false))
    .returning({ id: flitoImpuestos.id });
  encolarAnalisis(reencolados.map((r) => r.id));
  return { reencolados: reencolados.length, fallidos: fallidos.length };
}

// ─────────────────────────────── Reintento manual (AC5) ───────────────────────────────

const ANALISIS_TERMINADO = [AnalisisEstadoImpuesto.COMPLETADO, AnalisisEstadoImpuesto.ERROR];

/**
 * «Reintentar validación». La frontera (404 si no es suyo) la pone la ruta con `buscarConAcceso`
 * ANTES de llamar aquí. El `UPDATE` condicional es el que decide: dos usuarios a la vez no encolan
 * dos jobs, porque solo uno encuentra la fila en un estado terminado.
 */
export async function reanalizarImpuesto(id: string, ahora = new Date()): Promise<ResultadoReanalisis> {
  const [imp] = await db.select({ estado: flitoImpuestos.estado, analisisEstado: flitoImpuestos.analisisEstado })
    .from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) return { resultado: 'NO_ENCONTRADO' };
  if (imp.estado !== EstadoImpuesto.SOLICITADO) return { resultado: 'NO_SOLICITADO' };
  if (imp.analisisEstado === null) return { resultado: 'SIN_ANALISIS' };
  if (imp.analisisEstado === AnalisisEstadoImpuesto.EN_CURSO) return { resultado: 'ANALISIS_EN_CURSO' };

  const [cert] = await db.select({ id: flitoImpuestoCertificaciones.id }).from(flitoImpuestoCertificaciones)
    .where(and(eq(flitoImpuestoCertificaciones.impuestoId, id), eq(flitoImpuestoCertificaciones.vigente, true)))
    .limit(1);
  if (cert) return { resultado: 'YA_CERTIFICADO' };

  const filas = await db.update(flitoImpuestos).set({
    analisisEstado: AnalisisEstadoImpuesto.EN_CURSO, analisisEncoladoEn: ahora, analisisReencolados: 0,
  }).where(and(
    eq(flitoImpuestos.id, id),
    eq(flitoImpuestos.estado, EstadoImpuesto.SOLICITADO),
    inArray(flitoImpuestos.analisisEstado, ANALISIS_TERMINADO),
  )).returning({ id: flitoImpuestos.id });
  // 0 filas: otro usuario lo encoló entre la lectura y el UPDATE.
  if (filas.length === 0) return { resultado: 'ANALISIS_EN_CURSO' };

  encolarAnalisis([id]);
  return { resultado: 'ENCOLADO', id, analisisEstado: AnalisisEstadoImpuesto.EN_CURSO };
}
