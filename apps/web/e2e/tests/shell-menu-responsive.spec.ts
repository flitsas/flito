// Shell del UI Kit 2026 (Épica #14560, Sesión A) — navegación responsive. Épica #14678 (menú por áreas,
// spec docs/ux/epica-14678-menu-por-areas.md §3 y §7):
//   · ≥1024 px: dock en UNA fila con las seis opciones del admin (Operaciones, Financiera, Gerencial, Kyverum,
//     Administración, Ayuda), en SECTION_ORDER y con nombre; caben sin «Más». Los paneles abren hacia arriba.
//   · <1024 px: sin dock; el ☰ del topbar abre el menú lateral con las mismas opciones en el mismo orden, en
//     acordeón (varias abiertas a la vez, la de la página actual abierta de entrada) y subgrupos plegables con su
//     cantidad (Kyverum: siete; Gerencial: Torre de Control). Escape lo cierra y devuelve el foco al ☰; navegar lo cierra.
// La referencia del orden es el propio dock a 1920 px (shell-navbar.spec.ts ya compara esos nombres con el catálogo):
// así este spec no fija a mano las claves de las opciones.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, sobreDeMios, ADMIN_USER, MENSAJERO_USER } from '../helpers/auth';
import { COPY_MENU_ERROR, COPY_MENU_VACIO } from '../../src/components/shell/useEstadoMenu';

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

/** Claves de las opciones de la fila del dock, en el orden del DOM (sin el indicador ni el «Más»). */
const seccionesDeLaFila = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelector('[data-vt="floating-nav"]')!.children)
    .map((k) => k.getAttribute('data-seccion') ?? '')
    .filter((s) => s !== '' && s !== 'mas'));

async function ordenDeReferencia(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByRole('button', { name: 'Más', exact: true })).toHaveCount(0);
  const orden = await seccionesDeLaFila(page);
  expect(orden).toEqual(['operaciones', 'financiera', 'gerencial', 'kyverum', 'administracion', 'ayuda']);
  return orden;
}

