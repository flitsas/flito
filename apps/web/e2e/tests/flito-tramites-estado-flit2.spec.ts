import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

// FLITO — Gestión Trámites · estado de la conexión con FLIT 2 (HU #13098). Backend mockeado: se
// verifica el cableado de la UI contra `GET /api/flito/sync/flit2/estado` (`Flit2EstadoConexion`).

const RUTA_ESTADO = /\/api\/flito\/sync\/flit2\/estado$/;
const RUTA_SINCRONIZAR = /\/api\/flito\/sync\/flit2\/sincronizar$/;
/** Texto del campo `error` del API: nunca debe llegar a la pantalla. */
const CRUDO = 'ERROR-CRUDO-e2e-13098';

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dentro = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

const SANO = {
  configurado: true, motivoSinConfigurar: null,
  ultimaExitosaEn: hace(3), ultimoIntentoEn: hace(3),
  atrasada: false, alerta: false, problema: null,
  piiEnmascarada: { tramites: 0, desde: null },
};
const PROBLEMA = { tipo: 'lectura', codigo: null, motivo: null, en: hace(2), hasta: null };

async function mockCola(page: Page) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => json(r, 200, { estados: [], tramites: [], ciudades: [], transitos: [] }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Mockea el estado con una respuesta cambiable y cuenta los GET. En dev, React StrictMode monta el
 * efecto dos veces: la carga inicial son 1 o 2 GET, así que los asertos de conteo son relativos.
 */
async function mockEstado(page: Page, status: number, body: unknown) {
  const ctl = { n: 0, status, body, set(s: number, b: unknown) { ctl.status = s; ctl.body = b; } };
  await page.route(RUTA_ESTADO, (r) => { ctl.n += 1; return json(r, ctl.status, ctl.body); });
  return ctl;
}

/** Espera a que la carga inicial asiente y devuelve cuántos GET salieron. */
async function asentado(page: Page, ctl: { n: number }) {
  await expect.poll(() => ctl.n).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="linea-estado-flit2"][aria-busy="true"]')).toHaveCount(0);
  await page.waitForTimeout(200);
  return ctl.n;
}

const linea = (page: Page) => page.getByTestId('linea-estado-flit2');
const aviso = (page: Page) => page.getByTestId('aviso-estado-flit2');

async function abrir(page: Page) {
  await page.goto('/flito/tramites');
  await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
}

