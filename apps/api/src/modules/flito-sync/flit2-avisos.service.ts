// HU #13632 (Feature #13613, Épica #13576) — avisos firmados de FLIT 2: verificación, agenda de la lectura
// y marcas del canal. Diseño: docs/diseno/hu-13632-avisos-flit2.md (decisiones A1, B1, C2).
//
// FLIT 2 avisa que un trámite cambió; FLITO responde 200 de inmediato y agenda la MISMA lectura incremental
// del cron (`leerConCandado('aviso')`). El aviso es un timbre, no el dato: no trae PII.
//
// Reglas de este archivo:
//   RN-01 Firma: HMAC-SHA256 de los bytes exactos del cuerpo, clave = bytes UTF-8 del secreto tal cual (sin
//         trim; confirmado con FLIT 2). Comparación en tiempo constante. Nunca se loguean cuerpo, firma ni secreto.
//   RN-02 Agrupación (AC5): ventana FIJA de 6 s desde el primer aviso del lote; una lectura por ventana. Los
//         avisos que llegan durante una lectura forman el lote siguiente: exactamente una lectura más.
//   RN-03 Dedup (AC6): `eventId` ya visto, o `syncVersion <= máxima vista` del mismo `id` → duplicado. TTL de
//         15 min y tope de 10 000 entradas por mapa. Pasado el TTL lo frena la comprobación previa en base.
//   RN-04 Comprobación en base (B1): antes de leer y después de leer, `flito_tramites.sync_version >= V`. Los
//         `eliminado: true` no se verifican (un tombstone nunca se escribe): solo disparan la lectura.
//   RN-05 AC7: hasta 2 reintentos a 5 s del fin de la lectura, solo con los faltantes. Después queda para el
//         cron (respaldo), con log `info` del conteo y sin ids.
//   RN-06 Candado ocupado (`Flit2LecturaEnCursoError`) = pendiente: reintento cada 5 s hasta LIMITE_CRON_MS +
//         30 s; agotado, queda para el cron. Fuente apagada o `Flit2Error` → se descarta el lote. La agenda
//         nunca lanza.
//   RN-07 Marcas (C2): rechazos y `ultimo_aviso_en` se acumulan en memoria y se vuelcan con UN `UPDATE` como
//         mucho cada 5 s por proceso, fuera de la respuesta. Firma válida → contador a 0.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { flitoSyncFlit2Lectura, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { LIMITE_CRON_MS, leerConCandado } from './flit2-lectura.service.js';
import { Flit2Error, Flit2LecturaEnCursoError } from './flit2.errors.js';
import { FuenteApagadaError, fuenteHabilitada } from './flito-sync-interruptor.service.js';

const log = loggerFor('flito-sync-flit2-avisos');

export const VENTANA_MS = 6_000;
export const REINTENTO_MS = 5_000;
export const REINTENTOS_VERIFICACION = 2;
/** Lo máximo que otra corrida sostiene el candado. Función (no constante) para no leer el import al cargar. */
export const enCursoMaxMs = (): number => LIMITE_CRON_MS + 30_000;
export const DEDUP_TTL_MS = 15 * 60_000;
export const DEDUP_TOPE = 10_000;
export const VOLCADO_MS = 5_000;
export const SECRETO_MIN = 32;
export const TIPO_CAMBIO = 'tramite.cambio';

// ── Configuración y firma ────────────────────────────────────────────────────────────────────────

/** Secreto utilizable o null (deshabilitado, ausente o corto → 404, AC3). Se lee en cada petición. */
export function secretoAvisos(): string | null {
  if (!env.FLIT2_AVISOS_HABILITADO) return null;
  const s = env.FLIT2_AVISOS_SECRETO;
  return s && s.length >= SECRETO_MIN ? s : null;
}

