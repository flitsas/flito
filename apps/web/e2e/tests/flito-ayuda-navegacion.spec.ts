// Ayuda FLITO — tabla de contenido, enlace a sección y Anterior/Siguiente (Feature #13691 · HU #13705).
// Dos bloques: unidad pura (sin navegador: importa los helpers desde `src`) y UI de AC1–AC6, más el
// Reintentar de la ficha (defecto heredado: el reintento por nonce no salía nunca del error).
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { CATALOGO_AYUDA, GRUPOS_ORDEN, type EntradaAyuda } from '../../src/content/ayuda/catalogo';
import { anclaDeEncabezado, parseMarkdown } from '../../src/lib/ayudaMarkdown';
import { puedeEnlazarFichaAyuda, vecinasVisibles } from '../../src/lib/ayudaFlito';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { contraste, fondoPintado, tintaEfectiva } from '../helpers/pixeles';
import { loginAs, FINANCIERA_USER, OPERACIONES_USER } from '../helpers/ayuda-fixtures';

const ENCABEZADO = [
  '---',
  'resumen: Ficha de prueba de navegación.',
  'palabras_clave:',
  '  - prueba',
  'consultas:',
  '  - cómo navego la ficha',
  'version: 1.0',
  'fecha: 2026-10-20',
  '---',
].join('\n');

const relleno = Array.from({ length: 12 }, (_, i) => `Párrafo de relleno ${i + 1} para que haya desplazamiento.`).join('\n\n');

const FICHA_TOC = `${ENCABEZADO}
## Qué es

${relleno}

## Pasos

1. Abrir la pantalla.

${relleno}

### Paso avanzado

${relleno}

## Cómo se entra

${relleno}
`;

