// Ayuda FLITO — índice por permiso y 4 estados (HU #11893, AC3 y AC4).
// HU #11901: búsqueda de capítulos en el índice (cuerpo Markdown de visibles).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda, buscarCapitulos, PROVEEDOR_USER, FINANCIERA_USER, GESTOR_IMPUESTOS_USER,
  MENSAJERO_USER, OPERACIONES_USER, CONDUCTOR_USER,
} from '../helpers/ayuda-fixtures';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

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
    await expect(page.getByRole('link', { name: /Credenciales|Integración con Siigo/ })).toHaveCount(0);
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
    await expect(page.getByRole('link', { name: /ficha de Tablero/ })).toHaveCount(0);
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
    await expect(page.getByRole('link', { name: /Credenciales|Integración con Siigo/ })).toHaveCount(0);
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

  test('AC4 — admin ve Tablero e Integración con Siigo publicados; sin capítulo Compuerta (HU #11895, #13431)', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    // HU #13431: «Entregar trámites» es una acción de Gestión Trámites, no un ítem del menú.
    await expect(page.getByRole('link', { name: /Compuerta/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Tablero' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Integración con Siigo', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Facturación electrónica · Credenciales/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /ficha pendiente de Integración con Siigo/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Mi ruta' })).toBeVisible();
  });

  test('HU #13431 — el índice usa los nombres del menú: «Derechos» y el «Tablero» de General', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    // P-33: el capítulo de derechos se llama como el ítem del menú.
    await expect(page.getByRole('link', { name: 'Abrir ficha de Derechos', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Derechos de tránsito/ })).toHaveCount(0);
    // P-11: el «Tablero FLITO» se absorbió en el Tablero de General; el capítulo vive en ese grupo,
    // va primero y lleva al inicio (`/`).
    await expect(page.getByRole('link', { name: /Tablero FLITO/ })).toHaveCount(0);
    const general = page.locator('section[aria-labelledby="ayuda-grupo-general"]');
    await expect(general.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await expect(general.getByRole('link', { name: 'Abrir ficha de Tablero', exact: true })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="ayuda-grupo-gestion"]').getByRole('link', { name: /Tablero/ })).toHaveCount(0);
    await expect(page.locator('section[aria-labelledby]').first()).toHaveAttribute('aria-labelledby', 'ayuda-grupo-general');
    await page.goto('/flito/ayuda/flito_tablero');
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Tablero' })).toHaveAttribute('href', '/');
  });
  test('HU #13431 — cada grupo del índice sigue el orden del menú (NAV_ENTRADAS)', async ({ page }) => {
    // Fuente: el orden de `page:` en navEntradas.ts por sección, y el de `permiso:` en el catálogo.
    const nav = readFileSync(resolve(raiz, 'apps/web/src/components/shell/navEntradas.ts'), 'utf8');
    const ordenMenu = [...nav.matchAll(/\{ page: '(\w+)',[^}]*section: '(\w+)'/g)].map((m) => ({ page: m[1], section: m[2] }));
    const cat = readFileSync(resolve(raiz, 'apps/web/src/content/ayuda/catalogo.ts'), 'utf8');
    const capitulos = [...cat.matchAll(/clave: '(\w+)', grupo: '(\w+)', etiqueta: '([^']+)'[^}]*permiso: '(\w+)'/g)]
      .map((m) => ({ clave: m[1], grupo: m[2], etiqueta: m[3], permiso: m[4] }));
    expect(capitulos.length).toBeGreaterThan(15);
    const SECCION: Record<string, string> = { general: 'general', gestion: 'gestion', finanzas: 'finanzas', administracion: 'admin' };
    // El Tablero de General es el ítem `dashboard` del menú (P-11): su capítulo cuelga de `flito_tablero`.
    const itemDelMenu = (permiso: string) => (permiso === 'flito_tablero' ? 'dashboard' : permiso);
    const esperado: Record<string, string[]> = {};
    for (const grupo of Object.keys(SECCION)) {
      const delGrupo = capitulos.filter((c) => c.grupo === grupo);
      const posiciones = delGrupo.map((c) => {
        const i = ordenMenu.findIndex((e) => e.page === itemDelMenu(c.permiso));
        expect(i, `${c.clave} es un ítem del menú`).toBeGreaterThanOrEqual(0);
        expect(ordenMenu[i].section, `${c.clave} va en la sección de su grupo`).toBe(SECCION[grupo]);
        return i;
      });
      expect(posiciones, `orden de ${grupo}`).toEqual([...posiciones].sort((a, b) => a - b));
      esperado[grupo] = delGrupo.map((c) => `Abrir ficha de ${c.etiqueta}`);
    }

    // Y lo que se pinta respeta ese orden (admin ve todos los capítulos).
    await abrirAyuda(page, OPERACIONES_USER);
    for (const grupo of Object.keys(SECCION)) {
      const enlaces = page.locator(`section[aria-labelledby="ayuda-grupo-${grupo}"] a`);
      await expect(enlaces).toHaveCount(esperado[grupo].length);
      const nombres = await enlaces.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      expect(nombres, `índice · ${grupo}`).toEqual(esperado[grupo]);
    }
  });

  test('HU #13431 — en 375 px el índice no desborda y las tarjetas usan el token de tarjeta', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await abrirAyuda(page, OPERACIONES_USER);
    const capitulos = page.getByRole('navigation', { name: 'Capítulos de ayuda' });
    await expect(capitulos).toBeVisible();
    // El desborde del header del shell (acciones de la barra superior) es de todas las páginas y
    // no de esta: se mide el contenido de la Ayuda, no `documentElement.scrollWidth`.
    const derechaMax = await page.evaluate(() => {
      const raices = [
        document.querySelector('nav[aria-label="Capítulos de ayuda"]'),
        document.getElementById('ayuda-buscar-capitulos'),
      ];
      let max = 0;
      for (const r of raices) {
        if (!r) continue;
        for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) max = Math.max(max, el.getBoundingClientRect().right);
      }
      return max;
    });
    expect(derechaMax).toBeLessThanOrEqual(375);
    // Sin `bg-white`: la tarjeta toma `--flit-bg-card`, que tiene par oscuro.
    await expect(capitulos.locator('.bg-white')).toHaveCount(0);
    const fondo = await capitulos.locator('section > div').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const token = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.background = 'var(--flit-bg-card)';
      document.body.appendChild(d);
      const c = getComputedStyle(d).backgroundColor;
      d.remove();
      return c;
    });
    expect(fondo).toBe(token);
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
    await expect(page.getByRole('link', { name: /Credenciales|Integración con Siigo/ })).toHaveCount(0);
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
    await expect(page.getByRole('link', { name: /Credenciales|Integración con Siigo/ })).toHaveCount(0);
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
