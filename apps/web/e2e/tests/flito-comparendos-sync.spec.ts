// FLITO — Comparendos: la consola de sincronización, disparo y seguimiento (HU #11635, Feature 17c).
//
// Cubre la REGIÓN A de `docs/ux/flito-comparendos-config-sync.md` § «Vista Sincronización — consola
// + historial»: el disparo, el estado en curso, el paso a seguimiento y el resultado terminal. El
// historial de corridas y su modal (Región B) son la HU #11636 y NO se tocan aquí; lo único que este
// archivo asume del historial es que `GET /sync/runs` se lee al montar, porque esa lectura es
// también la que detecta una corrida ya en marcha (AC4).
//
// Numeración: los TCs siguen la serie del Feature, que llega a TC36 en
// `flito-comparendos-pills-config.spec.ts` (HUs #11633 y #11634). Aquí van TC37 a TC64. Ese archivo
// NO se toca desde esta HU.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// GUARDIA DE COBERTURA — ESTE ARCHIVO ESTÁ DESPIERTO
//
// Los 26 TCs originales se escribieron en modo A, antes que la pantalla, y el archivo vivió dormido
// tras el modificador que salta un bloque entero. Despertarlo era el último paso de la
// implementación; el gate B de la HU #11635 lo verificó, corrigió los fixtures que describían un
// mundo imposible (ver `esperarConsolaEnReposo`), añadió el TC63 que faltaba y el TC64 que pidió la
// auditoría de seguridad, y corrió los 28 en verde.
//
// El check sigue siendo obligatorio en cada gate, porque un archivo dormido APARENTA cobertura: el
// runner dice «28 skipped» y pinta verde igual. Se comprueba así, y lo correcto es CERO líneas:
//
//     grep -nE '\.(fixme|skip|only)\(' apps/web/e2e/tests/flito-comparendos-sync.spec.ts
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
import type { Page, Route } from '@playwright/test';
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
  inicial: { lista?: unknown[]; detalle?: Record<string, unknown> } = {},
): Promise<EstadoRuns> {
  const estado: EstadoRuns = {
    lista: inicial.lista ?? [],
    detalle: inicial.detalle ?? {},
    llamadasLista: 0,
    llamadasDetalle: 0,
    idsPedidos: [],
    limites: [],
  };
  await page.route(API_RUNS, (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const id = url.pathname.split('/sync/runs/')[1] ?? '';
    if (id) {
      estado.llamadasDetalle += 1;
      estado.idsPedidos.push(id);
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
    estado.limites.push(url.searchParams.get('limit') ?? '');
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(estado.lista),
    });
  });
  return estado;
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
