// Ayuda FLITO — tabla de contenido, enlace a sección y Anterior/Siguiente (Feature #13691 · HU #13705).
// Dos bloques: unidad pura (sin navegador: importa los helpers desde `src`) y UI de AC1–AC6, más el
// Reintentar de la ficha (defecto heredado: el reintento por nonce no salía nunca del error).
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { CATALOGO_AYUDA, GRUPOS_ORDEN, GRUPO_AYUDA_LABEL, type EntradaAyuda } from '../../src/content/ayuda/catalogo';
import { anclaDeEncabezado, parseMarkdown } from '../../src/lib/ayudaMarkdown';
import { puedeEnlazarFichaAyuda, vecinasVisibles } from '../../src/lib/ayudaFlito';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { contraste, fondoPintado, tintaEfectiva } from '../helpers/pixeles';
import { loginAs, CLIENTE_USER, CONDUCTOR_USER, FINANCIERA_USER, OPERACIONES_USER } from '../helpers/ayuda-fixtures';

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
    expect([...GRUPOS_ORDEN]).toEqual(['general', 'gestion', 'transito', 'finanzas', 'administracion']); // HU #13775: Tránsito
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

  // HU #13775 — el grupo Tránsito entra entre Gestión y Finanzas en Anterior/Siguiente (docs/ux/flito-ayuda-transito.md).
  test('HU #13775 — Siguiente y Anterior cruzan Gestión → Tránsito → Finanzas', async ({ page }) => {
    const ultimaGestion = CATALOGO_AYUDA.filter((c) => c.grupo === 'gestion').at(-1)!;
    const primeraFinanzas = CATALOGO_AYUDA.find((c) => c.grupo === 'finanzas')!;
    expect(GRUPOS_ORDEN.slice(1, 4)).toEqual(['gestion', 'transito', 'finanzas']);
    await loginAs(page, OPERACIONES_USER); // admin: ve todas las fichas
    await page.goto(`/flito/ayuda/${ultimaGestion.clave}`);
    const nav = page.getByRole('navigation', { name: 'Navegación entre fichas' });
    await nav.getByRole('link', { name: 'Ficha siguiente: Organismos de tránsito' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/transito_organismos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Organismos de tránsito' })).toBeVisible();
    await expect(nav.getByRole('link', { name: `Ficha anterior: ${ultimaGestion.etiqueta}` })).toBeVisible();

    await nav.getByRole('link', { name: `Ficha siguiente: ${primeraFinanzas.etiqueta}` }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${primeraFinanzas.clave}$`));
    await nav.getByRole('link', { name: 'Ficha anterior: Organismos de tránsito' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/transito_organismos$/);
    await nav.getByRole('link', { name: `Ficha anterior: ${ultimaGestion.etiqueta}` }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${ultimaGestion.clave}$`));
  });

  test('HU #13775 AC4 — /flito/ayuda/transito_organismos sin el permiso: NoAccess, sin la ficha', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda/transito_organismos');
    await expect(page.getByRole('heading', { name: /no tienes acceso a organismos de tránsito/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toHaveCount(0);
    await expect(page.getByText('Configuración de cada secretaría de tránsito', { exact: false })).toHaveCount(0);
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

// ── HU #13896 · Árbol lateral de fichas (docs/ux/flito-ayuda.md § HU #13896) ─────────────────────

const arbol = (page: Page) => page.getByTestId('ayuda-arbol-lateral');
const arbolPlegable = (page: Page) => page.getByTestId('ayuda-arbol-plegable');
const grupoBtn = (page: Page, grupo: string) => arbol(page).getByRole('button', { name: grupo, exact: true });

/** Claves visibles del usuario, en el orden del índice (la fuente de verdad que el árbol replica). */
async function clavesDelIndice(page: Page): Promise<string[]> {
  await page.goto('/flito/ayuda');
  const filas = page.getByRole('navigation', { name: 'Fichas de ayuda' }).getByRole('link');
  await expect(filas.first()).toBeVisible();
  return (await filas.evaluateAll((els) => els.map((a) => a.getAttribute('href') ?? '')))
    .map((h) => h.replace('/flito/ayuda/', ''));
}

function gruposDe(claves: string[]): string[] {
  const presentes = new Set(claves.map((c) => entrada(c).grupo));
  return GRUPOS_ORDEN.filter((g) => presentes.has(g)).map((g) => GRUPO_AYUDA_LABEL[g]);
}

test.describe('FLITO — Ayuda · árbol lateral de fichas (HU #13896)', () => {
  test('AC1/AC2 — ≥ lg: 3 columnas, grupos en orden del índice, solo el grupo actual desplegado, ficha actual marcada', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, OPERACIONES_USER); // admin: varios grupos
    const claves = await clavesDelIndice(page);
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(toc(page)).toBeVisible();
    await expect(arbol(page)).toBeVisible();
    await expect(arbol(page)).toHaveAttribute('aria-label', 'Fichas de ayuda');
    const columnas = await arbol(page).locator('xpath=..').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columnas).toBe(3);

    const grupos = gruposDe(claves);
    await expect(arbol(page).getByRole('button')).toHaveText(grupos);
    for (const g of grupos) {
      await expect(grupoBtn(page, g)).toHaveAttribute('aria-expanded', g === 'Finanzas' ? 'true' : 'false');
    }
    const actual = arbol(page).locator('[aria-current]');
    await expect(actual).toHaveCount(1);
    await expect(actual).toHaveAttribute('aria-current', 'page');
    await expect(actual).toHaveText('Bolsas');
    await expect(actual).toHaveClass(/font-semibold/);

    // Desplegado todo, el árbol lista exactamente las fichas del índice, en su orden.
    for (const g of grupos) {
      if (await grupoBtn(page, g).getAttribute('aria-expanded') === 'false') await grupoBtn(page, g).click();
    }
    const hrefs = await arbol(page).getByRole('link').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(claves.map((c) => `/flito/ayuda/${c}`));
  });

  test('AC1 — ficha con un solo h2: 2 columnas (árbol + artículo), sin columna derecha vacía', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, 'flito_bolsas', `${ENCABEZADO}\n## Qué es\n\nSolo una sección.\n`);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(arbol(page)).toBeVisible();
    await expect(toc(page)).toHaveCount(0);
    const columnas = await arbol(page).locator('xpath=..').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columnas).toBe(2);
  });

  test('AC3 — navegar desde el árbol sin recarga; Volver al índice y Anterior/Siguiente con las vecinas correctas', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, OPERACIONES_USER);
    const claves = await clavesDelIndice(page);
    const destino = claves.find((c) => entrada(c).grupo === 'finanzas' && c !== 'flito_bolsas')!;
    expect(destino).toBeTruthy();
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(arbol(page)).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __sinRecarga?: number }).__sinRecarga = 1; });

    await arbol(page).getByRole('link', { name: entrada(destino).etiqueta, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${destino}$`));
    await expect(page.getByRole('heading', { level: 1, name: entrada(destino).etiqueta })).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __sinRecarga?: number }).__sinRecarga)).toBe(1);
    await expect(arbol(page).locator('[aria-current="page"]')).toHaveText(entrada(destino).etiqueta);

    await expect(page.getByRole('link', { name: '← Volver al índice' })).toBeVisible();
    const i = claves.indexOf(destino);
    const nav = page.getByRole('navigation', { name: 'Navegación entre fichas' });
    if (i > 0) await expect(nav.getByRole('link', { name: `Ficha anterior: ${entrada(claves[i - 1]).etiqueta}` })).toBeVisible();
    if (i < claves.length - 1) await expect(nav.getByRole('link', { name: `Ficha siguiente: ${entrada(claves[i + 1]).etiqueta}` })).toBeVisible();

    // Enter sobre un enlace del árbol también navega.
    const otro = arbol(page).getByRole('link', { name: 'Bolsas', exact: true });
    await otro.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/flito\/ayuda\/flito_bolsas$/);
    expect(await page.evaluate(() => (window as unknown as { __sinRecarga?: number }).__sinRecarga)).toBe(1);
  });

  test('AC4 — Enter/Espacio despliegan; la memoria sobrevive al cambio de ficha e ir al índice; el grupo de la ficha nueva se fuerza', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, OPERACIONES_USER);
    const claves = await clavesDelIndice(page);
    const gestion = claves.find((c) => entrada(c).grupo === 'gestion')!;
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    const btnGestion = grupoBtn(page, 'Gestión');
    await expect(btnGestion).toHaveAttribute('aria-expanded', 'false');
    // Plegado: sus enlaces no están en el orden de tabulación.
    await expect(arbol(page).getByRole('link', { name: entrada(gestion).etiqueta, exact: true })).toBeHidden();

    await btnGestion.focus();
    await page.keyboard.press('Enter');
    await expect(btnGestion).toHaveAttribute('aria-expanded', 'true');
    await expect(btnGestion).toBeFocused();
    await page.keyboard.press('Space');
    await expect(btnGestion).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(btnGestion).toHaveAttribute('aria-expanded', 'true');

    // Saltar a una ficha de Gestión: Gestión y Finanzas siguen desplegados.
    await arbol(page).getByRole('link', { name: entrada(gestion).etiqueta, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${gestion}$`));
    await expect(grupoBtn(page, 'Gestión')).toHaveAttribute('aria-expanded', 'true');
    await expect(grupoBtn(page, 'Finanzas')).toHaveAttribute('aria-expanded', 'true');

    // Plegar el grupo actual está permitido; al volver a abrir una ficha de Gestión se fuerza desplegado.
    await grupoBtn(page, 'Gestión').click();
    await expect(grupoBtn(page, 'Gestión')).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('link', { name: '← Volver al índice' }).click();
    await expect(arbol(page)).toHaveCount(0);
    await page.getByRole('link', { name: `Abrir ficha de ${entrada(gestion).etiqueta}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${gestion}$`));
    await expect(grupoBtn(page, 'Gestión')).toHaveAttribute('aria-expanded', 'true');
    await expect(grupoBtn(page, 'Finanzas')).toHaveAttribute('aria-expanded', 'true');

    // Memoria solo de la SPA: recargar deja desplegado solo el grupo actual; nada en el storage.
    await page.reload();
    await expect(grupoBtn(page, 'Gestión')).toHaveAttribute('aria-expanded', 'true');
    await expect(grupoBtn(page, 'Finanzas')).toHaveAttribute('aria-expanded', 'false');
    const persistido = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .filter((k) => /arbol|grupo|desplegad/i.test(k)));
    expect(persistido).toEqual([]);
  });

  test('AC5 — < lg: acordeón «Fichas de ayuda» cerrado encima de la TOC, sin desborde; abierto marca la actual', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, FINANCIERA_USER);
    const claves = await clavesDelIndice(page);
    await servirFicha(page, 'flito_bolsas', FICHA_TOC);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { level: 2, name: 'Qué es' })).toBeVisible();
    await expect(arbol(page)).toBeHidden();
    const toggle = arbolPlegable(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Fichas de ayuda');
    await expect(toggle).toContainText(`(${claves.length})`);
    const yArbol = (await toggle.boundingBox())!.y;
    const yToc = (await page.getByTestId('ayuda-toc-plegable').boundingBox())!.y;
    expect(yArbol).toBeLessThan(yToc);

    await toggle.click();
    const nav = page.getByRole('navigation', { name: 'Fichas de ayuda' });
    await expect(nav).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveText('Bolsas');

    const desborde = await page.evaluate(() => {
      const w = window.innerWidth;
      const raices = ['[data-ayuda-cuerpo]', 'nav[aria-label="Fichas de ayuda"]', '[data-testid="ayuda-arbol-plegable"]'];
      return raices.flatMap((sel) => [...document.querySelectorAll(`${sel}, ${sel} *`)])
        .filter((el) => el.getBoundingClientRect().right > w + 0.5)
        .map((el) => el.tagName);
    });
    expect(desborde).toEqual([]);

    const otra = claves.find((c) => entrada(c).grupo === 'finanzas' && c !== 'flito_bolsas');
    if (otra) {
      await nav.getByRole('link', { name: entrada(otra).etiqueta, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/flito/ayuda/${otra}$`));
      await expect(arbolPlegable(page)).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('AC6 — el índice no tiene árbol', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('heading', { level: 1, name: 'Ayuda FLITO' })).toBeVisible();
    await expect(arbol(page)).toHaveCount(0);
    await expect(arbolPlegable(page)).toHaveCount(0);
  });

  test('AC7 — usuario con una sola ficha: un grupo desplegado y una ficha marcada', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/flito/ayuda/dashboard');
    await expect(arbol(page)).toBeVisible();
    const botones = arbol(page).getByRole('button');
    await expect(botones).toHaveCount(1);
    await expect(botones).toHaveText('General');
    await expect(botones).toHaveAttribute('aria-expanded', 'true');
    const enlaces = arbol(page).locator('a');
    await expect(enlaces).toHaveCount(1);
    await expect(enlaces).toHaveAttribute('aria-current', 'page');
  });

  test('AC7 — rol con enlace en una URL de ficha: NoAccess como hoy, sin árbol', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, CLIENTE_USER);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { name: /no tienes acceso/i })).toBeVisible();
    await expect(arbol(page)).toHaveCount(0);
    await expect(arbolPlegable(page)).toHaveCount(0);
  });

  test('AC8 — slug inexistente: mensaje de hoy, sin árbol ni etiquetas ajenas', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda/flito_compuerta'); // clave fuera del catálogo (HU #13774)
    await expect(page.getByText('Esta ficha no existe.')).toBeVisible();
    await expect(arbol(page)).toHaveCount(0);
    await expect(arbolPlegable(page)).toHaveCount(0);
    await expect(page.getByText('Fichas de ayuda', { exact: true })).toHaveCount(0);

    await page.goto('/flito/ayuda/transito_organismos');
    await expect(page.getByRole('heading', { name: /no tienes acceso a organismos de tránsito/i })).toBeVisible();
    await expect(arbol(page)).toHaveCount(0);
    await expect(page.getByText('Bolsas', { exact: true })).toHaveCount(0);
  });
});
