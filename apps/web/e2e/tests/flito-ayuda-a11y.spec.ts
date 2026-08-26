// Ayuda FLITO — accesibilidad (HU #11893, AC5).
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, abrirAyuda, PROVEEDOR_USER, FINANCIERA_USER, CONDUCTOR_USER } from '../helpers/ayuda-fixtures';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { aHex, contraste, fondoPintado, tintaEfectiva } from '../helpers/pixeles';

const MINIMO = 4.5;

async function sinViolacionesGraves(page: Page, etiqueta: string) {
  const violaciones = await correrAxe(page);
  esperarSinViolacionesGraves(violaciones, etiqueta);
  expect(violaciones.filter((v) => v.id === 'color-contrast'), `contraste en «${etiqueta}»`).toEqual([]);
}

async function ratioDe(page: Page, texto: Locator, fondoDe?: Locator): Promise<number> {
  const { color: fondo } = await fondoPintado(page, fondoDe ?? texto);
  const tinta = await tintaEfectiva(texto, fondo);
  const ratio = contraste(tinta, fondo);
  console.log(`[a11y · píxel] ${await texto.innerText()} ${aHex(tinta)} sobre ${aHex(fondo)} → ${ratio.toFixed(2)}`);
  return ratio;
}

test.describe('FLITO — Ayuda · AC5 accesibilidad', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC5 — índice lleno: headings, axe y contraste (SOAT publicado)', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await expect(page.getByRole('heading', { level: 1, name: 'Ayuda FLITO' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Gestión' })).toBeVisible();
    const fila = page.getByRole('link', { name: 'Abrir ficha de SOAT' });
    await expect(fila).toBeVisible();
    await fila.focus();
    await expect(fila).toBeFocused();
    expect(await ratioDe(page, fila.getByText('SOAT', { exact: true }), fila)).toBeGreaterThanOrEqual(MINIMO);
    await sinViolacionesGraves(page, 'índice lleno SOAT publicado');
  });

  test('AC5 — ficha publicada SOAT: Volver al índice e Ir a la pantalla', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/soat');
    await expect(page.getByRole('heading', { name: 'Qué es' })).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    const volver = page.getByRole('link', { name: 'Volver al índice' }).first();
    const ir = page.getByRole('link', { name: 'Ir a la pantalla SOAT' });
    await expect(volver).toBeVisible();
    await expect(ir).toBeVisible();
    await ir.focus();
    await expect(ir).toBeFocused();
    expect(await ratioDe(page, ir)).toBeGreaterThanOrEqual(MINIMO);
    expect(await ratioDe(page, volver)).toBeGreaterThanOrEqual(MINIMO);
    await sinViolacionesGraves(page, 'ficha publicada SOAT');
  });

  test('AC5 — ficha publicada Bolsas (Financiera): badge pendiente ausente; Volver e Ir a la pantalla', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await expect(page.getByText('Ficha pendiente', { exact: true })).toHaveCount(0);
    const fila = page.getByRole('link', { name: 'Abrir ficha de Bolsas' });
    await expect(fila).toBeVisible();
    expect(await ratioDe(page, fila.getByText('Bolsas', { exact: true }), fila)).toBeGreaterThanOrEqual(MINIMO);

    await fila.click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/flito_bolsas$/);
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Qué es' })).toBeVisible();
    const volver = page.getByRole('link', { name: 'Volver al índice' }).first();
    const ir = page.getByRole('link', { name: 'Ir a la pantalla Bolsas' });
    await expect(volver).toBeVisible();
    await expect(ir).toBeVisible();
    await ir.focus();
    await expect(ir).toBeFocused();
    expect(await ratioDe(page, ir)).toBeGreaterThanOrEqual(MINIMO);
    expect(await ratioDe(page, volver)).toBeGreaterThanOrEqual(MINIMO);
    await sinViolacionesGraves(page, 'ficha publicada Bolsas');
  });

  test('AC5 — NoAccess: axe no se corre (CTA del shell); ficha inexistente: axe + vacío', async ({ page }) => {
    await abrirAyuda(page, CONDUCTOR_USER);
    const h1 = page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i });
    await expect(h1).toBeVisible();
    await expect(h1).toBeFocused();
    await expect(page.getByRole('link', { name: 'Volver al tablero' })).toBeVisible();
  });

  test('AC5 — ficha inexistente: axe + Volver al índice (el catálogo de 18 no tiene pendientes)', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/privacy');
    await expect(page.getByText('Esta ficha no existe.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al índice' }).first()).toBeVisible();
    await sinViolacionesGraves(page, 'ficha no existe');
  });

  test('AC5 — error del índice: Reintentar con contraste', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.route('**/content/ayuda/_plantilla.md**', (route) => route.abort('failed'));
    await page.goto('/flito/ayuda');
    const reintentar = page.getByRole('button', { name: 'Reintentar' });
    await expect(reintentar).toBeVisible();
    await reintentar.focus();
    await expect(reintentar).toBeFocused();
    expect(await ratioDe(page, page.getByRole('heading', { name: 'No se pudo cargar el índice de ayuda.' }))).toBeGreaterThanOrEqual(MINIMO);
    await sinViolacionesGraves(page, 'índice en error');
  });
});
