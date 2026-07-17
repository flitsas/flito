import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const REMESAS_FIXTURE = [
  {
    id: 101,
    numero: 'REM-202605-0101',
    consecutivoRndc: 'CR-101',
    estado: 'activa',
    clientId: 1,
    clientName: 'Cliente Demo',
    origenNombre: 'BOGOTÁ',
    municipioOrigenDane: '11001',
    municipioDestinoDane: '76001',
    cantidadCargada: '25000',
    pesoKg: '24500',
    valorFlete: '3500000',
    fechaCargue: '2026-05-07',
    manifiestoId: null,
    cumplidoAt: null,
  },
  {
    id: 102,
    numero: 'REM-202605-0102',
    consecutivoRndc: null,
    estado: 'borrador',
    clientId: null,
    clientName: null,
    origenNombre: null,
    municipioOrigenDane: '05001',
    municipioDestinoDane: '08001',
    cantidadCargada: '10000',
    pesoKg: null,
    valorFlete: '1200000',
    fechaCargue: '2026-05-08',
    manifiestoId: null,
    cumplidoAt: null,
  },
];

test.describe('RNDC remesas — listado', () => {
  test('admin ve listado con dos remesas y puede filtrar por estado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);

    let lastUrl = '';
    await page.route('**/api/rndc/remesas**', (route) => {
      lastUrl = route.request().url();
      const url = new URL(lastUrl);
      const estado = url.searchParams.get('estado');
      const data = estado ? REMESAS_FIXTURE.filter((r) => r.estado === estado) : REMESAS_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });

    await page.goto('/rndc/remesas');
    await expect(page.getByText('REM-202605-0101')).toBeVisible();
    await expect(page.getByText('REM-202605-0102')).toBeVisible();

    // Filtrar por estado=borrador (botón pill) → solo 0102 visible.
    await page.getByRole('button', { name: 'borrador' }).click();
    await expect(page.getByText('REM-202605-0102')).toBeVisible();
    await expect(page.getByText('REM-202605-0101')).toHaveCount(0);
    expect(lastUrl).toContain('estado=borrador');
  });

  test('error del backend al cargar remesas muestra toast', async ({ page }) => {
    await loginAs(page, ADMIN_USER);

    await page.route('**/api/rndc/remesas**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'BD caída' }),
      })
    );

    await page.goto('/rndc/remesas');
    await expect(page.locator('[role="status"]').filter({ hasText: /BD caída|Error/i }).first()).toBeVisible();
  });
});
