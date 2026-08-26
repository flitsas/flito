// Ayuda FLITO — índice por permiso y 4 estados (HU #11893, AC3 y AC4).
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda, PROVEEDOR_USER, FINANCIERA_USER, GESTOR_IMPUESTOS_USER, MENSAJERO_USER,
  OPERACIONES_USER,
} from '../helpers/ayuda-fixtures';

test.describe('FLITO — Ayuda · índice', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC3 — proveedor solo ve SOAT publicado (HU #11894); no error', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Impuestos/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Bolsas/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
    await expect(page.getByText(/no se pudo cargar el índice/i)).toHaveCount(0);

    await page.getByRole('link', { name: 'Abrir ficha de SOAT' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/soat$/);
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toBeVisible();
    await expect(page.getByText(/no se pudo cargar esta ficha/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ir a la pantalla SOAT' })).toHaveAttribute('href', '/flito/soat');
  });

  test('AC3 — gestor de impuestos solo ve Impuestos publicado (HU #11894)', async ({ page }) => {
    await abrirAyuda(page, GESTOR_IMPUESTOS_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Impuestos' })).toBeVisible();
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Comparendos/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Clientes/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Tablero FLITO/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Compuerta/ })).toHaveCount(0);
  });

  test('AC3 — mensajero solo ve Mi ruta publicada (HU #11894)', async ({ page }) => {
    await abrirAyuda(page, MENSAJERO_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Mi ruta' })).toBeVisible();
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
  });

  test('AC3 — financiera no ve SOAT ni Credenciales; sí ve Bolsas y parametrización publicadas (HU #11895)', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Clientes y proveedores' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Facturación electrónica · Parametrización' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
  });

  test('AC4 — índice lleno; las 6 de Finanzas/Admin publicadas, no vacío pendiente (HU #11895)', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await expect(page.getByRole('navigation', { name: 'Capítulos de ayuda' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);

    await page.getByRole('link', { name: 'Abrir ficha de Bolsas' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/flito_bolsas$/);
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('AC4 — error del índice: Reintentar; ausencia de .md no es este estado', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.route('**/content/ayuda/_plantilla.md**', (route) => route.abort('failed'));
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('heading', { name: 'No se pudo cargar el índice de ayuda.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText(/esta ficha está pendiente/i)).toHaveCount(0);
  });

  test('AC4 — deep-link a ficha sin permiso es NoAccess de esa pantalla', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — bolsas/i })).toBeVisible();
    await expect(page.getByText(/esta ficha está pendiente/i)).toHaveCount(0);
  });

  test('AC4 — slug fuera del catálogo: esta ficha no existe', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/privacy');
    await expect(page.getByText('Esta ficha no existe.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al índice' }).first()).toBeVisible();
  });

  test('AC4 — admin ve Compuerta, Tablero FLITO y Credenciales publicados (HU #11895)', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Compuerta de entrega' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Tablero FLITO' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Facturación electrónica · Credenciales' })).toBeVisible();
    await expect(page.getByRole('link', { name: /ficha pendiente de Facturación electrónica · Credenciales/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Mi ruta' })).toBeVisible();
  });
});
