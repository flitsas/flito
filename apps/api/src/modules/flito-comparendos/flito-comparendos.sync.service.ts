// FLITO comparendos — la corrida de sincronización (Feature #11492 17a, HU #11500, CF-05/CF-06/CF-10).
//
// Lo que junta todo lo anterior: coge los NITs del catálogo (HU #11497), el token cifrado
// (HU #11498) y los dos adapters (HU #11499), pregunta, homologa con `flito-comparendos-merge.ts`,
// escribe el consolidado y decide qué se apaga. Archivo propio y no dentro de
// `flito-comparendos.service.ts` porque aquel son tres CRUD y esto es la única parte del módulo que
// llama a terceros, aguanta fallos parciales y escribe datos de fuente.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-15  Una corrida a la vez (CF-06). El segundo `POST /sync` recibe 409 `sync_en_curso`. Dos syncs
//        solapados no solo competirían por el mismo `numero_comparendo`: cada uno vería como
//        «ausentes» los comparendos que el otro aún no ha escrito, y eso son inactivaciones en
//        falso, que es el daño más caro que este módulo puede hacer.
//
// RN-16  El modo simulado NO corre en producción. `COMPARENDOS_SIMIT_MODE` vale `mock` por defecto,
//        así que la variable sin provisionar en PDN significaría escribir comparendos INVENTADOS en
//        la base productiva y, acto seguido, inactivar el histórico real por «ausencia». Se aborta
//        antes de tocar nada.
//
// RN-17  Una llamada a SIMIT por NIT y una por (NIT, municipio activo). Las municipales de un mismo
//        NIT van con un pool acotado por `COMPARENDOS_SYNC_CONCURRENCIA` (ADR-0001 §7): el endpoint
//        es SÍNCRONO y el nginx del web corta a los ~120 s, así que la matriz en serie no cabe en el
//        presupuesto de tiempo. El token se descifra UNA vez por corrida, no una por NIT.
//
// RN-18  Inactivación conservadora (CF-10). Solo se inactiva por ausencia a los NIT cuyo paso SIMIT
//        fue `ok` **y** cuyos municipios activos fueron TODOS `ok`. Un municipio con timeout no
//        significa «este comparendo ya no existe», significa «hoy no sabemos».
//
// RN-19  El timeline no se repite. `primera_llegada` una sola vez por registro; `inactivacion` y
//        `reaparicion` como mucho una por corrida, garantizado por el único
//        `(registro_id, tipo, sync_run_id)` de la 0150 y no por confiar en el flujo: re-ejecutar una
//        corrida con los mismos datos no puede duplicar ni filas ni eventos.
//
// RN-25  Los `payload_*` que escribe esta corrida van PODADOS a la lista blanca del `field_map`
//        (HU #11511, ver la cabecera de `flito-comparendos-merge.ts`): la respuesta íntegra del
//        proveedor —con el nombre y el documento del infractor, que es una persona natural y no la
//        empresa monitoreada— no llega a la base. La poda ocurre en el acumulador, así que este
//        archivo no ve nunca el ítem completo más allá de la llamada al adapter.
//
// RN-20  Nada de PII cruda en logs ni en `sync_steps.mensaje`. El NIT sale enmascarado
//        (`maskDocument`), la placa no sale, y el `mensaje` del paso viene siempre de los errores
//        tipados del módulo —que se construyen sin token, sin cabeceras y sin datos del proveedor—.
//        La columna se conserva, así que lo que se escriba ahí sobrevive a la corrida (Ley 1581).
//
// ── Las cuatro reglas que impiden inactivar de más (gate de seguridad de esta HU) ────────────────
//
// RN-21  La corrida NUNCA sobrevive a su propio lock. El TTL se DERIVA del tamaño del alcance y la
//        corrida se corta en un deadline absoluto anterior a ese TTL. Sin esto, un TTL fijo es una
//        suposición sobre la duración: en cuanto el alcance la desborda, el lock expira con la
//        corrida todavía viva y el reintento del operador —que lo habrá lanzado, porque el nginx le
//        devolvió 504— arranca una SEGUNDA corrida concurrente sobre las mismas tablas. Cada una ve
//        como ausentes los comparendos que la otra aún no ha escrito: inactivación en falso por
//        partida doble. Y como `releaseLock` borra por `(lockName, acquiredBy)` y `acquiredBy` es
//        `hostname-pid` (un solo proceso: `ecosystem.config.cjs` no declara `instances`), las dos
//        comparten dueño y la primera en terminar libera el lock de la otra, habilitando una tercera.
//
// RN-22  Cobertura no es «la fuente respondió», es «la fuente respondió y se entendió». Un paso que
//        trae ítems y no logra sacarle el número de comparendo a (casi) ninguno es una respuesta
//        ilegible un escalón más abajo que `ComparendosFuenteRespuestaIlegibleError`: mismo `[]`
//        silencioso, mismo apagón. Un `source_path` equivocado en el `field_map` o un proveedor que
//        renombra el campo del número pasan la validación de RN-12 —que solo exige que EXISTA algún
//        candidato, no que acierte— y dejarían el NIT con «cobertura completa» y cero registros.
//
// RN-23  Solo se inactiva lo que esta corrida pudo volver a ver. La ausencia se mide contra las
//        fuentes a las que se PREGUNTÓ: un comparendo que solo se ve por el UTS «X» no está ausente
//        si hoy no se consultó a «X». Basta con que alguien ponga `activo=false` en ese municipio
//        (PATCH del catálogo, HU #11497, que no avisa de nada) para que la corrida siguiente lo
//        apagara. Caso extremo: con CERO municipios activos, `municipales.every(...)` sobre la lista
//        vacía es `true` y un sync solo-SIMIT apagaría todo el histórico municipal.
//
// RN-24  Freno de inactivación masiva. Un token vencido cuyo proveedor conteste `200` con lista
//        vacía pasa todos los filtros sin ruido, y una sola corrida apagaría el histórico entero. Si
//        el barrido superara el tope de filas o el porcentaje de activos configurados, no se ejecuta
//        y la corrida se cierra como `partial`. El daño sería reversible (`reaparicion` restaura),
//        pero el timeline no: el único de RN-19 deduplica por corrida, no entre corridas, así que el
//        apagón y su reaparición quedan escritos para siempre.

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  ComparendosSyncEstado,
  ComparendosSyncModo,
  ComparendosSyncResultado,
  ComparendosSyncResumen,
  ComparendosSyncRun,
  ComparendosSyncStep,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import {
  flitoComparendosEventos,
  flitoComparendosMunicipios,
  flitoComparendosNits,
  flitoComparendosRegistros,
  flitoComparendosSyncRuns,
  flitoComparendosSyncSteps,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { withLock } from '../../shared/utils/lock.js';
import { maskDocument } from '../../shared/utils/pii.js';
import type { Redacted } from '../../shared/utils/crypto.js';
import { consultarComparendosMunicipales } from './clients/uts-municipal.client.js';
import { consultarComparendosSimit } from './clients/verifik-simit.client.js';
import { FUENTE_SIMIT, type ComparendosOrigenFuente } from './clients/types.js';
import {
  acumularMunicipal,
  acumularSimit,
  cargarMapaHomologacion,
  candidatosDe,
  origenMerge,
  resolverCampos,
  type AcumuladorNit,
  type MapaHomologacion,
} from './flito-comparendos-merge.js';
import {
  ComparendosError,
  ComparendosFiltroNitsInvalidoError,
  ComparendosFuenteError,
  ComparendosHomologacionIlegibleError,
  ComparendosModoSimuladoEnProduccionError,
  ComparendosNoEncontradoError,
  ComparendosScopeDemasiadoGrandeError,
  ComparendosSinNitsActivosError,
  ComparendosSyncEnCursoError,
  esViolacionDeUnicidad,
} from './flito-comparendos.errors.js';
import { normalizarNit } from './flito-comparendos.service.js';
import { obtenerTokenSimit } from './flito-comparendos.token.service.js';

const log = loggerFor('flito-comparendos');

/** Handle de transacción de drizzle, con el mismo idioma que el resto de servicios `flito-*`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Exclusión mutua por `system_locks` (`withLock`) y no por la fila `running` de `sync_runs`.
 *
 * Las dos opciones estaban sobre la mesa y la fila parecía más simple —ya existe, y el estado ya se
 * guarda ahí—, pero no tiene **TTL**: si el proceso muere a mitad de corrida (deploy, OOM, el
 * `docker stop` de turno), la fila se queda en `running` para siempre y el módulo no vuelve a
 * sincronizar hasta que alguien la edite a mano en producción. `system_locks` resuelve la carrera en
 * un único `INSERT … ON CONFLICT DO UPDATE WHERE expired` —atómico de verdad, no un SELECT seguido
 * de un INSERT— y se libera solo al expirar.
 */
const NOMBRE_LOCK = 'flito-comparendos-sync';

/**
 * Suelo del TTL. Una corrida pequeña no necesita más, y mantenerlo alto no cuesta nada: el deadline
 * de RN-21 la corta mucho antes de que este plazo importe.
 */
const LOCK_TTL_MIN_MS = 10 * 60_000;

/**
 * Techo del TTL, y por tanto de lo que puede durar una corrida.
 *
 * Existe porque el TTL es también el tiempo que el módulo queda bloqueado si el proceso muere
 * (deploy a mitad de sync, OOM): derivarlo del alcance sin tope convertiría un alcance grande en una
 * hora larga sin poder sincronizar. Un alcance que no quepa aquí se rechaza ANTES de empezar en vez
 * de arrancar una corrida condenada a abortar (`ComparendosScopeDemasiadoGrandeError`).
 */
const LOCK_TTL_MAX_MS = 60 * 60_000;

/**
 * Lo que se reserva entre el deadline de la corrida y la expiración del lock.
 *
 * Cubre el cierre: los últimos pasos, el `UPDATE` del `sync_run` y el barrido de inactivación. El
 * dueño del lock tiene que haber terminado —y liberado— antes de que nadie más pueda tomarlo, que es
 * justo lo que impide el solapamiento de RN-21.
 */
const MARGEN_CIERRE_MS = 60_000;

/**
 * Ratio de ítems sin número por encima del cual un paso deja de contar como cobertura (RN-22).
 *
 * Mayoría ESTRICTA y no «alguno»: los proveedores mandan filas de relleno de vez en cuando y
 * castigar la cobertura del NIT por un solo ítem raro dejaría el módulo sin inactivar nunca. Lo que
 * este umbral detecta es lo otro: un `source_path` equivocado o un campo renombrado ignoran el 100 %
 * de los ítems, y un renombrado parcial (una variante del endpoint) se lleva una fracción grande.
 */
const RATIO_IGNORADOS_ILEGIBLE = 0.5;

/**
 * Mínimo de comparendos activos para que el freno por PORCENTAJE tenga sentido (RN-24).
 *
 * Mismo razonamiento que `SIIGO_FRENO_MIN_OPERACIONES` en `config/env.ts`: sobre una muestra
 * diminuta, un porcentaje no significa nada. Un NIT con 3 comparendos activos que paga los tres
 * dispararía un freno del 100 % en una corrida perfectamente correcta. Por debajo de este número
 * solo aplica el tope absoluto de filas.
 */
const MIN_ACTIVOS_PARA_FRENO_RATIO = 20;

/** Tope de números por `IN (…)`: PostgreSQL admite 65535 parámetros y aquí van de a uno. */
const TAMANO_LOTE = 500;

export interface OpcionesSync {
  /** NITs a sincronizar. Omitido o vacío = todos los activos del catálogo (AC1). */
  nits?: readonly string[];
  actorId: number | null;
}

// ─────────────────────────────── Entrada pública ────────────────────────────────────────────────

/**
 * `POST /sync`: corre la sincronización completa y devuelve el resultado (AC1).
 *
 * Síncrono a propósito (ADR-0001 §2/§7): no hay 202 ni polling en 17a. Lo que hace que quepa en el
 * presupuesto de tiempo es el pool de RN-17, no la asincronía.
 *
 * @throws ComparendosSyncEnCursoError                409 — ya hay otra corrida (RN-15).
 * @throws ComparendosModoSimuladoEnProduccionError   503 — `mock` en PDN (RN-16).
 * @throws ComparendosSinNitsActivosError             400 — catálogo sin NITs activos.
 * @throws ComparendosFiltroNitsInvalidoError         400 — el filtro nombra NITs que no están activos.
 * @throws ComparendosScopeDemasiadoGrandeError       400 — el alcance no cabe en una corrida (RN-21).
 * @throws ComparendosMapaHomologacionVacioError      503 — sin mapa de homologación (RN-12).
 * @throws ComparendosTokenNoConfiguradoError / ComparendosLlaveMaestraError /
 *         ComparendosTokenDescifradoError            503 — no se pudo obtener el token en modo real.
 */
export async function ejecutarSync(opciones: OpcionesSync): Promise<ComparendosSyncResultado> {
  const modo: ComparendosSyncModo = env.COMPARENDOS_SIMIT_MODE;

  // RN-16, y lo PRIMERO de todo: antes del lock, del catálogo y de cualquier escritura. Si esta
  // comprobación estuviera más abajo, una corrida abortada ya habría dejado su `sync_run` en la base
  // productiva.
  if (modo === 'mock' && env.NODE_ENV === 'production') {
    log.error('sync de comparendos abortado: COMPARENDOS_SIMIT_MODE=mock en producción');
    throw new ComparendosModoSimuladoEnProduccionError();
  }

  // El alcance se resuelve ANTES del lock, y ese es el cambio de RN-21: el TTL tiene que salir del
  // tamaño de lo que se va a hacer, y para eso hay que saberlo antes de pedirlo. El coste de sacarlo
  // fuera es que dos peticiones simultáneas leen las mismas dos listas antes de que una se lleve el
  // 409 — dos SELECT de catálogos, sin escrituras y sin llamadas al proveedor. Lo que SÍ sigue dentro
  // del lock es todo lo que escribe o gasta cuota (el `sync_run`, el token, las fuentes).
  const nits = await resolverScope(opciones.nits);
  const municipios = await municipiosActivos();
  const concurrencia = env.COMPARENDOS_SYNC_CONCURRENCIA;

  const costoNit = costoNitMs(municipios.length, concurrencia);
  const presupuesto = costoNit * nits.length;
  if (presupuesto + MARGEN_CIERRE_MS > LOCK_TTL_MAX_MS) {
    // Arrancar igualmente significaría abortar por deadline a media corrida cada vez: mejor decirlo
    // antes, con el número de NITs que sí caben, que gastar cuota del proveedor para no terminar.
    throw new ComparendosScopeDemasiadoGrandeError(
      nits.length, Math.max(1, Math.floor((LOCK_TTL_MAX_MS - MARGEN_CIERRE_MS) / costoNit)),
    );
  }

  const ttlMs = Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, presupuesto + MARGEN_CIERRE_MS));
  const resultado = await withLock(
    NOMBRE_LOCK, ttlMs, () => correrSync(opciones, modo, { nits, municipios, concurrencia, costoNit, ttlMs }),
  );
  if (resultado === null) throw new ComparendosSyncEnCursoError();
  return resultado;
}

