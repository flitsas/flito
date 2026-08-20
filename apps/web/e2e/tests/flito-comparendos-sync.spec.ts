// FLITO — Comparendos · Sincronización: la consola (HU #11635) y el historial de corridas (#11636).
//
// Cubre las DOS regiones de `docs/ux/flito-comparendos-config-sync.md` § «Vista Sincronización —
// consola + historial», y en este orden:
//
//   · REGIÓN A — la consola (HU #11635): disparo, estado en curso, paso a seguimiento y resultado
//     terminal. TC37–TC64.
//   · REGIÓN B — el historial de corridas y su modal de detalle (HU #11636): la lista, el detalle
//     con pasos, los estados vacío/error, y las tres obligaciones que la enmienda de UX del 20 ago
//     2026 (decisiones 13–16) le impone. TC65–TC85.
//
// Van en el MISMO archivo a propósito: las dos regiones viven en la misma vista, comparten la
// región viva única y comparten el `GET /sync/runs`. Los TCs que más valen de la #11636 —el
// refresco único al desenlace, la ausencia de sondeo propio, la región viva que sigue siendo una—
// son afirmaciones sobre la vista ENTERA, y partirlas en dos archivos sería no poder escribirlas.
//
// Numeración: los TCs siguen la serie del Feature, que llega a TC36 en
// `flito-comparendos-pills-config.spec.ts` (HUs #11633 y #11634). Aquí van TC37 a TC85. Ese archivo
// NO se toca desde estas HUs.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// GUARDIA DE COBERTURA — ESTE ARCHIVO ESTÁ DESPIERTO ENTERO
//
// Los dos bloques nacieron dormidos, y los dos se despertaron en su gate. Conviene que quede
// escrito, porque el modo A vuelve a repetirse en cada HU de este Feature:
//
//   · **TC37–TC64 (consola, #11635).** Escritos antes que la pantalla. Su gate B los despertó,
//     corrigió los fixtures que describían un mundo imposible (ver `esperarConsolaEnReposo`), añadió
//     el TC63 que faltaba y el TC64 que pidió la auditoría de seguridad, y corrió los 28 en verde.
//   · **TC65–TC85 (historial, #11636).** Escritos en modo A con la HU en `Active`, mientras el
//     frontend implementaba en paralelo y sin que existieran todavía `HistorialSyncComparendos.tsx`
//     ni `PanelDetalleSyncRun.tsx`. Su gate B los despertó, encontró la doble lectura del detalle
//     —dos filas de `pii_access_log` por abrir un modal—, corrigió el fixture de TC76 (un servidor
//     que no incluía la corrida recién lanzada) y añadió TC81, TC82 y TC83, que el modo A había
//     dejado declarados como huecos. Después, la auditoría de seguridad corrigió el RADIO del
//     barrido de PII (TC66/TC67: `outerHTML` y la región entera, no `innerHTML` de la tabla) y una
//     carrera entre la carga del archivo y el desenlace añadió TC84 con su control TC85.
//
// Un bloque dormido APARENTA cobertura —el runner dice «skipped» y pinta verde igual—, así que el
// check es obligatorio en cada gate, se hace así y lo correcto es **CERO líneas**:
//
//     grep -nE '\.(fixme|skip|only)\(' apps/web/e2e/tests/flito-comparendos-sync.spec.ts
//
// Cualquier línea que devuelva es un TC apagado, y un TC apagado en un archivo ya entregado no es
// una espera: es una regresión de cobertura que hay que justificar antes de seguir.
//
// Ese patrón está escrito para no encontrarse a sí mismo: la cadena que busca —punto, la palabra, y
// el paréntesis— no aparece en ninguna parte de este comentario. Si algún día hay que volver a
// dormir un bloque, el modificador se pone en el código y no se nombra aquí arriba: un check que hay
// que interpretar no es un check.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// LOS SELECTORES SON CONTRATO, NO ADIVINANZA
//
// Al escribirse antes que la pantalla, este archivo no describe el marcado que hay: PIDE el que
// tiene que haber. Todo sale del copy literal de la spec de UX y de sus notas de a11y, y se afirma
// por rol y por texto visible —nunca por clase CSS ni por `data-testid` inventado—. Lo que el
// frontend-agent tiene que respetar, y que aquí se da por normativo:
//
//   · Consola  → `role="region"` con nombre accesible «Sincronizar ahora» (mismo patrón que los
//     cuatro bloques de Configuración, que ya son `region` etiquetada por su título).
//   · Resultado → `role="region"` con nombre «Resultado de la corrida».
//   · Anuncios → UNA sola región viva, `role="status"` (que es `aria-live="polite"` implícito), viva
//     durante toda la vista: inicio, paso a seguimiento y resultado terminal se anuncian ahí. TC62
//     la clava en una y solo una.
//   · Errores definitivos → `role="alert"`. Nunca para el paso a seguimiento (ver abajo).
//   · Botón → «Sincronizar» en reposo; «Sincronizando…» + `disabled` + `aria-busy="true"` mientras
//     dura el disparo Y mientras dura el seguimiento.
//   · Barra de progreso → `role="progressbar"` SIN `aria-valuenow`: el API no da porcentaje y un
//     número inventado es peor que ninguno.
//   · La primera lectura al pasar a seguimiento es INMEDIATA, no espera al primer tic del intervalo:
//     si el POST murió a los 110 s, hacer esperar otros 2,5 s solo alarga la incertidumbre.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// QUÉ FALLOS PERSIGUE (por qué esta HU se finge fácil)
//
//   1. **El corte de tiempo tratado como fallo definitivo.** Es EL fallo del Feature. El servidor es
//      síncrono (ADR-0001), el proxy corta a ~120 s y el cliente se rinde a ~110 s: cuando eso pasa
//      la corrida SIGUE VIVA en el servidor. Si la pantalla pinta «la sincronización falló», el
//      operador cree que no sincronizó, vuelve a pulsar y choca contra el 409 —y ahora sí tiene dos
//      mensajes rojos y ninguna idea de qué pasó—. TC42, TC43 y TC44 persiguen las tres puertas por
//      las que se entra a esa situación (red, tope propio del cliente, 409), y las tres afirman lo
//      MISMO en negativo: que no hay `role="alert"` y que no aparece ninguna de las copias de fallo.
//   2. **El sondeo que no para.** Tres formas de la misma fuga: seguir preguntando cuando la corrida
//      ya terminó (TC48), seguir preguntando desde una vista que el operador ya abandonó (TC49) y
//      martillear el servidor cada 300 ms en vez de cada 2,5 s (TC47). La tercera solo se ve
//      contando peticiones; las dos primeras, en producción, son peticiones eternas que nadie mira.
//   3. **El resultado terminal que nunca llega.** El sondeo entra pero no sale: la corrida pasa a
//      `completed` y la pantalla sigue diciendo «seguimos el progreso» para siempre. TC46 exige la
//      transición completa —y que el detalle se lea UNA sola vez, no en cada vuelta—; TC53 cubre el
//      caso torcido en que el POST terminó DESPUÉS del abort del cliente y ya no hay nada `running`
//      que encontrar.
//   4. **El 409 ramificado por texto y no por `codigo`.** Funciona el día que se escribe y se rompe
//      el día que alguien mejora la redacción del backend. TC44 manda un 409 cuyo mensaje NO dice
//      «en curso» y exige seguimiento; TC45 manda el espejo —un 409 cuyo mensaje SÍ lo dice pero con
//      otro `codigo`— y exige error definitivo. Solo pasa quien mire `codigo`.
//   5. **Errores accionables que no llevan a ninguna parte.** Un mensaje que dice «configúralo» sin
//      un enlace que lleve allí es una nota de disculpa. TC54 y TC55 pulsan el enlace y comprueban
//      el destino, no su existencia.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// CÓMO SE CONTROLA EL TIEMPO
//
// Un TC no puede esperar 110 s (el test entero muere a los 30) ni 10 minutos. Tres TCs —TC43, TC47
// y TC51— instalan el reloj falso de Playwright y adelantan el tiempo a mano. Los demás corren en
// tiempo real, a propósito: el reloj falso es la herramienta más cara de este archivo y cuanto menos
// código dependa de él, menos frágil es la suite.
//
// Consecuencia para quien implemente, y no es un detalle: **el tope del POST tiene que ser
// `AbortController` + `setTimeout`** —lo que ya hace `request()` en `lib/api.ts` con su tope global
// de 90 s— y NO `AbortSignal.timeout()`. El reloj de Playwright parchea `setTimeout`/`setInterval`
// pero no el temporizador interno de `AbortSignal`, así que con esa segunda forma TC43 no podría
// distinguir un tope de 110 s de uno que no existe. Lo mismo para el sondeo: temporizadores, no
// bucles de espera activa.
//
// Si el reloj falso diera problemas con el árbol de React en el gate, la alternativa para TC47/TC51
// es medir en tiempo real con intervalos cortos y ajustar el tope a segundos; TC43 no tiene
// alternativa y quedaría como deuda declarada. No se apaga un TC sin decirlo.
//
// PII: todos los NITs son SINTÉTICOS («900123456», «830009988», «900111222») y ninguno es de una
// empresa real (Ley 1581). El NIT se ve en pantalla —es el eje del módulo y solo lo mira `admin`—
// pero NUNCA viaja en la URL del SPA: TC38 lo afirma sobre el alcance con selección.
// ══════════════════════════════════════════════════════════════════════════════════════════════
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const API_NITS = '**/api/flito/comparendos/nits';
const API_MUNICIPIOS = '**/api/flito/comparendos/municipios';
const API_CAUSALES = '**/api/flito/comparendos/causales';
const API_TOKEN = '**/api/flito/comparendos/config/token-simit';

/** El disparo. Sin comodín al final: `/sync/runs` NO puede caer aquí. */
const API_SYNC = '**/api/flito/comparendos/sync';
/** Listado Y detalle de corridas en un solo patrón: el manejador desambigua por `pathname`. */
const API_RUNS = '**/api/flito/comparendos/sync/runs**';

// ─────────────────────────────────────── Datos sintéticos ───────────────────────────────────────

const NIT_A = '900123456';
const NIT_B = '830009988';
const NIT_INACTIVO = '900111222';

const SELLO = { creadoEn: '2026-07-02T08:12:00Z', actualizadoEn: '2026-08-14T08:07:00Z' };

/**
 * El catálogo que alimenta el selector de «Solo estos NIT».
 *
 * El tercero está INACTIVO a propósito: el selector se construye filtrando `activo === true`, y sin
 * un inactivo en la lista ese filtro sería una afirmación que pasa siempre. TC38 comprueba que no se
 * ofrece —ofrecerlo termina en un 400 `nits_filtro_invalido` que el operador no puede entender,
 * porque la pantalla misma se lo puso delante—.
 */
const NITS = [
  { id: 'n1', nit: NIT_A, alias: 'Transportes Andinos SAS', activo: true, ...SELLO },
  { id: 'n2', nit: NIT_B, alias: null, activo: true, ...SELLO },
  { id: 'n3', nit: NIT_INACTIVO, alias: 'Prueba tipográfica', activo: false, ...SELLO },
];

const MUNICIPIOS = [
  { id: 'm1', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, ...SELLO },
  { id: 'm2', codigoFuente: 'BELLO', nombre: 'Bello', activo: true, ...SELLO },
];
const CAUSALES = [{ id: 'c1', nombre: 'Notificado al cliente', activo: true, orden: 10, ...SELLO }];
const TOKEN_CONFIGURADO = {
  configurado: true,
  actualizadoEn: '2026-08-14T14:14:00Z',
  actualizadoPor: { id: 7, nombre: 'María Ruiz' },
  keyVersion: 2,
};

const RUN_ID = 'run-2026-08-14-0001';

/**
 * Instantes en UTC. 20:02Z son las 15:02 en Bogotá, que es la hora del wireframe.
 *
 * Si la pantalla olvidara el `timeZone` —`fechaHoraColombia()` en `formato.ts` lo pone— un runner en
 * UTC pintaría «20:02» y los TCs lo dirían. Es el mismo cuidado que la HU #11634 puso en el sello
 * del token.
 */
const INICIADO_EN = '2026-08-14T20:02:00Z';
const FINALIZADO_EN = '2026-08-14T20:04:00Z';

const ALCANCE = [NIT_A, NIT_B, NIT_INACTIVO];

const RESUMEN_COMPLETADA = {
  modo: 'real',
  nitsProcesados: 12,
  llamadasSimitOk: 12,
  llamadasSimitError: 0,
  llamadasMunicipalOk: 40,
  llamadasMunicipalError: 0,
  upserts: 340,
  inactivados: 3,
  reactivados: 1,
  primeraLlegada: 12,
  itemsIgnorados: 0,
  nitsSinInactivacion: 0,
  abortadaPorTiempo: false,
  inactivacionOmitida: null,
};

/** `partial` = hubo datos pero no de todas las fuentes: dos NITs se quedaron sin inactivar (CF-10). */
const RESUMEN_PARCIAL = {
  ...RESUMEN_COMPLETADA,
  llamadasMunicipalOk: 38,
  llamadasMunicipalError: 2,
  inactivados: 0,
  nitsSinInactivacion: 2,
};

/**
 * El resumen incómodo: corrida cortada por su propio plazo, barrido de inactivación omitido por el
 * tope de seguridad y datos que ni siquiera vinieron del proveedor real.
 *
 * Los tres avisos a la vez y en la misma corrida no son un montaje inverosímil: son exactamente lo
 * que produce un ambiente mal apuntado un lunes por la mañana, y son los tres que hacen que un
 * «Ignorados 0» signifique «no se llegó a mirar» en vez de «no había nada».
 */
const RESUMEN_CON_AVISOS = {
  ...RESUMEN_COMPLETADA,
  modo: 'mock',
  abortadaPorTiempo: true,
  inactivacionOmitida: 'umbral',
  inactivados: 0,
  nitsSinInactivacion: 4,
};

const STEPS = [
  { nit: NIT_A, fuente: 'simit', ok: true, httpStatus: 200, errorCode: null, mensaje: null, itemsLeidos: 14, duracionMs: 1_200 },
  { nit: NIT_A, fuente: 'ITAGUI', ok: true, httpStatus: 200, errorCode: null, mensaje: null, itemsLeidos: 3, duracionMs: 800 },
];

/**
 * El paso que falló. Lleva `itemsLeidos: null` a propósito: `null` es información —«no se llegó a
 * leer»— y la celda tiene que pintar el guion, no un cero que se leería como «no había comparendos».
 */
const STEP_ERROR = {
  nit: NIT_B,
  fuente: 'BELLO',
  ok: false,
  httpStatus: 504,
  errorCode: 'fuente_timeout',
  mensaje: 'El municipio no respondió a tiempo.',
  itemsLeidos: null,
  duracionMs: 8_000,
};

const RUN_EN_CURSO = {
  runId: RUN_ID,
  estado: 'running',
  iniciadoEn: INICIADO_EN,
  finalizadoEn: null,
  scopeNits: ALCANCE,
  resumen: null,
  iniciadoPor: 7,
};
const RUN_COMPLETADA = {
  ...RUN_EN_CURSO, estado: 'completed', finalizadoEn: FINALIZADO_EN, resumen: RESUMEN_COMPLETADA,
};

const RESULTADO_COMPLETADA = { ...RUN_COMPLETADA, steps: STEPS };
const RESULTADO_PARCIAL = {
  ...RUN_COMPLETADA, estado: 'partial', resumen: RESUMEN_PARCIAL, steps: [...STEPS, STEP_ERROR],
};
const RESULTADO_FALLIDA = {
  ...RUN_COMPLETADA,
  estado: 'failed',
  resumen: { ...RESUMEN_COMPLETADA, llamadasSimitOk: 0, llamadasSimitError: 12, upserts: 0 },
  steps: [STEP_ERROR],
};
const RESULTADO_CON_AVISOS = {
  ...RUN_COMPLETADA, estado: 'partial', resumen: RESUMEN_CON_AVISOS, steps: STEPS,
};

// ────────────────────────────────────────── Copy literal ────────────────────────────────────────

/**
 * El copy, palabra por palabra, de `docs/ux/flito-comparendos-config-sync.md`.
 *
 * Va COPIADO y no importado de la pantalla: importando la constante, el TC diría «el mensaje es el
 * que diga el código», que es una tautología que pasa siempre. Copiado dice «el mensaje es ESTE»,
 * que es lo que el AC pide y lo que falla cuando alguien lo cambia sin pasar por UX.
 *
 * `ayudaParcial` arrastra una AMBIGÜEDAD de la spec que hay que resolver antes de cerrar la HU: la
 * tabla «Tonos del estado de corrida» redacta esa ayuda de una forma («Hubo datos, pero no de todas
 * las fuentes…») y el «Copy — catálogo corto» de otra. Aquí manda el catálogo, por ser el índice
 * canónico de copy del documento; si UX decide lo contrario, se cambia AQUÍ y TC39 lo delata.
 */
const COPY = {
  enCurso: 'Sincronización en curso.',
  seguimiento: 'La respuesta tardó; seguimos el progreso de la corrida.',
  topeEspera: 'La corrida sigue en el servidor. Revisa el historial en unos minutos.',
  sinNits: 'No hay NIT activos para sincronizar. Agrégalos o actívalos en Configuración.',
  tokenFalta: 'Falta el token SIMIT. Configúralo antes de sincronizar.',
  filtroInvalido: 'Estos NIT no están activos en el catálogo:',
  modoSimulado: 'La sincronización está en modo simulado en un ambiente de producción y se abortó '
    + 'para no escribir datos inventados. Avisa a quien administra el ambiente.',
  limitador: 'Ya se lanzaron varias sincronizaciones en el último minuto. Espera un minuto.',
  generico: 'No se pudo iniciar la sincronización. Vuelve a intentarlo.',
  ayudaParcial: 'Con cobertura incompleta no se inactivan comparendos de esos NIT aunque «falten» '
    + 'en una fuente.',
  ayudaTiempo: 'La corrida se cortó por tiempo: lo no consultado no significa ausencia.',
  ayudaUmbral: 'No se inactivó nada: el volumen a apagar superaba el tope de seguridad.',
  modoMock: 'Modo simulado — los datos no vinieron del proveedor real.',
  toastCompletada: 'Sincronización completada.',
  toastParcial: 'Sincronización parcial: revisa las fuentes con error.',
  toastFallida: 'La sincronización falló. Revisa el detalle de la corrida.',
} as const;

/**
 * Todas las copias de fallo definitivo, juntas.
 *
 * Existe para el barrido en NEGATIVO de los tres TCs del corte de tiempo: lo que hay que demostrar
 * ahí no es solo que aparezca el mensaje bueno, es que NO aparezca ninguno de los malos. Afirmar
 * únicamente sobre el mensaje esperado dejaría pasar una pantalla que enseña las dos cosas a la vez
 * —«seguimos el progreso» arriba y una banda roja debajo—, que para el operador es peor que
 * cualquiera de las dos por separado.
 */
const COPIAS_DE_FALLO = [COPY.generico, COPY.limitador, COPY.sinNits, COPY.tokenFalta, COPY.toastFallida];

// ─────────────────────────────────────── Mocks con traza ────────────────────────────────────────

interface Respuesta { status: number; body: unknown }

