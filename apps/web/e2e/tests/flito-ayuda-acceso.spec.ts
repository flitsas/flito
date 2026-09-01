// Ayuda FLITO — menú y NoAccess (HU #11893, AC1 y AC2).
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda, OPERACIONES_USER, PROVEEDOR_USER, CONDUCTOR_USER, SIN_CATALOGO,
} from '../helpers/ayuda-fixtures';

const CANARIO = '/api/__qa_canary';

async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

function espiarChunk(page: Page): string[] {
  const alChunk: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.includes('FlitoAyuda')) alChunk.push(pathname);
  });
  return alChunk;
}

test.describe('FLITO — Ayuda · acceso', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC1 — proveedor ve Ayuda FLITO en General y navega', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'General', exact: true }).click();
    const enlace = page.getByRole('link', { name: 'Ayuda FLITO', exact: true });
    await expect(enlace).toBeVisible();
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
    await expect(page.getByRole('option', { name: /Ayuda FLITO/ })).toBeVisible();
  });

  test('AC1 — admin ve el ítem (Object.keys no es el gate; el helper sí)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Ayuda FLITO', exact: true })).toBeVisible();
  });

  for (const usuario of SIN_CATALOGO) {
    test(`AC2 — ${usuario.role} no ve el ítem y /flito/ayuda es NoAccess`, async ({ page }) => {
      await loginAs(page, usuario);
      const alChunk = espiarChunk(page);
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Ayuda FLITO', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
      await expect(page.getByRole('option', { name: /Ayuda FLITO/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.goto('/flito/ayuda');
      await expect(page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Volver al tablero' })).toBeVisible();
      await expect(page).toHaveURL(/\/flito\/ayuda$/);
      await reposo(page);
      expect(alChunk).toEqual([]);
    });
  }

  test('AC2 — conductor no confunde NoAccess con el vacío del índice', async ({ page }) => {
    await abrirAyuda(page, CONDUCTOR_USER);
    await expect(page.getByText(/no hay capítulos de ayuda/i)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i })).toBeVisible();
  });
});
