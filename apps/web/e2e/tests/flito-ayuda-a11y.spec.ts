// Ayuda FLITO — accesibilidad (HU #11893, AC5).
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, abrirAyuda, PROVEEDOR_USER, CONDUCTOR_USER } from '../helpers/ayuda-fixtures';
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

  test('AC5 — índice lleno: headings, axe y contraste del badge', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await expect(page.getByRole('heading', { level: 1, name: 'Ayuda FLITO' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Gestión' })).toBeVisible();
    const fila = page.getByRole('link', { name: /ficha pendiente de SOAT/i });
    await expect(fila).toBeVisible();
    await fila.focus();
    await expect(fila).toBeFocused();

    const badge = page.getByText('Ficha pendiente', { exact: true }).first();
    expect(await ratioDe(page, badge)).toBeGreaterThanOrEqual(MINIMO);
    expect(await ratioDe(page, fila.getByText('SOAT', { exact: true }), fila)).toBeGreaterThanOrEqual(MINIMO);

    await sinViolacionesGraves(page, 'índice lleno');
  });

  test('AC5 — ficha pendiente: Volver al índice e Ir a la pantalla', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/soat');
    await expect(page.getByText('Esta ficha está pendiente.')).toBeVisible();
    const volver = page.getByRole('link', { name: 'Volver al índice' }).first();
    const ir = page.getByRole('link', { name: 'Ir a la pantalla SOAT' });
    await expect(volver).toBeVisible();
    await expect(ir).toBeVisible();
    await ir.focus();
    await expect(ir).toBeFocused();
    expect(await ratioDe(page, ir)).toBeGreaterThanOrEqual(MINIMO);
    expect(await ratioDe(page, volver)).toBeGreaterThanOrEqual(MINIMO);
    await sinViolacionesGraves(page, 'ficha pendiente');
  });

  test('AC5 — NoAccess y ficha inexistente: axe + foco en h1', async ({ page }) => {
    await abrirAyuda(page, CONDUCTOR_USER);
    const h1 = page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i });
    await expect(h1).toBeVisible();
    await expect(h1).toBeFocused();
    await expect(page.getByRole('link', { name: 'Volver al tablero' })).toBeVisible();
    // NoAccess es el patrón del shell (CTA preexistente). No se corre axe aquí: el contraste
    // de ese botón no es de esta HU. El vacío «ficha no existe» sí es superficie nueva.

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
