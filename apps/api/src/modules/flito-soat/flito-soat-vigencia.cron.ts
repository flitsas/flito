// FLITO SOAT — verificación de vigencia: la PROGRAMACIÓN de la corrida diaria (Feature #12075,
// HU #12095).
//
// Esto es el ANDAMIAJE, no el recorrido. Aquí vive CUÁNDO arranca (00:10 de Colombia), QUIÉN la
// ejecuta cuando hay más de una instancia (el candado), CÓMO se apaga (la puerta positiva por env),
// por qué NO se repite el mismo día aunque el proceso se reinicie (el estado del día, persistido) y
// CUÁNDO se reintenta (cada hora, hasta tres veces). Qué hace la corrida —los vehículos, sus
// columnas de vigencia, el resumen— es de la HU #12096 y entra por `recorrerVigenciaSoat`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-D4  La hora es la de COLOMBIA, no la del servidor. El contenedor corre en UTC, así que la hora
//        se resuelve con `Intl` sobre `America/Bogota` y no con `getHours()`: un cron atado al reloj
//        del proceso arrancaría a las 19:10 de Bogotá y nadie lo notaría hasta que la corrida
//        apareciera fechada el día anterior. Mismo mecanismo que `flito-derechos-drive.cron.ts`, con
//        una diferencia: allí la ventana es una hora en punto y aquí tiene minutos, así que el
//        latido baja de 10 a 5 minutos para no llegar tarde a una ventana que empieza en :10.
//
// RN-D6  Puerta POSITIVA: sin `SOAT_VIGENCIA_CRON_ENABLED=1` explícito, el cron no arranca y lo
//        dice en el log. Igual que `PRIVACY_RETENTION_CRON_ENABLED` y `DRIVE_DERECHOS_CRON_ENABLED`,
//        y por la misma razón: esto acabará consultando una fuente externa por cada vehículo con
//        comprobante cargado, y un contenedor mal configurado o un script con `NODE_ENV=production`
//        no debe ser suficiente para desatarlo.
//
// CF-08  Un solo servidor hace el trabajo. La corrida ENTERA va dentro de `withLock`; la instancia
//        que no obtiene el candado lo registra y termina sin consultar nada.
//
//        Que el estado del día se lea UNA sola vez, y ANTES del candado, no lo justifica el candado:
//        lo justifica la ESCRITURA DE ENTRADA de `ejecutarIntento`. El día pasa a `en_curso` con el
//        próximo intento ya fechado antes de que arranque el recorrido, así que un latido de otra
//        instancia que caiga a mitad de la corrida ajena lee un reintento no vencido y se va a
//        esperar — aunque no llegue a pedir el candado. Esa escritura doble (entrada y cierre) ES la
//        protección; «simplificarla» a una sola escritura al final, creyendo que el candado ya
//        excluye a los demás, abre exactamente la ventana que hoy no existe: entre el arranque del
//        intento y su cierre, los demás latidos verían un día sin estado y pedirían el candado en
//        cada uno, y un proceso que muriera a mitad dejaría el día sin fecha de retome.
//
// CF-06  Reintento horario y ACOTADO. Un intento que deja vehículos sin verificar reprograma el
//        siguiente a una hora del ARRANQUE del intento —cadencia fija 00:10, 01:10, 02:10, 03:10, no
//        deriva con lo que tarde cada pasada—. Tras `MAX_REINTENTOS` el día se cierra como `parcial`
//        y no vuelve a intentarse: una corrida que reintenta indefinidamente contra una fuente caída
//        deja de ser un reintento y pasa a ser una tormenta.
//
// AC5    La idempotencia del día NO puede vivir en memoria: un reinicio del proceso a las 00:30
//        volvería a lanzar la corrida de un día ya cerrado. El estado del día se persiste y se lee
//        de la base en cada latido.
//
//        DÓNDE se persiste hoy: `system_kv`, el KV de estado operativo que ya usan el sync de FLIT y
//        la salud del reconciliador. La tabla de corridas que el AC5 nombra la crea la HU #12096
//        —esta HU tiene prohibido tocar el esquema—, así que la lectura y la escritura del estado
//        están aisladas en `leerEstadoDelDia` / `guardarEstadoDelDia`: cuando exista la tabla, la
//        #12096 reemplaza el cuerpo de esas dos funciones y NADA más de este archivo cambia. Lo que
//        el AC5 exige de verdad —que el estado sobreviva al reinicio y sea el mismo para todas las
//        instancias— ya se cumple.
//
// AC7    Los logs llevan host, día, intento y totales. Ni placa, ni VIN, ni documento, ni nombre: de
//        este archivo no sale ningún identificador de vehículo ni de persona porque no llega
//        ninguno — `recorrerVigenciaSoat` devuelve conteos, no filas.
//
//        La excepción que sí llegaría es el ERROR del recorrido, y por eso al log va su nombre y no
//        su mensaje (`nombreDeError`): el mensaje lo redacta la HU #12096 y un `Error('RUNT: placa
//        ABC123 …')` colaría la placa por una clave (`err`) que la lista blanca del AC7 permite.

