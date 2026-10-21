// HU #13764 — Dr. Flit: botón flotante y panel lateral en todas las pantallas (Feature #13694).
// Spec UX: docs/ux/flito-dr-flit.md · slim: docs/diseno/feature-13694-dr-flit-panel-slim.md
// TCs: docs/qa/tc-hu-13764-dr-flit-panel.md
import { test, expect, type Page } from '@playwright/test';
import { loginAs, FINANCIERA_USER, ADMIN_USER, CLIENTE_USER } from '../helpers/ayuda-fixtures';
import { sobreDeMe, sobreDeMios, TOKEN_E2E } from '../helpers/auth';

const CHUNK_PANEL = /DrFlitPanel/;
const boton = (page: Page) => page.getByRole('button', { name: 'Abrir Dr. Flit' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const SALUDO = 'Hola, soy Dr. Flit. Le ayudo a encontrar respuestas en los manuales de los módulos que usted usa.';

async function entrar(page: Page, user = FINANCIERA_USER, ruta = '/flito/ayuda') {
  await loginAs(page, user);
  await page.goto(ruta);
}

async function abrirDrFlit(page: Page) {
  await expect(boton(page)).toBeVisible();
  await boton(page).click();
  await expect(panel(page)).toBeVisible();
}

test.describe('HU #13764 · Dr. Flit — botón y panel', () => {
  test('AC1 · financiera ve «Abrir Dr. Flit» abajo a la derecha en / y en /flito/ayuda', async ({ page }) => {
    await entrar(page, FINANCIERA_USER, '/');
    await expect(boton(page)).toBeVisible();
    await page.goto('/flito/ayuda');
    await expect(boton(page)).toBeVisible();
    const caja = await boton(page).boundingBox();
    const vp = page.viewportSize()!;
    expect(caja).not.toBeNull();
    // Esquina inferior derecha: a ≤ 40 px de los bordes derecho e inferior.
    expect(vp.width - (caja!.x + caja!.width)).toBeLessThanOrEqual(40);
    expect(vp.height - (caja!.y + caja!.height)).toBeLessThanOrEqual(40);
  });

  test('AC2 · usuario con enlace de cliente nunca ve el botón', async ({ page }) => {
    await entrar(page, { ...CLIENTE_USER, allowedPages: ['flito_soat'] }, '/');
    await expect(page.getByRole('banner').first()).toBeVisible();
    // Esperar a que /mios haya respondido antes de afirmar la ausencia.
    await page.waitForLoadState('networkidle');
    await expect(boton(page)).toHaveCount(0);
  });

  // Login por formulario: `login()` hace `setUser` ANTES de `await cargarMios()`, así que el shell se
  // monta con `funciones === null`. Es el único camino donde la guarda fail-closed se ve (con token
  // sembrado, `AppRoutes` muestra «Cargando...» y el shell ni existe durante la espera).
  for (const [quien, user, loVeAlFinal] of [
    ['financiera', FINANCIERA_USER, true],
    ['cliente con enlace', { ...CLIENTE_USER, allowedPages: ['flito_soat'] }, false],
  ] as const) {
    test(`AC2 · ${quien}: tras el login, mientras /permisos/mios no responde el botón no se pinta`, async ({ page }) => {
      const me = { ...sobreDeMe(user) } as Record<string, unknown>;
      delete me.email;
      await page.route('**/api/auth/login', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ token: TOKEN_E2E, user: me }),
      }));
      await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
      let liberar!: () => void;
      const retenido = new Promise<void>((r) => { liberar = r; });
      await page.route(/\/api\/permisos\/mios$/, async (route) => {
        await retenido;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMios(user)) });
      });
      await page.goto('/login');
      const pedida = page.waitForRequest(/\/api\/permisos\/mios$/);
      await page.locator('#login-username').fill(user.username);
      await page.locator('#login-password').fill('clave-e2e');
      await page.locator('#login-password').press('Enter');
      await pedida;
      // El shell YA está montado durante la retención: la ausencia del botón prueba la guarda.
      await expect(page.getByRole('banner').first()).toBeVisible();
      await page.waitForTimeout(500);
      await expect(boton(page)).toHaveCount(0);
      liberar();
      await page.waitForLoadState('networkidle');
      if (loVeAlFinal) await expect(boton(page)).toBeVisible();
      else await expect(boton(page)).toHaveCount(0);
    });
  }

  test('AC2 · si /permisos/mios falla (500) el botón no se pinta', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('banner').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(boton(page)).toHaveCount(0);
  });

  test('AC3 · al pulsar se abre el panel «Dr. Flit», el foco entra y el fondo sigue usable', async ({ page }) => {
    await entrar(page);
    await expect(boton(page)).toHaveAttribute('aria-expanded', 'false');
    await abrirDrFlit(page);
    await expect(boton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('heading', { name: 'Dr. Flit' })).toBeFocused();
    // No modal: ni diálogo ni aria-modal.
    await expect(page.locator('#drflit-panel')).not.toHaveAttribute('aria-modal', /.*/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // La pantalla de fondo sigue usable con el panel abierto.
    const busqueda = page.getByRole('searchbox', { name: 'Buscar fichas' });
    await busqueda.fill('conciliación');
    await expect(busqueda).toHaveValue('conciliación');
    await expect(panel(page)).toBeVisible();
  });

  test('AC4 · «Cerrar» y Esc cierran el panel y devuelven el foco al botón', async ({ page }) => {
    await entrar(page);
    await abrirDrFlit(page);
    await panel(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(boton(page)).toBeFocused();
    await expect(boton(page)).toHaveAttribute('aria-expanded', 'false');

    await boton(page).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(boton(page)).toBeFocused();
  });

  // Diálogo de página: la paleta ⌘K (estable para cualquier rol y cierra con Esc). Declarado por el
  // TC de QA: financiera no tiene un FlitModal estable en /flito/ayuda.
  test('AC4 · con un diálogo de página abierto, Esc cierra el diálogo y no el panel', async ({ page }) => {
    await entrar(page);
    await abrirDrFlit(page);
    await page.keyboard.press('Control+k');
    const paleta = page.getByRole('dialog');
    await expect(paleta).toBeVisible();
    // El foco está en el diálogo (como en cualquier modal de página): Esc es suyo.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(paleta).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(boton(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('AC4 · Esc con el foco fuera del panel no lo cierra (TC-09)', async ({ page }) => {
    await entrar(page);
    await abrirDrFlit(page);
    await page.getByRole('searchbox', { name: 'Buscar fichas' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();
    await expect(boton(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('AC5 · panel recién abierto: saludo + «Abrir la Ayuda FLITO» hacia /flito/ayuda', async ({ page }) => {
    await entrar(page, FINANCIERA_USER, '/');
    await abrirDrFlit(page);
    await expect(panel(page).getByText(SALUDO)).toBeVisible();
    const enlace = panel(page).getByRole('link', { name: 'Abrir la Ayuda FLITO' });
    await expect(enlace).toHaveAttribute('href', '/flito/ayuda');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
  });

  test('AC6 · lg+: al cambiar de pantalla desde el menú el panel sigue abierto y el botón visible', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await entrar(page, FINANCIERA_USER, '/flito/ayuda');
    await abrirDrFlit(page);
    const dock = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(dock).toBeVisible();
    // Primer enlace del dock; si las secciones son desplegables, se abre la primera.
    let destino = dock.getByRole('link').first();
    if ((await dock.getByRole('link').count()) === 0) {
      await dock.getByRole('button').first().click();
      destino = page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link').first();
    }
    const href = await destino.getAttribute('href');
    await destino.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    expect(href).not.toBe('/flito/ayuda');
    await expect(panel(page)).toBeVisible();
    await expect(boton(page)).toBeVisible();
  });

  test('AC7 · <lg: panel a ancho completo, sin scroll horizontal, «Cerrar» visible, no modal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await entrar(page);
    await expect(boton(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    const antes = await page.evaluate(() => document.scrollingElement!.scrollTop);
    // El ancho desplazable del documento se compara contra sí mismo: el topbar de 375 px ya
    // desborda hoy sin Dr. Flit (deuda preexistente, fuera de esta HU). Abrir el panel no lo empeora.
    const anchoAntes = await page.evaluate(() => document.documentElement.scrollWidth);
    await abrirDrFlit(page);
    const caja = await panel(page).boundingBox();
    expect(Math.round(caja!.width)).toBe(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(anchoAntes);
    // El panel no tiene scroll horizontal propio ni se sale del viewport.
    expect(await page.locator('#drflit-panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(Math.round(caja!.x)).toBe(0);
    await expect(panel(page).getByRole('button', { name: 'Cerrar' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Sin trampa de foco: el topbar sigue alcanzable con el ratón y el teclado.
    await page.getByRole('banner').first().getByRole('button').first().focus();
    await expect(page.getByRole('banner').first().getByRole('button').first()).toBeFocused();
    await panel(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(boton(page)).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(antes);
  });

  for (const ancho of [1920, 1440, 1100]) {
    test(`AC7 · lg+ ${ancho} px: el botón queda fuera del dock (admin)`, async ({ page }) => {
      await page.setViewportSize({ width: ancho, height: 900 });
      await entrar(page, ADMIN_USER, '/flito/ayuda');
      const dock = page.getByRole('navigation', { name: 'Navegación principal' });
      await expect(dock).toBeVisible();
      await expect(boton(page)).toBeVisible();
      const d = (await dock.boundingBox())!;
      const b = (await boton(page).boundingBox())!;
      const solapan = b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y;
      expect(solapan).toBe(false);
    });
  }

  test('AC8 · sin abrir el panel su código no se descarga; al abrirlo, sí', async ({ page }) => {
    const pedidas: string[] = [];
    page.on('request', (r) => { if (CHUNK_PANEL.test(r.url())) pedidas.push(r.url()); });
    await entrar(page, FINANCIERA_USER, '/');
    await expect(boton(page)).toBeVisible();
    await page.goto('/flito/ayuda');
    await expect(boton(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(pedidas).toEqual([]);
    await abrirDrFlit(page);
    await expect(panel(page).getByText(SALUDO)).toBeVisible();
    // Si no hubo petición al chunk, el panel venía en el bundle y AC8 no se cumple.
    expect(pedidas.length).toBeGreaterThan(0);
  });

  test('AC9 · carga lenta muestra «Abriendo Dr. Flit…»; si falla, «Reintentar» trae la bienvenida', async ({ page }) => {
    await entrar(page);
    let intentos = 0;
    let liberar!: () => void;
    const retenido = new Promise<void>((r) => { liberar = r; });
    await page.route(CHUNK_PANEL, async (route) => {
      intentos += 1;
      if (intentos === 1) {
        await retenido;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await abrirDrFlit(page);
    await expect(panel(page).getByRole('status')).toHaveText('Abriendo Dr. Flit…');
    await expect(panel(page).getByRole('button', { name: 'Cerrar' })).toBeVisible();
    liberar();
    await expect(panel(page).getByText('No se pudo abrir Dr. Flit.')).toBeVisible();
    await expect(panel(page).getByText('Revise su conexión e intente de nuevo.')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel(page).getByText(SALUDO)).toBeVisible();
    expect(intentos).toBeGreaterThanOrEqual(2);
  });
});
