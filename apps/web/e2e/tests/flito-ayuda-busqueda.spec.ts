// Ayuda FLITO — búsqueda por relevancia y vacíos diferenciados (Feature #13691 · HU #13704).
// Dos bloques: la prueba por ficha (sin navegador: importa el ranking puro desde `src` y lee los
// `.md` con fs) y la prueba de UI del orden, la etiqueta de grupo (P9-1a) y los vacíos (P9-3a).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { CATALOGO_AYUDA } from '../../src/content/ayuda/catalogo';
import { parsearFicha } from '../../src/lib/ayudaFicha';
import { documentoDeEntrada, ordenarPorRelevancia, type DocumentoAyuda } from '../../src/lib/ayudaBusqueda';
import {
  loginAs, abrirAyuda, buscarFichas, FINANCIERA_USER, OPERACIONES_USER,
} from '../helpers/ayuda-fixtures';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const dirFichas = resolve(raiz, 'apps/web/src/content/ayuda');

// Mismo orden que el índice: grupo (orden del menú) y, dentro, el del catálogo.
const GRUPOS = ['general', 'gestion', 'finanzas', 'administracion'] as const;
const DOCS = GRUPOS.flatMap((g) => CATALOGO_AYUDA.filter((e) => e.grupo === g)).map((entrada) => {
  const ruta = resolve(dirFichas, `${entrada.clave}.md`);
  const ficha = existsSync(ruta) ? parsearFicha(readFileSync(ruta, 'utf8')) : null;
  return { ...documentoDeEntrada(entrada, ficha), conArchivo: ficha != null };
});

function doc(clave: string, parcial: Partial<DocumentoAyuda>): DocumentoAyuda {
  return { clave, titulo: clave, palabrasClave: [], consultas: [], resumen: '', cuerpo: '', ...parcial };
}

test.describe('FLITO — Ayuda · ranking por ficha (HU #13704 AC4)', () => {
  const conArchivo = DOCS.filter((d) => d.conArchivo);

  test('hay fichas con archivo que probar', () => {
    expect(conArchivo.length).toBeGreaterThanOrEqual(22);
  });

  for (const d of conArchivo) {
    test(`${d.clave} — primera al buscar «${d.titulo}» y presente en cada una de sus consultas`, () => {
      expect(ordenarPorRelevancia(DOCS, d.titulo)[0]?.clave).toBe(d.clave);
      expect(d.consultas.length, 'declara consultas').toBeGreaterThan(0);
      for (const consulta of d.consultas) {
        const claves = ordenarPorRelevancia(DOCS, consulta).map((r) => r.clave);
        expect(claves, `«${consulta}»`).toContain(d.clave);
      }
    });
  }
});

test.describe('FLITO — Ayuda · ordenarPorRelevancia (HU #13704)', () => {
  test('AC1 — título y palabras clave pesan más que el cuerpo (aunque la del cuerpo vaya antes)', () => {
    const soloCuerpo = doc('b', { titulo: 'Bolsas', cuerpo: 'Se cruza con la conciliación del mes. conciliación conciliación' });
    const enClave = doc('c', { titulo: 'Comprobantes', palabrasClave: ['conciliación'] });
    const enTitulo = doc('a', { titulo: 'Conciliación' });
    expect(ordenarPorRelevancia([soloCuerpo, enClave, enTitulo], 'conciliación').map((r) => r.clave)).toEqual(['a', 'c', 'b']);
    // Con el catálogo real: la ficha que se llama así va primera.
    expect(ordenarPorRelevancia(DOCS, 'conciliación')[0].clave).toBe('flito_conciliacion');
  });

  test('AC4 — título igual a la consulta va primero aunque otra ficha sume más señales en el resto', () => {
    // Sin el +100 de título igual: «Bolsas» suma 38 y «Bolsas de trabajo» 47 (diseño slim §3).
    const igual = doc('a', { titulo: 'Bolsas' });
    const masSenales = doc('b', {
      titulo: 'Bolsas de trabajo',
      palabrasClave: ['bolsas'],
      consultas: ['cómo crear bolsas'],
      resumen: 'Bolsas del mes.',
      cuerpo: 'Las bolsas se cruzan.',
    });
    expect(ordenarPorRelevancia([masSenales, igual], 'Bolsas').map((r) => r.clave)).toEqual(['a', 'b']);
  });

  test('AC2 — sin tildes ni mayúsculas: «GESTION tramites» → «Gestión Trámites» primera', () => {
    expect(ordenarPorRelevancia(DOCS, 'GESTION tramites')[0].titulo).toBe('Gestión Trámites');
    expect(ordenarPorRelevancia(DOCS, 'facturacion electronica · operacion')[0].clave).toBe('siigo_operacion');
  });

  test('todas las palabras deben coincidir; vacía = mismo orden; no muta', () => {
    const docs = [doc('x', { titulo: 'Uno', cuerpo: 'alfa' }), doc('y', { titulo: 'Dos', cuerpo: 'alfa beta' })];
    const copia = [...docs];
    expect(ordenarPorRelevancia(docs, 'alfa beta').map((r) => r.clave)).toEqual(['y']);
    expect(ordenarPorRelevancia(docs, '   ').map((r) => r.clave)).toEqual(['x', 'y']);
    expect(ordenarPorRelevancia(docs, 'alfa').map((r) => r.clave)).toEqual(['x', 'y']);
    expect(ordenarPorRelevancia(DOCS, 'xyzzy')).toEqual([]);
    expect(docs).toEqual(copia);
  });
});

const COPY_SIN_MODULOS = 'Su usuario aún no tiene módulos con ayuda';

