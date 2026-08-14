// FLITO comparendos — purga por retención (Feature #11492 17a, HU #11511).
//
// `COMPARENDOS_RETENTION_MONTHS` existía desde la HU #11496 y **no se consumía en ningún punto del
// repositorio**: una política de retención declarada en una variable de entorno que no borraba nada.
// Esto es lo que la cumple. 24 meses por defecto, decisión humana del 2026-08-13.
//
// Está aparte del sync a propósito. El sync es una operación que un humano dispara y que llama a
// terceros; esto es un barrido periódico que solo habla con la base. Meterlos en el mismo archivo
// haría que un fallo de purga tumbase una corrida, o al revés.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-26  El reloj de la retención es `ultimo_visto_en`, NO `created_at`. Un comparendo que las
//        fuentes siguen reportando hoy es un dato vigente por muy antiguo que sea el hecho: la deuda
//        existe y borrarla dejaría al operador ciego sobre una obligación viva. Lo que se purga es
//        lo que NADIE ha vuelto a ver en la ventana de retención — que es exactamente lo que la Ley
//        1581 llama «no conservar más tiempo del necesario para la finalidad». El barrido de
//        inactivación NO toca `ultimo_visto_en` (solo `estado` y `ultimo_sync_run_id`), así que un
//        comparendo inactivo envejece desde la última vez que se vio de verdad.
//
// RN-27  El timeline se va con su registro y no antes. Los eventos caen por el ON DELETE CASCADE de
//        la 0150; no hay ni un DELETE dirigido a `flito_comparendos_eventos` en este archivo, y la
//        0151 tampoco le concede DELETE al rol de la aplicación. Un timeline huérfano —eventos de un
//        registro borrado, o un registro cuyo «desde cuándo» desapareció— sería peor que cualquiera
//        de las dos cosas completas.
//
// RN-28  Puerta positiva por env, como `PRIVACY_RETENTION_CRON_ENABLED` (el precedente del repo).
//        Un cron que BORRA no se enciende por el hecho de desplegarse: se enciende cuando alguien
//        decide, con la retención revisada, que puede empezar a borrar. `runComparendosPurgaOnce`
//        sigue siendo invocable a mano —y con `dryRun`— aunque el cron esté apagado.
//
// RN-29  Cada pasada deja escrito CUÁNTO borró, por tabla, con el corte y los meses de retención.
//        Un borrado sin rastro es indistinguible de una pérdida de datos: cuando alguien pregunte
//        «¿y dónde está la corrida de hace dos años?», la respuesta tiene que estar en el log y no en
//        una deducción.
//
// RN-30  FRENO, no solo throttle. `LOTE × MAX_LOTES` limita el RITMO (10 000 filas por tabla y día),
//        que no es lo mismo que limitar el DAÑO: una purga equivocada a 10 000 filas diarias sigue
//        vaciando la tabla, solo que despacio y en silencio. El escenario no necesita atacante y es
//        el mismo que ya frena el barrido de inactivación (RN-24): si el sync deja de correr durante
//        la ventana de retención —cron parado, `COMPARENDOS_SIMIT_MODE=mock` abortando en PDN,
//        proveedor caído meses—, `ultimo_visto_en` deja de avanzar en TODA la tabla y a los 24 meses
//        la purga empieza a borrar datos vigentes creyendo que nadie los ha vuelto a ver. Así que
//        una pasada se ABORTA entera si:
//
//          · los candidatos superan `COMPARENDOS_PURGA_MAX_RATIO` de la tabla, o
//          · no hay ninguna corrida de sync terminada en los últimos
//            `COMPARENDOS_PURGA_SYNC_MAX_DIAS` días — porque una purga por antigüedad solo tiene
//            sentido si el reloj que la alimenta está vivo.
//
//        La asimetría que corrige es la que señaló el gate: el barrido de inactivación, que es
//        REVERSIBLE, tenía freno; el borrado, que NO lo es, no tenía ninguno. Los dos frenos son
//        configurables porque la primera pasada tras encender el cron en una base con años de
//        histórico puede superar el porcentaje legítimamente: para ese caso se sube el umbral a
//        conciencia, una vez, después de mirar el `dryRun` — que es justo lo que un freno tiene que
//        obligar a hacer.

