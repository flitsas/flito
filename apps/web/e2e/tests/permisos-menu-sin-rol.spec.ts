// HU #12872 — Menú, tablero y pantallas sin nombre de rol, con refresco de permisos en la sesión.
//
// Certifica (docs/qa/hu-12872-tcs.md):
//   AC1 — el nombre del rol no decide: un rol cualquiera con la página y la función ve «SOAT».
//   AC2 — sin la página no hay ítem, y la URL directa pinta «sin acceso» sin pedir la cola.
//   AC5 — «Mi ruta» por función (`logistica.ruta.ver`), no por ser `mensajero`.
//   AC6 — el tablero pinta solo los bloques cuyo destino abre el usuario, y no pide los demás.
//   AC7 — al volver a la pestaña o navegar, páginas y funciones se refrescan sin cerrar sesión.
//
// Trampa de `sobreDeMe` (∪ defaults del rol + allowedPages): cada positivo usa un rol cuyos
// defaults NO dan la página, y la página llega SOLO por `allowedPages`; cada uno lleva su control
// negativo con el mismo rol sin la página o sin la función.
//
//   npx playwright test e2e/tests/permisos-menu-sin-rol.spec.ts --reporter=line

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, sobreDeMe, sobreDeMios, FUNCIONES_POR_ROL,
  FINANCIERA_USER, AUDITOR_USER, MENSAJERO_USER, OPERACIONES_USER,
} from '../helpers/auth';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockColaSoat(page: Page) {
  await page.route(/\/api\/flito\/soat(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 }));
  });
  await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill(json({ companias: [], organismos: [], proveedores: [] })));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) => route.fulfill(json([])));
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });

/** Abre la sección del dock si existe (si no existe, no hay nada que abrir: es parte del aserto). */
async function abrirSeccion(page: Page, seccion: string) {
  await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();
  const boton = nav(page).getByRole('button', { name: seccion, exact: true });
  if (await boton.count()) await boton.click();
}

const enlaceMenu = (page: Page, nombre: string) => nav(page).getByRole('link', { name: nombre, exact: true });
const casillaPago = (page: Page) => page.getByRole('checkbox', { name: 'Incluir datos de pago y trazabilidad', exact: true });

test.describe('HU #12872 — acceso por permiso, sin nombre de rol', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC1 — financiera con la página SOAT y `soat.cola.ver` ve «SOAT» y entra a la cola', async ({ page }) => {
    await mockColaSoat(page);
    await loginAs(page, { ...FINANCIERA_USER, allowedPages: ['flito_soat'] }, {
      funciones: [...FUNCIONES_POR_ROL.financiera, 'soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver'],
    });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'SOAT')).toBeVisible();
    await enlaceMenu(page, 'SOAT').click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByText(/No tienes acceso/)).toHaveCount(0);
  });

  test('AC1 control — el mismo rol con la página pero SIN la función no ve «SOAT»', async ({ page }) => {
    await loginAs(page, { ...FINANCIERA_USER, allowedPages: ['flito_soat'] }, { funciones: FUNCIONES_POR_ROL.financiera });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'SOAT')).toHaveCount(0);
  });

  test('AC1 — otro nombre de rol (auditor) con lo mismo ve lo mismo', async ({ page }) => {
    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['flito_soat'] }, { funciones: ['soat.cola.ver'] });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'SOAT')).toBeVisible();
  });

  test('AC2 — sin la página de Impuestos: ni ítem, ni ⌘K, y la URL directa dice «sin acceso» sin pedir la cola', async ({ page }) => {
    let pedidas = 0;
    await page.route(/\/api\/flito\/impuestos/, (route: Route) => { pedidas += 1; return route.fulfill(json({ items: [], total: 0 })); });
    await loginAs(page, FINANCIERA_USER, { funciones: [...FUNCIONES_POR_ROL.financiera, 'impuestos.cola.ver'] });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'Impuestos')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('impuestos');
    await expect(page.getByRole('option', { name: /^Impuestos/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/flito/impuestos');
    const titulo = page.getByRole('heading', { name: /No tienes acceso a/ });
    await expect(titulo).toBeVisible();
    await expect(titulo).toBeFocused();
    const region = page.getByRole('region', { name: /No tienes acceso a/ });
    await expect(region).not.toContainText(/\brol\b/i);
    await expect(region.getByRole('link', { name: 'Volver al tablero' })).toHaveAttribute('href', '/');
    expect(pedidas).toBe(0);
  });

  test('AC5 — un rol que no es mensajero, con la página y `logistica.ruta.ver`, ve «Mi ruta»', async ({ page }) => {
    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['flito_logistica_ruta'] }, {
      funciones: [...FUNCIONES_POR_ROL.auditor, 'logistica.ruta.ver'],
    });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'Mi ruta')).toHaveAttribute('href', '/flito/ruta');
  });

  test('AC5 control — un mensajero con la página pero sin la función no ve «Mi ruta»', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER, { funciones: [] });
    await page.goto('/');
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'Mi ruta')).toHaveCount(0);
  });
});