function campo(page: Page) {
  return page.getByRole('searchbox', { name: 'Buscar fichas' });
}
function resultados(page: Page) {
  return page.getByRole('list', { name: 'Resultados de la búsqueda' });
}

test.describe('FLITO — Ayuda · búsqueda por relevancia en la UI (HU #13704)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('AC1/AC3 — lista única con el grupo en cada fila; limpiar vuelve al índice agrupado', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await expect(page.getByRole('navigation', { name: 'Fichas de ayuda' })).toBeVisible();
    await buscarFichas(page, 'conciliación');
    const lista = resultados(page);
    await expect(lista).toBeVisible();
    await expect(lista.getByRole('link').first()).toHaveAccessibleName('Abrir ficha de Conciliación, Finanzas');
    await expect(lista.getByTestId('ayuda-fila-grupo').first()).toHaveText('Finanzas');
    const n = await lista.getByRole('link').count();
    await expect(lista.getByTestId('ayuda-fila-grupo')).toHaveCount(n);
    await expect(page.getByRole('navigation', { name: 'Fichas de ayuda' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: n === 1 ? '1 ficha coincide con "conciliación"' : `${n} fichas coinciden con "conciliación"` })).toBeVisible();

    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
    await expect(resultados(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Fichas de ayuda' })).toBeVisible();
    await expect(page.locator('section[aria-labelledby]').first()).toHaveAttribute('aria-labelledby', 'ayuda-grupo-general');
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('AC2 — «GESTION tramites» deja «Gestión Trámites» primera', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarFichas(page, 'GESTION tramites');
    await expect(resultados(page).getByRole('link').first()).toHaveAccessibleName('Abrir ficha de Gestión Trámites, Gestión');
  });

  test('AC5 — financiera: «credenciales siigo» no trae «Integración con Siigo»', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await buscarFichas(page, 'credenciales siigo');
    await expect(page.getByRole('status').filter({ hasText: /coincide/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Integración con Siigo/ })).toHaveCount(0);
  });

  test('AC6 — «xyzzy»: sin coincidencias anunciado; Limpiar búsqueda vacía y devuelve el foco', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarFichas(page, 'xyzzy');
    const region = page.getByRole('status').filter({ hasText: 'Ninguna ficha coincide con "xyzzy"' });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(resultados(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
    await expect(campo(page)).toHaveValue('');
    await expect(campo(page)).toBeFocused();
    await expect(page.getByText(/Ninguna ficha coincide/)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Fichas de ayuda' })).toBeVisible();
  });

  test('AC7 — sin fichas visibles por URL directa: vacío con enlace al inicio; ítem del menú oculto', async ({ page }) => {
    // HU #13775: el conductor ya tiene ficha («Tablero de control», por `dashboard`). Sin fichas queda un rol creado
    // por el administrador sin `dashboard`; se entra directo a la Ayuda (su inicio sería otra pantalla).
    await loginAs(page, { id: 25, username: 'e2e_ayuda_rol_propio', name: 'Rol propio Ayuda E2E', role: 'rol_propio_e2e', allowedPages: ['pesv'] });
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: COPY_SIN_MODULOS })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
    await expect(campo(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /no tienes acceso/i })).toHaveCount(0);
  });

  test('AC8 — error de carga: copy sin texto técnico; Reintentar con éxito llena el índice', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let fallar = true;
    await page.route('**/content/ayuda/_plantilla.md**', (route) => (fallar ? route.abort('failed') : route.continue()));
    await page.goto('/flito/ayuda');
    const alerta = page.getByRole('alert');
    await expect(alerta.getByRole('heading', { name: 'No se pudo cargar el índice de ayuda.' })).toBeVisible();
    await expect(alerta).toContainText('Revise su conexión y vuelva a intentarlo.');
    await expect(alerta).not.toContainText(/fetch|module|import|error:|http/i);
    await expect(campo(page)).toHaveCount(0);

    fallar = false;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(campo(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('AC9 — esqueleto de carga sin campo; label «Buscar fichas» asociado y foco visible', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.route('**/content/ayuda/**', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('status', { name: /cargando/i })).toBeVisible();
    await expect(campo(page)).toHaveCount(0);
    await expect(page.getByLabel('Buscar fichas')).toBeVisible();
    await expect(campo(page)).toHaveAttribute('type', 'search');
    await expect(campo(page)).toHaveAttribute('maxlength', '100');
    await page.keyboard.press('Tab');
    await campo(page).focus();
    await expect(campo(page)).toBeFocused();
    const outline = await campo(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle} ${s.boxShadow}`;
    });
    expect(outline).not.toBe('none none');
  });

  test('AC9 — en 375 px la barra envuelve: Limpiar búsqueda bajo el campo, sin desborde', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await abrirAyuda(page, OPERACIONES_USER);
    await buscarFichas(page, 'conciliación');
    const limpiar = page.getByRole('button', { name: 'Limpiar búsqueda' });
    await expect(limpiar).toBeVisible();
    const cajaCampo = await campo(page).boundingBox();
    const cajaBoton = await limpiar.boundingBox();
    expect(cajaBoton!.y).toBeGreaterThanOrEqual(cajaCampo!.y + cajaCampo!.height);
    const derecha = await page.evaluate(() => {
      const r = document.querySelector('ol[aria-label="Resultados de la búsqueda"]');
      if (!r) return 0;
      return Math.max(...[r, ...Array.from(r.querySelectorAll('*'))].map((el) => el.getBoundingClientRect().right));
    });
    expect(derecha).toBeLessThanOrEqual(375);
  });
});
