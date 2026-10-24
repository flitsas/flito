// Ayuda FLITO — avisos destacados y «Aplica para» en la ficha (Feature #13691 · HU #13706).
// Unidad pura (parser `callout`/`quote`, `rolesPorDefectoDePagina` contra la matriz real) y UI de
// AC1 (rótulos en texto + contraste medido en píxel, claro y oscuro), AC2 y AC3 («Reporte de costos»).
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  PAGES, ROLE_LABELS, USER_ROLES, paginasPorDefecto, type PageSlug,
} from '@operaciones/shared-types';
import { parseMarkdown } from '../../src/lib/ayudaMarkdown';
import { rolesPorDefectoDePagina } from '../../src/lib/ayudaFlito';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { contraste, fondoPintado, tintaEfectiva } from '../helpers/pixeles';
import { loginAs, ADMIN_USER, FINANCIERA_USER } from '../helpers/ayuda-fixtures';

const ENCABEZADO = [
  '---',
  'resumen: Ficha de prueba de avisos.',
  'palabras_clave:',
  '  - prueba',
  'consultas:',
  '  - cómo se ven los avisos',
  'version: 1.0',
  'fecha: 2026-10-20',
  '---',
].join('\n');

const FICHA_AVISOS = `${ENCABEZADO}
## Qué es

Ficha de prueba con los tres avisos.

> [!NOTA]
> El filtro se conserva al volver.

> [!IMPORTANTE]
> Guarde antes de cambiar de pestaña.

> [!PRECAUCION]
> Al anular, el comprobante no se recupera.

> Una cita normal.

> [!OTRO] Tipo desconocido <b>sin html</b>.

## Pasos

1. Abrir la pantalla.
`;

