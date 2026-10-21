// Ayuda FLITO — imágenes y diagramas en las fichas con carga diferida (Feature #13691 · HU #13707).
// Diseño slim §6: solo `![alt](./<clave>/<archivo>)`, URL final `/ayuda/<clave>/<archivo>?v=<version>`,
// cualquier otro origen → solo el alt y ninguna petición. Unidad pura del parser + UI de AC1, AC4,
// AC5, AC6 y responsive a 375. Las fichas sintéticas se sirven interceptando el `.md` (módulo `?raw`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { parseMarkdown, urlImagen } from '../../src/lib/ayudaMarkdown';
import { loginAs, ADMIN_USER } from '../helpers/ayuda-fixtures';

const CLAVE = 'siigo_operacion';
const ALT_AC1 = 'Bandeja de facturas con el filtro Pendientes';
const ALT_DIAGRAMA =
  'Diagrama: un caso detenido se reintenta, se corrige o se da por perdido; un caso dado por perdido vuelve a la cola con Volver a intentarlo';

const SVG_DEMO = readFileSync(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public/ayuda/siigo_operacion/camino-caso-detenido.svg'),
  'utf8',
);

const encabezado = (version: string) => [
  '---',
  'resumen: Ficha de prueba de imágenes.',
  'palabras_clave:',
  '  - prueba',
  'consultas:',
  '  - cómo se ven las imágenes',
  `version: ${version}`,
  'fecha: 2026-10-20',
  '---',
].join('\n');

const FICHA_AC1 = `${encabezado('1.1')}
## Qué es

Ficha con una captura.

![${ALT_AC1}](./siigo_operacion/bandeja.png)

## Pasos

1. Texto posterior a la imagen.
`;

const FICHA_ROTA = `${encabezado('1.0')}
## Qué es

Antes de la imagen.

![Archivo que no existe](./siigo_operacion/no-existe.png)

## Pasos

1. Texto posterior que se lee normal.
`;

const FICHA_EXTERNA = `${encabezado('1.0')}
## Qué es

![Logo externo](https://example.com/logo.png)

![Pixel en línea](data:image/png;base64,iVBORw0KGgo=)

![Salto de carpeta](../otra/archivo.png)

![Ruta absoluta](/ayuda/siigo_operacion/bandeja.png)

## Pasos

1. Fin.
`;

