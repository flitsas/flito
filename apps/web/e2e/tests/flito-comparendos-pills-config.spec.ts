// FLITO — Comparendos: pestañas (?vista=) y los cuatro bloques de parametrización — NITs y
// municipios (HU #11633), causales de gestión y token SIMIT (HU #11634), Feature 17c.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// GUARDIA DE COBERTURA — ESTE ARCHIVO TIENE QUE ESTAR DESPIERTO
//
// Los 20 TCs originales se escribieron en modo A, antes que la pantalla, y el archivo vivió dormido
// tras el modificador de Playwright que salta un bloque entero. Despertarlo era el último paso de
// la implementación; el gate B de la HU #11633 lo verificó y corrió los 20 en verde.
//
// El check sigue siendo obligatorio en cada gate, porque un archivo dormido APARENTA cobertura: el
// runner dice «20 skipped» y pinta verde igual. Se comprueba así, y lo correcto es CERO líneas:
//
//     grep -nE '\.(fixme|skip|only)\(' apps/web/e2e/tests/flito-comparendos-pills-config.spec.ts
//
// Ese patrón está escrito para no encontrarse a sí mismo. La versión anterior de este comentario
// citaba el modificador en prosa y el grep devolvía dos aciertos sobre su propia explicación: el
// verde del check exigía abrir el archivo y leer para descubrir que los aciertos eran comentarios.
// Un check que hay que interpretar no es un check. Si algún día hay que volver a dormir un bloque,
// el modificador se pone en el código y no se nombra aquí arriba.
//
// Los selectores son **contrato**, no adivinanza: salen del copy exacto de
// `docs/ux/flito-comparendos-config-sync.md` (§ pestañas y § bloques 1 a 4) y de sus notas de a11y. Se afirma por rol y por texto visible —nunca por clase CSS ni por
// `data-testid` inventado— para que el spec falle cuando cambie lo que el operador ve, no cuando
// cambie el marcado.
//
// QUÉ FALLOS PERSIGUE (los tres que no se notan mirando la pantalla feliz):
//
//   1. **La vista deja de ser un destino.** Si `?vista=` no manda de verdad —o si un valor basura
//      deja la página en blanco en vez de caer a Registros— el enlace que un operador se guarda o
//      se manda por correo se convierte en una pantalla rota. Por eso hay TCs de deep link y de
//      valor inválido, no solo de clic en la pill.
//   2. **Los bloques se tumban entre sí.** Config carga cuatro catálogos en paralelo; el fallo
//      silencioso es que un 500 de municipios se lleve por delante la tabla de NITs (o al revés) y
//      el operador crea que perdió su parametrización. TC17 afirma justo esa independencia.
//   3. **El desactivar se disfraza de eliminar.** `nit_en_uso` (409) es la barrera que impide dejar
//      histórico huérfano. Si la UI trata ese 409 como un error genérico —o peor, si borra la fila
//      de la tabla en optimista antes de saber la respuesta— el operador cree que eliminó un NIT
//      que sigue vivo. TC12 mira las dos mitades: el copy que ofrece desactivar Y que la fila sigue.
//   4. **El token se escapa por donde nadie mira** (HU #11634). Que no se pinte en pantalla es lo
//      fácil y lo que cualquiera comprueba a ojo. Lo que no se ve es el `console.log` de depuración
//      que quedó puesto, el `<form>` sin `preventDefault()` que manda el secreto por GET y lo deja
//      en la barra de direcciones y en el historial, o el valor que acaba en `localStorage`. TC28
//      persigue esas cuatro salidas a la vez, buscando un PREFIJO del valor —porque lo prohibido no
//      es solo el token entero, también un fragmento— en la URL, en la consola, en el
//      almacenamiento y en el texto de la página.
//   5. **El orden de las causales deja de ser el del negocio** (HU #11634). El selector del visor
//      las ofrece en la secuencia en que se usan, no alfabéticamente; si la pantalla ordena por
//      nombre —o mete la causal nueva al final en vez de en su sitio— nadie lo nota mirando la
//      tabla, porque una lista ordenada parece ordenada de todas formas. TC22 y TC23 usan un
//      fixture donde las dos ordenaciones se contradicen a propósito.
//
// PII y secretos: todos los NITs, códigos, nombres y tokens son SINTÉTICOS («900123456»,
// «830009988», «ITAGUI», «tok-simit-DEMO-…»). Ni un dato real entra en un spec ni en un fixture
// (Ley 1581). El NIT se muestra completo en pantalla —es el eje del módulo y solo lo ve `admin`—
// pero NUNCA viaja en la URL del SPA: TC03 lo afirma. El token no se muestra NUNCA, ni un
// fragmento: TC27 y TC28.
// ══════════════════════════════════════════════════════════════════════════════════════════════
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const API_NITS = '**/api/flito/comparendos/nits';
const API_NIT_ID = '**/api/flito/comparendos/nits/*';
const API_MUNICIPIOS = '**/api/flito/comparendos/municipios';
const API_MUNICIPIO_ID = '**/api/flito/comparendos/municipios/*';

const SELLO = { creadoEn: '2026-07-02T08:12:00Z', actualizadoEn: '2026-08-14T08:07:00Z' };

const NIT_ACTIVO = { id: 'n1', nit: '900123456', alias: 'Transportes Andinos SAS', activo: true, ...SELLO };
// Sin alias a propósito: `null` es información y la celda tiene que pintar «—», no vacío.
const NIT_INACTIVO = { id: 'n2', nit: '830009988', alias: null, activo: false, ...SELLO };
const NIT_SIN_HISTORICO = { id: 'n3', nit: '900111222', alias: 'Prueba tipográfica', activo: true, ...SELLO };

const MUNI_ACTIVO = { id: 'm1', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, ...SELLO };
const MUNI_INACTIVO = { id: 'm2', codigoFuente: 'ENVIGADO', nombre: 'Envigado', activo: false, ...SELLO };

const NITS = [NIT_ACTIVO, NIT_INACTIVO, NIT_SIN_HISTORICO];

/**
 * El subtítulo de cada pestaña, palabra por palabra.
 *
 * Va copiado y no importado de `navegacionComparendos.tsx` a propósito: importando la constante, el
 * TC diría «el subtítulo es el que diga el código», que es una tautología que pasa siempre. Copiado
 * dice «el subtítulo es ESTE», que es lo que el AC1 pide y lo que falla cuando alguien lo cambia.
 *
 * El de `registros` es el de la HU #11560 sin tocar una coma: la #11633 trasladó el visor de sitio,
 * y trasladar no es reescribir.
 */
const SUBTITULO = {
  registros:
    'Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen de la fuente '
    + 'y no se editan aquí: lo único que se registra es la causal y la observación de gestión.',
  sincronizacion:
    'Consulta SIMIT y los municipios activos sobre los NIT vigilados. No hay corrida automática: '
    + 'cada sincronización la disparas tú.',
  configuracion:
    'NIT vigilados, municipios fuente, causales de gestión y el token SIMIT. Sin esto, la '
    + 'sincronización no tiene qué consultar.',
} as const;
const MUNICIPIOS = [MUNI_ACTIVO, MUNI_INACTIVO];

// ── Causales y token (HU #11634) ───────────────────────────────────────────────────────────────

const API_CAUSALES = '**/api/flito/comparendos/causales';
const API_CAUSAL_ID = '**/api/flito/comparendos/causales/*';
const API_TOKEN = '**/api/flito/comparendos/config/token-simit';

// Llegan en el orden en que responde `GET /causales` (por `orden`, y a igualdad por nombre), que es
// justo el que NO coincide con el alfabético: alfabéticamente iría «En gestión jurídica» primero.
// Esa discordancia es la que hace de TC22 una prueba y no una tautología.
const CAUSAL_NOTIFICADO = { id: 'c1', nombre: 'Notificado al cliente', activo: true, orden: 10, ...SELLO };
const CAUSAL_PAGADO = { id: 'c2', nombre: 'Pagado', activo: true, orden: 20, ...SELLO };
const CAUSAL_JURIDICA = { id: 'c3', nombre: 'En gestión jurídica', activo: false, orden: 30, ...SELLO };
const CAUSALES = [CAUSAL_NOTIFICADO, CAUSAL_PAGADO, CAUSAL_JURIDICA];

// `actualizadoEn` en UTC: 14:14Z son las 09:14 en Bogotá, que es la hora del wireframe. Si la
// pantalla olvidara el `timeZone`, un runner en UTC pintaría «14:14» y el TC lo diría.
const TOKEN_CONFIGURADO = {
  configurado: true,
  actualizadoEn: '2026-08-14T14:14:00Z',
  actualizadoPor: { id: 7, nombre: 'María Ruiz' },
  keyVersion: 2,
};
const TOKEN_SIN_AUTOR = { ...TOKEN_CONFIGURADO, actualizadoPor: null };
const TOKEN_SIN_CONFIGURAR = {
  configurado: false, actualizadoEn: null, actualizadoPor: null, keyVersion: null,
};