/** Sustituye el `.md` (servido por Vite como módulo `?raw`) de una ficha por `md`. */
async function servirFicha(page: Page, clave: string, md: string) {
  await page.route(`**/content/ayuda/${clave}.md**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `export default ${JSON.stringify(md)};`,
  }));
}

const CLAVE = 'finanzas_reporte_costos';

test.describe('FLITO — Ayuda · avisos y «Aplica para», unidad pura (HU #13706)', () => {
  test('AC1 — parser: los tres tipos producen `callout` con su cuerpo', () => {
    const ast = parseMarkdown('> [!NOTA]\n> Uno **dos**.\n\n> [!IMPORTANTE] En línea.\n\n> [!PRECAUCION]\n> A\n>\n> B');
    expect(ast.map((b) => b.type)).toEqual(['callout', 'callout', 'callout']);
    expect(ast.map((b) => (b.type === 'callout' ? b.tipo : ''))).toEqual(['nota', 'importante', 'precaucion']);
    const [nota, importante, precaucion] = ast;
    expect(nota.type === 'callout' && nota.parrafos).toEqual([[{ type: 'text', value: 'Uno ' }, { type: 'strong', children: [{ type: 'text', value: 'dos' }] }, { type: 'text', value: '.' }]]);
    expect(importante.type === 'callout' && importante.parrafos).toEqual([[{ type: 'text', value: 'En línea.' }]]);
    // Una línea `>` vacía separa párrafos dentro del aviso.
    expect(precaucion.type === 'callout' && precaucion.parrafos.length).toBe(2);
  });

  test('AC2 — `> texto` y `> [!OTRO]` → cita simple con el texto tal cual; nunca nodo HTML', () => {
    const ast = parseMarkdown('> Una cita.\n\n> [!OTRO] x <b>y</b>\n\nPárrafo.');
    expect(ast.map((b) => b.type)).toEqual(['quote', 'quote', 'p']);
    expect(ast[0]).toEqual({ type: 'quote', parrafos: [[{ type: 'text', value: 'Una cita.' }]] });
    expect(ast[1]).toEqual({ type: 'quote', parrafos: [[{ type: 'text', value: '[!OTRO] x <b>y</b>' }]] });
    // El tipo solo cuenta en la 1.ª línea del bloque; en minúsculas o en medio, es cita.
    expect(parseMarkdown('> [!nota] x')[0].type).toBe('quote');
    expect(parseMarkdown('> hola\n> [!NOTA] x')[0].type).toBe('quote');
    // Un párrafo corta en la línea `>` siguiente sin tragársela.
    expect(parseMarkdown('Texto\n> [!NOTA] x').map((b) => b.type)).toEqual(['p', 'callout']);
  });

  test('AC3 — rolesPorDefectoDePagina: admin primero, luego la matriz por defecto en orden de USER_ROLES', () => {
    const slugs = Object.keys(PAGES) as PageSlug[];
    for (const slug of slugs) {
      const roles = rolesPorDefectoDePagina(slug);
      expect(roles[0], slug).toBe('admin');
      expect(roles as string[], slug).not.toContain('operaciones');
      // HU #13914: los roles de enlace (cliente, proveedor) ya no se excluyen.
      const esperado = USER_ROLES.filter((r) => r !== 'admin' && paginasPorDefecto(r).includes(slug));
      expect(roles.slice(1), slug).toEqual(esperado);
    }
    // Ancla con datos reales: Financiera tiene el reporte de costos por defecto; Cliente y Proveedor
    // tienen `flito_soat` por defecto y salen en «Aplica para» de SOAT (HU #13914 AC7), en el orden de
    // `USER_ROLES` y con Admin primero.
    expect(rolesPorDefectoDePagina('finanzas_reporte_costos')).toContain('financiera');
    expect(paginasPorDefecto('proveedor')).toContain('flito_soat');
    const soat = rolesPorDefectoDePagina('flito_soat');
    expect(soat[0]).toBe('admin');
    expect(soat).toContain('cliente');
    expect(soat).toContain('proveedor');
    expect(soat).toEqual(USER_ROLES.filter((r) => soat.includes(r)));
  });
});

test.describe('FLITO — Ayuda · avisos y «Aplica para» en la ficha (HU #13706)', () => {
  test('AC1/AC2 — los tres avisos con rótulo en texto, como nota y fuera de la TOC; cita sin HTML', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, FINANCIERA_USER);
    await servirFicha(page, CLAVE, FICHA_AVISOS);
    await page.goto(`/flito/ayuda/${CLAVE}`);
    const notas = page.getByRole('note');
    await expect(notas).toHaveCount(3);
    await expect(page.getByRole('note', { name: 'Nota' })).toContainText('Nota');
    await expect(page.getByRole('note', { name: 'Nota' })).toContainText('El filtro se conserva al volver.');
    await expect(page.getByRole('note', { name: 'Importante' })).toContainText('Importante');
    await expect(page.getByRole('note', { name: 'Precaución' })).toContainText('Precaución');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // El rótulo no es encabezado: la TOC solo trae las secciones.
    await expect(page.getByRole('navigation', { name: 'Contenido de la ficha' }).getByRole('link'))
      .toHaveText(['Qué es', 'Pasos']);
    const citas = page.locator('[data-ayuda-cuerpo] blockquote');
    await expect(citas).toHaveCount(2);
    await expect(citas.nth(0)).toHaveText('Una cita normal.');
    await expect(citas.nth(1)).toHaveText('[!OTRO] Tipo desconocido <b>sin html</b>.');
    await expect(page.locator('[data-ayuda-cuerpo] b')).toHaveCount(0);
    esperarSinViolacionesGraves(await correrAxe(page), 'ficha con avisos y Aplica para');
  });

  for (const tema of ['light', 'dark'] as const) {
    test(`AC1 — contraste ≥ 4.5:1 de rótulo y cuerpo de los avisos (tema ${tema}, medido en píxel)`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.addInitScript((t) => localStorage.setItem('aura-theme', t), tema);
      await loginAs(page, FINANCIERA_USER);
      await servirFicha(page, CLAVE, FICHA_AVISOS);
      await page.goto(`/flito/ayuda/${CLAVE}`);
      await expect(page.getByRole('note')).toHaveCount(3);
      await page.mouse.move(0, 0);
      for (const tipo of ['nota', 'importante', 'precaucion']) {
        const aviso = page.getByTestId(`ayuda-aviso-${tipo}`);
        await aviso.scrollIntoViewIfNeeded();
        const { color: fondo } = await fondoPintado(page, aviso);
        for (const t of [aviso.locator('strong'), aviso.locator('p').last()]) {
          const ratio = contraste(await tintaEfectiva(t, fondo), fondo);
          expect(ratio, `${tipo} · ${await t.innerText()}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  for (const [nombre, user] of [['Financiera', FINANCIERA_USER], ['Administrador', ADMIN_USER]] as const) {
    test(`AC3 — «Reporte de costos» (${nombre}): «Aplica para» calculado de la matriz, Administrador primero`, async ({ page }) => {
      await loginAs(page, user);
      await servirFicha(page, CLAVE, FICHA_AVISOS);
      await page.goto(`/flito/ayuda/${CLAVE}`);
      const etiquetas = rolesPorDefectoDePagina('finanzas_reporte_costos').map((r) => ROLE_LABELS[r]);
      const lista = etiquetas.length === 1
        ? etiquetas[0]
        : `${etiquetas.slice(0, -1).join(', ')} y ${etiquetas[etiquetas.length - 1]}`;
      const pie = page.getByTestId('ayuda-aplica-para');
      await expect(pie).toHaveText(
        `Aplica para: Por defecto ${lista}. También quien tenga permiso a la pantalla Reporte de costos.`,
      );
      await expect(pie).toContainText(/^Aplica para: Por defecto Administrador, /);
      await expect(pie).toContainText('Financiera');
      await expect(pie).not.toContainText(/Operaciones|Cliente|Proveedor/);
    });
  }

  test('AC3 — ficha que no se llena (error de carga): sin «Aplica para»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.route(`**/content/ayuda/${CLAVE}.md**`, (route) => route.fulfill({
      status: 404, contentType: 'text/plain', body: '',
    }));
    await page.goto(`/flito/ayuda/${CLAVE}`);
    await expect(page.getByText('No se pudo cargar esta ficha.')).toBeVisible();
    await expect(page.getByTestId('ayuda-aplica-para')).toHaveCount(0);
  });
});