import os from 'os';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { systemKv } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { recorrerVigenciaSoat } from './flito-soat-vigencia.service.js';

const log = loggerFor('flito-soat-vigencia-cron');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/**
 * Lo ÚNICO que un error deja en el log es su NOMBRE (AC7).
 *
 * El mensaje es texto libre y no es nuestro: hoy `recorrerVigenciaSoat` no lanza, pero la HU #12096
 * lo va a llenar con lo que devuelva la fuente externa, y un `Error('RUNT: placa ABC123 sin
 * respuesta')` metería la placa en el log sin que nadie lo note — el aserto del AC7 mira las CLAVES,
 * y `err` es una clave permitida. Cerrar el canal aquí, y no en la #12096, es lo que hace que la
 * regla no dependa de cómo redacte sus excepciones la historia siguiente.
 *
 * El nombre sí es diagnóstico si la #12096 usa clases con nombre propio (`RuntSinRespuestaError`);
 * el detalle irreproducible por el nombre va al conteo de `pendientes`, no al log.
 */
function nombreDeError(e: unknown): string {
  return e instanceof Error && e.name ? e.name : 'error';
}

/** Zona del negocio. Se resuelve con Intl y no con la del contenedor, que en Docker es UTC (RN-D4). */
const ZONA = 'America/Bogota';

/** Hora de Colombia a la que abre la ventana de arranque: 00:10. */
export const HORA_OBJETIVO = 0;
export const MINUTO_OBJETIVO = 10;

/**
 * Cada cuánto se mira el reloj. No es la frecuencia de la corrida —esa es UNA al día— sino el
 * granulado con el que se detectan la ventana de las 00:10 y el vencimiento de un reintento.
 *
 * Cinco minutos y no los diez del barrido del Drive: aquella ventana es «la hora N», que dura 60
 * minutos; esta empieza en el minuto 10 y el reintento se mide en horas. Con 5 minutos, el peor
 * retraso frente a las 00:10 son 5 minutos y el latido sigue siendo despreciable (una lectura por
 * clave primaria).
 */
const LATIDO_MS = 5 * 60_000;

/** Una hora entre intentos (CF-06). */
const REINTENTO_MS = 60 * 60_000;

/**
 * Reintentos, no ejecuciones: la corrida inicial (intento 1) más tres reintentos (intentos 2, 3 y 4).
 * El cuarto reintento no ocurre — el día se cierra como `parcial`.
 */
export const MAX_REINTENTOS = 3;

/** Nombre del candado (CF-08). Cabe en los 50 caracteres de `system_locks.lock_name`. */
const NOMBRE_LOCK = 'flito-soat-vigencia';

