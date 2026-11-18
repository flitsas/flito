import { test, expect } from '../helpers/fixtures';
import type { Page, Route } from '@playwright/test';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// BUG #14569 — Revisiones OCR, segunda pasada:
//   · el listado trae `registroActual`: el auditor ve el trámite asociado sin usar el buscador (403);
//   · punto 9: «Reintentar lectura» = `POST /flito/revisiones/:id/reintentar-lectura` sin body.
// Backend mockeado.

const TRAMITE = {
  id: 'soat1', idFlit: 'F-24-001532', placa: 'KPX482', vin: '9GAMM6100KF021893', etiqueta: 'F-24-001532 · KPX482',
  detalle: 'Chevrolet Spark GT', coincide: { placa: true, vin: true }, seleccionable: true, motivoNoSeleccionable: null,
};

const campo = (valor: string, confianza = 0.62) => ({ valor, confianza, confiable: confianza >= 0.9 });
const REVISION = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', modulo: 'soat', motivo: 'confianza_baja', detalle: 'La confianza del OCR quedó bajo el umbral',
  registroId: null, placaSugerida: 'KPX482',
  extraccion: { placa: campo('KPX482'), numero_poliza: campo('AT-0001') },
  resuelto: false, creadoEn: '2026-11-10T12:00:00Z', soporte: { id: 'sop1', nombreArchivo: 'poliza-KPX482.pdf' },
  registroActual: null, ...extra,
});
const RELEIDA = REVISION({
  extraccion: { placa: campo('KPX482', 0.97), numero_poliza: campo('AT-77881', 0.95) },
});

type Reintento = { status: number; body: unknown };
interface Llamadas { buscar: number; reintentos: { url: string; body: string | null }[] }

