// HU #13765 — Dr. Flit: «Explícame un módulo» con resumen y enlace a la ficha (Feature #13694).
// Spec UX: docs/ux/flito-dr-flit.md · slim: docs/diseno/feature-13694-dr-flit-panel-slim.md
// Un test por AC. La ficha pendiente se simula sirviendo el módulo `?raw` de la ficha como `null`
// (exactamente lo que `leerFichaMd` devuelve sin archivo); hoy todas las entradas tienen `.md`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/ayuda-fixtures';
import { CATALOGO_AYUDA, GRUPOS_ORDEN } from '../../src/content/ayuda/catalogo';
import { parsearFicha } from '../../src/lib/ayudaFicha';
import { explicacionDeModulo } from '../../src/lib/drFlitConversacion';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/content/ayuda');
const fichaTramites = parsearFicha(readFileSync(resolve(raiz, 'flito_tramites.md'), 'utf8'));
const RESUMEN_TRAMITES = fichaTramites.encabezado?.resumen ?? '';
const MD_TRAMITES = /\/src\/content\/ayuda\/flito_tramites\.md\?/;
const ORDEN_INDICE = GRUPOS_ORDEN.flatMap((g) => CATALOGO_AYUDA.filter((c) => c.grupo === g).map((c) => c.etiqueta));

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const lista = (page: Page) => panel(page).getByRole('group', { name: '¿Qué módulo quiere conocer?' });

// Por defecto el rol financiera no ve Gestión Trámites; el AC2 parte de una financiera que sí lo tiene
// habilitado (permiso por usuario), sin «Integración con Siigo».
const FINANCIERA_CON_TRAMITES = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'] };

async function abrirLista(page: Page, user: Parameters<typeof loginAs>[1] = FINANCIERA_CON_TRAMITES) {
  await loginAs(page, user);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
  await conversacion(page).getByRole('button', { name: 'Explícame un módulo' }).click();
  await expect(lista(page)).toBeVisible();
}