/**
 * Peor caso de UN NIT: la llamada a SIMIT más las tandas de municipales del pool (RN-17).
 *
 * Se cuenta con el timeout entero por llamada porque es el único techo que el adapter garantiza —una
 * fuente lenta consume exactamente eso—, y con `ceil(municipios / concurrencia)` tandas porque el
 * pool no lanza más de `concurrencia` a la vez.
 */
function costoNitMs(municipios: number, concurrencia: number): number {
  const tandas = Math.ceil(municipios / Math.max(1, concurrencia));
  return (1 + tandas) * env.COMPARENDOS_HTTP_TIMEOUT_MS;
}

// ─────────────────────────────── Orquestación ───────────────────────────────────────────────────

/** Todo lo que se resuelve una vez por corrida y viaja a cada NIT. */
interface ContextoCorrida {
  runId: string;
  modo: ComparendosSyncModo;
  mapa: MapaHomologacion;
  municipios: readonly string[];
  /** Token descifrado, UNA vez por corrida (RN-17). `undefined` en modo simulado: no hace falta. */
  token?: Redacted<string>;
  concurrencia: number;
}

/** El alcance ya resuelto y su presupuesto de tiempo, calculados antes de tomar el lock (RN-21). */
interface AlcanceCorrida {
  nits: readonly string[];
  municipios: readonly string[];
  concurrencia: number;
  /** Peor caso de un NIT, en ms: lo que hay que tener por delante para empezar el siguiente. */
  costoNit: number;
  /** TTL con el que se tomó el lock. El deadline de la corrida va por debajo. */
  ttlMs: number;
}

