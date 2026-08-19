// Siigo — el trabajador que vacía la cola de emisión (HU #11327, Feature #11242).
//
// Aquí vive TODA la decisión: qué se reintenta, cuándo, cuántas veces y qué se da por perdido. La
// cola (`facturacion.cola.service.ts`) solo escribe lo que este archivo decide, y la emisión
// (`facturacion.emision.service.ts`) solo sabe emitir. Separarlo así es lo que permite probar la
// política de reintentos sin base de datos y sin red.
//
// TRES ORDENES QUE NO SON ARBITRARIOS
//
//   1. **El cortacircuitos se mira ANTES de tomar nada.** Con el circuito abierto, `emitirFactura`
//      no falla «como si Siigo hubiera rechazado»: falla con `CircuitoAbiertoError`, que no es un
//      `SiigoApiError`, así que el emisor no puede afirmar que el POST llegara y —correctamente—
//      deja la factura `en_proceso`. Correctamente, pero el POST no salió nunca: el resultado es una
//      clave reservada ocupando su trámite unos 45 minutos (arrendamiento + barrido) por una
//      petición que no se hizo. Preguntar antes cuesta un `Map.get` y ahorra eso.
//   2. **La reconciliación va primero y va siempre** (AC4). Una huérfana es, por definición, una fila
//      que ya no tiene a nadie esperándola: si el barrido dependiera de que haya trabajo en la cola,
//      el día que la cola se vacía —que es justo cuando todo va mal— dejarían de rescatarse. Va
//      acotada a cinco filas y con su propio presupuesto de tiempo para que un atasco de huérfanas
//      no deje sin turno a lo que sí factura.
//   3. **El freno se mide una vez por ciclo; el cortacircuitos, antes de cada fila.** El primero es
//      una consulta agregada sobre la bitácora y preguntarlo quince veces por ciclo sería quince
//      agregaciones para obtener el mismo número. El segundo es un `Map` en memoria y puede haberse
//      abierto con la fila anterior.

import os from 'os';
import type { SiigoColaDesenlace } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import { circuitoAbierto } from '../../services/circuitBreaker.js';
import { esReintentable } from './siigo.errors.js';
import { backoffMs } from './siigo.resiliencia.js';
import { detalleTecnico } from './siigo.redaccion.js';
import {
  claveCortacircuitosEmision, emitirFactura, SiigoEmisionError, type ResultadoEmision,
} from './facturacion.emision.service.js';
import { reconciliarHuerfanas } from './facturacion.reconciliacion.service.js';
import { exigirIntegracionNoFrenada, SiigoIntegracionFrenadaError } from './siigo.freno.service.js';
import { conceptosDelLote, emisionDelLote, tramitesDelLote } from './facturacion.lote.repo.js';
import {
  liberar, registrarDesenlace, tomarLote, type FilaTomada, type InstruccionDesenlace,
} from './facturacion.cola.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.cola.trabajador');
const HOST_ID = `${os.hostname()}-${process.pid}`;

/**
 * Base y techo del retroceso PERSISTIDO. Nada que ver con el de `ejecutarConResiliencia`.
 *
 * Aquel espera dentro de la misma llamada, reteniendo la petición: por eso su techo son 30 s, más
 * allá de los cuales esperar no aporta y solo ocupa. Este agenda una fila en una tabla, que mientras
 * espera no retiene absolutamente nada. Volver cada 30 s contra un Siigo caído durante una hora son
 * 120 peticiones inútiles que además engordan la proporción de errores que mide el freno; con media
 * hora de techo son cuatro.
 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_TOPE_MS = 30 * 60_000;

/** Cuántas huérfanas mira un ciclo. Pequeño a propósito: son la excepción, emitir es la norma. */
export const LOTE_RECONCILIACION = 5;

/** Qué parte del plazo del ciclo se le presupuesta a la reconciliación. */
const FRACCION_RECONCILIACION = 0.3;

/**
 * Rechazos por límite de tasa seguidos que hacen que el ciclo se rinda.
 *
 * Si Siigo dice que se superaron las 100 peticiones por minuto, las catorce filas siguientes van a
 * oír exactamente lo mismo: insistir solo gasta cuota para recibir el mismo rechazo y sube la
 * proporción de errores que mide el freno. Entre uno y otro se espera —eso es el retroceso del
 * AC3— y al tercero se deja el resto para el ciclo siguiente, con sus citas ya agendadas.
 */
