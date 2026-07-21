// Clientes (/clients) — panel de autogestión FLITO por compañía (reorg P2.3b).
// La autogestión (antes en Parametrización) se administra junto a la cartera de clientes.
// Solo Operaciones/admin lo ven; backend mockeado.
import { test, expect } from '@playwright/test';
import { loginAs, OPERACIONES_USER, ADMIN_USER } from '../helpers/auth';

const COMPANIAS = [
  { id: 1, nombre: 'Concesionario Norte', nit: '900111', soatAutogestionable: true,
    impuestosAutogestionable: false, logisticaAutogestionable: false, carpetaStorage: null, toleranciaValorImpuesto: 1000 },
];

async function mock(page: import('@playwright/test').Page, companias = COMPANIAS) {
  await page.route(/\/api\/clients(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(companias) }));
}

test.describe('Clientes · autogestión FLITO', () => {
  test('operaciones ve el panel de compañías con acción de edición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: /autogestión flito por compañía/i })).toBeVisible();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' }).first()).toBeVisible();
  });

  test('admin abre el modal de edición de la compañía', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);

    await page.goto('/clients');
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await expect(page.getByText('SOAT autogestionable')).toBeVisible();
    await expect(page.getByText('Tolerancia de valor de impuesto')).toBeVisible();
  });
});