async function correrSync(
  opciones: OpcionesSync, modo: ComparendosSyncModo, alcance: AlcanceCorrida,
): Promise<ComparendosSyncResultado> {
  const { nits, municipios, concurrencia, costoNit } = alcance;

  // El deadline se toma al entrar, con el lock YA adquirido: el reloj del plazo y el del lock son el
  // mismo, y el margen absorbe el viaje del `acquireLock`. Pasado este instante no se empieza ningún
  // NIT más — el dueño del lock no puede sobrevivir a su propio lock (RN-21).
  const deadline = Date.now() + alcance.ttlMs - MARGEN_CIERRE_MS;

  // Orden deliberado: todo lo que puede decir «esta corrida no se puede hacer» ocurre ANTES del
  // INSERT del `sync_run`. Así una precondición fallida no deja corridas fantasma en el histórico.
  const mapa = await cargarMapaHomologacion();
  // El token se descifra aquí y no dentro del adapter: una vez por corrida en vez de una por NIT
  // (RN-17). En modo simulado ni se pide — un entorno sin credenciales debe poder ejercer el sync.
  const token = modo === 'real' ? await obtenerTokenSimit() : undefined;

  const iniciadoEn = new Date();
  const runId = await crearRun(nits, opciones.actorId, iniciadoEn);

  const ctx: ContextoCorrida = { runId, modo, mapa, municipios, token, concurrencia };

  log.info({
    runId, modo, nits: nits.length, municipios: municipios.length,
    mapaVersion: mapa.version, mapaProvisional: mapa.provisional, concurrencia,
    ttlMs: alcance.ttlMs, presupuestoNitMs: costoNit,
  }, 'sync de comparendos iniciado');

  const steps: ComparendosSyncStep[] = [];
  const resumen: ComparendosSyncResumen = resumenVacio(modo);
  const elegiblesParaInactivar: string[] = [];

  try {
    for (const nit of nits) {
      // RN-21. Se comprueba con el coste del NIT POR DELANTE y no contra el deadline pelado: entrar
      // a un NIT que no cabe es exactamente lo que hace que la corrida termine después de que su
      // lock haya expirado.
      if (Date.now() + costoNit > deadline) {
        resumen.abortadaPorTiempo = true;
        log.warn({
          runId, nitsProcesados: resumen.nitsProcesados, nitsDelAlcance: nits.length,
        }, 'sync de comparendos cortado por deadline: se cierra sin inactivar para no exceder el lock');
        break;
      }

      // Los NITs van en SERIE y solo las municipales de cada uno en paralelo (RN-17). Paralelizar
      // también los NITs multiplicaría las peticiones simultáneas al mismo proveedor por la cuota
      // contratada, que es justo lo que el rate limit del catálogo (HU #11497) protege.
      const nitResultado = await procesarNit(ctx, nit);
      steps.push(...nitResultado.steps);
      resumen.itemsIgnorados += nitResultado.itemsIgnorados;
      contarLlamadas(resumen, nitResultado.steps);
      await guardarPasos(runId, nitResultado.steps);

      const escritura = await escribirRegistros(ctx, nit, nitResultado.acumulador);
      resumen.upserts += escritura.upserts;
      resumen.primeraLlegada += escritura.primeraLlegada;
      resumen.reactivados += escritura.reactivados;

      resumen.nitsProcesados++;
      if (nitResultado.coberturaCompleta) elegiblesParaInactivar.push(nit);
    }

    // La inactivación va al FINAL y no por NIT: el número de comparendo es único en el país
    // (CF-07), así que el mismo comparendo puede aparecer bajo dos NITs monitoreados. Apagando NIT a
    // NIT, el primero lo inactivaría por ausencia y el segundo lo reactivaría en la misma corrida —
    // dos eventos de timeline para algo que nunca dejó de estar.
    //
    // Cortada por deadline NO se inactiva NADA, ni siquiera de los NITs que sí se completaron: el
    // margen que queda está reservado para cerrar, y un barrido es la operación más cara y menos
    // reversible de la corrida. Ante la duda, RN-18: no apagar.
    if (resumen.abortadaPorTiempo) {
      resumen.inactivacionOmitida = 'deadline';
    } else {
      const barrido = await inactivarAusentes(ctx.runId, elegiblesParaInactivar, municipios);
      resumen.inactivados = barrido.inactivados;
      resumen.inactivacionOmitida = barrido.omitida;
    }
    resumen.nitsSinInactivacion = nits.length - elegiblesParaInactivar.length;

    const estado = estadoDeLaCorrida(steps, resumen);
    const finalizadoEn = new Date();
    await cerrarRun(runId, estado, resumen, finalizadoEn);

    log.info({ runId, estado, ...sinModo(resumen) }, 'sync de comparendos terminado');

    return {
      runId,
      estado,
      iniciadoEn: iniciadoEn.toISOString(),
      finalizadoEn: finalizadoEn.toISOString(),
      scopeNits: [...nits],
      resumen,
      iniciadoPor: opciones.actorId,
      steps,
    };
  } catch (e) {
    // Un fallo inesperado (la base, un bug) no puede dejar la corrida en `running` para siempre: eso
    // haría creer al histórico que sigue viva. Se cierra como `failed` con lo que se llevaba contado
    // y el error sigue subiendo — taparlo aquí lo convertiría en un 200 mentiroso.
    await cerrarRun(runId, 'failed', resumen, new Date()).catch(() => undefined);
    log.error({ runId, err: e instanceof Error ? e.message : String(e) }, 'sync de comparendos abortado');
    throw e;
  }
}