/**
 * Mock de LECTURA por valor mutable, no por cola de respuestas.
 *
 * Mismo motivo que en `flito-comparendos-pills-config.spec.ts`: en desarrollo React monta en
 * `StrictMode` y el efecto corre dos veces, así que una cola «primero esto, después aquello» le
 * serviría la segunda respuesta al segundo montaje y el TC miraría un estado que el usuario nunca ve.
 * Con un valor mutable manda el test, no el orden de los efectos.
 */
async function mockLectura(page: Page, url: string, inicial: Respuesta) {
  const estado = { respuesta: inicial, llamadas: 0 };
  await page.route(url, (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    estado.llamadas += 1;
    return route.fulfill({
      status: estado.respuesta.status,
      contentType: 'application/json',
      body: JSON.stringify(estado.respuesta.body),
    });
  });
  return estado;
}

/**
 * Qué hace el servidor con el `POST /sync`. Es el mando a distancia de esta HU.
 *
 * Los tres planes no son tres formas de escribir lo mismo: son las tres cosas distintas que el
 * mundo real hace con ese POST.
 *   · `responder` — hay respuesta HTTP (200 con la corrida, o el 4xx/5xx que sea).
 *   · `abortar`   — la petición muere en la red. Es lo que el navegador ve cuando el proxy corta a
 *                   los ~120 s, y lo que `lib/api.ts` traduce a `ApiError(0, …)`.
 *   · `retener`   — la petición se queda colgada para siempre. Es la única forma de comprobar el
 *                   tope de tiempo del PROPIO cliente: si el servidor nunca contesta, rendirse (o
 *                   no) es una decisión enteramente del navegador.
 */
type PlanSync =
  | { tipo: 'responder'; status: number; body: unknown }
  | { tipo: 'abortar'; motivo: 'timedout' | 'failed' }
  | { tipo: 'retener' };

interface EstadoSync {
  plan: PlanSync;
  /** El cuerpo de cada disparo. Media docena de TCs afirman sobre lo enviado, no sobre lo pintado. */
  cuerpos: (Record<string, unknown> | null)[];
  soltar: (() => void) | null;
}

async function mockDisparo(page: Page, inicial: PlanSync): Promise<EstadoSync> {
  const estado: EstadoSync = { plan: inicial, cuerpos: [], soltar: null };
  await page.route(API_SYNC, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let cuerpo: Record<string, unknown> | null;
    // Un sync global se pide con un POST pelado, sin cuerpo: ahí `postDataJSON()` revienta y `null`
    // es la respuesta correcta, no un error del mock. El backend hace lo propio (`req.body ?? {}`).
    try { cuerpo = route.request().postDataJSON() as Record<string, unknown>; } catch { cuerpo = null; }
    estado.cuerpos.push(cuerpo);

    const plan = estado.plan;
    if (plan.tipo === 'abortar') return route.abort(plan.motivo);
    if (plan.tipo === 'retener') {
      await new Promise<void>((resolve) => { estado.soltar = resolve; });
      // Si el cliente ya se rindió, `fulfill` rechaza sobre una petición que el navegador ya no
      // tiene: eso no es un fallo del TC, es exactamente lo que el TC provocó.
      return route
        .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_COMPLETADA) })
        .catch(() => undefined);
    }
    return route.fulfill({
      status: plan.status, contentType: 'application/json', body: JSON.stringify(plan.body),
    });
  });
  return estado;
}

interface EstadoRuns {
  /** Lo que devuelve `GET /sync/runs`. Mutable: así se simula que la corrida cambia de estado. */
  lista: unknown[];
  /** Lo que devuelve `GET /sync/runs/:id`, por id. */
  detalle: Record<string, unknown>;
  llamadasLista: number;
  llamadasDetalle: number;
  idsPedidos: string[];
  /** El `?limit=` de cada lectura del listado. */
  limites: string[];

  // ─── Añadido por la HU #11636. Todo lo de aquí abajo está APAGADO por defecto: los 28 TCs de la
  //     consola no cambian de comportamiento ni por un byte. ───

  /** Status con el que falla el LISTADO. `null` = responder 200 con `lista`. */
  fallaLista: number | null;
  /** Status con el que falla el DETALLE, sea cual sea el id. `null` = responder según `detalle`. */
  fallaDetalle: number | null;
  /** Con `true`, cada lectura del listado se queda colgada hasta `soltarLista()`. */
  congelado: boolean;
  /**
   * Congela el listado a partir de la PRIMERA lectura que sirva una corrida ya terminal (esa se
   * sirve; las siguientes esperan). Es lo que hace decidible el TC79: el refresco del desenlace se
   * queda en el aire, así que la primera fila solo puede estar bien si NO esperó a la red.
   *
   * Congelar por CONTENIDO y no por número de llamada es deliberado: contar llamadas obliga a
   * adivinar cuántos sondeos había en vuelo al cambiar el fixture, y un sondeo que llegue medio
   * segundo antes o después cambiaría a cuál le toca colgarse. Aquí no hay carrera posible.
   */
  congelarTrasElDesenlace: boolean;
  /**
   * Cuántas lecturas del listado están AHORA MISMO esperando a que las suelten.
   *
   * Es el instrumento del TC79 y no un contador de adorno: con el refresco del desenlace congelado,
   * `0` significa que nadie pidió la lista nueva —el archivo se quedó viejo— y `2` o más, que
   * detrás del desenlace hay un sondeo. `1` es la obligación de la enmienda, exactamente.
   */
  retenidas: number;
  /**
   * Plan POR LECTURA del listado, cuando `congelado` y `fallaLista` se quedan cortos.
   *
   * Recibe el `?limit=` y el número de lectura **con ese mismo límite** (1 = la primera), y decide:
   * `'retener'` la deja colgada, un `{ status, body }` la responde así, y `null` es «lo de siempre».
   * Distinguir por límite es lo que permite tratar distinto a las dos zonas que leen este endpoint:
   * la consola hidrata con un límite corto y el historial pide sus páginas con el de la spec.
   *
   * Lo pide TC84: la carrera necesita que la PRIMERA página del historial no llegue nunca, que el
   * refresco del desenlace —la segunda— falle, y que el reintento —la tercera— vaya bien, todo
   * mientras la consola sigue sondeando con normalidad. Con un interruptor global no se puede.
   */
  planLista: ((limite: string, nEsima: number) => 'retener' | Respuesta | null) | null;
  /** Suelta lo retenido y deja de congelar. Idempotente. */
  soltarLista: () => void;
}

/**
 * Las dos lecturas de corridas en un solo manejador, desambiguadas por `pathname`.
 *
 * Con dos `page.route` —uno para el listado y otro para el detalle— el resultado dependería del
 * ORDEN de registro, porque Playwright evalúa las rutas al revés de como se registran y
 * el patrón de `API_RUNS` —que termina en comodín— se traga también `/sync/runs/:id`. Un TC que pasa
 * o falla según qué helper se llamó primero es una trampa para el siguiente que edite el archivo.
 *
 * Contar las llamadas no es telemetría de adorno: la mitad de los TCs del seguimiento afirman sobre
 * el NÚMERO de peticiones, que es la única forma de ver desde fuera que un sondeo paró, que respetó
 * su cadencia o que no se quedó vivo detrás de una vista desmontada.
 */
async function mockRuns(
  page: Page,
  inicial: {
    lista?: unknown[];
    detalle?: Record<string, unknown>;
    /** Arranca con el listado colgado: es el estado «cargando» del historial (TC77). */
    congelado?: boolean;
  } = {},
): Promise<EstadoRuns> {
  const retenidas: (() => void)[] = [];
  const estado: EstadoRuns = {
    lista: inicial.lista ?? [],
    detalle: inicial.detalle ?? {},
    llamadasLista: 0,
    llamadasDetalle: 0,
    idsPedidos: [],
    limites: [],
    fallaLista: null,
    fallaDetalle: null,
    congelado: inicial.congelado ?? false,
    congelarTrasElDesenlace: false,
    retenidas: 0,
    planLista: null,
    soltarLista: () => {
      estado.congelado = false;
      estado.congelarTrasElDesenlace = false;
      while (retenidas.length > 0) retenidas.pop()?.();
    },
  };
  await page.route(API_RUNS, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const id = url.pathname.split('/sync/runs/')[1] ?? '';
    if (id) {
      estado.llamadasDetalle += 1;
      estado.idsPedidos.push(id);
      if (estado.fallaDetalle !== null) {
        return route.fulfill({
          status: estado.fallaDetalle,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'No se pudo leer la corrida', codigo: 'error_interno' }),
        });
      }
      const cuerpo = estado.detalle[id];
      return route.fulfill(cuerpo
        ? { status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) }
        : {
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Corrida no encontrada', codigo: 'no_encontrado' }),
        });
    }
    estado.llamadasLista += 1;
    const limite = url.searchParams.get('limit') ?? '';
    estado.limites.push(limite);

    // El plan por lectura manda sobre los interruptores globales: es más específico.
    const nEsima = estado.limites.filter((l) => l === limite).length;
    const plan = estado.planLista ? estado.planLista(limite, nEsima) : null;
    if (plan === 'retener') {
      estado.retenidas += 1;
      // Se registra en la misma cola que el congelado para que `soltarLista()` la suelte al final
      // del TC: una petición colgada en el cierre de la página no rompe nada, pero dejarla suelta
      // a propósito cuando hay una forma de recogerla es ensuciar el teardown de los demás.
      await new Promise<void>((resolve) => { retenidas.push(resolve); });
      estado.retenidas -= 1;
    } else if (plan !== null) {
      return route.fulfill({
        status: plan.status, contentType: 'application/json', body: JSON.stringify(plan.body),
      }).catch(() => undefined);
    }

    // La cuenta sube ANTES de esperar: una lectura retenida ya ocurrió —el servidor la recibió— y
    // el TC que mide «cuántas veces se preguntó» tiene que verla mientras sigue colgada.
    if (estado.congelado) {
      estado.retenidas += 1;
      await new Promise<void>((resolve) => { retenidas.push(resolve); });
      estado.retenidas -= 1;
    }
    if (estado.fallaLista !== null) {
      return route.fulfill({
        status: estado.fallaLista,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No se pudo listar', codigo: 'error_interno' }),
      });
    }
    const cuerpo = estado.lista;
    if (estado.congelarTrasElDesenlace && primeraEsTerminal(cuerpo)) estado.congelado = true;
    // `fulfill` puede rechazar si el TC ya cerró la página con lecturas retenidas dentro: eso no es
    // un fallo del mock, es el final normal de un TC que congeló el listado a propósito.
    return route
      .fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) })
      .catch(() => undefined);
  });
  return estado;
}

/**
 * ¿La corrida de arriba —la que se está siguiendo— ya tiene desenlace? Lo que arma el congelado.
 *
 * Se mira SOLO la primera y no «alguna»: el listado viene ordenado de la más reciente a la más
 * vieja, así que en un historial normal SIEMPRE hay corridas terminales debajo, y preguntar por
 * «alguna» congelaría el listado desde la primera lectura del montaje.
 */
function primeraEsTerminal(lista: unknown[]): boolean {
  const estado = (lista[0] as { estado?: string } | null)?.estado;
  return typeof estado === 'string' && estado !== 'running';
}

// ────────────────────────────────────────── Localizadores ───────────────────────────────────────

const consola = (page: Page) => page.getByRole('region', { name: 'Sincronizar ahora' });
const resultado = (page: Page) => page.getByRole('region', { name: 'Resultado de la corrida' });
const botonSincronizar = (page: Page) => page.getByRole('button', { name: 'Sincronizar', exact: true });
const botonOcupado = (page: Page) => page.getByRole('button', { name: 'Sincronizando…' });
const bloqueToken = (page: Page) => page.getByRole('region', { name: 'Token SIMIT' });

/**
 * La región viva de la vista. Una sola, y `role="status"` —que ya implica `aria-live="polite"`—.
 *
 * Se busca por rol y no por `[aria-live="polite"]` porque las dos formas son la MISMA promesa para
 * quien usa lector de pantalla y no tiene sentido que un TC prefiera una ortografía; el rol es
 * además lo que Playwright resuelve por el árbol de accesibilidad, que es donde vive el contrato.
 * TC62 fija que hay exactamente una.
 */
const anuncio = (page: Page) => page.getByRole('status');

async function irASincronizacion(page: Page) {
  await page.goto('/flito/comparendos?vista=sincronizacion');
}

/**
 * Espera a que la consola esté DE VERDAD en reposo: hidratación resuelta y botón disponible.
 *
 * Corrige los dos errores que este spec traía de fábrica, encontrados en el gate B. Los dos eran
 * míos, no de la pantalla, y conviene que queden escritos:
 *
 *   1. **La corrida no puede existir antes del disparo.** Seis TCs arrancaban con
 *      `lista: [RUN_EN_CURSO]` y DESPUÉS pulsaban «Sincronizar». Eso se contradice con el AC4 y con
 *      mi propio TC60: al montar con una corrida `running`, la consola entra en seguimiento sola y
 *      el formulario desaparece —lo exige TC52—, así que no queda botón que pulsar. La corrida tiene
 *      que NACER del disparo, que es lo que ocurre en producción; el fixture describía un mundo
 *      imposible y habría hecho fallar a una implementación correcta.
 *   2. **El contador de lecturas no se puede leer justo después de `goto`.** La vista se carga con
 *      `lazy()`, así que su lectura de montaje llega más tarde: capturar antes dejaba el contador en
 *      0, subía a 1 él solo, y la aserción «no abrió seguimiento» fallaba acusando a la pantalla de
 *      algo que no hizo.
 *
 * El botón habilitado es la señal honesta de las dos cosas a la vez: solo se habilita cuando la fase
 * deja de ser `hidratando`, y eso ocurre cuando la lectura del historial ya respondió.
 */
async function esperarConsolaEnReposo(page: Page) {
  await expect(botonSincronizar(page)).toBeEnabled();
}

/**
 * El almacenamiento del navegador, ENTERO y en texto plano, para buscar la aguja dentro.
 *
 * Copiado del mismo helper de `flito-comparendos-pills-config.spec.ts` (donde persigue el token) y
 * por el mismo motivo: se serializan los dos almacenes COMPLETOS en vez de mirar una clave concreta,
 * porque el fallo que se persigue no es «alguien lo guardó en la clave `alcance`», es «acabó en
 * algún sitio persistente». Buscar por clave solo encuentra el descuido que ya se sospechaba, y una
 * clave se renombra en el mismo commit en que se escribe.
 */
async function almacenamiento(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
}

/**
 * Adelanta el reloj falso hasta que salte exactamente UN sondeo.
 *
 * Avanza 5,5 s de golpe —más que cualquier peldaño de la cadencia— para que el paso sea el mismo en
 * los dos tramos y el TC no tenga que saber en cuál está. Solo puede saltar uno por llamada: el
 * siguiente se programa cuando VUELVE la respuesta del anterior, y esa vuelta ocurre en tiempo real,
 * después de que `runFor` haya terminado.
 */
async function avanzarUnSondeo(page: Page, runs: EstadoRuns) {
  const antes = runs.llamadasLista;
  await page.clock.runFor(5_500);
  await expect.poll(() => runs.llamadasLista, { timeout: 5_000 }).toBe(antes + 1);
}

/**
 * El barrido en negativo del corte de tiempo: ni banda roja, ni ninguna copia de fallo, en ninguna
 * parte de la página.
 *
 * Vive aquí y no copiado dentro de cada TC porque tiene que ser IDÉNTICO en las tres puertas de
 * entrada al seguimiento (red, tope propio, 409): si cada copia se queda corta por su lado, la que
 * se quede sin mirar el `role="alert"` dejará pasar justo la pantalla que enseña el aviso bueno y la
 * banda roja a la vez.
 */
async function sinFalloRojo(page: Page) {
  await expect(page.getByRole('alert'), 'no hay banda de error definitivo').toHaveCount(0);
  for (const copia of COPIAS_DE_FALLO) {
    await expect(page.getByText(copia, { exact: false }), `copia de fallo: ${copia}`).toHaveCount(0);
  }
}

/**
 * Deja pasar tiempo REAL suficiente para que un sondeo vivo se delate.
 *
 * Cuatro segundos: la cadencia normativa es de 2,5 s, así que un sondeo que siguiera en marcha
 * habría preguntado al menos una vez más. Es la única forma honesta de afirmar una AUSENCIA de
 * actividad —no hay evento al que engancharse cuando lo que se espera es que no pase nada— y por eso
 * se paga con segundos de reloj en los dos TCs que lo necesitan.
 */