/** Un único `warn` al arrancar si la configuración no sirve. Nunca incluye el valor del secreto. */
export function avisarConfiguracionAvisos(): void {
  if (!env.FLIT2_AVISOS_HABILITADO) return;
  const s = env.FLIT2_AVISOS_SECRETO;
  if (!s || s.length < SECRETO_MIN) {
    log.warn({ minimo: SECRETO_MIN }, 'avisos de FLIT 2 habilitados sin secreto utilizable: el endpoint responde 404');
  } else if (s !== s.trim()) {
    log.warn('el secreto de avisos de FLIT 2 tiene espacios al inicio o al final: se usa tal cual (sin trim)');
  }
}

/**
 * Bytes de la clave HMAC. FLIT 2 usa los bytes UTF-8 del string tal cual, sin decodificar ni recortar
 * (confirmado contra su código). Si eso cambia, se cambia aquí y en ningún otro sitio.
 */
export function claveHmac(secreto: string): Buffer {
  return Buffer.from(secreto, 'utf8');
}

export type MotivoFirma = 'ausente' | 'mal_formada' | 'incorrecta';
export type ResultadoFirma = { ok: true } | { ok: false; motivo: MotivoFirma };

// Solo `sha256=` + 64 hex en minúsculas: el único formato que emite FLIT 2.
const RE_FIRMA = /^sha256=([0-9a-f]{64})$/;

/** Verifica `X-Webhook-Signature` sobre el cuerpo crudo. Pura; tiempo constante sobre buffers de 32 bytes. */
export function verificarFirmaAviso(
  cuerpo: Buffer, cabecera: string | string[] | undefined, secreto: string,
): ResultadoFirma {
  if (cabecera === undefined || cabecera === '') return { ok: false, motivo: 'ausente' };
  if (typeof cabecera !== 'string') return { ok: false, motivo: 'mal_formada' };
  const m = RE_FIRMA.exec(cabecera);
  if (!m) return { ok: false, motivo: 'mal_formada' };
  const esperado = createHmac('sha256', claveHmac(secreto)).update(cuerpo).digest();
  const recibido = Buffer.from(m[1]!, 'hex');
  return timingSafeEqual(esperado, recibido) ? { ok: true } : { ok: false, motivo: 'incorrecta' };
}

// ── Esquema del aviso ────────────────────────────────────────────────────────────────────────────

export const avisoFlit2Schema = z.object({
  eventId: z.string().uuid(),
  tipo: z.string().min(1).max(64),
  id: z.string().uuid(),
  syncVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fechaUltimoCambio: z.string().datetime({ offset: true }),
  eliminado: z.boolean(),
  tenantId: z.unknown().optional(),
});
export type AvisoFlit2 = z.infer<typeof avisoFlit2Schema>;

// ── Marcas del canal (C2) ────────────────────────────────────────────────────────────────────────

interface Marcas { delta: number; reiniciar: boolean; ultimoAvisoEn: Date | null }
const marcasVacias = (): Marcas => ({ delta: 0, reiniciar: false, ultimoAvisoEn: null });
const hayMarcas = (m: Marcas) => m.delta > 0 || m.reiniciar || m.ultimoAvisoEn !== null;

let marcas = marcasVacias();
let timerVolcado: ReturnType<typeof setTimeout> | null = null;

function programarVolcado(): void {
  if (timerVolcado) return;
  timerVolcado = setTimeout(() => { timerVolcado = null; void volcarMarcas(); }, VOLCADO_MS);
  timerVolcado.unref?.();
}

/** Firma inválida: +1 al contador (AC2). */
export function anotarRechazo(): void {
  marcas.delta += 1;
  programarVolcado();
}

/** Firma válida: el contador vuelve a 0 (los rechazos anteriores dejan de ser «seguidos»). */
export function anotarFirmaValida(): void {
  marcas.reiniciar = true;
  marcas.delta = 0;
  programarVolcado();
}

/** Cuerpo válido (cualquier tipo): fija `ultimo_aviso_en`. */
export function anotarAvisoValido(ahora: Date = new Date()): void {
  if (!marcas.ultimoAvisoEn || ahora > marcas.ultimoAvisoEn) marcas.ultimoAvisoEn = ahora;
  programarVolcado();
}

