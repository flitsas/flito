import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Gestión Trámites · botón «Sincronizar FLIT 2» (HU #13096). Backend mockeado: se verifica
// el cableado de la UI contra `POST /api/flito/sync/flit2/sincronizar` (`Flit2LecturaResultado` y
// el cuerpo de error `{ error, codigo, parcial? }`).

const RUTA = /\/api\/flito\/sync\/flit2\/sincronizar$/;
/** Texto del campo `error` del API: nunca debe llegar a la pantalla. */
const CRUDO = 'ERROR-CRUDO-e2e-13096';

const RESULTADO = {
  leidos: 12, nuevos: 5, actualizados: 3, sinCambios: 4, conflictos: 7, sinVehiculo: 0,
  eliminadosIgnorados: 0, invalidos: 9, companiasFaltantes: 1, organismosSinEmparejar: 1,
  paginas: 2, hasMore: false, modo: 'cursor', ejecutadoEn: '2026-09-29T15:00:00.000Z',
};

async function mockCola(page: Page, alListar?: () => void) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }),
  }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => {
    alListar?.();
    return r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }),
    });
  });
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const boton = (page: Page) => page.getByRole('button', { name: /Sincroniza(r|ndo) FLIT 2/ });

async function abrir(page: Page) {
  await page.goto('/flito/tramites');
  await expect(boton(page)).toBeVisible();
}