async function pausaMasLargaQueElSondeo(page: Page) {
  await page.waitForTimeout(4_000);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · consola de sincronización (HU #11635)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El visor de Registros y los catálogos de Configuración no son el sujeto de esta HU, pero se
    // montan en cuanto un TC cambia de pestaña (TC54, TC55). Se les da una respuesta feliz por
    // defecto para que no sea un bloque vecino el que haga fallar un TC de sincronización.
    await mockLectura(page, API_REGISTROS, { status: 200, body: { items: [], nextCursor: null } });
    await mockLectura(page, API_NITS, { status: 200, body: NITS });
    await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
    await mockLectura(page, API_CAUSALES, { status: 200, body: CAUSALES });
    await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_CONFIGURADO });
    // Sin corridas: es el estado en el que la consola arranca en reposo. Un `page.route` registrado
    // después dentro de un TC gana sobre este, así que sigue siendo un DEFECTO, no una imposición.
    await mockRuns(page);
  });

  // ═══════════════════════════ AC1 · Disparo global exitoso ═══════════════════════════════════

  test.describe('AC1 · disparo y resultado', () => {
    // TC37 — el camino feliz completo, y el único TC que mira las seis cosas a la vez: lo que se
    // envía, lo que el botón dice mientras tanto, lo que se anuncia, el resumen, el detalle por
    // fuente y el aviso final. Es el TC que se rompe cuando alguien cambia el contrato del cuerpo.
    test('TC37: sincronizar todos los NIT activos manda un POST sin filtro y termina en resultado completo', async ({ page }) => {
      const runs = await mockRuns(page, { detalle: { [RUN_ID]: RESULTADO_COMPLETADA } });
      // RETENIDO, no `responder`: con la respuesta inmediata, el POST resolvía ENTRE las dos
      // aserciones del botón ocupado —`toBeDisabled()` pasaba y `aria-busy` fallaba— y el TC acusaba
      // a la pantalla de un atributo que sí puso, durante los milisegundos que duró. Reteniendo la
      // respuesta, el estado «ocupado» dura lo que el TC necesite mirarlo.
      const disparo = await mockDisparo(page, { tipo: 'retener' });

      await irASincronizacion(page);
      await expect(consola(page)).toBeVisible();
      // El alcance por defecto es el global: quien entra y pulsa sin tocar nada sincroniza todo.
      await expect(page.getByRole('radio', { name: 'Todos los NIT activos' })).toBeChecked();

      await botonSincronizar(page).click();

      // Mientras dura: el botón lo dice con TEXTO además de con el atributo. Quien no ve la pantalla
      // se entera por el nombre accesible, no por un `aria-busy` que ningún lector lee en voz alta
      // si el nombre no cambió.
      const ocupado = botonOcupado(page);
      await expect(ocupado).toBeDisabled();
      await expect(ocupado).toHaveAttribute('aria-busy', 'true');
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      disparo.soltar?.();

      // Lo enviado: un POST y solo uno, SIN la clave `nits`. Se afirma sobre la ausencia de la clave
      // y no sobre la igualdad con `{}` porque un POST pelado (cuerpo `null`) y un `{}` explícito
      // son los dos correctos para el backend, y un TC no debe elegir por él lo que no le importa.
      expect(disparo.cuerpos, 'un disparo, no dos').toHaveLength(1);
      expect(disparo.cuerpos[0] ?? {}, 'sin filtro = todos los activos').not.toHaveProperty('nits');

      // El resultado terminal: estado, modo y hora de Colombia. La fecha se afirma con un patrón
      // tolerante porque su forma exacta depende de la ICU del navegador («14 de ago de 2026» en
      // Chromium, «14 ago 2026» en Node): lo que el TC vigila es el DÍA y la HORA, que es lo que
      // cambiaría si alguien olvidara el `timeZone`.
      const panel = resultado(page);
      await expect(panel.getByText('Completada', { exact: true })).toBeVisible();
      await expect(panel).toContainText('modo real');
      await expect(panel.getByText(/14 .{0,7}ago.{0,4}2026, 15:04/)).toBeVisible();

      // El resumen, con las etiquetas del wireframe. «Nuevos» es `primeraLlegada` y «Reaparecidos»
      // es `reactivados`: los nombres del contrato no son los de la pantalla, y ese mapeo es
      // precisamente lo que se puede cruzar sin que nadie lo note.
      await expect(panel).toContainText('NITs procesados 12');
      await expect(panel).toContainText('Upserts 340');
      await expect(panel).toContainText('Nuevos 12');
      await expect(panel).toContainText('Inactivados 3');
      await expect(panel).toContainText('Reaparecidos 1');

      // El detalle por fuente, con su tabla nombrada (el `<caption class="sr-only">` de la spec de
      // a11y) y con «simit» etiquetado «SIMIT», que es como se llama para quien lo lee.
      const tabla = panel.getByRole('table', { name: /Detalle por fuente/i });
      await expect(tabla.getByRole('row')).toHaveCount(STEPS.length + 1);
      await expect(tabla.getByRole('row').nth(1)).toContainText('SIMIT');
      await expect(tabla.getByRole('row').nth(1)).toContainText(NIT_A);
      // Duración en formato local: coma decimal, no punto. Es el idioma del producto.
      await expect(tabla.getByRole('row').nth(1)).toContainText('1,2 s');

      // El desenlace se ANUNCIA con el copy del catálogo de UX, palabra por palabra. Ese catálogo lo
      // llamaba «toast» y la implementación lo publica en la región viva única (y el chip de la
      // tarjeta lo dice en pantalla): quien mira lee «Completada», quien usa lector oye la frase
      // entera y no hay dos sitios que mantener. Queda como desviación menor de copy en el HANDOFF.
      await expect(anuncio(page)).toContainText(COPY.toastCompletada);
      // Con la corrida ya en la mano no hace falta ir a buscarla: el POST síncrono devuelve los
      // `steps[]`. Una lectura del detalle aquí sería una petición que nadie pidió.
      expect(runs.llamadasDetalle, 'el POST ya trajo los pasos').toBe(0);
    });

    // TC38 — BORDE del contrato: el cuerpo con selección. `POST /sync` valida con `.strict()`, así
    // que `{ nit: '…' }` en singular —el error de dedo más fácil— no da un 400: da un cuerpo vacío
    // que dispara un sync GLOBAL. Es decir, el operador pide un NIT y se lleva el catálogo entero,
    // con su cuota del proveedor y sus minutos de espera. Por eso se afirma con igualdad exacta.
    test('TC38: con alcance «Solo estos NIT» el cuerpo lleva un array `nits` y el NIT no viaja en la URL', async ({ page }) => {
      const disparo = await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA });

      await irASincronizacion(page);
      await page.getByRole('radio', { name: 'Solo estos NIT' }).check();

      const seleccion = page.getByRole('group', { name: 'NIT activos a sincronizar' });
      // El inactivo NO se ofrece: ofrecerlo termina en un 400 `nits_filtro_invalido` que la pantalla
      // misma provocó, y ese es el peor error posible — el que el producto le tiende al usuario.
      await expect(seleccion.getByText(NIT_INACTIVO)).toHaveCount(0);
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_A) }).check();
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_B) }).check();

      await botonSincronizar(page).click();
      await expect(resultado(page)).toBeVisible();

      expect(disparo.cuerpos).toHaveLength(1);
      expect(disparo.cuerpos[0], 'array `nits`, nunca `nit` singular').toEqual({ nits: [NIT_A, NIT_B] });
      expect(disparo.cuerpos[0]).not.toHaveProperty('nit');

      // La regla del visor sigue en pie: `vista` es navegación y puede ir en la query; un NIT es un
      // documento de identidad cuando el monitoreado es persona natural y NO entra en la URL, que se
      // copia, se pega en un correo y se queda en el historial del navegador.
      expect(page.url()).not.toContain(NIT_A);
      expect(page.url()).not.toContain(NIT_B);
    });

    // TC39 — `partial` es el estado que más se malinterpreta: parece «casi bien» y significa que hay
    // NITs a los que NO se les inactivó nada aunque en la fuente parezcan ausentes (CF-10). Sin la
    // ayuda de cobertura, el operador lee los ceros de «Inactivados» como «no había nada que apagar».
    test('TC39: una corrida parcial se etiqueta Parcial y explica la cobertura incompleta', async ({ page }) => {
      await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_PARCIAL });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const panel = resultado(page);
      // La etiqueta va en el chip, con TEXTO: `partial` no puede distinguirse solo por el color del
      // tono `warning` (nota de contraste de la spec de a11y).
      await expect(panel.getByText('Parcial', { exact: true })).toBeVisible();
      await expect(panel.getByText(COPY.ayudaParcial)).toBeVisible();
      // Y el número, que es lo accionable: dos NIT se quedaron sin inactivar. Afirmar solo sobre el
      // «2» suelto —como hacía la versión de modo A— lo daba por bueno con cualquier 2 de la
      // pantalla, y esta tarjeta está llena de números.
      await expect(panel.getByText('2 NIT sin inactivación por cobertura incompleta.')).toBeVisible();
      await expect(anuncio(page)).toContainText(COPY.toastParcial);
      // Y el detalle señala la fuente culpable, que es lo accionable de un parcial.
      await expect(panel.getByRole('table', { name: /Detalle por fuente/i })).toContainText('BELLO');
    });

    // TC40 — la corrida fallida y, sobre todo, la fila con error: HTTP del PROVEEDOR, mensaje
    // persistido, y el guion donde no hubo lectura. La spec de a11y lo pide explícito: la fila con
    // error no se distingue solo por color, lleva la palabra.
    test('TC40: una corrida fallida muestra el paso con error legible, con su HTTP y su mensaje', async ({ page }) => {
      await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_FALLIDA });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const panel = resultado(page);
      await expect(panel.getByText('Fallida', { exact: true })).toBeVisible();
      await expect(anuncio(page)).toContainText(COPY.toastFallida);

      const fila = panel.getByRole('row').filter({ hasText: 'BELLO' });
      await expect(fila).toContainText('Error');
      await expect(fila).toContainText('504');
      await expect(fila).toContainText('El municipio no respondió a tiempo.');
      // `itemsLeidos: null` es «no se llegó a leer», no «cero comparendos». Un cero aquí sería una
      // afirmación sobre datos que nadie consultó.
      await expect(fila).toContainText('—');
      await expect(fila).toContainText('8,0 s');
    });

    // TC41 — BORDE de los avisos, los tres juntos. Son las tres advertencias que convierten un
    // resumen tranquilizador en uno que hay que mirar dos veces, y las tres se pintan solo «si
    // aplican», que es la condición que más fácilmente se implementa al revés (o no se implementa).
    test('TC41: corte por tiempo, inactivación omitida por umbral y modo simulado se avisan en el resumen', async ({ page }) => {
      await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_CON_AVISOS });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const panel = resultado(page);
      await expect(panel.getByText(COPY.ayudaTiempo)).toBeVisible();
      await expect(panel.getByText(COPY.ayudaUmbral)).toBeVisible();
      // El modo importa dentro de seis meses, mirando una corrida vieja con números raros: la
      // primera pregunta es si aquello fue una simulación.
      await expect(panel.getByText(COPY.modoMock)).toBeVisible();
    });
  });

  // ═════════════════════ AC2 · corte de tiempo y sync en curso → seguimiento ═══════════════════

  test.describe('AC2 · del corte de tiempo al seguimiento', () => {
    // TC42 — LA primera puerta: la petición muere en la red (que es lo que el navegador ve cuando el
    // proxy corta a los ~120 s). La corrida sigue viva en el servidor, así que decir «falló» es
    // decir una mentira comprobable. Y el sondeo tiene que arrancar YA, no al primer tic.
    test('TC42: si el POST muere en la red, la consola anuncia seguimiento y empieza a consultar el historial', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, { tipo: 'abortar', motivo: 'timedout' });

      await irASincronizacion(page);
      // La corrida NACE del disparo (ver `esperarConsolaEnReposo`): el listado está vacío hasta que
      // se pulsa, y en el instante del POST el servidor ya la tiene. Es el orden de producción.
      await esperarConsolaEnReposo(page);
      const lecturasAlMontar = runs.llamadasLista;
      runs.lista = [RUN_EN_CURSO];

      await botonSincronizar(page).click();

      await expect(anuncio(page)).toContainText(COPY.seguimiento);
      await sinFalloRojo(page);
      // El botón sigue ocupado: el trabajo no ha terminado, solo dejó de vérsele.
      await expect(botonOcupado(page)).toBeDisabled();
      await expect.poll(
        () => runs.llamadasLista,
        { message: 'la primera lectura del seguimiento es inmediata, no espera al primer tic' },
      ).toBeGreaterThan(lecturasAlMontar);
    });

    // TC43 — el tope de tiempo es del CLIENTE y tiene que ser SUYO, no el global.
    //
    // `lib/api.ts` aborta toda petición a los 90 s. El proxy corta a los 120. Si este POST se queda
    // con el tope global, el cliente se rinde 30 s antes de tiempo en una corrida que iba a terminar
    // bien —y como rendirse lleva a seguimiento, la pantalla se ve IGUAL: el fallo no se nota
    // mirando, solo contando el tiempo—. De ahí el requerimiento R1 (~110 s) y de ahí este TC.
    //
    // El reloj falso es imprescindible: nadie puede esperar 110 s dentro de un test de 30. Y por eso
    // R1 tiene que implementarse con `setTimeout` (como ya hace `request()`) y no con
    // `AbortSignal.timeout()`, que el reloj de Playwright no parchea.
    test('TC43: el POST aguanta más allá del tope global de 90 s y se rinde pasados ~110 s', async ({ page }) => {
      const runs = await mockRuns(page);
      const disparo = await mockDisparo(page, { tipo: 'retener' });

      // Quién abortó a quién: si el que muere es el cliente, el navegador reporta la petición como
      // fallida. Es la prueba directa, y el copy de la pantalla es la indirecta.
      const abortadas: string[] = [];
      page.on('requestfailed', (req) => {
        if (req.method() === 'POST' && req.url().includes('/comparendos/sync')) {
          abortadas.push(req.failure()?.errorText ?? 'sin motivo');
        }
      });

      // El reloj se instala antes de navegar a la vista: a partir de aquí el tiempo del navegador
      // solo avanza cuando este test lo diga.
      await page.clock.install({ time: new Date('2026-08-14T15:02:00-05:00') });
      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      await botonSincronizar(page).click();
      await expect(botonOcupado(page)).toBeVisible();

      // Noventa y cinco segundos: pasado el tope GLOBAL. Si nadie puso R1, aquí ya se habría rendido.
      await page.clock.runFor(95_000);
      await expect(botonOcupado(page), 'a los 95 s el POST sigue vivo').toBeVisible();
      await expect(page.getByText(COPY.seguimiento)).toHaveCount(0);
      expect(abortadas, 'el tope global de 90 s no debe abortar este POST').toHaveLength(0);

      // Ciento quince: pasado el tope propio. Ahora sí, y sin banda roja.
      const lecturasPrevias = runs.llamadasLista;
      // Mientras el cliente colgaba, el servidor arrancó la corrida: ya se ve en el historial.
      runs.lista = [RUN_EN_CURSO];
      await page.clock.runFor(20_000);
      await expect(anuncio(page)).toContainText(COPY.seguimiento);
      await sinFalloRojo(page);
      expect(abortadas, 'a los ~110 s se rinde el cliente').not.toHaveLength(0);
      await expect.poll(() => runs.llamadasLista).toBeGreaterThan(lecturasPrevias);

      // Se suelta la petición retenida para no dejar un manejador colgado al cerrar la página.
      disparo.soltar?.();
    });

    // TC44 — la segunda puerta, y la que separa a quien lee el contrato de quien lee el mensaje: el
    // 409 se ramifica por `codigo`. El cuerpo de este TC dice «Conflicto.» y NADA MÁS: cualquier
    // implementación que busque «en curso» en el texto se estrella aquí, que es justo lo que pasará
    // en producción el día que alguien mejore la redacción del backend.
    test('TC44: un 409 sync_en_curso con mensaje genérico entra a seguimiento, no a fallo', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, {
        tipo: 'responder', status: 409, body: { error: 'Conflicto.', codigo: 'sync_en_curso' },
      });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      const lecturasAlMontar = runs.llamadasLista;
      // Otra sesión lanzó la suya entre mi montaje y mi clic: es exactamente lo que produce el 409.
      runs.lista = [RUN_EN_CURSO];
      await botonSincronizar(page).click();

      await expect(anuncio(page)).toContainText(COPY.seguimiento);
      await sinFalloRojo(page);
      // Ni el eco del servidor: «Conflicto.» no le dice nada a nadie.
      await expect(page.getByText('Conflicto.', { exact: true })).toHaveCount(0);
      await expect.poll(() => runs.llamadasLista).toBeGreaterThan(lecturasAlMontar);
    });

    // TC45 — el ESPEJO de TC44, y sin él TC44 se puede aprobar haciendo trampa: un 409 cuyo TEXTO
    // habla de una sincronización en curso pero cuyo `codigo` es otro es un error definitivo de
    // verdad. Quien ramifique por texto pasa TC44 y falla aquí; quien ramifique por `codigo` pasa los
    // dos. Es el par el que prueba algo, no cada uno por separado.
    test('TC45: un 409 con otro `codigo` es error definitivo aunque su texto hable de sincronización en curso', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, {
        tipo: 'responder',
        status: 409,
        body: { error: 'Hay una sincronización en curso sobre otro recurso.', codigo: 'interno' },
      });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      const lecturasAlMontar = runs.llamadasLista;
      await botonSincronizar(page).click();

      await expect(consola(page).getByRole('alert')).toContainText(COPY.generico);
      await expect(page.getByText(COPY.seguimiento)).toHaveCount(0);
      // Y no se pone a sondear: sondear un error definitivo es preguntar por una corrida que no
      // existe, indefinidamente.
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'un error definitivo no abre seguimiento').toBe(lecturasAlMontar);
    });

    // TC46 — el seguimiento SALE. Es el fallo #3 del encabezado: entrar en «seguimos el progreso» es
    // la mitad fácil; llegar al resultado terminal es la que se queda a medias, y cuando se queda a
    // medias la pantalla no falla —se queda ahí, tranquila, para siempre—.
    //
    // Además fija que el detalle (`/sync/runs/:id`) se lee UNA vez, al detectar la transición, y no
    // en cada vuelta del sondeo: esa lectura deja registro de acceso a datos personales
    // (`pii_access_log`), así que pedirla 240 veces no es solo ruido, es un rastro falso.
    test('TC46: el seguimiento llega al resultado terminal y lee el detalle una sola vez', async ({ page }) => {
      const runs = await mockRuns(page, { detalle: { [RUN_ID]: RESULTADO_COMPLETADA } });
      await mockDisparo(page, {
        tipo: 'responder', status: 409, body: { error: 'Conflicto.', codigo: 'sync_en_curso' },
      });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      runs.lista = [RUN_EN_CURSO];
      await botonSincronizar(page).click();
      await expect(anuncio(page)).toContainText(COPY.seguimiento);

      // Dos vueltas con la corrida todavía en marcha, para que el TC no pase por accidente en la
      // primera lectura: el seguimiento tiene que SOSTENERSE, no acertar de refilón.
      await expect.poll(() => runs.llamadasLista).toBeGreaterThanOrEqual(2);
      await expect(botonOcupado(page)).toBeDisabled();

      // Y ahora el servidor termina.
      runs.lista = [RUN_COMPLETADA];

      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      await expect(resultado(page)).toContainText('Upserts 340');
      await expect(anuncio(page)).toContainText(COPY.toastCompletada);
      await expect(botonSincronizar(page)).toBeEnabled();

      expect(runs.idsPedidos, 'una lectura del detalle, y de la corrida correcta').toEqual([RUN_ID]);
    });

    // TC47 — la cadencia, y la DESVIACIÓN autorizada respecto de la spec de UX.
    //
    // Un sondeo cada 300 ms funciona igual de bien en un test y convierte una corrida de diez
    // minutos en dos mil peticiones autenticadas contra un endpoint que, además, escribe una fila de
    // `pii_access_log` cada vez. La spec de UX fija 2,5 s FIJOS durante los diez minutos: 240
    // peticiones por corrida, la mitad de la cuota de `apiLimiter` (500 por 15 min y **por IP**, que
    // detrás del NAT de la oficina es la de todo el edificio) y 240 filas de bitácora de acceso a
    // datos personales por cada corrida.
    //
    // La implementación escalona —2,5 s el primer minuto, 5 s hasta el quinto, 10 s hasta el tope— y
    // el Líder lo autorizó por ese coste. La versión de modo A de este TC decía «cada ~2,5 s» a
    // secas: con el escalonado, esa afirmación **deja de ser cierta pasado el primer minuto**, así
    // que el TC se parte en dos mitades que sí lo son. Los 2,5 s se conservan donde hay alguien
    // mirando la barra, que es el minuto inicial; después, nadie está pendiente de que el número
    // cambie al segundo.
    //
    // Queda anotado en el HANDOFF: la spec de UX (§ Lógica de polling, punto 1) hay que actualizarla,
    // porque hoy dice otra cosa que la que hace el producto.
    test('TC47: el sondeo va a 2,5 s el primer minuto y baja a 5 s después, ni martillea ni se duerme', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, {
        tipo: 'responder', status: 409, body: { error: 'Conflicto.', codigo: 'sync_en_curso' },
      });

      await page.clock.install({ time: new Date('2026-08-14T15:02:00-05:00') });
      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      runs.lista = [RUN_EN_CURSO];
      await botonSincronizar(page).click();
      await expect(anuncio(page)).toContainText(COPY.seguimiento);

      // Con la corrida ya enganchada, NADA puede pedirse sin que el reloj avance: el siguiente
      // sondeo es un `setTimeout` y el reloj está detenido. Por eso la medida de aquí es exacta.
      await expect(consola(page).getByRole('progressbar')).toBeVisible();
      const trasEngancharse = runs.llamadasLista;

      await page.clock.runFor(1_900);
      expect(runs.llamadasLista, 'nada de martillear por debajo de 2 s').toBe(trasEngancharse);
      await page.clock.runFor(1_300);
      await expect.poll(() => runs.llamadasLista).toBe(trasEngancharse + 1);

      // Segundo tramo. Once saltos de 5,5 s cruzan el primer minuto sin depender de en qué peldaño
      // esté la cadencia: 5,5 s es más que cualquiera de los dos, así que cada salto dispara uno y
      // solo uno.
      for (let i = 0; i < 11; i += 1) await avanzarUnSondeo(page, runs);

      const enElSegundoTramo = runs.llamadasLista;
      await page.clock.runFor(4_900);
      expect(runs.llamadasLista, 'pasado el primer minuto la cadencia baja a 5 s').toBe(enElSegundoTramo);
      await page.clock.runFor(600);
      await expect.poll(() => runs.llamadasLista).toBe(enElSegundoTramo + 1);
    });

    // TC48 — el sondeo PARA cuando la corrida termina. La fuga clásica: el `setInterval` que nadie
    // limpia porque el estado que lo gobernaba ya cambió y «visualmente todo está bien».
    test('TC48: al llegar el resultado terminal, el sondeo deja de preguntar', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_EN_CURSO],
        detalle: { [RUN_ID]: RESULTADO_COMPLETADA },
      });

      // Se entra por AC4 (corrida ya en marcha al abrir), que llega al mismo sitio con menos pasos.
      await irASincronizacion(page);
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect.poll(() => runs.llamadasLista).toBeGreaterThanOrEqual(1);

      runs.lista = [RUN_COMPLETADA];
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();

      // Un segundo de asiento antes de tomar la medida: al cerrar la corrida la vista refresca el
      // historial (Región B, HU #11636) y esa lectura legítima entra en el mismo contador. Lo que
      // este TC persigue es la actividad SOSTENIDA, no el último coletazo.
      await page.waitForTimeout(1_000);
      const congelado = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'la corrida terminó: no hay nada que preguntar').toBe(congelado);
    });

    // TC49 — el sondeo PARA al abandonar la vista. Se cambia de pestaña (no se recarga): una recarga
    // dura mataría el temporizador sola y el TC no probaría nada. Así es como se ve la fuga en
    // producción: el operador se va a Configuración y la pestaña sigue preguntando por una corrida
    // que ya no está mirando, hasta que cierre el navegador.
    test('TC49: al salir de la pestaña Sincronización el sondeo se desmonta con ella', async ({ page }) => {
      const runs = await mockRuns(page, { lista: [RUN_EN_CURSO] });

      await irASincronizacion(page);
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect.poll(() => runs.llamadasLista).toBeGreaterThanOrEqual(1);

      await page.getByRole('tab', { name: 'Configuración' }).click();
      await expect(page).toHaveURL(/[?&]vista=configuracion\b/);
      await expect(page.getByRole('region', { name: /NIT.? monitoreados/i })).toBeVisible();

      const congelado = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'nadie sondea desde una vista desmontada').toBe(congelado);
    });

    // TC50 — BORDE de ahorro: con la pestaña del navegador oculta, el sondeo se pausa; al volver,
    // pregunta al INSTANTE en vez de esperar su turno. Lo segundo importa tanto como lo primero:
    // volver a una pantalla y encontrarla desactualizada durante dos segundos y medio es
    // exactamente el momento en que el operador vuelve a pulsar.
    //
    // Se falsean las dos ortografías (`visibilityState` y `hidden`) porque las dos se usan y el TC no
    // debe elegir por la implementación cuál mirar.
    test('TC50: con la pestaña oculta el sondeo se pausa, y al volver consulta de inmediato', async ({ page }) => {
      const runs = await mockRuns(page, { lista: [RUN_EN_CURSO] });

      await irASincronizacion(page);
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect.poll(() => runs.llamadasLista).toBeGreaterThanOrEqual(1);

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      const enPausa = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'oculta = en pausa').toBe(enPausa);

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(
        () => runs.llamadasLista,
        { message: 'al volver se consulta ya, no en el próximo tic', timeout: 2_000 },
      ).toBeGreaterThan(enPausa);
    });

    // TC51 — BORDE del tope de espera: diez minutos. Sin tope, una corrida que muere sin cerrarse
    // (el servidor se reinicia y la fila se queda en `running` para siempre) deja una pestaña
    // preguntando indefinidamente. El copy tiene que devolverle el control al operador: la corrida
    // sigue allá, mírala en el historial.
    test('TC51: pasados diez minutos en curso, el sondeo se rinde y lo dice sin fingir un fallo', async ({ page }) => {
      const runs = await mockRuns(page, { lista: [RUN_EN_CURSO] });

      await page.clock.install({ time: new Date('2026-08-14T15:02:00-05:00') });
      await irASincronizacion(page);
      await expect(anuncio(page)).toContainText(COPY.enCurso);

      // El tope se mide en TIEMPO transcurrido, no en número de vueltas: se salta el bloque entero y
      // luego se dan dos tics para que el temporizador vuelva a leer el reloj.
      await page.clock.fastForward(10 * 60 * 1_000);
      await page.clock.runFor(3_000);
      await page.clock.runFor(3_000);

      await expect(consola(page).getByText(COPY.topeEspera)).toBeVisible();
      // Rendirse no es fallar: la corrida sigue viva y decir «falló» sería mentir otra vez.
      await sinFalloRojo(page);

      const congelado = runs.llamadasLista;
      await page.clock.fastForward(60_000);
      await page.waitForTimeout(300);
      expect(runs.llamadasLista, 'rendirse es dejar de preguntar').toBe(congelado);
    });

    // TC52 — el fallo #1 del encabezado, visto desde el otro lado: durante el seguimiento NO se
    // puede volver a disparar. Es la protección real contra el bucle que arruina la experiencia —el
    // operador cree que no pasó nada, vuelve a pulsar, se lleva un 409, y ahora tiene dos mensajes y
    // ninguna certeza—. Ofrecer un botón vivo mientras se sigue una corrida es invitarle a eso.
    test('TC52: mientras se sigue la corrida no se puede disparar otra vez', async ({ page }) => {
      const runs = await mockRuns(page);
      const disparo = await mockDisparo(page, { tipo: 'abortar', motivo: 'timedout' });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      runs.lista = [RUN_EN_CURSO];
      await botonSincronizar(page).click();
      await expect(anuncio(page)).toContainText(COPY.seguimiento);

      const ocupado = botonOcupado(page);
      await expect(ocupado).toBeDisabled();
      await expect(ocupado).toHaveAttribute('aria-busy', 'true');
      // Y no hay una segunda puerta: ni «Sincronizar» ni «Sincronizar de nuevo» mientras se sigue.
      await expect(botonSincronizar(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Sincronizar de nuevo' })).toHaveCount(0);

      await pausaMasLargaQueElSondeo(page);
      expect(disparo.cuerpos, 'un solo disparo mientras dure el seguimiento').toHaveLength(1);
      expect(runs.llamadasLista, 'el seguimiento sí sigue vivo').toBeGreaterThan(1);
    });

    // TC53 — el caso torcido, y el que la spec resuelve en una nota que es fácil no leer: el cliente
    // aborta a los 110 s, pero el servidor TERMINÓ a los 112. Cuando el sondeo va a mirar ya no hay
    // nada `running`, así que un seguimiento ingenuo se queda esperando una corrida en curso que no
    // volverá a existir — y la pantalla se congela en «seguimos el progreso» con el resultado ahí
    // mismo, en la primera fila del listado.
    //
    // El montaje cambió en el gate B, y el cambio ES el caso. En la versión de modo A la corrida
    // terminal ya estaba en el listado AL MONTAR, y eso no describe «la mía terminó justo después
    // del corte»: describe «había una corrida terminal de antes», que es justo la que la pantalla NO
    // debe adoptar como propia (TC63). Aquí aparece DESPUÉS del disparo, que es el único orden en el
    // que puede ser la que creó mi POST.
    test('TC53: si la corrida terminó justo tras el abort, el seguimiento muestra ese resultado terminal', async ({ page }) => {
      const runs = await mockRuns(page, { detalle: { [RUN_ID]: RESULTADO_COMPLETADA } });
      await mockDisparo(page, { tipo: 'abortar', motivo: 'timedout' });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      await botonSincronizar(page).click();

      // El POST ya colgó y el listado todavía no la enseña: es el hueco real entre el abort del
      // cliente y el cierre de la corrida en el servidor. La consola busca, no se rinde a la primera.
      await expect(anuncio(page)).toContainText(COPY.seguimiento);
      runs.lista = [RUN_COMPLETADA];

      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      await expect(resultado(page)).toContainText('Upserts 340');
      await sinFalloRojo(page);
      expect(runs.idsPedidos, 'se lee el detalle de la corrida recién cerrada').toEqual([RUN_ID]);
      await expect(botonSincronizar(page)).toBeEnabled();
    });

    // TC63 — el ESPEJO de TC53, y nace de este gate: es la pregunta que el modo A no había hecho.
    //
    // La regla de la spec de UX («si al pollar no hay `running`, mirar la corrida más reciente y, si
    // está terminal, mostrar ese resultado») está pensada para un hueco de dos minutos, pero tomada
    // al pie de la letra adopta como propia CUALQUIER corrida terminal que haya en el listado: la de
    // otro operador, o la de ayer. Y la spec propone anclarla por tiempo —comparar el `iniciadoEn`
    // del servidor con el reloj del portátil—, que se rompe en silencio con cualquier desfase de
    // husos y se rompe hacia el lado malo.
    //
    // La implementación lo resuelve mejor: congela los `runId` conocidos justo ANTES del POST y solo
    // adopta lo que no estaba. Una corrida que ya se veía al montar no puede ser la que creó mi
    // petición, y ante la duda dice «no lo pudimos confirmar» en vez de enseñar el éxito de otro como
    // si fuera el mío. Este TC clava esa decisión, porque el fallo que evita es el peor de todos: el
    // operador se va tranquilo con el resultado de una corrida que no lanzó.
    test('TC63: una corrida terminal que ya existía al montar NO se adopta como resultado del disparo', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_COMPLETADA],
        detalle: { [RUN_ID]: RESULTADO_COMPLETADA },
      });
      await mockDisparo(page, { tipo: 'abortar', motivo: 'timedout' });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      await botonSincronizar(page).click();

      // Se busca la corrida varias veces, espaciadas, y al no aparecer ninguna nueva se admite la
      // ignorancia. No es un error y no se pinta como tal: la corrida pudo salir bien y el historial
      // la tendrá.
      await expect(consola(page).getByText(COPY.topeEspera)).toBeVisible({ timeout: 20_000 });
      await expect(resultado(page), 'ni un resultado ajeno colado como propio').toHaveCount(0);
      await sinFalloRojo(page);
      expect(runs.idsPedidos, 'ni se pide el detalle de una corrida que no es mía').toEqual([]);
    });
  });

  // ══════════════════════════════ AC3 · errores accionables ═══════════════════════════════════

  test.describe('AC3 · errores que llevan a alguna parte', () => {
    // TC54 — sin NITs no hay nada que consultar, y el operador no tiene por qué saber dónde se
    // arregla eso. El TC PULSA el enlace: comprobar que el botón existe es comprobar la mitad que no
    // se rompe nunca.
    test('TC54: sin NIT activos, el error explica y su enlace lleva a Configuración', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, {
        tipo: 'responder',
        status: 400,
        body: { error: 'No hay NITs activos en el catálogo.', codigo: 'sin_nits_activos' },
      });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      const lecturasAlMontar = runs.llamadasLista;
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.sinNits);
      // Sin eco del servidor: el copy de la pantalla lo escribe UX, no el backend (decisión #11559).
      await expect(page.getByText('No hay NITs activos en el catálogo.')).toHaveCount(0);
      expect(runs.llamadasLista, 'un 400 es definitivo: no abre seguimiento').toBe(lecturasAlMontar);

      await banda.getByRole('button', { name: 'Ir a Configuración' }).click();
      await expect(page).toHaveURL(/[?&]vista=configuracion\b/);
      await expect(page.getByRole('region', { name: /NIT.? monitoreados/i })).toBeVisible();
      // CONTROL de TC55: este enlace lleva a Configuración y NADA MÁS —deja al operador arriba, en
      // el primer bloque—. Sin esta aserción, el `toBeInViewport()` del TC del token podría estar
      // pasando solo porque la pantalla cabe entera, y entonces no probaría el desplazamiento que el
      // AC3 pide. Aquí el bloque 4 tiene que quedar FUERA de la vista para que allí signifique algo.
      await expect(bloqueToken(page), 'el token es el bloque 4: sin ancla, queda bajo el pliegue')
        .not.toBeInViewport();
    });

    // TC55 — el token falta y el enlace no lleva «a Configuración» a secas: lleva AL BLOQUE. La
    // pantalla de configuración tiene cuatro tarjetas y el token es la última; dejar al operador
    // arriba del todo con un «búscalo tú» es la clase de detalle que convierte un error accionable en
    // uno decorativo. Se afirma con `toBeInViewport`, que es lo que el operador experimenta.
    test('TC55: sin token, el enlace deja el bloque Token SIMIT a la vista', async ({ page }) => {
      await mockDisparo(page, {
        tipo: 'responder',
        status: 503,
        body: { error: 'Token SIMIT no configurado.', codigo: 'token_no_configurado' },
      });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.tokenFalta);
      await banda.getByRole('button', { name: 'Ir al token' }).click();

      await expect(page).toHaveURL(/[?&]vista=configuracion\b/);
      await expect(bloqueToken(page)).toBeVisible();
      await expect(bloqueToken(page), 'el bloque queda a la vista, no arriba del todo').toBeInViewport();
    });

    // TC56 — `nits_filtro_invalido`: el mensaje del backend viene con jerga de validación y no se
    // pinta. Lo que el operador necesita saber es CUÁLES de los NIT que él mismo acaba de elegir no
    // sirven, y esos los tiene la pantalla sin preguntarle a nadie.
    test('TC56: un filtro de NIT inválido nombra los NIT elegidos, sin eco de la jerga del servidor', async ({ page }) => {
      await mockDisparo(page, {
        tipo: 'responder',
        status: 400,
        body: {
          error: `nits inválidos: ${NIT_A}, ${NIT_B} (validación zod: array/max)`,
          codigo: 'nits_filtro_invalido',
        },
      });

      await irASincronizacion(page);
      await page.getByRole('radio', { name: 'Solo estos NIT' }).check();
      const seleccion = page.getByRole('group', { name: 'NIT activos a sincronizar' });
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_A) }).check();
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_B) }).check();
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.filtroInvalido);
      await expect(banda).toContainText(NIT_A);
      await expect(banda).toContainText(NIT_B);
      await expect(page.getByText(/validación zod/)).toHaveCount(0);
      // La selección se conserva: el error es sobre ella y borrarla obligaría a rehacer el trabajo.
      await expect(seleccion.getByRole('checkbox', { name: new RegExp(NIT_A) })).toBeChecked();
    });

    // TC57 — modo simulado en un ambiente productivo: el único error que NO ofrece reintentar. No es
    // un olvido, es la decisión: reintentar no lo arregla y un botón de reintento invita a insistir
    // hasta que «funcione», que aquí significaría escribir datos inventados en producción.
    test('TC57: el modo simulado en producción se explica y no ofrece reintento ciego', async ({ page }) => {
      await mockDisparo(page, {
        tipo: 'responder',
        status: 503,
        body: {
          error: 'COMPARENDOS_SIMIT_MODE=mock con NODE_ENV=production',
          codigo: 'modo_simulado_en_produccion',
        },
      });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.modoSimulado);
      await expect(banda.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
      // Ni el nombre de la variable de entorno en pantalla: eso es para quien opera el ambiente, y
      // se entera por el mensaje que le llega, no por la pantalla del operador.
      await expect(page.getByText(/COMPARENDOS_SIMIT_MODE/)).toHaveCount(0);
    });

    // TC58 — el limitador: aquí el reintento SÍ tiene sentido (pasado el minuto), y el TC comprueba
    // que el botón realmente vuelve a disparar en vez de solo limpiar el mensaje. Un «Reintentar»
    // que no reintenta es la peor versión de este control.
    test('TC58: un 429 pide esperar un minuto y su Reintentar vuelve a disparar de verdad', async ({ page }) => {
      const disparo = await mockDisparo(page, {
        tipo: 'responder',
        status: 429,
        body: { error: 'Demasiadas sincronizaciones', codigo: 'demasiadas_peticiones' },
      });

      await irASincronizacion(page);
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.limitador);

      disparo.plan = { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA };
      await banda.getByRole('button', { name: 'Reintentar' }).click();

      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      expect(disparo.cuerpos, 'el reintento es un disparo nuevo').toHaveLength(2);
      await expect(consola(page).getByRole('alert')).toHaveCount(0);
    });

    // TC59 — el 5xx sin código conocido. Es el cajón de sastre, y por eso el TC vigila que el cajón
    // no se lleve por delante la mitad de arriba: un 500 no es un corte de tiempo y aquí SÍ toca
    // decir que no se pudo iniciar.
    test('TC59: un 500 sin código dice que no se pudo iniciar y ofrece reintentar', async ({ page }) => {
      const runs = await mockRuns(page);
      await mockDisparo(page, { tipo: 'responder', status: 500, body: { error: 'boom' } });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      const lecturasAlMontar = runs.llamadasLista;
      await botonSincronizar(page).click();

      const banda = consola(page).getByRole('alert');
      await expect(banda).toContainText(COPY.generico);
      await expect(banda.getByRole('button', { name: 'Reintentar' })).toBeVisible();
      await expect(page.getByText('boom')).toHaveCount(0);
      await expect(page.getByText(COPY.seguimiento)).toHaveCount(0);
      expect(runs.llamadasLista, 'un 500 no es un corte de tiempo').toBe(lecturasAlMontar);
    });
  });

  // ═══════════════════════ AC4 · entrar con una corrida ya en curso ═══════════════════════════

  test.describe('AC4 · al abrir la vista', () => {
    // TC60 — entrar y encontrarse el trabajo hecho a medias. Sin esto, quien vuelve a la pestaña
    // mientras una corrida va por la mitad ve un formulario en reposo, pulsa, y se lleva el 409 —el
    // mismo bucle del fallo #1, pero por la puerta de atrás—.
    test('TC60: si al abrir hay una corrida en curso, la consola entra en seguimiento sola', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_EN_CURSO],
        detalle: { [RUN_ID]: RESULTADO_COMPLETADA },
      });
      const disparo = await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA });

      await irASincronizacion(page);

      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect(botonOcupado(page)).toBeDisabled();
      // El contexto de la corrida ajena: cuándo empezó (en hora de Colombia) y sobre cuántos NIT va.
      await expect(consola(page)).toContainText('15:02');
      await expect(consola(page)).toContainText(`${ALCANCE.length} NIT`);
      // Y nadie disparó nada: el seguimiento no es un disparo disfrazado.
      expect(disparo.cuerpos, 'entrar a mirar no lanza una corrida').toHaveLength(0);

      runs.lista = [RUN_COMPLETADA];
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      expect(disparo.cuerpos).toHaveLength(0);
    });

    // TC61 — el espejo de TC60: con la última corrida ya terminada NO se entra en seguimiento. Un
    // seguimiento espurio deja el botón inhabilitado sin motivo y a un operador que no puede
    // sincronizar mirando una pantalla que dice que algo está pasando.
    test('TC61: si la última corrida ya terminó, la consola abre en reposo y no sondea', async ({ page }) => {
      const runs = await mockRuns(page, { lista: [RUN_COMPLETADA] });

      await irASincronizacion(page);
      await expect(botonSincronizar(page)).toBeEnabled();
      await expect(page.getByText(COPY.enCurso)).toHaveCount(0);
      await expect(page.getByText(COPY.seguimiento)).toHaveCount(0);

      const trasElMontaje = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'sin corrida viva no hay nada que sondear').toBe(trasElMontaje);
    });
  });

  // ═════════════════════════════════ Accesibilidad transversal ════════════════════════════════

  test.describe('A11y de la consola', () => {
    // TC62 — la región viva, que es por donde se entera de todo esto quien no ve la pantalla.
    //
    // Tres cosas, y las tres se rompen por separado:
    //   · UNA sola región. Con dos, el lector anuncia el mismo cambio dos veces o —peor— anuncia una
    //     y calla la otra según el orden del DOM.
    //   · POLITE, no assertive: el progreso de una corrida de dos minutos no puede interrumpir lo que
    //     el operador esté haciendo. `role="alert"` está reservado para el error definitivo, y usarlo
    //     para el progreso es gritar cada 2,5 s.
    //   · La barra sin porcentaje. El API no da progreso; un `aria-valuenow` inventado le diría a un
    //     lector de pantalla un número que no significa nada.
    test('TC62: hay una sola región viva, es polite, y la barra no inventa porcentaje', async ({ page }) => {
      await mockRuns(page, { lista: [RUN_EN_CURSO] });

      await irASincronizacion(page);
      await expect(anuncio(page)).toHaveCount(1);
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect(anuncio(page)).not.toHaveAttribute('aria-live', 'assertive');
      // El progreso no es una alerta: mientras la corrida va, no hay ninguna.
      await expect(page.getByRole('alert')).toHaveCount(0);

      const barra = consola(page).getByRole('progressbar');
      await expect(barra).toBeVisible();
      await expect(barra).not.toHaveAttribute('aria-valuenow', /.+/);
    });
  });

  // ═════════════════════ Lo que la sincronización deja en el navegador ════════════════════════

  test.describe('PII de la consola', () => {
    // TC64 — sale de la auditoría de seguridad de la HU. Hoy la pantalla NO persiste nada: el
    // alcance vive en estado de React y muere con el desmontaje. Este TC no descubre un fallo:
    // **fija un acierto**, que es lo único que impide que se pierda.
    //
    // El cambio que lo rompería no vendrá con mala intención, y ese es el problema: «recuerda la
    // última selección» es una mejora de usabilidad razonable, se escribe en cuatro líneas y mete
    // NIT —cuasi-PII, AGENTS.md §14— en un almacén que sobrevive a la recarga, al cierre del
    // navegador y a que el operador cambie de turno en el mismo equipo. Nadie lo notaría: la
    // pantalla se vería mejor.
    //
    // Dos cosas hacen que este verde signifique algo, y las dos son deliberadas:
    //
    //   1. **El alcance fue una selección EXPLÍCITA**, no el disparo global. Con «todos los NIT
    //      activos» no hay lista que guardar y el TC pasaría solo, sin haber comprobado nada. Por eso
    //      se afirma sobre el cuerpo enviado ANTES de mirar el almacenamiento: si ese cuerpo no
    //      llevara `nits`, el resto del TC sería teatro.
    //   2. **Se mira el contenido SERIALIZADO de los dos almacenes**, no una clave. Ver
    //      `almacenamiento()`.
    //
    // Y se comprueba dos veces: recién terminada la corrida, y otra vez tras ABANDONAR la vista. El
    // desmontaje es la puerta más silenciosa —un `useEffect` de limpieza que «guarda para restaurar
    // al volver» no se ve en ninguna pantalla— y es justo donde hoy el hook decide, a propósito, no
    // guardar nada.
    //
    // La URL no se comprueba aquí porque ya la vigila TC38, que es donde se elige el alcance.
    test('TC64: el alcance elegido no queda en localStorage ni en sessionStorage', async ({ page }) => {
      const disparo = await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA });

      await irASincronizacion(page);
      await esperarConsolaEnReposo(page);
      await page.getByRole('radio', { name: 'Solo estos NIT' }).check();
      const seleccion = page.getByRole('group', { name: 'NIT activos a sincronizar' });
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_A) }).check();
      await seleccion.getByRole('checkbox', { name: new RegExp(NIT_B) }).check();

      await botonSincronizar(page).click();
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();

      // Hubo alcance que persistir. Sin esta línea, el barrido de abajo no probaría nada.
      expect(disparo.cuerpos[0], 'la corrida llevó una selección explícita de NIT')
        .toEqual({ nits: [NIT_A, NIT_B] });

      // La aguja es el NIT COMPLETO y no un prefijo —al revés que con el token, donde cualquier
      // fragmento ya es una fuga—: aquí el dato que identifica es el número entero, y un trozo de
      // siete dígitos empezaría a chocar con marcas de tiempo y con ids de cualquier otra clave,
      // convirtiendo el guardián en una fuente de falsos rojos.
      const trasLaCorrida = await almacenamiento(page);
      expect(trasLaCorrida, 'localStorage / sessionStorage tras la corrida').not.toContain(NIT_A);
      expect(trasLaCorrida, 'localStorage / sessionStorage tras la corrida').not.toContain(NIT_B);

      // Y al salir de la vista, que es cuando un «me lo guardo para cuando vuelva» escribiría.
      await page.getByRole('tab', { name: 'Configuración' }).click();
      await expect(page.getByRole('region', { name: /NIT.? monitoreados/i })).toBeVisible();

      const trasSalir = await almacenamiento(page);
      expect(trasSalir, 'localStorage / sessionStorage tras abandonar la vista').not.toContain(NIT_A);
      expect(trasSalir, 'localStorage / sessionStorage tras abandonar la vista').not.toContain(NIT_B);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// REGIÓN B — HISTORIAL DE CORRIDAS Y DETALLE DE PASOS (HU #11636)
