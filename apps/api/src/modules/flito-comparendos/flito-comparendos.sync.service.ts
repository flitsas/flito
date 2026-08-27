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
//        fue `ok` **y** cuyos municipios activos fueron TODOS `ok` y CONCLUYENTES (RN-47). Un
//        municipio con timeout no significa «este comparendo ya no existe», significa «hoy no
//        sabemos» — y uno que contesta sin veredicto tampoco significa nada más que eso.
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
// RN-47  Cobertura es «respondió Y se pronunció», no solo «respondió» (Bug #11711 AC8). El UTS
//        municipal contesta a veces con `codigoEstado: null` y cero comparendos, y eso no es «este
//        NIT no debe nada»: es «no sé decirte». Medido contra el proveedor el 2026-08-21, y lo que
//        se midió es que el código NO correlaciona con nada — el mismo MEDELLIN responde `1` con un
//        comparendo para un NIT y `null` con cero para otro, y BELLO responde `1` con cero—. De ahí
//        las dos mitades de la regla: ni se puede deducir «sin deuda» de la ausencia de veredicto,
//        ni se puede tratar esa ausencia como avería (exigir veredicto dejaría a esos municipios
//        caídos para siempre, y un municipio caído es un `partial` eterno). Así que el paso queda
//        `ok` —la corrida sigue, el municipio no se marca como caído— pero NO cuenta como cobertura
//        para el CF-10, con lo que ningún comparendo de ese NIT se apaga por ausencia. El motivo
//        viaja en `sync_steps.mensaje`, que ya se conserva: sin columna nueva y sin copiar una
//        palabra del proveedor.
//
//        **Lo que esta regla cuesta, decidido a sabiendas y no descubierto después.** MEDELLIN
//        contesta `codigoEstado: null` de forma RUTINARIA —no excepcional— a los NIT que no tienen
//        comparendos allí (medido el 2026-08-21). Como la cobertura es del NIT entero y no por
//        fuente, la consecuencia es esta: **todo NIT monitoreado que tenga MEDELLIN activo y no deba
//        nada en MEDELLIN deja de ejecutar el barrido de inactivación**, y no solo sobre las filas de
//        ese municipio: también sobre las que solo reporta SIMIT. No es un estado transitorio —
//        mientras el proveedor siga contestando así, esos NIT no inactivarán por ausencia NUNCA— y
//        no hay alerta: la corrida se cierra `completed` y las dos únicas señales de que esto está
//        pasando son `resumen.nitsSinInactivacion` (que sube) y el `mensaje` del paso.
//
//        David lo revisó con esa consecuencia delante y decidió que se queda así (2026-08-21). El
//        criterio es el de todo el módulo: entre apagar de más y no apagar, se elige no apagar. Un
//        histórico apagado en falso le dice al cliente que no debe nada, y su rastro en el timeline
//        no se borra (RN-19); un histórico congelado se ve feo en los contadores pero no miente
//        sobre la deuda. Se revisa cuando el módulo se encienda y haya datos reales de cuántos NIT
//        quedan congelados; la salida natural, si duele, es afinar la cobertura POR FILAS —solo las
//        del municipio que calló— en vez de por NIT, que es más trabajo y más riesgo del que hoy se
//        justifica (ver el test «un municipio mudo entre varios frena la inactivación del NIT
//        ENTERO, y es a propósito»).
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
 * Mismo razonamiento que el mínimo de operaciones de la política de freno de Siigo
 * (`POLITICA` en `modules/siigo/siigo.freno.service.ts`): sobre una muestra
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
  /**
   * El catálogo COMPLETO de municipios (activos y no), para derivar `municipio_comparendo`
   * (HU #11878). No es `municipios` con otro nombre: aquella es a quién se le PREGUNTA en esta
   * corrida y por eso solo lleva los activos; esta es con qué se RECONOCE de dónde es un comparendo,
   * y desactivar una fuente no borra de dónde eran los suyos. Se lee una vez por corrida.
   */
  catalogoMunicipios: readonly string[];
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
  // El catálogo entero, una vez por corrida y DENTRO del lock: es dato de escritura (alimenta
  // `municipio_comparendo`), no de alcance, así que no tiene por qué leerse antes de saber si esta
  // corrida se va a hacer. Un catálogo vacío no es un error como sí lo es un mapa vacío (RN-12):
  // significa que ningún organismo se va a reconocer y el escalón 2 devuelve `null` para todos, que
  // es lo mismo que había antes de la HU #11878.
  const catalogo = await catalogoMunicipios();
  // El token se descifra aquí y no dentro del adapter: una vez por corrida en vez de una por NIT
  // (RN-17). En modo simulado ni se pide — un entorno sin credenciales debe poder ejercer el sync.
  const token = modo === 'real' ? await obtenerTokenSimit() : undefined;

  const iniciadoEn = new Date();
  const runId = await crearRun(nits, opciones.actorId, iniciadoEn);

  const ctx: ContextoCorrida = {
    runId, modo, mapa, municipios, catalogoMunicipios: catalogo, token, concurrencia,
  };

  log.info({
    runId, modo, nits: nits.length, municipios: municipios.length,
    mapaVersion: mapa.version, mapaProvisional: mapa.provisional, concurrencia,
    ttlMs: alcance.ttlMs, presupuestoNitMs: costoNit,
  }, 'sync de comparendos iniciado');

  const steps: ComparendosSyncStep[] = [];
  const resumen: ComparendosSyncResumen = resumenVacio(modo);
  const elegiblesParaInactivar: string[] = [];
  // HU #11806. Telemetría de la corrida, no dato del histórico: ver `ResultadoNit.formasNumero`.
  const formasNumero = new Map<string, number>();

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
      for (const [llave, n] of nitResultado.formasNumero) {
        formasNumero.set(llave, (formasNumero.get(llave) ?? 0) + n);
      }
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

    log.info(
      { runId, estado, formasNumero: histogramaLegible(formasNumero), ...sinModo(resumen) },
      'sync de comparendos terminado',
    );

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

