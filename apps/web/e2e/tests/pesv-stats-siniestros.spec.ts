import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// PESV Paso 21 · Dashboard estadístico siniestros (Res. 40595 anexo).

const STATS_FIXTURE = {
  periodo: { from: '2026-01-01', to: '2026-12-31' },
  totales: {
    total: 12, accidentes: 5, casi: 4, comparendos: 3,
    fatales: 1, graves: 2, leves: 3,
    victimas_total: 7, dias_perdidos_total: 45, costos_total: '5000000',
    investigaciones: 4, investigaciones_cerradas: 3,
  },
  mensual: [
    { mes: '2026-04', total: 5, accidentes: 2, graves_fatales: 1, victimas: 3 },
    { mes: '2026-05', total: 7, accidentes: 3, graves_fatales: 2, victimas: 4 },
  ],
  porCausa: [
    { metodo: '5_porques', c: 2 },
    { metodo: 'ishikawa', c: 2 },
  ],
  topConductores: [
    { conductor_id: 7, name: 'Edison Alvarez', c: 3, victimas: 1 },
    { conductor_id: 8, name: 'María Pérez', c: 1, victimas: 0 },
  ],
  indicadoresPesv: { hht: 1500, frecuencia: 666.67, severidad: 6000, indiceGravedad: 4000, formula: '(acc × 200K)/HHT' },
};

test.describe('PESV Estadística siniestros (S8 Paso 21)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin ve KPIs principales y top conductores', async ({ page }) => {
    await page.route('**/api/drivers/incidents/stats**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATS_FIXTURE) })
    );

    await page.goto('/pesv/incidentes/stats');
    // Header con paso 21
    await expect(page.getByText(/PESV Paso 21|Res\. 40595|frecuencia/i).first()).toBeVisible();
    // 4 KPIs PESV
    await expect(page.getByText(/HHT/i).first()).toBeVisible();
    await expect(page.getByText(/[íi]ndice frecuencia/i)).toBeVisible();
    await expect(page.getByText(/[íi]ndice severidad/i)).toBeVisible();
    await expect(page.getByText(/[íi]ndice gravedad/i)).toBeVisible();
    // Top conductor renderiza nombre
    await expect(page.getByText(/Edison Alvarez/i)).toBeVisible();
    // Cobertura investigación 75% (3/4)
    await expect(page.getByText(/Cobertura investigaci[óo]n/i)).toBeVisible();
  });

  test('filtros from/to disparan refetch con query string', async ({ page }) => {
    let lastQuery = '';
    await page.route('**/api/drivers/incidents/stats**', (route) => {
      lastQuery = new URL(route.request().url()).search;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATS_FIXTURE) });
    });

    await page.goto('/pesv/incidentes/stats');
    await page.locator('input[type="date"]').first().fill('2026-03-01');
    await page.locator('input[type="date"]').nth(1).fill('2026-06-30');
    // El useEffect se dispara dos veces (uno por cada fill) — esperamos hasta que el último
    // disparo incluya AMBOS parámetros.
    await expect.poll(() => lastQuery, { timeout: 10_000 }).toContain('from=2026-03-01');
    await expect.poll(() => lastQuery, { timeout: 10_000 }).toContain('to=2026-06-30');
  });

  test('HHT=0 → indicadores en 0 sin crash', async ({ page }) => {
    const zero = {
      ...STATS_FIXTURE,
      totales: { ...STATS_FIXTURE.totales, total: 0, investigaciones: 0, investigaciones_cerradas: 0 },
      mensual: [], porCausa: [], topConductores: [],
      indicadoresPesv: { hht: 0, frecuencia: 0, severidad: 0, indiceGravedad: 0, formula: 'N/A' },
    };
    await page.route('**/api/drivers/incidents/stats**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(zero) })
    );

    await page.goto('/pesv/incidentes/stats');
    await expect(page.getByText(/HHT/i).first()).toBeVisible();
    // Página carga sin throw
    await expect(page.getByText(/PESV Paso 21|Res\. 40595/i).first()).toBeVisible();
  });
});