/** Contadores en cero. `modo` viaja dentro para que quede guardado junto a los números. */
function resumenVacio(modo: ComparendosSyncModo): ComparendosSyncResumen {
  return {
    modo,
    nitsProcesados: 0,
    llamadasSimitOk: 0,
    llamadasSimitError: 0,
    llamadasMunicipalOk: 0,
    llamadasMunicipalError: 0,
    upserts: 0,
    inactivados: 0,
    reactivados: 0,
    primeraLlegada: 0,
    itemsIgnorados: 0,
    nitsSinInactivacion: 0,
    abortadaPorTiempo: false,
    inactivacionOmitida: null,
  };
}

/** El resumen sin `modo`, para no repetirlo en la línea de log que ya lo lleva en el contexto. */
function sinModo(resumen: ComparendosSyncResumen): Omit<ComparendosSyncResumen, 'modo'> {
  const { modo: _modo, ...resto } = resumen;
  return resto;
}

function contarLlamadas(resumen: ComparendosSyncResumen, steps: readonly ComparendosSyncStep[]): void {
  for (const step of steps) {
    if (step.fuente === FUENTE_SIMIT) {
      if (step.ok) resumen.llamadasSimitOk++; else resumen.llamadasSimitError++;
    } else if (step.ok) resumen.llamadasMunicipalOk++; else resumen.llamadasMunicipalError++;
  }
}

/**
 * `completed` si no falló nada, `failed` si no salió NADA bien, `partial` en medio.
 *
 * La distinción importa fuera de la pantalla: con `partial` hay NITs cuyos comparendos no se
 * inactivaron aunque parezcan ausentes (RN-18), así que un cero en «inactivados» significa cosas
 * distintas según el estado.
 *
 * Una corrida cortada por deadline (RN-21) o con el barrido frenado (RN-24) **nunca** es
 * `completed`, por buenos que sean sus pasos: dejó trabajo sin hacer, y decir «completada» haría
 * que ese cero en «inactivados» se leyera como «no había nada que apagar».
 */
function estadoDeLaCorrida(
  steps: readonly ComparendosSyncStep[], resumen: ComparendosSyncResumen,
): ComparendosSyncEstado {
  const ok = steps.filter((s) => s.ok).length;
  if (ok === 0) return steps.length === 0 ? 'partial' : 'failed';
  if (resumen.abortadaPorTiempo || resumen.inactivacionOmitida !== null) return 'partial';
  return ok === steps.length ? 'completed' : 'partial';
}

// ─────────────────────────────── Alcance y catálogos ────────────────────────────────────────────

/**
 * NITs de la corrida: los del filtro, o todos los activos (AC1).
 *
 * Un NIT del filtro que no esté ACTIVO se rechaza en vez de ignorarse. Ignorarlo devolvería un 200
 * con una corrida que no hizo lo que se le pidió, y eso se descubre tarde y mal: alguien mira el
 * resultado, ve ceros y concluye que la empresa no debe nada.
 */
async function resolverScope(filtro: readonly string[] | undefined): Promise<string[]> {
  const activos = await db.select({ nit: flitoComparendosNits.nit })
    .from(flitoComparendosNits)
    .where(eq(flitoComparendosNits.activo, true))
    .orderBy(flitoComparendosNits.nit);

  const disponibles = activos.map((f) => f.nit);
  if (disponibles.length === 0) throw new ComparendosSinNitsActivosError();

  if (!filtro || filtro.length === 0) return disponibles;

  // Se normaliza igual que en el alta (RN-01): quien pida «900.123.456» está pidiendo el mismo NIT
  // que se guardó como `900123456`, y rechazarlo por la puntuación sería un 400 incomprensible.
  const pedidos = [...new Set(filtro.map((n) => normalizarNit(n)))];
  const conocidos = new Set(disponibles);
  const desconocidos = pedidos.filter((n) => !conocidos.has(n));
  if (desconocidos.length > 0) throw new ComparendosFiltroNitsInvalidoError(desconocidos);

  return pedidos;
}

/** Municipios a los que se les pregunta. Sin activos, la corrida es solo SIMIT (no es un error). */
async function municipiosActivos(): Promise<string[]> {
  const filas = await db.select({ codigoFuente: flitoComparendosMunicipios.codigoFuente })
    .from(flitoComparendosMunicipios)
    .where(eq(flitoComparendosMunicipios.activo, true))
    .orderBy(flitoComparendosMunicipios.codigoFuente);
  return filas.map((f) => f.codigoFuente);
}

// ─────────────────────────────── Llamadas a las fuentes ─────────────────────────────────────────

interface ResultadoNit {
  steps: ComparendosSyncStep[];
  acumulador: AcumuladorNit;
  itemsIgnorados: number;
  /** SIMIT ok **y** todos los municipios activos ok: la condición del CF-10 (RN-18, RN-22). */
  coberturaCompleta: boolean;
}