/**
 * TTL del candado. Deliberadamente MENOR que la hora del reintento: si el dueño muere sin liberar,
 * el candado tiene que haber caducado antes de que toque el intento siguiente, o el fallo de una
 * instancia congelaría la corrida del día entero. La HU #12096 tendrá que revisarlo si el recorrido
 * real puede tardar más de esto: pasarse del TTL es que otra instancia entre en paralelo.
 */
const LOCK_TTL_MS = 50 * 60_000;

/** Clave del estado del día en `system_kv` (ver AC5 en la cabecera). */
export const KV_CLAVE_CORRIDA = 'flito-soat.vigencia.corrida-dia';

/**
 * Cómo terminó la corrida de un día.
 *
 * `en_curso` es también el estado de «hay un reintento programado»: el día no está cerrado y volverá
 * a intentarse. Lo que lo cierra es `completa` (no quedó nada pendiente) o `parcial` (se agotaron
 * los reintentos y quedaron vehículos sin verificar).
 */
export type EstadoCorrida = 'en_curso' | 'completa' | 'parcial';

export interface EstadoDelDia {
  /** Día en Bogotá, `YYYY-MM-DD`. */
  dia: string;
  estado: EstadoCorrida;
  /** Ejecuciones hechas hoy: 1 es la corrida inicial, 2..4 los reintentos. */
  intentos: number;
  /** Verificados acumulados del día, para el log. */
  verificados: number;
  /** Sin verificar en el último intento. Mayor que cero es lo que reprograma. */
  pendientes: number;
  /** ISO del momento a partir del cual toca reintentar, o `null` si el día no espera nada más. */
  proximoIntentoEn: string | null;
  actualizadoEn: string;
}

/** Lo que el latido mira del reloj. Separado para poder decidir sin depender de `Date`. */
export interface RelojBogota {
  dia: string;
  hora: number;
  minuto: number;
  /** Instante absoluto, para comparar contra `proximoIntentoEn`. */
  ms: number;
}

export type MotivoEspera =
  /** No es la ventana de arranque y no hay reintento pendiente. */
  | 'fuera_de_ventana'
  /** La corrida del día ya se cerró con éxito. */
  | 'dia_cerrado'
  /** Hay un intento reprogramado, pero todavía no le toca. */
  | 'reintento_no_vencido'
  /** Se agotaron los reintentos: el día quedó parcial. */
  | 'reintentos_agotados'
  /** Este proceso tiene un intento en curso (reentrada del `setInterval`). */
  | 'en_vuelo'
  /** No se pudo leer el estado del día; sin él no se decide nada. */
  | 'estado_ilegible';

export type Decision =
  | { accion: 'esperar'; motivo: MotivoEspera }
  | { accion: 'correr'; intento: number; motivo: 'corrida_inicial' | 'reintento' };

/** Fecha y hora en Bogotá, sin depender de la zona del proceso (RN-D4). */
export function ahoraEnBogota(ahora: Date = new Date()): RelojBogota {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return {
    dia: `${v('year')}-${v('month')}-${v('day')}`,
    // `en-CA` con hour12:false devuelve «24» para la medianoche en algunos runtimes de ICU.
    hora: Number(v('hour')) % 24,
    minuto: Number(v('minute')),
    ms: ahora.getTime(),
  };
}

/** ¿El reloj está dentro de la ventana de arranque del día (de 00:10 en adelante, dentro de la hora)? */
function enVentanaDeArranque(reloj: RelojBogota): boolean {
  return reloj.hora === HORA_OBJETIVO && reloj.minuto >= MINUTO_OBJETIVO;
}

/**
 * Qué hacer en este latido. Función pura: todo el comportamiento temporal del cron se decide aquí,
 * que es lo que permite probarlo sin esperar a la madrugada.
 *
 * La ventana de arranque es estricta a propósito (AC2: «a cualquier otra hora el latido no hace
 * nada»). Si el proceso estuvo caído la hora 0 entera, ese día no hay corrida inicial y la siguiente
 * es la de mañana; no se inventa un arranque a las 09:00 porque una verificación masiva a media
 * mañana es una decisión de operación, no un rescate automático.
 */