async function montar(page: Page, revision: unknown, reintento?: () => Reintento): Promise<Llamadas> {
  const llamadas: Llamadas = { buscar: 0, reintentos: [] };
  await page.route(/\/api\/flito\/revisiones\?/, (route) => {
    const soat = route.request().url().includes('modulo=soat');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(soat ? [revision] : []) });
  });
  await page.route(/\/api\/flito\/revisiones\/campos\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['placa', 'numero_poliza']) }));
  await page.route(/\/api\/flito\/revisiones\/soporte\/.*\/archivo$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }));
  await page.route(/\/api\/flito\/revisiones\/[^/]+\/candidatos\/buscar/, (route) => {
    llamadas.buscar += 1;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [TRAMITE], total: 1, truncado: false, registroActual: null }) });
  });
  await page.route(/\/api\/flito\/revisiones\/[^/]+\/reintentar-lectura$/, async (route: Route) => {
    llamadas.reintentos.push({ url: route.request().url(), body: route.request().postData() });
    const r = reintento ? reintento() : { status: 500, body: {} };
    await new Promise((res) => setTimeout(res, 300));
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return llamadas;
}

const trigger = (page: Page) => page.getByLabel('Trámite contra el que se concilia *');
const botonReintentar = (page: Page) => page.getByRole('button', { name: 'Reintentar lectura' });
const ok = (sinLectura = false, camposLeidos = 2): Reintento =>
  ({ status: 200, body: { revision: sinLectura ? REVISION() : RELEIDA, sinLectura, camposLeidos: sinLectura ? 0 : camposLeidos } });

test.describe('FLITO — Revisiones OCR · trámite asociado y reintentar lectura (BUG #14569)', () => {
  test('auditor: ve la etiqueta completa del trámite asociado y la tabla, sin buscar ni reintentar', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const llamadas = await montar(page, REVISION({ registroId: 'soat1', registroActual: TRAMITE }));
    await page.goto('/flito/revisiones');

    await expect(trigger(page)).toHaveText(/F-24-001532 · KPX482 · Chevrolet Spark GT/);
    await expect(trigger(page)).toBeDisabled();
    await expect(page.getByText('Leído del PDF')).toBeVisible();
    await expect(page.getByText('9GAMM6100KF021893').first()).toBeVisible();
    await expect(botonReintentar(page)).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(llamadas.buscar).toBe(0);
    expect(llamadas.reintentos).toHaveLength(0);
  });

  test('auditor sin trámite asociado: «Sin trámite asociado»', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await montar(page, REVISION());
    await page.goto('/flito/revisiones');
    await expect(trigger(page)).toHaveText(/Sin trámite asociado/);
    await expect(page.getByText('Leído del PDF')).toHaveCount(0);
  });

  test('admin con trámite previo: viene elegido desde el listado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION({ registroId: 'soat1', registroActual: TRAMITE }));
    await page.goto('/flito/revisiones');
    await expect(trigger(page)).toHaveText(/F-24-001532 · KPX482 · Chevrolet Spark GT/);
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeEnabled();
  });

  test('sin ediciones: POST sin body, «Leyendo de nuevo…», campos actualizados y aviso con N', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const llamadas = await montar(page, REVISION(), () => ok(false, 2));
    await page.goto('/flito/revisiones');
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-0001');

    await botonReintentar(page).click();
    await expect(page.getByRole('button', { name: 'Leyendo de nuevo…' })).toBeDisabled();
    await expect(page.locator('#c-numero_poliza')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeDisabled();

    await expect(page.getByRole('status').filter({ hasText: 'Lectura actualizada: 2 campos leídos. Revisa los campos y el trámite antes de confirmar.' })).toBeVisible();
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-77881');
    await expect(page.locator('#c-numero_poliza')).toBeEnabled();
    await expect(page.getByText('95% · confiable')).toBeVisible();
    expect(llamadas.reintentos).toHaveLength(1);
    expect(llamadas.reintentos[0].body).toBeNull();
    expect(new URL(llamadas.reintentos[0].url).pathname).toBe('/api/flito/revisiones/r1/reintentar-lectura');
  });

  test('con ediciones: pide confirmación en línea; Cancelar no llama y «Reintentar de todos modos» sí', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const llamadas = await montar(page, REVISION(), () => ok());
    let dialogos = 0;
    page.on('dialog', (d) => { dialogos += 1; void d.dismiss(); });
    await page.goto('/flito/revisiones');

    await page.locator('#c-numero_poliza').fill('AT-0002');
    await botonReintentar(page).click();
    await expect(page.getByText('Se reemplazarán los campos que corregiste con la nueva lectura.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('Se reemplazarán los campos que corregiste con la nueva lectura.')).toHaveCount(0);
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-0002');
    expect(llamadas.reintentos).toHaveLength(0);

    await botonReintentar(page).click();
    await page.getByRole('button', { name: 'Reintentar de todos modos' }).click();
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-77881');
    expect(llamadas.reintentos).toHaveLength(1);
    expect(dialogos).toBe(0);
  });

  test('sinLectura: aviso y los campos quedan como estaban', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION(), () => ok(true));
    await page.goto('/flito/revisiones');

    await botonReintentar(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'El documento se volvió a leer, pero no se obtuvo ningún campo. La revisión no cambió.' })).toBeVisible();
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-0001');
  });

  test('503: aviso en página con el copy del servidor', async ({ page }) => {
    const copy = 'El lector de documentos no está disponible en este momento. La revisión no cambió; intenta de nuevo en unos minutos.';
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION(), () => ({ status: 503, body: { error: copy } }));
    await page.goto('/flito/revisiones');

    await botonReintentar(page).click();
    await expect(page.getByRole('status').filter({ hasText: copy })).toBeVisible();
    await expect(page.locator('#c-numero_poliza')).toHaveValue('AT-0001');
    await expect(botonReintentar(page)).toBeEnabled();
  });

  test('500 sin copy: genérico, nunca el texto crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION(), () => ({ status: 500, body: { error: 'TypeError: boom interno' } }));
    await page.goto('/flito/revisiones');

    await botonReintentar(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'No pudimos reintentar la lectura. Intenta de nuevo.' })).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
  });

  test('revisión resuelta: sin botón de reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION({ resuelto: true, registroId: 'soat1', registroActual: TRAMITE }));
    await page.goto('/flito/revisiones');
    await expect(page.getByText('Resuelta', { exact: true })).toBeVisible();
    await expect(trigger(page)).toHaveText(/F-24-001532 · KPX482/);
    await expect(botonReintentar(page)).toHaveCount(0);
  });

  test('375 px: aviso y confirmación sin desborde horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER);
    await montar(page, REVISION(), () => ok());
    await page.goto('/flito/revisiones');

    await page.locator('#c-numero_poliza').fill('AT-0002');
    await botonReintentar(page).click();
    await expect(page.getByRole('button', { name: 'Reintentar de todos modos' })).toBeVisible();
    const alto = await botonReintentar(page).evaluate((el) => el.getBoundingClientRect().height);
    expect(alto).toBeGreaterThanOrEqual(44);
    let ancho = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(ancho).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Reintentar de todos modos' }).click();
    await expect(page.getByText(/Lectura actualizada/)).toBeVisible();
    ancho = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(ancho).toBeLessThanOrEqual(0);
  });
});
