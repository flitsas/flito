import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

// FLITO — Gestión Trámites · estado de la conexión con FLIT 2 (HU #13098) y lectura en vivo sin el
// botón «Sincronizar FLIT 2» (HU #13189). Backend mockeado: se verifica el cableado de la UI contra
// `GET /api/flito/sync/flit2/estado` (`Flit2EstadoConexion`, con `automatica` de la HU #13188).

const RUTA_ESTADO = /\/api\/flito\/sync\/flit2\/estado$/;
const RUTA_ACCESO = /\/api\/flito\/sync\/flit2\/acceso$/;
/** Texto del campo `error` del API: nunca debe llegar a la pantalla. */
const CRUDO = 'ERROR-CRUDO-e2e-13098';

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dentro = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

/** Pulso de la lectura automática (HU #13188). `proximaEn` lejos por defecto: no dispara el ritmo rápido. */
function auto(extra: Record<string, unknown> = {}) {
  return { activa: true, intervaloMs: 300_000, proximaEn: dentro(30), enCurso: false, generadoEn: new Date().toISOString(), ...extra };
}

const SANO = {
  configurado: true, motivoSinConfigurar: null,
  ultimaExitosaEn: hace(3), ultimoIntentoEn: hace(3),
  atrasada: false, alerta: false, problema: null,
  piiEnmascarada: { tramites: 0, desde: null },
  automatica: auto(),
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
const indicador = (page: Page) => page.getByTestId('indicador-flit2');
const textoIndicador = (page: Page) => page.getByTestId('texto-indicador-flit2');
const botonFlit2 = (page: Page) => page.getByRole('button', { name: 'Sincronizar FLIT 2' });
/** Cuenta `m:ss` visible. */
const MSS = /\d+:\d{2}/;

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
    await expect(page.getByRole('button', { name: 'Sincronizar FLIT', exact: true })).toBeVisible();
    await expect(botonFlit2(page)).toHaveCount(0);
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
    // HU #13189: sin botón de FLIT 2; el grupo de FLIT 1 sigue igual.
    await expect(botonFlit2(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sincronizar FLIT', exact: true })).toBeVisible();
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
    // Bug #13198: el título dice la causa (rechazo), aunque además pasen 30 minutos.
    await expect(aviso(page)).toContainText('FLIT 2 rechazó el acceso de FLITO.');
    await expect(aviso(page)).not.toContainText('más de 30 minutos');
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
    await expect(aviso(page)).toContainText(/La lectura automática vuelve a intentarlo en \d+:\d{2}unos minutos; si no lee, revisa Acceso a FLIT 2\./);
    await expect(textoIndicador(page)).toHaveText(/^Sin leer hace más de 30 min · reintenta en \d+:\d{2}$/);
    const antes = await asentado(page, ctl);
    ctl.set(500, { error: CRUDO });
    await volverALaPestana(page);
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await page.waitForTimeout(200);
    await expect(aviso(page)).toContainText('FLIT 2 lleva más de 30 minutos sin leer trámites.');
    await expect(linea(page)).not.toContainText('No se pudo consultar');
    await expect(textoIndicador(page)).toHaveText(/^Sin leer hace más de 30 min · reintenta en \d+:\d{2}$/);
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
    // El código `bloqueado` no se pinta en el aviso (la cabecera sí dice «Acceso bloqueado», HU #13189).
    await expect(aviso(page)).not.toContainText('bloqueado');
  });

  test('Bug #13198 (a): bloqueo reciente con alerta → título de bloqueo, no «más de 30 minutos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(2), alerta: true,
      problema: { ...PROBLEMA, tipo: 'bloqueado', en: hace(1), hasta: dentro(20) },
    });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(aviso(page).locator('p').first()).toHaveText('FLIT 2 bloqueó el acceso por un tiempo.');
    await expect(aviso(page)).not.toContainText('más de 30 minutos');
    await expect(aviso(page)).toContainText(/Última lectura exitosa: .+\./);
    await expect(aviso(page)).toContainText(/FLIT 2 bloqueó el acceso por intentos fallidos a las .+, hasta las .+\. FLITO vuelve a leer solo después; no hace falta hacer nada\./);
  });

  test('Bug #13198 (b): rechazo reciente con alerta → título de rechazo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(2), alerta: true,
      problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'credenciales', en: hace(1) },
    });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(aviso(page).locator('p').first()).toHaveText('FLIT 2 rechazó el acceso de FLITO.');
    await expect(aviso(page)).not.toContainText('más de 30 minutos');
    await expect(aviso(page)).toContainText(/Revisa el usuario y la contraseña en Acceso a FLIT 2\./);
  });

  test('Bug #13198 (c): «no_responde» sin alerta → sin tarjeta de alerta; el indicador dice que falló y sin el código', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(2), alerta: false,
      problema: { ...PROBLEMA, codigo: 'no_responde', en: hace(1) }, automatica: auto({ proximaEn: dentro(2) }),
    });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText(/^Falló la última lectura · reintenta en (1:5\d|2:00)$/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText(/^A las .+, FLIT 2 no respondió\. FLITO vuelve a intentarlo solo cada pocos minutos\.$/);
    await expect(page.getByText(/no_responde/)).toHaveCount(0);
  });

  test('Bug #13198 (c2): fallo de lectura con alerta y lectura reciente → título «falló la última lectura»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(10), alerta: true, problema: { ...PROBLEMA, codigo: 'no_responde', en: hace(1) },
    });
    await abrir(page);
    await expect(aviso(page).locator('p').first()).toHaveText('Falló la última lectura de FLIT 2.');
    await expect(aviso(page)).not.toContainText('más de 30 minutos');
    await expect(page.getByText(/no_responde/)).toHaveCount(0);
  });

  test('Bug #13198 (d): ≥30 min sin lectura y sin problema → título «más de 30 minutos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, ultimaExitosaEn: hace(45), alerta: true });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(aviso(page).locator('p').first()).toHaveText('FLIT 2 lleva más de 30 minutos sin leer trámites.');
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

  // ── HU #13189: lectura en vivo ─────────────────────────────────────────────────────────────────

  test('13189 AC1 + AC2 + AC9: encendida con punto y cuenta por segundo; la región viva no lleva la cuenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, automatica: auto({ proximaEn: dentro(3) }) });
    await abrir(page);
    await expect(botonFlit2(page)).toHaveCount(0);
    await expect(linea(page)).toContainText(/2026/);
    await expect(indicador(page)).toHaveAttribute('data-caso', 'encendida');
    await expect(textoIndicador(page)).toHaveText(/^Lectura automática cada 5 min · próxima en (2:5\d|3:00)$/);
    await expect(textoIndicador(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('punto-flit2')).toHaveAttribute('aria-hidden', 'true');
    const status = indicador(page).getByRole('status');
    await expect(status).toHaveText('Lectura automática de FLIT 2 encendida.');
    await expect(indicador(page)).toContainText(/Próxima lectura a las .+\./);
    const primero = await textoIndicador(page).textContent();
    await expect.poll(() => textoIndicador(page).textContent(), { timeout: 4_000 }).not.toBe(primero);
    await expect(status).toHaveText('Lectura automática de FLIT 2 encendida.');
    // El árbol accesible del indicador no lleva la cuenta (solo la frase de estado y la hora absoluta).
    const arbol = await indicador(page).ariaSnapshot();
    expect(arbol).not.toContain('próxima en');
    expect(await status.textContent()).not.toMatch(MSS);
  });

  test('13189 AC2: la cuenta se corrige con generadoEn (reloj del equipo desfasado) y vencida dice «en unos segundos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    // El servidor va 10 min adelante del equipo: la próxima es a 3 min en SU reloj.
    const servidor = Date.now() + 10 * 60_000;
    const ctl = await mockEstado(page, 200, {
      ...SANO, automatica: auto({ generadoEn: new Date(servidor).toISOString(), proximaEn: new Date(servidor + 3 * 60_000).toISOString() }),
    });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText(/próxima en (2:5\d|3:00)$/);
    ctl.set(200, { ...SANO, automatica: auto({ proximaEn: new Date(Date.now() - 50).toISOString() }) });
    await volverALaPestana(page);
    await expect(textoIndicador(page)).toHaveText('Lectura automática cada 5 min · próxima en unos segundos');
    await expect(indicador(page)).toContainText('Próxima lectura en unos segundos.');
  });

  test('13189 AC3 + AC4: en curso dice «Leyendo FLIT 2 ahora…» y consulta cada 15 s; vencida la cuenta, un GET ~10 s después', async ({ page }) => {
    await page.clock.install();
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, automatica: auto({ enCurso: true }) });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText('Leyendo FLIT 2 ahora…');
    await expect(indicador(page).getByRole('status')).toHaveText('Leyendo FLIT 2 ahora.');
    await expect(indicador(page)).not.toContainText(MSS);
    const antes = await asentado(page, ctl);
    // Termina la lectura: la próxima es en 1 min.
    ctl.set(200, { ...SANO, automatica: auto({ proximaEn: dentro(1) }) });
    await page.clock.fastForward('00:16');
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await expect(textoIndicador(page)).toHaveText(/próxima en \d:\d{2}$/);
    // A los 50 s todavía nada; pasado el vencimiento + 10 s, un GET.
    await page.clock.fastForward('00:50');
    await page.waitForTimeout(200);
    expect(ctl.n).toBe(antes + 1);
    await page.clock.fastForward('00:25');
    await expect.poll(() => ctl.n).toBe(antes + 2);
  });

  test('13189 AC3: una lectura en curso gana a «apagada» (precedencia de la spec)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const apagadaLeyendo = { activa: false, intervaloMs: null, proximaEn: null, enCurso: true, generadoEn: new Date().toISOString() };
    await mockEstado(page, 200, { ...SANO, automatica: apagadaLeyendo });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText('Leyendo FLIT 2 ahora…');
    await expect(indicador(page)).not.toContainText('La lectura automática está apagada en este ambiente');
  });

  test('13189 AC5: apagada lo dice sin cuenta; con alerta la tarjeta remite a quien administra el ambiente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const apagada = { activa: false, intervaloMs: null, proximaEn: null, enCurso: false, generadoEn: new Date().toISOString() };
    const ctl = await mockEstado(page, 200, { ...SANO, automatica: apagada });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText('La lectura automática está apagada en este ambiente');
    await expect(indicador(page).getByRole('status')).toHaveText('La lectura automática de FLIT 2 está apagada en este ambiente.');
    await expect(indicador(page)).not.toContainText(MSS);
    await expect(indicador(page)).not.toContainText('Próxima lectura');
    ctl.set(200, { ...SANO, ultimaExitosaEn: hace(45), alerta: true, automatica: apagada });
    await volverALaPestana(page);
    await expect(aviso(page)).toContainText('La lectura automática está apagada en este ambiente. Avísale a quien administra el ambiente.');
  });

  test('13189 AC6: falló por lectura con cuenta; bloqueado con hora de fin; rechazado remite a Acceso a FLIT 2 sin cuenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, error: CRUDO, problema: { ...PROBLEMA, codigo: 'invalid_cursor' }, automatica: auto({ proximaEn: dentro(2) }) });
    await abrir(page);
    await expect(textoIndicador(page)).toHaveText(/^Falló la última lectura · reintenta en (1:5\d|2:00)$/);
    await expect(indicador(page)).toContainText(/Nuevo intento a las .+\./);
    await expect(page.getByText(/invalid_cursor/)).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    ctl.set(200, { ...SANO, problema: { ...PROBLEMA, tipo: 'bloqueado', hasta: dentro(20) } });
    await volverALaPestana(page);
    await expect(textoIndicador(page)).toHaveText(/^Acceso bloqueado · vuelve a leer después de las .+$/);
    await expect(textoIndicador(page)).not.toContainText(/en \d+:\d{2}/);
    ctl.set(200, { ...SANO, problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'credenciales' } });
    await volverALaPestana(page);
    await expect(textoIndicador(page)).toHaveText('Acceso rechazado · revisa Acceso a FLIT 2');
    await expect(indicador(page).getByRole('status')).toHaveText('FLIT 2 rechazó el acceso guardado.');
    await expect(indicador(page)).not.toContainText(MSS);
  });

  test('13189 AC7 + AC9: la tarjeta de alerta da la cuenta a la vista y «unos minutos» al lector', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, ultimaExitosaEn: hace(45), alerta: true, automatica: auto({ proximaEn: dentro(4) }) });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(aviso(page)).toContainText(/La lectura automática vuelve a intentarlo en \d:\d{2}unos minutos; si no lee, revisa Acceso a FLIT 2\./);
    await expect(aviso(page)).not.toContainText('Pulsa');
    const arbol = await aviso(page).ariaSnapshot();
    expect(arbol).toContain('vuelve a intentarlo en unos minutos');
    expect(arbol).not.toMatch(/intentarlo en \d/);
  });

  test('13189 AC8: sin configurar no hay punto ni cuenta; el esqueleto trae dos barras', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_ESTADO, async (r) => {
      await pendiente;
      return json(r, 200, { ...SANO, configurado: false, motivoSinConfigurar: 'sin_acceso', ultimaExitosaEn: null });
    });
    await abrir(page);
    await expect(linea(page).locator('.animate-pulse')).toHaveCount(2);
    soltar();
    await expect(linea(page)).toContainText('Sin configurar');
    await expect(indicador(page)).toHaveCount(0);
  });

  test('13189 AC10: al guardar el acceso el toast depende de la lectura automática y se reconsulta el estado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, SANO);
    const meta = {
      configurado: true, clientId: 'flito-dev', actualizadoPor: { id: 1, nombre: 'Ana Pérez' },
      actualizadoEn: '2026-09-29T15:42:00.000Z', estado: 'vigente', bloqueadoHasta: null,
    };
    await page.route(RUTA_ACCESO, (r) => json(r, 200, meta));
    await abrir(page);
    const antes = await asentado(page, ctl);
    await page.getByRole('button', { name: 'Acceso a FLIT 2' }).click();
    const panel = page.getByRole('dialog', { name: 'Acceso a FLIT 2' });
    await panel.getByLabel('Usuario de servicio').fill('flito-nuevo');
    await panel.getByLabel('Contraseña').fill('CLAVE-e2e-13189');
    await panel.getByRole('button', { name: 'Guardar acceso' }).click();
    await expect(page.getByRole('status').filter({
      hasText: 'Acceso guardado. La primera lectura empieza en unos segundos; el resultado se ve en el panel de Gestión Trámites.',
    })).toBeVisible();
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
