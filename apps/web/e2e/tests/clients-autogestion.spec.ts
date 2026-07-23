// Clientes (/clients) — una sola tabla: info de empresa + checkboxes de autogestión FLITO
// (SOAT/Impuestos/Logística) inline. Un cliente ES una compañía FLITO (§correcciones-UX).
// Solo Operaciones/admin lo ven; backend mockeado.
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const CLIENTES = [
  {
    id: 1, name: 'Concesionario Norte', document: '900111', documentType: 'NIT',
    phone: '3001112233', email: 'norte@x.co', address: null, city: 'Manizales', notes: null, active: true,
    soatAutogestionable: true, impuestosAutogestionable: false, logisticaAutogestionable: false,
  },
];

async function mock(page: import('@playwright/test').Page, clientes = CLIENTES) {
  await page.route(/\/api\/clients(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(clientes) }));
}

test.describe('Clientes · autogestión FLITO', () => {
  test('operaciones ve una sola tabla con la empresa y sus checkboxes de autogestión', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/clients');
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    // Info relevante de la empresa.
    await expect(page.getByRole('cell', { name: /900111/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Manizales' })).toBeVisible();
    // Checkboxes reflejan los flags: SOAT marcado, Impuestos/Logística no.
    await expect(page.getByRole('checkbox', { name: /Autogestión SOAT de Concesionario Norte/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Autogestión Impuestos de Concesionario Norte/ })).not.toBeChecked();
    // Ya no hay dos tablas ni botón Editar / columna Tolerancia.
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Tolerancia/i })).toHaveCount(0);
  });

  test('marcar un checkbox dispara el PATCH del flag de la compañía', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1 }) });
    });

    await page.goto('/clients');
    await page.getByRole('checkbox', { name: /Autogestión Impuestos de Concesionario Norte/ }).check();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ impuestosAutogestionable: true });
    await expect(page.getByRole('checkbox', { name: /Autogestión Impuestos de Concesionario Norte/ })).toBeChecked();
  });
});