const MAX_RECHAZOS_POR_LIMITE = 3;
const PAUSA_LIMITE_BASE_MS = 2_000;
const PAUSA_LIMITE_TOPE_MS = 15_000;

/** Código con el que Siigo dice que se pasó la cuota de peticiones por minuto. */
const CODIGO_LIMITE = 'requests_limit';

const dormirReal = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export interface OpcionesCiclo {
  ambiente: SiigoAmbiente;
  /** Hasta cuándo puede trabajar el ciclo. Es lo que impide que sobreviva a su propio cerrojo. */
  plazoMs: number;
  /** Cuántas filas mira como mucho. */
  lote: number;
  /** Inyectables: sin ellos no se puede probar el plazo, el retroceso ni el apagado (AC7). */
  ahora?: () => Date;
  dormir?: (ms: number) => Promise<void>;
  debeDetenerse?: () => boolean;
  /** Quién toma las filas. Por defecto, host y pid. */
  tomadoPor?: string;
  arrendamientoMin?: number;
}

export interface ResumenCiclo {
  reconciliadas: number;
  tomadas: number;
  enviadas: number;
  /** Filas que vuelven a la cola con cita nueva. */
  reintentables: number;
  definitivas: number;
  /** Filas tomadas que se devolvieron sin mirar (apagado, plazo, cortacircuitos). */
  liberadas: number;
  frenada: boolean;
  circuitoAbierto: boolean;
  detenido: boolean;
  agotoPlazo: boolean;
}

function resumenVacio(): ResumenCiclo {
  return {
    reconciliadas: 0, tomadas: 0, enviadas: 0, reintentables: 0, definitivas: 0, liberadas: 0,
    frenada: false, circuitoAbierto: false, detenido: false, agotoPlazo: false,
  };
}

// ── La política de reintentos, sin base de datos de por medio ───────────────

/**
 * Lo que la cola necesita saber de un intento.
 *
 * Es el `ResultadoEmision` con el desenlace ensanchado: la cola admite un valor más —`error_interno`,
 * para cuando la emisión ni siquiera llegó a devolver resultado— y así un fallo nuestro no tiene que
 * disfrazarse de huérfana para caber en el tipo. Todo `ResultadoEmision` encaja aquí tal cual.
 */
export type ResultadoParaCola = Omit<ResultadoEmision, 'desenlace'> & { desenlace: SiigoColaDesenlace };

/** Lo que hay que escribir en la fila, ya decidido. Sin `colaId` ni arrendamiento: eso es del ciclo. */
export type PlanDesenlace =
  | { estado: 'enviado'; facturaId: string; desenlace: SiigoColaDesenlace; intentos: number; esperas: number }
  | {
    estado: 'error'; proximoIntentoAt: Date; desenlace: SiigoColaDesenlace;
    intentos: number; esperas: number; errorCode: string | null; errorDetalle: string | null;
    /**
     * La factura del intento, cuando la hubo. Se conserva aunque el trabajo vuelva a la cola: una
     * fila que salió `huerfana` APUNTA a una factura real que quedó `en_proceso`, y es justo el caso
     * en que alguien va a querer ir de la cola al documento para entender qué pasó. Perderla dejaba
     * roto el enlace que `idx_siigo_cola_factura` existe para servir.
     */
    facturaId: string | null;
  }
  | {
    estado: 'fallido_definitivo'; desenlace: SiigoColaDesenlace; intentos: number; esperas: number;
    errorCode: string | null; errorDetalle: string | null; facturaId: string | null;
  };

/**
 * AC2 y AC5 — qué le pasa a la fila según lo que devolvió la emisión.
 *
 * Función pura: recibe la fila y el resultado, devuelve el plan. Es donde de verdad está la historia
 * y por eso no toca nada — se puede recorrer entera con una tabla de casos.
 *
 * **Los dos contadores no son intercambiables.** Un desenlace de red —Siigo contestó y rechazó—
 * gasta `intentos`, porque cada uno es información nueva sobre por qué esto no va a salir. Un ciclo
 * sin desenlace —la clave estaba tomada, el POST no volvió, la fila quedó huérfana— gasta `esperas`.
 * Con un solo contador, un Siigo lento agota los cinco intentos sin que nadie haya rechazado nada y
 * la fila acaba dada por perdida **con el documento posiblemente vivo ante la DIAN**, que es la única
 * afirmación que este módulo no puede permitirse hacer sin comprobarla.
 *
 * **Ningún camino deja la fila sin salida ni la reintenta en bucle**: o termina, o incrementa un
 * contador con techo y agenda una cita más lejana que la anterior.
 */
