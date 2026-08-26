// Ayuda FLITO — fichas de Finanzas y Administración publicadas (HU #11895, AC1–AC3).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda,
  OPERACIONES_USER, FINANCIERA_USER, AUDITOR_USER,
} from '../helpers/ayuda-fixtures';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

const SECCIONES = [
  'Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace',
] as const;

const FICHAS_FINANZAS = [
  { clave: 'flito_bolsas', etiqueta: 'Bolsas', to: '/flito/bolsas' },
  { clave: 'flito_conciliacion', etiqueta: 'Conciliación', to: '/flito/conciliacion' },
  { clave: 'finanzas_reporte_costos', etiqueta: 'Reporte de costos', to: '/finanzas/reporte-costos' },
  { clave: 'siigo_parametrizacion', etiqueta: 'Facturación electrónica · Parametrización', to: '/siigo/parametrizacion' },
  { clave: 'siigo_operacion', etiqueta: 'Facturación electrónica · Operación', to: '/siigo/operacion' },
] as const;

const FICHA_CREDENCIALES = {
  clave: 'siigo_credenciales',
  etiqueta: 'Facturación electrónica · Credenciales',
} as const;

function leerFicha(clave: string): string {
  return readFileSync(resolve(raiz, `apps/web/src/content/ayuda/${clave}.md`), 'utf8');
}

