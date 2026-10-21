// HU #13764 (retrabajo, AC7) — Dr. Flit en un teléfono real: el panel ocupa el ancho VISIBLE y «Cerrar» se ve.
// Fallo de la sesión de evidencias en DEV: en un iPhone 12 la barra superior medía 453 px de contenido en
// 390 de pantalla. En un navegador móvil eso ensancha el layout viewport (`innerWidth` 453 ≠
// `visualViewport.width` 390), y el panel `fixed inset-x-0` heredaba los 453: «Cerrar» quedaba fuera de vista.
// Segunda causa: las barras de ancho fijo del esqueleto de carga (PageContentSkeleton, 22rem) desbordan
// MIENTRAS se ve el esqueleto (en la emulación: 393 en 390); al reemplazarlo la página el ancho vuelve.
// Por eso tiene su propio caso, que retiene el chunk lazy de la página para medir con el esqueleto en pantalla.
// El proyecto `chromium` (escritorio, sin `isMobile`) no ensancha el layout viewport y por eso no lo veía.
// Corre en el proyecto `mobile-chrome` (`*.mobile.spec.ts`) con emulación móvil real.
import { test, expect, devices, type Page } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/ayuda-fixtures';

// iPhone 12 sobre Chromium: `defaultBrowserType` (webkit) no se puede fijar dentro de un archivo.
const { defaultBrowserType: _webkit, ...IPHONE_12 } = devices['iPhone 12'];

async function medirAnchos(page: Page) {
  return page.evaluate(() => ({
    inner: window.innerWidth,
    visible: window.visualViewport?.width ?? window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    barra: (document.querySelector('header[role="banner"]') as HTMLElement).scrollWidth,
  }));
}

async function comprobarSinDesborde(page: Page, ancho: number) {
  await loginAs(page, FINANCIERA_USER);
  await page.goto('/flito/ayuda');
  await expect(page.getByRole('banner').first()).toBeVisible();
  // Medir con la página ya cargada: el esqueleto de carga (PageContentSkeleton) también desbordaba y el
  // layout viewport del móvil se quedaba ensanchado después de que la página real lo reemplazaba.
  await expect(page.getByRole('heading', { name: 'Ayuda FLITO' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Cargando página' })).toHaveCount(0);
  const a = await medirAnchos(page);
  expect(a.inner, 'el layout viewport no se ensancha').toBe(ancho);
  expect(a.visible).toBe(ancho);
  expect(a.scroll, 'sin scroll horizontal en la página').toBeLessThanOrEqual(a.inner);
  expect(a.barra, 'la barra superior cabe').toBeLessThanOrEqual(ancho);

  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  const panel = page.getByRole('complementary', { name: 'Dr. Flit' });
  await expect(panel).toBeVisible();
  const cajaPanel = await panel.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(Math.round(cajaPanel.width), 'el panel mide el ancho visible').toBe(ancho);
  const cerrar = panel.getByRole('button', { name: 'Cerrar' });
  await expect(cerrar).toBeVisible();
  const cajaCerrar = await cerrar.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(cajaCerrar.left).toBeGreaterThanOrEqual(0);
  expect(cajaCerrar.right, '«Cerrar» dentro de lo visible').toBeLessThanOrEqual(ancho);
  await cerrar.click();
  await expect(panel).toBeHidden();
}

test.describe('HU #13764 · AC7 en teléfono · iPhone 12 (390 px)', () => {
  test.use(IPHONE_12);
  test('la barra no desborda y «Cerrar» de Dr. Flit queda dentro de los 390 px visibles', async ({ page }) => {
    await comprobarSinDesborde(page, 390);
  });
});

test.describe('HU #13764 · AC7 en teléfono · 320 px', () => {
  test.use({ ...IPHONE_12, viewport: { width: 320, height: 640 } });
  test('a 320 px la barra cabe y «Cerrar» de Dr. Flit se ve', async ({ page }) => {
    await comprobarSinDesborde(page, 320);
  });
});

test.describe('HU #13764 · AC7 en teléfono · esqueleto de carga (iPhone 12)', () => {
  test.use(IPHONE_12);
  test('mientras se ve «Cargando página» el layout viewport sigue en 390 y no hay scroll horizontal', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    // En dev, Vite sirve el lazy de /flito/ayuda como /src/pages/FlitoAyuda.tsx: retenerlo deja el esqueleto.
    let soltar!: () => void;
    const retenido = new Promise<void>((r) => { soltar = r; });
    await page.route(/\/src\/pages\/FlitoAyuda\.tsx/, async (route) => { await retenido; await route.continue(); });
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('status', { name: 'Cargando página' })).toBeVisible();
    const a = await medirAnchos(page);
    expect(a.inner, 'el esqueleto no ensancha el layout viewport').toBe(390);
    expect(a.scroll, 'sin scroll horizontal con el esqueleto').toBeLessThanOrEqual(390);
    soltar();
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO' })).toBeVisible();
  });
});
