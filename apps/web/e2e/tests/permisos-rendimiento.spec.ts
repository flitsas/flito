// HU #13589 (Feature #13416, Épica #13411) — «Rendimiento» deja de ser un permiso suelto y pasa a ser el
// ítem `admin_rendimiento` de Administración (P-35..P-37).
//
// Mapa AC → test:
//   AC4 → «menú: Rendimiento dentro de Administración»
//   AC5 → «sin el ítem: el Tablero no ofrece Rendimiento ni pide el resumen» (sin aviso de error) y su
//         control positivo «con el ítem: el Tablero ofrece Rendimiento (RUM)»
//   AC6 → «sin el ítem: /admin/rendimiento es página no permitida» y «con el ítem: cuatro estados»
//
//   TZ=UTC npx playwright test e2e/tests/permisos-rendimiento.spec.ts
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { COPY_ERROR_RUM, COPY_VACIO_RUM } from '../../src/pages/admin/RumSummary';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });

/** Un usuario con Tablero pero sin el ítem «Rendimiento» (ni `rum.resumen.ver`). */
const SIN_RENDIMIENTO = {
  id: 31, username: 'e2e_sin_rendimiento', name: 'Sin Rendimiento E2E', role: 'auditor' as const, allowedPages: ['dashboard'],
};

/**
 * AC5 — Tablero ANTIGUO: sin `tablero.tablero.ver` (con ella `Dashboard` devuelve el tablero FLITO antes de
 * llegar a los enlaces y el aserto sería vacuo) y con Vehículos, que es lo que pinta el bloque de enlaces
 * donde vive «Rendimiento (RUM)». `funciones: []` fija `/mios` sin la del tablero FLITO.
 */
const TABLERO_ANTIGUO = {
  id: 32, username: 'e2e_tablero_antiguo', name: 'Tablero Antiguo E2E', role: 'auditor' as const,
  allowedPages: ['dashboard', 'vehicles'],
};
const SIN_FUNCIONES = { funciones: [] as string[] };

const resumen = (groups: unknown[]) => ({ ok: true, windowDays: 7, minSamples: 3, totalRows: groups.length * 5, groups });
const GRUPO = {
  metric: 'LCP', route: '/flito/soat', device: 'desktop', samples: 12, p75: 1800, avg: 1500,
  first_at: '2026-10-08T10:00:00.000Z', last_at: '2026-10-14T10:00:00.000Z',
};

test.describe('HU #13589 · Rendimiento como ítem de Administración', () => {
  test('AC4 · menú: «Rendimiento» dentro de Administración, enlazado a /admin/rendimiento', async ({ page }) => {
    await page.route('**/api/rum/summary**', (r) => r.fulfill(json(resumen([]))));
    await loginAs(page, ADMIN_USER);
    await page.goto('/');
    await nav(page).getByRole('button', { name: 'Administración', exact: true }).click();
    const enlace = nav(page).getByRole('link', { name: 'Rendimiento', exact: true });
    await expect(enlace).toHaveAttribute('href', '/admin/rendimiento');
    await enlace.click();
    await expect(page.getByRole('heading', { name: 'Rendimiento en campo (RUM)', level: 1 })).toBeVisible();
  });

  test('AC5 · sin el ítem: el Tablero no ofrece Rendimiento ni pide el resumen, sin aviso de error', async ({ page }) => {
    const pedidas: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/rum/summary')) pedidas.push(r.url()); });
    await loginAs(page, TABLERO_ANTIGUO, SIN_FUNCIONES);
    await page.goto('/');
    // Primero: la página cargó y es el tablero antiguo con su bloque de enlaces.
    await expect(page.getByRole('link', { name: 'Ver vehículos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Rendimiento (RUM)' })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Rendimiento', exact: true })).toHaveCount(0);
    await expect(page.getByText(COPY_ERROR_RUM)).toHaveCount(0);
    expect(pedidas).toEqual([]);
  });

  test('AC5 · control positivo: con el ítem, el mismo Tablero ofrece «Rendimiento (RUM)»', async ({ page }) => {
    await loginAs(page, { ...TABLERO_ANTIGUO, allowedPages: [...TABLERO_ANTIGUO.allowedPages, 'admin_rendimiento'] }, SIN_FUNCIONES);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Ver vehículos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Rendimiento (RUM)' })).toHaveAttribute('href', '/admin/rendimiento');
  });

  test('AC6 · sin el ítem: /admin/rendimiento es página no permitida y no pide el resumen', async ({ page }) => {
    const pedidas: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/rum/summary')) pedidas.push(r.url()); });
    await loginAs(page, SIN_RENDIMIENTO);
    await page.goto('/admin/rendimiento');
    await expect(page.getByRole('heading', { level: 1, name: /no tienes acceso a rendimiento/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rendimiento en campo (RUM)' })).toHaveCount(0);
    expect(pedidas).toEqual([]);
  });

  test('AC6 · con el ítem: cargando, error con reintento (sin texto crudo), vacío y lleno', async ({ page }) => {
    let fase: 'error' | 'vacio' | 'lleno' = 'error';
    let liberar: (() => void) | null = null;
    const primera = new Promise<void>((res) => { liberar = res; });
    // Retiene TODAS las respuestas hasta liberar: en dev el doble efecto de StrictMode dispara dos
    // cargas, y retener solo la primera dejaba que la segunda quitara «cargando» antes del aserto.
    await page.route('**/api/rum/summary**', async (r) => {
      await primera;
      if (fase === 'error') return r.fulfill(json({ error: 'relation "rum_samples" does not exist' }, 500));
      if (fase === 'vacio') return r.fulfill(json(resumen([])));
      return r.fulfill(json(resumen([GRUPO])));
    });
    await loginAs(page, ADMIN_USER);
    await page.goto('/admin/rendimiento');

    // Cargando
    await expect(page.getByRole('status').filter({ hasText: 'Cargando métricas…' })).toBeVisible();
    liberar!();

    // Error: copy propio + Reintentar; nunca el error crudo del API.
    await expect(page.getByRole('alert')).toHaveText(COPY_ERROR_RUM);
    await expect(page.getByText('rum_samples')).toHaveCount(0);

    // Vacío tras reintentar
    fase = 'vacio';
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText(COPY_VACIO_RUM)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);

    // Lleno al cambiar de ventana
    fase = 'lleno';
    await page.getByRole('button', { name: '14 días' }).click();
    await expect(page.getByRole('button', { name: '14 días' })).toHaveAttribute('aria-pressed', 'true');
    const tabla = page.getByRole('region', { name: 'Resumen de rendimiento por métrica, ruta y dispositivo' });
    await expect(tabla.getByRole('row')).toHaveCount(2);
    await expect(tabla.getByRole('cell', { name: '/flito/soat' })).toBeVisible();
    await expect(tabla.getByText('1.80 s')).toBeVisible();
  });
});
