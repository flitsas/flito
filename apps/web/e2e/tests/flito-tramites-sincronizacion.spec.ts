import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

// FLITO — Gestión Trámites · sección «Sincronización» con interruptor por fuente (HU #13238, Feature
// #13236). Backend mockeado: se verifica el cableado de la UI contra el contrato de la HU #13237
// (`GET/PUT /api/flito/sync/interruptores`, `GET /api/flito/sync/estado`, `GET …/flit2/estado` y el 409
// `FUENTE_APAGADA` de `POST /api/flito/sync/sincronizar`).

const RUTA_INTER = /\/api\/flito\/sync\/interruptores$/;
const RUTA_PUT = /\/api\/flito\/sync\/interruptores\/(flit1|flit2)$/;
const RUTA_ESTADO1 = /\/api\/flito\/sync\/estado$/;
const RUTA_ESTADO2 = /\/api\/flito\/sync\/flit2\/estado$/;
const RUTA_SYNC = /\/api\/flito\/sync\/sincronizar$/;
/** Texto crudo del API: nunca debe llegar a la pantalla. */
const CRUDO = 'ERROR-CRUDO-e2e-13238';

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dentro = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

type Fuente = 'flit1' | 'flit2';
interface Inter { fuente: Fuente; encendido: boolean; actualizadoEn: string | null; actualizadoPor: { id: number; nombre: string } | null }

const inter = (fuente: Fuente, encendido: boolean, conQuien = true): Inter => ({
  fuente, encendido,
  actualizadoEn: conQuien ? hace(5) : null,
  actualizadoPor: conQuien ? { id: 1, nombre: 'Ana Pérez' } : null,
});

const estado1 = (habilitada = true, ultima: string | null = hace(10)) => ({
  habilitada, motivoDeshabilitada: habilitada ? null : 'interruptor', ultimaSincronizacion: ultima, hayTramites: true,
});

const estado2 = (extra: Record<string, unknown> = {}) => ({
  habilitada: true, motivoDeshabilitada: null,
  configurado: true, motivoSinConfigurar: null,
  ultimaExitosaEn: hace(3), ultimoIntentoEn: hace(3),
  atrasada: false, alerta: false, problema: null,
  piiEnmascarada: { tramites: 0, desde: null },
  automatica: { activa: true, intervaloMs: 300_000, proximaEn: dentro(4), enCurso: false, generadoEn: new Date().toISOString() },
  ...extra,
});

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Escenario {
  f1?: boolean; f2?: boolean; maestro?: boolean;
  e1?: ReturnType<typeof estado1>; e2?: ReturnType<typeof estado2>;
  getStatus?: number;
}

