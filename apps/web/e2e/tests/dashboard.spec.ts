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

  test('proveedor: solo lo que su permiso abre, sin métricas de SOAT ni petición a /soat/stats', async ({ page }) => {
    // HU #12872 (AC6): el tablero ya no decide por `role === 'admin'`. El proveedor abre Vehículos
    // (pagina.vehicles) → ve su primaria; NO tiene `soat.antiguo.administrar` (la guarda de
    // `/soat/stats`) → ni métricas ni KpiCards de SOAT, y la consulta ni se dispara.
    let statsPedidas = 0;
    await page.route(/\/api\/soat\/stats/, (r) => { statsPedidas += 1; return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: 'Ver vehículos' })).toBeVisible();
    await expect(page.getByText('SOAT vigentes')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Ver salud SOAT/ })).toHaveCount(0);
    expect(statsPedidas).toBe(0);
  });
});
