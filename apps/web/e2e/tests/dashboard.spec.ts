import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// Home de operadores/admin: Dashboard.tsx short-circuita a <FlitoTablero> cuando puedeOperar(role)
// (§correcciones-UX #4). El resumen viene de /flito/tablero como OBJETO.
const RESUMEN_TABLERO = {
  soat: { pendiente: 3, pagado: 10 },
  impuestos: { pendiente: 2, pagado: 8 },
  revisionesPendientes: { soat: 1, impuestos: 2 },
  estancados: { soat: 1, impuestos: 0 },
  diferenciasDeValor: 3,
  compuertaHabilitados: 6,
};

async function mockTablero(page: import('@playwright/test').Page) {
  // Dashboard.tsx dispara fetch de /soat/stats, /fleet, /rndc para admin aunque luego renderice
  // <FlitoTablero>; sin mock responderían 401 → SESSION_ENDED → logout. Catch-all vacío + tablero válido.
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/auth/me')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_TABLERO) }));
}

test.describe('Dashboard', () => {
  test('admin ve el Tablero FLITO en la home (KPIs de atención + sincronizar)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockTablero(page);

    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Tablero', exact: true })).toBeVisible();
    // Acción de sincronización (solo para quien opera).
    await expect(page.getByRole('button', { name: /Sincronizar desde FLIT/i })).toBeVisible();
    // KPIs del resumen.
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();
    await expect(page.getByText('Habilitados para entrega')).toBeVisible();
  });

  test('admin ve los conteos por estado (SOAT / Impuestos) del Tablero FLITO', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockTablero(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'SOAT por estado' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Impuestos por estado' })).toBeVisible();
    // Totales: SOAT 3+10=13, Impuestos 2+8=10.
    await expect(page.getByText('13 en total')).toBeVisible();
    await expect(page.getByText('10 en total')).toBeVisible();
    await expect(page.getByText('Diferencias de valor')).toBeVisible();
  });

  test('proveedor ve saludo minimal sin métricas', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page).toHaveURL('/');
    // El proveedor entra al fast path: greeting + hint de Cmd+K, sin cards de SOAT.
    await expect(page.getByText(/navegar a tus secciones/i)).toBeVisible();
  });
});
