import { test, expect } from '../helpers/fixtures';
import type { Page, Route } from '@playwright/test';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// BUG #14569, punto 8 — buscador de trámite en Revisiones OCR. El `<select>` de 200 candidatos traídos
// al cliente pasa a un combobox con búsqueda en el servidor: `POST /flito/revisiones/:id/candidatos/buscar`
// con las llaves en el BODY (placa = cuasi-PII, nunca en la URL). Backend mockeado.

type Candidato = {
  id: string; idFlit: string | null; placa: string | null; vin: string | null; etiqueta: string;
  detalle: string | null; coincide: { placa: boolean; vin: boolean }; seleccionable: boolean; motivoNoSeleccionable: string | null;
};
const cand = (id: string, idFlit: string, placa: string, vin: string, extra: Partial<Candidato> = {}): Candidato => ({
  id, idFlit, placa, vin, etiqueta: `${idFlit} · ${placa}`, detalle: 'Chevrolet Spark GT',
  coincide: { placa: false, vin: false }, seleccionable: true, motivoNoSeleccionable: null, ...extra,
});

const C1 = cand('soat1', 'F-24-001532', 'KPX482', '9GAMM6100KF021893', { coincide: { placa: true, vin: true } });
const C2 = cand('soat2', 'F-24-001498', 'KPX482', '9GAMM6100KA007714', { coincide: { placa: true, vin: false } });
const C3 = cand('soat3', 'F-24-000977', 'KPX428', '9FBLSRAJ0KC033120', { detalle: 'Renault Logan' });
const YA = cand('soat4', 'F-24-000812', 'KPX482', '9GAMM6100KA000001', { seleccionable: false, motivoNoSeleccionable: 'Ya tiene derecho' });

const REVISION = (placa: string | null, vin: string | null = null) => ({
  id: 'r1', modulo: 'soat', motivo: 'cruce_ambiguo', detalle: 'Varias coincidencias para la placa leída',
  registroId: null, placaSugerida: placa,
  extraccion: {
    ...(placa ? { placa: { valor: placa, confianza: 0.95, confiable: true } } : {}),
    ...(vin ? { vin: { valor: vin, confianza: 0.95, confiable: true } } : {}),
  },
  resuelto: false, creadoEn: '2026-11-10T12:00:00Z', soporte: { id: 'sop1', nombreArchivo: 'poliza-KPX482.pdf' },
});

type Respuesta = { status?: number; items?: Candidato[]; truncado?: boolean; demoraMs?: number };
type Peticion = { url: string; body: Record<string, unknown> };

async function montar(page: Page, revision: unknown, responder: (body: Record<string, unknown>) => Respuesta) {
  const peticiones: Peticion[] = [];
  await page.route(/\/api\/flito\/revisiones\?/, (route) => {
    const soat = route.request().url().includes('modulo=soat');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(soat ? [revision] : []) });
  });
  await page.route(/\/api\/flito\/revisiones\/campos\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['placa', 'vin']) }));
  await page.route(/\/api\/flito\/revisiones\/soporte\/.*\/archivo$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }));
  await page.route(/\/api\/flito\/revisiones\/[^/]+\/candidatos\/buscar/, async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    peticiones.push({ url: route.request().url(), body });
    const r = responder(body);
    if (r.demoraMs) await new Promise((res) => setTimeout(res, r.demoraMs));
    if (r.status && r.status >= 400) return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify({ error: 'boom interno' }) });
    const items = r.items ?? [];
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: r.truncado ? items.length + 5 : items.length, truncado: !!r.truncado, registroActual: null }),
    });
  });
  return peticiones;
}

const trigger = (page: Page) => page.getByLabel('Trámite contra el que se concilia *');
const buscador = (page: Page) => page.getByRole('combobox', { name: 'Buscar trámite por placa, VIN o número FLIT' });

