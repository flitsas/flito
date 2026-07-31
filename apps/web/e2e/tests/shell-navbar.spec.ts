// Shell sin sidebar — FlitNavBar, dock flotante al pie (HU #11143).
// Cubre: dónde vive el dock, apertura de módulos hacia arriba y dentro del
// viewport, subgrupos de los módulos grandes, condensado por scroll, contrato
// de teclado (disclosure APG + Escape que devuelve el foco), filtrado por
// permisos y drawer mobile como única navegación en <lg.
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// El home (/) renderiza <FlitoTablero>, que consume /flito/tablero como OBJETO (no lista).
// Sin este shape el dashboard antes reventaba y dejaba el shell en blanco.
const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('/auth/me')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  // Registrado después → tiene prioridad para /flito/tablero.
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
}

/** El tablero vacío no llega a una pantalla de alto; el condensado necesita scroll real. */
async function alargarPagina(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const relleno = document.createElement('div');
    relleno.style.height = '2400px';
    document.querySelector('main')?.appendChild(relleno);
  });
}

const dockLocator = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Navegación principal' });

test.describe('Shell · FlitNavBar (dock de escritorio)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('admin ve los 9 módulos; el panel de PESV abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav).toBeVisible();
    // Módulos de 1 ítem → link directo; el resto → trigger de disclosure.
    for (const label of ['Tablero', 'Flota']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    for (const label of ['Gestión', 'Tránsito', 'Mantenimiento', 'PESV', 'RNDC', 'Cumplimiento', 'Administración']) {
      await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    const pesvTrigger = nav.getByRole('button', { name: 'PESV', exact: true });
    await pesvTrigger.click();
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pesvTrigger).toBeFocused();

    // Navegar desde el panel lo cierra y marca el módulo activo.
    await pesvTrigger.click();
    await page.getByRole('link', { name: 'Conductores', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\/conductores/);
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('los módulos grandes se abren repartidos en subgrupos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    // Se busca el <p> del título y no el texto a secas: hay subgrupos que se
    // llaman igual que un ítem del propio panel (Logística es las dos cosas).
    const titulo = (panel: string, grupo: string) =>
      page.locator(`#${panel} p`).filter({ hasText: new RegExp(`^${grupo}$`) });

    const nav = dockLocator(page);
    await nav.getByRole('button', { name: 'PESV', exact: true }).click();
    for (const grupo of ['Dirección', 'Operación', 'Personas', 'Cumplimiento']) {
      await expect(titulo('flit-navbar-panel-pesv', grupo)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Gestión', exact: true }).click();
    for (const grupo of ['Trámites', 'Logística', 'Maestros']) {
      await expect(titulo('flit-navbar-panel-gestion', grupo)).toBeVisible();
    }
  });

  test('proveedor solo ve Gestión (vehicles + soat) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = dockLocator(page);
    await expect(nav.getByRole('button', { name: 'Gestión' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'PESV' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Administración' })).toHaveCount(0);

    await nav.getByRole('button', { name: 'Gestión' }).click();
    await expect(page.getByRole('link', { name: 'Vehículos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SOAT' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
  });
});

// El dock no ocupa sitio bajo el topbar: los offsets sticky de las páginas
// internas suman --flit-navbar-height al alto del topbar, así que ahora el
// token tiene que valer cero. Y desde el pie, el panel solo puede abrir hacia
// arriba — 1024px es el ancho donde el dock va más justo, y PESV con sus cuatro
// columnas es el panel que destapa los desbordes.
for (const width of [1024, 1440]) {
  test(`${width}px · el dock vive al pie, no reserva alto arriba y abre hacia arriba`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await nav.waitFor();

    expect(await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--flit-navbar-height').trim(),
    )).toBe('0px');

    const dock = (await nav.boundingBox())!;
    expect(dock.y).toBeGreaterThan(900 / 2);

    await nav.getByRole('button', { name: 'PESV', exact: true }).click();
    // Se espera a que acabe la animación de entrada: mide 6px de translateY y
    // falsearía el rect.
    await page.waitForTimeout(300);
    const panel = (await page.locator('#flit-navbar-panel-pesv').boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y + 1);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  });
}

test('el dock se condensa al bajar, no oscila y se reexpande arriba', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const nav = dockLocator(page);
  await nav.waitFor();
  await alargarPagina(page);

  const alto = () => page.evaluate(() => {
    const el = document.querySelector('[data-vt="floating-nav"]');
    return el ? Math.round(el.getBoundingClientRect().height) : -1;
  });

  const expandido = await alto();

  await page.mouse.wheel(0, 600);
  await expect.poll(alto).toBeLessThan(expandido);

  // No oscila: el rebote de scroll que provoca el propio cambio de layout no
  // puede devolverlo a expandido.
  await page.waitForTimeout(700);
  expect(await alto()).toBeLessThan(expandido);

  await page.mouse.wheel(0, -900);
  await expect.poll(alto).toBe(expandido);
});

test('al final de la página el dock no tapa el pie legal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const nav = dockLocator(page);
  await nav.waitFor();
  await alargarPagina(page);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400); // el dock se condensa al bajar

  // La pregunta no es "¿se ve el pie?" —estaría pintado igual debajo del dock—
  // sino qué elemento hay REALMENTE en ese punto de la pantalla.
  const pie = await page.evaluate(() => {
    const el = document.querySelector('footer');
    if (!el) return { error: 'no hay pie legal' };
    const b = el.getBoundingClientRect();
    const encima = document.elementFromPoint(b.left + 40, b.top + 6);
    return { visible: el.contains(encima) || encima === el };
  });
  expect(pie).toMatchObject({ visible: true });
});

test('mobile: navbar oculta, hamburguesa abre el drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeHidden();
  await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
  await expect(page.getByRole('dialog', { name: 'Menú de navegación' })).toBeVisible();
});
