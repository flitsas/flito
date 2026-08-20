// FLITO — Comparendos · Sincronización: el seguimiento de la corrida (HU #11635, AC1..AC4).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// EL PROBLEMA QUE ESTE ARCHIVO RESUELVE
//
// `POST /sync` es SÍNCRONO (ADR-0001 §7): no hay 202 ni cola, la respuesta llega cuando la corrida
// termina. Una corrida real tarda minutos y el proxy corta a los ~120 s, así que el caso normal de
// un catálogo grande es que **el cliente se quede sin respuesta con la corrida viva en el servidor**.
// Ese corte no es un fallo, y pintarlo de rojo sería mentir dos veces: decir que falló algo que
// probablemente esté saliendo bien, y sugerir un reintento que —de aceptarlo el 409— duplicaría el
// trabajo o —de no aceptarlo— confundiría todavía más.
//
// De ahí las ocho fases. No son ceremonia: cada una responde a una pregunta distinta sobre lo que
// se sabe de la corrida.
//
//   hidratando   — todavía no sé si hay algo corriendo (AC4).
//   reposo       — no hay corrida; el formulario manda.
//   enviando     — mi POST está vivo; puede acabar en resultado, en corte o en error.
//   localizando  — hubo corte o 409: sé que puede haber una corrida, pero NO sé cuál.
//   siguiendo    — sé cuál es y está `running`; la sondeo hasta que deje de estarlo.
//   resultado    — terminal y confirmado, con sus `steps[]`.
//   error        — el disparo no ocurrió y el servidor dijo por qué (AC3).
//   sin_confirmar— la corrida existe y no pude confirmar cómo acabó. **No es un error.**
//
// `sin_confirmar` es fase propia y no una variante de `error`, y esa es la decisión de diseño más
// importante del archivo: cuando se agota el tope, o se pierde el contacto, o el detalle responde
// 404, lo único cierto es que **no sabemos**. La corrida puede haber terminado perfectamente. Un
// rojo ahí afirma un fracaso que nadie comprobó, y lo caro no es el color: es que quien lo lee
// vuelve a lanzar la sincronización «porque falló».
//
// ── Cadencia escalonada: 2,5 s el primer minuto · 5 s hasta el minuto 5 · 10 s hasta el tope ────
//
// La spec de UX fija 2,5 s fijos. **Esto se desvía a propósito** y el motivo hay que dejarlo
// escrito, porque a primera vista parece un descuido:
//
//   · `apiLimiter` cuenta 500 peticiones por 15 min **por IP**, y la IP es compartida detrás del
//     NAT de la oficina. Un sondeo cada 2,5 s durante los 10 min de tope son 240 peticiones de UNA
//     pestaña: la mitad de la cuota de todo el edificio, mientras el resto del equipo usa la app.
//   · Cada sondeo de `/sync/runs` escribe una fila en `pii_access_log` (el `scope_nits` de las
//     corridas es PII, HU #11511). 240 filas por corrida convierten la bitácora de accesos —que
//     existe para poder auditar quién miró qué— en un log de polling donde el acceso humano no se
//     encuentra.
//
// Escalonando: ~24 sondeos el primer minuto, ~48 hasta el quinto, ~30 hasta el décimo ≈ 102 en el
// peor caso, menos de la mitad. Y se conservan los 2,5 s **donde hay alguien mirando la barra**:
// pasado el primer minuto nadie está pendiente de que el número cambie al segundo.
//
// ── Una cadena de `setTimeout`, NUNCA un `setInterval` ──────────────────────────────────────────
//
// El siguiente sondeo se programa cuando VUELVE la respuesta del anterior. Con `setInterval` y un
// `GET` lento las peticiones se apilan —y cada una escribe su fila de auditoría—, que es la forma
// exacta de convertir un servidor lento en un servidor caído.
//
// ── Identificar la corrida cuando el POST no devolvió nada ──────────────────────────────────────
//
// Ni el 409 ni el corte traen `runId`. Se ancla con dos cosas y **ninguna es un reloj**: comparar el
// `iniciadoEn` del servidor con el `Date.now()` del portátil se rompe en silencio con cualquier
// desfase de husos o de sincronización horaria, y se rompe hacia el lado malo (engancharse a la
// corrida equivocada y contar su resultado como propio).
//
//   1. `idsConocidos` — los `runId` ya vistos, congelados justo ANTES del POST. Lo que aparece
//      después y no está ahí es nuevo, sin preguntarle la hora a nadie.
//   2. `iniciadoPor === user.id` — `iniciadoPor` es el `sub` del token, el mismo entero que
//      `useAuth().user.id`. La comparación vive en `esMia()` y **exige que los dos lados existan**:
//      los dos pueden ser `null` y `null !== null` daría «propia» para una corrida cuyo autor no
//      conocemos.
//
// ── Lo que NO se hace ───────────────────────────────────────────────────────────────────────────
//
//   · **No se persiste nada.** Ni `sessionStorage` ni `localStorage`: lo que habría que guardar
//     incluye el alcance, y el alcance son NIT (AGENTS.md §14). Al desmontar, la corrida sigue en el
//     servidor y al volver a entrar `hidratando` la reengancha — que es justo lo que pide el AC4.
//   · **No se dice «cancelada» ni «detenida» en ningún copy.** Abortar el POST no cancela nada al
//     otro lado; el servidor sigue consultando proveedores. Escribir «cancelada» sería la afirmación
//     falsa más fácil de colar en esta pantalla.
//   · **No se inventa una llamada para ponerle nombre a quien inició una corrida ajena.** El
//     contrato deja un id a propósito (`iniciadoPor: number | null`) y el módulo no tiene directorio.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComparendosSyncEstado, ComparendosSyncResultado, ComparendosSyncRun } from '@operaciones/shared-types';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { RUTA_COMPARENDOS } from './bloqueConfigComparendos';
import { errorDeSync, esCorteDeTiempo, esSyncEnCurso, type ErrorSync } from './erroresSync';