async function procesarNit(ctx: ContextoCorrida, nit: string): Promise<ResultadoNit> {
  const acumulador: AcumuladorNit = new Map();
  let itemsIgnorados = 0;

  // SIMIT primero y en serie: es una sola llamada por NIT y su resultado es el que manda en el
  // merge, así que no hay nada que ganar solapándola con las municipales.
  const simit = await llamarSimit(ctx, nit);
  if (simit.items) {
    const ignorados = acumularSimit(acumulador, simit.items, candidatosDe(ctx.mapa, 'simit'));
    itemsIgnorados += ignorados;
    // RN-22: el veredicto de legibilidad se aplica al paso ANTES de que nadie mire `ok`, porque `ok`
    // es lo único que la cobertura del CF-10 consulta.
    simit.step = pasoIlegibleSiProcede(simit.step, 'simit', simit.items.length, ignorados);
  }

  // El pool (RN-17). `enPool` conserva el orden de los resultados aunque las llamadas terminen
  // desordenadas: los pasos de una corrida deben leerse siempre en el mismo orden que el catálogo.
  const municipales = await enPool(
    ctx.municipios, ctx.concurrencia, (codigoFuente) => llamarMunicipal(ctx, nit, codigoFuente),
  );

  for (const municipal of municipales) {
    if (!municipal.items) continue;
    const ignorados = acumularMunicipal(
      acumulador, municipal.items, candidatosDe(ctx.mapa, 'municipal'), municipal.step.fuente,
    );
    itemsIgnorados += ignorados;
    municipal.step = pasoIlegibleSiProcede(municipal.step, 'municipal', municipal.items.length, ignorados);
  }

  const steps = [simit.step, ...municipales.map((m) => m.step)];
  return {
    steps,
    acumulador,
    itemsIgnorados,
    coberturaCompleta: simit.step.ok && municipales.every((m) => m.step.ok),
  };
}

/**
 * Degrada a paso FALLIDO el que respondió bien pero cuyos ítems no se pudieron identificar (RN-22).
 *
 * Se marca `ok: false` en vez de solo restarle la cobertura, y la decisión tiene tres motivos:
 *
 *   1. Es lo mismo que ya hace `ComparendosFuenteRespuestaIlegibleError` un escalón más arriba. «No
 *      entiendo esta respuesta» es un fallo, aunque llegue con un 200: tratarlo como éxito es
 *      exactamente lo que convierte un cambio de contrato del proveedor en un apagón silencioso.
 *   2. La corrida pasa a `partial` y el paso queda con su `errorCode` en `sync_steps`, que es lo que
 *      el operador ve. Con `ok: true` la pantalla diría «completada, 0 comparendos» y nadie iría a
 *      mirar el `field_map`.
 *   3. La cobertura del CF-10 se calcula sobre `ok`, así que la regla queda en UN sitio y no en dos
 *      condiciones que hay que acordarse de mantener sincronizadas.
 *
 * Lo que sí se conserva es lo que sí se entendió: los ítems con número ya están en el acumulador y se
 * escriben igual. Un fallo parcial no tira los datos buenos.
 */
function pasoIlegibleSiProcede(
  step: ComparendosSyncStep, origen: ComparendosOrigenFuente, itemsLeidos: number, ignorados: number,
): ComparendosSyncStep {
  if (!step.ok || itemsLeidos === 0) return step;
  if (ignorados / itemsLeidos <= RATIO_IGNORADOS_ILEGIBLE) return step;

  const e = new ComparendosHomologacionIlegibleError(origen, step.fuente, step.httpStatus, ignorados, itemsLeidos);
  return { ...step, ok: false, errorCode: e.codigo, mensaje: e.message };
}

interface ResultadoLlamada {
  step: ComparendosSyncStep;
  /** Ítems crudos, o `null` si la fuente falló. `null` NO es lista vacía: ver RN-18. */
  items: Record<string, unknown>[] | null;
}

async function llamarSimit(ctx: ContextoCorrida, nit: string): Promise<ResultadoLlamada> {
  const inicio = Date.now();
  try {
    const r = await consultarComparendosSimit(nit, ctx.token ? { token: ctx.token } : {});
    return {
      step: paso(nit, FUENTE_SIMIT, { ok: true, httpStatus: r.httpStatus, itemsLeidos: r.items.length }, inicio),
      items: r.items as Record<string, unknown>[],
    };
  } catch (e) {
    return { step: pasoFallido(nit, FUENTE_SIMIT, e, inicio), items: null };
  }
}

async function llamarMunicipal(ctx: ContextoCorrida, nit: string, codigoFuente: string): Promise<ResultadoLlamada> {
  const inicio = Date.now();
  try {
    const r = await consultarComparendosMunicipales(nit, codigoFuente);
    return {
      step: paso(nit, codigoFuente, { ok: true, httpStatus: r.httpStatus, itemsLeidos: r.items.length }, inicio),
      items: r.items as Record<string, unknown>[],
    };
  } catch (e) {
    return { step: pasoFallido(nit, codigoFuente, e, inicio), items: null };
  }
}

function paso(
  nit: string, fuente: string,
  datos: { ok: boolean; httpStatus: number | null; itemsLeidos: number | null; errorCode?: string; mensaje?: string },
  inicio: number,
): ComparendosSyncStep {
  return {
    nit,
    fuente,
    ok: datos.ok,
    httpStatus: datos.httpStatus,
    errorCode: datos.errorCode ?? null,
    mensaje: datos.mensaje ?? null,
    itemsLeidos: datos.itemsLeidos,
    duracionMs: Date.now() - inicio,
  };
}

/**
 * Traduce lo que salió mal a un paso fallido.
 *
 * **Se discrimina por `ComparendosError` y NO por `ComparendosFuenteError`**, y esa línea es la
 * corrección que dejó pedida el gate de la HU #11499: los tres fallos del token —`llave_maestra`,
 * `token_no_configurado` y `token_descifrado`— salen del servicio del token, no de la fuente, así
 * que **no** heredan de `ComparendosFuenteError` (está escrito en el `@throws` de
 * `verifik-simit.client.ts`). Con el `instanceof` estrecho, esos tres caían en la rama de «error
 * inesperado» y el paso perdía su código: el operador vería «fallo inesperado» donde lo que pasa es
 * que falta provisionar una variable.
 *
 * El `httpStatus` solo existe cuando hubo proveedor al otro lado; los errores de configuración y de
 * token no lo tienen.
 *
 * De lo que NO es del dominio se guarda un texto fijo. Un `err.message` de librería es texto
 * arbitrario que puede arrastrar la URL, un cuerpo de respuesta o datos del infractor, y esta cadena
 * se PERSISTE en `sync_steps.mensaje` (RN-20). El detalle real va al log de la aplicación.
 */
function pasoFallido(nit: string, fuente: string, e: unknown, inicio: number): ComparendosSyncStep {
  if (e instanceof ComparendosError) {
    const httpStatus = e instanceof ComparendosFuenteError ? e.httpStatus : null;
    return paso(nit, fuente, {
      ok: false, httpStatus, itemsLeidos: null, errorCode: e.codigo, mensaje: e.message,
    }, inicio);
  }

  log.error({ fuente, nit: maskDocument(nit), err: e instanceof Error ? e.message : String(e) },
    'fallo inesperado consultando una fuente de comparendos');
  return paso(nit, fuente, {
    ok: false, httpStatus: null, itemsLeidos: null,
    errorCode: 'error_inesperado',
    mensaje: 'Fallo inesperado al consultar la fuente. Revisa el log de la aplicación con el id de la corrida.',
  }, inicio);
}

