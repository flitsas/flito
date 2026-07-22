import { test, expect } from '@playwright/test';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Parametrización (Fase 6). Compañías, proveedores SOAT, organismos y
// reglas. Operaciones edita; Auditoría entra en solo lectura. Backend mockeado.

const COMPANIAS = [
  { id: 1, nombre: 'Concesionario Norte', nit: '900111', soatAutogestionable: false,
    impuestosAutogestionable: false, logisticaAutogestionable: false, carpetaStorage: null, toleranciaValorImpuesto: 1000 },
];
const PROVEEDORES = [
  { id: 'p1', nombre: 'Seguros Alfa', estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo: true },
];
const ORGANISMOS = [
  { codigo: 'STT-MZL', nombre: 'STT Manizales', alias: 'Manizales', activo: true,
    modalidadVigente: 'requiere_gestion', umbralOcr: 0.8, slaHoras: 48, tramitesRetenidos: 0 },
];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COMPANIAS) }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/parametrizacion\/organismos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORGANISMOS) }));
  await page.route(/\/api\/flito\/parametrizacion\/reglas-proveedor-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
}

test.describe('FLITO — Parametrización', () => {
  test('operaciones navega tabs y ve acciones de edición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/parametrizacion');
    await expect(page.getByRole('heading', { name: 'Parametrización', exact: true })).toBeVisible();
    // Tab por defecto: compañías.
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Proveedores SOAT' }).click();
    await expect(page.getByRole('button', { name: 'Nuevo proveedor' })).toBeVisible();
    await expect(page.getByText('Seguros Alfa')).toBeVisible();

    await page.getByRole('button', { name: 'Organismos' }).click();
    await expect(page.getByText('STT Manizales')).toBeVisible();

    await page.getByRole('button', { name: 'Reglas SOAT' }).click();
    await expect(page.getByRole('button', { name: 'Nueva regla' })).toBeVisible();
  });

  test('auditor entra en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/parametrizacion');
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  });
});