/**
 * El valor que se escribe en el campo del token. SINTÉTICO y reconocible a simple vista.
 *
 * Es la aguja de los TCs de fuga: se busca literal en la URL, en la consola, en el DOM y en el
 * almacenamiento del navegador. Lleva «DEMO» dentro para que, si algún día aparece en un log o en
 * una captura, quede claro en el acto que no es una credencial de verdad.
 */
const TOKEN_ESCRITO = 'tok-simit-DEMO-9f3a2b7c4d';

// ─────────────────────────────────── Mocks con traza ────────────────────────────────────────────

interface Respuesta { status: number; body: unknown }

/**
 * Mock de LECTURA por valor mutable, no por cola de respuestas.
 *
 * En desarrollo React monta en `StrictMode` y el efecto corre dos veces: una cola «primero 500,
 * después 200» le serviría el 200 al segundo montaje y el test miraría un estado que el usuario
 * nunca ve. Con un valor mutable manda el test, no el orden de los efectos. Misma decisión que en
 * `flito-comparendos-cascaron.spec.ts`.
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

interface Escritura { metodo: string; url: string; cuerpo: Record<string, unknown> | null }

/** Mock de ESCRITURA que guarda método y cuerpo: media docena de TCs afirman sobre lo enviado. */
async function mockEscritura(page: Page, url: string, inicial: Respuesta) {
  const estado = { respuesta: inicial, peticiones: [] as Escritura[] };
  await page.route(url, (route: Route) => {
    const metodo = route.request().method();
    if (metodo === 'GET') return route.fallback();
    let cuerpo: Record<string, unknown> | null;
    try { cuerpo = route.request().postDataJSON() as Record<string, unknown>; } catch { cuerpo = null; }
    estado.peticiones.push({ metodo, url: route.request().url(), cuerpo });
    return route.fulfill({
      status: estado.respuesta.status,
      contentType: 'application/json',
      body: estado.respuesta.status === 204 ? '' : JSON.stringify(estado.respuesta.body),
    });
  });
  return estado;
}

/** Los cuatro bloques de Configuración, todos en verde salvo lo que el TC cambie. */
async function mockConfigFeliz(page: Page) {
  const nits = await mockLectura(page, API_NITS, { status: 200, body: NITS });
  const municipios = await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
  const causales = await mockLectura(page, API_CAUSALES, { status: 200, body: CAUSALES });
  const token = await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_CONFIGURADO });
  return { nits, municipios, causales, token };
}

const bloqueNits = (page: Page) => page.getByRole('region', { name: /NIT.? monitoreados/i });
const bloqueMunicipios = (page: Page) => page.getByRole('region', { name: /Municipios fuente/i });
const bloqueCausales = (page: Page) => page.getByRole('region', { name: /Causales de gestión/i });
const bloqueToken = (page: Page) => page.getByRole('region', { name: 'Token SIMIT' });

/**
 * Recoge TODO lo que la página escriba en la consola, desde antes de navegar.
 *
 * Es la mitad que no se ve de la regla del token: que el valor no se pinte es fácil de comprobar
 * mirando; que no acabe en un `console.log` de depuración —de los que se dejan puestos y nadie mira
 * en producción, pero cualquiera con la pestaña abierta lee— solo lo detecta un oyente puesto antes
 * de que la página cargue.
 */
function consolaDe(page: Page): string[] {
  const mensajes: string[] = [];
  page.on('console', (m) => mensajes.push(m.text()));
  return mensajes;
}

/**
 * El almacenamiento del navegador, en texto plano, para buscar la aguja dentro.
 *
 * Se serializa entero en vez de mirar una clave concreta: el fallo que se persigue no es «alguien
 * guardó el token en la clave `token`», es «el token acabó en algún sitio persistente», y una
 * búsqueda por clave solo encontraría el descuido que ya se sospechaba.
 */
async function almacenamiento(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
}