export function planificarDesenlace(
  fila: FilaTomada, r: ResultadoParaCola, ahora: Date,
): PlanDesenlace {
  const base = { intentos: fila.intentos, esperas: fila.esperas };

  if (r.desenlace === 'emitida' || r.desenlace === 'ya_emitida') {
    // I3 — la cola converge sola: `ya_emitida` significa que la clave ya estaba emitida y que
    // `emitirFactura` lo resolvió SIN tocar la red. El trabajo está hecho, aunque no lo hiciéramos
    // nosotros. Tratarlo como fallo dejaría en la cola una fila eterna con su factura ya emitida.
    if (r.facturaId) {
      return { ...base, estado: 'enviado', facturaId: r.facturaId, desenlace: r.desenlace };
    }
    // Emitida sin fila local: la reconciliación tiene que recuperarla por las observaciones, y esta
    // fila no puede quedarse pidiendo un trabajo que ya se hizo.
    return {
      ...base,
      estado: 'fallido_definitivo',
      desenlace: r.desenlace,
      facturaId: null,
      errorCode: 'sin_factura_local',
      errorDetalle: 'La emisión terminó sin dejar fila de factura en FLITO. Hay que comprobarlo en Siigo.',
    };
  }

  if (r.desenlace === 'no_elegible') {
    // Las guardas la rechazaron ANTES de tocar la red, así que no hay nada que reintentar: el mismo
    // trámite volvería a ser rechazado por el mismo motivo hasta agotar el techo, gastando ciclos
    // para llegar al sitio al que se puede llegar ya.
    return {
      ...base,
      estado: 'fallido_definitivo',
      desenlace: 'no_elegible',
      facturaId: r.facturaId,
      // El código propio manda sobre el genérico: un fallo de configuración y un trámite que no
      // cumple las guardas se arreglan en sitios distintos, y quien mire la bandeja necesita saber
      // en cuál. Solo cuando no hay código se etiqueta como «no elegible» a secas.
      errorCode: r.errorCode ?? 'no_elegible',
      errorDetalle: r.errorDetalle
        ?? (r.motivos.join(' ') || 'El trámite no cumple las condiciones para facturarse.'),
    };
  }

  if (r.desenlace === 'fallida') {
    // Siigo CONTESTÓ y rechazó: es un desenlace, y gasta intento.
    const intentos = fila.intentos + 1;
    const definitivo = { ...base, intentos, desenlace: 'fallida' as const, facturaId: r.facturaId };
    // AC5 — un error no reintentable no agota intentos: reintentar un payload que Siigo ya evaluó y
    // rechazó por un dato nuestro solo consigue el mismo rechazo cuatro veces más.
    if (!esReintentable(r.errorCode, 400)) {
      return {
        ...definitivo, estado: 'fallido_definitivo',
        errorCode: r.errorCode, errorDetalle: r.errorDetalle,
      };
    }
    if (intentos >= fila.maxIntentos) {
      return {
        ...definitivo, estado: 'fallido_definitivo',
        errorCode: r.errorCode, errorDetalle: r.errorDetalle,
      };
    }
    return {
      ...base,
      intentos,
      estado: 'error',
      desenlace: 'fallida',
      proximoIntentoAt: cita(ahora, intentos),
      errorCode: r.errorCode,
      errorDetalle: r.errorDetalle,
      facturaId: r.facturaId,
    };
  }

  // `en_curso`, `huerfana` y cualquier fallo nuestro: NO hubo desenlace. Gasta espera.
  const esperas = fila.esperas + 1;
  const errorCode = r.errorCode ?? (r.desenlace === 'en_curso' ? 'emision_en_curso' : 'sin_desenlace');
  const errorDetalle = r.errorDetalle
    ?? (r.desenlace === 'en_curso'
      ? 'Otro proceso tenía reservada la clave de esta factura cuando le tocó el turno.'
      : 'La emisión no obtuvo respuesta de Siigo. La reconciliación averiguará si el documento existe.');

  if (esperas >= fila.maxEsperas) {
    return {
      ...base,
      esperas,
      estado: 'fallido_definitivo',
      desenlace: r.desenlace,
      facturaId: r.facturaId,
      errorCode,
      errorDetalle,
    };
  }
  return {
    ...base,
    esperas,
    estado: 'error',
    desenlace: r.desenlace,
    proximoIntentoAt: cita(ahora, esperas),
    errorCode,
    errorDetalle,
    // Una `huerfana` SÍ tiene factura: quedó reservada y `en_proceso`. Conservarla es lo que permite
    // ir de la fila de cola al documento que hay que mirar, que en ese desenlace es toda la pregunta.
    facturaId: r.facturaId,
  };
}

