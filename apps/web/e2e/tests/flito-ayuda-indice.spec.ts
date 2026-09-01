// Ayuda FLITO — índice por permiso y 4 estados (HU #11893, AC3 y AC4).
// HU #11901: búsqueda de capítulos en el índice (cuerpo Markdown de visibles).
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda, buscarCapitulos, PROVEEDOR_USER, FINANCIERA_USER, GESTOR_IMPUESTOS_USER,
  MENSAJERO_USER, OPERACIONES_USER, CONDUCTOR_USER,
} from '../helpers/ayuda-fixtures';

const COPY_CERO = 'Ningún capítulo coincide con su búsqueda.';
const COPY_PERMISO = 'No hay capítulos de ayuda para las pantallas que usted puede abrir.';
const COPY_ERROR = 'No se pudo cargar el índice de ayuda.';

function campoBuscar(page: Page) {
  return page.getByRole('searchbox', { name: 'Buscar capítulos' });
}

function urlIndiceSinQuery(page: Page) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/flito/ayuda');
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
}

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

test.describe('FLITO — Ayuda · buscar capítulos (HU #11901)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-11901-01 AC1 — proveedor: «Cargar factura» lista SOAT; URL sin query', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await buscarCapitulos(page, 'Cargar factura');
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);
    urlIndiceSinQuery(page);
  });

  test('TC-11901-02 AC1 — case-insensitive: «cargar factura» y «CARGAR FACTURA»', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await buscarCapitulos(page, 'cargar factura');
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await buscarCapitulos(page, 'CARGAR FACTURA');
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    urlIndiceSinQuery(page);
  });

  test('TC-11901-03 AC2 — financiera: «Credenciales RNDC» no revela admin; vacío de filtro', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await buscarCapitulos(page, 'Credenciales RNDC');
    await expect(page.getByText(COPY_CERO)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByText(COPY_PERMISO)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: COPY_ERROR })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver al tablero' })).toHaveCount(0);
  });

  test('TC-11901-04 AC3 — admin 0 coincidencias: copy anclado ≠ FlitEmpty ≠ error', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarCapitulos(page, 'zzz-sin-capitulo-11901');
    await expect(page.getByText(COPY_CERO)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeVisible();
    await expect(campoBuscar(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO', exact: true })).toBeVisible();
    await expect(page.getByText(COPY_PERMISO)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: COPY_ERROR })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Capítulos de ayuda' })).toHaveCount(0);
  });

  test('TC-11901-05 AC3 — Limpiar búsqueda restaura los tres grupos', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarCapitulos(page, 'zzz-sin-capitulo-11901');
    await expect(page.getByText(COPY_CERO)).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
    await expect(campoBuscar(page)).toHaveValue('');
    await expect(campoBuscar(page)).toBeFocused();
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Capítulos de ayuda' })).toBeVisible();
  });

  test('TC-11901-06 AC3 — vaciar el campo restaura; NoAccess no usa copy de filtro', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarCapitulos(page, 'zzz-sin-capitulo-11901');
    await campoBuscar(page).fill('');
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();

    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i })).toBeVisible();
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);
    await expect(page.getByText(COPY_PERMISO)).toHaveCount(0);
    await expect(campoBuscar(page)).toHaveCount(0);
  });

  test('TC-11901-07 AC4 — admin «Cargar factura»: solo grupo Gestión / SOAT', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarCapitulos(page, 'Cargar factura');
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Bolsas/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
  });

  test('TC-11901-08 AC4 — financiera «Asentar corrección» (NFD) → Bolsas', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await buscarCapitulos(page, 'Asentar corrección');
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);

    await buscarCapitulos(page, 'asentar correccion');
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
  });

  test('TC-11901-09 AC5 — campo solo en índice; no persiste; no query; espacios = vacío', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await expect(campoBuscar(page)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);

    await buscarCapitulos(page, '   ');
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);

    await buscarCapitulos(page, 'Cargar factura');
    urlIndiceSinQuery(page);
    await page.reload();
    await expect(campoBuscar(page)).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    urlIndiceSinQuery(page);

    await buscarCapitulos(page, 'Cargar factura');
    await page.getByRole('link', { name: 'Abrir ficha de SOAT' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/soat$/);
    await expect(campoBuscar(page)).toHaveCount(0);
    await page.getByRole('link', { name: 'Volver al índice' }).first().click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    await expect(campoBuscar(page)).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    urlIndiceSinQuery(page);
  });

  test('TC-11901-09b AC5 — GET /flito/ayuda/soat no tiene el campo de búsqueda', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/soat');
    await expect(page.getByRole('heading', { name: 'Qué es' })).toBeVisible();
    await expect(campoBuscar(page)).toHaveCount(0);
    await expect(page.getByPlaceholder('Buscar capítulos…')).toHaveCount(0);
  });

  test('TC-11901-10 AC6 — 4 estados: skeleton y error sin campo; 0 match = subestado lleno', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.route('**/content/ayuda/**', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('status', { name: /cargando/i })).toBeVisible();
    await expect(campoBuscar(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(campoBuscar(page)).toBeVisible();

    await page.unroute('**/content/ayuda/**');
    await page.route('**/content/ayuda/_plantilla.md**', (route) => route.abort('failed'));
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('heading', { name: COPY_ERROR })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(campoBuscar(page)).toHaveCount(0);
    await expect(page.getByText(COPY_CERO)).toHaveCount(0);
  });
});
