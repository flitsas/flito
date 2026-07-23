import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Parametrización (Fase 6 · reorg P2.3b). Ahora solo proveedores SOAT y reglas;
// la autogestión de compañías vive en Clientes y la modalidad de organismos en Tránsito.
// Operaciones edita; Auditoría entra en solo lectura. Backend mockeado.

const PROVEEDORES = [
  { id: 'p1', nombre: 'Seguros Alfa', estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo: true },
];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/parametrizacion\/reglas-proveedor-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  // Reglas precarga compañías/organismos para sus selectores.
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route(/\/api\/flito\/parametrizacion\/organismos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
}

test.describe('FLITO — Parametrización', () => {
  test('operaciones ve proveedores por defecto y navega a reglas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/parametrizacion');
    await expect(page.getByRole('heading', { name: 'Parametrización', exact: true })).toBeVisible();
    // Tab por defecto: proveedores SOAT.
    await expect(page.getByRole('button', { name: 'Nuevo proveedor' })).toBeVisible();
    await expect(page.getByText('Seguros Alfa')).toBeVisible();
    // Ya no existen los tabs de Compañías ni Organismos (se movieron).
    await expect(page.getByRole('button', { name: 'Compañías' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Organismos' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Reglas SOAT' }).click();
    await expect(page.getByRole('button', { name: 'Nueva regla' })).toBeVisible();
  });

  test('auditor entra en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/parametrizacion');
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo proveedor' })).toHaveCount(0);
  });
});