/** La próxima cita: retroceso exponencial con techo propio de la cola. */
function cita(ahora: Date, n: number): Date {
  return new Date(ahora.getTime() + backoffMs(n, BACKOFF_BASE_MS, BACKOFF_TOPE_MS));
}

/**
 * El fallo que no viene de Siigo sino de nosotros, traducido a un resultado de emisión.
 *
 * Se distingue por clase y no por mensaje: `SiigoEmisionError` significa que faltan datos o
 * configuración —el trámite no existe, no hay comprobante parametrizado, el mapeo falta— y eso no se
 * arregla reintentando, así que se da por perdido sin gastar los cinco intentos. Cualquier otra
 * excepción (la base de datos, un fallo nuestro) sí puede ser pasajera y solo gasta una espera.
 */
function comoResultado(e: unknown): ResultadoParaCola {
  const esDeDatos = e instanceof SiigoEmisionError;
  return {
    // `error_interno` y no `huerfana`: una huérfana es una factura que puede existir en Siigo, y
    // decir eso de un fallo que ocurrió antes de salir a la red mandaría al barrido a buscar un
    // documento que nadie llegó a pedir.
    desenlace: esDeDatos ? 'no_elegible' : 'error_interno',
    facturaId: null,
    siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
    requiereRevision: false, revisionMotivo: null,
    errorCode: esDeDatos ? `emision_${e.codigo}` : 'error_interno',
    errorDetalle: detalleTecnico(e),
    motivos: esDeDatos ? [e.message] : [],
  };
}

// ── El ciclo ────────────────────────────────────────────────────────────────

/**
 * Un ciclo completo: reconciliar, comprobar el freno y vaciar lo que quepa de la cola.
 *
 * Devuelve siempre un resumen, incluso cuando no hace nada: un ciclo que no pudo trabajar y uno que
 * no tenía trabajo son cosas distintas y el cron necesita poder distinguirlas para no registrar como
 * normal una integración parada.
 */