//
// Todo lo que sigue —fixtures, localizadores y TC65–TC80— es de la #11636 y está DORMIDO hasta que
// la pantalla exista. Ver la «Guardia de cobertura» de la cabecera.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// QUÉ PERSIGUE ESTE BLOQUE (y por qué el historial tampoco es «una tabla más»)
//
//   1. **Una regla de PII escondida en una frase de UI.** El AC1 dice «la fila no lista todos los
//      NIT del alcance», y eso no es una preferencia de maquetación: el alcance de una corrida son
//      NIT, y un NIT de persona natural es un documento de identidad (lo dice el COMMENT de la
//      migración 0150 y lo repite AGENTS.md §14). Una tabla que los desgrana los pone en la
//      pantalla, en las capturas de soporte y en cualquier exportación que se añada después. TC66 lo
//      fija por el lado que se rompe solo: con una corrida de alcance amplio, la fila enseña el
//      CONTEO y **ninguno** de los doce NIT, y se comprueba sobre el HTML de la fila —no sobre su
//      texto visible—, porque el `title` de un tooltip «para que se vean al pasar el ratón» es
//      exactamente la mejora bienintencionada que este TC existe para impedir.
//   2. **Tres obligaciones de la enmienda de UX del 20 ago 2026 que no se ven mirando la pantalla.**
//      · El historial **no sondea** (TC78): se refresca UNA vez cuando la consola publica el
//        desenlace, y punto. Un sondeo propio duplicaría lo que la decisión 13 acaba de recortar:
//        cuota del limitador —500 peticiones / 15 min por IP de oficina— y filas de
//        `pii_access_log`, que es el registro que existe para poder auditar quién miró qué.
//      · La primera fila es **superficie de desenlace** (TC79), no archivo: al descartarse el toast,
//        es donde queda el resultado si el operador estaba mirando hacia abajo cuando terminó la
//        corrida. Y tiene que traer el chip correcto EN ESE MOMENTO, no un estado viejo que se
//        corrige cuando vuelva la red.
//      · Ni la lista ni el modal montan **región viva propia** (TC80). Es la obligación que más
//        fácil se incumple sin querer, y no por descuido sino por buen oficio: el esqueleto de carga
//        canónico del módulo —`EsqueletoBloque`, en `bloqueConfigComparendos.tsx`— lleva
//        `role="status"`, y reutilizarlo aquí (o copiar el patrón de `PanelDetalleComparendo`, que
//        hace lo mismo) mete una segunda región viva en la vista sin que nadie escriba «aria-live».
//   3. **«Sin inventar nombres» (AC2).** `iniciadoPor` es un id y se pinta «Usuario N» o guion. TC71
//      lo fija Y comprueba que no se haya ido a buscar el nombre a `/api/users`: ese endpoint no es
//      solo una petición de más, es traer datos de personas a una pantalla que no los necesitaba.
//   4. **El aislamiento del AC3.** Un 500 del historial no puede llevarse por delante la consola de
//      arriba (TC76). Es el mismo caso que el TC17 del visor —un 500 de municipios que no tumba la
//      tabla de NITs— y salió valioso allí por la misma razón: las dos zonas comparten pantalla y
//      no comparten destino.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// LO QUE ESTE BLOQUE DA POR NORMATIVO (marcado que el frontend tiene que respetar)
//
// Igual que en la Región A: los selectores son contrato, salen del copy literal de la spec de UX y
// se afirman por rol y por texto visible. Lo específico del historial:
//
//   · Historial → `role="region"` con nombre «Historial de sincronizaciones» (el `<h2>` de la
//     tarjeta), y DENTRO una `<table>` con su `<caption class="sr-only">`. La tabla se monta SIN el
//     prop `label` de `FlitTable`: ese prop añade un `role="region"` propio al contenedor con scroll
//     y dejaría dos landmarks con el mismo nombre a un palmo.
//   · Botón por fila → nombre accesible que empiece por «Ver detalle» y que sea **distinto en cada
//     fila** (TC74). Cuatro botones llamados «Ver» son cuatro controles indistinguibles para quien
//     navega por lista de botones; el instante de la corrida es lo que los separa.
//   · Modal → `FlitModal wide`, título «Corrida · <instante completo>», y `restoreFocusRef` al botón
//     que lo abrió. El detalle se lee UNA vez al abrir.
//   · Cargando → `aria-busy="true"` en la zona (la región del historial, o el diálogo), y **nada**
//     con `role="status"`. Es la desviación deliberada respecto de `EsqueletoBloque`, y el motivo
//     está arriba.
//   · Error de carga → el copy del catálogo, visible dentro de la tarjeta, + botón «Reintentar».
//     **Sin `role="alert"`**, al revés que `BloqueConfig` y que el visor: una alerta es una región
//     viva assertive, y en esta vista la spec de a11y la reserva al error definitivo del disparo
//     («es la única excepción»). Que no se pueda leer el archivo de ayer no justifica interrumpir a
//     quien mira la corrida de ahora. Es la misma razón por la que el esqueleto no lleva
//     `role="status"`: en esta vista, y solo en esta, el módulo se desvía de su propio patrón.
//   · «Iniciada por» y su valor, LEGIBLES COMO PAREJA —da igual si en una ficha `<dl>` o en una
//     línea corrida—: el guion de una corrida sin iniciador no puede quedar suelto en mitad de la
//     ficha, que es el dato que hay que poder leer sin adivinar de qué es.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// DOS AMBIGÜEDADES DE COPY QUE ESTE BLOQUE RESUELVE (y que van al HANDOFF)
//
//   1. **«modo mock» del wireframe → «modo simulado».** La fila de ejemplo del wireframe escribe
//      «modo mock · 0 upserts», pero el catálogo corto —índice canónico— dice «Modo simulado» y la
//      regla de tono del documento prohíbe anglicismos en copy de usuario. Manda el catálogo. TC68
//      lo afirma en las dos direcciones: que diga «simulado» y que NO diga «mock».
//   2. **El copy del error del DETALLE no existe en la spec.** La spec da el de la lista («No se
//      pudo cargar el historial de sincronizaciones.») y para el modal solo dice «error +
//      reintentar». Se redacta aquí en paralelo —«No se pudo cargar el detalle de la corrida.»— y
//      queda anotado como desviación menor: si UX prefiere otra, se cambia en `COPY_HIST` y TC73 lo
//      delata.
//
// El «resumen rápido» de la fila se afirma por SEMÁNTICA y no palabra por palabra (número + la
// palabra clave), al revés que el resto del copy de este archivo. Es deliberado: la spec lo dibuja
// en un wireframe con abreviaturas («3 inact.», «2 err mun.») y no lo fija en el catálogo, así que
// clavar una redacción sería inventar contrato. Lo que sí se afirma es que la celda no miente: que
// no hay números donde no hubo resumen, y que el modo simulado se dice.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * El alcance amplio: doce NIT SINTÉTICOS, ninguno de una empresa real (Ley 1581).
 *
 * Doce y no dos porque el fallo que persigue TC66 solo se ve con una lista que a nadie se le
 * ocurriría volcar en una celda... que es exactamente lo que pasa cuando el alcance son dos y
 * alguien decide que «así se ve mejor». El TC tiene que fallar con la implementación descuidada
 * ANTES de que el catálogo del cliente crezca, no después.
 */
