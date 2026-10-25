// HU #13766 — Dr. Flit: «Tengo una pregunta» con secciones citadas de los manuales (Feature #13694).
// Spec UX: docs/ux/flito-dr-flit.md · slim: docs/diseno/feature-13694-dr-flit-panel-slim.md §3
// Un test por AC. La parte pura importa `buscarSecciones` desde `src` y lee los `.md` con fs (como
// `flito-ayuda-busqueda.spec.ts`); la UI recorre el panel real.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER as FINANCIERA_REPARTO } from '../helpers/ayuda-fixtures';
import { conDrFlit } from '../helpers/auth';

import { CATALOGO_AYUDA, type EntradaAyuda } from '../../src/content/ayuda/catalogo';
import { parsearFicha } from '../../src/lib/ayudaFicha';
import { capitulosEnOrdenDeIndice } from '../../src/lib/ayudaFlito';
import { anclaExiste, buscarSecciones, seccionesDeFicha } from '../../src/lib/drFlitBusqueda';

// HU #13942: el reparto inicial solo da «Ver los manuales»; estos casos prueban el panel completo.
const FINANCIERA_USER = conDrFlit(FINANCIERA_REPARTO);

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../src/content/ayuda');
const leer = (clave: string) => {
  const ruta = resolve(raiz, `${clave}.md`);
  return existsSync(ruta) ? parsearFicha(readFileSync(ruta, 'utf8')) : null;
};
/** Fichas visibles de un usuario en el orden del índice (lo que el panel pasa a `buscarSecciones`). */
const fichasDe = (user: Parameters<typeof capitulosEnOrdenDeIndice>[0]) =>
  capitulosEnOrdenDeIndice(user).map((entrada) => ({ entrada, ficha: leer(entrada.clave) }));

const MD_TRAMITES = /\/src\/content\/ayuda\/flito_tramites\.md\?/;
const MD_CUALQUIERA = /\/src\/content\/ayuda\/[a-z0-9_]+\.md\?/;
const MD_SIIGO_CRED = /siigo_credenciales\.md/;

// Financiera con Gestión Trámites habilitado por usuario y sin «Integración con Siigo».
const FINANCIERA_CON_TRAMITES = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'] };

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');
const enviar = (page: Page) => panel(page).getByRole('button', { name: 'Enviar' });

async function abrirPanel(page: Page, user: Parameters<typeof loginAs>[1] = FINANCIERA_CON_TRAMITES) {
  await loginAs(page, user);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
}

async function preguntar(page: Page, texto: string) {
  await caja(page).fill(texto);
  await caja(page).press('Enter');
}