/** Un solo UPDATE con lo acumulado. Si falla, se conserva para el siguiente volcado (sin valores en el log). */
export async function volcarMarcas(): Promise<void> {
  if (!hayMarcas(marcas)) return;
  const m = marcas;
  marcas = marcasVacias();
  const col = flitoSyncFlit2Lectura.rechazosFirmaSeguidos;
  const colAviso = flitoSyncFlit2Lectura.ultimoAvisoEn;
  const t = m.ultimoAvisoEn?.toISOString() ?? null;
  try {
    await db.update(flitoSyncFlit2Lectura).set({
      rechazosFirmaSeguidos: m.reiniciar
        ? sql`${m.delta}::int`
        : sql`LEAST(${col}::bigint + ${m.delta}::bigint, 2147483647)::int`,
      ...(t ? { ultimoAvisoEn: sql`GREATEST(COALESCE(${colAviso}, ${t}::timestamptz), ${t}::timestamptz)` } : {}),
    }).where(eq(flitoSyncFlit2Lectura.id, 1));
  } catch (e) {
    // Lo nuevo (posterior al fallo) manda sobre lo viejo: un reinicio nuevo anula los rechazos previos.
    marcas = marcas.reiniciar
      ? { ...marcas, ultimoAvisoEn: maxFecha(marcas.ultimoAvisoEn, m.ultimoAvisoEn) }
      : { delta: m.delta + marcas.delta, reiniciar: m.reiniciar, ultimoAvisoEn: maxFecha(marcas.ultimoAvisoEn, m.ultimoAvisoEn) };
    log.warn({ err: (e as Error)?.name }, 'no se pudieron volcar las marcas de avisos de FLIT 2; se reintenta');
    programarVolcado();
  }
}

