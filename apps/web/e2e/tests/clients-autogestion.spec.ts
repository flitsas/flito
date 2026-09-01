// Clientes (/clients) — una sola tabla: info de empresa + checkboxes de autogestión FLITO
// (SOAT/Impuestos/Logística) inline. Un cliente ES una compañía FLITO (§correcciones-UX).
// Solo Operaciones/admin lo ven; backend mockeado.
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const CLIENTES = [
  {
    id: 1, name: 'Concesionario Norte', document: '900111', documentType: 'NIT',
    phone: '3001112233', email: 'norte@x.co', address: null, city: 'Manizales', notes: null, active: true,
    soatAutogestionable: true, soatSinTramite: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
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

// ─────────────────────── Módulo fusionado (HU #10979) ───────────────────────
//
// «Clientes y proveedores» absorbió la antigua Parametrización: las tarifas se abren por fila y los
// proveedores SOAT viven en su propia pestaña. Estos casos vienen del spec de Parametrización, que
// se retiró con la página.

const PROVEEDORES = [
  { id: 'p1', nombre: 'Seguros Alfa', estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo: true },
];
const TARIFAS = [
  { id: 't1', companiaId: 1, companiaNombre: 'Concesionario Norte', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 250000, activo: true },
  { id: 't2', companiaId: 1, companiaNombre: 'Concesionario Norte', concepto: 'logistica', tipoTramite: null, valor: 15000, activo: true },
];

async function mockModulo(page: import('@playwright/test').Page, tarifas = TARIFAS) {
  await mock(page);
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/parametrizacion\/tarifas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tarifas) }));
}

test.describe('Clientes y proveedores · módulo fusionado', () => {
  test('las dos pestañas conviven en una sola pantalla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clientes y proveedores' })).toBeVisible();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();

    await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Seguros Alfa' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'portal' })).toBeVisible();
  });

  test('las tarifas se abren desde la fila del cliente y distinguen la genérica', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await page.getByRole('button', { name: 'Tarifas' }).click();

    await expect(page.getByText('Tarifas de Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'TRASPASO' })).toBeVisible();
    // Una tarifa sin tipo aplica a cualquiera: decirlo evita leerla como un hueco.
    await expect(page.getByRole('cell', { name: 'Genérica (cualquier tipo)' })).toBeVisible();
  });

  test('un cliente sin tarifas avisa de que no se podrá liquidar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page, []);

    await page.goto('/clients');
    await page.getByRole('button', { name: 'Tarifas' }).click();
    await expect(page.getByText(/no podrán liquidarse/)).toBeVisible();
  });

  test('el formulario de tarifa rechaza un valor negativo antes de enviarlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await page.getByRole('button', { name: 'Tarifas' }).click();
    await page.getByRole('button', { name: 'Nueva tarifa' }).click();

    await page.getByLabel('Valor (COP) *').fill('-5');
    await expect(page.getByText(/mayor o igual a cero/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear' })).toBeDisabled();
  });

  test('ya no existe la pestaña de reglas de enrutamiento', async ({ page }) => {
    // El proveedor se elige al enviar el SOAT al gestor; las reglas por ámbito se retiraron.
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await expect(page.getByRole('button', { name: /Reglas/ })).toHaveCount(0);
  });
});
