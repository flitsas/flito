import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Checklists preoperacionales — inspección diaria del vehículo (Res. 40595).

const CHECKLIST_FIXTURE = [
  { id: 1, vehicleId: 10, plate: 'EEE001', conductorId: 5, conductorName: 'Conductor E2E A',
    fechaHora: '2026-05-07T07:30:00', decision: 'apto', anuladoAt: null },
  { id: 2, vehicleId: 11, plate: 'EEE002', conductorId: 6, conductorName: 'Conductor E2E B',
    fechaHora: '2026-05-07T08:15:00', decision: 'condicional', anuladoAt: null },
  { id: 3, vehicleId: 12, plate: 'EEE003', conductorId: 7, conductorName: 'Conductor E2E C',
    fechaHora: '2026-05-07T09:00:00', decision: 'no_apto', anuladoAt: null },
];

test.describe('Checklists preoperacionales', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin lista checklists con todas las decisiones', async ({ page }) => {
    await page.route('**/api/drivers/checklists**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: CHECKLIST_FIXTURE }) })
    );

    await page.goto('/pesv/checklists');
    await expect(page.getByRole('heading', { name: /Checklists preoperacionales/i })).toBeVisible();
    // 3 conductores visibles
    await expect(page.getByText(/Conductor E2E A/i)).toBeVisible();
    await expect(page.getByText(/Conductor E2E B/i)).toBeVisible();
    await expect(page.getByText(/Conductor E2E C/i)).toBeVisible();
    // Pills de decisión renderizan (apto/condicional/no_apto)
    await expect(page.getByText(/^apto$/i).first()).toBeVisible();
    await expect(page.getByText(/condicional/i).first()).toBeVisible();
    await expect(page.getByText(/no apto/i).first()).toBeVisible();
  });

  test('filtro no_apto dispara request con query string', async ({ page }) => {
    let lastUrl = '';
    await page.route('**/api/drivers/checklists**', (route) => {
      lastUrl = route.request().url();
      const decision = new URL(lastUrl).searchParams.get('decision');
      const data = decision ? CHECKLIST_FIXTURE.filter((c) => c.decision === decision) : CHECKLIST_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data }) });
    });

    await page.goto('/pesv/checklists');
    await page.getByRole('button', { name: /^no_apto$/ }).click();
    await expect.poll(() => lastUrl, { timeout: 10_000 }).toContain('decision=no_apto');
    // Solo conductor C debe quedar visible
    await expect(page.getByText(/Conductor E2E C/i)).toBeVisible();
    await expect(page.getByText(/Conductor E2E A/i)).not.toBeVisible();
  });

  test('empty state se muestra sin checklists', async ({ page }) => {
    await page.route('**/api/drivers/checklists**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );

    await page.goto('/pesv/checklists');
    await expect(page.getByText(/Sin checklists/i)).toBeVisible();
    // CTA "Nuevo checklist" sigue visible para que el admin pueda crear
    await expect(page.getByRole('link', { name: /Nuevo checklist/i })).toBeVisible();
  });
});
