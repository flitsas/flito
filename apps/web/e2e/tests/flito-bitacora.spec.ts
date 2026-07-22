import { test, expect } from '@playwright/test';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Bitácora (Fase 6). Consulta read-only sobre audit_logs del dominio FLITO.
// Operaciones y Auditoría leen. Backend mockeado.

const REGISTROS = [
  { id: 1, resource: 'flito_soat', resourceId: 's1', action: 'update', actorNombre: 'ops@flitsas.io', actorId: 7, detalle: 'Pago confirmado por factura', creadoEn: '2026-07-10T12:00:00Z' },
  { id: 2, resource: 'flito_tramite', resourceId: 't1', action: 'update', actorNombre: 'sistema', actorId: null, detalle: 'Compuerta habilitada', creadoEn: '2026-07-10T11:00:00Z' },
];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/bitacora(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REGISTROS) }));
}

test.describe('FLITO — Bitácora', () => {
  test('operaciones ve la tabla con actor sistema y filtros por recurso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/bitacora');
    await expect(page.getByRole('heading', { name: 'Bitácora', exact: true })).toBeVisible();
    await expect(page.getByText('Pago confirmado por factura')).toBeVisible();
    await expect(page.getByText('Compuerta habilitada')).toBeVisible();
    await expect(page.getByText('sistema', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Todas', exact: true })).toBeVisible();
  });

  test('filtrar por recurso vuelve a consultar', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    let ultimaUrl = '';
    await page.route(/\/api\/flito\/bitacora\?.*resource=flito_soat/, (route) => {
      ultimaUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([REGISTROS[0]]) });
    });

    await page.goto('/flito/bitacora');
    await page.getByRole('button', { name: 'SOAT', exact: true }).click();
    await expect.poll(() => ultimaUrl).toContain('resource=flito_soat');
  });
});