const RUTA_SYNC = `${RUTA_COMPARENDOS}/sync`;
const RUTA_RUNS = `${RUTA_SYNC}/runs`;

/**
 * Tope del POST, por debajo del corte del proxy (~120 s) y del techo de `api.ts` (115 s).
 *
 * Vive AQUÍ y no en `api.ts` a propósito: el transporte no conoce las rutas de este módulo ni
 * cuánto tarda una corrida. Lo que sabe `api.ts` es cuál es el máximo tolerable; cuánto se pide,
 * lo decide quien conoce la ruta.
 */
const TIMEOUT_POST_MS = 110_000;

/** Cuántas corridas se piden en cada sondeo. La `running` es siempre la más reciente (CF-06). */
const LIMITE_LISTA = 5;

/** Tope de seguimiento en la UI. Pasado esto no se afirma nada: se pasa a `sin_confirmar`. */
const TOPE_SEGUIMIENTO_MS = 10 * 60_000;

/** Fallos seguidos del sondeo: a partir del tercero se avisa, al octavo se deja de afirmar. */
const FALLOS_AVISO = 3;
const FALLOS_RENDICION = 8;

/** El 429 del limitador no es un fallo del servidor: se espera más y no cuenta para la rendición. */
const ESPERA_429_MS = 15_000;

/** Localizar una corrida recién nacida: 4 intentos ≈ 10 s antes de admitir que no se sabe. */
const INTENTOS_LOCALIZAR = 4;
const ESPERA_LOCALIZAR_MS = 2_500;

export type FaseSync =
  | 'hidratando' | 'reposo' | 'enviando' | 'localizando'
  | 'siguiendo' | 'resultado' | 'error' | 'sin_confirmar';

/** Cadencia del sondeo según lo que lleve corriendo el seguimiento. Ver la cabecera. */
function cadencia(transcurridoMs: number): number {
  if (transcurridoMs < 60_000) return 2_500;
  if (transcurridoMs < 5 * 60_000) return 5_000;
  return 10_000;
}

/**
 * ¿Esta corrida la lancé YO?
 *
 * Un solo predicado para las tres preguntas del archivo, y con la comparación escrita en positivo a
 * propósito: `run.iniciadoPor !== c.userId` parece lo mismo y no lo es, porque **`null !== null` es
 * `false`** — una corrida sin iniciador conocido pasaría por propia sin que nadie lo decidiera. Y
 * `iniciadoPor: number | null` es contrato explícito (una corrida disparada por un proceso, o cuyo
 * autor se borró), no un caso imaginario; el mismo hueco se abre mientras `useAuth().user` todavía
 * no ha cargado y `userId` es `null`.
 *
 * Con esto, «no sé de quién es» cae del lado de AJENA, que es la dirección segura: como mucho se
 * etiqueta de más una corrida propia —se pinta una frase de contexto de sobra—, en vez de
 * atribuirle a alguien una sincronización que no lanzó y anunciarle como suyo un desenlace que no
 * lo es.
 */