/**
 * Ejecuta `tarea` sobre `items` con como mucho `limite` en vuelo (ADR-0001 §7).
 *
 * Los resultados salen en el orden de entrada, no en el de terminación. Y una condición que el
 * llamador debe cumplir: **`tarea` no puede rechazar**. Si lo hiciera, `Promise.all` cortaría aquí
 * dejando a los demás trabajadores corriendo sin nadie que los espere — peticiones huérfanas contra
 * el proveedor y una corrida que se cierra antes de tiempo. Por eso `llamarMunicipal` atrapa todo y
 * devuelve un paso fallido en vez de lanzar.
 */
async function enPool<T, R>(
  items: readonly T[], limite: number, tarea: (item: T) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;

  const trabajador = async (): Promise<void> => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await tarea(items[i]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, trabajador),
  );
  return resultados;
}

// ─────────────────────────────── Escritura del consolidado ──────────────────────────────────────

interface ResultadoEscritura {
  upserts: number;
  primeraLlegada: number;
  reactivados: number;
}

/** Fila existente: solo las columnas que el merge necesita para decidir (RN-13). */
type FilaExistente = {
  id: string;
  numeroComparendo: string;
  estado: 'activo' | 'inactivo';
  vistoEnSimit: boolean;
  vistoEnMunicipal: boolean;
  municipioFuente: string | null;
  placa: string | null;
  codigoInfraccion: string | null;
  descripcionInfraccion: string | null;
  fechaComparendo: string | null;
  organismo: string | null;
  monto: string | null;
  estadoFuente: string | null;
};

/**
 * Escribe el consolidado de un NIT: upsert por `numero_comparendo` (AC2) + timeline (AC3).
 *
 * Una transacción por NIT y no una por corrida: encierra lo que tiene que ser atómico —los registros
 * de este NIT y sus eventos— sin mantener abierta una transacción durante TODAS las llamadas HTTP de
 * la matriz, que es lo que pasaría con una sola. Una transacción larga bloquea vacuum y se lleva por
 * delante una conexión del pool durante minutos.
 */
async function escribirRegistros(
  ctx: ContextoCorrida, nit: string, acumulador: AcumuladorNit,
): Promise<ResultadoEscritura> {
  const total: ResultadoEscritura = { upserts: 0, primeraLlegada: 0, reactivados: 0 };
  if (acumulador.size === 0) return total;

  const ahora = new Date();
  const consolidados = [...acumulador.values()];
  const eventos: { registroId: string; tipo: 'primera_llegada' | 'reaparicion'; detalle: unknown }[] = [];

  await db.transaction(async (tx) => {
    // Se leen las filas que ya existen para esos números ANTES de escribir: el merge necesita el
    // valor anterior de cada campo (RN-13) y el estado anterior para saber si esto es una reaparición.
    const existentes = new Map<string, FilaExistente>();
    for (const lote of enLotes(consolidados.map((c) => c.numero), TAMANO_LOTE)) {
      const filas = await tx.select({
        id: flitoComparendosRegistros.id,
        numeroComparendo: flitoComparendosRegistros.numeroComparendo,
        estado: flitoComparendosRegistros.estado,
        vistoEnSimit: flitoComparendosRegistros.vistoEnSimit,
        vistoEnMunicipal: flitoComparendosRegistros.vistoEnMunicipal,
        municipioFuente: flitoComparendosRegistros.municipioFuente,
        placa: flitoComparendosRegistros.placa,
        codigoInfraccion: flitoComparendosRegistros.codigoInfraccion,
        descripcionInfraccion: flitoComparendosRegistros.descripcionInfraccion,
        fechaComparendo: flitoComparendosRegistros.fechaComparendo,
        organismo: flitoComparendosRegistros.organismo,
        monto: flitoComparendosRegistros.monto,
        estadoFuente: flitoComparendosRegistros.estadoFuente,
      })
        .from(flitoComparendosRegistros)
        .where(inArray(flitoComparendosRegistros.numeroComparendo, lote));
      for (const fila of filas) existentes.set(fila.numeroComparendo, fila as FilaExistente);
    }

    for (const consolidado of consolidados) {
      const existente = existentes.get(consolidado.numero) ?? null;
      const vistoEnSimit = (existente?.vistoEnSimit ?? false) || consolidado.simit !== null;
      const vistoEnMunicipal = (existente?.vistoEnMunicipal ?? false) || consolidado.municipal !== null;
      const campos = resolverCampos(consolidado, existente);

      const comun = {
        ...campos,
        // El municipio se conserva si esta corrida no lo trajo: es la pista de dónde se vio y no un
        // dato que el SIMIT pueda contradecir.
        municipioFuente: consolidado.municipioFuente ?? existente?.municipioFuente ?? null,
        origenMerge: origenMerge(vistoEnSimit, vistoEnMunicipal),
        vistoEnSimit,
        vistoEnMunicipal,
        ultimoVistoEn: ahora,
        ultimoSyncRunId: ctx.runId,
        updatedAt: ahora,
      };

      if (existente) {
        await tx.update(flitoComparendosRegistros).set({
          ...comun,
          // Los payloads solo se pisan si esta corrida trajo uno nuevo: el de la otra fuente sigue
          // siendo la materia prima del spike de homologación. Llegan aquí YA PODADOS a la lista
          // blanca del `field_map` (RN-25): lo que este UPDATE escribe no lleva nombre ni documento
          // del infractor.
          ...(consolidado.payloadSimit === null || consolidado.payloadSimit === undefined
            ? {} : { payloadSimit: consolidado.payloadSimit }),
          ...(consolidado.payloadMunicipal === null || consolidado.payloadMunicipal === undefined
            ? {} : { payloadMunicipal: consolidado.payloadMunicipal }),
          // Reaparición (AC3): volvió a estar, así que se limpia la marca de apagado.
          ...(existente.estado === 'inactivo' ? { estado: 'activo' as const, inactivadoEn: null } : {}),
        }).where(eq(flitoComparendosRegistros.id, existente.id));

        total.upserts++;
        if (existente.estado === 'inactivo') {
          total.reactivados++;
          eventos.push({ registroId: existente.id, tipo: 'reaparicion', detalle: { origen: comun.origenMerge } });
        }
        continue;
      }

      // Alta. `nitMonitoreado` guarda el NIT con el que se PREGUNTÓ; si el mismo comparendo aparece
      // después bajo otro NIT monitoreado, la fila no cambia de dueño (rama de arriba): es la misma
      // deuda vista dos veces, no dos filas (CF-07), y reescribir el NIT haría bailar el dato.
      const insertado = await insertarRegistro(tx, {
        numeroComparendo: consolidado.numero,
        nitMonitoreado: nit,
        ...comun,
        payloadSimit: consolidado.payloadSimit ?? null,
        payloadMunicipal: consolidado.payloadMunicipal ?? null,
        estado: 'activo' as const,
        primeraVistoEn: ahora,
        createdAt: ahora,
      }, consolidado.numero);

      total.upserts++;
      if (insertado.nuevo) {
        total.primeraLlegada++;
        eventos.push({ registroId: insertado.id, tipo: 'primera_llegada', detalle: { origen: comun.origenMerge } });
      }
    }

    if (eventos.length > 0) {
      await tx.insert(flitoComparendosEventos)
        .values(eventos.map((e) => ({
          registroId: e.registroId,
          tipo: e.tipo,
          syncRunId: ctx.runId,
          // Sin NIT, sin placa y sin nada del proveedor (RN-20): el timeline se lee entero en la
          // pantalla de 17b y el registro al que apunta ya tiene esos datos.
          detalle: e.detalle,
        })))
        // El anti-spam es el único `(registro_id, tipo, sync_run_id)` de la 0150 (RN-19): re-ejecutar
        // una corrida no puede duplicar el timeline, y confiar en el flujo no basta.
        .onConflictDoNothing();
    }
  });

  return total;
}