/** Simula volver a la pestaña: dispara `visibilitychange` con la pestaña visible (GET silencioso). */
async function volverALaPestana(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test.describe('FLITO — Gestión Trámites · estado de FLIT 2 (HU #13098)', () => {
  test('AC6: sin «sync.sync.ver_estado» no hay línea, ni aviso, ni GET', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, alerta: true });
    await abrir(page);
    await expect(page.getByText('Última lectura FLIT 2')).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
    expect(ctl.n).toBe(0);
  });

  test('AC6: admin sin la función tampoco pinta nada ni consulta', async ({ page }) => {
    const sinEstado = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'sync.sync.ver_estado');
    await loginAs(page, { ...OPERACIONES_USER, funciones: sinEstado });
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, alerta: true });
    await abrir(page);
    await expect(page.getByRole('button', { name: 'Sincronizar FLIT 2' })).toBeVisible();
    await expect(linea(page)).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
    expect(ctl.n).toBe(0);
  });

  test('AC6: con la función pero 403 del API, nada en pantalla, sin error y sin más consultas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 403, { error: CRUDO });
    await abrir(page);
    await expect.poll(() => ctl.n).toBeGreaterThan(0);
    await expect(linea(page)).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    const antes = ctl.n;
    await volverALaPestana(page);
    await page.waitForTimeout(300);
    expect(ctl.n).toBe(antes);
  });

  test('AC1 + AC2: cargando con esqueleto, luego la última lectura exitosa y «atrasada»; sano sin aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_ESTADO, async (r) => { await pendiente; return json(r, 200, { ...SANO, atrasada: true }); });
    await abrir(page);
    await expect(linea(page)).toHaveAttribute('aria-busy', 'true');
    await expect(linea(page)).toContainText('Última lectura FLIT 2');
    soltar();
    await expect(linea(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(linea(page)).toContainText(/2026/);
    await expect(linea(page)).toContainText('· lectura atrasada');
    await expect(linea(page)).toContainText('Quedan trámites por leer; la lectura automática sigue donde quedó.');
    await expect(aviso(page)).toHaveCount(0);
    // La línea va junto a su botón, justo antes de él.
    await expect(page.locator('[data-testid="linea-estado-flit2"] + button')).toHaveText('Sincronizar FLIT 2');
  });

  test('AC1: error del primer GET con Reintentar, que vuelve a llamar y recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 500, { error: CRUDO });
    await abrir(page);
    await expect(linea(page)).toContainText('No se pudo consultar');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    const antes = await asentado(page, ctl);
    ctl.set(200, SANO);
    await page.getByRole('button', { name: 'Reintentar la consulta del estado de FLIT 2' }).click();
    await expect(linea(page)).toContainText(/2026/);
    await expect(linea(page)).not.toContainText('No se pudo consultar');
    expect(ctl.n).toBe(antes + 1);
  });

  test('AC1: sin configurar, con variante según el permiso de guardar el acceso; nunca alerta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, configurado: false, motivoSinConfigurar: 'sin_acceso', ultimaExitosaEn: null, alerta: true });
    await abrir(page);
    await expect(linea(page)).toContainText('Sin configurar');
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText('FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en Acceso a FLIT 2.');
    await expect(page.getByText('FLIT 2 lleva más de 30 minutos')).toHaveCount(0);
  });

  test('AC1: sin configurar y sin permiso de guardar pide a un administrador; «ambiente» tiene su copy', async ({ page }) => {
    const sinGuardar = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'tramites.flit2.guardar_acceso');
    await loginAs(page, { ...OPERACIONES_USER, funciones: sinGuardar });
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, configurado: false, motivoSinConfigurar: 'sin_acceso', ultimaExitosaEn: null });
    await abrir(page);
    await expect(aviso(page)).toHaveText(
      'FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Pídele a un administrador que configure el acceso.',
    );
    ctl.set(200, { ...SANO, configurado: false, motivoSinConfigurar: 'ambiente', ultimaExitosaEn: null });
    await volverALaPestana(page);
    await expect(aviso(page)).toHaveText('FLIT 2 no está configurado en este servidor. Avísale a quien administra el ambiente.');
  });

  test('AC5 + AC3: alerta con rechazo (hora y qué hacer); se va con una lectura exitosa', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(45), alerta: true,
      problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'credenciales' },
    });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(aviso(page)).toContainText('FLIT 2 lleva más de 30 minutos sin leer trámites.');
    await expect(aviso(page)).toContainText(/Última lectura exitosa: .*2026.*\./);
    await expect(aviso(page)).toContainText(/FLIT 2 rechazó el acceso guardado a las \d{1,2}:\d{2}.*\. Revisa el usuario y la contraseña en Acceso a FLIT 2\./);
    await expect(aviso(page).getByRole('button')).toHaveCount(0);
    await expect(page.getByText(/credenciales/)).toHaveCount(0);
    ctl.set(200, SANO);
    await volverALaPestana(page);
    await expect(aviso(page)).toHaveCount(0);
  });

  test('AC5: un refresco silencioso que falla no quita la alerta ni pinta error', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, ultimaExitosaEn: null, alerta: true });
    await abrir(page);
    await expect(aviso(page)).toContainText('Todavía no hay ninguna lectura exitosa.');
    await expect(aviso(page)).toContainText('Pulsa Sincronizar FLIT 2 para intentarlo ahora; si no lee, revisa Acceso a FLIT 2.');
    const antes = await asentado(page, ctl);
    ctl.set(500, { error: CRUDO });
    await volverALaPestana(page);
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await page.waitForTimeout(200);
    await expect(aviso(page)).toContainText('FLIT 2 lleva más de 30 minutos sin leer trámites.');
    await expect(linea(page)).not.toContainText('No se pudo consultar');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });

  test('AC3: bloqueo con hora de fin; sin alerta el aviso es de estado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, problema: { ...PROBLEMA, tipo: 'bloqueado', hasta: dentro(20) } });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText(
      /^FLIT 2 bloqueó el acceso por intentos fallidos a las .+, hasta las .+\. FLITO vuelve a leer solo después; no hace falta hacer nada\.$/,
    );
    await expect(page.getByText(/bloqueado/)).toHaveCount(0);
  });

  test('AC6: los códigos de lectura se traducen; nunca el código crudo ni el texto del API', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, error: CRUDO, problema: { ...PROBLEMA, codigo: 'invalid_cursor' } });
    await abrir(page);
    await expect(aviso(page)).toContainText(
      /^La lectura de las .+ falló: FLIT 2 no reconoció el punto donde iba la lectura\. FLITO no avanza para no perder trámites\. Avísale a soporte técnico\.$/,
    );
    await expect(page.getByText(/invalid_cursor/)).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    ctl.set(200, { ...SANO, problema: { ...PROBLEMA, codigo: 'codigo_raro_e2e' } });
    await volverALaPestana(page);
    await expect(aviso(page)).toHaveText(/^La lectura de las .+ falló en FLITO\. Se reintenta sola; si se repite, avísale a soporte técnico\.$/);
    await expect(page.getByText(/codigo_raro_e2e/)).toHaveCount(0);
  });

  test('AC4: PII enmascarada con conteo, sin datos del trámite; con 1 va en singular', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, piiEnmascarada: { tramites: 12, desde: hace(60) } });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText(
      '12 trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en espera. '
      + 'Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio; al habilitarlo, FLITO los vuelve a leer solo.',
    );
    ctl.set(200, { ...SANO, piiEnmascarada: { tramites: 1, desde: hace(60) } });
    await volverALaPestana(page);
    await expect(aviso(page)).toHaveText(/^1 trámite de FLIT 2 llegó sin los datos del comprador/);
  });

  test('onIntento: tras «Sincronizar FLIT 2», aunque falle, se vuelve a consultar el estado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, SANO);
    await page.route(RUTA_SINCRONIZAR, (r) => json(r, 503, { error: CRUDO, codigo: 'rechazado' }));
    await abrir(page);
    const antes = await asentado(page, ctl);
    await page.getByRole('button', { name: 'Sincronizar FLIT 2' }).click();
    await expect.poll(() => ctl.n).toBe(antes + 1);
  });

  test('Polling: cada 2 minutos con la pestaña visible; en segundo plano se pausa y al volver consulta', async ({ page }) => {
    await page.clock.install();
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, SANO);
    await abrir(page);
    const antes = await asentado(page, ctl);
    await page.clock.fastForward('02:01');
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward('04:05');
    await page.waitForTimeout(300);
    expect(ctl.n).toBe(antes + 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => ctl.n).toBe(antes + 2);
  });
});