test.describe('HU #12872 — AC6/AC9 · tablero por permiso del destino', () => {
  /** Cuenta las peticiones a los tres endpoints del tablero genérico. */
  async function contarTablero(page: Page, rndcStatus = 200) {
    const pedidas = { soat: 0, flota: 0, rndc: 0 };
    let rndc = rndcStatus;
    await page.route(/\/api\/soat\/stats/, (r) => { pedidas.soat += 1; return r.fulfill(json({ totalVehicles: 3, pendiente: 1, enviado: 0, comprado: 0, verificado: 2, rechazado: 0 })); });
    await page.route(/\/api\/fleet\/documents\/expiring/, (r) => { pedidas.flota += 1; return r.fulfill(json({ data: [], count: 0 })); });
    await page.route(/\/api\/rndc\/manifiestos/, (r) => {
      pedidas.rndc += 1;
      return rndc === 200 ? r.fulfill(json({ data: [], total: 0 })) : r.fulfill(json({ error: 'x' }, rndc));
    });
    return { pedidas, ponerRndc: (s: number) => { rndc = s; } };
  }

  test('solo PESV: dos atajos, sin «Estado operativo» y sin pedir SOAT, flota ni RNDC', async ({ page }) => {
    const { pedidas } = await contarTablero(page);
    await loginAs(page, { ...MENSAJERO_USER, allowedPages: ['pesv', 'pesv_tablero_ejecutivo'] }, { funciones: [] });
    await page.goto('/');
    const atajos = page.getByRole('region', { name: 'Atajos operacionales' });
    await expect(atajos.getByRole('link', { name: 'PESV — abrir' })).toBeVisible();
    await expect(atajos.getByRole('link', { name: 'Tablero ejecutivo — abrir' })).toBeVisible();
    await expect(atajos.getByRole('link')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Estado operativo' })).toHaveCount(0);
    expect(pedidas).toEqual({ soat: 0, flota: 0, rndc: 0 });
  });

  test('RNDC con error: el bloque dice que falló (no «OK») y reintentar lo llena', async ({ page }) => {
    const { pedidas, ponerRndc } = await contarTablero(page, 500);
    await loginAs(page, { ...MENSAJERO_USER, allowedPages: ['rndc'] }, { funciones: [] });
    await page.goto('/');
    const errores = page.getByTestId('tablero-bloque-error');
    await expect(errores.first()).toContainText('No pudimos cargar RNDC.');
    await expect(page.getByText('Envíos al día')).toHaveCount(0);
    ponerRndc(200);
    await errores.first().getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Envíos al día')).toBeVisible();
    await expect(errores).toHaveCount(0);
    expect(pedidas.soat).toBe(0);
  });

  test('sin ningún bloque: vacío útil, sin «0» sueltos', async ({ page }) => {
    const { pedidas } = await contarTablero(page);
    await loginAs(page, MENSAJERO_USER, { funciones: [] });
    await page.goto('/');
    await expect(page.getByTestId('tablero-vacio')).toContainText('Tu tablero no tiene indicadores con tus permisos actuales.');
    await expect(page.getByRole('region', { name: 'Atajos operacionales' })).toHaveCount(0);
    expect(pedidas).toEqual({ soat: 0, flota: 0, rndc: 0 });
  });
});

test.describe('HU #12872 — AC7 · refresco de permisos en la sesión', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** `/mios` y `/me` propios y mutables (los de `loginAs` quedan tapados: se registran después). */
  async function sesionMutable(page: Page) {
    const estado = {
      funciones: [...FUNCIONES_POR_ROL.admin],
      me: sobreDeMe(OPERACIONES_USER) as { allowedPages: string[] },
      mios: 0,
      fallarMios: false,
    };
    await loginAs(page, OPERACIONES_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => {
      estado.mios += 1;
      if (estado.fallarMios) return route.fulfill(json({ error: 'caído' }, 500));
      return route.fulfill(json(sobreDeMios(OPERACIONES_USER, estado.funciones)));
    });
    await page.route('**/api/auth/me', (route) => route.fulfill(json(estado.me)));
    return estado;
  }

  const volverALaPestana = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  test('al volver a la pestaña desaparece el botón cuya función se retiró, sin recargar', async ({ page }) => {
    await mockColaSoat(page);
    const estado = await sesionMutable(page);
    await page.goto('/flito/soat');
    await expect(casillaPago(page)).toHaveCount(1);
    const antes = estado.mios;

    // Control: volver sin cambios no vacía nada (un refresco falso que vacíe sería rojo aquí).
    await volverALaPestana(page);
    await expect.poll(() => estado.mios).toBeGreaterThan(antes);
    await expect(casillaPago(page)).toHaveCount(1);

    estado.funciones = estado.funciones.filter((c) => c !== 'soat.excel.exportar_pago');
    await volverALaPestana(page);
    await expect(casillaPago(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('un refresco que falla conserva la foto anterior (no amplía ni vacía)', async ({ page }) => {
    await mockColaSoat(page);
    const estado = await sesionMutable(page);
    await page.goto('/flito/soat');
    await expect(casillaPago(page)).toHaveCount(1);
    estado.fallarMios = true;
    const antes = estado.mios;
    await volverALaPestana(page);
    await expect.poll(() => estado.mios).toBeGreaterThan(antes);
    await expect(casillaPago(page)).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
  });

  test('al navegar (pasado el throttle) se refresca; perder la página pinta «sin acceso» en el sitio', async ({ page }) => {
    await page.clock.install();
    await mockColaSoat(page);
    const estado = await sesionMutable(page);
    await page.goto('/flito/soat');
    await expect(casillaPago(page)).toHaveCount(1);

    estado.funciones = estado.funciones.filter((c) => c !== 'soat.excel.exportar_pago');
    await page.clock.fastForward(16_000);
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('Tablero');
    await page.getByRole('option', { name: /^Tablero/ }).first().click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(casillaPago(page)).toHaveCount(0);

    // Ahora se retira la PÁGINA: al volver a la pestaña, la guarda pinta «sin acceso» en la misma URL.
    estado.me = { ...estado.me, allowedPages: estado.me.allowedPages.filter((p) => p !== 'flito_soat') };
    await volverALaPestana(page);
    await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toBeVisible();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await abrirSeccion(page, 'Gestión');
    await expect(enlaceMenu(page, 'SOAT')).toHaveCount(0);
  });
});
