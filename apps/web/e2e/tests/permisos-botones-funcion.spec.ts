// HU #12170 — Botones por función efectiva (`GET /api/permisos/mios`).
//
// Certifica AC1/AC4/AC6 sobre el botón «Solicitar SOAT» de la cola FLITO:
//   · Conjunto vacío → el botón NO se pinta (mutante «helper siempre true» lo pondría).
//   · Con `soat.solicitud.crear` (+ canal) y SIN `soat.solicitud.enviar` → el botón SÍ se pinta
//     (mutante «helper siempre vacío» lo quitaría).
//
// `/permisos/mios` lo mockea `loginAs` con las `funciones` que se le pasan (AuthProvider lo pide al
// cuajar la sesión). Aquí decía «se mockea ANTES de loginAs» con un `page.route` propio: desde que
// `loginAs` registra el suyo por defecto, uno registrado antes quedaría tapado (Playwright evalúa
// las rutas en orden inverso de registro), así que el conjunto viaja por la opción del helper.
//
//   npx playwright test e2e/tests/permisos-botones-funcion.spec.ts --reporter=line

import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function mockCola(page: Page) {
  await page.route(/\/api\/flito\/soat(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill(json({
      items: [], total: 0, page: 1, pageSize: 50,
    }));
  });
  await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill(json({
    companias: [], organismos: [], proveedores: [],
  })));
}

test.describe('HU #12170 — botones por función efectiva', () => {
  test('conjunto vacío: no pinta «Solicitar SOAT» (AC4 / mutante siempre-true)', async ({ page }) => {
    await mockCola(page);
    await loginAs(page, CLIENTE_CON_CANAL, { funciones: [] });
    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' })).toHaveCount(0);
    await expect(page.getByText(/no tiene ninguna función habilitada/i)).toBeVisible();
  });

  test('con soat.solicitud.crear: pinta «Solicitar SOAT» (mutante siempre-vacío)', async ({ page }) => {
    await mockCola(page);
    await loginAs(page, CLIENTE_CON_CANAL, { funciones: [
      'soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.crear',
      'soat.solicitud.ver', 'soat.runt.preconsultar', 'soat.factura.leer',
    ] });
    await page.goto('/flito/soat');
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Cargar facturas/i })).toHaveCount(0);
  });
});