export function decidirCorrida(estado: EstadoDelDia | null, reloj: RelojBogota): Decision {
  // Día sin estado: o es la ventana de arranque, o no hay nada que hacer.
  if (!estado || estado.dia !== reloj.dia) {
    return enVentanaDeArranque(reloj)
      ? { accion: 'correr', intento: 1, motivo: 'corrida_inicial' }
      : { accion: 'esperar', motivo: 'fuera_de_ventana' };
  }

  if (estado.estado === 'completa') return { accion: 'esperar', motivo: 'dia_cerrado' };
  if (estado.estado === 'parcial') return { accion: 'esperar', motivo: 'reintentos_agotados' };

  // `en_curso`: o hay un intento en vuelo, o hay uno reprogramado. Los dos casos se distinguen por
  // el reloj y no por una bandera, y esa es justamente la propiedad que hace que un proceso que
  // muere a mitad de la corrida no congele el día: el intento siguiente ya estaba fechado ANTES de
  // empezar el actual, así que a la hora se retoma solo.
  if (estado.proximoIntentoEn === null) return { accion: 'esperar', motivo: 'reintentos_agotados' };
  const vence = Date.parse(estado.proximoIntentoEn);
  if (Number.isNaN(vence) || reloj.ms < vence) return { accion: 'esperar', motivo: 'reintento_no_vencido' };

  return { accion: 'correr', intento: estado.intentos + 1, motivo: 'reintento' };
}

// ─────────────────────────── Estado del día (la costura de la HU #12096) ────────────────────────
//
// Las DOS únicas funciones que saben dónde vive el estado. La #12096 les cambia el cuerpo por la
// tabla de corridas y no toca nada más de este archivo.

export async function leerEstadoDelDia(): Promise<EstadoDelDia | null> {
  const [fila] = await db.select({ v: systemKv.v }).from(systemKv)
    .where(eq(systemKv.k, KV_CLAVE_CORRIDA)).limit(1);
  const v = fila?.v as Partial<EstadoDelDia> | undefined;
  if (!v || typeof v.dia !== 'string' || typeof v.estado !== 'string') return null;
  return {
    dia: v.dia,
    estado: v.estado as EstadoCorrida,
    intentos: Number(v.intentos ?? 0),
    verificados: Number(v.verificados ?? 0),
    pendientes: Number(v.pendientes ?? 0),
    proximoIntentoEn: typeof v.proximoIntentoEn === 'string' ? v.proximoIntentoEn : null,
    actualizadoEn: typeof v.actualizadoEn === 'string' ? v.actualizadoEn : new Date(0).toISOString(),
  };
}

export async function guardarEstadoDelDia(estado: EstadoDelDia): Promise<void> {
  // El MISMO objeto en `values` y en `set`: si el upsert escribiera una cosa al insertar y otra al
  // actualizar, el primer día del mes sería correcto y el resto no.
  const fila = { v: estado as unknown as Record<string, unknown>, updatedAt: new Date(estado.actualizadoEn) };
  await db.insert(systemKv).values({ k: KV_CLAVE_CORRIDA, ...fila })
    .onConflictDoUpdate({ target: systemKv.k, set: fila });
}

// ─────────────────────────────────────── El latido ──────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * Reentrada DE ESTE PROCESO, no idempotencia del día.
 *
 * Si un intento tarda más que el latido, el `setInterval` volvería a entrar y la misma instancia
 * competiría consigo misma por el candado. Esto lo evita. No sustituye a nada de AC5: la
 * idempotencia entre reinicios y entre instancias la da el estado persistido, que es lo que se lee
 * abajo; esta bandera nace en `false` en cada arranque y no decide si el día ya corrió.
 */
