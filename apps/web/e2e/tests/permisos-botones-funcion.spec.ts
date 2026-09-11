// HU #12170 — Botones por función efectiva (`GET /api/permisos/mios`).
//
// Certifica AC1/AC4/AC6 sobre el botón «Solicitar SOAT» de la cola FLITO:
//   · Conjunto vacío → el botón NO se pinta (mutante «helper siempre true» lo pondría).
//   · Con `soat.solicitud.crear` (+ canal) y SIN `soat.solicitud.enviar` → el botón SÍ se pinta
//     (mutante «helper siempre vacío» lo quitaría).
//
// `/permisos/mios` se mockea ANTES de `loginAs`: AuthProvider lo pide al cuajar la sesión.
//
//   npx playwright test e2e/tests/permisos-botones-funcion.spec.ts --reporter=line

import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function mockMiosYCola(page: Page, funciones: string[]) {
  await page.route(/\/api\/permisos\/mios$/, (route) => route.fulfill(json({
    funciones,
    rol: 'cliente',
    tipoPrincipal: 'externo',
    version: 1,
    resueltoEn: new Date().toISOString(),
  })));
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
    await mockMiosYCola(page, []);
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' })).toHaveCount(0);
    await expect(page.getByText(/no tiene ninguna función habilitada/i)).toBeVisible();
  });

  test('con soat.solicitud.crear: pinta «Solicitar SOAT» (mutante siempre-vacío)', async ({ page }) => {
    await mockMiosYCola(page, [
      'soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.crear',
      'soat.solicitud.ver', 'soat.runt.preconsultar', 'soat.factura.leer',
    ]);
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat');
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Cargar facturas/i })).toHaveCount(0);
  });
});
