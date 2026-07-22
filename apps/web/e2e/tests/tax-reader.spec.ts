import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Tax-reader — OCR de impuestos vehiculares.
// Cubre regresión Edison-403: usuario sin permiso `tax_reader` debe ser redirigido a /,
// NO ver mensaje "sin permisos" ni 403 silencioso.

test.describe('Tax-reader — control de permisos', () => {
  test('admin con allowedPages [*] ve la página', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.goto('/tax-reader');
    await expect(page.getByRole('heading', { name: /Lectura de Impuestos/i })).toBeVisible();
    await expect(page.getByText(/Sube declaraciones de impuesto vehicular/i)).toBeVisible();
  });

  test('usuario sin permiso tax_reader es redirigido a /', async ({ page }) => {
    // Rol con permisos limitados — NO incluye 'tax_reader'.
    const LIMITED_USER = {
      id: 99, username: 'e2e_limited', name: 'Sin Permiso',
      role: 'transito' as const, allowedPages: ['vehicles', 'soat'],
    };
    await loginAs(page, LIMITED_USER);
    await page.goto('/tax-reader');
    // ProtectedRoute redirige a / cuando hasPage(user, 'tax_reader') === false
    await expect(page).toHaveURL(/\/$/);
    // El header de tax-reader NO debe estar
    await expect(page.getByRole('heading', { name: /Lectura de Impuestos/i })).toHaveCount(0);
  });
});