import os from 'os';
import { count, desc, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import {
  flitoComparendosEventos,
  flitoComparendosRegistros,
  flitoComparendosSyncRuns,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';

const log = loggerFor('flito-comparendos-purga');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/** Una pasada al día: la retención se mide en meses, así que no hay nada que ganar corriendo más. */
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Lock propio y NO el del sync (`flito-comparendos-sync`).
 *
 * Compartirlo serializaría las dos cosas, que suena bien hasta que se mira el efecto: el `POST
 * /sync` de un operador respondería 409 `sync_en_curso` porque un cron está purgando, y el operador
 * no tiene forma de saber por qué. Se aceptan a cambio, y son inofensivas, las carreras que quedan:
 * la única fila que las dos operaciones pueden tocar a la vez es una que lleva 24 meses sin verse y
 * que justo ahora reaparece; si la purga gana, el sync actualiza cero filas y la siguiente corrida la
 * vuelve a dar de alta como llegada nueva.
 */
const NOMBRE_LOCK = 'flito-comparendos-purga';

/**
 * TTL del lock. Generoso respecto de lo que la pasada puede tardar (está acotada por
 * `LOTE × MAX_LOTES`) porque el coste de pasarse es que dos pasadas se solapen, y el de quedarse
 * corto es un lock huérfano que bloquea la purga hasta que expire.
 */
const LOCK_TTL_MS = 30 * 60 * 1000;

/** Filas por DELETE. Un borrado masivo en un solo statement bloquea la tabla y engorda el WAL. */
const LOTE = 500;

/**
 * Tope de lotes por pasada y por tabla: 10 000 filas.
 *
 * La primera pasada tras encender el cron en una base con años de histórico podría querer borrar
 * millones de filas, y hacerlo de una sentada es la forma más fácil de que este cron sea el
 * incidente. Con el tope, la purga avanza un trozo al día hasta ponerse al corriente y el log dice
 * que quedó trabajo (`truncado`). Ninguna fila se salva: solo se retrasa.
 *
 * Esto es un THROTTLE y no un freno: lo que impide que una purga equivocada vacíe la tabla a plazos
 * es RN-30, no esto.
 */
const MAX_LOTES = 20;

/**
 * Mínimo de filas para que el freno por PORCENTAJE signifique algo (RN-30).
 *
 * Mismo criterio que `MIN_ACTIVOS_PARA_FRENO_RATIO` en el sync: con 3 comparendos en la tabla, dos
 * que caducan son el 66 % y dispararían el freno en una purga perfectamente correcta. Por debajo de
 * este número solo manda el heartbeat.
 */
const MIN_FILAS_PARA_FRENO_RATIO = 50;

/** Por qué se abortó una pasada (RN-30). `null` si no se abortó. */
export type MotivoAborto =
  /** Los candidatos son una fracción de la tabla mayor que `COMPARENDOS_PURGA_MAX_RATIO`. */
  | 'ratio'
  /** Nadie ha sincronizado en `COMPARENDOS_PURGA_SYNC_MAX_DIAS`: el reloj de la retención no avanza. */
  | 'sync_inactivo';

export interface ResultadoPurga {
  /** Comparendos borrados (`flito_comparendos_registros`). */
  registros: number;
  /** Eventos de timeline que se fueron con ellos por CASCADE. Contados antes de borrar (RN-27). */
  eventos: number;
  /** Corridas de sync borradas. Sus `sync_steps` caen por CASCADE. */
  syncRuns: number;
  /** `true` si queda trabajo para la pasada siguiente (el último lote salió lleno). */
  truncado: boolean;
  /** Instante de corte usado, en ISO. */
  corte: string;
  dryRun: boolean;
  /**
   * Freno de RN-30. Fuera de `dryRun` implica que no se borró NADA; en `dryRun` es informativo: la
   * pasada en seco sigue contando, y decir «esto es lo que se borraría **y además hoy el freno lo
   * impediría, por esto**» es más útil que no contar nada.
   */
  abortadoPor: MotivoAborto | null;
}

/**
 * El corte: `ahora` menos los meses de retención.
 *
 * Con aritmética de meses del calendario y no con «30 días × N». Restar meses hace que el corte caiga
 * siempre en el mismo día del mes, que es como se lee una política de «24 meses» en un contrato; la
 * aproximación en días desplaza el corte casi un mes en dos años, y esa diferencia son datos
 * personales conservados de más sin que nadie lo haya decidido.
 *
 * `setUTCMonth` normaliza solo los desbordes reales (31 de marzo menos 1 mes = 3 de marzo). Para una
 * ventana de meses eso es ruido de un día, y el alternativo —fijar el día 1— movería el corte mucho
 * más.
 */
export function corteDeRetencion(ahora: Date, meses: number): Date {
  const corte = new Date(ahora.getTime());
  corte.setUTCMonth(corte.getUTCMonth() - meses);
  return corte;
}

/**
 * Una pasada de la purga.
 *
 * @param opts.dryRun  Cuenta candidatos —TODOS, con un `count(*)` y el mismo `WHERE`— y no borra
 *                     nada. Es lo que hay que correr antes de encender el cron en un ambiente con
 *                     histórico: dice cuánto se llevaría por delante la purga, que es la pregunta
 *                     que nadie quiere responder después. El conteo no está acotado por
 *                     `LOTE × MAX_LOTES`: ese tope es el ritmo de UNA pasada, y lo que la pasada en
 *                     seco tiene que responder es cuánto hay en total (si no cabe en una pasada, lo
 *                     dice `truncado`). También evalúa el freno de RN-30 y lo reporta en
 *                     `abortadoPor` sin dejar de contar.
 */
export async function runComparendosPurgaOnce(opts: { dryRun?: boolean } = {}): Promise<ResultadoPurga> {
  const dryRun = opts.dryRun ?? false;
  const meses = env.COMPARENDOS_RETENTION_MONTHS;
  const corte = corteDeRetencion(new Date(), meses);

  const vacio: ResultadoPurga = {
    registros: 0, eventos: 0, syncRuns: 0, truncado: false, corte: corte.toISOString(), dryRun,
    abortadoPor: null,
  };

  const resultado = await withLock(NOMBRE_LOCK, LOCK_TTL_MS, async (): Promise<ResultadoPurga> => {
    const total: ResultadoPurga = { ...vacio };

    // El freno va ANTES de tocar nada (RN-30) y con el mismo criterio que el del sync: se mide y se
    // decide no borrar, en vez de borrar y descubrirlo después. Aquí «después» no existe — un
    // registro borrado no vuelve.
    const freno = await evaluarFreno(corte, meses);
    total.abortadoPor = freno?.motivo ?? null;

    if (freno) {
      log.error({
        dryRun, motivo: freno.motivo, retentionMonths: meses, corte: total.corte, ...freno.detalle,
      }, dryRun
        ? 'purga de comparendos en seco: HOY el freno la abortaría (se cuenta igual, no se borra nada)'
        : `purga de comparendos ABORTADA (${freno.motivo}): no se borra ninguna fila`);
      if (!dryRun) return total;
    }

    // Los registros primero: son los que arrastran timeline. Si la pasada se corta por el tope, es
    // preferible haber avanzado en lo que tiene datos personales de un tercero que en las corridas.
    const registros = await purgarRegistros(corte, dryRun);
    total.registros = registros.filas;
    total.eventos = registros.eventos;
    total.truncado = registros.truncado;

    const runs = await purgarSyncRuns(corte, dryRun);
    total.syncRuns = runs.filas;
    total.truncado = total.truncado || runs.truncado;

    // RN-29. Se registra siempre que haya algo que contar, también en `dryRun`: la pasada en seco
    // existe para poder leer este número antes de encender el cron.
    if (total.registros > 0 || total.syncRuns > 0 || dryRun) {
      log.info({
        dryRun,
        retentionMonths: meses,
        corte: total.corte,
        registros: total.registros,
        eventos: total.eventos,
        syncRuns: total.syncRuns,
        truncado: total.truncado,
        abortadoPor: total.abortadoPor,
      }, dryRun
        ? 'purga de comparendos en seco: esto es lo que se borraría'
        : 'purga de comparendos: filas eliminadas por retención');
    }

    return total;
  });

  // `withLock` devuelve `null` cuando otra instancia tiene el lock vigente. No es un error: la purga
  // de hoy ya la está haciendo alguien.
  return resultado ?? vacio;
}

// ─────────────────────────────── El freno (RN-30) ───────────────────────────────────────────────

/** Los candidatos de `registros`, con el tamaño de la tabla como denominador del freno. */
const candidatosRegistros = (corte: Date) => lt(flitoComparendosRegistros.ultimoVistoEn, corte);

/**
 * ¿Esta pasada borraría tanto, o con el reloj tan parado, que lo más probable es que la equivocada
 * sea ella? (RN-30)
 *
 * Devuelve el motivo y lo que hay que ver en el log para entenderlo, o `null` si se puede purgar.
 *
 * Las dos preguntas son distintas y las dos hacen falta:
 *
 *   · **Porcentaje.** Responde «¿esto es una purga o un vaciado?». Una retención en régimen tira
 *     cada día el trozo que cumple años, que sobre una tabla viva es una fracción pequeña. Si de
 *     golpe caduca media tabla, o el corte está mal o el reloj lo está.
 *
 *   · **Heartbeat del sync.** Responde a la causa concreta que el porcentaje puede no atrapar y que
 *     ningún otro control ve: `ultimo_visto_en` solo avanza cuando el sync corre. Con el sync
 *     parado, la tabla entera envejece a la vez, y en cuanto cruza la ventana de retención la purga
 *     empieza a borrar comparendos VIGENTES. Se aceptan `completed` y `partial`: una corrida parcial
 *     falló en algún NIT pero escribió `ultimo_visto_en` de todo lo que sí vio, que es exactamente lo
 *     que aquí se pregunta —si el reloj se mueve—. Lo que NO cuenta es `running` (puede llevar
 *     colgada semanas) ni `failed` (no escribió nada).
 *
 * Si el freno salta, se aborta la pasada ENTERA, también la purga de `sync_runs`. Sus filas no
 * corren el mismo riesgo —`iniciado_en` es inmutable, así que una corrida vieja lo es de verdad—,
 * pero son justamente el rastro de cuándo dejó de sincronizarse: borrarlas mientras se investiga por
 * qué el freno saltó sería tirar la prueba.
 */
async function evaluarFreno(
  corte: Date, meses: number,
): Promise<{ motivo: MotivoAborto; detalle: Record<string, unknown> } | null> {
  // Un recorrido, dos números: los que caducan y el total. `count(*) filter` evita traerse una fila
  // a la aplicación y evita también la segunda pasada sobre la tabla.
  const [medida] = await db.select({
    candidatos: sql<number>`count(*) filter (where ${candidatosRegistros(corte)})`.mapWith(Number),
    total: sql<number>`count(*)`.mapWith(Number),
  }).from(flitoComparendosRegistros);

  const candidatos = Number(medida?.candidatos ?? 0);
  const total = Number(medida?.total ?? 0);

  // Sin candidatos no hay nada que frenar: la pasada seguirá y no borrará registros. Las corridas de
  // sync sí pueden tener candidatos propios, y esas se purgan igual (ver arriba por qué es seguro).
  if (candidatos === 0) return null;

  const ratio = total > 0 ? candidatos / total : 0;
  if (total >= MIN_FILAS_PARA_FRENO_RATIO && ratio > env.COMPARENDOS_PURGA_MAX_RATIO) {
    return {
      motivo: 'ratio',
      detalle: {
        candidatos, total, ratio: Number(ratio.toFixed(4)),
        maxRatio: env.COMPARENDOS_PURGA_MAX_RATIO, retentionMonths: meses,
        pista: 'si la primera pasada tras encender el cron debe ponerse al corriente, sube '
          + 'COMPARENDOS_PURGA_MAX_RATIO a conciencia tras revisar el dryRun',
      },
    };
  }

  const [ultima] = await db.select({ iniciadoEn: flitoComparendosSyncRuns.iniciadoEn })
    .from(flitoComparendosSyncRuns)
    .where(inArray(flitoComparendosSyncRuns.estado, ['completed', 'partial']))
    .orderBy(desc(flitoComparendosSyncRuns.iniciadoEn))
    .limit(1);

  const dias = env.COMPARENDOS_PURGA_SYNC_MAX_DIAS;
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  const ultimoOk = ultima?.iniciadoEn ? new Date(ultima.iniciadoEn).getTime() : null;

  if (ultimoOk === null || ultimoOk < limite) {
    return {
      motivo: 'sync_inactivo',
      detalle: {
        candidatos, total,
        ultimaCorridaOk: ultimoOk === null ? null : new Date(ultimoOk).toISOString(),
        maxDias: dias,
        pista: 'el reloj de la retención es `ultimo_visto_en` y solo lo mueve el sync: sin corridas '
          + 'recientes, los candidatos pueden ser datos VIGENTES que nadie ha vuelto a consultar',
      },
    };
  }

  return null;
}

/** Comparendos que nadie ha vuelto a ver desde el corte, con su timeline detrás (RN-26, RN-27). */
async function purgarRegistros(
  corte: Date, dryRun: boolean,
): Promise<{ filas: number; eventos: number; truncado: boolean }> {
  // En seco se CUENTA, no se recorre. La versión anterior contaba un lote y salía —el siguiente
  // SELECT devolvería los mismos ids para siempre—, así que sobre 200 000 candidatos reportaba 500 y
  // subestimaba hasta 20× su propio tope. Y esta es la cifra que la documentación manda mirar antes
  // de encender el cron: si miente, no sirve para nada.
  if (dryRun) {
    const [conteo] = await db.select({ n: count() })
      .from(flitoComparendosRegistros)
      .where(candidatosRegistros(corte));
    const filas = Number(conteo?.n ?? 0);

    // El timeline también entero, y con el MISMO `WHERE` como subconsulta: contar los eventos de un
    // lote y extrapolar sería otra cifra a medias en la misma línea de log.
    const [conteoEventos] = await db.select({ n: count() })
      .from(flitoComparendosEventos)
      .where(sql`${flitoComparendosEventos.registroId} IN (
        SELECT ${flitoComparendosRegistros.id} FROM ${flitoComparendosRegistros}
        WHERE ${candidatosRegistros(corte)}
      )`);

    return { filas, eventos: Number(conteoEventos?.n ?? 0), truncado: filas > LOTE * MAX_LOTES };
  }

  let filas = 0;
  let eventos = 0;
  // `truncado` es «queda trabajo», no «se agotaron los lotes»: si el último vino incompleto, el
  // siguiente SELECT habría devuelto cero y el trabajo terminó. Marcarlo igual contamina el log que
  // alguien mirará justamente para saber si la purga se puso al corriente.
  let ultimoLoteLleno = false;

  for (let lote = 0; lote < MAX_LOTES; lote++) {
    // Se seleccionan los ids y se borra por id, en vez de un `DELETE ... WHERE ultimo_visto_en <
    // corte LIMIT n` (que PostgreSQL no admite) o un DELETE sin límite (que bloquearía la tabla
    // entera). El id es la PK, así que el borrado por lote es una búsqueda por índice.
    const candidatos = await db.select({ id: flitoComparendosRegistros.id })
      .from(flitoComparendosRegistros)
      .where(lt(flitoComparendosRegistros.ultimoVistoEn, corte))
      .orderBy(flitoComparendosRegistros.ultimoVistoEn)
      .limit(LOTE);

    if (candidatos.length === 0) return { filas, eventos, truncado: false };

    const ids = candidatos.map((c) => c.id);
    ultimoLoteLleno = ids.length === LOTE;

    // El conteo del timeline va ANTES del DELETE porque después ya no hay a quién preguntarle: los
    // eventos se van por CASCADE y `returning` sobre el padre no los cuenta (RN-29).
    const [conteo] = await db.select({ n: count() })
      .from(flitoComparendosEventos)
      .where(inArray(flitoComparendosEventos.registroId, ids));
    eventos += Number(conteo?.n ?? 0);

    const borrados = await db.delete(flitoComparendosRegistros)
      .where(inArray(flitoComparendosRegistros.id, ids))
      .returning({ id: flitoComparendosRegistros.id });
    filas += borrados.length;
  }

  return { filas, eventos, truncado: ultimoLoteLleno };
}

/** Corridas de sync anteriores al corte. Sus pasos —que llevan el NIT— caen por CASCADE. */
async function purgarSyncRuns(corte: Date, dryRun: boolean): Promise<{ filas: number; truncado: boolean }> {
  if (dryRun) {
    const [conteo] = await db.select({ n: count() })
      .from(flitoComparendosSyncRuns)
      .where(lt(flitoComparendosSyncRuns.iniciadoEn, corte));
    const filas = Number(conteo?.n ?? 0);
    return { filas, truncado: filas > LOTE * MAX_LOTES };
  }

  let filas = 0;
  let ultimoLoteLleno = false;

  for (let lote = 0; lote < MAX_LOTES; lote++) {
    const candidatos = await db.select({ id: flitoComparendosSyncRuns.id })
      .from(flitoComparendosSyncRuns)
      .where(lt(flitoComparendosSyncRuns.iniciadoEn, corte))
      .orderBy(flitoComparendosSyncRuns.iniciadoEn)
      .limit(LOTE);

    if (candidatos.length === 0) return { filas, truncado: false };

    const ids = candidatos.map((c) => c.id);
    ultimoLoteLleno = ids.length === LOTE;

    const borrados = await db.delete(flitoComparendosSyncRuns)
      .where(inArray(flitoComparendosSyncRuns.id, ids))
      .returning({ id: flitoComparendosSyncRuns.id });
    filas += borrados.length;
  }

  return { filas, truncado: ultimoLoteLleno };
}

// ─────────────────────────────── El cron ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-28 está cerrada. */
export function startComparendosPurgaCron(): void {
  if (timer) return;
  if (!env.COMPARENDOS_PURGA_CRON_ENABLED) {
    log.info({ host: HOST_ID }, 'purga de comparendos DESHABILITADA (COMPARENDOS_PURGA_CRON_ENABLED!=1)');
    return;
  }
  log.info({
    host: HOST_ID, intervalHours: 24, retentionMonths: env.COMPARENDOS_RETENTION_MONTHS,
  }, 'purga de comparendos ACTIVA');

  // La primera pasada se retrasa para no competir con el arranque, y con un desfase distinto al de
  // los otros dos crons de retención del repo (5 y 8 min) para no juntar tres barridos en el mismo
  // minuto de una instancia recién levantada.
  setTimeout(() => {
    void runComparendosPurgaOnce()
      .catch((e) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'purga: primera pasada'));
  }, 11 * 60 * 1000).unref();

  timer = setInterval(() => {
    void runComparendosPurgaOnce()
      .catch((e) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'purga: pasada periódica'));
  }, RUN_INTERVAL_MS);
  timer.unref();
}

export function stopComparendosPurgaCron(): void {
  if (timer) { clearInterval(timer); timer = null; log.info('purga de comparendos detenida'); }
}
