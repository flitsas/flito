// Spec 1/7 — Crear diagnóstico PESV.
//
// Cubre:
//   - Login lider_pesv → vista lista
//   - Apertura modal "Nuevo diagnóstico"
//   - Submit con nivelEmpresa=avanzado, fecha=hoy, observaciones "e2e test"
//   - Verifica toast con N dinámico ("creado con 24 estándares en estado pendiente")
//   - Reintento mismo año → 409 con mensaje "ya hay diagnóstico para ese año"
//   - Redirect a /pesv/diagnostico/:id
//
// Mocks: stub al backend para no depender de BD viva (patrón existente del repo).

import { test, expect } from '../helpers/fixtures';
import {
  LIDER_PESV_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, jsonRoute,
} from '../helpers/pesv-fixtures';

test.describe('PESV Diagnóstico · Crear', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, LIDER_PESV_USER);
    await stubPesvSiblings(page);
  });

  test('lider_pesv crea diagnóstico nuevo, toast con N dinámico, redirect a detalle', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    const anio = new Date().getFullYear();
    let postPayload: Record<string, unknown> | null = null;

    // Lista (GET vacía la primera vez)
    await page.route('**/api/pesv/diagnostico', async (route) => {
      const m = route.request().method();
      if (m === 'GET') return jsonRoute(200, { data: [] })(route);
      if (m === 'POST') {
        postPayload = route.request().postDataJSON();
        return jsonRoute(201, { id: 42, anio, count: 24 })(route);
      }
      return route.continue();
    });

    // Detalle del recién creado
    await page.route('**/api/pesv/diagnostico/42', jsonRoute(200, buildDiagDetail({ id: 42, anio })));
    await page.route('**/api/pesv/diagnostico/42/items/**/historial', jsonRoute(200, { data: [] }));

    await page.goto('/pesv/diagnostico');
    await expect(page.getByRole('heading', { name: /Diagn[óo]stico\s+PESV/i }).first()).toBeVisible();
    await page.getByRole('button', { name: /Nuevo diagnóstico/i }).click();

    // Modal abierto
    const modal = page.getByRole('dialog', { name: /Nuevo diagn[óo]stico PESV/i });
    await expect(modal).toBeVisible();

    // Nivel avanzado por defecto + fecha + observaciones
    await modal.getByRole('radio', { name: /Avanzado/i }).check({ force: true });
    await modal.locator('input[type="date"]').fill(today);
    await modal.getByPlaceholder(/Tama[ñn]o de flota/i).fill('Flota >50 vehículos, transporte de carga.');
    await modal.locator('textarea').last().fill('e2e test');

    await modal.getByRole('button', { name: /Crear diagn[óo]stico/i }).click();

    // Toast con N dinámico — la app usa `react-hot-toast` con role=status.
    await expect(page.locator('[role="status"]', { hasText: /creado con 24 est[áa]ndares en estado pendiente/i })).toBeVisible();

    // Redirect a detalle
    await expect(page).toHaveURL(/\/pesv\/diagnostico\/42$/);
    expect(postPayload).toMatchObject({ anio, fecha: today, nivelEmpresa: 'avanzado', observaciones: 'e2e test' });
  });

  test('reintentar mismo año → 409 "ya hay diagnóstico para ese año"', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    const anio = new Date().getFullYear();

    await page.route('**/api/pesv/diagnostico', async (route) => {
      const m = route.request().method();
      if (m === 'GET') return jsonRoute(200, { data: [] })(route);
      if (m === 'POST') return jsonRoute(409, { error: 'ya hay diagnóstico para ese año' })(route);
      return route.continue();
    });

    await page.goto('/pesv/diagnostico');
    await page.getByRole('button', { name: /Nuevo diagnóstico/i }).click();

    const modal = page.getByRole('dialog', { name: /Nuevo diagn[óo]stico PESV/i });
    await modal.locator('input[type="date"]').fill(today);
    await modal.getByRole('button', { name: /Crear diagnóstico/i }).click();

    // Toast de error visible. El modal queda abierto para corregir.
    await expect(page.locator('[role="status"]', { hasText: /ya hay diagn[óo]stico para ese a[ñn]o/i })).toBeVisible();
    await expect(modal).toBeVisible();
    expect(page.url()).toMatch(/\/pesv\/diagnostico$/);

    // Suprimir lint sobre unused: build24Items se importa por simetría con otros specs.
    void build24Items;
    void anio;
  });
});