const ALCANCE_AMPLIO = [
  NIT_A, NIT_B, '900222333', '830115577', '900334455', '901009988',
  '830447722', '900556677', '901112233', '830778899', '900889900', '901223344',
];

/** Ids sin año dentro: así «la fila no enseña el año» (TC65) se puede afirmar sobre el texto entero. */
const H_COMPLETADA = 'run-hist-uno';
const H_PARCIAL = 'run-hist-dos';
const H_FALLIDA = 'run-hist-tres';
const H_SIMULADA = 'run-hist-cuatro';
const H_VIVA = 'run-hist-viva';

const RESUMEN_HIST_PARCIAL = { ...RESUMEN_PARCIAL, upserts: 120 };
const RESUMEN_HIST_SIMULADO = {
  ...RESUMEN_COMPLETADA, modo: 'mock', upserts: 0, inactivados: 0, primeraLlegada: 0, reactivados: 0,
};

/**
 * Las cuatro corridas del wireframe, con sus horas de Bogotá calculadas a mano:
 *
 *   20:02Z → 14 ago 15:02 · 08:07Z → 14 ago 03:07 · 23:40Z → 13 ago 18:40 · 08:05Z → 13 ago 03:05
 *
 * Dos son del mismo día y dos de días distintos a propósito: es lo que hace que la columna «Inicio»
 * con fecha corta tenga sentido y lo que delataría un `timeZone` olvidado (en UTC, la tercera
 * saltaría al día 14).
 */
const RUN_HIST_COMPLETADA = {
  runId: H_COMPLETADA,
  estado: 'completed',
  iniciadoEn: '2026-08-14T20:02:00Z',
  finalizadoEn: '2026-08-14T20:04:00Z',
  scopeNits: ALCANCE_AMPLIO,
  resumen: RESUMEN_COMPLETADA,
  iniciadoPor: 7,
};
const RUN_HIST_PARCIAL = {
  ...RUN_HIST_COMPLETADA,
  runId: H_PARCIAL,
  estado: 'partial',
  iniciadoEn: '2026-08-14T08:07:00Z',
  finalizadoEn: '2026-08-14T08:12:00Z',
  resumen: RESUMEN_HIST_PARCIAL,
};
/**
 * La fallida, y la más informativa de las cuatro: alcance de UN solo NIT (el singular de TC67),
 * `resumen: null` —una corrida que murió sin escribir contadores— e `iniciadoPor: null`, que es el
 * guion del AC2. Tres bordes en una sola fila porque los tres se dan juntos en la vida real: lo que
 * se rompe pronto no llega a contar nada ni a decir de quién era.
 */
const RUN_HIST_FALLIDA = {
  ...RUN_HIST_COMPLETADA,
  runId: H_FALLIDA,
  estado: 'failed',
  iniciadoEn: '2026-08-13T23:40:00Z',
  finalizadoEn: '2026-08-13T23:41:00Z',
  scopeNits: [NIT_A],
  resumen: null,
  iniciadoPor: null,
};
const RUN_HIST_SIMULADA = {
  ...RUN_HIST_COMPLETADA,
  runId: H_SIMULADA,
  estado: 'completed',
  iniciadoEn: '2026-08-13T08:05:00Z',
  finalizadoEn: '2026-08-13T08:06:00Z',
  resumen: RESUMEN_HIST_SIMULADO,
};

const HISTORIAL = [RUN_HIST_COMPLETADA, RUN_HIST_PARCIAL, RUN_HIST_FALLIDA, RUN_HIST_SIMULADA];

/** El detalle de cada una. La fallida va SIN pasos: es el «no hay vacío, hay copy» de TC72. */
const DETALLE_HIST: Record<string, unknown> = {
  [H_COMPLETADA]: { ...RUN_HIST_COMPLETADA, steps: STEPS },
  [H_PARCIAL]: { ...RUN_HIST_PARCIAL, steps: [...STEPS, STEP_ERROR] },
  [H_FALLIDA]: { ...RUN_HIST_FALLIDA, steps: [] },
  [H_SIMULADA]: { ...RUN_HIST_SIMULADA, steps: STEPS },
};

/** La corrida viva de TC79: nace `running` y termina mientras el operador mira la pantalla. */
const RUN_HIST_VIVA = {
  ...RUN_HIST_COMPLETADA,
  runId: H_VIVA,
  estado: 'running',
  iniciadoEn: INICIADO_EN,
  finalizadoEn: null,
  resumen: null,
};
const RUN_HIST_VIVA_TERMINADA = {
  ...RUN_HIST_VIVA, estado: 'completed', finalizadoEn: FINALIZADO_EN, resumen: RESUMEN_COMPLETADA,
};

/**
 * El guion de las ausencias, copiado de `formato.ts` (`SIN_DATO`) y no importado, por lo mismo que
 * el resto del copy de este archivo: importarlo diría «el hueco se pinta con lo que diga el código».
 * Y es la raya (U+2014), no un menos ni un guion corto: eso también es contrato de pantalla.
 */
const GUION = '\u2014';

/**
 * Una página de `n` corridas sintéticas, para el único TC que mueve el `?limit=`.
 *
 * Se generan en vez de escribirse a mano por lo evidente —cien filas— y con dos cuidados: `runId`
 * distinto en cada una (la tabla las distingue por ahí) e instantes decrecientes de hora en hora,
 * que es el orden en que el servidor las devuelve. El alcance se queda en un solo NIT: el sujeto
 * del caso es el límite, y doce NIT por fila solo engordarían el JSON del mock.
 */
function corridasSinteticas(n: number) {
  const base = Date.parse(INICIADO_EN);
  return Array.from({ length: n }, (_, i) => ({
    ...RUN_HIST_COMPLETADA,
    runId: `run-pagina-${i}`,
    iniciadoEn: new Date(base - i * 3_600_000).toISOString(),
    finalizadoEn: new Date(base - i * 3_600_000 + 120_000).toISOString(),
    scopeNits: [NIT_A],
  }));
}

/**
 * Los `?limit=` que pidió EL HISTORIAL, sin los de la consola.
 *
 * Las dos zonas leen el mismo endpoint y el mock no puede distinguirlas por otra cosa: la consola
 * hidrata con un límite corto —solo quiere saber si hay algo corriendo— y el historial pide sus
 * páginas. Filtrar por los tres valores de la spec deja fuera esa lectura ajena sin tener que
 * afirmar nada sobre ella, que es de otra HU.
 */
function limitesDelHistorial(runs: EstadoRuns): string[] {
  return runs.limites.filter((l) => l === '20' || l === '50' || l === '100');
}

/**
 * Los NIT del alcance amplio que NO están en el catálogo de la consola.
 *
 * Existen para poder barrer la PÁGINA ENTERA y no solo la tarjeta del historial. `NIT_A` y `NIT_B`
 * sí están en el catálogo, así que aparecen legítimamente en el selector «Solo estos NIT» de la
 * consola —que vive en la misma vista— y un barrido global sobre ellos daría un rojo por algo
 * correcto. Estos diez no salen de ningún catálogo: solo existen como alcance de corridas viejas,
 * de modo que cualquier sitio del documento donde aparezcan es un sitio donde alguien los aparcó.
 */