let enVuelo = false;

/**
 * Un latido. Exportado para poder ejercer el comportamiento temporal en los tests sin `setInterval`.
 *
 * @param ahora Instante a evaluar. Por defecto, el real.
 */
export async function latidoVigenciaSoat(ahora: Date = new Date()): Promise<Decision> {
  const reloj = ahoraEnBogota(ahora);

  if (enVuelo) return { accion: 'esperar', motivo: 'en_vuelo' };

  let estado: EstadoDelDia | null;
  try {
    // La lectura va ANTES del candado y basta con una: lo que impide actuar sobre un estado viejo no
    // es el candado sino la escritura de entrada del intento en curso —el día ya está `en_curso` con
    // el reintento fechado—, así que este latido decide esperar sin necesidad de pedirlo (CF-08).
    estado = await leerEstadoDelDia();
  } catch (e) {
    log.error(
      { host: HOST_ID, dia: reloj.dia, err: nombreDeError(e) },
      'no se pudo leer el estado de la corrida de vigencia: se reintenta en el próximo latido',
    );
    return { accion: 'esperar', motivo: 'estado_ilegible' };
  }

  const decision = decidirCorrida(estado, reloj);
  if (decision.accion === 'esperar') return decision;

  enVuelo = true;
  try {
    const corrio = await withLock(NOMBRE_LOCK, LOCK_TTL_MS, () => ejecutarIntento(reloj, decision.intento, estado));
    if (corrio === null) {
      log.info(
        { host: HOST_ID, dia: reloj.dia, intento: decision.intento, lock: NOMBRE_LOCK },
        'otra instancia tiene la corrida de vigencia: esta no consulta nada',
      );
    }
  } finally {
    enVuelo = false;
  }

  return decision;
}

/**
 * Un intento completo, ya dentro del candado.
 *
 * El estado se escribe DOS veces y no una: al empezar, con el siguiente intento ya fechado, y al
 * terminar, con el resultado. La escritura de entrada es la que hace que un proceso que muere a
 * mitad no deje el día colgado —a la hora, otra instancia (o esta misma tras reiniciar) ve un
 * reintento vencido y sigue—, y la que impide que un intento que se alargue más de una hora se
 * solape consigo mismo. Sin ella, un `en_curso` sin fecha sería un día muerto.
 */