/** Sustituye el `.md` (servido por Vite como módulo `?raw`) de una ficha por `md`. */
async function servirFicha(page: Page, clave: string, md: string) {
  await page.route(`**/content/ayuda/${clave}.md**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `export default ${JSON.stringify(md)};`,
  }));
}

const toc = (page: Page) => page.getByRole('navigation', { name: 'Contenido de la ficha' });

function entrada(clave: string): EntradaAyuda {
  const e = CATALOGO_AYUDA.find((x) => x.clave === clave);
  if (!e) throw new Error(clave);
  return e;
}

test.describe('FLITO — Ayuda · navegación, unidad pura (HU #13705)', () => {
  test('AC7 — anclaDeEncabezado: NFD, minúsculas, guiones; vacío → «seccion»', () => {
    expect(anclaDeEncabezado('Cómo se entra')).toBe('como-se-entra');
    expect(anclaDeEncabezado('Año ñandú')).toBe('ano-nandu');
    expect(anclaDeEncabezado('  ¿Qué NO hace?  ')).toBe('que-no-hace');
    expect(anclaDeEncabezado('Paso 1 · Cargar')).toBe('paso-1-cargar');
    expect(anclaDeEncabezado('¡¿?!')).toBe('seccion');
  });

  test('AC7 — parseMarkdown: ids únicos por ficha; repetido → «-2», «-3»; texto plano sin marcas', () => {
    const ast = parseMarkdown('## Pasos\n\n### **Paso** `avanzado`\n\n## Pasos\n\n## Pasos\n\n# Qué es');
    const ids = ast.flatMap((b) => ('id' in b ? [b.id] : []));
    expect(ids).toEqual(['pasos', 'paso-avanzado', 'pasos-2', 'pasos-3', 'que-es']);
  });

  test('AC5 — vecinasVisibles: orden dado, salta no visibles, sin Anterior/Siguiente en los extremos', () => {
    const visibles = ['flito_tablero', 'flito_bolsas', 'flito_conciliacion', 'roles_permisos'].map(entrada);
    expect(vecinasVisibles(visibles, 'flito_tablero')).toEqual({ anterior: undefined, siguiente: entrada('flito_bolsas') });
    expect(vecinasVisibles(visibles, 'flito_conciliacion')).toEqual({
      anterior: entrada('flito_bolsas'), siguiente: entrada('roles_permisos'),
    });
    expect(vecinasVisibles(visibles, 'roles_permisos')).toEqual({ anterior: entrada('flito_conciliacion'), siguiente: undefined });
    // `flito_tarifas` va entre bolsas y conciliación en el catálogo, pero no es visible: no existe aquí.
    expect(vecinasVisibles(visibles, 'flito_tarifas')).toEqual({});
    expect(vecinasVisibles([entrada('soat')], 'soat')).toEqual({ anterior: undefined, siguiente: undefined });
  });

  test('GRUPOS_ORDEN vive en el catálogo y cubre todos los grupos', () => {
    expect([...GRUPOS_ORDEN]).toEqual(['general', 'gestion', 'finanzas', 'administracion']);
    for (const e of CATALOGO_AYUDA) expect(GRUPOS_ORDEN).toContain(e.grupo);
  });

  test('AC4 — puedeEnlazarFichaAyuda acepta #… y ?… y falla cerrada bajo /flito/ayuda', () => {
    const financiera = { allowedPages: ['flito_bolsas', 'flito_conciliacion'], tipoEnlace: 'ninguno' as const };
    const sinFichas = { allowedPages: ['flito_soat_inexistente'], tipoEnlace: 'ninguno' as const };
    // Ficha sin permiso, con ancla o query → no.
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/siigo_credenciales#paso-1')).toBe(false);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/siigo_credenciales?x=1')).toBe(false);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/siigo_credenciales')).toBe(false);
    // Ficha visible, con o sin ancla/query → sí.
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/flito_bolsas')).toBe(true);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/flito_bolsas#pasos')).toBe(true);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/flito_bolsas?v=1#pasos')).toBe(true);
    // Formas raras bajo /flito/ayuda → no.
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/flito_bolsas/extra')).toBe(false);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/no_existe#x')).toBe(false);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayudax')).toBe(false);
    // El índice: depende de ver ≥1 ficha.
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda')).toBe(true);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda#x')).toBe(true);
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/ayuda/')).toBe(true);
    expect(puedeEnlazarFichaAyuda(sinFichas, '/flito/ayuda?q=1')).toBe(false);
    expect(puedeEnlazarFichaAyuda(null, '/flito/ayuda/flito_bolsas#pasos')).toBe(false);
    // Fuera de la Ayuda no es asunto de este helper.
    expect(puedeEnlazarFichaAyuda(financiera, '/flito/tramites')).toBe(true);
  });
});

test.describe('FLITO — Ayuda · navegación en la ficha (HU #13705)', () => {
  test('AC1/AC7 — TOC con un enlace por sección, h3 anidado; «Pasos» → URL #pasos y foco en el h2', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    const nav = toc(page);
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText(['Qué es', 'Pasos', 'Paso avanzado', 'Cómo se entra']);
    await expect(nav.getByRole('link', { name: 'Paso avanzado' }).locator('xpath=..')).toHaveClass(/pl-3/);
    await expect(nav.getByRole('link', { name: 'Pasos', exact: true }).locator('xpath=..')).not.toHaveClass(/pl-3/);
    // Los encabezados llevan el id de `anclaDeEncabezado`.
    await expect(page.locator('h2#que-es')).toHaveText('Qué es');
    await expect(page.locator('h3#paso-avanzado')).toHaveText('Paso avanzado');

    await nav.getByRole('link', { name: 'Pasos', exact: true }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/flito_bolsas#pasos$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Pasos' })).toBeFocused();
    await expect(page.getByRole('heading', { level: 2, name: 'Pasos' })).toBeInViewport();
    await expect(nav.getByRole('link', { name: 'Pasos', exact: true })).toHaveAttribute('aria-current', 'location');
  });

  test('AC1 — ficha con un solo h2: sin TOC ni columna vacía', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', `${ENCABEZADO}\n## Qué es\n\nSolo una sección.\n`);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(toc(page)).toHaveCount(0);
  });

  test('AC2 — enlace directo #como-se-entra: la ficha carga y el foco queda en «Cómo se entra»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/flito_tramites#como-se-entra');
    const seccion = page.getByRole('heading', { level: 2, name: 'Cómo se entra' });
    await expect(seccion).toBeFocused();
    await expect(seccion).toHaveAttribute('id', 'como-se-entra');
    await expect(seccion).toBeInViewport();
  });

  test('AC3 — ancla inexistente: abre al inicio, foco en el título, sin error', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/flito_tramites#no-existe');
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Gestión Trámites' })).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Gestión Trámites' })).toBeInViewport();
  });

  test('AC4 — enlace con ancla a ficha sin permiso: texto para financiera; a ficha visible: enlace', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', `${ENCABEZADO}
## Qué es

Vea [credenciales de Siigo](/flito/ayuda/siigo_credenciales#paso-1) y [los pasos de Bolsas](/flito/ayuda/flito_bolsas#pasos).

## Pasos

Texto.
`);
    await page.goto('/flito/ayuda/flito_bolsas');
    const cuerpo = page.getByRole('article', { name: 'Bolsas' });
    await expect(cuerpo).toContainText('credenciales de Siigo');
    await expect(cuerpo.getByRole('link', { name: 'credenciales de Siigo' })).toHaveCount(0);
    await expect(cuerpo.getByRole('link', { name: 'los pasos de Bolsas' })).toHaveAttribute('href', '/flito/ayuda/flito_bolsas#pasos');
  });

  test('AC5 — Anterior/Siguiente en el orden del índice, solo visibles, sin extremos', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda');
    const filas = page.getByRole('navigation', { name: 'Fichas de ayuda' }).getByRole('link');
    await expect(filas.first()).toBeVisible();
    const claves = (await filas.evaluateAll((els) => els.map((a) => a.getAttribute('href') ?? '')))
      .map((h) => h.replace('/flito/ayuda/', ''));
    expect(claves.length).toBeGreaterThanOrEqual(3);
    expect(claves).not.toContain('siigo_credenciales');
    const etiqueta = (clave: string) => entrada(clave).etiqueta;

    // Primera: sin Anterior.
    await page.goto(`/flito/ayuda/${claves[0]}`);
    const nav = page.getByRole('navigation', { name: 'Navegación entre fichas' });
    await expect(nav.getByRole('link', { name: `Ficha siguiente: ${etiqueta(claves[1])}` })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Ficha anterior/ })).toHaveCount(0);

    // Siguiente navega y la del medio tiene ambas.
    await nav.getByRole('link', { name: /^Ficha siguiente/ }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${claves[1]}$`));
    await expect(page.getByRole('heading', { level: 1, name: etiqueta(claves[1]) })).toBeVisible();
    await expect(nav.getByRole('link', { name: `Ficha anterior: ${etiqueta(claves[0])}` })).toBeVisible();
    await expect(nav.getByRole('link', { name: `Ficha siguiente: ${etiqueta(claves[2])}` })).toBeVisible();

    // Última: sin Siguiente.
    const ultima = claves[claves.length - 1];
    await page.goto(`/flito/ayuda/${ultima}`);
    await expect(nav.getByRole('link', { name: `Ficha anterior: ${etiqueta(claves[claves.length - 2])}` })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Ficha siguiente/ })).toHaveCount(0);
  });

  test('AC6 — bajo lg: TOC plegada arriba del cuerpo, sin desborde; Anterior/Siguiente apilados', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(page.getByTestId('ayuda-toc-lateral')).toBeHidden();
    const toggle = page.getByTestId('ayuda-toc-plegable');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Contenido de la ficha');
    await expect(toc(page)).toHaveCount(0);
    // La TOC va arriba del cuerpo.
    const yToggle = (await toggle.boundingBox())!.y;
    const yCuerpo = (await page.getByRole('heading', { level: 2, name: 'Qué es' }).boundingBox())!.y;
    expect(yToggle).toBeLessThan(yCuerpo);

    await toggle.click();
    await expect(toc(page).getByRole('link')).toHaveCount(4);
    await toc(page).getByRole('link', { name: 'Cómo se entra' }).click();
    await expect(page).toHaveURL(/#como-se-entra$/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 2, name: 'Cómo se entra' })).toBeFocused();

    // Se mide la superficie de la ficha, no el documento: la topbar del shell ya desborda a 375 px en
    // cualquier pantalla (también /flito/bolsas) y no es de esta HU.
    const desborde = await page.evaluate(() => {
      const w = window.innerWidth;
      const raices = ['[data-ayuda-cuerpo]', '[data-testid="ayuda-toc-plegable"]', 'nav[aria-label="Navegación entre fichas"]'];
      return raices.flatMap((sel) => [...document.querySelectorAll(`${sel}, ${sel} *`)])
        .filter((el) => el.getBoundingClientRect().right > w + 0.5)
        .map((el) => el.tagName);
    });
    expect(desborde).toEqual([]);

    const ant = await page.getByTestId('ayuda-ficha-anterior').boundingBox();
    const sig = await page.getByTestId('ayuda-ficha-siguiente').boundingBox();
    if (ant && sig) expect(sig.y).toBeGreaterThan(ant.y);
  });

  test('AC6 — a11y: navs con nombre, foco visible en TOC y Anterior/Siguiente, axe sin graves', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(toc(page)).toBeVisible();
    for (const link of [
      toc(page).getByRole('link', { name: 'Pasos', exact: true }),
      page.getByRole('navigation', { name: 'Navegación entre fichas' }).getByRole('link').first(),
    ]) {
      await link.focus();
      await expect(link).toBeFocused();
      const foco = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.outlineStyle}|${s.outlineWidth}|${s.boxShadow}`;
      });
      expect(foco === 'none|0px|none', `foco visible: ${foco}`).toBe(false);
    }
    esperarSinViolacionesGraves(await correrAxe(page), 'ficha con TOC y Anterior/Siguiente');
  });

  for (const tema of ['light', 'dark'] as const) {
    test(`AC6 — contraste ≥ 4.5:1 de TOC y Anterior/Siguiente (tema ${tema}, medido en píxel)`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.addInitScript((t) => localStorage.setItem('aura-theme', t), tema);
      await loginAs(page, FINANCIERA_USER);
      await servirFicha(page, 'flito_bolsas', FICHA_TOC);
      await page.goto('/flito/ayuda/flito_bolsas');
      const vecina = page.getByRole('navigation', { name: 'Navegación entre fichas' }).getByRole('link').first();
      const textos = [
        toc(page).getByRole('link', { name: 'Qué es' }),
        vecina.locator('span').first(),
        vecina.locator('span').last(),
      ];
      await page.mouse.move(0, 0);
      for (const t of textos) {
        await expect(t).toBeVisible();
        await t.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        const { color: fondo } = await fondoPintado(page, t);
        const ratio = contraste(await tintaEfectiva(t, fondo), fondo);
        expect(ratio, `${await t.innerText()}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('Reintentar de la ficha: tras un fallo de carga, recarga y la ficha se llena', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let fallar = true;
    await page.route('**/content/ayuda/flito_bolsas.md**', (route) => (fallar ? route.abort('failed') : route.continue()));
    await page.goto('/flito/ayuda/flito_bolsas');
    const alerta = page.getByRole('alert');
    await expect(alerta.getByRole('heading', { name: 'No se pudo cargar esta ficha.' })).toBeVisible();
    await expect(alerta).not.toContainText(/fetch|module|import|error:|http/i);
    await expect(page.getByRole('navigation', { name: 'Navegación entre fichas' })).toHaveCount(0);

    fallar = false;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
