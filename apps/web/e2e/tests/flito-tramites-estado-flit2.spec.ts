import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, FUNCIONES_POR_ROL } from '../helpers/auth';
import { expandirSincronizacionSiHay } from '../helpers/sincronizacion';

// FLITO — Gestión Trámites · estado de la conexión con FLIT 2 (HU #13098, #13189, #13634) simplificado
// por la HU #13678: el grupo dice solo «Conexión» y «Última actualización»; si no hay conexión, un aviso
// con motivo y acción. Sin frecuencia, próxima lectura, cuentas ni reintentos. Backend mockeado: se
// verifica el cableado de la UI contra `GET /api/flito/sync/flit2/estado` (`Flit2EstadoConexion`).

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
  ultimaExitosaEn: hace(3), ultimoIntentoEn: hace(3), ultimoAvisoEn: null,
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
const conexion = (page: Page) => page.getByTestId('conexion-flit2');
const actualizacion = (page: Page) => page.getByTestId('ultima-actualizacion-flit2');
const motivo = (page: Page) => page.getByTestId('motivo-conexion-flit2');
const accion = (page: Page) => page.getByTestId('accion-conexion-flit2');
const botonFlit2 = (page: Page) => page.getByRole('button', { name: 'Sincronizar FLIT 2' });
/** Mecánica de la lectura que la HU #13678 saca del grupo FLIT 2 (en ningún estado). */
const MECANICA = [
  /cada \d+ min/, /próxima en/i, /Próxima lectura/, /Leyendo FLIT 2 ahora/, /reintenta en/, /lectura atrasada/,
  /cada pocos minutos/, /vuelve a intentarlo en/, /Última lectura buena/, /Último aviso/, /\d+:\d{2}(?!\s?[ap]\.)/,
];
async function sinMecanica(page: Page) {
  const texto = (await page.getByTestId('grupo-flit2').innerText()).replace(/\s+/g, ' ');
  for (const re of MECANICA) expect(texto, `no debe aparecer ${re}`).not.toMatch(re);
}

async function abrir(page: Page) {
  await page.goto('/flito/tramites');
  await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
  // HU #13238: la sección Sincronización es un acordeón contraído; sin ella (sin permisos) no hay nada.
  await expandirSincronizacionSiHay(page);
}