/** Monta todos los mocks y devuelve un control con contadores y respuestas cambiables. */
async function mockear(page: Page, esc: Escenario = {}) {
  const ctl = {
    inter: { fuentes: [inter('flit1', esc.f1 ?? true), inter('flit2', esc.f2 ?? true)], maestroFlit2: esc.maestro ?? true },
    getStatus: esc.getStatus ?? 200,
    e1: esc.e1 ?? estado1(),
    e2: esc.e2 ?? estado2(),
    gets: 0, gets1: 0, puts: [] as { fuente: string; encendido: boolean }[], posts: 0,
    putStatus: 200,
    /** Si está, el PUT espera a que se resuelva. */
    retenerPut: null as Promise<void> | null,
    syncStatus: 200,
    syncBody: { tramitesNuevos: 3, tramitesActualizados: 2, companiasFaltantes: 1, organismosSinEmparejar: 0, ultimaSincronizacion: new Date().toISOString() } as unknown,
  };
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => json(r, 200, { estados: [], tramites: [], ciudades: [], transitos: [] }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(RUTA_INTER, (r) => { ctl.gets += 1; return json(r, ctl.getStatus, ctl.getStatus === 200 ? ctl.inter : { error: CRUDO }); });
  await page.route(RUTA_PUT, async (r) => {
    const fuente = RUTA_PUT.exec(r.request().url())![1] as Fuente;
    const { encendido } = r.request().postDataJSON() as { encendido: boolean };
    ctl.puts.push({ fuente, encendido });
    if (ctl.retenerPut) await ctl.retenerPut;
    if (ctl.putStatus !== 200) return json(r, ctl.putStatus, { error: CRUDO, codigo: 'X' });
    const nuevo: Inter = { fuente, encendido, actualizadoEn: new Date().toISOString(), actualizadoPor: { id: 7, nombre: 'Operaciones E2E' } };
    ctl.inter = { ...ctl.inter, fuentes: ctl.inter.fuentes.map((f) => (f.fuente === fuente ? nuevo : f)) };
    if (fuente === 'flit1') ctl.e1 = estado1(encendido, ctl.e1.ultimaSincronizacion);
    else ctl.e2 = { ...ctl.e2, habilitada: encendido && ctl.inter.maestroFlit2, motivoDeshabilitada: !ctl.inter.maestroFlit2 ? 'maestro' : encendido ? null : 'interruptor' };
    return json(r, 200, nuevo);
  });
  await page.route(RUTA_ESTADO1, (r) => { ctl.gets1 += 1; return json(r, 200, ctl.e1); });
  await page.route(RUTA_ESTADO2, (r) => json(r, 200, ctl.e2));
  await page.route(RUTA_SYNC, (r) => { ctl.posts += 1; return json(r, ctl.syncStatus, ctl.syncBody); });
  return ctl;
}

const seccion = (page: Page) => page.getByTestId('seccion-sincronizacion');
const grupo = (page: Page, f: Fuente) => page.getByTestId(`grupo-${f}`);
const sw = (page: Page, f: Fuente) => page.getByRole('switch', { name: `Recibir trámites de ${f === 'flit1' ? 'FLIT 1' : 'FLIT 2'}` });
const botonSync = (page: Page) => page.getByRole('button', { name: 'Sincronizar FLIT', exact: true });
const botonAcceso = (page: Page) => page.getByRole('button', { name: 'Acceso a FLIT 2', exact: true });

async function abrir(page: Page) {
  await page.goto('/flito/tramites');
  await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
  await expect(seccion(page)).not.toHaveAttribute('aria-busy', 'true');
}

test.describe('FLITO — Gestión Trámites · sección Sincronización (HU #13238)', () => {
  test('AC1 + AC6: dos grupos rotulados con su interruptor, estado y quién/cuándo; una sola primaria; h-10 y barras alineadas a 1366', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await loginAs(page, OPERACIONES_USER);
    await mockear(page);
    await abrir(page);

    await expect(seccion(page).getByRole('heading', { level: 2, name: 'Sincronización' })).toBeVisible();
    await expect(grupo(page, 'flit1').getByRole('heading', { level: 3, name: 'FLIT 1' })).toBeVisible();
    await expect(grupo(page, 'flit2').getByRole('heading', { level: 3, name: 'FLIT 2' })).toBeVisible();
    for (const f of ['flit1', 'flit2'] as const) {
      await expect(sw(page, f)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId(`estado-fuente-${f}`)).toHaveText('Encendida');
      await expect(page.getByTestId(`quien-cuando-${f}`)).toHaveText(/^Encendida por Ana Pérez hoy a las /);
    }
    // La cabecera ya no carga la sincronización: el botón y el acceso viven en su grupo.
    await expect(grupo(page, 'flit1').getByRole('button', { name: 'Sincronizar FLIT', exact: true })).toBeVisible();
    await expect(grupo(page, 'flit2').getByRole('button', { name: 'Acceso a FLIT 2', exact: true })).toBeVisible();
    await expect(grupo(page, 'flit2').getByTestId('linea-estado-flit2')).toBeVisible();
    await expect(grupo(page, 'flit2').getByTestId('indicador-flit2')).toBeVisible();
    // Una sola primaria (gradiente) en toda la zona.
    const primarias = await seccion(page).locator('button').evaluateAll(
      (bs) => bs.filter((b) => (b as HTMLElement).style.background.includes('gradient')).length,
    );
    expect(primarias).toBe(1);
    // Lado a lado y con las barras alineadas (mismo borde inferior), una sola altura de control.
    const b1 = (await botonSync(page).boundingBox())!;
    const b2 = (await botonAcceso(page).boundingBox())!;
    expect(b1.height).toBe(40);
    expect(b2.height).toBe(40);
    expect(Math.abs((b1.y + b1.height) - (b2.y + b2.height))).toBeLessThanOrEqual(1);
    const g1 = (await grupo(page, 'flit1').boundingBox())!;
    const g2 = (await grupo(page, 'flit2').boundingBox())!;
    expect(g2.x).toBeGreaterThan(g1.x + g1.width - 1);
    expect((await sw(page, 'flit1').boundingBox())!.height).toBe(40);
    await expect(grupo(page, 'flit1').getByText('Elegir fecha')).toBeVisible();
    expect(await grupo(page, 'flit1').locator('label:has-text("Elegir fecha")').evaluate((e) => e.getBoundingClientRect().height)).toBe(40);
  });

  test('AC1: apagar FLIT 1 pide confirmación con el foco en Cancelar; confirma tras la respuesta con «Guardando…» y un toast cerrable', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page);
    await abrir(page);

    await sw(page, 'flit1').click();
    const dialogo = page.getByRole('dialog', { name: '¿Apagar FLIT 1?' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText('nadie puede usar «Sincronizar FLIT»');
    await expect(dialogo.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(sw(page, 'flit1')).toBeFocused();
    expect(ctl.puts).toHaveLength(0);

    let soltar: () => void = () => {};
    ctl.retenerPut = new Promise<void>((res) => { soltar = res; });
    await sw(page, 'flit1').click();
    await page.getByRole('button', { name: 'Apagar FLIT 1' }).click();
    // No optimista: ocupado, «Guardando…», conserva el valor y no pierde el foco.
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-busy', 'true');
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-disabled', 'true');
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('Guardando…');
    await sw(page, 'flit1').click({ force: true }); // ocupado: no hace nada
    expect(ctl.puts).toEqual([{ fuente: 'flit1', encendido: false }]);
    soltar();
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'flit1')).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw(page, 'flit1')).toBeFocused();
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('Apagada');
    await expect(page.getByTestId('quien-cuando-flit1')).toHaveText(/^Apagada por Operaciones E2E hoy a las /);
    const toast = page.getByRole('status').filter({ hasText: 'FLIT 1 quedó apagada' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(toast).toHaveCount(0);
    // El motivo y el botón quedan al día.
    await expect(page.getByTestId('motivo-flit1')).toContainText('La sincronización con FLIT 1 está apagada desde Sincronización.');
    await expect(botonSync(page)).toHaveAttribute('aria-disabled', 'true');
  });

  test('AC1 + AC7: encender con teclado (Espacio) no pide confirmación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    await abrir(page);
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'false');
    await sw(page, 'flit2').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'true');
    expect(ctl.puts).toEqual([{ fuente: 'flit2', encendido: true }]);
    await expect(page.getByText('FLIT 2 quedó encendida: la lectura sigue donde quedó en la próxima vuelta automática.')).toBeVisible();
    await expect(page.getByTestId('motivo-flit2')).toHaveCount(0);
  });

  test('AC2: esqueleto mientras carga; error del GET con Reintentar y copy propio; recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { getStatus: 500 });
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_INTER, async (r) => { ctl.gets += 1; await pendiente; return json(r, ctl.getStatus, ctl.getStatus === 200 ? ctl.inter : { error: CRUDO }); });
    await page.goto('/flito/tramites');
    await expect(seccion(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('esqueleto-switch-flit1')).toBeVisible();
    await expect(page.getByTestId('esqueleto-switch-flit2')).toBeVisible();
    soltar();
    const error = page.getByTestId('error-interruptores');
    await expect(error).toContainText('No se pudo consultar los interruptores de sincronización.');
    await expect(error).toHaveAttribute('role', 'alert');
    expect(await error.getAttribute('style')).toContain('--flit-danger-text');
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    // El resto de la zona sigue funcionando.
    await expect(botonSync(page)).toBeEnabled();
    ctl.getStatus = 200;
    await error.getByRole('button', { name: /Reintentar/ }).click();
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'true');
    await expect(error).toHaveCount(0);
  });

  test('AC2: si falla al guardar, el interruptor conserva el valor y sale un toast con copy propio y Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    ctl.putStatus = 500;
    await abrir(page);
    await sw(page, 'flit2').click();
    const toast = page.getByRole('alert').filter({ hasText: 'No se pudo guardar el cambio de FLIT 2. Inténtalo de nuevo.' });
    await expect(toast).toBeVisible();
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('Apagada');
    await expect(sw(page, 'flit2')).toBeFocused();
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    ctl.putStatus = 200;
    await toast.getByRole('button', { name: 'Reintentar' }).click();
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'true');
    expect(ctl.puts).toHaveLength(2);
  });

  test('AC2: un 403 al guardar deja la sección en solo lectura', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    ctl.putStatus = 403;
    await abrir(page);
    await sw(page, 'flit2').click();
    await expect(page.getByText('No tienes permiso para cambiar la sincronización. Pídeselo a un administrador.')).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByTestId('estado-fuente-flit2')).toContainText('Apagada');
  });

  test('AC3: sin la función no hay interruptores ni GET, pero cada grupo dice en texto si está encendida o apagada', async ({ page }) => {
    const sinConfigurar = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'tramites.sincronizacion.configurar');
    await loginAs(page, { ...OPERACIONES_USER, funciones: sinConfigurar });
    const ctl = await mockear(page, { e1: estado1(false) });
    await abrir(page);
    await expect(page.getByRole('switch')).toHaveCount(0);
    expect(ctl.gets).toBe(0);
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('FLIT 1: Apagada');
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('FLIT 2: Encendida');
    await expect(page.getByTestId('quien-cuando-flit1')).toHaveCount(0);
    await expect(page.getByTestId('motivo-flit1')).toContainText('Pídele a un administrador que la encienda.');
  });

  test('AC4: FLIT 1 apagada deshabilita «Sincronizar FLIT» con el motivo junto a él', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f1: false, e1: estado1(false) });
    await abrir(page);
    const motivo = page.getByTestId('motivo-flit1');
    await expect(motivo).toHaveAttribute('role', 'status');
    await expect(motivo).toContainText('La sincronización con FLIT 1 está apagada desde Sincronización.');
    await expect(botonSync(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(botonSync(page)).toHaveAttribute('aria-describedby', 'sync-motivo-flit1');
    // aria-disabled sigue enfocable; un clic forzado no lanza el POST.
    await botonSync(page).click({ force: true });
    await page.waitForTimeout(200);
    expect(ctl.posts).toBe(0);
  });

  test('AC4: un 409 FUENTE_APAGADA muestra el mismo motivo, refresca el estado y no pinta el texto crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page);
    await abrir(page);
    ctl.syncStatus = 409;
    ctl.syncBody = { codigo: 'FUENTE_APAGADA', fuente: 'flit1', error: CRUDO };
    ctl.inter = { ...ctl.inter, fuentes: [inter('flit1', false), inter('flit2', true)] };
    ctl.e1 = estado1(false);
    const antes = ctl.gets1;
    await botonSync(page).click();
    await expect(page.getByText('No se sincronizó: FLIT 1 está apagada en este ambiente.')).toBeVisible();
    await expect(page.getByTestId('motivo-flit1')).toContainText('La sincronización con FLIT 1 está apagada desde Sincronización.');
    await expect(botonSync(page)).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => ctl.gets1).toBeGreaterThan(antes);
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });

  test('AC4: sincronizar ok deja un toast de una frase en lugar de la tarjeta de desglose', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockear(page);
    await abrir(page);
    await botonSync(page).click();
    await expect(page.getByText('Sincronización lista: 3 nuevos y 2 con cambios. 1 quedaron sin empresa o sin secretaría.')).toBeVisible();
    await expect(page.getByText(/traídos de FLIT/)).toHaveCount(0);
  });

  test('AC5: FLIT 2 apagada por interruptor: indicador y panel dicen que está apagada y por qué, sin alerta de atraso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, {
      f2: false,
      e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor', alerta: true, problema: { tipo: 'lectura', codigo: null, motivo: null, en: hace(2), hasta: null } }),
    });
    await abrir(page);
    await expect(page.getByTestId('texto-indicador-flit2')).toHaveText('Lectura automática apagada desde Sincronización');
    await expect(page.getByTestId('texto-indicador-flit2')).not.toContainText(/\d+:\d{2}/);
    await expect(page.getByTestId('motivo-flit2')).toContainText('FLIT 2 está apagada: FLITO no lee trámites nuevos de FLIT 2.');
    await expect(page.getByTestId('aviso-estado-flit2')).toHaveCount(0);
    await expect(page.getByText('Falló la última lectura de FLIT 2.')).toHaveCount(0);
  });

  test('AC5: con el maestro apagado, aviso persistente del servidor y estado «Encendida · apagada en el servidor»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, { maestro: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'maestro', automatica: { activa: false, intervaloMs: null, proximaEn: null, enCurso: false, generadoEn: new Date().toISOString() } }) });
    await abrir(page);
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('Encendida · apagada en el servidor');
    await expect(page.getByTestId('motivo-flit2')).toHaveText('La lectura automática de FLIT 2 está apagada en el servidor; este interruptor no tendrá efecto hasta que se encienda allí.');
    await expect(page.getByTestId('motivo-flit2')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('texto-indicador-flit2')).toHaveText('Lectura automática apagada en el servidor');
  });

  for (const tema of ['claro', 'oscuro'] as const) {
    test(`AC7 + AC9: hover y foco visible en el interruptor y en los botones (${tema})`, async ({ page }) => {
      if (tema === 'oscuro') await page.addInitScript(() => localStorage.setItem('aura-theme', 'dark'));
      await loginAs(page, OPERACIONES_USER);
      await mockear(page);
      await abrir(page);
      const s = sw(page, 'flit1');
      const fondo = () => s.evaluate((e) => getComputedStyle(e).backgroundColor);
      const reposo = await fondo();
      await s.hover();
      await expect.poll(fondo).not.toBe(reposo);
      // Foco por teclado: anillo visible en el interruptor y en «Sincronizar FLIT».
      await s.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(s).toBeFocused();
      const anillo = (sel: ReturnType<typeof sw>) => sel.evaluate((e) => {
        const c = getComputedStyle(e);
        return (c.outlineStyle !== 'none' && c.outlineWidth !== '0px') || c.boxShadow !== 'none';
      });
      expect(await anillo(s)).toBe(true);
      await botonSync(page).focus();
      expect(await anillo(botonSync(page))).toBe(true);
      // Los colores del carril salen de tokens (con par oscuro), nunca de HEX.
      const carril = await s.locator('span').first().getAttribute('style');
      expect(carril).toContain('var(--flit-blue-text)');
    });
  }

  test('AC8: a 375 px sin scroll horizontal, grupos apilados y botones a ancho completo', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, { maestro: false, f1: false, e1: estado1(false), e2: estado2({ habilitada: false, motivoDeshabilitada: 'maestro' }) });
    await abrir(page);
    // La sección no desborda: ningún elemento suyo pasa del borde del viewport. (La barra superior del
    // shell desborda a 375 por su cuenta —preexistente, fuera de esta HU— y por eso no se mide el
    // `scrollWidth` del documento aquí.)
    const desbordan = await seccion(page).evaluate((sec) => [sec, ...sec.querySelectorAll('*')]
      .filter((e) => e.getBoundingClientRect().right > 375.5).length);
    expect(desbordan).toBe(0);
    expect(await seccion(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const g1 = (await grupo(page, 'flit1').boundingBox())!;
    const g2 = (await grupo(page, 'flit2').boundingBox())!;
    expect(g2.y).toBeGreaterThanOrEqual(g1.y + g1.height);
    const b = (await botonAcceso(page).boundingBox())!;
    expect(b.width).toBeGreaterThan(g2.width - 40);
  });
});
