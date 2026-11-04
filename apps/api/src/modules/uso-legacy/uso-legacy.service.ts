// HU #13989 (Feature #13980, Épica #14272, ADR-0033) — conteo de uso de las rutas legacy `soat`,
// `tramites` y `liquidacion`, en agregados diarios. Módulo TEMPORAL: alimenta el ADR de la HU #13990.
// Retirarlo es borrar este directorio, sus líneas en `app.ts`, `server.ts`, `metrics.ts` y `env.ts`, y
// una migración nueva con DROP TABLE (máximo 6 meses desde el primer despliegue en PDN).
//
// Cómo leer el dato:
//   · `publico` en una ruta autenticada es un RECHAZO, no un uso anónimo. `identidad.routes.ts` monta
//     `authMiddleware` por ruta y por eso sus 401 sí traen patrón.
//   · `(sin_ruta)` agrupa 401 y 403 de frontera a nivel de router, y 404. La cardinalidad queda acotada
//     (máximo 7 prefijos × 6 métodos × consumidores) aunque se barran URL al azar.
//   · `total` cuenta peticiones, no éxitos: un 403 de `exigirFuncion` lleva patrón y suma.
//   · Una ruta sin tráfico no aparece: «sin uso» exige cruzar con el inventario de rutas declaradas.
//   · El dato llega con hasta 60 s de retraso por réplica.
//
// Garantía para la petición: nada de aquí rechaza ni se espera desde una ruta. La tabla y las métricas
// se tocan solo dentro de `try/catch`, porque varios tests mockean `schema.js` o `metrics.js` a medias.
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { usoLegacyDiario } from '../../db/schema/uso-legacy.js';
import { loggerFor } from '../../shared/logger.js';
import { usoLegacyConteosDescartadosTotal, usoLegacyFlushTotal } from '../../shared/metrics.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';

const log = loggerFor('uso-legacy');

export const MODULOS_USO_LEGACY = ['soat', 'tramites', 'liquidacion'] as const;
export type ModuloUsoLegacy = (typeof MODULOS_USO_LEGACY)[number];

export const CONSUMIDOR_PUBLICO = 'publico';
export const RUTA_SIN_PATRON = '(sin_ruta)';
export const INTERVALO_FLUSH_MS = 60_000;
export const TOPE_CLAVES = 5000;
export const TIMEOUT_FLUSH_MS = 10_000;
export const TIMEOUT_CIERRE_MS = 5000;
export const TOPE_FILAS_CONSULTA = 2000;

const LARGO_MAXIMO_PATRON = 200;
const METODOS_CONOCIDOS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const SEPARADOR = '\t';

// De módulo a propósito: `hoyColombia()` construye el formateador en cada llamada y esto corre por petición.
const FORMATO_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
});

let buffer = new Map<string, number>();
let flushEnCurso: Promise<void> | null = null;
let temporizador: ReturnType<typeof setInterval> | null = null;

export interface ConteoUsoLegacy {
  prefijo: string;
  modulo: ModuloUsoLegacy;
  /** `req.route?.path`: puede faltar, o no ser string (arreglo o RegExp). */
  patron: unknown;
  metodo: string;
  consumidor: string | undefined;
}

function medir(fn: () => void): void {
  try { fn(); } catch { /* una métrica nunca cuesta un conteo ni una petición */ }
}

function rutaDe(prefijo: string, patron: unknown): string {
  if (typeof patron !== 'string' || patron.length > LARGO_MAXIMO_PATRON) return `${prefijo}/${RUTA_SIN_PATRON}`;
  return patron === '/' ? prefijo : `${prefijo}${patron}`;
}

/** Suma `n` a la clave. Pasado el tope, una clave nueva se descarta y se mide; las existentes siguen sumando. */
function sumar(clave: string, n: number): void {
  const actual = buffer.get(clave);
  if (actual !== undefined) { buffer.set(clave, actual + n); return; }
  if (buffer.size >= TOPE_CLAVES) {
    medir(() => usoLegacyConteosDescartadosTotal.inc(n));
    return;
  }
  buffer.set(clave, n);
}

function armarTemporizador(): void {
  if (temporizador) return;
  temporizador = setInterval(() => { void flushUsoLegacy(); }, INTERVALO_FLUSH_MS);
  temporizador.unref();
}

/** Registra una petición en el buffer del proceso. El `dia` es el de Colombia en este momento, no el del flush. */
export function acumular(conteo: ConteoUsoLegacy, ahora: Date = new Date()): void {
  const metodo = METODOS_CONOCIDOS.has(conteo.metodo) ? conteo.metodo : 'OTRO';
  const clave = [
    FORMATO_DIA.format(ahora), conteo.modulo, rutaDe(conteo.prefijo, conteo.patron), metodo, conteo.consumidor || CONSUMIDOR_PUBLICO,
  ].join(SEPARADOR);
  sumar(clave, 1);
  armarTemporizador();
}