function esMia(run: ComparendosSyncRun, userId: number | null): boolean {
  return run.iniciadoPor !== null && userId !== null && run.iniciadoPor === userId;
}

/**
 * Lo que se ANUNCIA, que no es lo mismo que lo que se pinta.
 *
 * Dos decisiones sobre esta tabla:
 *
 *   · **El 409 y el corte de tiempo anuncian LO MISMO** (`seguimiento`). Para quien escucha, los dos
 *     significan exactamente lo mismo —«no tengo respuesta todavía, pero sigo la corrida»— y la
 *     causa técnica no le sirve de nada. Que la corrida sea ajena se dice en la tarjeta, con texto
 *     visible: es contexto, no un cambio de situación.
 *   · **`enCurso` es el anuncio de entrar y encontrarse trabajo** (AC4) y también el del disparo
 *     recién lanzado: en los dos casos hay una sincronización corriendo y no hay nada más que decir.
 */
const ANUNCIO = {
  enCurso: 'Sincronización en curso.',
  seguimiento: 'La respuesta tardó; seguimos el progreso de la corrida.',
  yaTermino: 'La sincronización que estaba en curso ya terminó. Puedes lanzar la tuya.',
  fallo: 'No se pudo iniciar la sincronización.',
  sinConfirmar: 'La corrida sigue en el servidor. Revisa el historial en unos minutos.',
} as const;

/** El copy terminal es el de la spec de UX, palabra por palabra. */
const ANUNCIO_TERMINAL: Record<ComparendosSyncEstado, string> = {
  running: 'La sincronización sigue en curso.',
  completed: 'Sincronización completada.',
  partial: 'Sincronización parcial: revisa las fuentes con error.',
  failed: 'La sincronización falló. Revisa el detalle de la corrida.',
};

/**
 * Que la corrida fuera de otra sesión se dice al ANUNCIAR EL DESENLACE, no solo al pintarlo: quien
 * usa lector de pantalla oiría «Sincronización completada» y creería que terminó la suya. El texto
 * propio se conserva ENTERO detrás, para que el desenlace se lea igual en los dos casos.
 */
function anuncioTerminal(estado: ComparendosSyncEstado, ajena: boolean): string {
  // Respaldo por el valor crudo, igual que `etiquetaOrigen` en `formato.ts`: el `estado` llega por
  // la red y un backend un paso por delante mandaría uno que este mapa todavía no tiene.
  const propio = (ANUNCIO_TERMINAL as Record<string, string | undefined>)[estado]
    ?? 'La sincronización terminó. Revisa el detalle de la corrida.';
  return ajena ? `La sincronización iniciada desde otra sesión terminó. ${propio}` : propio;
}

/** Lo que la consola pinta. Todo lo demás (timers, contadores, ids vistos) vive en `Control`. */
interface Vista {
  fase: FaseSync;
  /** La corrida `running` que se sigue. `null` fuera de `siguiendo`. */
  corrida: ComparendosSyncRun | null;
  resultado: ComparendosSyncResultado | null;
  error: ErrorSync | null;
  /** La corrida en curso (o su resultado) la inició otra sesión: no es «lo mío». */
  ajena: boolean;
  /** Tres sondeos seguidos sin respuesta. No es un fallo todavía; es una advertencia honesta. */
  contactoPerdido: boolean;
  /** Aviso que NO es error (hoy solo: el 409 cuya corrida ya había terminado). */
  aviso: string | null;
  /** Lo que dice la región `aria-live`. Cambia una vez por transición, nunca en cada sondeo. */
  anuncio: string;
  /** Alcance PEDIDO: lista de NIT, o `null` = todos los activos. */
  alcance: string[] | null;
}

const VISTA_INICIAL: Vista = {
  fase: 'hidratando', corrida: null, resultado: null, error: null,
  ajena: false, contactoPerdido: false, aviso: null, anuncio: '', alcance: null,
};

export interface SyncEnVivo extends Vista {
  /** `null` = todos los NIT activos (cuerpo sin `nits`, AC1). */
  lanzar: (nits: string[] | null) => void;
  /** Vuelve al formulario desde un desenlace (resultado, error o corrida sin confirmar). */
  volverAlFormulario: () => void;
  /** Reengancha el seguimiento desde `sin_confirmar`, con el reloj a cero. */
  volverAConsultar: () => void;
}

