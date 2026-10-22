// Ayuda FLITO — fichas de gestión publicadas (HU #11894, AC1–AC5).
// Las de Finanzas/Administración las publica HU #11895 (spec `flito-ayuda-fichas-finanzas.spec.ts`).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda,
  OPERACIONES_USER, PROVEEDOR_USER, GESTOR_IMPUESTOS_USER, MENSAJERO_USER, FINANCIERA_USER,
} from '../helpers/ayuda-fixtures';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

const SECCIONES = [
  'Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace',
] as const;

/**
 * Las 12 fichas de operación (HU #11894). Etiqueta = `catalogo.ts` = nombre del ítem del menú (P-33,
 * HU #13431). `flito_tablero` es desde P-11 el **Tablero** de General (ruta `/`), no un ítem de Gestión.
 */
const FICHAS_GESTION = [
  { clave: 'flito_tramites', etiqueta: 'Gestión Trámites', to: '/flito/tramites' },
  { clave: 'soat', etiqueta: 'SOAT', to: '/flito/soat' },
  { clave: 'flito_impuestos', etiqueta: 'Impuestos', to: '/flito/impuestos' },
  { clave: 'flito_derechos', etiqueta: 'Derechos', to: '/flito/derechos' },
  { clave: 'flito_revisiones', etiqueta: 'Revisiones OCR', to: '/flito/revisiones' },
  { clave: 'flito_tablero', etiqueta: 'Tablero', to: '/' },
  { clave: 'flito_bitacora', etiqueta: 'Bitácora', to: '/flito/bitacora' },
  { clave: 'flito_logistica', etiqueta: 'Logística', to: '/flito/logistica' },
  { clave: 'flito_logistica_ruta', etiqueta: 'Mi ruta', to: '/flito/ruta' },
  { clave: 'flito_comparendos', etiqueta: 'Comparendos', to: '/flito/comparendos' },
  { clave: 'clients', etiqueta: 'Clientes y proveedores', to: '/clients' },
] as const;

function leerFicha(clave: string): string {
  return readFileSync(resolve(raiz, `apps/web/src/content/ayuda/${clave}.md`), 'utf8');
}