function maxFecha(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ── Comprobación en base (B1) ────────────────────────────────────────────────────────────────────

/** De las `(id, versión)` pedidas, las que FLITO aún no tiene (`sync_version < V` o sin fila). */
export async function versionesSinAplicar(pedidas: Map<string, number>): Promise<Map<string, number>> {
  if (pedidas.size === 0) return new Map();
  const filas = await db.select({ id: flitoTramites.idFlit2, v: flitoTramites.syncVersion })
    .from(flitoTramites).where(inArray(flitoTramites.idFlit2, [...pedidas.keys()]));
  const guardada = new Map(filas.map((f) => [String(f.id), Number(f.v ?? -1)]));
  const faltan = new Map<string, number>();
  for (const [id, v] of pedidas) if ((guardada.get(id) ?? -1) < v) faltan.set(id, v);
  return faltan;
}

// ── Agenda (A1) ──────────────────────────────────────────────────────────────────────────────────

/** Entrada de un lote: versión a verificar y reintentos AC7 ya gastados. */
interface Entrada { version: number; intentos: number }
interface Lote { verificar: Map<string, Entrada>; tombstones: boolean }
const loteVacio = (): Lote => ({ verificar: new Map(), tombstones: false });
const vacio = (l: Lote) => l.verificar.size === 0 && !l.tombstones;

export interface DepsAgenda {
  leer: () => Promise<unknown>;
  sinAplicar: (pedidas: Map<string, number>) => Promise<Map<string, number>>;
  ahora: () => number;
}

export type EstadoRecepcion = 'agendado' | 'duplicado' | 'fuente_apagada';

export class AgendaAvisosFlit2 {
  private estado: 'libre' | 'armado' | 'leyendo' = 'libre';
  private lote = loteVacio();
  private loteDesde: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enCursoDesde: number | null = null;
  /** Sube en cada `detener()`: una lectura que termina después no reprograma nada. */
  private generacion = 0;
  private readonly eventos = new Map<string, number>();
  private readonly versiones = new Map<string, { v: number; vence: number }>();

  constructor(private readonly deps: DepsAgenda) {}

  /** Duplicado por `eventId` o por `(id, syncVersion)` dentro del TTL (RN-03). No registra. */
  esDuplicado(a: AvisoFlit2): boolean {
    const t = this.deps.ahora();
    const ev = this.eventos.get(a.eventId);
    if (ev !== undefined && ev > t) return true;
    const ver = this.versiones.get(a.id);
    return ver !== undefined && ver.vence > t && a.syncVersion <= ver.v;
  }

  /** Registra el aviso en la dedup y lo mete al lote; arma la ventana si estaba libre (RN-02). */
  agendar(a: AvisoFlit2): void {
    const t = this.deps.ahora();
    this.registrar(a, t);
    if (a.eliminado) this.lote.tombstones = true;
    else fundir(this.lote, a.id, { version: a.syncVersion, intentos: 0 });
    if (this.loteDesde === null) this.loteDesde = t;
    if (this.estado === 'libre') this.programar(VENTANA_MS);
  }

  /** Limpia timers, lote y dedup. */
  detener(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generacion += 1;
    this.estado = 'libre';
    this.lote = loteVacio();
    this.loteDesde = null;
    this.enCursoDesde = null;
    this.eventos.clear();
    this.versiones.clear();
  }

  private registrar(a: AvisoFlit2, t: number): void {
    const vence = t + DEDUP_TTL_MS;
    podar(this.eventos, t, (x) => x);
    podar(this.versiones, t, (x) => x.vence);
    this.eventos.delete(a.eventId);
    this.eventos.set(a.eventId, vence);
    const previa = this.versiones.get(a.id);
    const v = previa && previa.vence > t ? Math.max(previa.v, a.syncVersion) : a.syncVersion;
    this.versiones.delete(a.id);
    this.versiones.set(a.id, { v, vence });
  }

  private programar(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.estado = 'armado';
    this.timer = setTimeout(() => { this.timer = null; void this.disparar(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  private async disparar(): Promise<void> {
    const lote = this.lote;
    this.lote = loteVacio();
    this.loteDesde = null;
    this.estado = 'leyendo';
    const gen = this.generacion;
    let reintentar: Lote | null = null;
    try {
      reintentar = await this.procesar(lote);
    } catch (e) {
      log.error({ err: (e as Error)?.name }, 'agenda de avisos de FLIT 2: error inesperado; queda para el cron');
    }
    if (gen === this.generacion) this.despues(reintentar);
  }

  /** Lee el lote y devuelve lo que hay que reintentar (null = nada). Solo lanza por errores no previstos. */
  private async procesar(lote: Lote): Promise<Lote | null> {
    // Comprobación previa (RN-04): si otra lectura ya lo trajo, no se lee.
    let pendiente = lote;
    try {
      const faltan = await this.deps.sinAplicar(versiones(lote));
      pendiente = { verificar: filtrar(lote.verificar, faltan), tombstones: lote.tombstones };
    } catch (e) {
      log.warn({ err: (e as Error)?.name }, 'comprobación previa de avisos de FLIT 2 falló; se lee igual');
    }
    if (vacio(pendiente)) { this.enCursoDesde = null; return null; }

    try {
      await this.deps.leer();
    } catch (e) {
      return this.trasError(e, pendiente);
    }
    this.enCursoDesde = null;

    // Verificación AC7 (RN-05): los tombstones no se verifican.
    let faltan: Map<string, number>;
    try {
      faltan = await this.deps.sinAplicar(versiones({ verificar: pendiente.verificar, tombstones: false }));
    } catch (e) {
      log.warn({ err: (e as Error)?.name }, 'verificación de avisos de FLIT 2 falló; queda para el cron');
      return null;
    }
    const reintento = loteVacio();
    let agotados = 0;
    for (const [id, v] of faltan) {
      const e = pendiente.verificar.get(id)!;
      if (e.intentos < REINTENTOS_VERIFICACION) reintento.verificar.set(id, { version: v, intentos: e.intentos + 1 });
      else agotados += 1;
    }
    if (agotados > 0) log.info({ faltantes: agotados }, 'avisos de FLIT 2 sin aplicar tras los reintentos: quedan para el respaldo');
    return vacio(reintento) ? null : reintento;
  }

  private trasError(e: unknown, pendiente: Lote): Lote | null {
    if (e instanceof Flit2LecturaEnCursoError) {
      const t = this.deps.ahora();
      this.enCursoDesde ??= t;
      if (t - this.enCursoDesde < enCursoMaxMs()) {
        log.debug('lectura de FLIT 2 en curso: el aviso espera su turno');
        return pendiente;
      }
      log.info('lectura de FLIT 2 ocupada demasiado tiempo: los avisos quedan para el cron');
    } else if (e instanceof FuenteApagadaError) {
      log.debug('fuente FLIT 2 apagada al disparar el aviso: se descarta el lote');
    } else if (e instanceof Flit2Error) {
      log.warn({ codigo: e.codigo }, 'lectura por aviso de FLIT 2 no se pudo hacer; queda para el cron');
    } else {
      log.error({ err: (e as Error)?.name }, 'lectura por aviso de FLIT 2 falló; queda para el cron');
    }
    this.enCursoDesde = null;
    return null;
  }

  /** Tras una lectura: a lo sumo UNA lectura más, que funde reintento y avisos llegados mientras (AC5). */
  private despues(reintentar: Lote | null): void {
    const hayNuevos = !vacio(this.lote);
    if (reintentar) {
      for (const [id, e] of reintentar.verificar) fundir(this.lote, id, e);
      this.lote.tombstones ||= reintentar.tombstones;
    }
    if (vacio(this.lote)) { this.estado = 'libre'; this.loteDesde = null; return; }
    const restante = hayNuevos && this.loteDesde !== null ? this.loteDesde + VENTANA_MS - this.deps.ahora() : 0;
    this.loteDesde ??= this.deps.ahora();
    this.programar(reintentar ? Math.max(REINTENTO_MS, restante) : restante);
  }
}

/** Mete una entrada al lote; con el mismo id se queda la versión mayor (y sus intentos). */
function fundir(lote: Lote, id: string, e: Entrada): void {
  const previa = lote.verificar.get(id);
  if (!previa || e.version > previa.version) lote.verificar.set(id, e);
  else if (e.version === previa.version) lote.verificar.set(id, { version: e.version, intentos: Math.min(e.intentos, previa.intentos) });
}

function versiones(l: Lote): Map<string, number> {
  return new Map([...l.verificar].map(([id, e]) => [id, e.version]));
}

function filtrar(m: Map<string, Entrada>, quedan: Map<string, number>): Map<string, Entrada> {
  return new Map([...m].filter(([id]) => quedan.has(id)));
}

/** Expulsa vencidos y, por encima del tope, los más viejos (orden de inserción de `Map`). */
function podar<V>(m: Map<string, V>, t: number, vence: (v: V) => number): void {
  for (const [k, v] of m) {
    if (m.size < DEDUP_TOPE && vence(v) > t) break;
    m.delete(k);
  }
}

// ── Singleton del proceso ────────────────────────────────────────────────────────────────────────

export const agendaAvisos = new AgendaAvisosFlit2({
  leer: () => leerConCandado('aviso'),
  sinAplicar: versionesSinAplicar,
  ahora: () => Date.now(),
});

/**
 * Recibe un aviso con firma y cuerpo válidos y `tipo = tramite.cambio`. Única E/S: el interruptor (AC8);
 * si esa consulta falla se agenda igual (la lectura vuelve a mirarlo, RN-24 de la lectura).
 */
export async function recibirAviso(a: AvisoFlit2, agenda: AgendaAvisosFlit2 = agendaAvisos): Promise<EstadoRecepcion> {
  if (agenda.esDuplicado(a)) return 'duplicado';
  if (!env.FLIT2_SYNC_CRON) return 'fuente_apagada';
  try {
    if (!(await fuenteHabilitada('flit2'))) return 'fuente_apagada';
  } catch (e) {
    log.warn({ err: (e as Error)?.name }, 'no se pudo consultar el interruptor de FLIT 2; se agenda igual');
  }
  agenda.agendar(a);
  return 'agendado';
}

/** Lo llama `stopFlitSync` y los tests: sin timers colgados. Lo acumulado en marcas se descarta. */
export function detenerAvisosFlit2(): void {
  agendaAvisos.detener();
  if (timerVolcado) clearTimeout(timerVolcado);
  timerVolcado = null;
  marcas = marcasVacias();
}