test.describe('FLITO — Gestión Trámites · Sincronizar FLIT 2 (HU #13096)', () => {
  test('AC1: sin «sync.sync.lanzar» el botón no está en el DOM', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockCola(page);
    await page.goto('/flito/tramites');
    await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
    await expect(boton(page)).toHaveCount(0);
  });

  test('AC1: con el permiso aparece junto a «Sincronizar FLIT», como secundario, y FLIT 1 no cambia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await abrir(page);
    const flit1 = page.getByRole('button', { name: 'Sincronizar FLIT', exact: true });
    await expect(flit1).toBeVisible();
    // Hermano inmediato a la derecha de FLIT 1 en la barra (orden de DOM).
    const orden = await page.getByRole('button').evaluateAll((bs) => bs.map((b) => b.textContent?.trim()));
    expect(orden.indexOf('Sincronizar FLIT 2')).toBe(orden.indexOf('Sincronizar FLIT') + 1);
    await expect(boton(page)).toHaveClass(/h-10/);
    await expect(boton(page)).toHaveAttribute('title', 'Lee lo nuevo de FLIT 2 desde la última lectura');
  });

  test('AC2: éxito con totales y faltantes; sin telemetría; refresca la cola; un solo POST por doble clic', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let listados = 0;
    await mockCola(page, () => { listados += 1; });
    let posts = 0;
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA, async (r) => {
      posts += 1;
      expect(r.request().postData() ?? '').toBe('');
      await pendiente;
      return json(r, 200, RESULTADO);
    });
    await abrir(page);
    await expect.poll(() => listados).toBeGreaterThan(0);
    const antes = listados;

    // Dos clics en el mismo tick: ejerce la guardia por ref (el dblclick de Playwright deja repintar `disabled`).
    await boton(page).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await expect(boton(page)).toHaveText('Sincronizando FLIT 2…');
    await expect(boton(page)).toBeDisabled();
    await expect(boton(page)).toHaveAttribute('aria-busy', 'true');
    // FLIT 1 sigue usable mientras lee FLIT 2.
    await expect(page.getByRole('button', { name: 'Sincronizar FLIT', exact: true })).toBeEnabled();
    soltar();

    await expect(page.getByText(
      'FLIT 2: 12 trámites leídos, 5 nuevos y 3 actualizados. 2 quedaron sin empresa o sin secretaría: revísalos en la cola.',
      { exact: true },
    )).toBeVisible();
    expect(posts).toBe(1);
    await expect(boton(page)).toHaveText('Sincronizar FLIT 2');
    await expect(boton(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => listados).toBeGreaterThan(antes);
    await expect(page.getByText(/conflicto|inválido|página/i)).toHaveCount(0);
    // El toast se cierra con ✕.
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(/^FLIT 2: 12 trámites/)).toHaveCount(0);
  });

  test('AC2: con `hasMore` dice que el resto llega en la lectura automática; vacío tiene su copy', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let n = 0;
    await page.route(RUTA, (r) => {
      n += 1;
      return n === 1
        ? json(r, 200, { ...RESULTADO, leidos: 1, nuevos: 1, actualizados: 0, companiasFaltantes: 0, organismosSinEmparejar: 0, hasMore: true })
        : json(r, 200, { ...RESULTADO, leidos: 0, nuevos: 0, actualizados: 0, hasMore: false });
    });
    await abrir(page);
    await boton(page).click();
    await expect(page.getByText(
      'FLIT 2: 1 trámite leído, 1 nuevo y 0 actualizados. Quedan más: la lectura automática sigue donde quedó.',
      { exact: true },
    )).toBeVisible();
    await boton(page).click();
    await expect(page.getByText('FLIT 2 no tiene trámites nuevos ni con cambios desde la última lectura.', { exact: true })).toBeVisible();
    // id fijo: la segunda pulsación sustituye al toast anterior.
    await expect(page.getByText(/Quedan más/)).toHaveCount(0);
  });

  test('AC3: con una lectura en curso (409) avisa que ya hay una en marcha, sin Reintentar ni texto crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 409, { error: CRUDO, codigo: 'lectura_concurrente' }));
    await abrir(page);
    await boton(page).click();
    const aviso = page.getByRole('alert').filter({ hasText: 'Ya hay una lectura de FLIT 2 en marcha' });
    await expect(aviso).toHaveText(/Ya hay una lectura de FLIT 2 en marcha\. Espera a que termine y actualiza la cola\./);
    await expect(aviso.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(page.getByText('lectura_concurrente')).toHaveCount(0);
  });

  test('AC4: un 503 de acceso da copy propio sin Reintentar; nunca el error crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 503, { error: CRUDO, codigo: 'rechazado' }));
    await abrir(page);
    await boton(page).click();
    const aviso = page.getByRole('alert').filter({ hasText: 'FLIT 2 rechazó el acceso guardado' });
    await expect(aviso).toBeVisible();
    await expect(aviso.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(page.getByText(/\b503\b|rechazado\b/)).toHaveCount(0);
  });

  test('AC4: `no_responde` ofrece Reintentar, que vuelve a llamar; FLIT 1 y su fecha no cambian', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let n = 0;
    await page.route(RUTA, (r) => {
      n += 1;
      return n === 1 ? json(r, 503, { error: CRUDO, codigo: 'no_responde' }) : json(r, 200, RESULTADO);
    });
    await abrir(page);
    await boton(page).click();
    const aviso = page.getByRole('alert').filter({ hasText: 'FLIT 2 no responde.' });
    await expect(aviso).toHaveText(/FLIT 2 no responde\. Puede ser una caída momentánea: vuelve a intentarlo en unos minutos\./);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sincronizar FLIT', exact: true })).toBeEnabled();
    await expect(page.getByText('Última actualización')).toBeVisible();
    await aviso.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText(/^FLIT 2: 12 trámites leídos/)).toBeVisible();
    expect(n).toBe(2);
  });

  test('AC4: un fallo de red cae en el genérico con Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: CRUDO }));
    await abrir(page);
    await boton(page).click();
    const aviso = page.getByRole('alert').filter({ hasText: 'No se pudo sincronizar FLIT 2. Vuelve a intentarlo.' });
    await expect(aviso.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });

  test('503 `espera` con parcial: toast de éxito con los parciales', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await page.route(RUTA, (r) => json(r, 503, { error: CRUDO, codigo: 'espera', parcial: { ...RESULTADO, leidos: 40, nuevos: 7 } }));
    await abrir(page);
    await boton(page).click();
    await expect(page.getByRole('status').filter({
      hasText: 'Se alcanzaron a leer 40 trámites (7 nuevos). FLIT 2 pidió esperar: la lectura automática sigue donde quedó.',
    })).toBeVisible();
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });
});
