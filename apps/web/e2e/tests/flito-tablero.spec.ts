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
  alertas: { borrador_5d: 12, sin_aprobar_ans: 7, soat_sin_gestion: 3, impuesto_sin_gestion: 0 },
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

  // ── HU #10962 — alertas operativas ──────────────────────────────────────────

  test('el tablero muestra las cuatro alertas con su conteo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/tablero');
    const alertas = page.getByRole('region', { name: 'Alertas operativas' });
    await expect(alertas.getByText('Más de 5 días en borrador')).toBeVisible();
    await expect(alertas.getByText('Más de 2 días sin aprobar (ANS)')).toBeVisible();
    await expect(alertas.getByText('SOAT solicitado sin gestión')).toBeVisible();
    await expect(alertas.getByText('Impuesto solicitado sin gestión')).toBeVisible();
    await expect(alertas.getByText('12', { exact: true })).toBeVisible();
  });

  test('una alerta con cero no reclama atención', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/tablero');
    const sinNada = page.getByRole('link', { name: /Impuesto solicitado sin gestión: 0/ });
    await expect(sinNada).toBeVisible();
    await expect(sinNada.getByText('Requiere atención')).toHaveCount(0);
  });

  test('pulsar una alerta lleva al listado ya filtrado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const urls: string[] = [];
    await page.route(/\/api\/flito\/tramites\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) });
    });
    await page.route(/\/api\/flito\/tramites\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }) }));

    await page.goto('/flito/tablero');
    await page.getByRole('link', { name: /Más de 5 días en borrador/ }).click();

    await expect(page).toHaveURL(/\/flito\/tramites\?alerta=borrador_5d/);
    await expect.poll(() => urls.some((u) => u.includes('alerta=borrador_5d'))).toBe(true);
    // La alerta activa se anuncia; un listado recortado no puede parecer la maestra completa.
    await expect(page.getByRole('button', { name: /Quitar la alerta/ })).toBeVisible();
  });

  test('quitar la alerta la retira de la URL y del listado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/tramites\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));
    await page.route(/\/api\/flito\/tramites\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }) }));

    // Entrada directa por URL, sin pasar por el tablero (AC4).
    await page.goto('/flito/tramites?alerta=soat_sin_gestion');
    const quitar = page.getByRole('button', { name: /Quitar la alerta/ });
    await expect(quitar).toBeVisible();

    await quitar.click();
    await expect(page).not.toHaveURL(/alerta=/);
    await expect(quitar).toHaveCount(0);
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
