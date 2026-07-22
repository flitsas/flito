// Shell sin sidebar — FlitNavBar horizontal (decisión PO 2026-06-12).
// Cubre: visibilidad en desktop, dropdown disclosure (abrir/navegar/Esc),
// filtrado por permisos y drawer mobile como única nav en <lg.
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// El home (/) renderiza <FlitoTablero>, que consume /flito/tablero como OBJETO (no lista).
// Sin este shape el dashboard antes reventaba y dejaba el shell en blanco.
const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('/auth/me')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  // Registrado después → tiene prioridad para /flito/tablero.
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
}

test.describe('Shell · FlitNavBar (desktop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('admin ve los 9 módulos; dropdown PESV abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav).toBeVisible();
    // Módulos de 1 ítem → link directo; el resto → trigger de dropdown.
    for (const label of ['Tablero', 'Flota']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    for (const label of ['Gestión', 'Tránsito', 'Mantenimiento', 'PESV', 'RNDC', 'Cumplimiento', 'Administración']) {
      await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    const pesvTrigger = nav.getByRole('button', { name: 'PESV' });
    await pesvTrigger.click();
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pesvTrigger).toBeFocused();

    // Navegar desde el dropdown cierra el panel y marca el módulo activo.
    await pesvTrigger.click();
    await page.getByRole('link', { name: 'Conductores', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\/conductores/);
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('proveedor solo ve Gestión (vehicles + soat) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('button', { name: 'Gestión' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'PESV' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Administración' })).toHaveCount(0);

    await nav.getByRole('button', { name: 'Gestión' }).click();
    await expect(page.getByRole('link', { name: 'Vehículos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SOAT' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
  });
});

test('mobile: navbar oculta, hamburguesa abre el drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeHidden();
  await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
  await expect(page.getByRole('dialog', { name: 'Menú de navegación' })).toBeVisible();
});
