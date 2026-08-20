// FLITO — Comparendos: pestañas (?vista=) y parametrización de NITs y municipios (HU #11633, 17c).
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
// `docs/ux/flito-comparendos-config-sync.md` (§ pestañas, § bloque 1 NITs, § bloque 2 municipios) y
// de sus notas de a11y. Se afirma por rol y por texto visible —nunca por clase CSS ni por
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
//
// PII: todos los NITs y códigos son SINTÉTICOS («900123456», «830009988», «ITAGUI»). Ni un dato
// real entra en un spec ni en un fixture (Ley 1581). El NIT se muestra completo en pantalla —es el
// eje del módulo y solo lo ve `admin`— pero NUNCA viaja en la URL del SPA: TC03 lo afirma.
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

/** Los catálogos que Configuración pide en paralelo, todos en verde salvo lo que el TC cambie. */
async function mockConfigFeliz(page: Page) {
  const nits = await mockLectura(page, API_NITS, { status: 200, body: NITS });
  const municipios = await mockLectura(page, API_MUNICIPIOS, { status: 200, body: MUNICIPIOS });
  return { nits, municipios };
}

const bloqueNits = (page: Page) => page.getByRole('region', { name: /NIT.? monitoreados/i });
const bloqueMunicipios = (page: Page) => page.getByRole('region', { name: /Municipios fuente/i });

async function irAConfiguracion(page: Page) {
  await page.goto('/flito/comparendos?vista=configuracion');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · pestañas y parametrización (HU #11633)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El visor de la pestaña Registros no es el sujeto de esta HU, pero se monta: se le da una
    // página vacía-con-datos para que no sea él quien haga fallar un TC de navegación.
    await mockLectura(page, API_REGISTROS, { status: 200, body: { items: [], nextCursor: null } });
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
});