export async function procesarCicloEmision(o: OpcionesCiclo): Promise<ResumenCiclo> {
  const ahora = o.ahora ?? (() => new Date());
  const dormir = o.dormir ?? dormirReal;
  const debeDetenerse = o.debeDetenerse ?? (() => false);
  const tomadoPor = o.tomadoPor ?? HOST_ID;
  const circuito = claveCortacircuitosEmision(o.ambiente);
  const resumen = resumenVacio();
  const finDelCiclo = ahora().getTime() + o.plazoMs;

  // AC3 — con el circuito abierto no se hace NINGUNA petición, y eso incluye las del barrido: sus
  // consultas morirían igual en el cortacircuitos, pero cada una dejaría un `error_tecnico` en la
  // bitácora que alimenta el freno. Un servicio caído acabaría frenando la integración con errores
  // que nunca salieron de este proceso.
  if (circuitoAbierto(circuito)) {
    resumen.circuitoAbierto = true;
    return resumen;
  }

  resumen.reconciliadas = await reconciliar(o, ahora, finDelCiclo);

  // AC3 — el freno, una vez por ciclo. Si frena, no se toca la cola: las filas conservan su cita y
  // vuelven cuando la integración se reactive.
  if (!await integracionSana(o.ambiente, resumen)) return resumen;

  const filas = await tomarLote({
    ambiente: o.ambiente,
    limite: o.lote,
    tomadoPor,
    ahora: ahora(),
    arrendamientoMin: o.arrendamientoMin,
  });
  resumen.tomadas = filas.length;

  const pendientes = [...filas];
  let rechazosPorLimite = 0;

  // El bucle va en `try` y la liberación en `finally`, y no es adorno: `procesarFila` protege la
  // emisión con su propio `try`, pero la ESCRITURA del desenlace queda fuera de esa red. Si la base
  // falla justo ahí —un `statement timeout`, una caída— la excepción escapaba del ciclo, la
  // liberación no llegaba a ejecutarse y las filas que ni se miraron se quedaban arrendadas los
  // veinte minutos enteros. No corrompe nada y se recupera solo al vencer el arrendamiento; pero
  // veinte minutos de trabajo parado por una fila que reventó son veinte minutos regalados.
  try {
    while (pendientes.length > 0) {
      // Las tres razones para parar se miran ANTES de sacar la fila de la lista, para que lo que no
      // se mire se libere entero y vuelva a estar disponible ya, no dentro de veinte minutos.
      if (debeDetenerse()) { resumen.detenido = true; break; }
      if (ahora().getTime() >= finDelCiclo) { resumen.agotoPlazo = true; break; }
      if (circuitoAbierto(circuito)) { resumen.circuitoAbierto = true; break; }

      const fila = pendientes.shift()!;
      const plan = await procesarFila(fila, o, tomadoPor, ahora);
      contabilizar(resumen, plan);

      // AC3 — retroceso ante el rechazo por límite. La fila ya tiene su cita persistida; esto es el
      // retroceso del CICLO, para no preguntarle catorce veces seguidas a un Siigo que acaba de
      // decir que se pasó la cuota.
      if (plan && esRechazoPorLimite(plan)) {
        rechazosPorLimite += 1;
        if (rechazosPorLimite >= MAX_RECHAZOS_POR_LIMITE) break;
        await dormir(backoffMs(rechazosPorLimite, PAUSA_LIMITE_BASE_MS, PAUSA_LIMITE_TOPE_MS));
      }
    }
  } finally {
    // Se libera lo que no se llegó a mirar incluso si el ciclo revienta. `liberar` condiciona por
    // `tomado_por`, así que soltar de más es imposible: solo se suelta lo que sigue siendo nuestro.
    for (const p of pendientes) {
      if (await liberar({ colaId: p.id, tomadoPor, ahora: ahora() })) resumen.liberadas += 1;
    }
  }
  return resumen;
}

function esRechazoPorLimite(plan: PlanDesenlace): boolean {
  return plan.estado !== 'enviado' && plan.errorCode === CODIGO_LIMITE;
}

function contabilizar(resumen: ResumenCiclo, plan: PlanDesenlace | null): void {
  if (!plan) return;
  if (plan.estado === 'enviado') resumen.enviadas += 1;
  else if (plan.estado === 'error') resumen.reintentables += 1;
  else resumen.definitivas += 1;
}

/**
 * AC4 — el barrido de huérfanas, con su propio presupuesto de tiempo.
 *
 * El presupuesto se comprueba DESPUÉS y no interrumpe a media fila: cada reconciliación se resuelve
 * entera o no se resuelve, y cortarla por la mitad no dejaría nada a medias en la base pero sí
 * escribiría un resumen que no describe lo que pasó. Lo que de verdad acota el gasto es el límite de
 * cinco filas; el presupuesto es la señal de que ese límite se quedó corto para este despliegue.
 */
async function reconciliar(
  o: OpcionesCiclo, ahora: () => Date, finDelCiclo: number,
): Promise<number> {
  const inicio = ahora().getTime();
  const presupuesto = Math.floor(o.plazoMs * FRACCION_RECONCILIACION);
  try {
    const r = await reconciliarHuerfanas({
      ambiente: o.ambiente, limite: LOTE_RECONCILIACION, ahora, arrendamientoMin: o.arrendamientoMin,
    });
    const gastado = ahora().getTime() - inicio;
    if (gastado > presupuesto) {
      log.warn(
        { gastadoMs: gastado, presupuestoMs: presupuesto, restanteMs: finDelCiclo - ahora().getTime() },
        'el barrido de huérfanas consumió más que su presupuesto: la emisión de este ciclo va con menos tiempo',
      );
    }
    return r.length;
  } catch (e) {
    // Un barrido que falla no puede impedir que se facture: son dos trabajos distintos que comparten
    // ciclo por conveniencia, no por dependencia.
    log.error({ err: detalleTecnico(e) }, 'el barrido de huérfanas falló; el ciclo sigue con la cola');
    return 0;
  }
}

