import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Tablero (Fase 6). Indicadores que el proceso por Excel no dejaba ver.
// Operaciones sincroniza; Auditoría observa en solo lectura. Backend mockeado.

const RESUMEN = {
  soat: { pendiente: 2, solicitado: 1, con_novedad: 0, pagado: 5 },
  impuestos: { pendiente: 0, solicitado: 2, con_novedad: 0, pagado: 4 },
  revisionesPendientes: { soat: 2, impuestos: 1 },
  estancados: { soat: 0, impuestos: 2 },
  diferenciasDeValor: 1,
  compuertaHabilitados: 4,
};

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/tablero$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN) }));
}

test.describe('FLITO — Tablero', () => {
  test('operaciones ve KPIs, conteos por estado y el botón de sincronizar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/tablero');
    await expect(page.getByRole('heading', { name: 'Tablero', exact: true })).toBeVisible();
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();
    await expect(page.getByText('SOAT por estado')).toBeVisible();
    await expect(page.getByText('Impuestos por estado')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sincronizar desde FLIT/i })).toBeVisible();
  });

  test('sincronizar dispara la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let sincronizado = false;
    await page.route(/\/api\/flito\/sync\/sincronizar$/, (route) => {
      sincronizado = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tramitesNuevos: 0, soatCreados: 0 }) });
    });

    await page.goto('/flito/tablero');
    await page.getByRole('button', { name: /Sincronizar desde FLIT/i }).click();
    await expect.poll(() => sincronizado).toBe(true);
  });

  test('auditor observa en solo lectura: sin botón de sincronizar', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/tablero');
    await expect(page.getByRole('heading', { name: 'Tablero', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sincronizar desde FLIT/i })).toHaveCount(0);
    await expect(page.getByText(/Auditoría observa el tablero/i)).toBeVisible();
  });
});
