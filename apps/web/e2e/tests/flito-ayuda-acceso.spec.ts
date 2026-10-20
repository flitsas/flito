// Ayuda FLITO — menú y NoAccess (HU #11893, AC1 y AC2).
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, OPERACIONES_USER, PROVEEDOR_USER, CONDUCTOR_USER, SIN_CATALOGO,
} from '../helpers/ayuda-fixtures';

test.describe('FLITO — Ayuda · acceso', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // HU #13431: «Ayuda» es su propio elemento del menú, el último, y con un solo ítem se pinta como
  // enlace directo (no hay disclosure «General» que abrir).
  test('AC1 — proveedor ve Ayuda FLITO como último elemento del menú y navega', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    const enlace = nav.getByRole('link', { name: 'Ayuda', exact: true });
    await expect(enlace).toBeVisible();
    await expect(nav.getByRole('link').last()).toHaveAccessibleName('Ayuda');
    await expect(enlace).toHaveAttribute('href', '/flito/ayuda');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO', exact: true })).toBeVisible();
  });

  test('AC1 — proveedor también la encuentra en el Command Palette', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
    await expect(page.getByRole('option', { name: /^Ayuda/ })).toBeVisible();
  });

  test('AC1 — admin ve el ítem (Object.keys no es el gate; el helper sí)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link', { name: 'Ayuda', exact: true })).toBeVisible();
  });

  for (const usuario of SIN_CATALOGO) {
    // HU #13704 AC7 (P9-3a): el ítem sigue oculto; la URL directa ya no es NoAccess sino el vacío
    // «Su usuario aún no tiene módulos con ayuda» con salida al inicio.
    test(`AC2 — ${usuario.role} no ve el ítem; /flito/ayuda muestra el vacío sin módulos (HU #13704 AC7)`, async ({ page }) => {
      await loginAs(page, usuario);
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
      await expect(page.getByRole('option', { name: /^Ayuda/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.goto('/flito/ayuda');
      await expect(page.getByRole('heading', { name: 'Su usuario aún no tiene módulos con ayuda' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
      await expect(page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i })).toHaveCount(0);
      await expect(page.getByRole('searchbox', { name: 'Buscar fichas' })).toHaveCount(0);
      await expect(page).toHaveURL(/\/flito\/ayuda$/);
      // El menú sigue sin el ítem en la página del vacío.
      await expect(page.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);
    });
  }

  test('AC2 — conductor: la ficha de otra pantalla por URL sigue en NoAccess de esa pantalla', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — bolsas/i })).toBeVisible();
    await expect(page.getByText('Su usuario aún no tiene módulos con ayuda')).toHaveCount(0);
  });
});