test.describe('Shell · dock (≥1024 px)', () => {
  for (const width of [1024, 1280, 1440]) {
    test(`${width} px · las seis opciones en una fila, con nombre y en SECTION_ORDER; un panel abre encima y cierra`, async ({ page }) => {
      const referencia = await ordenDeReferencia(page);
      await page.setViewportSize({ width, height: 900 });

      await expect(dock(page).getByRole('button', { name: 'Más', exact: true })).toHaveCount(0);
      await expect.poll(() => seccionesDeLaFila(page)).toEqual(referencia);
      // Con su nombre a la vista (no hay modo solo-íconos).
      const nombresOcultos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-vt="floating-nav"] .dock__nombre'))
          .filter((n) => (n as HTMLElement).offsetWidth <= 1).length);
      expect(nombresOcultos).toBe(0);

      const trigger = dock(page).getByRole('button', { name: 'Administración', exact: true });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(trigger).toHaveAttribute('aria-controls', 'flit-navbar-panel-administracion');
      const panel = page.locator('#flit-navbar-panel-administracion');
      await expect(panel).toBeVisible();

      // El panel cabe en la pantalla y queda por encima del dock.
      await page.waitForTimeout(300);
      const cajaPanel = (await panel.boundingBox())!;
      const cajaDock = (await dock(page).boundingBox())!;
      expect(cajaPanel.x).toBeGreaterThanOrEqual(0);
      expect(cajaPanel.x + cajaPanel.width).toBeLessThanOrEqual(width);
      expect(cajaPanel.y).toBeGreaterThanOrEqual(0);
      expect(cajaPanel.y + cajaPanel.height).toBeLessThanOrEqual(cajaDock.y + 1);

      // Escape cierra y devuelve el foco al botón de la opción.
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // Navegar desde el panel lo cierra.
      await trigger.click();
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

      // El panel no desborda la pantalla (se mide al terminar su entrada desde la izquierda).
      await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
      const caja = (await menu.boundingBox())!;
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
    const operaciones = menu.getByRole('button', { name: 'Operaciones', exact: true });
    await operaciones.click();
    await expect(operaciones).toHaveAttribute('aria-expanded', 'true');
    const enlace = menu.locator('#flit-menu-lateral-operaciones').getByRole('link').first();
    await expect(enlace).toBeVisible();
    const destino = await enlace.getAttribute('href');
    await enlace.click();
    await expect(menu).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(destino);
  });

  test('390 px · acordeón: varias opciones abiertas a la vez; subgrupos plegables con su cantidad; lo cerrado no se ve', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await botonMenu(page).click();
    const menu = menuLateral(page);

    const operaciones = menu.getByRole('button', { name: 'Operaciones', exact: true });
    const kyverum = menu.getByRole('button', { name: 'Kyverum', exact: true });
    await expect(kyverum).toHaveAttribute('aria-expanded', 'false');
    // Cerrado = fuera de la vista y del orden de Tab (visibility: hidden).
    await expect(menu.locator('#flit-menu-lateral-kyverum')).toBeHidden();
    await operaciones.click();
    await kyverum.click();
    await expect(operaciones).toHaveAttribute('aria-expanded', 'true');
    await expect(kyverum).toHaveAttribute('aria-expanded', 'true');

    // Kyverum: siete subgrupos plegables, en el orden del riel, con su cantidad.
    const subgrupos = menu.locator('#flit-menu-lateral-kyverum .menu-lateral__sub');
    await expect(subgrupos).toHaveCount(7);
    expect(await subgrupos.locator('.menu-lateral__nombre').allTextContents())
      .toEqual(['Tránsito', 'Flota', 'Mantenimiento', 'PESV', 'RNDC', 'LAFT', 'Trámites']);
    const pesv = menu.getByRole('button', { name: 'PESV', exact: true });
    await expect(pesv.locator('.menu-lateral__cuenta')).toHaveText('25');
    await expect(menu.getByRole('link', { name: 'Conductores', exact: true })).toBeHidden();
    await pesv.click();
    await expect(pesv).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('link', { name: 'Conductores', exact: true })).toBeVisible();

    // Sin desborde horizontal dentro del cajón.
    const desborde = await menu.evaluate((el) => {
      const cuerpo = el.querySelector('.menu-lateral__cuerpo') as HTMLElement;
      return cuerpo.scrollWidth - cuerpo.clientWidth;
    });
    expect(desborde).toBeLessThanOrEqual(0);
  });

  test('390 px · en una página de Kyverum el cajón abre la opción y el subgrupo de esa página', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/pesv/conductores');
    await botonMenu(page).click();
    const menu = menuLateral(page);
    await expect(menu.getByRole('button', { name: 'Kyverum', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', { name: 'Kyverum', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(menu.getByRole('button', { name: 'PESV', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', { name: 'RNDC', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('link', { name: 'Conductores', exact: true })).toHaveAttribute('aria-current', 'page');
    // `/pesv` es prefijo de la página actual: su entrada no se marca (`finExacto`); solo hay una entrada actual.
    await expect(menu.locator('a[href="/pesv"]')).not.toHaveAttribute('aria-current', /.*/);
    await expect(menu.locator('a[aria-current="page"]')).toHaveCount(1);
  });

  // Spec UX §4: en el cajón, el mismo mensaje que en la barra, arriba; sin toast.
  test('390 px · error: «No se pudo cargar el menú.» con «Reintentar»; al reintentar aparecen las opciones', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let falla = true;
    await loginAs(page, ADMIN_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => (falla
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMios(ADMIN_USER)) })));
    await mockApi(page);
    await page.goto('/');
    await botonMenu(page).click();
    const menu = menuLateral(page);
    await expect(menu.getByRole('alert')).toHaveText(COPY_MENU_ERROR);
    await expect(menu.getByRole('button', { name: 'Operaciones', exact: true })).toHaveCount(0);
    falla = false;
    await menu.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(menu.getByRole('button', { name: 'Operaciones', exact: true })).toBeVisible();
    await expect(menu.getByRole('alert')).toHaveCount(0);
  });

  test('390 px · vacío: sin ninguna opción, el aviso con el siguiente paso arriba del cajón', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, { ...MENSAJERO_USER, role: 'e2e_sin_modulos', allowedPages: [] }, { funciones: [] });
    await mockApi(page);
    await page.goto('/');
    await botonMenu(page).click();
    const menu = menuLateral(page);
    await expect(menu.getByRole('status')).toHaveText(COPY_MENU_VACIO);
    await expect(menu.locator('.menu-lateral__secciones')).toHaveCount(0);
    // Solo «Cerrar menú»: ninguna opción desplegable.
    await expect(menu.getByRole('button')).toHaveCount(1);
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