/**
 * El histograma de formas como objeto plano y ORDENADO, que es como se lee en un log (HU #11806).
 *
 * Se construye con `Object.fromEntries` sobre llaves que produce `formaNumero` —tokens de un
 * alfabeto cerrado (`D20`, `L1D20`, `OTRO`, `LARGO`…) precedidos por el código de fuente—, así que
 * ninguna clave viene del proveedor y no hay aquí el problema de RN-14. El orden es alfabético para
 * que dos corridas se puedan comparar a ojo.
 */
function histogramaLegible(formas: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...formas.entries()].sort(([a], [b]) => a.localeCompare(b)));
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

/**
 * El catálogo ENTERO de códigos de municipio, activos y no (HU #11878).
 *
 * Es la lista con la que `municipioDelComparendo` reconoce el organismo, y por eso NO filtra por
 * `activo`: dar de baja una fuente deja de consultarla, no cambia de dónde eran los comparendos que
 * ya trajo. Filtrar aquí haría que desactivar Medellín vaciara el municipio de sus comparendos en el
 * siguiente sync —el dato se re-deriva entero en cada corrida—, que es justamente el fallo que esta
 * HU cierra por el otro lado.
 */
async function catalogoMunicipios(): Promise<string[]> {
  const filas = await db.select({ codigoFuente: flitoComparendosMunicipios.codigoFuente })
    .from(flitoComparendosMunicipios)
    .orderBy(flitoComparendosMunicipios.codigoFuente);
  return filas.map((f) => f.codigoFuente);
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
  /**
   * Histograma de FORMAS del número, por PASO: `SIMIT|D20`, `MEDELLIN|L1D20`… (HU #11806).
   *
   * La llave lleva la fuente delante porque sin eso el histograma no responde la pregunta para la
   * que existe: no es «qué formas hubo en la corrida», es **qué forma emite cada municipio**. La
   * regla de `numeroCanonico` se escribió con muestra de tres de los nueve municipios sembrados, y
   * esta es la única vía por la que los otros seis se declaran solos, en una corrida real.
   *
   * No entra en `ComparendosSyncResumen` a propósito: ese tipo es contrato publicado en
   * `@operaciones/shared-types` y lo pinta el histórico. Esto es telemetría de diagnóstico, va al
   * `log.info` de cierre y se muere ahí. Sumarlo al resumen obligaría a una migración de la columna
   * `resumen` y a que el front supiera qué hacer con un token que puede cambiar mañana.
   */
  formasNumero: Map<string, number>;
  /**
   * SIMIT ok **y** todos los municipios activos ok Y CONCLUYENTES: la condición del CF-10
   * (RN-18, RN-22, RN-47).
   */
  coberturaCompleta: boolean;
}

