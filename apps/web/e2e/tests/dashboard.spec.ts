import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

test.describe('Dashboard', () => {
  test('admin ve métricas de SOAT y flota cuando entra a /', async ({ page }) => {
    await loginAs(page, ADMIN_USER);

    await page.route('**/api/soat/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalVehicles: 25,
          pendiente: 3,
          enviado: 1,
          comprado: 5,
          verificado: 14,
          rechazado: 2,
        }),
      })
    );
    await page.route('**/api/fleet/documents/expiring**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 4, items: [] }) })
    );
    await page.route('**/api/rndc/manifiestos**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], total: 0 }) })
    );

    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByText(/Admin E2E|Buenos|Buenas/i).first()).toBeVisible();
    // 25 vehículos aparece como número grande en alguna card
    await expect(page.getByText(/25/).first()).toBeVisible();
  });

  // FLOTA-04 — sección «Atención operativa» + deep links.
  test('admin ve «Atención operativa» con SOAT pendiente, vencidos y por vencer (deep links)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/soat/stats', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalVehicles: 25, pendiente: 2, enviado: 0, comprado: 5, verificado: 14, rechazado: 2 }) }));
    // Forma real del endpoint: { data, count }. 1 vencido + 3 por vencer.
    await page.route('**/api/fleet/documents/expiring**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 3, data: [{ estado: 'por_vencer' }, { estado: 'por_vencer' }, { estado: 'vencido' }] }) }));
    await page.route('**/api/rndc/manifiestos**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], total: 0 }) }));

    await page.goto('/');
    const section = page.getByRole('region', { name: 'Atención operativa' });
    await expect(section).toBeVisible();
    await expect(section.getByText(/2 solicitudes SOAT pendientes de compra/)).toBeVisible();
    await expect(section.getByText(/1 documento vencido/)).toBeVisible();
    await expect(section.getByText(/3 documentos por vencer en 60 días/)).toBeVisible();
    await expect(section.getByRole('link', { name: /Ir a SOAT/ })).toHaveAttribute('href', '/soat');
    await expect(section.getByRole('link', { name: /Ver vencimientos/ }).first()).toHaveAttribute('href', '/fleet?tab=vencimientos');
  });

  test('proveedor ve saludo minimal sin métricas', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page).toHaveURL('/');
    // El proveedor entra al fast path: greeting + hint de Cmd+K, sin cards de SOAT.
    await expect(page.getByText(/navegar a tus secciones/i)).toBeVisible();
  });
});
