// FLITO — Comparendos: página, permiso y navegación (HU #11559, AC2 y AC3).
//
// Lo que este spec protege no es el visor —eso llega con la #11560— sino la frontera de acceso.
//
// El AC2 dice «no se dispara ninguna llamada al API», y eso es una afirmación sobre una AUSENCIA:
// se cumple sola en cualquier test roto. El montaje que la vuelve una prueba de verdad son cuatro
// piezas, y ninguna es opcional:
//
//   1. Se espía la PETICIÓN (`page.on('request')`), no la respuesta. El fixture base instala un
//      catch-all que responde `200 []` a todo `/api/**`, así que una llamada fugada no deja NINGUNA
//      huella en la interfaz: solo el espía la ve. Y si el componente monta, consulta y se desmonta,
//      la respuesta se descarta pero la petición ya salió.
//   2. El gemelo POSITIVO vive en este mismo archivo, con el mismo helper, el mismo glob y el mismo
//      punto de reposo. Si mañana cambia el prefijo del endpoint o el glob se escribe mal, el
//      positivo se pone rojo y delata que el negativo pasó por vacío.
//   3. El punto de reposo es determinista: un canario (`fetch('/api/__qa_canary')` + su
//      `waitForRequest`). Cuando el canario ha salido, cualquier petición del montaje ya pasó por la
//      misma cola de red. No hay `waitForTimeout` en este archivo.
//   4. En el caso sin permiso el glob se ABORTA, así que una fuga rompe dos asertos: el contador y
//      el propio `NoAccess`, que se convertiría en la banda de error.
//
// Y el aserto que más va a durar es el estructural: el chunk del módulo tampoco se pide. La
// mecánica exacta importa, porque es fácil contarla mal: el ELEMENTO de React sí se crea —evaluar
// el JSX del prop `element` construye el árbol entero, incluido `<FlitoComparendos />`—, pero crear
// un elemento no ejecuta nada. `React.lazy` dispara su `import()` al MONTARSE, y `ProtectedRoute`
// (`App.tsx`) devuelve `NoAccess` en lugar de sus hijos, así que ese montaje nunca ocurre. Ese
// aserto se pone rojo si alguien mueve la guarda DENTRO de la página —que es la causa de un fetch
// fugado, no su síntoma— aunque ese día la página no consultara nada. Depende del dev server de
// Vite, que es lo que arranca el `webServer` de `playwright.config.ts`: en desarrollo el módulo se
// pide por su ruta de origen (`/src/pages/FlitoComparendos.tsx`) y en build por su chunk
// (`FlitoComparendos-<hash>.js`); las dos contienen `FlitoComparendos`.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, OPERACIONES_USER, AUDITOR_USER, FINANCIERA_USER, PROVEEDOR_USER,
  GESTOR_IMPUESTOS_USER, MENSAJERO_USER, CONDUCTOR_USER,
} from '../helpers/auth';

const API_MODULO = '**/api/flito/comparendos/**';
const CANARIO = '/api/__qa_canary';

interface Espia {
  /** `${método} ${pathname}` de cada petición al módulo. Nunca la URL completa: la query es el
   *  sitio por donde se filtraría un NIT o una placa a un artefacto de CI (AGENTS.md §14). */
  alApi: string[];
  /** Peticiones del chunk/módulo de la página. */
  alChunk: string[];
}

/** Espía de red instalado ANTES de navegar. Devuelve los dos acumuladores. */
function espiar(page: Page): Espia {
  const espia: Espia = { alApi: [], alChunk: [] };
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/flito/comparendos')) espia.alApi.push(`${req.method()} ${pathname}`);
    if (pathname.includes('FlitoComparendos')) espia.alChunk.push(pathname);
  });
  return espia;
}

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

// Los roles que NO tienen la página. `auditor` es el que hay que resistir: entra a casi todo FLITO
// en lectura, pero el router de comparendos exige `admin` a nivel de router entero, así que darle
// la página sería regalarle una pantalla que responde 403 en cada petición. El resto va de control
// —`conductor` es el más acotado del sistema: lo que se le escapa a él, se le escapa a cualquiera—.
const SIN_LA_PAGINA = [
  AUDITOR_USER, FINANCIERA_USER, PROVEEDOR_USER,
  GESTOR_IMPUESTOS_USER, MENSAJERO_USER, CONDUCTOR_USER,
];