/**
 * INSERT del registro, con la carrera contra el índice único resuelta.
 *
 * El SELECT previo cubre el caso normal; esto cubre el hueco entre leer y escribir. Puede parecer
 * imposible con el lock de RN-15, pero el mismo comparendo puede llegar dos veces DENTRO de la misma
 * corrida bajo dos NITs distintos, y ahí el 23505 es real. Se resuelve pasando a UPDATE por número:
 * el registro existe, que es lo que importaba.
 */
async function insertarRegistro(
  tx: Tx,
  valores: typeof flitoComparendosRegistros.$inferInsert,
  numero: string,
): Promise<{ id: string; nuevo: boolean }> {
  try {
    const [creado] = await tx.insert(flitoComparendosRegistros).values(valores)
      .returning({ id: flitoComparendosRegistros.id });
    return { id: creado.id, nuevo: true };
  } catch (e) {
    if (!esViolacionDeUnicidad(e)) throw e;
    const { numeroComparendo: _numero, nitMonitoreado: _nit, primeraVistoEn: _primera, createdAt: _creado, ...cambios } = valores;
    const [actualizado] = await tx.update(flitoComparendosRegistros).set(cambios)
      .where(eq(flitoComparendosRegistros.numeroComparendo, numero))
      .returning({ id: flitoComparendosRegistros.id });
    // Sin `nuevo`: no es un alta, así que no genera `primera_llegada` (RN-19).
    return { id: actualizado.id, nuevo: false };
  }
}

/** Parte una lista en trozos del tamaño pedido. */
function* enLotes<T>(items: readonly T[], tamano: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += tamano) yield items.slice(i, i + tamano);
}

// ─────────────────────────────── Inactivación (RN-18, AC3) ──────────────────────────────────────

interface ResultadoBarrido {
  inactivados: number;
  /** `'umbral'` si el freno de RN-24 lo detuvo; `null` si el barrido se ejecutó. */
  omitida: 'umbral' | null;
}

/**
 * Filas del NIT que siguen activas: el universo del barrido y el denominador del freno de RN-24.
 */
function alcanceDelBarrido(lote: readonly string[]): SQL {
  return and(
    inArray(flitoComparendosRegistros.nitMonitoreado, [...lote]),
    eq(flitoComparendosRegistros.estado, 'activo'),
  )!;
}

/**
 * La condición de «esta corrida no lo vio, **y podría haberlo visto**» (RN-23).
 *
 * Dos mitades, y la segunda es la corrección del gate:
 *
 *   · `ultimo_sync_run_id IS DISTINCT FROM <run>` — no se volvió a ver. Se resuelve así y no con un
 *     `NOT IN (…números…)` por dos motivos: la lista de números puede ser de miles (y el `IN` tiene
 *     un techo de parámetros), y sobre todo porque un comparendo que se escribió en esta corrida
 *     bajo OTRO NIT monitoreado también quedó marcado con el run — así que queda fuera
 *     automáticamente y no se apaga por una ausencia que no existe. `IS DISTINCT FROM` y no `<>`:
 *     las filas nunca sincronizadas tienen la columna en `NULL` y `<>` daría `NULL`, así que no se
 *     inactivarían jamás.
 *
 *   · `municipio_fuente IS NULL OR municipio_fuente IN (municipios consultados)` — se le preguntó a
 *     quien lo reporta. Sin esto, desactivar un municipio en el catálogo (PATCH de la HU #11497)
 *     apaga en la corrida siguiente todo el histórico que solo ese UTS reporta: no se le pregunta,
 *     SIMIT sigue `ok`, la cobertura sale completa y el barrido lo lee como ausencia. `IS NULL` son
 *     los comparendos que solo se han visto por SIMIT —`municipio_fuente` lo escribe únicamente
 *     `acumularMunicipal`—, y de esos SIMIT sí es fuente suficiente.
 *
 * Con CERO municipios activos la segunda mitad se reduce a `IS NULL`, que es justo lo que hay que
 * hacer: un sync solo-SIMIT no puede apagar nada de origen municipal. El caso no es teórico —
 * `municipales.every(...)` sobre una lista vacía es `true`, así que la cobertura sale completa.
 *
 * Es deliberadamente conservador: un comparendo visto por SIMIT y por un municipio desactivado
 * conserva su `municipio_fuente` y ya no se inactiva. Preferir el falso negativo es RN-18.
 */
function condicionAusente(runId: string, municipiosConsultados: readonly string[]): SQL {
  const vistoPorFuenteConsultada = municipiosConsultados.length === 0
    ? isNull(flitoComparendosRegistros.municipioFuente)
    : or(
      isNull(flitoComparendosRegistros.municipioFuente),
      inArray(flitoComparendosRegistros.municipioFuente, [...municipiosConsultados]),
    )!;

  return and(
    sql`${flitoComparendosRegistros.ultimoSyncRunId} IS DISTINCT FROM ${runId}::uuid`,
    vistoPorFuenteConsultada,
  )!;
}

/**
 * ¿El barrido apagaría tanto que lo más probable es que el equivocado sea él? (RN-24)
 *
 * El tope de filas manda siempre; el de porcentaje solo cuando hay activos suficientes para que un
 * porcentaje signifique algo (`MIN_ACTIVOS_PARA_FRENO_RATIO`).
 */
function superaElFreno(candidatos: number, activos: number): boolean {
  if (candidatos > env.COMPARENDOS_INACTIVACION_MAX_FILAS) return true;
  return activos >= MIN_ACTIVOS_PARA_FRENO_RATIO
    && candidatos / activos > env.COMPARENDOS_INACTIVACION_MAX_RATIO;
}

