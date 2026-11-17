// Shell del UI Kit 2026 (Épica #14560, Sesión A) — navegación responsive:
//   · ≥1024 px: dock con «Más». Las secciones que caben van con nombre, en SECTION_ORDER; las que no, en el panel
//     del «Más», en el mismo orden. Fila + «Más» = el menú completo, sin perder ni repetir ninguna.
//   · <1024 px: sin dock; el ☰ del topbar abre el menú lateral con las mismas secciones en el mismo orden. Escape lo
//     cierra y devuelve el foco al ☰; navegar lo cierra.
// La referencia del orden es el propio dock a 1920 px, donde caben las 11 secciones del admin (shell-navbar.spec.ts
// ya compara esa fila con los nombres del catálogo): así este spec no fija a mano las claves de sección.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    // `/auth/me` y `/permisos/mios` los sirve `loginAs`: el catch-all no puede taparlos.
    const url = route.request().url();
    if (url.includes('/auth/me') || url.includes('/permisos/mios')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
}

const dock = (page: Page) => page.locator('[data-vt="floating-nav"]');
const botonMenu = (page: Page) => page.getByRole('button', { name: 'Abrir menú de navegación' });
const menuLateral = (page: Page) => page.getByRole('dialog', { name: 'Menú de navegación' });

/** Claves de sección de la fila del dock, en el orden del DOM, sin el «Más». */
const seccionesDeLaFila = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelector('[data-vt="floating-nav"]')!.children)
    .map((k) => k.getAttribute('data-seccion') ?? '')
    .filter((s) => s !== 'mas'));

async function ordenDeReferencia(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByRole('button', { name: 'Más', exact: true })).toHaveCount(0);
  const orden = await seccionesDeLaFila(page);
  expect(orden).toHaveLength(11);
  return orden;
}

test.describe('Shell · dock con «Más» (≥1024 px)', () => {
  for (const width of [1280, 1440]) {
    test(`${width} px · fila con nombre + «Más» = SECTION_ORDER completo, en orden`, async ({ page }) => {
      const referencia = await ordenDeReferencia(page);
      await page.setViewportSize({ width, height: 900 });

      const mas = dock(page).getByRole('button', { name: 'Más', exact: true });
      await expect(mas).toBeVisible();
      await expect(mas).toHaveAttribute('aria-expanded', 'false');
      const enFila = await seccionesDeLaFila(page);
      expect(enFila.length).toBeGreaterThan(0);
      expect(enFila.length).toBeLessThan(11);
      // Las de la fila, con su nombre a la vista (no hay modo solo-íconos).
      const nombresOcultos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-vt="floating-nav"] .dock__nombre'))
          .filter((n) => (n as HTMLElement).offsetWidth <= 1).length);
      expect(nombresOcultos).toBe(0);

      await mas.click();
      await expect(mas).toHaveAttribute('aria-expanded', 'true');
      await expect(mas).toHaveAttribute('aria-controls', 'flit-navbar-panel-mas');
      const panel = page.locator('#flit-navbar-panel-mas');
      await expect(panel).toBeVisible();
      const enMas = await panel.locator('.dock__seccion').evaluateAll((els) => els.map((e) => e.getAttribute('data-seccion') ?? ''));
      expect([...enFila, ...enMas]).toEqual(referencia);

      // El panel cabe en la pantalla y queda por encima del dock.
      await page.waitForTimeout(300);
      const cajaPanel = (await panel.boundingBox())!;
      const cajaDock = (await dock(page).boundingBox())!;
      expect(cajaPanel.x).toBeGreaterThanOrEqual(0);
      expect(cajaPanel.x + cajaPanel.width).toBeLessThanOrEqual(width);
      expect(cajaPanel.y).toBeGreaterThanOrEqual(0);
      expect(cajaPanel.y + cajaPanel.height).toBeLessThanOrEqual(cajaDock.y + 1);

      // Escape cierra y devuelve el foco al «Más».
      await page.keyboard.press('Escape');
      await expect(mas).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toHaveCount(0);
      await expect(mas).toBeFocused();

      // Navegar desde el «Más» lo cierra.
      await mas.click();
      await panel.getByRole('link').first().click();
      await expect(panel).toHaveCount(0);
    });
  }

  test('1440 px · sin ☰ en el topbar: la navegación es el dock', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await expect(dock(page)).toBeVisible();
    await expect(botonMenu(page)).toHaveCount(0);
  });
});

test.describe('Shell · ☰ y menú lateral (<1024 px)', () => {
  for (const width of [390, 768]) {
    test(`${width} px · el ☰ abre el menú lateral con SECTION_ORDER; Escape lo cierra y el foco vuelve al ☰`, async ({ page }) => {
      const referencia = await ordenDeReferencia(page);
      await page.setViewportSize({ width, height: 844 });

      await expect(dock(page)).toHaveCount(0);
      const boton = botonMenu(page);
      await expect(boton).toBeVisible();
      await expect(boton).toHaveAttribute('aria-expanded', 'false');

      await boton.click();
      const menu = menuLateral(page);
      await expect(menu).toBeVisible();
      await expect(boton).toHaveAttribute('aria-expanded', 'true');
      // Trampa de foco: el foco entra al diálogo.
      expect(await page.evaluate(() => !!document.activeElement?.closest('#flit-menu-lateral'))).toBe(true);

      const orden = await menu.locator('.menu-lateral__secciones > li').evaluateAll((els) => els.map((e) => e.getAttribute('data-seccion') ?? ''));
      expect(orden).toEqual(referencia);

      // El panel no desborda la pantalla.
      const caja = (await menu.boundingBox())!;
      expect(caja.x).toBeGreaterThanOrEqual(0);
      expect(caja.x + caja.width).toBeLessThanOrEqual(width);

      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(boton).toBeFocused();
      await expect(boton).toHaveAttribute('aria-expanded', 'false');
    });
  }

  test('390 px · navegar desde el menú lateral lo cierra; «Cerrar menú» también', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    await botonMenu(page).click();
    const menu = menuLateral(page);
    await menu.getByRole('button', { name: 'Cerrar menú' }).click();
    await expect(menu).toHaveCount(0);
    await expect(botonMenu(page)).toBeFocused();

    await botonMenu(page).click();
    const gestion = menu.getByRole('button', { name: 'Gestión', exact: true });
    await gestion.click();
    await expect(gestion).toHaveAttribute('aria-expanded', 'true');
    const enlace = menu.locator('#flit-menu-lateral-gestion').getByRole('link').first();
    const destino = await enlace.getAttribute('href');
    await enlace.click();
    await expect(menu).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(destino);
  });

  test('1023 → 1024 px · al pasar a lg el menú lateral se cierra y aparece el dock', async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await botonMenu(page).click();
    await expect(menuLateral(page)).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(menuLateral(page)).toHaveCount(0);
    await expect(dock(page)).toBeVisible();
  });
});