async function servirFicha(page: Page, clave: string, md: string) {
  await page.route(`**/content/ayuda/${clave}.md**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `export default ${JSON.stringify(md)};`,
  }));
}

test.describe('FLITO — Ayuda · imágenes, unidad pura del parser (HU #13707)', () => {
  test('válida → nodo img con la URL versionada (?v=)', () => {
    const ast = parseMarkdown(`![${ALT_AC1}](./siigo_operacion/bandeja.png)`, { versionFicha: '1.1' });
    expect(ast).toEqual([{
      type: 'p',
      children: [{ type: 'img', alt: ALT_AC1, src: '/ayuda/siigo_operacion/bandeja.png?v=1.1' }],
    }]);
    // Sin versión, sin `?v=`; jpg/jpeg/webp/svg también valen; dentro de un texto sigue siendo img.
    expect(urlImagen('./siigo_operacion/bandeja.png')).toBe('/ayuda/siigo_operacion/bandeja.png');
    for (const ext of ['jpg', 'jpeg', 'webp', 'svg']) {
      expect(urlImagen(`./clave_x/a-b_1.${ext}`, '2.0')).toBe(`/ayuda/clave_x/a-b_1.${ext}?v=2.0`);
    }
    const [p] = parseMarkdown('Mire ![Diagrama](./clave_x/d.svg) aquí.', { versionFicha: '1.0' });
    expect(p.type === 'p' && p.children.map((n) => n.type)).toEqual(['text', 'img', 'text']);
  });

  test('sin alt → ningún nodo (la prueba de artefactos lo detecta)', () => {
    expect(parseMarkdown('![](./siigo_operacion/bandeja.png)')).toEqual([{ type: 'p', children: [] }]);
    expect(parseMarkdown('![   ](./siigo_operacion/bandeja.png)')).toEqual([{ type: 'p', children: [] }]);
  });

  test('http, data:, ../, ruta absoluta, mayúsculas o extensión no permitida → solo el alt', () => {
    const casos = [
      'https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA',
      '../otra/a.png', './siigo_operacion/../x.png', '/ayuda/siigo_operacion/a.png',
      './siigo_operacion/a.gif', './siigo_operacion/a.html', './Siigo/a.png', './siigo_operacion/sub/a.png',
      'javascript:void0', './siigo_operacion/a.png?x=1',
    ];
    for (const src of casos) {
      expect(urlImagen(src), src).toBeNull();
      expect(parseMarkdown(`![Texto](${src})`, { versionFicha: '1.0' }), src)
        .toEqual([{ type: 'p', children: [{ type: 'text', value: 'Texto' }] }]);
    }
  });
});

test.describe('FLITO — Ayuda · imágenes en la ficha (HU #13707)', () => {
  test('AC1/AC3 — alt, caja 16:10 reservada antes de cargar, lazy y enlace a tamaño completo', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, ADMIN_USER);
    await servirFicha(page, CLAVE, FICHA_AC1);
    let soltar: () => void = () => {};
    const retenida = new Promise<void>((r) => { soltar = r; });
    const pedidas: string[] = [];
    await page.route('**/ayuda/siigo_operacion/bandeja.png**', async (route) => {
      pedidas.push(route.request().url());
      await retenida;
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG_DEMO });
    });
    await page.goto(`/flito/ayuda/${CLAVE}`);

    const img = page.getByRole('img', { name: ALT_AC1 });
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('src', '/ayuda/siigo_operacion/bandeja.png?v=1.1');
    const caja = page.getByTestId('ayuda-imagen').locator('> span').first();
    const pasos = page.getByRole('heading', { name: 'Pasos' });

    // Antes de cargar: la caja ya ocupa 16:10 del ancho del contenedor.
    await expect.poll(() => pedidas.length).toBeGreaterThan(0);
    const antes = (await caja.boundingBox())!;
    const pasosAntes = (await pasos.boundingBox())!;
    expect(Math.abs(antes.height - antes.width * 10 / 16)).toBeLessThanOrEqual(2);
    const ancho = await page.locator('[data-ayuda-cuerpo]').evaluate((el) => el.getBoundingClientRect().width);
    expect(antes.width).toBeLessThanOrEqual(ancho + 1);

    soltar();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    // Sin salto de layout: ni la caja ni lo que sigue se mueven al cargar.
    const despues = (await caja.boundingBox())!;
    expect(Math.abs(despues.height - antes.height)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((await pasos.boundingBox())!.y - pasosAntes.y)).toBeLessThanOrEqual(0.5);
    await expect(img).toHaveCSS('object-fit', 'contain');

    const enlace = page.getByRole('link', { name: /Ver en tamaño completo/ });
    await expect(enlace).toHaveAttribute('href', '/ayuda/siigo_operacion/bandeja.png?v=1.1');
    await expect(enlace).toHaveAttribute('target', '_blank');
    await expect(enlace).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('AC4 — la ficha real de Siigo muestra su diagrama SVG como imagen, desde public/ y versionado', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, ADMIN_USER);
    const respuestas: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/ayuda/siigo_operacion/')) respuestas.push(`${r.status()} ${r.url()}`); });
    await page.goto(`/flito/ayuda/${CLAVE}`);
    const img = page.getByRole('img', { name: ALT_DIAGRAMA });
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    await expect(img).toHaveAttribute('src', /^\/ayuda\/siigo_operacion\/camino-caso-detenido\.svg\?v=\d+\.\d+$/);
    expect(respuestas.some((r) => /^200 .*camino-caso-detenido\.svg\?v=/.test(r))).toBe(true);
    await expect(page.getByTestId('ayuda-imagen-rota')).toHaveCount(0);
  });

  test('AC5 — archivo inexistente → «Imagen no disponible: <alt>» y el resto de la ficha se lee', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, ADMIN_USER);
    await servirFicha(page, CLAVE, FICHA_ROTA);
    await page.route('**/ayuda/siigo_operacion/no-existe.png**', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto(`/flito/ayuda/${CLAVE}`);
    await expect(page.getByTestId('ayuda-imagen-rota')).toHaveText('Imagen no disponible: Archivo que no existe');
    await expect(page.getByRole('img', { name: 'Archivo que no existe' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Ver en tamaño completo/ })).toHaveCount(0);
    await expect(page.getByText('Antes de la imagen.')).toBeVisible();
    await expect(page.getByText('Texto posterior que se lee normal.')).toBeVisible();
  });

  test('AC6 — origen externo, data:, ../ o ruta absoluta: solo el alt y ninguna petición', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, ADMIN_USER);
    const pedidas: string[] = [];
    page.on('request', (r) => pedidas.push(r.url()));
    await servirFicha(page, CLAVE, FICHA_EXTERNA);
    await page.goto(`/flito/ayuda/${CLAVE}`);
    const cuerpo = page.locator('[data-ayuda-cuerpo]');
    for (const alt of ['Logo externo', 'Pixel en línea', 'Salto de carpeta', 'Ruta absoluta']) {
      await expect(cuerpo.getByText(alt, { exact: true })).toBeVisible();
    }
    await expect(cuerpo.locator('img')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Ver en tamaño completo/ })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(pedidas.filter((u) => u.includes('example.com') || u.startsWith('data:') || u.includes('/otra/')
      || u.includes('/ayuda/siigo_operacion/bandeja.png'))).toEqual([]);
  });

  test('responsive 375 — la imagen no desborda la ficha ni el viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, ADMIN_USER);
    await page.goto(`/flito/ayuda/${CLAVE}`);
    const img = page.getByRole('img', { name: ALT_DIAGRAMA });
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    const caja = (await page.getByTestId('ayuda-imagen').locator('> span').first().boundingBox())!;
    const cuerpo = (await page.locator('[data-ayuda-cuerpo]').boundingBox())!;
    expect(caja.x).toBeGreaterThanOrEqual(cuerpo.x - 1);
    expect(caja.x + caja.width).toBeLessThanOrEqual(cuerpo.x + cuerpo.width + 1);
    expect(Math.abs(caja.height - caja.width * 10 / 16)).toBeLessThanOrEqual(2);
    expect(caja.x + caja.width).toBeLessThanOrEqual(375);
    // El cuerpo de la ficha no genera scroll horizontal propio. (El desborde de ~78 px de la topbar del
    // shell a 375 es preexistente y ajeno a la Ayuda: se ve igual en fichas sin imagen.)
    const desborde = await page.locator('[data-ayuda-cuerpo]').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(desborde).toBeLessThanOrEqual(0);
  });
});