const NITS_SOLO_DEL_ALCANCE = ALCANCE_AMPLIO.filter(
  (nit) => !NITS.some((delCatalogo) => delCatalogo.nit === nit),
);

/** Copy literal de la Región B. Copiado de la spec de UX, no importado de la pantalla (ver `COPY`). */
const COPY_HIST = {
  titulo: 'Historial de sincronizaciones',
  vacio: 'Todavía no hay sincronizaciones. Lanza la primera desde el panel de arriba.',
  error: 'No se pudo cargar el historial de sincronizaciones.',
  /** No está en la spec: se redacta aquí en paralelo al de la lista. Ver la nota de ambigüedades. */
  errorDetalle: 'No se pudo cargar el detalle de la corrida.',
  sinPasos: 'Esta corrida no registró pasos.',
  /**
   * Tampoco está en la spec, y es la que más se nota que falta: el 404 del detalle. Se redacta
   * aquí junto al resto y va al HANDOFF con las otras dos. Lo que NO es discutible es que sea un
   * texto distinto del error reintentable — de eso depende que el operador entienda por qué esta
   * vez no hay botón (TC81).
   */
  sinCorrida: 'Esta corrida ya no está en el historial.',
} as const;

// ──────────────────────────────── Localizadores del historial ───────────────────────────────────

const historial = (page: Page) => page.getByRole('region', { name: COPY_HIST.titulo });
/**
 * La tabla del historial, buscada DENTRO de su región y sin exigirle nombre.
 *
 * La región ya está nombrada por su `<h2>`, y dentro no hay más que una tabla: pedirle además un
 * nombre concreto sería atarse a cómo esté redactado el `<caption>`, que la spec de UX no fija.
 * (El resto del módulo redacta sus captions empezando por el título del bloque —«Detalle por
 * fuente: …»—, y seguir esa costumbre aquí ayudaría a quien escriba el próximo localizador; queda
 * como observación, no como contrato.)
 */
const tablaHistorial = (page: Page) => historial(page).getByRole('table');
/** Solo las filas de datos: el `<tbody>` deja fuera la de cabeceras sin tener que restar uno. */
const filasHistorial = (page: Page) => tablaHistorial(page).locator('tbody').getByRole('row');
const botonesVerDetalle = (page: Page) =>
  tablaHistorial(page).getByRole('button', { name: /Ver detalle/i });
const verDetalle = (page: Page, fila: number) =>
  filasHistorial(page).nth(fila).getByRole('button', { name: /Ver detalle/i });
const modalCorrida = (page: Page) => page.getByRole('dialog');

async function esperarHistorialCargado(page: Page) {
  await expect(filasHistorial(page).first()).toBeVisible();
}

async function abrirDetalle(page: Page, fila: number) {
  await verDetalle(page, fila).click();
  await expect(modalCorrida(page)).toBeVisible();
}

/**
 * ¿Esta zona se declara OCUPADA mientras carga?
 *
 * Se mira el atributo en el ámbito **o** en cualquier descendiente en vez de exigir dónde va
 * exactamente: lo que el contrato pide es que la carga se anuncie sin montar una segunda región
 * viva, y si `aria-busy` cuelga de la tarjeta o del contenedor de las filas fantasma da igual —para
 * un lector de pantalla dice lo mismo—. Fijar el nodo exacto sería un rojo por maquetación.
 */
async function seDeclaraOcupada(zona: Locator): Promise<boolean> {
  return zona.evaluate(
    (el) => el.getAttribute('aria-busy') === 'true' || el.querySelector('[aria-busy="true"]') !== null,
  );
}

/**
 * El barrido de PII del historial, en sus dos radios. Se llama con el modal CERRADO.
 *
 * **`outerHTML` y no `innerHTML`.** Es la corrección que trajo la auditoría de seguridad, y el
 * agujero era exactamente del tipo que hace que un guardián apruebe lo que existe para cazar:
 * `innerHTML` serializa los hijos del nodo pero **no los atributos del nodo raíz**, así que un
 * `title="900222333 · 830115577 …"` o un `data-nits` puestos en la propia `<table>` pasaban verdes.
 * El tooltip del wireframe se escribe justo así.
 *
 * **La región entera y no solo la tabla.** Un NIT en el párrafo de la tarjeta, en la zona de
 * «Cargar más» o en una futura línea de resumen quedaba fuera del radio anterior. La frontera que
 * el AC1 dibuja es «la fila no los lista», y la forma honesta de vigilarla es que no estén en ningún
 * sitio de la tarjeta, no que no estén en el sitio donde se nos ocurrió mirar.
 *
 * **Y el documento entero para los diez que no salen de ningún catálogo.** Cubre lo que ni la
 * región ni la tabla ven: un `<template>`, un nodo oculto en otra parte del árbol, un input con
 * `value` de atributo, una tarjeta plegada.
 *
 * ── LÍMITE DECLARADO DEL BARRIDO ───────────────────────────────────────────────────────────────
 *
 * Ni `outerHTML` ni `innerText` ven un valor que vive ÚNICAMENTE como propiedad del DOM (un
 * `el.value` asignado por código, sin atributo) ni datos retenidos en props de React para un futuro
 * handler de copiado o exportación: nada de eso llega a ser texto ni atributo. El barrido de página
 * completa reduce ese hueco —cualquier aparcamiento que se materialice en el árbol sale— pero no lo
 * cierra.
 *
 * Se considera y se descarta serializar `__reactProps$…` de cada nodo: es posible, y ataría la
 * suite a un detalle interno de React cuyas claves cambian por build, para cazar un fallo que hoy no
 * existe. Un guardián frágil se apaga al tercer rojo falso y entonces no guarda nada. Queda escrito
 * aquí, que es donde lo va a leer quien añada ese handler de exportación.
 */
async function barridoSinAlcance(page: Page, cuando: string) {
  const marcado = await historial(page).evaluate((el) => el.outerHTML);
  for (const nit of ALCANCE_AMPLIO) {
    expect(marcado, `${cuando}: el NIT ${nit} no puede estar en el marcado del historial`)
      .not.toContain(nit);
  }
  const pagina = await page.evaluate(() => document.documentElement.outerHTML);
  for (const nit of NITS_SOLO_DEL_ALCANCE) {
    expect(pagina, `${cuando}: el NIT ${nit} no está en ningún catálogo y no puede estar en la página`)
      .not.toContain(nit);
  }
}

/**
 * Ningún NIT en la URL, que es la superficie que se copia, se pega en un correo y se queda en el
 * historial del navegador y en los logs del proxy.
 *
 * La regla ya estaba fijada para la consola (TC38) y el bloque del historial no la afirmaba en
 * ninguna parte: abrir un detalle es justo el momento en que apetece llevar el estado a la query
 * para poder enlazar una corrida. El `runId` ahí sería legítimo; el alcance, nunca.
 */