/**
 * Apaga los comparendos activos de los NITs con cobertura completa que esta corrida NO volvió a ver.
 *
 * Se cuenta antes de escribir (RN-24). Contar y luego actualizar cuesta una consulta más, pero es lo
 * que permite NO hacer el barrido en vez de deshacerlo: una inactivación masiva es reversible en los
 * registros —`reaparicion` los devuelve a activo— y NO lo es en el timeline, porque el único
 * `(registro, tipo, run)` de RN-19 deduplica dentro de una corrida, no entre corridas. Los eventos
 * de un apagón en falso se quedan escritos.
 */
async function inactivarAusentes(
  runId: string, nits: readonly string[], municipiosConsultados: readonly string[],
): Promise<ResultadoBarrido> {
  if (nits.length === 0) return { inactivados: 0, omitida: null };

  const ausente = condicionAusente(runId, municipiosConsultados);
  const lotes = [...enLotes(nits, TAMANO_LOTE)];

  let candidatos = 0;
  let activos = 0;
  for (const lote of lotes) {
    // Un solo recorrido por lote: el `filter` cuenta los que se apagarían y el `count(*)` el
    // denominador, sin traerse ni una fila a la aplicación.
    const [conteo] = await db.select({
      candidatos: sql<number>`count(*) filter (where ${ausente})`.mapWith(Number),
      activos: sql<number>`count(*)`.mapWith(Number),
    })
      .from(flitoComparendosRegistros)
      .where(alcanceDelBarrido(lote));
    candidatos += Number(conteo?.candidatos ?? 0);
    activos += Number(conteo?.activos ?? 0);
  }

  if (candidatos > 0 && superaElFreno(candidatos, activos)) {
    log.error({
      runId, candidatos, activos,
      maxFilas: env.COMPARENDOS_INACTIVACION_MAX_FILAS, maxRatio: env.COMPARENDOS_INACTIVACION_MAX_RATIO,
    }, 'barrido de inactivación frenado: apagaría más comparendos de los permitidos por corrida');
    return { inactivados: 0, omitida: 'umbral' };
  }

  const ahora = new Date();
  let inactivados = 0;

  await db.transaction(async (tx) => {
    for (const lote of lotes) {
      const filas = await tx.update(flitoComparendosRegistros)
        .set({ estado: 'inactivo', inactivadoEn: ahora, ultimoSyncRunId: runId, updatedAt: ahora })
        .where(and(alcanceDelBarrido(lote), ausente))
        .returning({ id: flitoComparendosRegistros.id });

      if (filas.length === 0) continue;
      inactivados += filas.length;

      await tx.insert(flitoComparendosEventos)
        .values(filas.map((f) => ({
          registroId: f.id,
          tipo: 'inactivacion' as const,
          syncRunId: runId,
          detalle: { motivo: 'ausente_en_todas_las_fuentes' },
        })))
        .onConflictDoNothing();
    }
  });

  return { inactivados, omitida: null };
}

// ─────────────────────────────── Persistencia de la corrida ─────────────────────────────────────

async function crearRun(nits: readonly string[], actorId: number | null, iniciadoEn: Date): Promise<string> {
  const [creada] = await db.insert(flitoComparendosSyncRuns).values({
    estado: 'running',
    scopeNits: [...nits],
    iniciadoPor: actorId,
    iniciadoEn,
  }).returning({ id: flitoComparendosSyncRuns.id });
  return creada.id;
}

async function cerrarRun(
  runId: string, estado: ComparendosSyncEstado, resumen: ComparendosSyncResumen, finalizadoEn: Date,
): Promise<void> {
  await db.update(flitoComparendosSyncRuns)
    .set({ estado, resumen, finalizadoEn })
    .where(eq(flitoComparendosSyncRuns.id, runId));
}

/**
 * Pasos de un NIT, persistidos al terminarlo.
 *
 * Se escriben por NIT y no al final de todo: si la corrida muere a la mitad, lo ya consultado queda
 * en la base y se puede ver qué fuente estaba fallando. Un único INSERT por NIT, no uno por paso.
 */
async function guardarPasos(runId: string, steps: readonly ComparendosSyncStep[]): Promise<void> {
  if (steps.length === 0) return;
  await db.insert(flitoComparendosSyncSteps).values(steps.map((s) => ({
    runId,
    nit: s.nit,
    fuente: s.fuente,
    ok: s.ok,
    httpStatus: s.httpStatus,
    errorCode: s.errorCode,
    mensaje: s.mensaje,
    itemsLeidos: s.itemsLeidos,
    duracionMs: s.duracionMs,
  })));
}

// ─────────────────────────────── Lectura de corridas (AC4) ──────────────────────────────────────

/** Últimas corridas, de la más reciente a la más antigua. Sin pasos: eso es el detalle. */
export async function listarSyncRuns(limite: number): Promise<ComparendosSyncRun[]> {
  const filas = await db.select().from(flitoComparendosSyncRuns)
    .orderBy(desc(flitoComparendosSyncRuns.iniciadoEn))
    .limit(limite);
  return filas.map(runDto);
}

/** Una corrida con su detalle por fuente. `null` no: el 404 lo decide el error de dominio. */
export async function obtenerSyncRun(id: string): Promise<ComparendosSyncResultado> {
  const [fila] = await db.select().from(flitoComparendosSyncRuns)
    .where(eq(flitoComparendosSyncRuns.id, id))
    .limit(1);
  if (!fila) throw new ComparendosNoEncontradoError('La corrida de sincronización no existe.');

  const pasos = await db.select().from(flitoComparendosSyncSteps)
    .where(eq(flitoComparendosSyncSteps.runId, id))
    .orderBy(flitoComparendosSyncSteps.createdAt);

  return {
    ...runDto(fila),
    steps: pasos.map((p) => ({
      nit: p.nit,
      fuente: p.fuente,
      ok: p.ok,
      httpStatus: p.httpStatus,
      errorCode: p.errorCode,
      mensaje: p.mensaje,
      itemsLeidos: p.itemsLeidos,
      duracionMs: p.duracionMs,
    })),
  };
}

function runDto(fila: typeof flitoComparendosSyncRuns.$inferSelect): ComparendosSyncRun {
  return {
    runId: fila.id,
    estado: fila.estado,
    iniciadoEn: fila.iniciadoEn.toISOString(),
    finalizadoEn: fila.finalizadoEn?.toISOString() ?? null,
    // La columna es JSONB: lo que se lee es lo que se escribió, pero el tipo que da drizzle es
    // `unknown` y el `as` es la única forma de recuperar la forma que se guardó.
    scopeNits: Array.isArray(fila.scopeNits) ? fila.scopeNits : [],
    resumen: (fila.resumen as ComparendosSyncResumen | null) ?? null,
    iniciadoPor: fila.iniciadoPor,
  };
}