function seccion(md: string, titulo: string): string {
  const re = new RegExp(`## ${titulo}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return md.match(re)?.[1] ?? '';
}

test.describe('FLITO — Ayuda · fichas de finanzas (HU #11895)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-11895-01 AC1 — admin: las 6 de Finanzas/Admin publicadas; cero pendientes en el catálogo', async ({ page }) => {
    await abrirAyuda(page, OPERACIONES_USER);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toBeVisible();

    for (const f of FICHAS_FINANZAS) {
      await expect(page.getByRole('link', { name: `Abrir ficha de ${f.etiqueta}` })).toBeVisible();
      await expect(page.getByRole('link', { name: `Ficha pendiente de ${f.etiqueta}` })).toHaveCount(0);
    }
    await expect(page.getByRole('link', { name: `Abrir ficha de ${FICHA_CREDENCIALES.etiqueta}` })).toBeVisible();
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);
  });

  test('TC-11895-02 AC1 — cada ficha de Finanzas abre plantilla (6 h2), sin vacío pendiente ni img', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    for (const f of FICHAS_FINANZAS) {
      await page.goto(`/flito/ayuda/${f.clave}`);
      await expect(page.getByRole('heading', { name: f.etiqueta, exact: true })).toBeVisible();
      await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
      await expect(page.getByText(/no se pudo cargar esta ficha/i)).toHaveCount(0);
      const articulo = page.getByRole('article', { name: f.etiqueta });
      await expect(articulo).toBeVisible();
      for (const h of SECCIONES) {
        await expect(articulo.getByRole('heading', { name: h, exact: true })).toBeVisible();
      }
      await expect(articulo.locator('img')).toHaveCount(0);
      await expect(page.getByRole('link', { name: `Ir a la pantalla ${f.etiqueta}` })).toHaveAttribute('href', f.to);
    }
  });

  test('TC-11895-03 AC1 — Credenciales publicada; sin Ir a la pantalla; no inventa menú ni UI', async ({ page }) => {
    const md = leerFicha(FICHA_CREDENCIALES.clave);
    const entra = seccion(md, 'Cómo se entra');
    expect(entra).toMatch(/solo Administración|Administración/i);
    expect(entra).not.toMatch(/NAV_ITEMS/);
    expect(entra).not.toMatch(/en el menú.{0,80}Credenciales/i);
    expect(entra).toMatch(/no está publicada|no hay un destino de producto/i);
    expect(md).toMatch(/\/rndc\/admin\/credenciales/);
    expect(md).not.toMatch(/\/siigo\/credenciales/);

    const nav = readFileSync(resolve(raiz, 'apps/web/src/components/shell/navItems.ts'), 'utf8');
    expect(nav).not.toMatch(/page:\s*'siigo_credenciales'/);
    expect(nav).not.toMatch(/to:\s*'\/siigo\/credenciales'/);

    await loginAs(page, OPERACIONES_USER);
    await page.goto(`/flito/ayuda/${FICHA_CREDENCIALES.clave}`);
    await expect(page.getByRole('heading', { name: FICHA_CREDENCIALES.etiqueta, exact: true })).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    const articulo = page.getByRole('article', { name: FICHA_CREDENCIALES.etiqueta });
    await expect(articulo).toBeVisible();
    for (const h of SECCIONES) {
      await expect(articulo.getByRole('heading', { name: h, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: /Ir a la pantalla/ })).toHaveCount(0);
    await expect(articulo.getByText('/rndc/admin/credenciales').first()).toBeVisible();
  });

  test('TC-11895-04 AC1 — artefactos: 6 .md con plantilla, usted, Facturar ≠ emisión, sin captura/endpoint/tabla', () => {
    const claves = [...FICHAS_FINANZAS.map((f) => f.clave), FICHA_CREDENCIALES.clave];
    for (const clave of claves) {
      const path = resolve(raiz, `apps/web/src/content/ayuda/${clave}.md`);
      expect(existsSync(path), path).toBe(true);
      const md = leerFicha(clave);
      for (const h of SECCIONES) {
        expect(md, `${clave} · ${h}`).toContain(`## ${h}`);
      }
      expect(md, `${clave} tono usted`).toMatch(/\busted\b/i);
      expect(md, `${clave} sin tú`).not.toMatch(/\btú\b/);
      expect(md).not.toMatch(/!\[[^\]]*\]\(/);
      expect(md).not.toMatch(/\/api\//);
      expect(md).not.toMatch(/\b(CREATE TABLE|FROM public\.|pg_)/i);
      expect(md).not.toMatch(/\|[-:]+\|/);
    }
    const costos = leerFicha('finanzas_reporte_costos');
    expect(costos, 'Facturar ≠ emitir (sinónimo tumba este aserto)').toMatch(
      /\*\*Facturar\*\*[^\n]{0,80}no es emitir/i,
    );
    expect(costos).toMatch(/emisión electrónica/i);
    expect(costos).not.toMatch(/Facturar es (la )?emisión electrónica/i);
    const operacion = leerFicha('siigo_operacion');
    expect(operacion).toMatch(/emisión electrónica/i);
    expect(operacion).toMatch(/Facturar/);
    expect(operacion).not.toMatch(/Facturar es (la )?emisión electrónica/i);
  });

  test('TC-11895-05 AC2 — financiera ve Bolsas, Conciliación, costos, Parametrización, Operación; no Credenciales', async ({ page }) => {
    await abrirAyuda(page, FINANCIERA_USER);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    for (const f of FICHAS_FINANZAS) {
      await expect(page.getByRole('link', { name: `Abrir ficha de ${f.etiqueta}` })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
    await expect(page.getByText('Ficha pendiente')).toHaveCount(0);
  });

  test('TC-11895-06 AC2 — financiera: deep-link a Credenciales es NoAccess, no la ficha', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda/siigo_credenciales');
    await expect(page.getByRole('heading', { name: /no tienes acceso a facturación electrónica · credenciales/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toHaveCount(0);
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
  });

  test('TC-11895-07 AC2 — auditor ve costos, Parametrización y Operación; no Bolsas, Conciliación ni Credenciales', async ({ page }) => {
    await abrirAyuda(page, AUDITOR_USER);
    await expect(page.getByRole('heading', { name: 'Finanzas', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Reporte de costos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Facturación electrónica · Parametrización' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir ficha de Facturación electrónica · Operación' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Bolsas/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Conciliación/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Credenciales/ })).toHaveCount(0);
  });

  test('TC-11895-08 AC2 — auditor: deep-link a Bolsas es NoAccess', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — bolsas/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toHaveCount(0);
  });

  test('TC-11895-09 AC3 — skill ancla Finanzas publicadas; no reescribe el gate', () => {
    const skill = readFileSync(resolve(raiz, '.claude/skills/flit-ayuda-flito/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: flit-ayuda-flito\n/m);
    expect(skill).toMatch(/gate duro/i);
    expect(skill).toMatch(/no se abre el PR/i);
    expect(skill).toMatch(/#11895|Finanzas y Administración/);
    expect(skill).toMatch(/siigo_credenciales/);
    expect(skill).not.toMatch(/Finanzas y Administración siguen pendientes/);
  });
});