function filaDe(clave: string, total: number) {
  const [dia, modulo, ruta, metodo, consumidor] = clave.split(SEPARADOR) as [string, string, string, string, string];
  return { dia, modulo, ruta, metodo, consumidor, total };
}

/** Solo el código del error: el mensaje de la query lleva sus parámetros, que son rutas y roles. */
function codigoDeError(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? 'desconocido');
}

async function escribirLote(lote: Map<string, number>): Promise<void> {
  let tope: ReturnType<typeof setTimeout> | undefined;
  try {
    // Claves ordenadas: dos réplicas toman los bloqueos en el mismo orden y no hay deadlock.
    const filas = [...lote.keys()].sort().map((clave) => filaDe(clave, lote.get(clave)!));
    const insercion = db.insert(usoLegacyDiario).values(filas).onConflictDoUpdate({
      target: [usoLegacyDiario.dia, usoLegacyDiario.modulo, usoLegacyDiario.ruta, usoLegacyDiario.metodo, usoLegacyDiario.consumidor],
      set: { total: sql`${usoLegacyDiario.total} + excluded.total` },
    });
    await Promise.race([
      insercion,
      new Promise((_, rechazar) => {
        tope = setTimeout(() => rechazar(new Error('timeout')), TIMEOUT_FLUSH_MS);
      }),
    ]);
    medir(() => usoLegacyFlushTotal.inc({ resultado: 'ok' }));
  } catch (e) {
    // Si un timeout llegó a confirmar en BD, ese lote se cuenta doble. Aceptado: #13990 decide por orden de magnitud.
    let conteos = 0;
    for (const [clave, n] of lote) { sumar(clave, n); conteos += n; }
    medir(() => usoLegacyFlushTotal.inc({ resultado: 'error' }));
    medir(() => log.warn({ err: codigoDeError(e), claves: lote.size, conteos }, 'flush de uso legacy fallido; lote reintegrado'));
  } finally {
    clearTimeout(tope);
  }
}

/**
 * Vuelca el buffer en UNA sentencia. Nunca rechaza y ninguna ruta espera por él. Un flush en curso impide
 * otro: quien llega durante uno recibe esa misma promesa.
 */
export function flushUsoLegacy(): Promise<void> {
  if (flushEnCurso) return flushEnCurso;
  if (buffer.size === 0) return Promise.resolve();
  const lote = buffer;
  buffer = new Map();
  flushEnCurso = escribirLote(lote).finally(() => { flushEnCurso = null; });
  return flushEnCurso;
}

/** Último paso del apagado: para el temporizador y hace el flush final, con tope de 5 s. Nunca rechaza. */
export async function cerrarUsoLegacy(): Promise<void> {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  let tope: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // El primero espera al que esté en curso (el de la señal); el segundo lleva lo contado después.
      flushUsoLegacy().then(() => flushUsoLegacy()),
      new Promise<void>((resolver) => { tope = setTimeout(resolver, TIMEOUT_CIERRE_MS); }),
    ]);
  } catch { /* nunca rechaza: el apagado sigue */ } finally {
    clearTimeout(tope);
  }
}

export interface FiltroUsoLegacy {
  desde: string;
  hasta: string;
  modulo?: ModuloUsoLegacy;
}

export interface FilaUsoLegacy {
  modulo: string;
  ruta: string;
  metodo: string;
  consumidor: string;
  total: number;
  primerDia: string;
  ultimoDia: string;
}

/** Uso agregado sobre el rango. Pide una fila de más para saber si el tope truncó el resultado. */
export async function consultarUso(filtro: FiltroUsoLegacy): Promise<{ filas: FilaUsoLegacy[]; truncado: boolean }> {
  const t = usoLegacyDiario;
  const condiciones: SQL[] = [gte(t.dia, filtro.desde), lte(t.dia, filtro.hasta)];
  if (filtro.modulo) condiciones.push(eq(t.modulo, filtro.modulo));
  const total = sql<number>`sum(${t.total})::bigint`.mapWith(Number);
  const filas = await db
    .select({
      modulo: t.modulo,
      ruta: t.ruta,
      metodo: t.metodo,
      consumidor: t.consumidor,
      total,
      primerDia: sql<string>`min(${t.dia})::text`,
      ultimoDia: sql<string>`max(${t.dia})::text`,
    })
    .from(t)
    .where(and(...condiciones))
    .groupBy(t.modulo, t.ruta, t.metodo, t.consumidor)
    .orderBy(sql`sum(${t.total}) DESC`, asc(t.modulo), asc(t.ruta), asc(t.metodo), asc(t.consumidor))
    .limit(TOPE_FILAS_CONSULTA + 1);
  return { filas: filas.slice(0, TOPE_FILAS_CONSULTA), truncado: filas.length > TOPE_FILAS_CONSULTA };
}

/** Solo para tests: foto del buffer y reinicio del estado de módulo. */
export function _bufferUsoLegacy(): ReadonlyMap<string, number> { return buffer; }
export function _reiniciarUsoLegacy(): void {
  buffer = new Map();
  flushEnCurso = null;
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
}