async function irAConfiguracion(page: Page) {
  await page.goto('/flito/comparendos?vista=configuracion');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · pestañas y parametrización (HU #11633 · #11634)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El visor de la pestaña Registros no es el sujeto de esta HU, pero se monta: se le da una
    // página vacía-con-datos para que no sea él quien haga fallar un TC de navegación.
    await mockLectura(page, API_REGISTROS, { status: 200, body: { items: [], nextCursor: null } });
    // Los cuatro bloques de Configuración se montan juntos desde la HU #11634, así que causales y
    // token responden por defecto en TODOS los TCs —también en los 21 de la #11633, que no los
    // nombran—. Sin esto, sus peticiones se irían a la red de verdad y cada TC de configuración
    // arrastraría dos bloques en estado de error que nadie pidió. Un `page.route` registrado
    // después dentro de un TC tiene prioridad sobre este, así que sigue siendo un DEFECTO, no una
    // imposición: quien necesite un 500 o una respuesta retenida la registra en su propio test.
    await mockLectura(page, API_CAUSALES, { status: 200, body: CAUSALES });
    await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_CONFIGURADO });
  });

  // ──────────────────────────── Pestañas y ?vista= (navegación) ─────────────────────────────────

  test.describe('Pestañas · ?vista=', () => {
    // TC01 — happy path de navegación.
    test('TC01: sin ?vista= abre Registros y las tres pills están anunciadas como tabs', async ({ page }) => {
      await mockConfigFeliz(page);
      await page.goto('/flito/comparendos');

      const tabs = page.getByRole('tablist', { name: 'Secciones de comparendos' });
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('tab')).toHaveText(['Registros', 'Sincronización', 'Configuración']);
      await expect(tabs.getByRole('tab', { name: 'Registros' })).toHaveAttribute('aria-selected', 'true');
      // El default NO ensucia la URL del operador (decisión de UX: se omite el param, no se escribe
      // `?vista=registros`).
      await expect(page).toHaveURL(/\/flito\/comparendos$/);
    });

    // TC02 — la pill cambia la URL, y la URL es lo que hace del destino algo compartible.
    test('TC02: al pulsar Configuración la URL queda en ?vista=configuracion sin recarga dura', async ({ page }) => {
      await mockConfigFeliz(page);
      await page.goto('/flito/comparendos');

      // Marca en la ventana: si la SPA recargara de verdad, este valor se pierde y el TC lo delata.
      await page.evaluate(() => { (window as unknown as { __sinRecarga?: boolean }).__sinRecarga = true; });

      await page.getByRole('tab', { name: 'Configuración' }).click();

      await expect(page).toHaveURL(/[?&]vista=configuracion\b/);
      await expect(page.getByRole('tab', { name: 'Configuración' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expect(bloqueNits(page)).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __sinRecarga?: boolean }).__sinRecarga)).toBe(true);

      // Y de vuelta: Registros limpia el param en lugar de dejar `vista=registros` colgando.
      await page.getByRole('tab', { name: 'Registros' }).click();
      await expect(page).toHaveURL(/\/flito\/comparendos$/);
    });

    // TC03 — deep link: es el motivo por el que la vista vive en la URL y no solo en un useState.
    test('TC03: ?vista=sincronizacion abre esa pestaña en frío y la URL no lleva PII', async ({ page }) => {
      await mockConfigFeliz(page);
      await page.goto('/flito/comparendos?vista=sincronizacion');

      await expect(page.getByRole('tab', { name: 'Sincronización' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Registros' })).toHaveAttribute('aria-selected', 'false');
      // `vista` no es PII y puede ir en la query; NIT y placa no. Guardia de la regla, no del caso.
      expect(page.url()).not.toMatch(/900123456|830009988/);
    });

    // TC04 — BORDE: el valor que nadie escribe a mano pero que llega igual (enlace viejo, typo,
    // param manipulado). Cae a Registros; no pantalla en blanco, no `role="alert"`.
    test('TC04: ?vista=basura cae a Registros sin romper la pantalla', async ({ page }) => {
      await mockConfigFeliz(page);
      await page.goto('/flito/comparendos?vista=jajaja');

      await expect(page.getByRole('tab', { name: 'Registros' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tablist', { name: 'Secciones de comparendos' })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    // TC05 — a11y: sin `aria-selected` correcto un lector de pantalla no sabe dónde está, y sin el
    // foco en el `h2` del panel el tabulador vuelve a empezar desde el navbar en cada cambio.
    test('TC05: al cambiar de pestaña el foco aterriza en el título del panel', async ({ page }) => {
      await mockConfigFeliz(page);
      await page.goto('/flito/comparendos');

      await page.getByRole('tab', { name: 'Configuración' }).click();

      const panel = page.getByRole('tabpanel');
      await expect(panel).toBeVisible();
      const enfocado = page.locator(':focus');
      await expect(enfocado).toHaveRole('heading');
      await expect(enfocado).toHaveAttribute('tabindex', '-1');
    });

    // TC21 — AC1, la parte que este spec no cubría: cada pestaña trae SU subtítulo.
    //
    // Es un hallazgo del gate B de esta misma HU. Los tres textos existían y eran correctos, pero
    // la invariante «el de Registros es el del #11560 palabra por palabra» vivía solo en un
    // comentario de `navegacionComparendos.tsx`, y un comentario no falla cuando alguien lo
    // incumple. Con tres frases parecidas en tres pestañas, el fallo realista no es que
    // desaparezcan —eso se ve—: es que dos se intercambien y nadie lo note hasta que un operador
    // lea en Configuración que la pantalla «consulta SIMIT», y se vaya a buscar el botón.
    test('TC21: cada pestaña trae su subtítulo, y el de Registros es el del visor palabra por palabra', async ({ page }) => {
      await mockConfigFeliz(page);

      const afirmarSubtitulo = async (vista: keyof typeof SUBTITULO) => {
        // El título de la pantalla NO se mueve: el subtítulo es lo único que cambia con la pestaña,
        // así que afirmarlo aquí es lo que convierte «hay un texto» en «hay ESTE texto y el resto
        // de la cabecera sigue en su sitio».
        await expect(page.getByRole('heading', { level: 1, name: 'Comparendos monitoreados' })).toBeVisible();
        await expect(page.getByText(SUBTITULO[vista], { exact: true })).toBeVisible();
        // Y los otros dos no están en pantalla. Sin esta mitad, un subtítulo repetido en las tres
        // pestañas —o dos intercambiados— pasaría el TC: bastaría con que el esperado apareciese
        // en alguna parte. `exact` porque las tres frases comparten vocabulario («SIMIT», «NIT»).
        for (const [otra, texto] of Object.entries(SUBTITULO)) {
          if (otra === vista) continue;
          await expect(page.getByText(texto, { exact: true })).toHaveCount(0);
        }
      };

      await page.goto('/flito/comparendos');
      await afirmarSubtitulo('registros');

      await page.getByRole('tab', { name: 'Sincronización' }).click();
      await afirmarSubtitulo('sincronizacion');

      await page.getByRole('tab', { name: 'Configuración' }).click();
      await afirmarSubtitulo('configuracion');

      // Y en frío, no solo navegando: quien llega por un enlace guardado tiene que leer el
      // subtítulo de la sección a la que llegó, no el de la que abre por defecto.
      await page.goto('/flito/comparendos?vista=configuracion');
      await afirmarSubtitulo('configuracion');
    });
  });

  // ─────────────────────────── Bloque 1 — NITs monitoreados ─────────────────────────────────────

  test.describe('Configuración · NITs monitoreados', () => {
    // TC06 — LLENO: el inactivo NO se oculta. Ocultarlo es el fallo caro: sin fila no hay botón
    // [Activar] y el NIT queda inalcanzable desde la pantalla que existe para gobernarlo.
    test('TC06: la tabla lista activos e inactivos, y el inactivo ofrece [Activar]', async ({ page }) => {
      await mockConfigFeliz(page);
      await irAConfiguracion(page);

      const bloque = bloqueNits(page);
      await expect(bloque.getByText('900123456')).toBeVisible();
      await expect(bloque.getByText('830009988')).toBeVisible();
      await expect(bloque.getByText('Transportes Andinos SAS')).toBeVisible();

      const filaInactiva = bloque.getByRole('row', { name: /830009988/ });
      // El estado se lee por su etiqueta, no por el color del punto (a11y: nada solo por color).
      await expect(filaInactiva.getByText('Inactivo')).toBeVisible();
      await expect(filaInactiva.getByRole('button', { name: 'Activar' })).toBeVisible();
      await expect(bloque.getByRole('row', { name: /900123456/ }).getByRole('button', { name: 'Desactivar' })).toBeVisible();
    });

    // TC07 — CARGANDO: anunciado, y sin adelantar el vacío. Pintar «Todavía no hay NIT» mientras la
    // petición vuela es el bug que hace que alguien cree un NIT que ya existía.
    test('TC07: cargando se anuncia con aria-busy y no muestra ni error ni vacío', async ({ page }) => {
      let soltar: (() => void) | null = null;
      const retenida = new Promise<void>((resolve) => { soltar = resolve; });
      await page.route(API_NITS, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await retenida;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NITS) });
      });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });

      await irAConfiguracion(page);

      const cargando = bloqueNits(page).getByRole('status', { name: 'Cargando NITs monitoreados' });
      await expect(cargando).toBeVisible();
      await expect(cargando).toHaveAttribute('aria-busy', 'true');
      await expect(bloqueNits(page).getByText(/Todavía no hay NIT monitoreados/)).toHaveCount(0);
      await expect(bloqueNits(page).getByRole('alert')).toHaveCount(0);

      soltar?.();
      await expect(bloqueNits(page).getByText('900123456')).toBeVisible();
      await expect(cargando).toHaveCount(0);
    });

    // TC08 — ERROR + reintento, sin eco del servidor (misma decisión que la #11559: el texto del
    // API no se pinta; el copy se deriva del estado).
    test('TC08: error muestra el copy propio con [Reintentar] y el reintento vuelve a pedir', async ({ page }) => {
      const nits = await mockLectura(page, API_NITS, {
        status: 500,
        body: { error: 'relation "flito_comparendos_nits" does not exist', codigo: 'interno' },
      });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });

      await irAConfiguracion(page);

      const bloque = bloqueNits(page);
      await expect(bloque.getByText('No se pudieron cargar los NIT monitoreados. Vuelve a intentarlo.')).toBeVisible();
      // Ni una palabra del servidor en pantalla: ni la tabla, ni el código, ni el stack.
      await expect(page.getByText(/relation|does not exist/i)).toHaveCount(0);

      const llamadasAntes = nits.llamadas;
      nits.respuesta = { status: 200, body: NITS };
      await bloque.getByRole('button', { name: 'Reintentar' }).click();

      await expect(bloque.getByText('900123456')).toBeVisible();
      expect(nits.llamadas).toBeGreaterThan(llamadasAntes);
      await expect(bloque.getByText('No se pudieron cargar los NIT monitoreados. Vuelve a intentarlo.')).toHaveCount(0);
    });

    // TC09 — VACÍO: el copy dice qué hacer, no solo que no hay nada.
    test('TC09: vacío explica el siguiente paso y ofrece [Agregar NIT]', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: [] });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });

      await irAConfiguracion(page);

      const bloque = bloqueNits(page);
      await expect(bloque.getByText('Todavía no hay NIT monitoreados.')).toBeVisible();
      await expect(bloque.getByText('Agrega al menos uno antes de sincronizar.')).toBeVisible();
      await expect(bloque.getByRole('button', { name: 'Agregar NIT' })).toBeVisible();
      await expect(bloque.getByRole('alert')).toHaveCount(0);
    });

    // TC10 — ALTA (happy): el NIT se normaliza AL ENVIAR y el campo no se reescribe mientras se
    // teclea. Reescribir el input bajo los dedos mueve el cursor al final y hace imposible corregir
    // un dígito del medio; por eso la normalización es del envío, no del `onChange`.
    test('TC10: alta con puntos envía el NIT normalizado, no reescribe el campo y confirma con toast', async ({ page }) => {
      const nits = await mockLectura(page, API_NITS, { status: 200, body: [] });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      const alta = await mockEscritura(page, API_NITS, {
        status: 201,
        body: { id: 'n9', nit: '900123456-1', alias: 'Transportes Andinos SAS', activo: true, ...SELLO },
      });

      await irAConfiguracion(page);
      await bloqueNits(page).getByRole('button', { name: 'Agregar NIT' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar NIT' });
      const campoNit = modal.getByLabel(/^NIT/);
      await campoNit.fill('900.123.456-1');
      // Lo escrito sigue escrito: el campo es del humano hasta que se envía.
      await expect(campoNit).toHaveValue('900.123.456-1');
      await modal.getByLabel(/^Alias/).fill('Transportes Andinos SAS');

      nits.respuesta = { status: 200, body: [{ id: 'n9', nit: '900123456-1', alias: 'Transportes Andinos SAS', activo: true, ...SELLO }] };
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal).toHaveCount(0);
      await expect(page.getByText('NIT agregado.')).toBeVisible();
      expect(alta.peticiones).toHaveLength(1);
      expect(alta.peticiones[0].metodo).toBe('POST');
      // Sin puntos ni espacios; el guion del DV se conserva (`normalizarNit` solo quita `[\s.]`).
      expect(alta.peticiones[0].cuerpo).toMatchObject({ nit: '900123456-1', alias: 'Transportes Andinos SAS' });
      await expect(bloqueNits(page).getByText('900123456-1')).toBeVisible();
    });

    // TC11 — BORDE/ERROR: 409 `nit_duplicado`. Se ramifica por `codigo`, no por el texto del
    // mensaje. El fallo que persigue: cerrar el modal y añadir la fila igual, dejando dos filas con
    // el mismo NIT hasta el próximo refresco.
    test('TC11: NIT duplicado muestra el error bajo el formulario y no duplica la fila', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: [NIT_ACTIVO] });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      await mockEscritura(page, API_NITS, {
        status: 409,
        body: { error: 'El NIT 900123456 ya está en el catálogo de monitoreo.', codigo: 'nit_duplicado' },
      });

      await irAConfiguracion(page);
      await bloqueNits(page).getByRole('button', { name: 'Agregar NIT' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar NIT' });
      await modal.getByLabel(/^NIT/).fill('900123456');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      // El modal se queda abierto con el error a la vista: el operador tiene que poder corregir sin
      // volver a abrir nada.
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('alert')).toContainText(/ya (está|existe)|duplicad/i);
      await expect(page.getByText('NIT agregado.')).toHaveCount(0);
      // Una fila, no dos.
      await expect(bloqueNits(page).getByRole('row', { name: /900123456/ })).toHaveCount(1);
    });

    // TC12 — ERROR de negocio: 409 `nit_en_uso`. Es la mitad de la HU que protege el histórico.
    test('TC12: eliminar un NIT con histórico ofrece desactivarlo y la fila no desaparece', async ({ page }) => {
      const nits = await mockLectura(page, API_NITS, { status: 200, body: NITS });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      const escritura = await mockEscritura(page, API_NIT_ID, {
        status: 409,
        body: {
          error: 'El NIT ya tiene 42 comparendo(s) registrados y no se puede eliminar.',
          codigo: 'nit_en_uso',
        },
      });

      await irAConfiguracion(page);
      const fila = bloqueNits(page).getByRole('row', { name: /900111222/ });
      await fila.getByRole('button', { name: 'Eliminar' }).click();

      // El modal de borrado SIEMPRE se abre, y su botón primario es quien dispara el DELETE: no es
      // un paso opcional. Antes se pulsaba tras un `if (await ...count())`, que es una foto del DOM
      // en un instante: con el modal todavía sin montar, el TC se saltaba el clic EN SILENCIO y
      // reventaba después, en la aserción del 409, culpando a la pantalla de algo que nunca se le
      // llegó a pedir.
      const modalEliminar = page.getByRole('dialog', { name: 'Eliminar NIT 900111222' });
      await expect(modalEliminar).toBeVisible();
      await modalEliminar.getByRole('button', { name: 'Eliminar', exact: true }).click();

      await expect(modalEliminar.getByRole('alert')).toContainText(
        'Este NIT ya tiene comparendos registrados y no se puede eliminar. Desactívalo para conservar el histórico.',
      );
      // La fila sigue: nada de optimismo antes de conocer la respuesta.
      await expect(bloqueNits(page).getByRole('row', { name: /900111222/ })).toBeVisible();

      // Y la salida ofrecida funciona: [Desactivar] hace PATCH { activo: false }.
      escritura.respuesta = { status: 200, body: { ...NIT_SIN_HISTORICO, activo: false } };
      nits.respuesta = { status: 200, body: [NIT_ACTIVO, NIT_INACTIVO, { ...NIT_SIN_HISTORICO, activo: false }] };
      // El [Desactivar] que ofrece el modal lo cierra en el acto y deja el PATCH en manos del
      // bloque: NO encadena una segunda confirmación, porque ya se pidió eliminar, que es más. Se
      // afirma que el modal se va, en vez de rebuscar a ciegas en un diálogo que se está
      // desmontando mientras se le pregunta.
      await modalEliminar.getByRole('button', { name: 'Desactivar' }).click();
      await expect(modalEliminar).toBeHidden();

      // `expect.poll` y no lectura síncrona del array: el clic vuelve del navegador por un camino y
      // la interceptación de `page.route` se registra por otro, en Node. Leer `peticiones` justo
      // después del clic es apostar a cuál de los dos llega antes, y esa apuesta se pierde bajo
      // carga —en CI, o en una corrida local larga— sin que nada haya cambiado en la pantalla.
      await expect.poll(
        () => escritura.peticiones.find((p) => p.metodo === 'PATCH')?.cuerpo,
        { message: 'el [Desactivar] ofrecido tras el 409 tiene que mandar PATCH { activo: false }' },
      ).toMatchObject({ activo: false });
      await expect(bloqueNits(page).getByRole('row', { name: /900111222/ }).getByText('Inactivo')).toBeVisible();
    });

    // TC13 — DESACTIVAR normal: con confirmación, `PATCH { activo: false }` (nunca DELETE) y la
    // fila se queda en la tabla con su [Activar].
    test('TC13: desactivar confirma, manda PATCH { activo: false } y conserva la fila', async ({ page }) => {
      const nits = await mockLectura(page, API_NITS, { status: 200, body: [NIT_ACTIVO] });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      const escritura = await mockEscritura(page, API_NIT_ID, { status: 200, body: { ...NIT_ACTIVO, activo: false } });

      await irAConfiguracion(page);
      await bloqueNits(page).getByRole('row', { name: /900123456/ }).getByRole('button', { name: 'Desactivar' }).click();

      const confirmacion = page.getByRole('dialog');
      await expect(confirmacion).toContainText(
        'Dejará de consultarse en la próxima sincronización. Los comparendos ya registrados se conservan.',
      );
      nits.respuesta = { status: 200, body: [{ ...NIT_ACTIVO, activo: false }] };
      await confirmacion.getByRole('button', { name: /Desactivar|Confirmar/ }).click();

      await expect(page.getByText('NIT desactivado.')).toBeVisible();
      expect(escritura.peticiones.map((p) => p.metodo)).toEqual(['PATCH']);
      expect(escritura.peticiones[0].cuerpo).toMatchObject({ activo: false });
      const fila = bloqueNits(page).getByRole('row', { name: /900123456/ });
      await expect(fila.getByText('Inactivo')).toBeVisible();
      await expect(fila.getByRole('button', { name: 'Activar' })).toBeVisible();
    });

    // TC14 — BORDE de validación: el alfabeto se cierra en el cliente además del servidor, y sobre
    // todo NO se gasta una petición (el alta tiene limitador de tasa).
    test('TC14: un NIT con letras no se envía y el error sale en el campo', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: [] });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      const alta = await mockEscritura(page, API_NITS, { status: 201, body: NIT_ACTIVO });

      await irAConfiguracion(page);
      await bloqueNits(page).getByRole('button', { name: 'Agregar NIT' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar NIT' });
      await modal.getByLabel(/^NIT/).fill('ABC12');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal).toBeVisible();
      // Se afirma sobre la ALERTA del formulario y no sobre el texto suelto del modal (HU #11633):
      // el formulario explica el formato admitido en su ayuda —«Solo dígitos…», «el guion del
      // dígito de verificación se conserva»— así que buscar esas palabras en todo el diálogo
      // encuentra dos elementos y no distingue la ayuda del error. `role="alert"` es además lo que
      // hace que el fallo se anuncie a quien no ve la pantalla, que es lo que el TC persigue.
      //
      // Y el texto que se busca es el del ERROR, no vocabulario que la ayuda comparte: «solo
      // dígitos» y «dígito de verificación» están en las dos frases. Hoy no colisionan porque la
      // búsqueda va dentro de la alerta, pero el día que alguien meta la ayuda dentro de
      // `ErrorFormulario` el TC pasaría en vacío, afirmando sobre un texto que está siempre.
      await expect(modal.getByRole('alert')).toContainText('El NIT admite solo dígitos');
      expect(alta.peticiones).toHaveLength(0);
    });
  });

  // ─────────────────────────── Bloque 2 — Municipios fuente ─────────────────────────────────────

  test.describe('Configuración · Municipios fuente', () => {
    // TC15 — LLENO: código y nombre son dos columnas, y el inactivo sigue visible. Además: aquí NO
    // hay [Eliminar] (el API no expone DELETE de municipio) — ofrecerlo sería un botón que siempre
    // falla.
    test('TC15: lista código y nombre, muestra el inactivo y no ofrece [Eliminar]', async ({ page }) => {
      await mockConfigFeliz(page);
      await irAConfiguracion(page);

      const bloque = bloqueMunicipios(page);
      await expect(bloque.getByText('ITAGUI')).toBeVisible();
      await expect(bloque.getByText('Itagüí')).toBeVisible();
      const filaInactiva = bloque.getByRole('row', { name: /ENVIGADO/ });
      await expect(filaInactiva.getByText('Inactivo')).toBeVisible();
      await expect(filaInactiva.getByRole('button', { name: 'Activar' })).toBeVisible();
      await expect(bloque.getByRole('button', { name: 'Eliminar' })).toHaveCount(0);
    });

    // TC16 — CARGANDO y VACÍO del bloque, con su propio copy (el vacío de municipios dice algo
    // distinto al de NITs: sin municipios el módulo TODAVÍA sirve, solo consulta SIMIT).
    test('TC16: municipios anuncia su carga y su vacío con copy propio', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      let soltar: (() => void) | null = null;
      const retenida = new Promise<void>((resolve) => { soltar = resolve; });
      await page.route(API_MUNICIPIOS, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await retenida;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });

      await irAConfiguracion(page);

      const bloque = bloqueMunicipios(page);
      await expect(bloque.getByRole('status')).toHaveAttribute('aria-busy', 'true');
      soltar?.();

      await expect(bloque.getByText(
        'No hay municipios configurados. Sin municipios activos solo se consulta SIMIT (si el token está listo).',
      )).toBeVisible();
      await expect(bloque.getByRole('button', { name: 'Agregar municipio' })).toBeVisible();
    });

    // TC17 — AISLAMIENTO (el fallo #2 del encabezado): municipios en 500 mientras NITs responde
    // 200. Cada bloque tiene sus cuatro estados POR SU CUENTA.
    test('TC17: el error de municipios no tumba la tabla de NITs', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      const municipios = await mockLectura(page, API_MUNICIPIOS, { status: 500, body: { error: 'boom', codigo: 'interno' } });

      await irAConfiguracion(page);

      await expect(bloqueMunicipios(page).getByRole('button', { name: 'Reintentar' })).toBeVisible();
      await expect(page.getByText(/boom/)).toHaveCount(0);
      // Los NITs, intactos: ni error, ni vacío, ni bloque desaparecido.
      await expect(bloqueNits(page).getByText('900123456')).toBeVisible();
      await expect(bloqueNits(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);

      municipios.respuesta = { status: 200, body: MUNICIPIOS };
      await bloqueMunicipios(page).getByRole('button', { name: 'Reintentar' }).click();
      await expect(bloqueMunicipios(page).getByText('ITAGUI')).toBeVisible();
      await expect(bloqueNits(page).getByText('900123456')).toBeVisible();
    });

    // TC18 — ALTA: el código se normaliza a MAYÚSCULAS al enviar. Es lo que viaja literal a UTS: un
    // «itagüí» guardado hoy es un municipio que «no devuelve nada» dentro de tres semanas.
    test('TC18: el código de fuente viaja normalizado a mayúsculas', async ({ page }) => {
      const municipios = await mockLectura(page, API_MUNICIPIOS, { status: 200, body: [] });
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      const alta = await mockEscritura(page, API_MUNICIPIOS, {
        status: 201,
        body: { id: 'm9', codigoFuente: 'BELLO', nombre: 'Bello', activo: true, ...SELLO },
      });

      await irAConfiguracion(page);
      await bloqueMunicipios(page).getByRole('button', { name: 'Agregar municipio' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar municipio' });
      await modal.getByLabel(/Código/i).fill('bello');
      await modal.getByLabel(/Nombre/i).fill('Bello');
      municipios.respuesta = { status: 200, body: [{ id: 'm9', codigoFuente: 'BELLO', nombre: 'Bello', activo: true, ...SELLO }] };
      await modal.getByRole('button', { name: 'Guardar' }).click();

      expect(alta.peticiones).toHaveLength(1);
      expect(alta.peticiones[0].cuerpo).toMatchObject({ codigoFuente: 'BELLO', nombre: 'Bello' });
      // Por CELDA y `exact`, no por texto (HU #11633): `getByText('BELLO')` es una coincidencia por
      // subcadena e insensible a mayúsculas, así que casa también con la celda del nombre («Bello»)
      // y resuelve a dos elementos. Con «ITAGUI»/«Itagüí» del TC15 no pasaba porque las tildes sí
      // diferencian; con «BELLO»/«Bello», no hay nada que diferencie salvo la caja.
      await expect(bloqueMunicipios(page).getByRole('cell', { name: 'BELLO', exact: true })).toBeVisible();
    });

    // TC19 — BORDE/ERROR: duplicado bajo el formulario, misma regla que en NITs.
    test('TC19: municipio duplicado se explica en el formulario y no añade fila', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      await mockEscritura(page, API_MUNICIPIOS, {
        status: 409,
        body: { error: 'El municipio ITAGUI ya está en el catálogo.', codigo: 'municipio_duplicado' },
      });

      await irAConfiguracion(page);
      await bloqueMunicipios(page).getByRole('button', { name: 'Agregar municipio' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar municipio' });
      await modal.getByLabel(/Código/i).fill('ITAGUI');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal).toBeVisible();
      await expect(modal.getByRole('alert')).toContainText(/ya (está|existe)|duplicad/i);
      await expect(bloqueMunicipios(page).getByRole('row', { name: /ITAGUI/ })).toHaveCount(1);
    });

    // TC20 — DESACTIVAR: sigue visible como inactivo (es la única forma de volver a activarlo) y
    // se manda PATCH, jamás DELETE.
    test('TC20: municipio desactivado queda visible como Inactivo y reactivable', async ({ page }) => {
      const municipios = await mockLectura(page, API_MUNICIPIOS, { status: 200, body: [MUNI_ACTIVO] });
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      const escritura = await mockEscritura(page, API_MUNICIPIO_ID, { status: 200, body: { ...MUNI_ACTIVO, activo: false } });

      await irAConfiguracion(page);

      // Primero se espera a ver la fila ACTIVA. `mockLectura` guarda un valor mutable y compartido,
      // así que adelantar la mutación al GET inicial le sirve el municipio ya inactivo en el primer
      // render, y entonces no hay ningún [Desactivar] que pulsar. No es teoría: mover la mutación
      // arriba del todo dejó este TC en rojo con un timeout sobre el botón. Por eso TC13 muta
      // después de ver el diálogo abierto y no antes; aquí el punto de sincronización es la fila.
      const desactivar = bloqueMunicipios(page).getByRole('row', { name: /ITAGUI/ })
        .getByRole('button', { name: 'Desactivar' });
      await expect(desactivar).toBeVisible();

      // Con el estado inicial ya pintado, la respuesta nueva del catálogo se arma ANTES del clic,
      // igual que en TC13. Hoy el bloque parcha la fila con el cuerpo del PATCH y no vuelve a pedir
      // la lista, así que este mock ni siquiera llega a servirse; el orden importa igual, porque el
      // día que alguien encadene un `recargar()` detrás del PATCH, dejar la mutación después del
      // clic haría que el refetch ganara la carrera y devolviera el municipio TODAVÍA ACTIVO. El TC
      // caería entonces por algo que no tiene que ver con lo que prueba, que es la peor forma de
      // fallar: el rojo señalaría a la pantalla y el defecto estaría en el andamio.
      municipios.respuesta = { status: 200, body: [{ ...MUNI_ACTIVO, activo: false }] };

      await desactivar.click();

      // `expect.poll`: ver la nota de TC12. La lista de métodos se comprueba entera —y no «hay un
      // PATCH»— porque parte de lo que el TC afirma es que NO sale ningún DELETE.
      await expect.poll(
        () => escritura.peticiones.map((p) => p.metodo),
        { message: 'desactivar un municipio manda PATCH, y solo PATCH' },
      ).toEqual(['PATCH']);
      expect(escritura.peticiones[0].cuerpo).toMatchObject({ activo: false });

      // Y no pregunta antes: la baja de un municipio no abre confirmación —al revés que la del NIT,
      // donde la pregunta de verdad es «¿eliminar o desactivar?»—. Esto era un `if` que no se
      // cumplía nunca, es decir, prosa disfrazada de código: ahora es una aserción que se entera si
      // alguien añade el diálogo sin decirlo.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const fila = bloqueMunicipios(page).getByRole('row', { name: /ITAGUI/ });
      await expect(fila.getByText('Inactivo')).toBeVisible();
      await expect(fila.getByRole('button', { name: 'Activar' })).toBeVisible();
    });
  });

  // ─────────────────────────── Bloque 3 — Causales de gestión (HU #11634) ───────────────────────

  test.describe('Configuración · Causales de gestión', () => {
    // TC22 — AC1 (LLENO): la lista va por `orden` y NO por alfabeto, y la inactiva sigue visible.
    //
    // El fixture está elegido para que las dos ordenaciones se contradigan: alfabéticamente «En
    // gestión jurídica» iría primera y aquí va última. Sin esa contradicción, un TC de orden pasa
    // aunque la pantalla ordene por lo que le dé la gana.
    test('TC22: las causales se listan por orden, no alfabéticamente, y la inactiva sigue en la lista', async ({ page }) => {
      await mockConfigFeliz(page);
      await irAConfiguracion(page);

      const bloque = bloqueCausales(page);
      await expect(bloque.getByRole('row')).toContainText([
        /Orden/,
        /10.*Notificado al cliente/,
        /20.*Pagado/,
        /30.*En gestión jurídica/,
      ]);

      // El estado se lee por su etiqueta, no por el color del punto, y concuerda con el sujeto: la
      // causal es femenina («Inactiva»), a diferencia del NIT y del municipio.
      const filaInactiva = bloque.getByRole('row', { name: /En gestión jurídica/ });
      await expect(filaInactiva.getByText('Inactiva')).toBeVisible();
      await expect(filaInactiva.getByRole('button', { name: 'Activar' })).toBeVisible();
      await expect(bloque.getByRole('row', { name: /Pagado/ }).getByRole('button', { name: 'Desactivar' })).toBeVisible();
    });

    // TC23 — AC1 (ALTA): «aparece en la lista según el orden indicado». Con un 15 entre el 10 y el
    // 20, la fila nueva tiene que caer EN MEDIO. Añadirla al final es el fallo realista: la
    // respuesta del POST llega sola y quien la recibe suele hacer `[...previas, nueva]` sin más, y
    // eso se ve bien mientras el orden nuevo sea el mayor de todos.
    test('TC23: la causal nueva se inserta en la posición que dice su orden, no al final', async ({ page }) => {
      await mockConfigFeliz(page);
      const alta = await mockEscritura(page, API_CAUSALES, {
        status: 201,
        body: { id: 'c9', nombre: 'Acuerdo de pago', activo: true, orden: 15, ...SELLO },
      });

      await irAConfiguracion(page);
      await bloqueCausales(page).getByRole('button', { name: 'Agregar causal' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar causal' });
      await modal.getByLabel(/^Nombre/).fill('Acuerdo de pago');
      await modal.getByLabel(/^Orden/).fill('15');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal).toHaveCount(0);
      await expect(page.getByText('Causal agregada.')).toBeVisible();
      expect(alta.peticiones).toHaveLength(1);
      expect(alta.peticiones[0].metodo).toBe('POST');
      // `orden` viaja como NÚMERO. Mandarlo como texto («15») es un 400 del esquema, y el input es
      // de texto: la conversión es de la pantalla y aquí se comprueba que la hace.
      expect(alta.peticiones[0].cuerpo).toEqual({ nombre: 'Acuerdo de pago', orden: 15 });

      await expect(bloqueCausales(page).getByRole('row')).toContainText([
        /Orden/,
        /10.*Notificado al cliente/,
        /15.*Acuerdo de pago/,
        /20.*Pagado/,
        /30.*En gestión jurídica/,
      ]);
    });

    // TC24 — AC1 (segunda mitad): «puedo desactivarla y sigue visible como inactiva».
    test('TC24: desactivar una causal manda PATCH { activo: false } y la deja visible y reactivable', async ({ page }) => {
      const causales = await mockLectura(page, API_CAUSALES, { status: 200, body: [CAUSAL_NOTIFICADO] });
      const escritura = await mockEscritura(page, API_CAUSAL_ID, {
        status: 200, body: { ...CAUSAL_NOTIFICADO, activo: false },
      });

      await irAConfiguracion(page);

      // Se espera a la fila ACTIVA antes de tocar el mock del catálogo: `mockLectura` guarda un
      // valor mutable y adelantar la mutación serviría la causal ya inactiva en el primer render,
      // dejando el TC sin ningún [Desactivar] que pulsar (misma trampa documentada en TC20).
      const desactivar = bloqueCausales(page).getByRole('row', { name: /Notificado al cliente/ })
        .getByRole('button', { name: 'Desactivar' });
      await expect(desactivar).toBeVisible();
      causales.respuesta = { status: 200, body: [{ ...CAUSAL_NOTIFICADO, activo: false }] };

      await desactivar.click();

      // La lista entera de métodos, y no «hay un PATCH»: parte de lo que se afirma es que NO sale
      // ningún DELETE — el API no lo expone y borrar una causal dejaría sin explicación las
      // gestiones que la citan.
      await expect.poll(
        () => escritura.peticiones.map((p) => p.metodo),
        { message: 'desactivar una causal manda PATCH, y solo PATCH' },
      ).toEqual(['PATCH']);
      expect(escritura.peticiones[0].cuerpo).toMatchObject({ activo: false });

      // Y no pregunta antes: como en municipios, la baja no toca ningún histórico y se deshace con
      // un clic en la misma fila.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const fila = bloqueCausales(page).getByRole('row', { name: /Notificado al cliente/ });
      await expect(fila.getByText('Inactiva')).toBeVisible();
      await expect(fila.getByRole('button', { name: 'Activar' })).toBeVisible();
    });

    // TC25 — AC2: 409 `causal_duplicada`, ramificado por `codigo` y no por el texto del mensaje.
    // El fallo que persigue: cerrar el modal y añadir la fila igual, dejando dos causales con el
    // mismo nombre en pantalla hasta el próximo refresco.
    test('TC25: causal duplicada deja el error en el formulario y no duplica la fila', async ({ page }) => {
      await mockConfigFeliz(page);
      await mockEscritura(page, API_CAUSALES, {
        status: 409,
        body: { error: 'Ya existe una causal llamada "Pagado".', codigo: 'causal_duplicada' },
      });

      await irAConfiguracion(page);
      await bloqueCausales(page).getByRole('button', { name: 'Agregar causal' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar causal' });
      await modal.getByLabel(/^Nombre/).fill('Pagado');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      // El modal se queda abierto con el error a la vista: hay que poder corregir sin reabrir nada.
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('alert')).toContainText('Ya hay una causal con ese nombre.');
      await expect(page.getByText('Causal agregada.')).toHaveCount(0);
      await expect(bloqueCausales(page).getByRole('row', { name: /Pagado/ })).toHaveCount(1);
    });

    // TC26 — BORDE de validación: lo que el cliente rechaza NO gasta una petición.
    //
    // Y se afirma sobre `role="alert"`, que es lo que hace que el fallo se anuncie a quien no ve la
    // pantalla. El campo de orden es de texto a propósito (un `type="number"` con `min`/`max`
    // delegaría el aviso en un globo del navegador, sin rol, sin idioma de la app y efímero); este
    // TC es lo que impide que alguien «lo arregle» volviendo a las restricciones nativas.
    test('TC26: un orden que no es entero y un nombre en blanco se rechazan sin llamar al API', async ({ page }) => {
      await mockConfigFeliz(page);
      const alta = await mockEscritura(page, API_CAUSALES, { status: 201, body: CAUSAL_PAGADO });

      await irAConfiguracion(page);
      await bloqueCausales(page).getByRole('button', { name: 'Agregar causal' }).click();

      const modal = page.getByRole('dialog', { name: 'Agregar causal' });
      await modal.getByLabel(/^Nombre/).fill('Acuerdo de pago');
      await modal.getByLabel(/^Orden/).fill('10,5');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal.getByRole('alert')).toContainText('El orden debe ser un número entero entre 0 y 32767.');
      expect(alta.peticiones).toHaveLength(0);

      // Y el nombre en blancos: pasa el `required` del navegador —no está vacío— pero al recortarlo
      // no queda nada. Es el hueco que deja la validación nativa y por eso la de la pantalla no
      // sobra.
      await modal.getByLabel(/^Orden/).fill('10');
      await modal.getByLabel(/^Nombre/).fill('   ');
      await modal.getByRole('button', { name: 'Guardar' }).click();

      await expect(modal.getByRole('alert')).toContainText('Escribe el nombre de la causal.');
      expect(alta.peticiones).toHaveLength(0);
    });

    // TC33 — CARGANDO y VACÍO del bloque, con su copy propio. Va al final del bloque y no en su
    // sitio «natural» porque los números son referencias del gate de QA: se añaden, no se renumeran.
    //
    // El copy del vacío de causales dice algo distinto al de NITs y al de municipios, y esa
    // diferencia es el TC: sin causales el módulo sigue sirviendo para MIRAR —el visor lista igual—
    // y lo que no se puede es gestionar. Un vacío genérico («no hay datos») haría creer que la
    // pantalla está rota o que falta sincronizar.
    test('TC33: causales anuncia su carga y explica en el vacío qué deja de funcionar', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      let soltar: (() => void) | null = null;
      const retenida = new Promise<void>((resolve) => { soltar = resolve; });
      await page.route(API_CAUSALES, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await retenida;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });

      await irAConfiguracion(page);

      const cargando = bloqueCausales(page).getByRole('status', { name: 'Cargando causales de gestión' });
      await expect(cargando).toBeVisible();
      await expect(cargando).toHaveAttribute('aria-busy', 'true');
      // Y mientras carga NO se adelanta el vacío: decir «no hay causales» sobre una petición que
      // sigue en el aire es afirmar algo que nadie ha comprobado todavía.
      await expect(bloqueCausales(page).getByText(/No hay causales/)).toHaveCount(0);

      soltar?.();

      await expect(bloqueCausales(page).getByText(
        'No hay causales. El visor podrá listar comparendos, pero no asignar gestión hasta que '
        + 'agregues al menos una.',
      )).toBeVisible();
      await expect(bloqueCausales(page).getByRole('button', { name: 'Agregar causal' })).toBeVisible();
      await expect(bloqueCausales(page).getByRole('alert')).toHaveCount(0);
    });
  });

  // ─────────────────────────── Bloque 4 — Token SIMIT (HU #11634) ───────────────────────────────

  test.describe('Configuración · Token SIMIT', () => {
    // TC27 — AC3 (LLENO): lo que la pantalla puede decir del token es su estado, quién, cuándo y la
    // versión de llave. Y lo que NO puede: enseñarlo. Aquí se afirman las dos mitades, incluida la
    // ausencia de cualquier control que prometa revelarlo.
    test('TC27: el bloque muestra estado, autor, fecha y versión de llave — y ningún control para ver el token', async ({ page }) => {
      await mockConfigFeliz(page);
      await irAConfiguracion(page);

      const bloque = bloqueToken(page);
      await expect(bloque.getByText('Configurado', { exact: true })).toBeVisible();
      // La hora es la de Bogotá (09:14), no la del runner: el instante del fixture es 14:14Z.
      // La expresión deja holgura alrededor del mes porque el formato largo de `es-CO`
      // depende de la ICU del navegador («14 de ago de 2026» en Chromium, «14 ago 2026» en
      // otras): lo que este TC afirma es el DÍA, la HORA y el AUTOR, no la tipografía del mes.
      await expect(bloque.getByText(/14 .{0,7}ago.{0,4}2026, 09:14 · María Ruiz/)).toBeVisible();
      await expect(bloque.getByText('Versión de llave')).toBeVisible();
      await expect(bloque.getByText('2', { exact: true })).toBeVisible();

      // El único botón del bloque es el de guardar. Si algún día aparece un «Ver token» o un
      // «Mostrar», este TC lo dice antes de que llegue a un ambiente.
      await expect(bloque.getByRole('button')).toHaveText(['Guardar token']);
      // Y nada más que prometa enseñarlo: ni enlace, ni casilla de «mostrar». Se afirma sobre
      // CONTROLES y no sobre el texto del bloque, porque su propia descripción contiene la palabra
      // —«no vuelve a mostrarse: ni completa ni enmascarada»— y un `getByText(/mostrar/i)` casaría
      // justo con la frase que promete lo contrario de lo que se busca. Un TC que se dispara con su
      // propio copy no vigila nada: obliga a redactar alrededor de él.
      await expect(bloque.getByRole('button', { name: /mostrar|revelar|ver/i })).toHaveCount(0);
      await expect(bloque.getByRole('link')).toHaveCount(0);
      await expect(bloque.getByRole('checkbox')).toHaveCount(0);

      // El campo es de escritura y arranca vacío: no hay «el actual» que precargar.
      const campo = bloque.getByLabel('Nuevo token');
      await expect(campo).toHaveAttribute('type', 'password');
      await expect(campo).toHaveValue('');
    });

    // TC28 — AC3 completo, y el TC que sostiene la regla dura de la HU.
    //
    // Cinco afirmaciones que van juntas porque describen UN gesto (guardar el token) y ninguna vale
    // sola: el estado pasa a configurado, el campo se vacía, se ve quién y cuándo, el cuerpo del PUT
    // lleva el token y NADA más — y el valor escrito no aparece en la barra de direcciones, ni en la
    // consola, ni en el almacenamiento del navegador, ni en el texto de la página.
    //
    // Lo de la URL no es paranoia: un `<form>` cuyo `onSubmit` no llame a `preventDefault()` se envía
    // por GET y deja el secreto en la barra de direcciones, en el historial y en el `Referer` de la
    // siguiente petición. Es un descuido de una línea con consecuencias que duran meses.
    test('TC28: guardar el token deja el campo vacío, pasa a configurado y no filtra el valor a ninguna parte', async ({ page }) => {
      // Los cuatro bloques en verde y DESPUÉS el token sin configurar: el `page.route` registrado
      // al final gana, así que esto sustituye al token feliz sin dejar a los otros tres bloques
      // cayendo en el catch-all de los fixtures (que responde `[]` y ensucia la salida).
      await mockConfigFeliz(page);
      await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_SIN_CONFIGURAR });
      const consola = consolaDe(page);
      const guardado = await mockEscritura(page, API_TOKEN, {
        status: 200,
        body: {
          configurado: true,
          actualizadoEn: '2026-08-19T20:05:00Z',
          actualizadoPor: { id: 7, nombre: 'María Ruiz' },
          keyVersion: 3,
        },
      });

      await irAConfiguracion(page);

      const bloque = bloqueToken(page);
      await expect(bloque.getByText('Sin configurar')).toBeVisible();
      // Sin token no hay fecha, ni autor, ni versión de llave: tres guiones seguidos no informan de
      // nada y el estado ya lo dijo todo.
      await expect(bloque.getByText('Versión de llave')).toHaveCount(0);
      await expect(bloque.getByText('Última actualización')).toHaveCount(0);

      // «Nuevo token» es la etiqueta también sin token configurado, y sigue siéndolo después de
      // guardar: el campo no se renombra bajo los dedos de quien lo está usando.
      const campo = bloque.getByLabel('Nuevo token');
      await campo.fill(TOKEN_ESCRITO);
      await bloque.getByRole('button', { name: 'Guardar token' }).click();

      await expect(page.getByText('Token SIMIT guardado.')).toBeVisible();
      await expect(bloque.getByText('Configurado', { exact: true })).toBeVisible();
      await expect(campo).toHaveValue('');
      await expect(bloque.getByText(/19 .{0,7}ago.{0,4}2026, 15:05 · María Ruiz/)).toBeVisible();

      expect(guardado.peticiones).toHaveLength(1);
      expect(guardado.peticiones[0].metodo).toBe('PUT');
      // `toEqual` y no `toMatchObject`: el cuerpo es el token y NADA más. Un `keyVersion` o un
      // `configurado` de propina serían campos que el esquema del servidor rechaza.
      expect(guardado.peticiones[0].cuerpo).toEqual({ token: TOKEN_ESCRITO });
      // Ni siquiera en la URL de la propia petición (un `?token=` en un PUT es igual de público).
      expect(guardado.peticiones[0].url).not.toContain('tok-simit');

      // La aguja se busca por un PREFIJO del valor, no por el valor entero: lo que la HU prohíbe no
      // es solo el token completo, es también cualquier fragmento suyo.
      const aguja = TOKEN_ESCRITO.slice(0, 8);
      expect(page.url()).not.toContain(aguja);
      expect(consola.join('\n')).not.toContain(aguja);
      expect(await almacenamiento(page)).not.toContain(aguja);
      expect(await page.locator('body').innerText()).not.toContain(aguja);
      // El DOM SERIALIZADO, que no es lo mismo que el texto visible: `innerText` no ve el valor de
      // un `<input>`, así que sin esta línea el TC diría «no filtra a ninguna parte» sin haber
      // mirado el sitio donde un input controlado podría estar reflejando el valor al ATRIBUTO
      // `value` (el atributo viaja en `outerHTML`; la propiedad no). Es lo que copia un «Guardar
      // como…» del navegador, lo que se lleva un informe de error automático y lo que lee cualquier
      // extensión con permiso sobre la página.
      expect(await page.content()).not.toContain(aguja);
      // Y las cookies: es el otro canal que sobrevive a la recarga y que ningún `expect` anterior
      // tocaba. No hay motivo para que el token esté ahí — precisamente por eso se comprueba.
      expect(JSON.stringify(await page.context().cookies())).not.toContain(aguja);
    });

    // TC29 — AC3, el borde del autor: un token sembrado por operación no tiene `updated_by`, y la
    // pantalla tiene que pintar un guion sin inventarse un nombre ni dejar la fila a medias.
    test('TC29: sin autor conocido la última actualización termina en guion', async ({ page }) => {
      await mockConfigFeliz(page);
      await mockLectura(page, API_TOKEN, { status: 200, body: TOKEN_SIN_AUTOR });
      await irAConfiguracion(page);

      const bloque = bloqueToken(page);
      await expect(bloque.getByText('Configurado', { exact: true })).toBeVisible();
      await expect(bloque.getByText(/14 .{0,7}ago.{0,4}2026, 09:14 · —/)).toBeVisible();
      // Ni «Usuario 7», ni «Sistema», ni un nombre heredado de otra fila.
      await expect(bloque.getByText(/María Ruiz|Usuario \d/)).toHaveCount(0);
    });

    // TC30 — AC4, límite de intentos. El copy es propio y ACCIONABLE («espera un minuto»), no el
    // mensaje del servidor: ramificar por el texto del API es lo que se rompe en silencio cuando
    // alguien le quita una tilde.
    test('TC30: un 429 al guardar explica la espera con copy propio y conserva lo escrito', async ({ page }) => {
      await mockConfigFeliz(page);
      const consola = consolaDe(page);
      await mockEscritura(page, API_TOKEN, {
        status: 429,
        body: { error: 'Demasiadas actualizaciones del token SIMIT, espere 1 minuto' },
      });

      await irAConfiguracion(page);
      const bloque = bloqueToken(page);
      const campo = bloque.getByLabel('Nuevo token');
      await campo.fill(TOKEN_ESCRITO);
      await bloque.getByRole('button', { name: 'Guardar token' }).click();

      await expect(bloque.getByRole('alert')).toContainText(
        'Ya se actualizó el token varias veces en el último minuto. Espera un minuto.',
      );
      await expect(page.getByText(/Demasiadas actualizaciones/)).toHaveCount(0);
      await expect(page.getByText('Token SIMIT guardado.')).toHaveCount(0);
      // Lo escrito SIGUE escrito: el 429 es un límite del servidor, no un error del operador, y
      // obligarle a reescribir a mano un token de mil caracteres sería cobrárselo a quien no lo
      // causó. Que se conserve en el campo no lo expone: sigue siendo un `type="password"`.
      await expect(campo).toHaveValue(TOKEN_ESCRITO);
      expect(page.url()).not.toContain('tok-simit');
      expect(consola.join('\n')).not.toContain('tok-simit');
      // Este es EL estado en el que el valor sigue escrito —y puede quedarse minutos, esperando a
      // que pase el minuto del limitador—, así que es donde más importa que el DOM serializado y
      // las cookies estén limpios. En TC28 el campo ya se vació; aquí no.
      expect(await page.content()).not.toContain('tok-simit');
      expect(JSON.stringify(await page.context().cookies())).not.toContain('tok-simit');
    });

    // TC31 — AC4, falta la llave de cifrado. Se ramifica por `codigo` (`llave_maestra`) porque un
    // 503 a secas no distingue «el ambiente está mal provisionado» de «vuelve a intentarlo», y son
    // dos cosas distintas: esta no se arregla reintentando, se arregla avisando a quien opera.
    test('TC31: un 503 llave_maestra dice qué pasa y a quién avisar, sin eco del servidor', async ({ page }) => {
      await mockConfigFeliz(page);
      const consola = consolaDe(page);
      await mockEscritura(page, API_TOKEN, {
        status: 503,
        body: {
          error: 'COMPARENDOS_ENC_KEY ausente o inválida: no se puede cifrar el token.',
          codigo: 'llave_maestra',
        },
      });

      await irAConfiguracion(page);
      const bloque = bloqueToken(page);
      await bloque.getByLabel('Nuevo token').fill(TOKEN_ESCRITO);
      await bloque.getByRole('button', { name: 'Guardar token' }).click();

      await expect(bloque.getByRole('alert')).toContainText(
        'El servidor no puede cifrar el token: falta la llave de cifrado del módulo. Avisa a quien '
        + 'administra el ambiente.',
      );
      // Ni el nombre de la variable de entorno en pantalla: el copy del servidor no se pinta.
      await expect(page.getByText(/COMPARENDOS_ENC_KEY/)).toHaveCount(0);
      expect(page.url()).not.toContain('tok-simit');
      expect(consola.join('\n')).not.toContain('tok-simit');
    });

    // TC32 — AISLAMIENTO con los bloques nuevos (el fallo #2 del encabezado, ahora a cuatro
    // tarjetas): causales y token caídos a la vez, NITs y municipios intactos, y el reintento de
    // uno no arrastra al otro. Con cuatro peticiones en paralelo, el `Promise.all` que nadie
    // escribió sigue siendo la tentación: publicaría los cuatro a la vez y dejaría en «cargando»
    // los que respondieron bien.
    test('TC32: causales y token en error no tumban los demás bloques, y cada uno reintenta por su cuenta', async ({ page }) => {
      await mockLectura(page, API_NITS, { status: 200, body: NITS });
      await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
      const causales = await mockLectura(page, API_CAUSALES, { status: 500, body: { error: 'boom causales', codigo: 'interno' } });
      const token = await mockLectura(page, API_TOKEN, { status: 500, body: { error: 'boom token', codigo: 'interno' } });

      await irAConfiguracion(page);

      await expect(bloqueCausales(page).getByText('No se pudieron cargar las causales de gestión. Vuelve a intentarlo.')).toBeVisible();
      await expect(bloqueToken(page).getByText('No se pudo consultar el estado del token SIMIT. Vuelve a intentarlo.')).toBeVisible();
      await expect(page.getByText(/boom/)).toHaveCount(0);
      // Los dos bloques de la #11633, intactos: ni error, ni vacío, ni bloque desaparecido.
      await expect(bloqueNits(page).getByText('900123456')).toBeVisible();
      await expect(bloqueMunicipios(page).getByText('ITAGUI')).toBeVisible();

      // El token se recupera solo, y el catálogo de causales sigue en su error: son dos peticiones
      // y dos reintentos, no un botón que recarga la pantalla entera.
      token.respuesta = { status: 200, body: TOKEN_CONFIGURADO };
      await bloqueToken(page).getByRole('button', { name: 'Reintentar' }).click();
      await expect(bloqueToken(page).getByText('Configurado', { exact: true })).toBeVisible();
      await expect(bloqueCausales(page).getByRole('button', { name: 'Reintentar' })).toBeVisible();

      causales.respuesta = { status: 200, body: CAUSALES };
      await bloqueCausales(page).getByRole('button', { name: 'Reintentar' }).click();
      await expect(bloqueCausales(page).getByText('Notificado al cliente')).toBeVisible();
      await expect(bloqueToken(page).getByText('Configurado', { exact: true })).toBeVisible();
    });

    // TC34 — BORDE, y el guardián de una decisión que parece un descuido: el campo del token NO
    // lleva `maxLength`.
    //
    // Con `maxLength`, un token pegado de más de 2048 caracteres se recorta SIN AVISO —el campo es
    // de puntos, no hay nada que ver— y lo que se guarda cifra igual de bien, deja «Configurado» en
    // pantalla y solo se delata semanas después en un 401 del proveedor que nadie ata a esta
    // pantalla. Por eso el límite se comprueba al enviar y se dice en voz alta. Sin este TC, el
    // atributo vuelve en la primera revisión que busque «consistencia» con los otros campos.
    test('TC34: un token más largo del máximo se avisa y NO se recorta ni se envía', async ({ page }) => {
      await mockConfigFeliz(page);
      const guardado = await mockEscritura(page, API_TOKEN, { status: 200, body: TOKEN_CONFIGURADO });

      await irAConfiguracion(page);
      const bloque = bloqueToken(page);
      const campo = bloque.getByLabel('Nuevo token');
      const demasiado = 'a'.repeat(2049);
      await campo.fill(demasiado);
      await bloque.getByRole('button', { name: 'Guardar token' }).click();

      await expect(bloque.getByRole('alert')).toContainText('El token admite hasta 2048 caracteres.');
      expect(guardado.peticiones).toHaveLength(0);
      // Lo escrito sigue entero: si el navegador lo hubiera truncado, aquí habría 2048.
      expect(await campo.inputValue()).toHaveLength(2049);
    });

    // TC35 — El botón mientras se guarda: texto visible «Guardando…», `aria-busy` e INHABILITADO.
    //
    // Existe por dos motivos. El de producto: cada intento cifra, abre transacción y escribe una
    // fila de historial, y el limitador propio de la ruta son 10 por minuto — un doble clic
    // impaciente gasta cuota de verdad. Y el de mantenimiento: el campo del token es el único no
    // controlado del módulo (vive en un `ref` para no serializarse), así que conviene dejar clavado
    // que lo que SÍ es estado de React —el «ocupado» que gobierna el botón— sigue funcionando. Sin
    // este TC, un refactor que confundiera las dos cosas se notaría en producción.
    test('TC35: mientras guarda, el botón se anuncia ocupado e inhabilitado, y al terminar limpia el campo', async ({ page }) => {
      await mockConfigFeliz(page);
      let soltar: (() => void) | null = null;
      const retenida = new Promise<void>((resolve) => { soltar = resolve; });
      const puts: string[] = [];
      await page.route(API_TOKEN, async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        puts.push(route.request().url());
        await retenida;
        return route.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify(TOKEN_CONFIGURADO),
        });
      });

      await irAConfiguracion(page);
      const bloque = bloqueToken(page);
      const campo = bloque.getByLabel('Nuevo token');
      await campo.fill(TOKEN_ESCRITO);
      await bloque.getByRole('button', { name: 'Guardar token' }).click();

      // El nombre accesible cambia con el estado: quien no ve la pantalla se entera de que se está
      // guardando por el texto, no solo por el atributo.
      const guardando = bloque.getByRole('button', { name: 'Guardando…' });
      await expect(guardando).toBeDisabled();
      await expect(guardando).toHaveAttribute('aria-busy', 'true');

      soltar?.();

      await expect(page.getByText('Token SIMIT guardado.')).toBeVisible();
      await expect(campo).toHaveValue('');
      await expect(bloque.getByRole('button', { name: 'Guardar token' })).toBeEnabled();
      expect(puts).toHaveLength(1);
    });
  });
});