/** Simula volver a la pestaña: dispara `visibilitychange` con la pestaña visible (GET silencioso). */
async function volverALaPestana(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test.describe('FLITO — Gestión Trámites · estado de FLIT 2 (HU #13098 · #13678)', () => {
  test('AC6: sin «sync.sync.ver_estado» no hay línea, ni aviso, ni GET', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, alerta: true });
    await abrir(page);
    await expect(page.getByText('Última actualización')).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
    expect(ctl.n).toBe(0);
  });

  test('AC6: admin sin la función tampoco pinta nada ni consulta', async ({ page }) => {
    const sinEstado = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'sync.sync.ver_estado');
    await loginAs(page, { ...OPERACIONES_USER, funciones: sinEstado });
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, alerta: true });
    await abrir(page);
    await expect(page.getByTestId('grupo-flit1')).toBeVisible();
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

  // ── HU #13678: solo conexión y última actualización ───────────────────────────────────────────

  test('#13678 AC1: sano → «Conectado» y «Última actualización» = la más reciente (aviso o lectura); sin la mecánica', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    // El aviso es el más reciente: «Última actualización» es su hora (hoy, 1 min).
    const ctl = await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: '2026-10-01T15:00:00.000Z', ultimoAvisoEn: hace(1), atrasada: true,
      automatica: auto({ proximaEn: dentro(3) }),
    });
    await abrir(page);
    await expect(linea(page)).toContainText('Conexión');
    await expect(conexion(page)).toHaveText('Conectado');
    await expect(conexion(page)).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('punto-flit2')).toHaveAttribute('aria-hidden', 'true');
    await expect(linea(page)).toContainText('Última actualización');
    await expect(actualizacion(page)).toHaveText(/^hoy a las \d{1,2}:\d{2}\s?[ap]\.\s?m\.$/);
    await expect(aviso(page)).toHaveCount(0);
    await sinMecanica(page);
    // Solo el valor de «Conexión» es región viva: «Última actualización» queda fuera.
    await expect(page.getByTestId('grupo-flit2').getByRole('status')).toHaveCount(1);
    // La lectura es la más reciente (el aviso es viejo): «Última actualización» toma su fecha.
    ctl.set(200, { ...SANO, ultimaExitosaEn: '2026-10-02T20:24:00.000Z', ultimoAvisoEn: '2026-10-01T15:00:00.000Z' });
    await volverALaPestana(page);
    await expect(actualizacion(page)).toHaveText(/^el 2 (de )?oct\.? (de )?2026 a las 3:24\s?p\.\s?m\.$/);
    // Una lectura en curso no cambia el valor ni pinta «Leyendo…».
    ctl.set(200, { ...SANO, automatica: auto({ enCurso: true }) });
    await volverALaPestana(page);
    await expect(conexion(page)).toHaveText('Conectado');
    await sinMecanica(page);
    await expect(botonFlit2(page)).toHaveCount(0);
  });

  test('#13678 AC1: vacío → «Conectado» y «Aún sin datos»; cargando trae los dos rótulos con aria-busy', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_ESTADO, async (r) => { await pendiente; return json(r, 200, { ...SANO, ultimaExitosaEn: null, ultimoAvisoEn: null }); });
    await abrir(page);
    await expect(linea(page)).toHaveAttribute('aria-busy', 'true');
    await expect(linea(page).locator('.animate-pulse')).toHaveCount(2);
    await expect(linea(page)).toContainText('Conexión');
    await expect(linea(page)).toContainText('Última actualización');
    soltar();
    await expect(linea(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(conexion(page)).toHaveText('Conectado');
    await expect(actualizacion(page)).toHaveText('Aún sin datos');
    await expect(aviso(page)).toHaveCount(0);
  });

  test('#13678 AC1: error del primer GET con Reintentar, que vuelve a llamar y recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 500, { error: CRUDO });
    await abrir(page);
    await expect(linea(page)).toContainText('No se pudo consultar');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    const antes = await asentado(page, ctl);
    ctl.set(200, SANO);
    await page.getByRole('button', { name: 'Reintentar la consulta del estado de FLIT 2' }).click();
    await expect(conexion(page)).toHaveText('Conectado');
    await expect(linea(page)).not.toContainText('No se pudo consultar');
    expect(ctl.n).toBe(antes + 1);
  });

  test('#13678 AC2: rechazo con alerta → «Sin conexión», motivo en rojo, acción y «Requiere atención»; se va con una lectura buena', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, {
      ...SANO, ultimaExitosaEn: hace(45), alerta: true, problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'credenciales' },
    });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Sin conexión');
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    // Bug #13198: el rechazo gana al atraso aunque pase el umbral.
    await expect(motivo(page)).toHaveText('FLIT 2 rechazó el usuario y la contraseña guardados.');
    await expect(accion(page)).toHaveText('Revísalos en Acceso a FLIT 2.');
    const rojo = await page.evaluate(() => {
      const el = document.createElement('span');
      el.style.color = 'var(--flit-danger-text)';
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    });
    expect(await motivo(page).evaluate((el) => getComputedStyle(el).color)).toBe(rojo);
    await expect(aviso(page).getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('alerta-resumen-flit2')).toHaveText('Requiere atención');
    await expect(page.getByText(/credenciales/)).toHaveCount(0);
    await sinMecanica(page);
    ctl.set(200, SANO);
    await volverALaPestana(page);
    await expect(conexion(page)).toHaveText('Conectado');
    await expect(aviso(page)).toHaveCount(0);
    await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
  });

  test('#13678 AC2: cada motivo trae su acción, sin código, sin cuentas ni «cada pocos minutos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const casos: Array<{ dato: Record<string, unknown>; motivo: string | RegExp; accion: string; alerta: boolean }> = [
      { dato: { alerta: true, problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'cambio_clave' } },
        motivo: 'FLIT 2 pide cambiar la contraseña del usuario de servicio.', accion: 'Cámbiala en FLIT 2 y guárdala de nuevo en Acceso a FLIT 2.', alerta: true },
      { dato: { alerta: true, problema: { ...PROBLEMA, tipo: 'rechazado', motivo: 'otro_e2e' } },
        motivo: 'FLIT 2 rechazó el acceso de FLITO.', accion: 'Revisa Acceso a FLIT 2; «Probar conexión» te dice la causa.', alerta: true },
      { dato: { problema: { ...PROBLEMA, tipo: 'bloqueado', hasta: dentro(20) } },
        motivo: /^FLIT 2 bloqueó el acceso por intentos fallidos hasta las \d{1,2}:\d{2}\s?[ap]\.\s?m\.$/,
        accion: 'No hace falta hacer nada: FLITO vuelve a leer solo después.', alerta: false },
      { dato: { alerta: true, problema: { ...PROBLEMA, tipo: 'bloqueado', hasta: null } },
        motivo: 'FLIT 2 bloqueó el acceso por intentos fallidos.', accion: 'FLITO lo vuelve a intentar solo. Si no se resuelve, revisa Acceso a FLIT 2.', alerta: true },
      { dato: { alerta: true, problema: { tipo: 'avisos_firma', codigo: null, motivo: null, en: null, hasta: null } },
        motivo: 'FLIT 2 está enviando avisos con firma no válida y FLITO los rechaza.',
        accion: 'Avísale a quien administra el ambiente: la clave compartida de los avisos debe ser la misma en FLIT 2 y en FLITO.', alerta: true },
      { dato: { problema: { ...PROBLEMA, codigo: 'invalid_cursor' } },
        motivo: 'FLIT 2 no reconoció el punto donde iba la lectura; FLITO no avanza para no perder trámites.', accion: 'Avísale a soporte técnico.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'insufficient_scope' } },
        motivo: 'El usuario de servicio no tiene permiso para leer trámites en FLIT 2.', accion: 'Pídele a FLIT 2 que lo habilite.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'espera' } },
        motivo: 'FLIT 2 pidió esperar antes de seguir.', accion: 'No hace falta hacer nada: la lectura sigue donde quedó.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'no_responde' } },
        motivo: 'FLIT 2 no respondió.', accion: 'FLITO lo vuelve a intentar solo. Si sigue así, avísale a quien administra el ambiente.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'flit2_respuesta' } },
        motivo: 'FLIT 2 respondió de forma inesperada.', accion: 'Si sigue así, avísale a soporte técnico.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'llave_maestra' } },
        motivo: 'El servidor no pudo leer el acceso guardado.', accion: 'Avísale a quien administra el ambiente.', alerta: false },
      { dato: { problema: { ...PROBLEMA, codigo: 'codigo_raro_e2e' } },
        motivo: 'Falló la última lectura de FLIT 2 en FLITO.', accion: 'Si sigue así, avísale a soporte técnico.', alerta: false },
      { dato: { alerta: true, problema: { tipo: 'xyz_e2e', codigo: 'cod_e2e', motivo: null, en: hace(1), hasta: null } },
        motivo: 'Hay un problema con la conexión a FLIT 2.', accion: 'Si sigue así, avísale a soporte técnico.', alerta: true },
    ];
    const ctl = await mockEstado(page, 200, SANO);
    await abrir(page);
    await expect(conexion(page)).toHaveText('Conectado');
    for (const c of casos) {
      ctl.set(200, { ...SANO, error: CRUDO, ...c.dato });
      await volverALaPestana(page);
      await expect(motivo(page)).toHaveText(c.motivo);
      await expect(accion(page)).toHaveText(c.accion);
      await expect(conexion(page)).toHaveText('Sin conexión');
      await expect(aviso(page)).toHaveAttribute('role', c.alerta ? 'alert' : 'status');
      await sinMecanica(page);
    }
    expect(await page.content()).not.toMatch(/invalid_cursor|insufficient_scope|no_responde|flit2_respuesta|llave_maestra|codigo_raro_e2e|xyz_e2e|cod_e2e|avisos_firma|otro_e2e/);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });

  test('#13678 AC2: «espera» (429) sin alerta → «Sin conexión» sin «Requiere atención»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, alerta: false, problema: { ...PROBLEMA, codigo: 'espera' } });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Sin conexión');
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
  });

  test('#13678 AC2: atraso por umbral U = 2R + 5 min (R = 5 → 15 minutos; R = 60 → 2 h 5 min) con su acción', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, ultimaExitosaEn: hace(20), alerta: true, automatica: auto({ proximaEn: dentro(3) }) });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Sin conexión');
    await expect(aviso(page)).toHaveAttribute('role', 'alert');
    await expect(motivo(page)).toHaveText('FLITO lleva más de 15 minutos sin leer trámites de FLIT 2.');
    await expect(accion(page)).toHaveText('Revisa Acceso a FLIT 2; si el acceso está bien, avísale a quien administra el ambiente.');
    await expect(page.getByTestId('alerta-resumen-flit2')).toHaveText('Requiere atención');
    await sinMecanica(page);
    // Bug #13198: con problema de lectura y lectura reciente manda el problema, no el atraso.
    ctl.set(200, { ...SANO, ultimaExitosaEn: hace(10), alerta: true, problema: { ...PROBLEMA, codigo: 'no_responde', en: hace(1) } });
    await volverALaPestana(page);
    await expect(motivo(page)).toHaveText('FLIT 2 no respondió.');
    ctl.set(200, { ...SANO, ultimaExitosaEn: hace(130), alerta: true, automatica: auto({ intervaloMs: 3_600_000 }) });
    await volverALaPestana(page);
    await expect(motivo(page)).toHaveText('FLITO lleva más de 2 h 5 min sin leer trámites de FLIT 2.');
    // Sin intervalo conocido no se afirma un tiempo.
    ctl.set(200, { ...SANO, ultimaExitosaEn: null, alerta: true, automatica: auto({ intervaloMs: null }) });
    await volverALaPestana(page);
    await expect(motivo(page)).toHaveText('FLITO no ha leído trámites de FLIT 2 en el tiempo esperado.');
    await expect(actualizacion(page)).toHaveText('Aún sin datos');
  });

  test('#13678 AC2: un refresco silencioso que falla no quita «Sin conexión» ni pinta error', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, ultimaExitosaEn: hace(45), alerta: true });
    await abrir(page);
    await expect(motivo(page)).toHaveText('FLITO lleva más de 15 minutos sin leer trámites de FLIT 2.');
    const antes = await asentado(page, ctl);
    ctl.set(500, { error: CRUDO });
    await volverALaPestana(page);
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await page.waitForTimeout(200);
    await expect(conexion(page)).toHaveText('Sin conexión');
    await expect(motivo(page)).toHaveText('FLITO lleva más de 15 minutos sin leer trámites de FLIT 2.');
    await expect(linea(page)).not.toContainText('No se pudo consultar');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });

  test('#13678 AC3: sin configurar → «Sin configurar» sin «Última actualización», con variante según el permiso; nunca alerta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, { ...SANO, configurado: false, motivoSinConfigurar: 'sin_acceso', ultimaExitosaEn: null, alerta: true });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Sin configurar');
    await expect(actualizacion(page)).toHaveCount(0);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText('FLIT 2 sin configurar: FLITO aún no lee trámites de FLIT 2. Configura el acceso en Acceso a FLIT 2.');
    await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Acceso a FLIT 2' })).toBeVisible();
  });

  test('#13678 AC3: sin configurar y sin permiso de guardar pide a un administrador; «ambiente» tiene su copy', async ({ page }) => {
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

  test('#13678 AC3: apagada en el servidor (lectura automática apagada) dice «Apagada en el servidor» sin motivo de conexión', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const apagada = { activa: false, intervaloMs: null, proximaEn: null, enCurso: false, generadoEn: new Date().toISOString() };
    await mockEstado(page, 200, { ...SANO, automatica: apagada, problema: { ...PROBLEMA, codigo: 'no_responde' } });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Apagada en el servidor');
    await expect(motivo(page)).toHaveCount(0);
    await sinMecanica(page);
  });

  test('#13678 AC3: compradores sin datos personales se conserva (plural y singular), también con «Sin conexión»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, piiEnmascarada: { tramites: 12, desde: hace(60) } });
    await abrir(page);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveText(
      '12 trámites de FLIT 2 llegaron sin los datos del comprador: su SOAT y sus impuestos quedan en espera. '
      + 'Pídele a FLIT 2 que habilite el permiso de datos personales para el usuario de servicio; al habilitarlo, FLITO los vuelve a leer solo.',
    );
    ctl.set(200, { ...SANO, piiEnmascarada: { tramites: 1, desde: hace(60) }, problema: { ...PROBLEMA, codigo: 'no_responde' } });
    await volverALaPestana(page);
    await expect(motivo(page)).toHaveText('FLIT 2 no respondió.');
    await expect(aviso(page)).toContainText('1 trámite de FLIT 2 llegó sin los datos del comprador');
  });

  test('#13678 AC3: «Acceso a FLIT 2» sigue; al guardar el toast depende de la lectura automática y se reconsulta el estado', async ({ page }) => {
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

  test('#13678 AC4: el grupo FLIT 1 no lleva «Conexión» ni «Última actualización» (no se modifica)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, SANO);
    await abrir(page);
    await expect(conexion(page)).toHaveText('Conectado');
    const g1 = page.getByTestId('grupo-flit1');
    await expect(g1).toBeVisible();
    await expect(g1).toContainText('FLIT 1');
    await expect(g1.getByTestId('conexion-flit2')).toHaveCount(0);
    await expect(g1).not.toContainText('Última actualización');
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

  test('Ritmo rápido (HU #13189 AC4): con una lectura en curso consulta cada 15 s; vencida la próxima, un GET ~10 s después', async ({ page }) => {
    await page.clock.install();
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    const ctl = await mockEstado(page, 200, { ...SANO, automatica: auto({ enCurso: true }) });
    await abrir(page);
    await expect(conexion(page)).toHaveText('Conectado');
    const antes = await asentado(page, ctl);
    ctl.set(200, { ...SANO, automatica: auto({ proximaEn: dentro(1) }) });
    await page.clock.fastForward('00:16');
    await expect.poll(() => ctl.n).toBe(antes + 1);
    await page.clock.fastForward('00:50');
    await page.waitForTimeout(200);
    expect(ctl.n).toBe(antes + 1);
    await page.clock.fastForward('00:25');
    await expect.poll(() => ctl.n).toBe(antes + 2);
    await sinMecanica(page);
  });

  test('#13678: a 375 px los pares se apilan sin desborde horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page);
    await mockEstado(page, 200, {
      ...SANO, ultimoAvisoEn: hace(1), alerta: true,
      problema: { tipo: 'avisos_firma', codigo: null, motivo: null, en: null, hasta: null },
    });
    await abrir(page);
    await expect(aviso(page)).toBeVisible();
    await expect(actualizacion(page)).toBeVisible();
    // Se mide el grupo FLIT 2 (lo que toca esta HU): ningún descendiente pasa del borde de la ventana.
    const desborde = await page.evaluate(() => {
      const bordes = [...document.querySelectorAll('[data-testid="grupo-flit2"] *')].map((el) => el.getBoundingClientRect().right);
      return { max: Math.max(...bordes), vw: window.innerWidth };
    });
    expect(desborde.max).toBeLessThanOrEqual(desborde.vw);
    const cajaGrupo = await page.getByTestId('grupo-flit2').boundingBox();
    const cajaLinea = await linea(page).boundingBox();
    expect(cajaGrupo && cajaLinea && cajaLinea.x + cajaLinea.width <= cajaGrupo.x + cajaGrupo.width + 1).toBeTruthy();
  });
});