/** Estado de control: nada de esto se pinta, y por eso nada de esto vive en `useState`. */
interface Control {
  vigente: boolean;
  timer: number | null;
  /** Hay un sondeo esperando a que la pestaña vuelva a estar visible. */
  pendiente: boolean;
  /** Cuándo empezó ESTE seguimiento (manda la cadencia). */
  inicio: number;
  /** Instante del tope de 10 minutos. Sigue corriendo con la pestaña oculta: es tiempo real. */
  limite: number;
  fallos: number;
  intentosLocalizar: number;
  /** Por qué se está localizando: el corte del cliente o el 409. Se busca distinto en cada caso. */
  motivo: 'corte' | 'en_curso' | null;
  runId: string | null;
  /** Todos los `runId` que esta pestaña ha visto alguna vez. */
  vistos: Set<string>;
  /** Copia congelada de `vistos` justo antes del POST: lo nuevo es lo que no está aquí. */
  idsConocidos: Set<string>;
  userId: number | null;
  /** La hidratación ya se pidió. Ver el comentario del efecto de montaje. */
  hidratado: boolean;
}

export function useComparendosSync(): SyncEnVivo {
  const { user } = useAuth();
  const [vista, setVista] = useState<Vista>(VISTA_INICIAL);
  const ctrl = useRef<Control>({
    vigente: true, timer: null, pendiente: false, inicio: 0, limite: 0,
    fallos: 0, intentosLocalizar: 0, motivo: null, runId: null,
    vistos: new Set(), idsConocidos: new Set(), userId: null, hidratado: false,
  });
  // El sondeo se reprograma a sí mismo, así que la cadena se corta con una referencia: `programar`
  // no puede depender de `sondear`, que a su vez depende de `programar`.
  const sondearRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => { ctrl.current.userId = user?.id ?? null; }, [user]);

  const parar = useCallback(() => {
    const c = ctrl.current;
    if (c.timer !== null) { clearTimeout(c.timer); c.timer = null; }
    c.pendiente = false;
  }, []);

  /**
   * Programa el SIGUIENTE sondeo. Con la pestaña oculta no se programa nada: se deja apuntado y se
   * sondea al volver (`visibilitychange`). El reloj del tope no se para —la corrida sigue—.
   */
  const programar = useCallback((esperaMs: number) => {
    const c = ctrl.current;
    if (!c.vigente) return;
    parar();
    if (document.visibilityState === 'hidden') { c.pendiente = true; return; }
    c.timer = window.setTimeout(() => {
      c.timer = null;
      void sondearRef.current();
    }, esperaMs);
  }, [parar]);

  /** Se acabó lo que se podía afirmar. Ver la cabecera: esto NO es un error. */
  const rendirse = useCallback(() => {
    parar();
    setVista((v) => ({ ...v, fase: 'sin_confirmar', contactoPerdido: false, anuncio: ANUNCIO.sinConfirmar }));
  }, [parar]);

  const terminarConError = useCallback((e: unknown) => {
    parar();
    setVista((v) => ({ ...v, fase: 'error', error: errorDeSync(e), contactoPerdido: false, anuncio: ANUNCIO.fallo }));
  }, [parar]);

  /**
   * Un sondeo que no llegó. Se tolera: la red de una oficina se cae medio minuto y la corrida sigue.
   * Al tercero se avisa —callarlo dejaría una barra animada que no significa nada— y al octavo se
   * deja de afirmar.
   */
  const contarFallo = useCallback(() => {
    const c = ctrl.current;
    c.fallos += 1;
    if (c.fallos >= FALLOS_RENDICION) { rendirse(); return; }
    if (c.fallos >= FALLOS_AVISO) setVista((v) => (v.contactoPerdido ? v : { ...v, contactoPerdido: true }));
    programar(cadencia(Date.now() - c.inicio));
  }, [programar, rendirse]);

  const manejarFalloDeSondeo = useCallback((e: unknown) => {
    // 403 es terminal: los permisos cambiaron con la pantalla abierta y reintentar no los devuelve.
    if (e instanceof ApiError && e.status === 403) { terminarConError(e); return; }
    // 429: el limitador pide aire. No es un fallo del servidor ni de la red, así que no acerca la
    // rendición; solo se espera más.
    if (e instanceof ApiError && e.status === 429) { programar(ESPERA_429_MS); return; }
    contarFallo();
  }, [contarFallo, programar, terminarConError]);

  /**
   * La corrida dejó de estar `running`: UNA sola lectura de `/:id` para traer los `steps[]`.
   *
   * El 404 no es un fallo que reintentar —la corrida se purgó o el id no es el que creíamos— y
   * tampoco autoriza a decir que falló: es exactamente el caso de `sin_confirmar`.
   */
  const cerrarConDetalle = useCallback(async (runId: string) => {
    const c = ctrl.current;
    try {
      const detalle = await api.get<ComparendosSyncResultado>(`${RUTA_RUNS}/${runId}`);
      if (!c.vigente) return;
      c.vistos.add(detalle.runId);
      parar();
      setVista((v) => ({
        ...v,
        fase: 'resultado',
        resultado: detalle,
        corrida: null,
        contactoPerdido: false,
        anuncio: anuncioTerminal(detalle.estado, v.ajena),
      }));
    } catch (e) {
      if (!c.vigente) return;
      if (e instanceof ApiError && e.status === 404) { rendirse(); return; }
      // El resto (5xx, red) sí se reintenta: el siguiente sondeo verá la corrida terminal otra vez.
      manejarFalloDeSondeo(e);
    }
  }, [manejarFalloDeSondeo, parar, rendirse]);

  /** Engancharse a una corrida `running` conocida y empezar (o seguir) a sondearla. */
  const engancharse = useCallback((run: ComparendosSyncRun, ajena: boolean, anuncio: string) => {
    const c = ctrl.current;
    c.runId = run.runId;
    c.vistos.add(run.runId);
    setVista((v) => ({
      ...v, fase: 'siguiendo', corrida: run, ajena, error: null, aviso: null, anuncio,
    }));
    programar(cadencia(Date.now() - c.inicio));
  }, [programar]);

  /**
   * No sé qué corrida seguir. Se busca distinto según por qué llegué aquí:
   *
   *   · `en_curso` (409) — mi POST no creó NADA, así que la corrida es la `running` que ya había,
   *     **sea de quien sea**. Si no es mía se dice; ocultarlo haría que un resultado ajeno pasara
   *     por propio. Y si ya no hay ninguna, terminó entre mi POST y este sondeo: vuelta al reposo
   *     con un aviso, no un error.
   *   · `corte` — mi POST pudo haber creado una corrida. Es la primera MÍA que no conocía antes de
   *     enviar. Si aparece ya terminal, el POST acabó después de que el cliente colgara: se muestra
   *     su resultado, que es tan válido como si hubiera llegado por la respuesta.
   */
  const localizar = useCallback(async (lista: ComparendosSyncRun[]) => {
    const c = ctrl.current;

    if (c.motivo === 'en_curso') {
      const enCurso = lista.find((r) => r.estado === 'running');
      if (!enCurso) {
        parar();
        c.runId = null;
        setVista((v) => ({
          ...v, fase: 'reposo', corrida: null, error: null, ajena: false,
          contactoPerdido: false, aviso: ANUNCIO.yaTermino, anuncio: ANUNCIO.yaTermino,
        }));
        return;
      }
      engancharse(enCurso, !esMia(enCurso, c.userId), ANUNCIO.seguimiento);
      return;
    }

    const mia = lista.find((r) => esMia(r, c.userId) && !c.idsConocidos.has(r.runId));
    if (!mia) {
      c.intentosLocalizar += 1;
      if (c.intentosLocalizar >= INTENTOS_LOCALIZAR) { rendirse(); return; }
      programar(ESPERA_LOCALIZAR_MS);
      return;
    }
    if (mia.estado === 'running') { engancharse(mia, false, ANUNCIO.seguimiento); return; }
    c.runId = mia.runId;
    await cerrarConDetalle(mia.runId);
  }, [cerrarConDetalle, engancharse, parar, programar, rendirse]);

  const sondear = useCallback(async () => {
    const c = ctrl.current;
    if (!c.vigente) return;
    // La pestaña se ocultó entre la programación y el disparo: se deja apuntado para la vuelta.
    if (document.visibilityState === 'hidden') { c.pendiente = true; return; }
    if (Date.now() >= c.limite) { rendirse(); return; }

    try {
      const lista = await api.get<ComparendosSyncRun[]>(`${RUTA_RUNS}?limit=${LIMITE_LISTA}`);
      if (!c.vigente) return;
      // Un 200 con algo que no es lista se trata como sondeo fallido, no como «no hay corridas»:
      // dar por terminada una corrida por un cuerpo inesperado es la conclusión más cara posible.
      if (!Array.isArray(lista)) { contarFallo(); return; }
      c.fallos = 0;
      for (const r of lista) c.vistos.add(r.runId);

      if (c.runId === null) { await localizar(lista); return; }

      const mia = lista.find((r) => r.runId === c.runId);
      if (mia && mia.estado === 'running') {
        // Solo se reescribe la vista si hay algo nuevo que decir: un `setVista` por sondeo
        // repintaría la tarjeta cada 2,5 s sin que nada haya cambiado.
        setVista((v) => (v.corrida?.runId === mia.runId && !v.contactoPerdido
          ? v
          : { ...v, corrida: mia, contactoPerdido: false }));
        programar(cadencia(Date.now() - c.inicio));
        return;
      }
      // Terminó, o ya no cabe en las últimas corridas (terminó hace rato). En los dos casos el
      // desenlace está en su detalle.
      await cerrarConDetalle(c.runId);
    } catch (e) {
      if (!c.vigente) return;
      manejarFalloDeSondeo(e);
    }
  }, [cerrarConDetalle, contarFallo, localizar, manejarFalloDeSondeo, programar, rendirse]);

  useEffect(() => { sondearRef.current = sondear; }, [sondear]);

  /**
   * Corte o 409: arrancar la búsqueda de la corrida, consultando **ya**.
   *
   * `sondearRef.current()` directo y NO `programar(0)`. La diferencia no es de estilo: el POST acaba
   * de tardar dos minutos, y hacer esperar otro turno de reloj antes de la primera lectura alarga
   * justo el rato en que quien mira no sabe qué está pasando. (Además, un `setTimeout(0)` bajo un
   * reloj detenido —el de los tests— no se dispararía nunca.)
   */
  const entrarALocalizar = useCallback((motivo: 'corte' | 'en_curso') => {
    const c = ctrl.current;
    c.motivo = motivo;
    c.runId = null;
    c.intentosLocalizar = 0;
    c.fallos = 0;
    setVista((v) => ({ ...v, fase: 'localizando', error: null, aviso: null, anuncio: ANUNCIO.seguimiento }));
    void sondearRef.current();
  }, []);

  const lanzar = useCallback((nits: string[] | null) => {
    const c = ctrl.current;
    if (!c.vigente) return;
    parar();
    c.runId = null;
    c.motivo = null;
    c.fallos = 0;
    c.intentosLocalizar = 0;
    c.inicio = Date.now();
    c.limite = c.inicio + TOPE_SEGUIMIENTO_MS;
    // Congelado ANTES del POST: es la frontera entre «lo que ya había» y «lo que pudo crear mi
    // petición». Después del POST ya no distinguiría nada.
    c.idsConocidos = new Set(c.vistos);

    setVista({ ...VISTA_INICIAL, fase: 'enviando', alcance: nits, anuncio: ANUNCIO.enCurso });

    void (async () => {
      try {
        // Cuerpo `{}` para el alcance global: sin clave `nits`, que es lo que el servidor lee como
        // «todos los activos». Nunca `nit` en singular — `syncSchema` es `.strict()` y lo rechaza.
        const detalle = await api.postConTimeout<ComparendosSyncResultado>(
          RUTA_SYNC, nits ? { nits } : {}, TIMEOUT_POST_MS,
        );
        if (!c.vigente) return;
        c.runId = detalle.runId;
        c.vistos.add(detalle.runId);
        // El POST síncrono devuelve la corrida ya terminada CON sus pasos: no hace falta pedir el
        // detalle. Si aun así llegara `running` (contrato futuro), se sigue en vez de mentir.
        if (detalle.estado === 'running') {
          engancharse(detalle, false, ANUNCIO.enCurso);
          return;
        }
        setVista((v) => ({
          ...v, fase: 'resultado', resultado: detalle, corrida: null,
          anuncio: anuncioTerminal(detalle.estado, false),
        }));
      } catch (e) {
        if (!c.vigente) return;
        // Los dos caminos del AC2, antes que cualquier copy de error: ninguno es un fallo.
        if (esCorteDeTiempo(e)) { entrarALocalizar('corte'); return; }
        if (esSyncEnCurso(e)) { entrarALocalizar('en_curso'); return; }
        setVista((v) => ({ ...v, fase: 'error', error: errorDeSync(e), anuncio: ANUNCIO.fallo }));
      }
    })();
  }, [engancharse, entrarALocalizar, parar]);

  const volverAlFormulario = useCallback(() => {
    const c = ctrl.current;
    parar();
    c.runId = null;
    c.motivo = null;
    c.fallos = 0;
    c.intentosLocalizar = 0;
    setVista({ ...VISTA_INICIAL, fase: 'reposo' });
  }, [parar]);

  /** Desde `sin_confirmar`: el reloj vuelve a cero y se reengancha por donde se pueda. */
  const volverAConsultar = useCallback(() => {
    const c = ctrl.current;
    c.fallos = 0;
    c.intentosLocalizar = 0;
    c.inicio = Date.now();
    c.limite = c.inicio + TOPE_SEGUIMIENTO_MS;
    setVista((v) => ({
      ...v,
      fase: c.runId ? 'siguiendo' : 'localizando',
      contactoPerdido: false,
      anuncio: c.runId ? ANUNCIO.enCurso : ANUNCIO.seguimiento,
    }));
    if (!c.runId && c.motivo === null) c.motivo = 'corte';
    void sondearRef.current();
  }, []);

  /**
   * Montaje: ¿hay algo corriendo ahora mismo? (AC4). Y el listener de visibilidad, que vive lo
   * mismo que el hook.
   *
   * Si la hidratación falla no se bloquea nada: se cae a `reposo` sin error visible. Quien pulse
   * `[Sincronizar]` con una corrida viva recibirá el 409 y entrará al seguimiento por su camino, que
   * es el mismo. Un error rojo aquí solo diría que no se pudo mirar el historial.
   */
  useEffect(() => {
    const c = ctrl.current;
    c.vigente = true;

    const alCambiarVisibilidad = () => {
      const actual = ctrl.current;
      if (document.visibilityState !== 'visible') return;
      if (!actual.vigente || !actual.pendiente) return;
      actual.pendiente = false;
      void sondearRef.current();
    };
    document.addEventListener('visibilitychange', alCambiarVisibilidad);

    // UNA hidratación por instancia del hook, aunque el efecto corra dos veces.
    //
    // En desarrollo, `StrictMode` monta, limpia y vuelve a montar los efectos sobre la MISMA
    // instancia —las refs sobreviven, que es lo que hace fiable esta bandera—. Sin ella, entrar a la
    // pestaña dispara dos `GET /sync/runs`, y esa lectura no es gratis: escribe una fila de
    // `pii_access_log` con los NIT del alcance de las corridas listadas (HU #11511). Duplicar
    // accesos a datos personales en la bitácora es peor que duplicar una petición.
    if (!c.hidratado) {
      c.hidratado = true;
      api.get<ComparendosSyncRun[]>(`${RUTA_RUNS}?limit=${LIMITE_LISTA}`)
        .then((lista) => {
          if (!c.vigente) return;
          const runs = Array.isArray(lista) ? lista : [];
          for (const r of runs) c.vistos.add(r.runId);
          const enCurso = runs.find((r) => r.estado === 'running');
          if (!enCurso) { setVista((v) => ({ ...v, fase: 'reposo' })); return; }
          // El tope de 10 min se cuenta desde AQUÍ y no desde el `iniciadoEn` de la corrida: es un
          // presupuesto de la pantalla, y restarle el reloj del servidor al del portátil es
          // exactamente la comparación de relojes que este archivo evita.
          c.inicio = Date.now();
          c.limite = c.inicio + TOPE_SEGUIMIENTO_MS;
          engancharse(enCurso, !esMia(enCurso, c.userId), ANUNCIO.enCurso);
        })
        .catch(() => { if (c.vigente) setVista((v) => ({ ...v, fase: 'reposo' })); });
    }

    return () => {
      // Cambiar de pestaña desmonta el marco entero. La corrida NO se cancela —el servidor sigue— y
      // al volver, `hidratando` la reengancha.
      c.vigente = false;
      if (c.timer !== null) { clearTimeout(c.timer); c.timer = null; }
      c.pendiente = false;
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
    };
  }, [engancharse]);

  return { ...vista, lanzar, volverAlFormulario, volverAConsultar };
}
