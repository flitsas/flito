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

const TARIFAS = [
  { id: 't1', companiaId: 1, companiaNombre: 'ACME SAS', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 250000, activo: true },
  { id: 't2', companiaId: 1, companiaNombre: 'ACME SAS', concepto: 'logistica', tipoTramite: null, valor: 15000, activo: true },
];
const COMPANIAS = [
  { id: 1, nombre: 'ACME SAS', nit: '900111' },
  { id: 2, nombre: 'SIN TARIFAS SAS', nit: '900222' },
];

/** Se registra DESPUÉS de mock(): la última ruta que coincide gana en Playwright. */
async function mockTarifas(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/tarifas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TARIFAS) }));
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COMPANIAS) }));
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

  // ── HU #10964 — tarifas por compañía ────────────────────────────────────────

  test('la pestaña de tarifas lista lo configurado y distingue la genérica', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockTarifas(page);

    await page.goto('/flito/parametrizacion');
    await page.getByRole('button', { name: 'Tarifas', exact: true }).click();

    await expect(page.getByRole('cell', { name: 'TRASPASO', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Genérica (cualquier tipo)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva tarifa' })).toBeVisible();
  });

  test('avisa de las compañías que se quedarían sin liquidar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockTarifas(page);

    await page.goto('/flito/parametrizacion');
    await page.getByRole('button', { name: 'Tarifas', exact: true }).click();
    // ACME tiene tarifas; SIN TARIFAS no, y por eso debe salir advertida.
    await expect(page.getByText(/1 compañía\(s\) sin ninguna tarifa/)).toBeVisible();
    await expect(page.getByText('SIN TARIFAS SAS')).toBeVisible();
  });

  test('el formulario rechaza un valor negativo antes de enviarlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockTarifas(page);

    await page.goto('/flito/parametrizacion');
    await page.getByRole('button', { name: 'Tarifas', exact: true }).click();
    await page.getByRole('button', { name: 'Nueva tarifa' }).click();

    await page.getByLabel('Valor (COP) *').fill('-5');
    await expect(page.getByText(/mayor o igual a cero/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear', exact: true })).toBeDisabled();
  });

  test('auditor ve las tarifas pero no puede tocarlas', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await mockTarifas(page);

    await page.goto('/flito/parametrizacion');
    await page.getByRole('button', { name: 'Tarifas', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'TRASPASO', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva tarifa' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  });
});