test.describe('HU #13766 · Dr. Flit — Tengo una pregunta', () => {
  test('AC1 · «¿cómo se entra a trámites?» → ≤3 citas y la primera es «Cómo se entra» de trámites', async ({ page }) => {
    const citas = buscarSecciones(fichasDe(FINANCIERA_CON_TRAMITES), '¿cómo se entra a trámites?');
    expect(citas.length).toBeGreaterThan(0);
    expect(citas.length).toBeLessThanOrEqual(3);
    expect(citas[0]).toEqual({
      clave: 'flito_tramites', ancla: 'como-se-entra', tituloFicha: 'Gestión Trámites', tituloSeccion: 'Cómo se entra',
    });

    await abrirPanel(page);
    await conversacion(page).getByRole('button', { name: 'Tengo una pregunta' }).click();
    await expect(caja(page)).toBeFocused();
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText('¿cómo se entra a trámites?')).toBeVisible();
    await expect(conversacion(page).getByText('Esto es lo que encontré en sus manuales:')).toBeVisible();
    const enlaces = conversacion(page).getByRole('listitem').getByRole('link');
    expect(await enlaces.count()).toBeLessThanOrEqual(3);
    await expect(enlaces.first()).toHaveAttribute('href', '/flito/ayuda/flito_tramites#como-se-entra');
    await expect(enlaces.first()).toContainText('Gestión Trámites');
    await expect(enlaces.first()).toContainText('Cómo se entra');
  });

  test('AC2 · encabezado repetido → la cita al segundo enlaza a «-2» y la ficha abre en esa sección', async ({ page }) => {
    // Puro: ficha sintética con dos «Pasos».
    const entrada = CATALOGO_AYUDA.find((c) => c.clave === 'flito_tramites') as EntradaAyuda;
    const sintetica = parsearFicha('## Pasos\n\nEntrar al módulo.\n\n## Pasos\n\nPaso zorbablex único.\n');
    expect(seccionesDeFicha(entrada, sintetica).map((s) => s.ancla)).toEqual(['pasos', 'pasos-2']);
    expect(buscarSecciones([{ entrada, ficha: sintetica }], 'zorbablex')).toEqual([
      { clave: 'flito_tramites', ancla: 'pasos-2', tituloFicha: 'Gestión Trámites', tituloSeccion: 'Pasos' },
    ]);
    expect(anclaExiste(sintetica, 'pasos-2')).toBe(true);
    expect(anclaExiste(sintetica, 'pasos-3')).toBe(false);

    // UI: la ficha real de trámites con una segunda sección «Pasos» al final.
    const raw = `${readFileSync(resolve(raiz, 'flito_tramites.md'), 'utf8')}\n\n## Pasos\n\nPaso zorbablex único.\n`;
    await page.route(MD_TRAMITES, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: `export default ${JSON.stringify(raw)};` }));
    await abrirPanel(page);
    await preguntar(page, 'zorbablex');
    const cita = conversacion(page).getByRole('listitem').getByRole('link');
    await expect(cita).toHaveCount(1);
    await expect(cita).toHaveAttribute('href', '/flito/ayuda/flito_tramites#pasos-2');
    await cita.click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/flito_tramites#pasos-2$/);
    await expect(page.locator('[id="pasos-2"]')).toBeInViewport();
  });

  test('AC3 · «CONCILIACION» da las mismas citas que «conciliación»', async ({ page }) => {
    const fichas = fichasDe(FINANCIERA_CON_TRAMITES);
    const conTilde = buscarSecciones(fichas, 'conciliación');
    expect(conTilde.length).toBeGreaterThan(0);
    expect(buscarSecciones(fichas, 'CONCILIACION')).toEqual(conTilde);

    await abrirPanel(page);
    await preguntar(page, 'CONCILIACION');
    const enlaces = conversacion(page).getByRole('listitem').getByRole('link');
    await expect(enlaces).toHaveCount(conTilde.length);
    expect(await enlaces.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(conTilde.map((c) => `/flito/ayuda/${c.clave}#${c.ancla}`));
  });

  test('AC4 · financiera: «credenciales siigo» no cita ni descarga «Integración con Siigo»', async ({ page }) => {
    for (const q of ['credenciales siigo', 'Integración con Siigo']) {
      expect(buscarSecciones(fichasDe(FINANCIERA_USER), q).some((c) => c.clave === 'siigo_credenciales')).toBe(false);
    }
    // Control: con la ficha visible, la consulta sí la encontraría (el filtro es el permiso).
    const todas = CATALOGO_AYUDA.map((entrada) => ({ entrada, ficha: leer(entrada.clave) }));
    expect(buscarSecciones(todas, 'Integración con Siigo').some((c) => c.clave === 'siigo_credenciales')).toBe(true);

    const pedidas: string[] = [];
    page.on('request', (r) => pedidas.push(r.url()));
    await abrirPanel(page, FINANCIERA_USER);
    for (const q of ['credenciales siigo', 'Integración con Siigo']) {
      await preguntar(page, q);
      await expect(conversacion(page).getByText(new RegExp(`^Usted: ${q}$`))).toBeVisible();
    }
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);
    await expect(conversacion(page).locator('a[href*="siigo_credenciales"]')).toHaveCount(0);
    expect(pedidas.some((u) => MD_CUALQUIERA.test(u))).toBe(true);
    expect(pedidas.some((u) => MD_SIIGO_CRED.test(u))).toBe(false);
  });

  test('AC5 · «xyzzy» → sin resultados, reformular y «Abrir la Ayuda FLITO» a /flito/ayuda sin la pregunta', async ({ page }) => {
    expect(buscarSecciones(fichasDe(FINANCIERA_CON_TRAMITES), 'xyzzy')).toEqual([]);
    // HU #13806 (F5) cuelga «Necesito soporte» en esta fila cuando el soporte está disponible; aquí no lo
    // está, y la respuesta vacía sigue siendo la de F3 (su caso con soporte: dr-flit-soporte.spec.ts).
    await page.route('**/api/flito/dr-flit/autorizacion**', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        finalidad: 'soporte', autorizado: false, versionVigente: 'v', textoVigente: 't', aceptadaEn: null,
        soporte: { disponible: false, ambiente: null, ambienteEtiqueta: null, adjuntos: { maxArchivos: 0, maxBytesArchivo: 0, tipos: [] } },
      }),
    }));
    await abrirPanel(page);
    await preguntar(page, 'xyzzy');
    await expect(conversacion(page).getByText('No encontré nada sobre "xyzzy" en sus manuales.')).toBeVisible();
    await expect(conversacion(page).getByText('Pruebe con otras palabras, por ejemplo el nombre del módulo o de la pantalla.'))
      .toBeVisible();
    await expect(conversacion(page).getByRole('button', { name: /soporte/i })).toHaveCount(0);
    await expect(conversacion(page).getByRole('link', { name: /soporte/i })).toHaveCount(0);
    const respuesta = conversacion(page).locator('div', { hasText: 'No encontré nada sobre' }).last();
    await respuesta.getByRole('link', { name: 'Abrir la Ayuda FLITO' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    expect(page.url()).not.toContain('xyzzy');
  });

  test('AC6 · vacío o solo espacios no se envía; el campo no admite más de 300 caracteres', async ({ page }) => {
    await abrirPanel(page);
    await caja(page).fill('   ');
    await caja(page).press('Enter');
    await expect(enviar(page)).toHaveAttribute('aria-disabled', 'true');
    await enviar(page).click({ force: true });
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);
    await expect(conversacion(page).getByText('Esto es lo que encontré')).toHaveCount(0);
    await expect(conversacion(page).getByText(/No encontré nada/)).toHaveCount(0);

    await expect(caja(page)).toHaveAttribute('maxlength', '300');
    await caja(page).fill('');
    await caja(page).pressSequentially('a'.repeat(310), { delay: 0 });
    await expect(caja(page)).toHaveValue('a'.repeat(300));
    await expect(panel(page).getByText('300/300')).toBeVisible();
    await expect(panel(page).getByText('Llegó al máximo de 300 caracteres.')).toBeVisible();
  });

  test('AC7 · la pregunta no sale en ninguna petición de red ni en la consola', async ({ page }) => {
    const MARCA = 'quokkasecreto';
    const fugas: string[] = [];
    page.on('request', (r) => {
      const cuerpo = r.postData() ?? '';
      if (`${r.url()} ${cuerpo}`.includes(MARCA)) fugas.push(`red: ${r.url()}`);
    });
    page.on('console', (m) => {
      if (m.text().includes(MARCA)) fugas.push(`consola: ${m.text()}`);
    });
    await abrirPanel(page);
    await preguntar(page, `¿cómo se entra a trámites ${MARCA}?`);
    await expect(conversacion(page).getByText('Esto es lo que encontré en sus manuales:')).toBeVisible();
    await preguntar(page, MARCA);
    await expect(conversacion(page).getByText(`No encontré nada sobre "${MARCA}" en sus manuales.`)).toBeVisible();
    expect(page.url()).not.toContain(MARCA);
    expect(fugas).toEqual([]);
  });

  test('AC8 · primera pregunta: «Dr. Flit está buscando…» y, si falla, «Reintentar» reenvía la misma', async ({ page }) => {
    let liberar!: () => void;
    const retenido = new Promise<void>((r) => { liberar = r; });
    let fallar = true;
    await page.route(MD_TRAMITES, async (route: Route) => {
      if (!fallar) return route.continue();
      await retenido;
      return route.abort('failed');
    });
    await abrirPanel(page);
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page)).toHaveAttribute('aria-live', 'polite');
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toBeVisible();
    await expect(enviar(page)).toHaveAttribute('aria-disabled', 'true');
    liberar();
    await expect(conversacion(page).getByText('No pude revisar sus manuales en este momento.')).toBeVisible();
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);

    fallar = false;
    await conversacion(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(conversacion(page).getByRole('listitem').getByRole('link').first())
      .toHaveAttribute('href', '/flito/ayuda/flito_tramites#como-se-entra');
    await expect(conversacion(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(conversacion(page).getByText('¿cómo se entra a trámites?')).toHaveCount(1);
  });

  test('AC9 · <label> «Escriba su pregunta», Enter envía, foco visible; cada cita nombra ficha y sección', async ({ page }) => {
    await abrirPanel(page);
    const input = caja(page);
    const id = await input.getAttribute('id');
    expect(id).toBeTruthy();
    await expect(panel(page).locator(`label[for="${id}"]`)).toHaveText('Escriba su pregunta');
    await input.focus();
    const foco = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' || cs.boxShadow !== 'none';
    });
    expect(foco).toBe(true);
    await input.fill('¿cómo se entra a trámites?');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('');
    const primera = conversacion(page).getByRole('listitem').getByRole('link').first();
    await expect(primera).toHaveAccessibleName(/^Gestión Trámites\s*,\s*Cómo se entra$/);
    await primera.focus();
    const focoCita = await primera.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' || cs.boxShadow !== 'none';
    });
    expect(focoCita).toBe(true);
  });
});
