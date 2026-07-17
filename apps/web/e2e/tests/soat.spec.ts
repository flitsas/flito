import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// SOAT — gestión de solicitudes (módulo operativo no-PESV).
// Cubre lectura, filtros por estado y diferencias admin vs proveedor.

const SOAT_FIXTURE = [
  {
    id: 1, vehicleId: 10, vin: 'VIN0000000001PEND', plate: 'EEE001', ownerName: 'Conductor E2E',
    ownerDocument: '99999999', brand: 'Chevrolet', model: 'NPR', status: 'pendiente',
    policyNumber: null, insurer: null, purchaseDate: null, expiryDate: null,
    runtVerified: false, soatHolder: null, assignedToName: null, notes: null,
    createdAt: '2026-04-01T12:00:00Z',
  },
  {
    id: 2, vehicleId: 11, vin: 'VIN0000000002COMP', plate: 'EEE002', ownerName: 'Logística E2E',
    ownerDocument: '99999998', brand: 'Hino', model: 'FC', status: 'comprado',
    policyNumber: 'Pendiente verificacion RUNT', insurer: 'Pendiente',
    purchaseDate: '2026-04-15', expiryDate: null,
    runtVerified: false, soatHolder: null, assignedToName: null, notes: null,
    createdAt: '2026-04-15T12:00:00Z',
  },
  {
    id: 3, vehicleId: 12, vin: 'VIN0000000003VERI', plate: 'EEE003', ownerName: 'Transportes E2E',
    ownerDocument: '99999997', brand: 'Volvo', model: 'FH', status: 'verificado',
    policyNumber: 'POL-12345', insurer: 'SBS Seguros',
    purchaseDate: '2026-03-01', expiryDate: '2027-03-01',
    runtVerified: true, soatHolder: null, assignedToName: null, notes: null,
    createdAt: '2026-03-01T12:00:00Z',
  },
];

test.describe('SOAT — gestión de solicitudes', () => {
  test('admin lista solicitudes y ve estados/filtros', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/soat**', (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get('status');
      const data = status ? SOAT_FIXTURE.filter((r) => r.status === status) : SOAT_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });

    await page.goto('/soat');
    // Cambiar a tab "Gestión de compras" — el default es "Consultar RUNT"
    await page.getByRole('button', { name: /Gesti[óo]n de compras/i }).click();
    await expect(page.getByRole('heading', { name: /Gesti[óo]n SOAT/i })).toBeVisible();
    // 3 solicitudes: una de cada estado clave
    await expect(page.getByText(/EEE001/)).toBeVisible();
    await expect(page.getByText(/EEE002/)).toBeVisible();
    await expect(page.getByText(/EEE003/)).toBeVisible();
    // Filtros visibles (Todos + 5 estados)
    await expect(page.getByRole('button', { name: /Pendientes/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Comprados/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Verificados/i })).toBeVisible();
  });

  test('filtro pendientes dispara request con query string', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    let lastUrl = '';
    await page.route('**/api/soat**', (route) => {
      lastUrl = route.request().url();
      const url = new URL(lastUrl);
      const status = url.searchParams.get('status');
      const data = status ? SOAT_FIXTURE.filter((r) => r.status === status) : SOAT_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });

    await page.goto('/soat');
    await page.getByRole('button', { name: /Gesti[óo]n de compras/i }).click();
    await page.getByRole('button', { name: /Pendientes/i }).click();
    await expect.poll(() => lastUrl, { timeout: 10_000 }).toContain('status=pendiente');
    // El de estado verificado NO debe aparecer
    await expect(page.getByText(/EEE001/)).toBeVisible();
    await expect(page.getByText(/EEE003/)).not.toBeVisible();
  });

  test('admin ve CTA "Nueva solicitud"; proveedor NO', async ({ page }) => {
    // Caso admin
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/soat**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SOAT_FIXTURE) })
    );
    await page.goto('/soat');
    await page.getByRole('button', { name: /Gesti[óo]n de compras/i }).click();
    await expect(page.getByRole('button', { name: /Nueva solicitud/i })).toBeVisible();

    // Caso proveedor — recargo sesión con otro usuario
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/soat');
    await page.getByRole('button', { name: /Gesti[óo]n de compras/i }).click();
    await expect(page.getByRole('button', { name: /Nueva solicitud/i })).toHaveCount(0);
  });

  test('card pendiente muestra CTA "Registrar compra" y abre modal', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/soat**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SOAT_FIXTURE[0]]) })
    );

    await page.goto('/soat');
    await page.getByRole('button', { name: /Gesti[óo]n de compras/i }).click();
    // Banner amarillo "1 pendientes de compra" debe estar
    await expect(page.getByText(/pendientes de compra/i)).toBeVisible();
    // Click en CTA registrar compra de la card
    await page.getByRole('button', { name: /Registrar compra/i }).first().click();
    // Modal con info del vehículo
    await expect(page.getByRole('heading', { name: /Registrar compra SOAT/i })).toBeVisible();
    await expect(page.getByText(/EEE001/).first()).toBeVisible();
    // Botón "Guardar compra" deshabilitado sin archivo
    const guardar = page.getByRole('button', { name: /Guardar compra/i });
    await expect(guardar).toBeDisabled();
  });
});