test.describe('HU #13765 · Dr. Flit — Explícame un módulo', () => {
  test('AC1 · financiera ve SUS módulos con ficha, en el orden del índice, sin «Integración con Siigo»', async ({ page }) => {
    const pedidas: string[] = [];
    page.on('request', (r) => pedidas.push(r.url()));
    await abrirLista(page, FINANCIERA_USER);
    const nombres = (await lista(page).getByRole('listitem').getByRole('button').allInnerTexts()).map((t) => t.trim());
    expect(nombres).toContain('Conciliación');
    expect(nombres).not.toContain('Integración con Siigo');
    // Subsecuencia exacta del índice de la Ayuda (grupo del menú y, dentro, orden del catálogo).
    expect(nombres).toEqual(ORDEN_INDICE.filter((e) => nombres.includes(e)));
    // Regla transversal: abrir la lista no descarga fichas, y nunca la de un módulo sin permiso.
    expect(pedidas.some((u) => /siigo_credenciales\.md/.test(u))).toBe(false);
    // Cancelar la quita sin dejar rastro en la conversación.
    await lista(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(lista(page)).toHaveCount(0);
    await expect(conversacion(page).getByText(/^Explíqueme/)).toHaveCount(0);
  });

  test('AC2 · elegir «Gestión Trámites» muestra la elección y el resumen con «Abrir la ficha»', async ({ page }) => {
    expect(RESUMEN_TRAMITES.length).toBeGreaterThan(0);
    await abrirLista(page);
    await lista(page).getByRole('button', { name: 'Gestión Trámites', exact: true }).click();
    await expect(lista(page)).toHaveCount(0);
    await expect(conversacion(page).getByText('Explíqueme Gestión Trámites')).toBeVisible();
    await expect(conversacion(page).getByText(RESUMEN_TRAMITES)).toBeVisible();
    const enlace = conversacion(page).getByRole('link', { name: 'Abrir la ficha de Gestión Trámites' });
    await expect(enlace).toHaveAttribute('href', '/flito/ayuda/flito_tramites');
    await expect(conversacion(page).getByText('Su ficha está pendiente.')).toHaveCount(0);
  });

  test('AC3 · ficha pendiente: resumen del catálogo y «Su ficha está pendiente», sin enlace', async ({ page }) => {
    // Puro: una entrada sin archivo usa `resumenPendiente` y no enlaza.
    const entrada = { ...CATALOGO_AYUDA.find((c) => c.clave === 'flito_tramites')!, resumenPendiente: 'Resumen del catálogo.' };
    expect(explicacionDeModulo(entrada, null)).toEqual({ etiqueta: 'Gestión Trámites', resumen: 'Resumen del catálogo.', href: null });
    expect(explicacionDeModulo(entrada, fichaTramites).href).toBe('/flito/ayuda/flito_tramites');

    // UI: el módulo de la ficha responde «sin archivo» (`null`).
    await page.route(MD_TRAMITES, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default null;' }));
    await abrirLista(page);
    await lista(page).getByRole('button', { name: 'Gestión Trámites', exact: true }).click();
    await expect(conversacion(page).getByText('Su ficha está pendiente.')).toBeVisible();
    await expect(conversacion(page).getByText('Ficha pendiente', { exact: true })).toBeVisible();
    await expect(conversacion(page).getByRole('link', { name: /Abrir la ficha/ })).toHaveCount(0);
  });

  test('AC4 · la ficha tarda («Dr. Flit está buscando…») y falla: error con «Reintentar» sin cerrar el panel', async ({ page }) => {
    let liberar!: () => void;
    const retenido = new Promise<void>((r) => { liberar = r; });
    let fallar = true;
    await page.route(MD_TRAMITES, async (route: Route) => {
      if (!fallar) return route.continue();
      await retenido;
      return route.abort('failed');
    });
    await abrirLista(page);
    await lista(page).getByRole('button', { name: 'Gestión Trámites', exact: true }).click();
    // Anunciado por el `log` (aria-live="polite").
    await expect(conversacion(page)).toHaveAttribute('aria-live', 'polite');
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toBeVisible();
    liberar();
    await expect(conversacion(page).getByText('No pude cargar la ficha de Gestión Trámites.')).toBeVisible();
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();

    fallar = false;
    await conversacion(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(conversacion(page).getByText(RESUMEN_TRAMITES)).toBeVisible();
    await expect(conversacion(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    // Reintentar repite la misma elección sin duplicar el mensaje del usuario.
    await expect(conversacion(page).getByText('Explíqueme Gestión Trámites')).toHaveCount(1);
    await expect(panel(page)).toBeVisible();
  });

  test('AC5 · cada módulo es un botón con su nombre, foco visible y contraste ≥4.5:1; la respuesta no saca el foco', async ({ page }) => {
    await abrirLista(page);
    const boton = lista(page).getByRole('button', { name: 'Gestión Trámites', exact: true });
    await expect(boton).toHaveText('Gestión Trámites');
    await boton.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(boton).toBeFocused();
    const estilo = await boton.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      let fondo = 'rgba(0, 0, 0, 0)';
      for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const a = rgb(bg)[3];
        if (bg !== 'transparent' && (a === undefined || a > 0)) { fondo = bg; break; }
      }
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const [l1, l2] = [lum(rgb(cs.color)), lum(rgb(fondo))].sort((a, b) => b - a);
      return { foco: cs.outlineStyle !== 'none' || cs.boxShadow !== 'none', contraste: (l1 + 0.05) / (l2 + 0.05) };
    });
    expect(estilo.foco).toBe(true);
    expect(estilo.contraste).toBeGreaterThanOrEqual(4.5);

    await page.keyboard.press('Enter');
    await expect(conversacion(page).getByText(RESUMEN_TRAMITES)).toBeVisible();
    // El foco sigue dentro del panel (no cae al body ni salta a la página).
    expect(await panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });
});