async function ejecutarIntento(
  reloj: RelojBogota, intento: number, previo: EstadoDelDia | null,
): Promise<void> {
  // Lo del día de AYER no se arrastra: sin el guardia por día, un intento que muriera a mitad
  // dejaría escritos los pendientes de la corrida anterior como si fueran los de hoy.
  const deHoy = previo && previo.dia === reloj.dia ? previo : null;
  const acumuladoPrevio = deHoy?.verificados ?? 0;
  // La cadencia se mide desde el ARRANQUE del intento: 00:10, 01:10, 02:10, 03:10, pase lo que pase
  // con la duración de cada pasada (CF-06).
  const siguiente = intento <= MAX_REINTENTOS ? new Date(reloj.ms + REINTENTO_MS).toISOString() : null;

  const base: EstadoDelDia = {
    dia: reloj.dia,
    estado: 'en_curso',
    intentos: intento,
    verificados: acumuladoPrevio,
    pendientes: deHoy?.pendientes ?? 0,
    proximoIntentoEn: siguiente,
    actualizadoEn: new Date(reloj.ms).toISOString(),
  };
  await guardarEstadoDelDia(base);

  log.info(
    { host: HOST_ID, dia: reloj.dia, intento, maxReintentos: MAX_REINTENTOS },
    intento === 1 ? 'corrida de vigencia del SOAT: arranca' : 'corrida de vigencia del SOAT: reintento',
  );

  let considerados = 0;
  let verificados = 0;
  let pendientes = 0;
  let fallo: string | null = null;

  try {
    // Punto de extensión de la HU #12096. De aquí solo salen conteos: ningún identificador de
    // vehículo ni de persona llega a este archivo, que es lo que hace trivial el AC7.
    const r = await recorrerVigenciaSoat({ dia: reloj.dia, intento });
    considerados = r.considerados;
    verificados = r.verificados;
    pendientes = r.pendientes;
  } catch (e) {
    // El NOMBRE del error, nunca su mensaje: ese texto viene de la #12096 y puede traer una placa.
    fallo = nombreDeError(e);
    // Un recorrido que revienta es el caso extremo de «quedaron vehículos sin verificar»: se trata
    // igual que un pendiente para que el reintento horario lo cubra. Lo que NO se hace es dar el día
    // por bueno porque la excepción se tragó el conteo.
    pendientes = Math.max(1, pendientes);
  }

  const agotados = intento > MAX_REINTENTOS;
  const cierre: EstadoCorrida = pendientes === 0 ? 'completa' : (agotados ? 'parcial' : 'en_curso');

  await guardarEstadoDelDia({
    ...base,
    estado: cierre,
    verificados: acumuladoPrevio + verificados,
    pendientes,
    proximoIntentoEn: cierre === 'en_curso' ? siguiente : null,
    actualizadoEn: new Date().toISOString(),
  });

  const datos = {
    host: HOST_ID,
    dia: reloj.dia,
    intento,
    considerados,
    verificados,
    verificadosDelDia: acumuladoPrevio + verificados,
    pendientes,
    estado: cierre,
    ...(fallo ? { err: fallo } : {}),
  };

  if (fallo) {
    log.error(datos, 'corrida de vigencia del SOAT: el recorrido falló');
  }
  if (cierre === 'completa') {
    log.info(datos, 'corrida de vigencia del SOAT: completa');
  } else if (cierre === 'parcial') {
    log.warn(
      { ...datos, reintentos: MAX_REINTENTOS },
      'corrida de vigencia del SOAT: PARCIAL — reintentos agotados, quedan vehículos sin verificar hasta mañana',
    );
  } else {
    log.warn(
      { ...datos, proximoIntentoEn: siguiente },
      'corrida de vigencia del SOAT: quedan vehículos sin verificar, se reintenta en una hora',
    );
  }
}

// ─────────────────────────────────────── El cron ────────────────────────────────────────────────

/** Arranca el cron. Noop —y lo dice en el log— si la puerta de RN-D6 está cerrada. */
export function startSoatVigenciaCron(): void {
  if (timer) return;

  if (!env.SOAT_VIGENCIA_CRON_ENABLED) {
    log.info(
      { host: HOST_ID },
      'verificación de vigencia del SOAT DESHABILITADA (SOAT_VIGENCIA_CRON_ENABLED!=1)',
    );
    return;
  }

  log.info({
    host: HOST_ID,
    zona: ZONA,
    hora: `${String(HORA_OBJETIVO).padStart(2, '0')}:${String(MINUTO_OBJETIVO).padStart(2, '0')}`,
    latidoMin: LATIDO_MS / 60_000,
    maxReintentos: MAX_REINTENTOS,
  }, 'verificación de vigencia del SOAT ACTIVA');

  timer = setInterval(() => {
    void latidoVigenciaSoat().catch((e) => log.error(
      { host: HOST_ID, err: nombreDeError(e) },
      'latido de vigencia del SOAT',
    ));
  }, LATIDO_MS);
  timer.unref();
}

/**
 * Detiene el cron. No interrumpe el intento en vuelo (AC3): el estado del día se escribe pase lo que
 * pase, así que apagarlo entre corridas no deja ninguna a medio cerrar — como mucho deja un
 * reintento fechado que nadie recogerá hasta que se vuelva a encender.
 */
export function stopSoatVigenciaCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info({ host: HOST_ID }, 'verificación de vigencia del SOAT detenida');
  }
}
