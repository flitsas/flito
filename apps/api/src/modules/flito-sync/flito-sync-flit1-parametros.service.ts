// FLITO sync — parámetros de la lectura automática de FLIT 1 (HU #13628, Feature #13612, Épica #13576).
// Diseño: `docs/diseno/hu-13628-parametros-lectura-flit1.md`. Tabla `flito_sync_flit1_lectura` (0241).
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Una fila (`id = 1`), sembrada por la migración con los defaults (2 min · 7 días · 60 días ·
//        arranque null). Propia de cada ambiente: vive en la base, sobrevive a reinicios y despliegues.
// RN-02  Fila ausente = defaults y se registra un `warn` sin PII. Un ERROR de base al leer no se traga.
// RN-03  `arranque` null = «hoy − 1 mes» en America/Bogota, calculado AL LEER (nunca la hora local del
//        servidor). Si el día no existe en el mes anterior se ajusta a su último día (31/03 → 28/02).
// RN-04  Límites (shared-types `LIMITES_PARAMETROS_LECTURA_FLIT1`): frecuencia 2–60 min, ventana 1–90
//        días, nocturna 7–90 días y nocturna ≥ ventana. Arranque `YYYY-MM-DD` real y ≤ hoy (Bogotá).
//        Un 400 no escribe nada. La base repite los rangos como CHECK; si uno salta es un bug (500).
// RN-05  Guardar (PUT) lee los valores anteriores con `FOR UPDATE` y escribe en la misma transacción:
//        dos PUT a la vez se serializan y cada uno conoce su par anterior/nuevo para la auditoría (AC7).
//        Guardar los mismos valores también escribe (quién y cuándo) y también se audita.
// RN-06  El PUT solo toca los cuatro parámetros y `parametros_actualizados_*`. Las columnas de estado
//        (`ultima_buena_en`, `proxima_prevista_en`, `ultimo_fallo_*`) las escribe la HU #13629.
// RN-07  El estado (AC8) se expone tal cual: los tres vacíos antes de la primera corrida. No se lee
//        `system_kv['flito.ultima_sincronizacion']` como respaldo (decisión de la HU #13629).

import { eq } from 'drizzle-orm';
import {
  DEFAULTS_PARAMETROS_LECTURA_FLIT1, LIMITES_PARAMETROS_LECTURA_FLIT1,
  type EstadoLecturaFlit1, type ParametrosLecturaFlit1, type ParametrosLecturaFlit1Input,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSyncFlit1Lectura, users } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';

const log = loggerFor('flito-sync-flit1-parametros');

const ID = 1;

/** Los cuatro valores guardados. `arranque` null = nunca guardado (RN-03). */
export interface ValoresParametrosFlit1 {
  frecuenciaMinutos: number;
  ventanaDias: number;
  ventanaNocturnaDias: number;
  arranque: string | null;
}

const VALORES_POR_DEFECTO: ValoresParametrosFlit1 = { ...DEFAULTS_PARAMETROS_LECTURA_FLIT1, arranque: null };

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dos = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` que existe en el calendario (rechaza `2026-02-30`). */
export function esFechaReal(v: string): boolean {
  const m = FECHA_RE.exec(v);
  if (!m) return false;
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mes - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d;
}

/** RN-03: hoy (`YYYY-MM-DD`, ya en Bogotá) menos un mes, con ajuste al último día del mes anterior. */
export function arranquePorDefecto(hoy: string): string {
  const m = FECHA_RE.exec(hoy);
  if (!m) throw new Error('arranquePorDefecto: fecha inválida');
  let y = Number(m[1]);
  let mes = Number(m[2]) - 1; // mes anterior, 1-based
  if (mes === 0) { mes = 12; y -= 1; }
  const ultimo = new Date(Date.UTC(y, mes, 0)).getUTCDate();
  return `${y}-${dos(mes)}-${dos(Math.min(Number(m[3]), ultimo))}`;
}

export interface ProblemaParametro { campo: keyof ParametrosLecturaFlit1Input; mensaje: string }

/**
 * Reglas que Zod no expresa (RN-04): arranque real y no futuro, nocturna ≥ ventana. Se llama con los
 * tipos y rangos ya validados. Orden fijo para que `campos` sea determinista. Nunca repite lo recibido.
 */
export function problemasParametrosFlit1(v: ParametrosLecturaFlit1Input, hoy: string): ProblemaParametro[] {
  const out: ProblemaParametro[] = [];
  if (!esFechaReal(v.arranque)) {
    out.push({ campo: 'arranque', mensaje: 'arranque debe ser una fecha real con formato AAAA-MM-DD.' });
  } else if (v.arranque > hoy) {
    out.push({ campo: 'arranque', mensaje: 'arranque no puede ser una fecha futura.' });
  }
  if (v.ventanaNocturnaDias < v.ventanaDias) {
    out.push({ campo: 'ventanaNocturnaDias', mensaje: 'La nocturna no puede ser menor que la ventana: ventanaNocturnaDias debe ser mayor o igual que ventanaDias.' });
  }
  return out;
}

/** Mensaje de rango de un campo numérico, leído de las constantes compartidas. */
export function mensajeRango(campo: keyof typeof LIMITES_PARAMETROS_LECTURA_FLIT1): string {
  const { min, max } = LIMITES_PARAMETROS_LECTURA_FLIT1[campo];
  return `${campo} debe ser un número entero entre ${min} y ${max}.`;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Proyección explícita: los parámetros y su autor. Nada de las columnas de estado. */
async function leerFila() {
  const [fila] = await db.select({
    frecuenciaMinutos: flitoSyncFlit1Lectura.frecuenciaMinutos,
    ventanaDias: flitoSyncFlit1Lectura.ventanaDias,
    ventanaNocturnaDias: flitoSyncFlit1Lectura.ventanaNocturnaDias,
    arranque: flitoSyncFlit1Lectura.arranque,
    actualizadoEn: flitoSyncFlit1Lectura.parametrosActualizadosEn,
    autorId: users.id,
    autorNombre: users.name,
  }).from(flitoSyncFlit1Lectura)
    .leftJoin(users, eq(users.id, flitoSyncFlit1Lectura.parametrosActualizadosPor))
    .where(eq(flitoSyncFlit1Lectura.id, ID))
    .limit(1);
  return fila;
}

type FilaParametros = Awaited<ReturnType<typeof leerFila>>;

function aParametros(fila: FilaParametros | undefined, ahora: Date): ParametrosLecturaFlit1 {
  if (!fila) log.warn('parámetros de lectura de FLIT 1 sin fila: se informan los valores por defecto');
  const arranque = fila?.arranque ?? null;
  return {
    frecuenciaMinutos: fila?.frecuenciaMinutos ?? VALORES_POR_DEFECTO.frecuenciaMinutos,
    ventanaDias: fila?.ventanaDias ?? VALORES_POR_DEFECTO.ventanaDias,
    ventanaNocturnaDias: fila?.ventanaNocturnaDias ?? VALORES_POR_DEFECTO.ventanaNocturnaDias,
    arranque: arranque ?? arranquePorDefecto(hoyColombia(ahora)),
    arranquePorDefecto: arranque === null,
    actualizadoEn: iso(fila?.actualizadoEn),
    actualizadoPor: fila && fila.autorId !== null && fila.autorNombre !== null
      ? { id: fila.autorId, nombre: fila.autorNombre }
      : null,
  };
}

/** `GET /flit1/parametros-lectura` (AC1). */
export async function leerParametrosLecturaFlit1(ahora: Date = new Date()): Promise<ParametrosLecturaFlit1> {
  return aParametros(await leerFila(), ahora);
}

/** `PUT /flit1/parametros-lectura` (AC2, RN-05, RN-06). Devuelve los valores anteriores y los persistidos. */
export async function guardarParametrosLecturaFlit1(
  nuevo: ParametrosLecturaFlit1Input, userId: number | null,
): Promise<{ anterior: ValoresParametrosFlit1; actual: ParametrosLecturaFlit1 }> {
  const anterior = await db.transaction(async (tx) => {
    const [previa] = await tx.select({
      frecuenciaMinutos: flitoSyncFlit1Lectura.frecuenciaMinutos,
      ventanaDias: flitoSyncFlit1Lectura.ventanaDias,
      ventanaNocturnaDias: flitoSyncFlit1Lectura.ventanaNocturnaDias,
      arranque: flitoSyncFlit1Lectura.arranque,
    }).from(flitoSyncFlit1Lectura).where(eq(flitoSyncFlit1Lectura.id, ID)).for('update');
    const ahora = new Date();
    const valores = {
      frecuenciaMinutos: nuevo.frecuenciaMinutos,
      ventanaDias: nuevo.ventanaDias,
      ventanaNocturnaDias: nuevo.ventanaNocturnaDias,
      arranque: nuevo.arranque,
      parametrosActualizadosEn: ahora,
      parametrosActualizadosPor: userId,
    };
    // Fila ausente (alguien la borró a mano): se recrea; el anterior son los defaults sembrados.
    await tx.insert(flitoSyncFlit1Lectura)
      .values({ id: ID, ...valores })
      .onConflictDoUpdate({ target: flitoSyncFlit1Lectura.id, set: valores });
    return previa ?? VALORES_POR_DEFECTO;
  });
  return { anterior, actual: aParametros(await leerFila(), new Date()) };
}

/** Detalle de auditoría (AC7): los cuatro pares anterior → nuevo. Sin nombres ni datos de persona. */
export function detalleAuditoriaParametrosFlit1(anterior: ValoresParametrosFlit1, nuevo: ParametrosLecturaFlit1Input): string {
  const arr = (v: string | null) => v ?? '(hace 1 mes)';
  const pares = [
    `frecuenciaMinutos ${anterior.frecuenciaMinutos} → ${nuevo.frecuenciaMinutos}`,
    `ventanaDias ${anterior.ventanaDias} → ${nuevo.ventanaDias}`,
    `ventanaNocturnaDias ${anterior.ventanaNocturnaDias} → ${nuevo.ventanaNocturnaDias}`,
    `arranque ${arr(anterior.arranque)} → ${nuevo.arranque}`,
  ];
  const igual = anterior.frecuenciaMinutos === nuevo.frecuenciaMinutos && anterior.ventanaDias === nuevo.ventanaDias
    && anterior.ventanaNocturnaDias === nuevo.ventanaNocturnaDias && anterior.arranque === nuevo.arranque;
  return `Parámetros de lectura de FLIT 1: ${pares.join('; ')}${igual ? ' (sin cambio)' : ''}`;
}

/** `GET /flit1/estado-lectura` (AC8, RN-07). Fila ausente = los tres vacíos. */
export async function leerEstadoLecturaFlit1(): Promise<EstadoLecturaFlit1> {
  const [fila] = await db.select({
    ultimaBuenaEn: flitoSyncFlit1Lectura.ultimaBuenaEn,
    proximaPrevistaEn: flitoSyncFlit1Lectura.proximaPrevistaEn,
    ultimoFalloEn: flitoSyncFlit1Lectura.ultimoFalloEn,
    ultimoFalloCodigo: flitoSyncFlit1Lectura.ultimoFalloCodigo,
  }).from(flitoSyncFlit1Lectura).where(eq(flitoSyncFlit1Lectura.id, ID)).limit(1);
  if (!fila) log.warn('estado de lectura de FLIT 1 sin fila: se informa vacío');
  const falloEn = iso(fila?.ultimoFalloEn);
  return {
    ultimaLecturaBuenaEn: iso(fila?.ultimaBuenaEn),
    proximaLecturaPrevistaEn: iso(fila?.proximaPrevistaEn),
    ultimoFallo: falloEn && fila?.ultimoFalloCodigo ? { en: falloEn, codigo: fila.ultimoFalloCodigo } : null,
  };
}