function sinNitEnLaUrl(page: Page, cuando: string) {
  const url = page.url();
  for (const nit of ALCANCE_AMPLIO) {
    expect(url, `${cuando}: ningún NIT viaja en la URL`).not.toContain(nit);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · historial de corridas (HU #11636)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLectura(page, API_REGISTROS, { status: 200, body: { items: [], nextCursor: null } });
    await mockLectura(page, API_NITS, { status: 200, body: NITS });
    await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
    await mockLectura(page, API_CAUSALES, { status: 200, body: CAUSALES });
    await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_CONFIGURADO });
    // Sin `mockRuns` por defecto: cada TC del historial monta el suyo, porque la lista ES el sujeto.
    // Un `page.route` registrado dentro del TC gana sobre uno del `beforeEach`, pero dejar aquí una
    // lista vacía haría que el TC que se olvide de montarla pase por «historial sin corridas» en vez
    // de fallar, que es lo que tiene que hacer.
  });

  // ═════════════════════════════════ AC1 · La lista de corridas ══════════════════════════════════

  test.describe('AC1 · lista de corridas', () => {
    // TC65 — el camino feliz de la lista, y el TC que fija la FORMA de la tabla: las cuatro columnas
    // del wireframe, el orden que manda el servidor, el chip con la palabra dentro y la fecha corta.
    //
    // Lo de la fecha no es cosmético y por eso se afirma en las dos direcciones. La enmienda 15 parte
    // el formato en dos: instante completo en las frases sueltas —la consola y la cabecera del
    // modal, donde una hora sin día puede ser de otro día sin que se note— y fecha corta en la
    // tabla, donde la columna ordenada ya da el contexto y repetir «2026» cuatro veces engorda una
    // tabla densa. Se comprueba que la fila trae día y hora, y que NO trae el año.
    test('TC65: la tabla lista las corridas con inicio corto, estado, alcance y resumen rápido', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await expect(historial(page)).toBeVisible();

      const filas = filasHistorial(page);
      await expect(filas).toHaveCount(HISTORIAL.length);

      // Las columnas del wireframe. La quinta («Detalle») lleva los botones y no se afirma por
      // nombre: lo que importa de ella es el botón, y eso es TC74.
      const cabeceras = tablaHistorial(page).getByRole('columnheader');
      await expect(cabeceras.nth(0)).toHaveText(/inicio/i);
      await expect(cabeceras.nth(1)).toHaveText(/estado/i);
      await expect(cabeceras.nth(2)).toHaveText(/alcance/i);
      await expect(cabeceras.nth(3)).toHaveText(/resumen/i);

      // El orden es el del servidor —de la más reciente a la más vieja— y la pantalla no lo
      // reordena por su cuenta. Un `sort` local por fecha parece inofensivo hasta que el backend
      // cambia el criterio y las dos ordenaciones discrepan en silencio.
      await expect(filas.nth(0)).toContainText(/14 .{0,7}ago.{0,4}15:02/);
      await expect(filas.nth(1)).toContainText(/14 .{0,7}ago.{0,4}03:07/);
      await expect(filas.nth(2)).toContainText(/13 .{0,7}ago.{0,4}18:40/);
      await expect(filas.nth(3)).toContainText(/13 .{0,7}ago.{0,4}03:05/);

      // Fecha CORTA: en la tabla no hay año. Los ids de las corridas del fixture tampoco lo llevan,
      // así que un «2026» aquí solo puede venir del formato largo.
      const textoTabla = await tablaHistorial(page).innerText();
      expect(textoTabla, 'la tabla usa el formato corto, sin año (enmienda 15)').not.toContain('2026');

      // El chip lleva la PALABRA: `partial` no puede distinguirse solo por el tono `warning`.
      await expect(filas.nth(0)).toContainText('Completada');
      await expect(filas.nth(1)).toContainText('Parcial');
      await expect(filas.nth(2)).toContainText('Fallida');

      // Resumen rápido: número y concepto. Se afirma la semántica, no la redacción (ver cabecera).
      await expect(filas.nth(0)).toContainText('340');
      await expect(filas.nth(0)).toContainText(/upserts/i);
      // `/inact/i` y no `/inactivados/`: el wireframe abrevia («3 inact.») y abreviar en una tabla
      // densa es legítimo. Exigir la palabra entera sería inventar copy donde el catálogo calla,
      // que es justo lo que este bloque dijo que no iba a hacer. (La abreviatura sin `<abbr>` queda
      // como observación de a11y en el HANDOFF, no como rojo.)
      await expect(filas.nth(0)).toContainText(/inact/i);

      // El listado se pide con el `limit` de la spec, y UNA sola vez. Dos lecturas idénticas al
      // montar es el efecto que corre dos veces en `StrictMode`: dos filas de `pii_access_log` con
      // los NIT de todas las corridas listadas, por abrir una pestaña.
      expect(runs.limites, 'el historial pide limit=20 (spec Región B)').toContain('20');
      expect(runs.limites.filter((l) => l === '20'), 'una sola lectura del listado del historial')
        .toHaveLength(1);
    });

    // TC66 — EL caso de esta HU, y el que impide que alguien «mejore» la tabla.
    //
    // El AC1 lo pide en una frase que parece de maquetación —«la fila no lista todos los NIT del
    // alcance»— y es una regla de tratamiento de datos personales. Tres cosas lo hacen decidible:
    //
    //   1. Se barre el **HTML** de la fila, no su texto visible. El wireframe sugiere un tooltip con
    //      el conteo, y la forma natural de escribir un tooltip es `title="900123456 · 830009988 …"`:
    //      invisible en la captura del navegador, perfectamente presente en el DOM, en el portapapeles
    //      y en cualquier exportación de la tabla. Un TC que solo mirara `innerText` lo aprobaría.
    //   2. Se barre la tabla ENTERA y no solo la primera fila: la fila de la corrida fallida tiene un
    //      alcance de un único NIT, que es donde más tienta escribirlo «porque cabe».
    //   3. Y se comprueba el contrapunto: dentro del modal SÍ están, porque el AC2 lo pide y porque
    //      es lo que hace que la regla de la lista no sea una pérdida de información, sino un cambio
    //      de sitio.
    test('TC66: la fila resume el alcance en un conteo y no enseña ningún NIT; el modal sí los lista', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);

      // Lo que la fila SÍ dice: cuántos, no cuáles.
      await expect(filasHistorial(page).nth(0)).toContainText(`${ALCANCE_AMPLIO.length} NIT`);

      await barridoSinAlcance(page, 'con el historial cargado');
      sinNitEnLaUrl(page, 'con el historial cargado');

      // Y en el detalle sí: ahí el alcance es el dato, no el ruido. Es lo que hace que la regla de
      // la lista no sea una pérdida de información, sino un cambio de sitio.
      await abrirDetalle(page, 0);
      await expect(modalCorrida(page)).toContainText(NIT_A);
      await expect(modalCorrida(page)).toContainText(NIT_B);
      await expect(modalCorrida(page)).toContainText(ALCANCE_AMPLIO[5]);
      sinNitEnLaUrl(page, 'con el detalle abierto');

      // Y AL CERRAR se van del DOM. Hoy es cierto porque el modal se monta y se desmonta, pero eso
      // es una propiedad de `FlitModal`, no una decisión de esta pantalla: el día que ese modal pase
      // a ocultarse con CSS —para conservar el scroll, o para animar la salida— los doce NIT se
      // quedarían en el árbol de una vista que ya no los enseña, y sin esta comprobación no habría
      // nada que lo dijera. El barrido de después es idéntico al de antes de abrir, a propósito.
      await page.keyboard.press('Escape');
      await expect(modalCorrida(page)).toHaveCount(0);
      await barridoSinAlcance(page, 'tras cerrar el detalle');
      sinNitEnLaUrl(page, 'tras cerrar el detalle');
    });

    // TC67 — BORDE del conteo: una corrida de un solo NIT. Dos cosas a la vez, y las dos se rompen
    // por separado: que el número no arrastre una «s» de plural («1 NITs» es el bug de plantilla más
    // barato del mundo) y que el alcance corto NO se desgrane. Lo segundo es lo que de verdad
    // importa: la regla de PII no admite excepción por brevedad, y «con uno solo se puede enseñar»
    // es exactamente el razonamiento que la rompe.
    test('TC67: una corrida de un solo NIT dice «1 NIT» en singular y tampoco lo enseña', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);

      const fila = filasHistorial(page).nth(2);
      const texto = await fila.innerText();
      expect(texto, 'el alcance de una sola corrida se cuenta en singular').toMatch(/\b1 NIT\b/);
      expect(texto, 'sin plural de plantilla').not.toMatch(/\b1 NITs\b/);

      // `outerHTML` de la REGIÓN, por lo mismo que en TC66: con `innerHTML` de la fila, un `title`
      // en el `<tr>` —el sitio más natural para un tooltip de fila— no se serializaba, y el
      // guardián aprobaba justo el descuido que existe para cazar. Aquí el radio es la tarjeta
      // entera: `NIT_A` sí está en el catálogo, así que aparece legítimamente en el selector de la
      // consola, pero en el historial no tiene nada que hacer.
      const marcado = await historial(page).evaluate((el) => el.outerHTML);
      expect(marcado, 'ni con uno solo se lista el NIT en el historial').not.toContain(NIT_A);
    });

    // TC68 — el resumen rápido cuando NO hay resumen, y el modo simulado.
    //
    // Una corrida que murió sin escribir contadores (`resumen: null`) tiene que pintar el guion. Un
    // «0 upserts» ahí sería una afirmación sobre un trabajo que nadie llegó a medir, que es el mismo
    // error que el `itemsLeidos: null` de los pasos: el cero se lee como «no había nada» y el guion
    // como «no se sabe». Son cosas distintas y en una tabla de auditoría la diferencia es todo.
    //
    // Y el modo simulado se dice con la palabra del catálogo: «simulado», no «mock». El wireframe
    // escribe «modo mock» y pierde contra el catálogo corto y contra la regla de tono del documento
    // (sin anglicismos en copy de usuario). Ver la nota de ambigüedades de la cabecera.
    test('TC68: sin resumen la fila pinta guion y no ceros, y el modo simulado se dice en español', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);

      const sinResumen = await filasHistorial(page).nth(2).innerText();
      expect(sinResumen, 'una corrida sin contadores no inventa upserts').not.toMatch(/upserts/i);
      expect(sinResumen, 'el hueco se dice con guion').toContain(GUION);

      const simulada = await filasHistorial(page).nth(3).innerText();
      expect(simulada, 'el modo simulado se avisa en la propia fila').toMatch(/simulad/i);
      expect(simulada, 'copy de usuario en español: «simulado», no «mock»').not.toMatch(/mock/i);
    });

    // TC83 — «Cargar más corridas», la única superficie que mueve el `?limit=`.
    //
    // La spec la deja como opcional de v1 y con una condición que es todo el caso: **la misma lista
    // reemplazada, no scroll infinito**. Las dos formas se ven casi iguales en pantalla la primera
    // vez y son distintas para todo lo demás:
    //
    //   · Acumular (20 + 50 = 70 filas) es pedir dos veces las mismas veinte corridas y anotar dos
    //     veces su acceso en `pii_access_log`, además de dejar una tabla con filas duplicadas en
    //     cuanto una corrida cambie de estado entre las dos lecturas.
    //   · El scroll infinito, aquí, es un sondeo con otro nombre: dispara lecturas de datos
    //     personales por mirar, sin que nadie haya pedido nada, y es justo lo que la decisión 13
    //     acaba de recortar en la consola.
    //
    // Por eso se afirma el VALOR del `limit` pedido —20, luego 50, luego 100— y no solo que hubiera
    // otra petición: una implementación que pidiera `?limit=20` tres veces también «hace otra
    // petición», y no carga nada más. Y se afirma el conteo de filas después de cada paso, que es lo
    // que separa reemplazar de acumular.
    //
    // El botón desaparece al llegar al tope: el servidor no acepta más de 100 (`limit` máx.), así
    // que dejarlo visible sería ofrecer una acción que ya no puede hacer nada.
    test('TC83: Cargar más pide 50 y luego 100, reemplaza la lista y desaparece en el tope', async ({ page }) => {
      const runs = await mockRuns(page, { lista: corridasSinteticas(20) });

      await irASincronizacion(page);
      await expect(filasHistorial(page)).toHaveCount(20);
      expect(limitesDelHistorial(runs), 'la primera página es la de la spec').toEqual(['20']);

      // Nada se mueve si nadie pulsa: el botón está, y hasta que se pulse no hay más lecturas.
      const boton = historial(page).getByRole('button', { name: /Cargar más/i });
      await expect(boton).toBeVisible();
      const trasElMontaje = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'sin pulsar no se carga nada').toBe(trasElMontaje);

      runs.lista = corridasSinteticas(50);
      await boton.click();
      await expect(filasHistorial(page)).toHaveCount(50);
      expect(limitesDelHistorial(runs), 'la segunda página se pide con limit=50').toEqual(['20', '50']);

      runs.lista = corridasSinteticas(100);
      await boton.click();
      await expect(filasHistorial(page)).toHaveCount(100);
      expect(limitesDelHistorial(runs), 'y la tercera con limit=100').toEqual(['20', '50', '100']);

      // Tope: no hay nada más que pedir y el control se retira.
      await expect(historial(page).getByRole('button', { name: /Cargar más/i })).toHaveCount(0);
    });
  });

  // ══════════════════════════════ AC2 · El detalle con sus pasos ═════════════════════════════════

  test.describe('AC2 · detalle de la corrida', () => {
    // TC69 — abrir el detalle: una lectura, la de esa corrida, y el instante COMPLETO en la cabecera.
    //
    // Las tres cosas que vigila:
    //   · Se pide el detalle de la fila que se pulsó (y no, por ejemplo, el de la primera siempre:
    //     el bug clásico de un `map` que se cierra sobre la variable equivocada).
    //   · Se pide UNA vez. Cada lectura de `/sync/runs/:id` escribe su fila de `pii_access_log`, así
    //     que un `useEffect` sin dependencias estables aquí no es una petición de más: es la
    //     bitácora de accesos a datos personales llenándose de ruido.
    //   · La cabecera lleva el instante entero —día, año y hora—, que es la otra mitad de la
    //     enmienda 15: en una frase suelta, «15:02» a secas puede ser de cualquier día.
    test('TC69: Ver detalle abre el modal de esa corrida con una sola lectura y su instante completo', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 0);

      const modal = modalCorrida(page);
      expect(runs.idsPedidos, 'se lee el detalle de la fila pulsada, y solo ese').toEqual([H_COMPLETADA]);
      await expect(modal.getByText(/14 .{0,7}ago.{0,4}2026, 15:02/).first()).toBeVisible();

      // Estado, modo, alcance, contadores y pasos: las cinco cosas que el AC2 pide ver.
      await expect(modal).toContainText('Completada');
      await expect(modal).toContainText(/modo:? real/i);
      await expect(modal).toContainText(NIT_A);
      await expect(modal).toContainText('Upserts 340');
      await expect(modal.getByRole('table', { name: /Detalle por fuente/i })).toBeVisible();

      // Y sigue siendo UNA lectura después de que el modal haya pintado: un re-render no vuelve a
      // preguntar.
      expect(runs.llamadasDetalle, 'el detalle se lee al abrir, no en cada render').toBe(1);
    });

    // TC70 — la tabla de pasos, que es la razón de ser del modal: qué fuente falló, con qué código y
    // cuántos ítems trajo. Todo esto lo pinta `ResultadoSyncComparendos`, que la #11635 dejó en su
    // propio archivo justamente para que el modal lo reutilizara; este TC es, por tanto, el guardián
    // de esa reutilización: si alguien copia la tabla en vez de reusarla, el día que se arregle el
    // guion en un sitio y no en el otro este TC lo dirá.
    //
    // «SIMIT» en mayúsculas es del AC2 palabra por palabra, y se afirma también en negativo: que el
    // `simit` crudo del contrato no se escape a la pantalla.
    test('TC70: los pasos etiquetan SIMIT, pintan el HTTP del proveedor y el guion donde no se leyó', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 1);

      const tabla = modalCorrida(page).getByRole('table', { name: /Detalle por fuente/i });
      await expect(tabla.getByRole('row')).toHaveCount([...STEPS, STEP_ERROR].length + 1);
      await expect(tabla.getByRole('row').nth(1)).toContainText('SIMIT');
      expect(await tabla.innerText(), 'la fuente nacional se llama SIMIT, no «simit»').not.toContain('simit');

      // La fila que falló: la palabra «Error» (no solo el color), el HTTP del PROVEEDOR, el mensaje
      // persistido y el guion de `itemsLeidos: null` —que significa «no se llegó a leer» y no cero—.
      const filaError = tabla.getByRole('row').filter({ hasText: 'BELLO' });
      await expect(filaError).toContainText('Error');
      await expect(filaError).toContainText('504');
      await expect(filaError).toContainText(STEP_ERROR.mensaje as string);
      await expect(filaError).toContainText(GUION);
    });

    // TC71 — «sin inventar nombres», que es la frase del AC2 con más consecuencias.
    //
    // `iniciadoPor` es un id porque el contrato lo decidió así (decisión 11: no se pide un directorio
    // de usuarios para este módulo). La tentación es evidente y bienintencionada —«Usuario 7» se ve
    // pobre— y la forma de ceder es una llamada a `/api/users` «solo para resolver el nombre». Eso no
    // es una petición de más: es traer datos de personas a una pantalla que no los necesitaba, y
    // atarlos a un dato de auditoría que se guarda para siempre.
    //
    // Por eso el TC no se conforma con leer «Usuario 7» en pantalla: escucha TODAS las peticiones de
    // la página y afirma que ninguna fue a un directorio. Y comprueba el otro atajo, el que no deja
    // rastro en la red: pintar el nombre del usuario de la sesión cuando el id coincide con el suyo
    // —`OPERACIONES_USER.id` es 7, el mismo de la corrida, así que ese atajo pasaría desapercibido—.
    test('TC71: el iniciador se muestra como «Usuario N» o guion, sin ir a buscar el nombre a ninguna parte', async ({ page }) => {
      const urls: string[] = [];
      page.on('request', (peticion) => urls.push(peticion.url()));
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 0);

      const modal = modalCorrida(page);
      // La pareja etiqueta/valor se afirma sobre el texto renderizado y con el separador flojo
      // (`:?\s*`) para no atarse al marcado: en una ficha `<dl>` el valor cae en la línea siguiente
      // y en una línea corrida va tras dos puntos. Las dos formas dicen lo mismo y ninguna de las
      // dos es asunto de un TC; lo que sí lo es —y esto no lo afloja— es que el id se lea JUNTO a
      // su etiqueta y no como un número suelto en mitad de la ficha.
      expect(await modal.innerText(), 'el iniciador se lee como «Usuario N», pegado a su etiqueta')
        .toMatch(/Iniciada por:?\s*Usuario 7/);
      expect(await modal.innerText(), 'no se pinta el nombre de nadie, ni el de la propia sesión')
        .not.toContain(OPERACIONES_USER.name);

      // La corrida sin iniciador conocido: guion, no «Usuario null» ni «Sistema» ni un hueco mudo.
      await modal.getByRole('button', { name: 'Cerrar' }).click();
      await expect(modalCorrida(page)).toHaveCount(0);
      await abrirDetalle(page, 2);
      expect(await modalCorrida(page).innerText(), 'sin iniciador conocido, guion: ni «Usuario null» ni un hueco')
        .toMatch(/Iniciada por:?\s*—/);

      const directorio = urls.filter((u) => /\/api\/(users|usuarios)\b/i.test(u));
      expect(directorio, 'el módulo no consulta un directorio de usuarios (decisión 11)').toEqual([]);
    });

    // TC72 — BORDE del modal: una corrida sin pasos. La spec es explícita en que aquí NO hay estado
    // vacío —un run sin `steps[]` es anómalo, no un caso normal— y en que se dice con una frase.
    // Sin ella queda una tabla con cabeceras y nada debajo, que se lee como «cargando» o como un
    // fallo de la pantalla, cuando lo que pasó es que la corrida murió antes de dar un solo paso.
    test('TC72: una corrida sin pasos lo dice con su frase y no deja una tabla vacía', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 2);

      const modal = modalCorrida(page);
      await expect(modal.getByText(COPY_HIST.sinPasos)).toBeVisible();
      await expect(modal.getByRole('table', { name: /Detalle por fuente/i })).toHaveCount(0);
      // Y lo que sí se sabe de esa corrida se sigue viendo: el estado y el alcance no dependen de
      // que hubiera pasos.
      await expect(modal).toContainText('Fallida');
      await expect(modal).toContainText(NIT_A);
    });

    // TC73 — el detalle falla. Dos exigencias, y la segunda es la que se olvida: que el error del
    // modal sea REINTENTABLE de verdad (que el botón vuelva a pedir, no que solo cierre) y que la
    // lista de abajo siga en pie. Un 500 leyendo una corrida no dice nada de las otras diecinueve.
    test('TC73: si el detalle falla, el modal ofrece reintentar y el reintento vuelve a pedir', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });
      runs.fallaDetalle = 500;

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 0);

      const modal = modalCorrida(page);
      // Se afirma el MENSAJE y no el rol: la spec de UX fija el copy de la lista y para el modal
      // solo dice «error + reintentar», así que exigir `role="alert"` aquí sería contrato inventado
      // —y además discutible, porque una alerta es una región viva y esta vista tiene una sola por
      // decisión expresa—. Queda como pregunta abierta a UX en el HANDOFF.
      await expect(modal.getByText(COPY_HIST.errorDetalle)).toBeVisible();
      await expect(anuncio(page), 'el fallo del detalle no monta una región viva nueva').toHaveCount(1);
      expect(runs.llamadasDetalle).toBe(1);

      // La tabla de abajo no se entera: sigue con sus cuatro filas.
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length);

      runs.fallaDetalle = null;
      await modal.getByRole('button', { name: 'Reintentar' }).click();
      await expect(modal).toContainText('Upserts 340');
      expect(runs.llamadasDetalle, 'el reintento vuelve a preguntar').toBe(2);
      await expect(modal.getByText(COPY_HIST.errorDetalle)).toHaveCount(0);
    });

    // TC74 — el modal por teclado, y los nombres de los botones que lo abren.
    //
    // Lo de los nombres no es un detalle de purista: cuatro botones «Ver» en una tabla son, para
    // quien navega por la lista de controles de un lector de pantalla, cuatro veces la misma palabra
    // sin nada que los distinga —y la fila, que es lo que los distingue en la pantalla, ahí no se
    // oye—. Se afirma que son CUATRO nombres DISTINTOS y no una redacción concreta: cómo se
    // desambigüen (el instante, el estado) es cosa de quien lo escriba.
    //
    // Y el foco vuelve al botón que abrió, que es el contrato de `FlitModal` vía `restoreFocusRef`:
    // sin él, Escape deja el foco en el `<body>` y quien navega con teclado tiene que recorrer la
    // página entera para volver a donde estaba.
    test('TC74: los botones de detalle se distinguen entre sí y Escape devuelve el foco al que abrió', async ({ page }) => {
      await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);

      const botones = botonesVerDetalle(page);
      await expect(botones).toHaveCount(HISTORIAL.length);
      const nombres = await botones.evaluateAll(
        (els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? ''),
      );
      expect(new Set(nombres).size, `cuatro nombres accesibles distintos, no cuatro «Ver»: ${nombres.join(' / ')}`)
        .toBe(HISTORIAL.length);

      const boton = verDetalle(page, 1);
      await boton.click();
      await expect(modalCorrida(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(modalCorrida(page)).toHaveCount(0);
      await expect(boton, 'el foco vuelve a la fila de la que se salió').toBeFocused();
    });

    // TC81 — el 404, que es el ÚNICO error del módulo que niega el reintento.
    //
    // Una corrida puede desaparecer entre que se lista y que se abre: purga por retención, o un
    // historial cargado hace media hora en una pestaña que nadie tocó. Lo que hace especial a este
    // error no es el copy, es la ausencia del botón: reintentar un 404 es volver a fallar, y un
    // «Reintentar» que solo puede fallar otra vez es peor que no ofrecer nada —hace cargar al
    // operador con la sospecha de que no insistió bastante—.
    //
    // Hoy las dos ramas están separadas por el `status`, y nada impide que alguien las «unifique»
    // más adelante para simplificar el manejo de errores: son cuatro líneas y el resultado se ve
    // igual de bien en pantalla. Por eso el TC afirma la AUSENCIA del control, que es lo que se
    // pierde en esa refactorización, y no solo el mensaje.
    //
    // Y afirma el contador en uno: un reintento automático «para asegurarse» sería exactamente el
    // reintento que esta rama descarta, solo que sin botón y sin que nadie lo vea. La fila de detrás
    // sigue en la lista porque el 404 es del DETALLE: lo que no está es esa corrida, no el archivo.
    test('TC81: una corrida que ya no está niega el reintento, deja cerrar y no vuelve a pedir sola', async ({ page }) => {
      // El detalle de la parcial no está en el servidor: el listado la tiene, el detalle no. Es lo
      // que pasa de verdad cuando la purga se lleva la corrida entre las dos lecturas.
      const detalleSinLaParcial: Record<string, unknown> = { ...DETALLE_HIST };
      delete detalleSinLaParcial[H_PARCIAL];
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: detalleSinLaParcial });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await abrirDetalle(page, 1);

      const modal = modalCorrida(page);
      await expect(modal.getByText(COPY_HIST.sinCorrida)).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Reintentar' }),
        'un 404 no se reintenta: el botón solo podría volver a fallar').toHaveCount(0);
      // Y no se cuela el copy del error reintentable, que es la otra mitad de la confusión.
      await expect(modal.getByText(COPY_HIST.errorDetalle)).toHaveCount(0);

      // Cerrar sí: es la única salida honesta, y tiene que estar DENTRO del cuerpo del diálogo, no
      // solo en la «X» de la cabecera —quien acaba de leer el mensaje tiene la acción donde mira—.
      const cerrar = modal.getByRole('button', { name: 'Cerrar' });
      await expect(cerrar.last()).toBeVisible();

      // Ni un reintento disfrazado: una petición, la que se pidió al abrir.
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasDetalle, 'un 404 no se reintenta solo').toBe(1);

      await cerrar.last().click();
      await expect(modalCorrida(page)).toHaveCount(0);
      // El archivo no se ha movido: el 404 era de una corrida, no del historial.
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length);
      await expect(historial(page).getByText(COPY_HIST.error)).toHaveCount(0);
    });

    // TC82 — reabrir la MISMA corrida vuelve a pedir el detalle, y eso es una decisión, no un olvido.
    //
    // Nace del arreglo de la doble lectura: la guardia que impide la segunda pasada de `StrictMode`
    // recuerda `runId#intento`, y la tentación evidente —una vez que existe una guardia— es
    // ascenderla a caché: «ya tengo el detalle de esta corrida, ¿para qué volver a pedirlo?». En
    // cualquier otra pantalla sería una mejora. Aquí NO, y por una razón que no se ve en el código:
    // cada apertura del modal es un acceso humano nuevo a datos personales —los NIT del alcance y
    // los de cada paso— y tiene que quedar anotado en `pii_access_log`. Servir la segunda apertura
    // desde memoria no ahorra una petición: borra de la bitácora una consulta que ocurrió de verdad.
    // La bitácora existe para responder «quién miró qué y cuándo», y una que se salta las miradas
    // repetidas responde mal a las dos.
    //
    // La segunda mitad del TC es la otra cara de la misma guardia: abrir una corrida DISTINTA tiene
    // que pedir la suya. Con una bandera booleana —el atajo que este archivo pidió no usar— la
    // segunda apertura se habría quedado sin petición y el modal enseñaría el detalle de la primera
    // corrida bajo el título de la segunda, que es de los peores fallos posibles en una pantalla de
    // auditoría: datos correctos atribuidos a la corrida equivocada.
    test('TC82: cada apertura pide su detalle — la misma corrida otra vez, y la de al lado la suya', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);

      await abrirDetalle(page, 0);
      await expect(modalCorrida(page)).toContainText('Upserts 340');
      expect(runs.idsPedidos, 'una lectura por apertura, no dos').toEqual([H_COMPLETADA]);

      await page.keyboard.press('Escape');
      await expect(modalCorrida(page)).toHaveCount(0);

      // La misma otra vez: se vuelve a preguntar. El acceso se repitió y la bitácora tiene que verlo.
      await abrirDetalle(page, 0);
      await expect(modalCorrida(page)).toContainText('Upserts 340');
      expect(runs.idsPedidos, 'reabrir es un acceso nuevo, no un acierto de caché')
        .toEqual([H_COMPLETADA, H_COMPLETADA]);

      // Y la de al lado pide la suya, con el modal de la primera todavía abierto: es el momento en
      // que una guardia demasiado lista se comería la petición.
      await page.keyboard.press('Escape');
      await expect(modalCorrida(page)).toHaveCount(0);
      await abrirDetalle(page, 1);
      expect(runs.idsPedidos[runs.idsPedidos.length - 1], 'cada corrida trae su propio detalle')
        .toBe(H_PARCIAL);
      // Y lo que se ve es lo suyo: el paso que falló está en la parcial, no en la completada.
      await expect(modalCorrida(page).getByRole('table', { name: /Detalle por fuente/i }))
        .toContainText('BELLO');
    });
  });

  // ═══════════════════════════════ AC3 · Estados del historial ═══════════════════════════════════

  test.describe('AC3 · vacío, error y carga', () => {
    // TC75 — el vacío, que es el primer día del módulo en el cliente. No es un hueco: es la frase que
    // invita a lanzar la primera sincronización, y por eso se afirma también que la consola de arriba
    // está lista para hacerlo. Un vacío que dice «lanza la primera desde el panel de arriba» mientras
    // el panel de arriba sigue inhabilitado es una instrucción imposible.
    test('TC75: sin corridas, el historial invita a lanzar la primera y la consola está lista', async ({ page }) => {
      await mockRuns(page, { lista: [] });

      await irASincronizacion(page);
      await expect(historial(page).getByText(COPY_HIST.vacio)).toBeVisible();
      await expect(tablaHistorial(page)).toHaveCount(0);
      await esperarConsolaEnReposo(page);
    });

    // TC76 — el AISLAMIENTO del AC3, y el TC de este bloque que más veces se va a agradecer.
    //
    // Es el mismo caso que el TC17 del visor (un 500 de municipios que no se lleva por delante la
    // tabla de NITs) y aquí es peor si se incumple: el historial es lo ÚLTIMO de la vista y la
    // consola es lo que el operador vino a usar. Que un fallo leyendo el archivo impida sincronizar
    // sería cambiar un problema pequeño —no puedo mirar lo de ayer— por el problema grande.
    //
    // Se comprueba en las dos direcciones, que es lo que hace que «aislamiento» signifique algo:
    // la consola sigue funcionando ENTERA con el historial roto (se dispara y se ve el resultado), y
    // el historial sigue diciendo lo suyo después, sin que el éxito de arriba le borre el error.
    test('TC76: un historial que no carga avisa con reintento y no tumba la consola de arriba', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });
      runs.fallaLista = 500;
      await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA });

      await irASincronizacion(page);
      await expect(historial(page).getByText(COPY_HIST.error)).toBeVisible();
      // El aviso se ve, pero NO interrumpe: `role="alert"` es región viva assertive, y la spec de
      // a11y lo reserva al error definitivo del DISPARO —«es la única excepción»—. Que no se pueda
      // leer el archivo de ayer no es una urgencia que deba cortarle la frase a quien está mirando
      // cómo va la corrida de ahora. Y la región viva de la vista sigue siendo una.
      await expect(page.getByRole('alert'), 'el fallo del archivo no se anuncia como urgencia').toHaveCount(0);
      await expect(anuncio(page), 'ni monta una segunda región viva').toHaveCount(1);

      // La consola no se entera: hidrata igual (el hook trata su lectura fallida como «no hay nada
      // corriendo», no como un error de pantalla) y dispara.
      await esperarConsolaEnReposo(page);
      await botonSincronizar(page).click();
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      await expect(historial(page).getByText(COPY_HIST.error)).toBeVisible();

      // Y el reintento es de verdad: con el servidor sano, la tabla aparece donde estaba el error.
      //
      // El servidor devuelve ahora CINCO corridas, con la recién lanzada arriba. El fixture tiene
      // que decir eso y no las cuatro de antes: entre el error y el reintento se ha ejecutado una
      // sincronización, así que un listado sin ella describiría un servidor imposible —y el TC
      // acabaría acusando a la pantalla de pintar una fila de más cuando lo que hace es exactamente
      // lo que la enmienda le pide, no perder de vista la corrida que el operador acaba de lanzar—.
      runs.fallaLista = null;
      runs.lista = [RUN_COMPLETADA, ...HISTORIAL];
      await historial(page).getByRole('button', { name: 'Reintentar' }).click();
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length + 1);
      await expect(historial(page).getByText(COPY_HIST.error)).toHaveCount(0);
      // Y la de arriba es la que se acaba de lanzar, no la más vieja del archivo.
      await expect(filasHistorial(page).first()).toContainText('Completada');
    });

    // TC77 — mientras carga, el hueco no miente Y no monta una segunda región viva.
    //
    // Lo primero: con el listado retenido no puede haber ni tabla, ni «todavía no hay
    // sincronizaciones», ni error. Pintar el vacío mientras se carga es la variante de este bug que
    // más engaña, porque es una frase afirmativa —«no hay corridas»— sobre algo que nadie ha
    // comprobado todavía; el orden correcto (error, luego vacío, luego lleno) ya está resuelto en
    // `BloqueConfig` y aquí se hereda.
    //
    // Lo segundo es la trampa fina de esta HU, y no se ve leyendo el JSX: el esqueleto canónico del
    // módulo (`EsqueletoBloque`) lleva `role="status"` con nombre, porque en Configuración —cuatro
    // bloques que cargan a la vez y NINGUNA región viva permanente— es exactamente lo correcto.
    // Traído a esta vista, ese mismo acierto se convierte en la segunda región viva que la spec de
    // a11y prohíbe. Aquí la carga se declara con `aria-busy` y quien anuncia sigue siendo la región
    // única de la vista.
    //
    // No se afirma que las filas fantasma sean cinco: es cosmético, no se puede mirar por rol sin
    // inventar un `data-testid` y no cambia nada para quien no ve la pantalla.
    test('TC77: mientras el historial carga no pinta vacío ni error, y no añade una segunda región viva', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST, congelado: true });

      await irASincronizacion(page);
      const zona = historial(page);
      await expect(zona).toBeVisible();

      await expect.poll(() => seDeclaraOcupada(zona), { timeout: 5_000 })
        .toBe(true);
      await expect(zona.getByText(COPY_HIST.vacio)).toHaveCount(0);
      await expect(zona.getByText(COPY_HIST.error)).toHaveCount(0);
      await expect(tablaHistorial(page)).toHaveCount(0);
      await expect(anuncio(page), 'cargar no puede montar una segunda región viva').toHaveCount(1);

      runs.soltarLista();
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length);
      expect(await seDeclaraOcupada(zona), 'al llegar los datos deja de estar ocupada').toBe(false);
      await expect(anuncio(page)).toHaveCount(1);
    });
  });

  // ═════════════════ La enmienda de UX del 20 ago 2026 · decisiones 13, 14 y 15 ══════════════════

  test.describe('Enmienda · el historial no sondea y es superficie de desenlace', () => {
    // TC78 — el historial NO sondea. Es la obligación 1 de la enmienda y solo se puede ver contando
    // peticiones: en pantalla, un historial que se refresca solo y uno que no se refrescan igual de
    // bien —y el que sondea se ve incluso «más vivo»—.
    //
    // El montaje se hace SIN corrida en curso a propósito: con una viva, la consola estaría sondeando
    // y cualquier crecimiento del contador sería suyo, no del historial, y el TC no distinguiría
    // quién preguntó. Sin corrida viva, la consola está quieta (TC61) y todo lo que se mueva aquí es
    // del historial.
    //
    // Se mira también el detalle con el modal ABIERTO: un `setInterval` que refresque «para que se
    // vea el progreso» dentro del modal escribiría una fila de `pii_access_log` por vuelta sobre una
    // corrida que ya terminó y que no va a cambiar nunca más.
    test('TC78: ni la lista ni el modal preguntan por su cuenta mientras nadie pulsa nada', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await esperarConsolaEnReposo(page);

      const trasElMontaje = runs.llamadasLista;
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasLista, 'el historial no sondea (enmienda, obligación 1)').toBe(trasElMontaje);
      expect(runs.llamadasDetalle, 'ni se adelanta a leer detalles que nadie pidió').toBe(0);

      await abrirDetalle(page, 0);
      expect(runs.llamadasDetalle).toBe(1);
      await pausaMasLargaQueElSondeo(page);
      expect(runs.llamadasDetalle, 'el detalle de una corrida terminada no se refresca solo').toBe(1);
      expect(runs.llamadasLista, 'abrir el modal tampoco recarga la lista').toBe(trasElMontaje);
    });

    // TC79 — la primera fila como SUPERFICIE DE DESENLACE (obligación 2), que es la parte de la
    // enmienda que más fácil se implementa «casi bien».
    //
    // Al descartarse el toast (decisión 14), esta fila es donde queda el resultado si el operador
    // estaba mirando hacia abajo cuando la corrida terminó. La implementación natural —«cuando haya
    // desenlace, recargo la lista»— deja una ventana en la que la tarjeta de arriba ya dice
    // «Completada» y la fila de abajo todavía dice «En curso»: dos afirmaciones contradictorias
    // sobre la misma corrida, en la misma pantalla, y la falsa es justamente la que mira quien no
    // estaba mirando arriba. La spec lo cierra sin ambigüedad: el chip correcto **en el mismo
    // momento** en que aparece la tarjeta.
    //
    // El TC lo vuelve decidible congelando el refresco: en cuanto el sondeo sirve la corrida ya
    // terminal, TODA lectura posterior del listado se queda en el aire. Así, la única forma de que
    // la fila esté bien es que la pantalla haya fundido el desenlace que ya tiene en la mano, sin
    // esperar a la red. Y la fila se lee de UN SOLO DISPARO —`innerText()` en vez de un `expect` que
    // reintenta— porque lo que se afirma es un instante: con reintentos, «se corrige medio segundo
    // después» pasaría por bueno, que es exactamente el fallo.
    //
    // Después se comprueba el otro lado de la obligación 1: que ese refresco sea UNO. `retenidas`
    // dice cuántas lecturas están esperando; si fuera 0, el archivo se habría quedado viejo (nadie
    // pidió la lista nueva) y si fuera 2 o más, el historial estaría sondeando detrás del desenlace.
    test('TC79: al terminar la corrida, la primera fila ya trae el chip correcto y el refresco es uno solo', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_HIST_VIVA, ...HISTORIAL],
        detalle: { [H_VIVA]: { ...RUN_HIST_VIVA_TERMINADA, steps: STEPS }, ...DETALLE_HIST },
      });

      await irASincronizacion(page);
      // Al entrar hay trabajo en marcha: la consola engancha sola (AC4) y el historial lo refleja.
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      await expect(filasHistorial(page).first()).toContainText('En curso');

      runs.congelarTrasElDesenlace = true;
      runs.lista = [RUN_HIST_VIVA_TERMINADA, ...HISTORIAL];

      // El sondeo de la consola trae el desenlace y la tarjeta de resultado aparece arriba.
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();

      const primeraFila = await filasHistorial(page).first().innerText();
      expect(primeraFila, 'la fila trae el desenlace en el mismo momento que la tarjeta')
        .toContain('Completada');
      expect(primeraFila, 'y no el estado viejo que se corrige cuando vuelva la red')
        .not.toContain('En curso');

      // Un refresco. Ni ninguno —el archivo se quedaría con la corrida vieja— ni un sondeo detrás.
      await expect.poll(() => runs.retenidas, { timeout: 5_000 }).toBe(1);
      await pausaMasLargaQueElSondeo(page);
      expect(runs.retenidas, 'un solo refresco al desenlace, no un sondeo').toBe(1);

      runs.soltarLista();
      await expect(filasHistorial(page).first()).toContainText('Completada');
      await expect(anuncio(page)).toContainText(COPY.toastCompletada);
    });

    // TC80 — la región viva sigue siendo UNA con toda la vista desplegada (obligación 3).
    //
    // TC62 ya lo afirma para la consola sola; aquí se comprueba en los cuatro momentos en que la
    // pantalla tiene más piezas encima, que es donde se rompe: historial cargado, tarjeta de
    // resultado arriba, modal abierto CARGANDO y modal lleno. El tercero es el importante: es el
    // momento en que el reflejo del módulo —`role="status"` en el esqueleto, como en
    // `PanelDetalleComparendo`— añadiría la segunda región sin que se note en pantalla.
    //
    // De paso, dos afirmaciones que solo se pueden hacer con todo montado a la vez:
    //   · Una sola tarjeta llamada «Resultado de la corrida». El modal reutiliza el mismo
    //     componente, así que si lo monta con su `role="region"` y su `<h2>` intactos, la vista pasa
    //     a tener dos landmarks homónimos y quien navegue por regiones no sabrá cuál es cuál. El
    //     diálogo ya se nombra a sí mismo con el título de la corrida: dentro no hace falta repetirlo.
    //   · Ninguna alerta. Nada ha fallado, y `role="alert"` está reservado para eso.
    test('TC80: con historial, resultado y modal abiertos a la vez sigue habiendo una sola región viva', async ({ page }) => {
      const runs = await mockRuns(page, { lista: HISTORIAL, detalle: DETALLE_HIST });
      await mockDisparo(page, { tipo: 'responder', status: 200, body: RESULTADO_COMPLETADA });

      // El detalle, retenido desde AQUÍ: una ruta registrada después gana sobre la de `mockRuns`, y
      // el patrón termina en `/…/runs/*`, que no puede tragarse el listado (no lleva barra final).
      const detalle = { soltar: null as (() => void) | null };
      await page.route('**/api/flito/comparendos/sync/runs/*', async (route: Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        runs.llamadasDetalle += 1;
        await new Promise<void>((resolve) => { detalle.soltar = resolve; });
        return route
          .fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(DETALLE_HIST[H_COMPLETADA]),
          })
          .catch(() => undefined);
      });

      await irASincronizacion(page);
      await esperarHistorialCargado(page);
      await expect(anuncio(page), 'con el historial cargado').toHaveCount(1);

      await botonSincronizar(page).click();
      await expect(resultado(page)).toBeVisible();
      await expect(anuncio(page), 'con la tarjeta de resultado arriba').toHaveCount(1);

      await verDetalle(page, 0).click();
      const modal = modalCorrida(page);
      await expect(modal).toBeVisible();
      await expect.poll(() => seDeclaraOcupada(modal), { timeout: 5_000 }).toBe(true);
      await expect(anuncio(page), 'con el modal cargando su detalle').toHaveCount(1);

      detalle.soltar?.();
      await expect(modal).toContainText('Upserts 340');
      await expect(anuncio(page), 'con el modal lleno').toHaveCount(1);

      await expect(page.getByRole('region', { name: 'Resultado de la corrida' }))
        .toHaveCount(1);
      await expect(page.getByRole('alert'), 'no ha fallado nada: no hay alertas').toHaveCount(0);
    });
  });

  // ═══════════════ Carreras entre la carga del archivo y el desenlace de la corrida ═══════════════

  test.describe('Carrera · el desenlace llega antes que la carga inicial', () => {
    // TC84 — el esqueleto eterno, y el TC más traicionero de esta HU: no se ve mirando la pantalla,
    // hay que provocar la carrera.
    //
    // Las dos zonas de la vista leen el MISMO endpoint y no van acompasadas. Se abre la pestaña con
    // una corrida viva: la consola hidrata con su límite corto, engancha el seguimiento y empieza a
    // sondear; el historial pide su primera página y esa lectura —la de veinte— se pierde. Con una
    // red lenta o un proxy que se traga una petición, eso no es una hipótesis de laboratorio: es un
    // martes. Entonces la corrida termina, la consola publica el desenlace, dispara el refresco…
    // y el refresco falla.
    //
    // El estado que queda es el que nadie mira: el historial nunca tuvo una primera respuesta, así
    // que sigue en «cargando», y la única señal de que ahí ya no va a aparecer nada es un
    // `aria-busy` que se quedó en `"true"` para siempre. En pantalla son cinco filas fantasma
    // pulsando con normalidad, indistinguibles de una carga que va lenta; para quien usa lector, un
    // bloque anunciado como ocupado que no termina nunca. Y no hay ningún texto que lo delate, así
    // que ningún TC que afirme sobre copy lo habría encontrado — por eso este afirma sobre el
    // atributo.
    //
    // El desatasco tiene que ser HONESTO: se muestra el error del historial con su reintento, no se
    // finge una tabla vacía («todavía no hay sincronizaciones» sería mentir sobre algo que nadie
    // pudo comprobar) y no se cuela por la puerta de una alerta —que sería una segunda región viva
    // gritando por un archivo que no cargó, mientras la corrida de arriba termina bien—.
    //
    // Su control es TC85, y sin él este caso no significaría nada: pasaría igual si alguien
    // «arreglara» el cuelgue haciendo que cualquier refresco fallido tumbe la lista, que es el
    // defecto contrario y peor.
    test('TC84: si el desenlace llega antes que la carga inicial y su refresco falla, el historial no se queda colgado', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_HIST_VIVA, ...HISTORIAL],
        detalle: { [H_VIVA]: { ...RUN_HIST_VIVA_TERMINADA, steps: STEPS }, ...DETALLE_HIST },
      });
      // La primera página del historial no llega NUNCA; el refresco del desenlace falla; el
      // reintento va bien. La consola, con su límite corto, sigue funcionando con normalidad: si
      // también se le retuviera, no habría desenlace que publicar y no habría carrera que probar.
      runs.planLista = (limite, nEsima) => {
        if (limite !== '20') return null;
        if (nEsima === 1) return 'retener';
        if (nEsima === 2) return { status: 500, body: { error: 'No se pudo listar', codigo: 'error_interno' } };
        return null;
      };

      await irASincronizacion(page);
      // La consola sí arrancó: engancha la corrida viva ella sola (AC4).
      await expect(anuncio(page)).toContainText(COPY.enCurso);
      // Y el historial se quedó esperando su primera página.
      const zona = historial(page);
      await expect.poll(() => seDeclaraOcupada(zona), { timeout: 5_000 }).toBe(true);
      await expect(tablaHistorial(page)).toHaveCount(0);

      // La corrida termina en el servidor. El sondeo de la consola lo detecta, pinta el resultado y
      // dispara el refresco del historial: esa segunda lectura es la que falla.
      runs.lista = [RUN_HIST_VIVA_TERMINADA, ...HISTORIAL];
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();

      // AQUÍ es donde el bloque se quedaba colgado. `aria-busy` es lo único que lo dice.
      await expect.poll(() => seDeclaraOcupada(zona), { timeout: 10_000 }).toBe(false);
      await expect(zona.getByText(COPY_HIST.error)).toBeVisible();
      await expect(zona.getByRole('button', { name: 'Reintentar' })).toBeVisible();
      // Y no se inventa un vacío: nadie ha comprobado que no haya corridas.
      await expect(zona.getByText(COPY_HIST.vacio)).toHaveCount(0);

      // El desatasco no se cuela por la puerta de una alerta, y la región viva sigue siendo una.
      await expect(page.getByRole('alert'), 'un archivo que no carga no es una urgencia').toHaveCount(0);
      await expect(anuncio(page)).toHaveCount(1);

      // La consola de arriba, entera: su tarjeta, su chip y su anuncio de desenlace.
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();
      await expect(anuncio(page)).toContainText(COPY.toastCompletada);

      // Y el reintento —tercera lectura, ya sana— pinta el archivo con la corrida recién terminada
      // arriba, que es la que el operador acaba de ver acabar.
      await zona.getByRole('button', { name: 'Reintentar' }).click();
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length + 1);
      await expect(filasHistorial(page).first()).toContainText('Completada');
      expect(await seDeclaraOcupada(zona), 'con los datos delante ya no está ocupada').toBe(false);
    });

    // TC85 — EL CONTROL de TC84, y la razón de que TC84 signifique algo.
    //
    // Mismo 500 en el refresco del desenlace, pero con la primera página ya cargada. Aquí el fallo
    // NO tiene que verse: lo que hay en pantalla se pidió, llegó y sigue siendo verdad; que no se
    // haya podido refrescar no lo convierte en mentira. Pintar el error aquí sería cambiar una
    // tabla correcta por una banda roja, y de paso perder de vista la corrida que el operador acaba
    // de ver terminar —justo lo que la obligación 2 de la enmienda existe para conservar—.
    //
    // Sin este caso, TC84 se aprobaría con el defecto contrario: «si un refresco falla, tumbo la
    // lista y enseño Reintentar» desatasca el cuelgue y rompe esto. Los dos juntos dicen lo único
    // que hay que decir: el error se muestra cuando no hay NADA que enseñar, no cuando lo último
    // que se pidió salió mal.
    //
    // La fila de arriba llega igualmente al desenlace porque la pantalla lo funde de lo que ya tiene
    // en la mano (TC79), sin depender de esa lectura que falló.
    test('TC85: con la lista ya cargada, un refresco que falla no la tumba ni pide reintentar', async ({ page }) => {
      const runs = await mockRuns(page, {
        lista: [RUN_HIST_VIVA, ...HISTORIAL],
        detalle: { [H_VIVA]: { ...RUN_HIST_VIVA_TERMINADA, steps: STEPS }, ...DETALLE_HIST },
      });
      // Lo único que cambia respecto de TC84: la primera página SÍ llega.
      runs.planLista = (limite, nEsima) => {
        if (limite !== '20' || nEsima !== 2) return null;
        return { status: 500, body: { error: 'No se pudo listar', codigo: 'error_interno' } };
      };

      await irASincronizacion(page);
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length + 1);
      await expect(filasHistorial(page).first()).toContainText('En curso');

      runs.lista = [RUN_HIST_VIVA_TERMINADA, ...HISTORIAL];
      await expect(resultado(page).getByText('Completada', { exact: true })).toBeVisible();

      // El refresco ya falló (segunda lectura de veinte) y se le da tiempo de sobra a la pantalla
      // para reaccionar mal: afirmar una ausencia sin esperar es afirmar que aún no ha pasado.
      await expect.poll(() => limitesDelHistorial(runs).length, { timeout: 10_000 }).toBe(2);
      await pausaMasLargaQueElSondeo(page);

      const zona = historial(page);
      await expect(zona.getByText(COPY_HIST.error), 'lo cargado sigue siendo verdad').toHaveCount(0);
      await expect(zona.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await seDeclaraOcupada(zona), 'ni se queda ocupada por un refresco fallido').toBe(false);

      // La tabla intacta, y su primera fila con el desenlace fundido pese al refresco fallido.
      await expect(filasHistorial(page)).toHaveCount(HISTORIAL.length + 1);
      await expect(filasHistorial(page).first()).toContainText('Completada');
    });
  });
});
