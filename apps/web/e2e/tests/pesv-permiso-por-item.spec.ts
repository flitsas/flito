import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// HU #13421 (ADR-0023 §D7): cada ítem del menú PESV tiene su propia página. Tener un ítem no abre
// los demás, y las pantallas que leen endpoints de OTRO ítem (la lista de conductores, los
// incidentes y las horas de capacitación de un conductor) degradan en su sitio cuando ese
// endpoint responde 403 —sin toast con el error crudo y sin tumbar el resto de la pantalla—.

const SOLO_ALCOHOLIMETRIA = {
  id: 7101, username: 'e2e_solo_alcohol', name: 'Solo Alcoholimetría E2E',
  role: 'mensajero' as const, allowedPages: ['pesv_alcoholimetria'],
};

const PROHIBIDO = { status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Sin permiso' }) };

test.describe('PESV — permiso por ítem del menú', () => {
  test('el ítem concedido abre su pantalla y el dueño de otra ruta no', async ({ page }) => {
    await loginAs(page, SOLO_ALCOHOLIMETRIA);
    await page.route('**/api/drivers/alcohol-tests', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));

    await page.goto('/pesv/alcoholimetria');
    await expect(page.getByRole('heading', { name: 'Pruebas de alcoholimetría' })).toBeVisible();

    await page.goto('/pesv/conductores');
    await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toBeVisible();
  });

  test('Alcoholimetría: sin acceso a la lista de conductores el selector lo explica', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/drivers/alcohol-tests', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
    await page.route(/\/api\/drivers(\?.*)?$/, (route) => route.fulfill(PROHIBIDO));

    await page.goto('/pesv/alcoholimetria');
    await page.getByRole('button', { name: 'Registrar prueba' }).click();

    const aviso = page.locator('#alcohol-conductores-aviso');
    await expect(aviso).toHaveText(/No tienes acceso a la lista de conductores/);
    await expect(page.getByLabel(/Conductor/)).toBeDisabled();
    await expect(page.getByText('Sin permisos para esta operación')).toHaveCount(0);
    if (process.env.HU13421_CAPTURAS) await page.screenshot({ path: `${process.env.HU13421_CAPTURAS}/alcohol-403.png` });
  });

  test('Incidentes: el formulario sigue usable sin la lista de conductores', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route(/\/api\/drivers\/incidents(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
    await page.route('**/api/fleet/vehicles**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 1, plate: 'ABC123' }] }) }));
    await page.route(/\/api\/drivers(\?.*)?$/, (route) => route.fulfill(PROHIBIDO));

    await page.goto('/pesv/incidentes');
    await page.getByRole('button', { name: 'Reportar nuevo incidente vial' }).click();

    await expect(page.locator('#incidente-conductores-aviso')).toHaveText(/registra el incidente sin conductor/);
    await expect(page.getByRole('option', { name: /ABC123/ })).toHaveCount(1);
    await expect(page.getByText('Sin permisos para esta operación')).toHaveCount(0);
    if (process.env.HU13421_CAPTURAS) await page.screenshot({ path: `${process.env.HU13421_CAPTURAS}/incidentes-403.png` });
  });

  test('Detalle del conductor: pestañas de otro ítem avisan en su sitio', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route(/\/api\/drivers\/5$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: 5, name: 'Conductor E2E', username: 'e2e_conductor', email: null }, profile: null, documentosCount: 0, incidentesCount: 2 }),
    }));
    await page.route(/\/api\/drivers\/incidents\?conductorId=5$/, (route) => route.fulfill(PROHIBIDO));
    await page.route(/\/api\/drivers\/trainings\/report\/horas-conductor/, (route) => route.fulfill(PROHIBIDO));

    await page.goto('/pesv/conductores/5');
    await page.getByRole('button', { name: /Incidentes/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No tienes acceso a los incidentes del conductor' })).toBeVisible();
    if (process.env.HU13421_CAPTURAS) await page.screenshot({ path: `${process.env.HU13421_CAPTURAS}/detalle-incidentes-403.png` });

    await page.getByRole('button', { name: 'Capacitaciones' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No tienes acceso a las horas de capacitación' })).toBeVisible();
    await expect(page.getByText('Sin permisos para esta operación')).toHaveCount(0);
  });
});