/**
 * ¿Se puede emitir? Mide el freno una vez y **falla cerrado**.
 *
 * Si la medición no se puede hacer —la bitácora de la que se deriva está en la misma base que todo
 * lo demás—, no se emite. Emitir sin saber si la integración está sana es justo lo que el freno
 * existe para impedir, y el coste de equivocarse por este lado son dos minutos de espera; por el
 * otro, que Siigo bloquee el usuario API de la empresa entera.
 */
async function integracionSana(ambiente: SiigoAmbiente, resumen: ResumenCiclo): Promise<boolean> {
  try {
    await exigirIntegracionNoFrenada({ ambiente });
    return true;
  } catch (e) {
    resumen.frenada = true;
    if (e instanceof SiigoIntegracionFrenadaError) {
      log.warn({ ambiente, proporcion: e.estado.proporcion }, 'la integración está frenada: este ciclo no emite');
    } else {
      log.error({ err: detalleTecnico(e) }, 'no se pudo medir el freno: este ciclo no emite');
    }
    return false;
  }
}

/**
 * Una fila: emitir y escribir el desenlace. Devuelve el plan, o `null` si la fila ya no era nuestra.
 *
 * Ninguna excepción sale de aquí. Una fila que revienta no puede tumbar el ciclo: las otras catorce
 * no tienen la culpa, y un ciclo que muere a media lista deja el resto arrendado hasta que venza.
 */
async function procesarFila(
  fila: FilaTomada, o: OpcionesCiclo, tomadoPor: string, ahora: () => Date,
): Promise<PlanDesenlace | null> {
  let resultado: ResultadoParaCola;
  try {
    const tramiteIds = await tramitesDelLote(fila.loteId);
    // A1 — qué se factura sale del LOTE, no de la liquidación. El envío solo encoló; entre aquel
    // clic y este ciclo pudo cambiar cualquier cosa, y deducir la lista otra vez aquí produciría una
    // factura distinta de la que se pidió. Vacío = lote anterior a A1: todos los aplicables.
    const conceptos = await conceptosDelLote(fila.loteId);
    // A2 — y con qué configuración. Todo nulo = lote anterior a A2: configuración global.
    const emision = await emisionDelLote(fila.loteId);
    if (tramiteIds.length === 0) {
      // Un lote sin contenido no se puede facturar y no se va a arreglar solo. Es dato, no red.
      throw new SiigoEmisionError(
        'sin_tramites',
        `El lote ${fila.loteId} no tiene trámites registrados: no hay nada que facturar.`,
      );
    }
    resultado = await emitirFactura(tramiteIds, {
      ambiente: o.ambiente,
      conceptos,
      emision,
      // Sin usuario: quien emite es el trabajador. Quién lo pidió está en `encolado_por` de la fila
      // de cola, que es donde esa pregunta tiene respuesta.
      usuarioId: null,
      ahora,
      arrendamientoMin: o.arrendamientoMin,
    });
  } catch (e) {
    resultado = comoResultado(e);
  }

  const plan = planificarDesenlace(fila, resultado, ahora());
  const escrita = await registrarDesenlace(instruccion(plan, fila.id, tomadoPor, ahora()));
  if (!escrita) {
    // Perdimos el arrendamiento mientras trabajábamos y otra instancia tomó la fila. No se insiste:
    // escribir igualmente pondría el desenlace de nuestro intento encima del suyo.
    log.warn({ colaId: fila.id, estado: plan.estado },
      'la fila de cola dejó de ser nuestra antes de escribir el desenlace: no se pisa');
    return null;
  }
  return plan;
}

/** El plan más el contexto del ciclo. El `switch` es lo que mantiene la unión discriminada intacta. */
function instruccion(
  plan: PlanDesenlace, colaId: string, tomadoPor: string, ahora: Date,
): InstruccionDesenlace {
  const comun = {
    colaId, tomadoPor, ahora, desenlace: plan.desenlace, intentos: plan.intentos, esperas: plan.esperas,
  };
  switch (plan.estado) {
    case 'enviado':
      return { ...comun, estado: 'enviado', facturaId: plan.facturaId };
    case 'error':
      return {
        ...comun,
        estado: 'error',
        proximoIntentoAt: plan.proximoIntentoAt,
        errorCode: plan.errorCode,
        errorDetalle: plan.errorDetalle,
        facturaId: plan.facturaId,
      };
    default:
      return {
        ...comun,
        estado: 'fallido_definitivo',
        facturaId: plan.facturaId,
        errorCode: plan.errorCode,
        errorDetalle: plan.errorDetalle,
      };
  }
}