test.describe('FLITO — Comparendos · acceso', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC2 gemelo positivo — con la página, la ruta monta, pide el módulo y consulta el API', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const espia = espiar(page);
    await page.route(API_MODULO, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }),
    }));

    await page.goto('/flito/comparendos');
    await expect(page.getByRole('heading', { name: 'Comparendos monitoreados' })).toBeVisible();
    await reposo(page);

    expect(espia.alApi.length).toBeGreaterThan(0);
    // Todo lo que sale es del módulo, y el listado está entre ello. El visor (HU #11560) añadió al
    // montaje los tres catálogos de etiqueta —municipios, causales y NITs—, así que el aserto ya no
    // puede ser «solo /registros»; lo que sigue valiendo es que ninguna otra superficie del API se
    // toca y que ninguna de esas peticiones es un POST con identidad.
    expect(espia.alApi.every((l) => l.startsWith('GET /api/flito/comparendos/'))).toBe(true);
    expect(espia.alApi.some((l) => l === 'GET /api/flito/comparendos/registros')).toBe(true);
    expect(espia.alChunk.length).toBeGreaterThan(0);
    // Ni el NIT ni la placa viajan en la dirección del navegador (AGENTS.md §14).
    expect(page.url()).toMatch(/\/flito\/comparendos$/);
  });

  for (const usuario of SIN_LA_PAGINA) {
    test(`AC2 — ${usuario.role} ve NoAccess, no consulta el API y ni siquiera descarga el módulo`, async ({ page }) => {
      await loginAs(page, usuario);
      const espia = espiar(page);
      // Abortado a propósito: si algo se escapa, cae el contador Y cae el `NoAccess`, porque la
      // pantalla pasaría a su estado de error. Dos señales independientes de la misma fuga.
      await page.route(API_MODULO, (route) => route.abort('failed'));

      await page.goto('/flito/comparendos');
      await expect(page.getByRole('heading', { name: /no tienes acceso a flito — comparendos/i })).toBeVisible();
      await reposo(page);

      expect(espia.alApi).toEqual([]);
      // El elemento `lazy` se crea, pero no se monta: `NoAccess` ocupa su sitio y el `import()`
      // nunca llega a dispararse, así que el chunk tampoco se pide.
      expect(espia.alChunk).toEqual([]);
    });
  }

  test('AC3 — con la página, el dock ofrece «Comparendos» en Gestión y navega', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('heading', { name: 'Comparendos monitoreados' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Gestión', exact: true }).click();
    const enlace = page.getByRole('link', { name: 'Comparendos', exact: true });
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveAttribute('href', '/flito/comparendos');

    // Y su subgrupo, que es lo que evita que caiga en la columna sin título del final del panel.
    await expect(
      page.locator('#flit-navbar-panel-gestion p').filter({ hasText: /^Comparendos$/ }),
    ).toBeVisible();

    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/comparendos$/);
  });

  test('AC3 — con la página, el Command Palette también la ofrece', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('heading', { name: 'Comparendos monitoreados' })).toBeVisible();

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('comparendo');
    await expect(page.getByRole('option', { name: /Comparendos/ })).toBeVisible();
  });

  test('AC3 — sin la página, el auditor no la ve ni en el dock ni en el Command Palette', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    // Se entra por una vista que el auditor SÍ tiene y que no depende de una respuesta con forma
    // propia (la bitácora consume una lista, que es lo que devuelve el catch-all del fixture).
    await page.goto('/flito/bitacora');

    // El dock: el auditor tiene varias páginas de Gestión, así que el módulo se abre y se puede
    // afirmar la ausencia con el panel desplegado (con el panel cerrado los enlaces ni existen y el
    // aserto no diría nada).
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Gestión', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Comparendos', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // El palette es el SEGUNDO camino al slug: mismo filtrado, componente distinto, y es el que
    // se olvida. Se busca por una keyword del ítem, no por su etiqueta, para que el aserto no pase
    // solo porque nadie escribió «Comparendos».
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('comparendo');
    await expect(page.getByRole('option', { name: /Comparendos/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /simit/i })).toHaveCount(0);
  });
});