/**
 * Vuelca el histograma de un paso en el de la corrida, con la fuente por delante.
 *
 * `formaNumero` ya garantiza que el token no lleva el número, solo su forma: aquí no hay nada que
 * redactar y por eso la fuente puede acompañarlo sin repasar la Ley 1581.
 */
function sumarFormas(destino: Map<string, number>, fuente: string, formas: ReadonlyMap<string, number>): void {
  for (const [forma, n] of formas) {
    const llave = `${fuente}|${forma}`;
    destino.set(llave, (destino.get(llave) ?? 0) + n);
  }
}

async function procesarNit(ctx: ContextoCorrida, nit: string): Promise<ResultadoNit> {
  const acumulador: AcumuladorNit = new Map();
  let itemsIgnorados = 0;
  const formasNumero = new Map<string, number>();

  // SIMIT primero y en serie: es una sola llamada por NIT y su resultado es el que manda en el
  // merge, así que no hay nada que ganar solapándola con las municipales.
  const simit = await llamarSimit(ctx, nit);
  if (simit.items) {
    const { ignorados, formas } = acumularSimit(acumulador, simit.items, candidatosDe(ctx.mapa, 'simit'));
    itemsIgnorados += ignorados;
    sumarFormas(formasNumero, simit.step.fuente, formas);
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
    const { ignorados, formas } = acumularMunicipal(
      acumulador, municipal.items, candidatosDe(ctx.mapa, 'municipal'), municipal.step.fuente,
    );
    itemsIgnorados += ignorados;
    sumarFormas(formasNumero, municipal.step.fuente, formas);
    municipal.step = pasoIlegibleSiProcede(municipal.step, 'municipal', municipal.items.length, ignorados);
  }

  const steps = [simit.step, ...municipales.map((m) => m.step)];
  return {
    steps,
    acumulador,
    itemsIgnorados,
    formasNumero,
    // `ok` no basta (RN-47): un municipio que contestó sin veredicto y sin comparendos no ha dicho
    // que este NIT no deba nada, así que su vacío no puede sumar cobertura. Se le resta a este NIT
    // la elegibilidad entera —y no solo sus filas— porque la ausencia se mide contra el conjunto: un
    // comparendo que hoy no vio SIMIT podría estar en el municipio que no se pronunció.
    coberturaCompleta: simit.step.ok && municipales.every((m) => m.step.ok && m.concluyente),
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
 *   3. La cobertura del CF-10 mira `ok`, así que degradar el paso basta para que este caso deje de
 *      autorizar una inactivación: no hay que acordarse de restarle la cobertura por separado.
 *
 * Matiz que este archivo debe a RN-47 (Bug #11711), porque el punto 3 decía «la regla queda en UN
 * sitio» y ya no es cierto: la cobertura son DOS condiciones —`ok` **y** `concluyente`—. No se
 * unificaron porque los dos casos no son el mismo y no merecen el mismo trato:
 *
 *   · **«No te entiendo»** (esto, RN-22) SÍ es un fallo. La respuesta llegó y no se pudo leer: hay
 *     algo roto —el `field_map` o el contrato del proveedor— y alguien tiene que ir a mirarlo. Paso
 *     `ok: false`, corrida `partial`, `errorCode` en `sync_steps`.
 *   · **«No me pronuncio»** (RN-47) NO lo es. El UTS contesta a veces sin `codigoEstado` y sin
 *     comparendos, y eso es una respuesta legítima de un proveedor que funciona: marcarla como fallo
 *     dejaría a ese municipio caído cada vez que un NIT no tiene comparendos allí. Paso `ok: true`,
 *     corrida `completed`, y lo único que se le quita es la cobertura.
 *
 * Lo que comparten —y es lo que importa— es que ninguno de los dos autoriza a apagar nada.
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
  /**
   * ¿La fuente se pronunció sobre este NIT? (RN-47).
   *
   * Vive aquí y no en el `step` a propósito: es una entrada del cálculo de cobertura, no un dato del
   * histórico. Persistirlo obligaría a una columna en `flito_comparendos_sync_steps` para algo que
   * solo se consulta dentro de la corrida; lo que el operador necesita —el motivo— ya va en
   * `mensaje`. Si algún día hay que filtrar corridas por esto, entonces sí será una columna.
   */
  concluyente: boolean;
}

/**
 * Lo que se le dice al operador cuando el municipio contesta pero no se pronuncia (RN-47).
 *
 * Se persiste en `sync_steps.mensaje`, que se conserva y se sirve, así que describe la FORMA de la
 * respuesta y su CONSECUENCIA, y ni una palabra del proveedor (RN-20). Es además el primer `mensaje`
 * que acompaña a un paso `ok: true`: hasta ahora solo lo llevaban los fallidos, y aquí el municipio
 * no ha fallado — simplemente no ha dicho nada que autorice a apagar comparendos.
 *
 * Por qué se reescribió el texto (HU #11796, enmienda UX del 24 ago 2026, decisión 18), y no es
 * cuestión de tono: el anterior empezaba «El UTS respondió sin veredicto (codigoEstado ausente)…»,
 * o sea NOMBRABA AL PROVEEDOR y CITABA UN CAMPO DE SU ENVELOPE — justo lo que RN-20 prohíbe, en la
 * misma constante cuyo comentario la invoca. Y de paso era lo que lo hacía sonar a avería:
 * «respondió sin veredicto» describe una anomalía del otro extremo, cuando lo que pasó es una
 * consulta normal con cero resultados. El paso ya salía `Ok` (`ok: true`, arriba); lo único que
 * sonaba a caída era este copy.
 *
 * Lo que el texto NO puede decir nunca: que el NIT no debe nada en ese municipio. Es el punto
 * entero — la respuesta no lo confirmó —, así que «sin deudas», «al día» en afirmativo o «sin
 * comparendos en el municipio» quedan prohibidos aquí.
 *
 * El histórico ya persistido conserva el texto viejo y NO se reescribe: la bitácora es lo que se le
 * dijo al operador aquel día. El front lo aliasa al pintar (HU #11797); aquí no hay UPDATE.
 */
const MENSAJE_VACIO_NO_CONCLUYENTE = 'La consulta salió bien y no trajo registros. Eso no confirma '
  + 'que el NIT esté al día, así que este municipio no cuenta como cobertura: no se inactiva nada de '
  + 'este NIT en esta corrida.';

async function llamarSimit(ctx: ContextoCorrida, nit: string): Promise<ResultadoLlamada> {
  const inicio = Date.now();
  try {
    const r = await consultarComparendosSimit(nit, ctx.token ? { token: ctx.token } : {});
    return {
      step: paso(nit, FUENTE_SIMIT, { ok: true, httpStatus: r.httpStatus, itemsLeidos: r.items.length }, inicio),
      items: r.items as Record<string, unknown>[],
      // Verifik no publica un veredicto aparte de la lista: su `data` ES la respuesta a la consulta,
      // y una `multas: []` suya sí significa «no consta ninguna». Que RN-47 sea del UTS y no de aquí
      // no es un olvido — es que la ambigüedad la introduce el otro proveedor, no este.
      concluyente: true,
    };
  } catch (e) {
    return { step: pasoFallido(nit, FUENTE_SIMIT, e, inicio), items: null, concluyente: false };
  }
}

async function llamarMunicipal(ctx: ContextoCorrida, nit: string, codigoFuente: string): Promise<ResultadoLlamada> {
  const inicio = Date.now();
  try {
    const r = await consultarComparendosMunicipales(nit, codigoFuente);
    return {
      // `ok: true` aunque no sea concluyente (RN-47): el municipio contestó y se entendió, así que
      // marcarlo como caído sería mentir sobre el proveedor y dejar la corrida en `partial` para
      // siempre. Lo que cambia es el `mensaje` —para que el operador vea por qué no se apagó nada—
      // y la cobertura, que se decide más arriba con `concluyente`.
      step: paso(nit, codigoFuente, {
        ok: true,
        httpStatus: r.httpStatus,
        itemsLeidos: r.items.length,
        mensaje: r.concluyente ? undefined : MENSAJE_VACIO_NO_CONCLUYENTE,
      }, inicio),
      items: r.items as Record<string, unknown>[],
      concluyente: r.concluyente,
    };
  } catch (e) {
    return { step: pasoFallido(nit, codigoFuente, e, inicio), items: null, concluyente: false };
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
  // HU #11794. Se lee por el MISMO motivo que los dos de la resolución: es el tercer escalón de
  // RN-13. Sin ella, una corrida en la que ninguna fuente publique la notificación resolvería el
  // campo a `null` y BORRARÍA la fecha ya guardada — dejar de recibir un dato no es recibir que está
  // vacío.
  fechaNotificacion: string | null;
  organismo: string | null;
  monto: string | null;
  estadoFuente: string | null;
  // Los dos de la resolución (HU #11712). Se leen para que el tercer escalón de RN-13 los conserve:
  // sin ellos, una corrida en la que el proveedor no mandara la resolución los resolvería a `null` y
  // `tipoDeRegistro` degradaría la fila de multa a comparendo — la regresión por silencio que la
  // regla monótona existe para impedir.
  //
  // `tipo_registro` NO se lee, y es deliberado: se deriva de estos dos, así que leerlo abriría la
  // puerta a que el valor viejo pesara sobre el valor nuevo y las dos columnas se contradijeran.
  numeroResolucion: string | null;
  idResolucion: string | null;
  // `municipio_comparendo` TAMPOCO se lee (HU #11878), por el mismo motivo que `tipo_registro`: se
  // RE-DERIVA entera en cada corrida a partir del municipio consultado y del organismo ya resuelto.
  // Un tercer escalón que conservara el valor viejo congelaría para siempre lo que se dedujo con el
  // catálogo de ayer, y la premisa que hace segura la re-derivación es justo la contraria: el
  // catálogo de municipios solo CRECE —no hay endpoint que borre municipios—, así que volver a
  // deducir solo puede reconocer más de lo que reconoció la vez anterior. `municipio_fuente` sí se
  // lee, y ahí no hay contradicción: ese es un HECHO de una corrida pasada (a quién se le preguntó)
  // y no una deducción.
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
        fechaNotificacion: flitoComparendosRegistros.fechaNotificacion,
        organismo: flitoComparendosRegistros.organismo,
        monto: flitoComparendosRegistros.monto,
        estadoFuente: flitoComparendosRegistros.estadoFuente,
        numeroResolucion: flitoComparendosRegistros.numeroResolucion,
        idResolucion: flitoComparendosRegistros.idResolucion,
      })
        .from(flitoComparendosRegistros)
        .where(inArray(flitoComparendosRegistros.numeroComparendo, lote));
      for (const fila of filas) existentes.set(fila.numeroComparendo, fila as FilaExistente);
    }

    for (const consolidado of consolidados) {
      const existente = existentes.get(consolidado.numero) ?? null;
      const vistoEnSimit = (existente?.vistoEnSimit ?? false) || consolidado.simit !== null;
      const vistoEnMunicipal = (existente?.vistoEnMunicipal ?? false) || consolidado.municipal !== null;
      // El municipio CONSULTADO, en UNA sola expresión (HU #11878). Sale a una const y no se repite
      // inline porque lo usan dos cosas —la columna `municipio_fuente` y la derivación de
      // `municipio_comparendo`, cuyo primer escalón es exactamente este valor—, y dos copias de la
      // misma cadena de `??` es lo único que podría hacer que la columna vieja y la nueva
      // discreparan dentro de la misma fila sin que nada lo avisara.
      //
      // Se conserva lo ya guardado si esta corrida no lo trajo: es la pista de dónde se vio y no un
      // dato que el SIMIT pueda contradecir.
      const municipioFuente = consolidado.municipioFuente ?? existente?.municipioFuente ?? null;
      const campos = resolverCampos(consolidado, existente, {
        municipioFuente, catalogoMunicipios: ctx.catalogoMunicipios,
      });

      const comun = {
        ...campos,
        municipioFuente,
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