test.describe('FLITO — Revisiones OCR · buscador de trámite (BUG #14569)', () => {
  test('sin placa ni VIN: pista; al escribir, POST con el texto en el body y lista con N.º FLIT · placa', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await montar(page, REVISION(null), (b) => (b.texto ? { items: [C1, C3] } : { items: [] }));
    await page.goto('/flito/revisiones');

    await trigger(page).click();
    await expect(page.getByText('Escribe al menos 3 caracteres de la placa, el VIN o el número FLIT para buscar el trámite.')).toBeVisible();
    expect(peticiones).toHaveLength(0);

    await buscador(page).fill('F-24');
    const opcion = page.getByRole('option', { name: /F-24-001532 · KPX482/ });
    await expect(opcion).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(opcion).toContainText('VIN …021893');

    const ultima = peticiones.at(-1)!;
    expect(ultima.body).toEqual({ texto: 'F-24' });
    expect(new URL(ultima.url).search).toBe('');
    expect(ultima.url).not.toContain('F-24');
  });

  test('cargando con esqueleto y luego sin resultados con el término buscado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION(null), () => ({ items: [], demoraMs: 800 }));
    await page.goto('/flito/revisiones');

    await trigger(page).click();
    await buscador(page).fill('KPX999');
    await expect(page.getByRole('status').filter({ hasText: 'Buscando trámites…' })).toBeAttached();
    await expect(page.getByText('No hay trámites por elegir con «KPX999».')).toBeVisible();
    await expect(page.getByText('Revisa la placa o busca por el número FLIT. Si el documento no es de ningún trámite, descártalo.')).toBeVisible();
  });

  test('error con Reintentar: sin texto crudo del API y el reintento repite la búsqueda', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let fallar = true;
    const peticiones = await montar(page, REVISION(null), () => (fallar ? { status: 500 } : { items: [C3] }));
    await page.goto('/flito/revisiones');

    await trigger(page).click();
    await buscador(page).fill('KPX428');
    await expect(page.getByText('No pudimos buscar los trámites.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);

    fallar = false;
    const antes = peticiones.length;
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(page.getByRole('option', { name: /F-24-000977 · KPX428/ })).toBeVisible();
    expect(peticiones.length).toBe(antes + 1);
    expect(peticiones.at(-1)!.body).toEqual({ texto: 'KPX428' });
  });

  test('único candidato que coincide con la placa del documento: se elige solo y sigue editable con Cambiar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await montar(page, REVISION('KPX482'), () => ({ items: [C1] }));
    await page.goto('/flito/revisiones');

    await expect(page.getByText('Elegido automáticamente: es el único trámite con la placa KPX482.')).toBeVisible();
    await expect(trigger(page)).toHaveText(/F-24-001532 · KPX482 · Chevrolet Spark GT/);
    await expect(page.getByText('Leído del PDF')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeEnabled();
    expect(peticiones[0].body).toEqual({ placa: 'KPX482' });

    await page.getByRole('button', { name: 'Cambiar', exact: true }).click();
    await expect(buscador(page)).toBeFocused();
    await expect(page.getByText('Filtrado por la placa KPX482 del documento')).toBeVisible();
    await expect(page.getByRole('option', { name: /F-24-001532/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('selección automática sigue a la placa: si ya no hay un único candidato, se quita y lo dice', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION('KPX482'), (b) => (b.placa === 'KPX482' ? { items: [C1] } : { items: [C1, C3] }));
    await page.goto('/flito/revisiones');

    await expect(page.getByText('Elegido automáticamente: es el único trámite con la placa KPX482.')).toBeVisible();
    await page.locator('#c-placa').fill('KPX4');
    await expect(page.getByText('Cambiaste la placa y ya no hay un único trámite que coincida. Elige uno.')).toBeVisible();
    await expect(trigger(page)).toHaveText('Selecciona el trámite…');
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeDisabled();
  });

  test('varias coincidencias: no se preselecciona; chip de coincidencia, «Ya tiene derecho» no elegible y teclado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION('KPX482', '9GAMM6100KF021893'), () => ({ items: [YA, C1, C2], truncado: true }));
    await page.goto('/flito/revisiones');

    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeDisabled();
    await expect(page.getByText(/Elegido automáticamente/)).toHaveCount(0);

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(buscador(page)).toBeFocused();
    await expect(page.getByText('Filtrado por la placa KPX482 y el VIN del documento')).toBeVisible();
    const deshabilitada = page.getByRole('option', { name: /F-24-000812/ });
    await expect(deshabilitada).toHaveAttribute('aria-disabled', 'true');
    await expect(deshabilitada).toContainText('Ya tiene derecho');
    await expect(page.getByRole('option', { name: /F-24-001532/ })).toContainText('Coincide placa y VIN');
    await expect(page.getByRole('option', { name: /F-24-001498/ })).toContainText('Coincide placa');
    await expect(page.getByText('Hay más trámites que coinciden. Escribe más de la placa, el VIN o el número FLIT para afinar.')).toBeVisible();

    // Clic en la no elegible no hace nada.
    await deshabilitada.click({ force: true });
    await expect(buscador(page)).toBeVisible();

    // El resaltado arranca en la primera elegible (salta la deshabilitada); ↓ baja a la segunda.
    const optC1 = page.getByRole('option', { name: /F-24-001532/ });
    await expect(buscador(page)).toHaveAttribute('aria-activedescendant', (await optC1.getAttribute('id'))!);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // tope: no da la vuelta
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveText(/F-24-001498 · KPX482/);
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeEnabled();

    // Esc cierra sin cambiar la selección.
    await page.keyboard.press('Enter');
    await expect(buscador(page)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(buscador(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveText(/F-24-001498/);
  });

  test('elección manual que deja de cruzar con la placa corregida: aviso con «Buscar con …» y la elección se mantiene', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION('KPX482'), (b) => (b.placa === 'KPX428' ? { items: [C3] } : { items: [C1, C2] }));
    await page.goto('/flito/revisiones');

    await trigger(page).click();
    await page.getByRole('option', { name: /F-24-001498/ }).click();
    await expect(trigger(page)).toHaveText(/F-24-001498/);

    await page.locator('#c-placa').fill('KPX428');
    await expect(page.getByText('La placa de los campos (KPX428) no es la del trámite elegido (KPX482). Revisa cuál corresponde.')).toBeVisible();
    await expect(trigger(page)).toHaveText(/F-24-001498/);
    await page.getByRole('button', { name: 'Buscar con KPX428' }).click();
    await expect(page.getByRole('option', { name: /F-24-000977 · KPX428/ })).toBeVisible();
  });

  test('auditor: el campo está deshabilitado y no se llama al buscador', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const peticiones = await montar(page, REVISION('KPX482'), () => ({ items: [C1] }));
    await page.goto('/flito/revisiones');

    await expect(trigger(page)).toBeDisabled();
    await expect(trigger(page)).toHaveText('Sin trámite asociado');
    await page.waitForTimeout(500);
    expect(peticiones).toHaveLength(0);
  });

  test('a 375 px la lista abierta no desborda la página', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION('KPX482', '9GAMM6100KF021893'), () => ({ items: [C1, C2, C3] }));
    await page.goto('/flito/revisiones');

    await trigger(page).scrollIntoViewIfNeeded();
    await trigger(page).click();
    await expect(page.getByRole('option')).toHaveCount(3);
    const caja = await trigger(page).boundingBox();
    expect(caja!.height).toBeGreaterThanOrEqual(44);
    const desborde = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await desborde()).toBeLessThanOrEqual(0);
    // Con un trámite elegido, la etiqueta larga del trigger se trunca en vez de ensanchar la columna.
    await page.getByRole('option', { name: /F-24-001532/ }).click();
    await expect(trigger(page)).toHaveText(/F-24-001532 · KPX482 · Chevrolet Spark GT/);
    expect(await desborde()).toBeLessThanOrEqual(0);
  });
});