function seccion(md: string, titulo: string): string {
  const re = new RegExp(`## ${titulo}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return md.match(re)?.[1] ?? '';
}

test.describe('FLITO — Ayuda · fichas de gestión (HU #11894)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-11894-01 AC1 — admin: las 12 de Gestión publicadas; Finanzas también (HU #11895)', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();

    for (const f of FICHAS_GESTION) {
      await expect(page.getByRole('link', { name: `Abrir ficha de ${f.etiqueta}` })).toBeVisible();
      await expect(page.getByRole('link', { name: `Ficha pendiente de ${f.etiqueta}` })).toHaveCount(0);
    }

    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);
  });

  test('TC-11894-02 AC1 — cada ficha de Gestión abre plantilla (6 h2), sin vacío pendiente; img solo demo con alt', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    for (const f of FICHAS_GESTION) {
      await page.goto(`/flito/ayuda/${f.clave}`);
      await expect(page.getByRole('heading', { name: f.etiqueta, exact: true })).toBeVisible();
      await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
      await expect(page.getByText(/no se pudo cargar esta ficha/i)).toHaveCount(0);
      const articulo = page.getByRole('article', { name: f.etiqueta });
      await expect(articulo).toBeVisible();
      for (const h of SECCIONES) {
        await expect(articulo.getByRole('heading', { name: h, exact: true })).toBeVisible();
      }
      // Desde la HU #13769 una ficha puede llevar capturas demo de su propia carpeta (la piloto,
      // `flito_logistica_ruta`, trae cinco). Lo que sigue prohibido: imagen sin alt o de otro origen.
      for (const img of await articulo.locator('img').all()) {
        expect((await img.getAttribute('alt'))?.trim(), `${f.clave} · alt`).toBeTruthy();
        expect(await img.getAttribute('src'), `${f.clave} · src`).toMatch(new RegExp(`^/ayuda/${f.clave}/[a-z0-9_-]+\\.(png|svg)(\\?v=[\\d.]+)?$`));
      }
      await expect(page.getByRole('link', { name: `Ir a la pantalla ${f.etiqueta}` })).toHaveAttribute('href', f.to);
    }
  });

  test('TC-11894-03 AC1 — artefactos: 12 .md con plantilla, usted, capturas solo demo con alt, sin endpoint/tabla', async () => {
    for (const f of FICHAS_GESTION) {
      const path = resolve(raiz, `apps/web/src/content/ayuda/${f.clave}.md`);
      expect(existsSync(path), path).toBe(true);
      const md = leerFicha(f.clave);
      for (const h of SECCIONES) {
        expect(md, `${f.clave} · ${h}`).toContain(`## ${h}`);
      }
      expect(md, `${f.clave} tono usted`).toMatch(/\busted\b/i);
      expect(md, `${f.clave} sin tú`).not.toMatch(/\btú\b/);
      // HU #13769: capturas permitidas solo con alt y desde la carpeta de la ficha (./<clave>/…).
      for (const [, alt, src] of md.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
        expect(alt.trim(), `${f.clave} · alt de ${src}`).not.toBe('');
        expect(src, `${f.clave} · src`).toMatch(new RegExp(`^\\./${f.clave}/[a-z0-9_-]+\\.(png|svg)$`));
      }
      expect(md).not.toMatch(/\/api\//);
      expect(md).not.toMatch(/\b(CREATE TABLE|FROM public\.|pg_)/i);
      expect(md).not.toMatch(/\|[-:]+\|/);
    }
  });

  test('TC-11894-04 AC1 — proveedor ve SOAT publicado (ya no es ficha pendiente)', async ({ page }) => {
    await abrirAyuda(page, PROVEEDOR_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de SOAT' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: 'Abrir ficha de SOAT' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/soat$/);
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
  });

  test('TC-11894-05 AC1 — mensajero ve Mi ruta publicada; financiera ve Clientes y Bolsas publicados', async ({ page }) => {
    await abrirAyuda(page, MENSAJERO_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Mi ruta' })).toBeVisible();
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);

    await abrirAyuda(page, FINANCIERA_USER);
    await expect(page.getByRole('link', { name: 'Abrir ficha de Clientes y proveedores' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Bolsas' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ficha pendiente de Bolsas' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);
  });

  test('TC-11894-06 AC2 — gestor de impuestos: Impuestos publicado; no SOAT, Comparendos, Clientes, Tablero, Compuerta', async ({ page }) => {
    await abrirAyuda(page, GESTOR_IMPUESTOS_USER);
    await expect(page.getByRole('heading', { name: 'Gestión', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Impuestos' })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);

    await expect(page.getByRole('link', { name: /SOAT/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Comparendos/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Clientes/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /ficha de Tablero/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Compuerta/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
  });

  test('TC-11894-07 AC2 — gestor: deep-link a SOAT es NoAccess, no la ficha publicada', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await page.goto('/flito/ayuda/soat');
    // El nombre de la página lo pone `PAGES[entrada.permiso]`, y desde el Feature #11912 esa ficha
    // cuelga de `flito_soat` («FLITO — SOAT») y no de la `soat` del módulo legacy: lo que se niega
    // sigue siendo lo mismo, solo que ahora la frase nombra la pantalla correcta.
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — soat/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toHaveCount(0);
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
  });

  test('TC-11894-08 AC3 — Tablero es el de General (P-11); «Entregar trámites» vive en Gestión Trámites, sin ficha Compuerta', async ({ page }) => {
    // HU #13431: el «Tablero FLITO» se absorbió en el Tablero de General (P-11). La ficha lleva al
    // ítem del menú y ya no a una pantalla aparte por dirección.
    const tablero = leerFicha('flito_tablero');
    const entraTablero = seccion(tablero, 'Cómo se entra');
    expect(entraTablero).toMatch(/sección \*\*General\*\*, ítem \*\*Tablero\*\*/);
    expect(entraTablero).not.toMatch(/\/flito\/tablero/);
    expect(entraTablero).not.toMatch(/NAV_ITEMS/);
    expect(tablero).not.toMatch(/Tablero FLITO/);
    // Épica 13411: «Para quién» se dice por permiso, no por nombre de rol.
    const paraQuien = seccion(tablero, 'Para quién');
    expect(paraQuien).toMatch(/ítem \*\*Tablero\*\*/);
    // La copia literal de la pantalla («Auditoría observa…») no es un nombre de rol.
    expect(paraQuien).not.toMatch(/(?<!\p{L})(Administrador|Auditor)(?!\p{L})/u);

    // HU #13431: «Entregar trámites» es una acción de Gestión Trámites; la ficha Compuerta se retiró.
    expect(existsSync(resolve(raiz, 'apps/web/src/content/ayuda/flito_compuerta.md'))).toBe(false);
    const tramites = leerFicha('flito_tramites');
    const entregar = seccion(tramites, 'Entregar trámites');
    expect(entregar).toMatch(/Listo para entregar/);
    expect(entregar).toMatch(/\busted\b/);
    expect(entregar).not.toMatch(/\/api\/|\/flito\/compuerta/);
    expect(tramites).not.toMatch(/Tablero FLITO/);

    const nav = readFileSync(resolve(raiz, 'apps/web/src/components/shell/navEntradas.ts'), 'utf8');
    expect(nav).not.toMatch(/page:\s*'flito_tablero'/);
    expect(nav).not.toMatch(/page:\s*'flito_compuerta'/);

    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/flito_tablero');
    const artTablero = page.getByRole('article', { name: 'Tablero' });
    await expect(artTablero.getByText('/flito/tablero')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Tablero' })).toHaveAttribute('href', '/');

    await page.goto('/flito/ayuda/flito_tramites');
    await expect(page.getByRole('article', { name: 'Gestión Trámites' }).getByRole('heading', { name: 'Entregar trámites', exact: true })).toBeVisible();

    // Clave retirada = clave fuera del catálogo: «Esta ficha no existe», con vuelta al índice.
    await page.goto('/flito/ayuda/flito_compuerta');
    await expect(page.getByText('Esta ficha no existe.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al índice' }).first()).toBeVisible();
  });

  test('TC-11894-09 AC4 — SOAT es la cola /flito/soat, no el legacy /soat', async ({ page }) => {
    const md = leerFicha('soat');
    expect(md).toMatch(/\/flito\/soat/);
    expect(md.replaceAll('/flito/soat', '')).not.toMatch(/\/soat\b/);
    expect(seccion(md, 'Cómo se entra')).toMatch(/\/flito\/soat/);

    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/ayuda/soat');
    await expect(page.getByRole('article', { name: 'SOAT' }).getByText('/flito/soat').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la pantalla SOAT' })).toHaveAttribute('href', '/flito/soat');
    await expect(page.getByRole('link', { name: 'Ir a la pantalla SOAT' })).not.toHaveAttribute('href', '/soat');
  });

  test('TC-11894-10 AC5 — con las 12 publicadas, la skill sigue exigiendo delta en PRs que cambien esas pantallas', async () => {
    for (const f of FICHAS_GESTION) {
      expect(existsSync(resolve(raiz, `apps/web/src/content/ayuda/${f.clave}.md`)), f.clave).toBe(true);
    }
    const skill = readFileSync(resolve(raiz, '.claude/skills/flit-ayuda-flito/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: flit-ayuda-flito\n/m);
    expect(skill).toMatch(/gate duro/i);
    expect(skill).toMatch(/no se abre el PR/i);
    expect(skill).toMatch(/\{slug\}\.md ya existe|con ficha/i);
    expect(skill).toMatch(/delta/);
  });
});
