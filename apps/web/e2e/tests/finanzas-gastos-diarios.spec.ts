// HU #12624 — Finanzas · Gastos diarios: cinco tarjetas por categoría, total con GMF estimado,
// filtros en la URL y ficha de ayuda. Backend mockeado con `page.route`; el fixture base responde
// `200 []` a lo no mockeado. La página `finanzas_gastos_diarios` la reparte la 0200 solo a `admin`
// (el fixture admin lleva todas las de `PAGES`); financiera entra sin ella hasta que el admin la
// conceda desde Roles y permisos (AC2).
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, FINANCIERA_USER } from '../helpers/auth';

const celda = (cantidad: number, valor: string) => ({ cantidad, valor });
/** Totales del AC3/AC4: base 5.850.000 = 3.450.000 + 1.200.000 + 810.000 + 315.000 + 75.000. */
const TOTALES = {
  soat: celda(12, '3450000.00'), impuesto: celda(4, '1200000.00'), derecho: celda(9, '810000.00'),
  logistica: celda(7, '315000.00'), serviciosAdicionales: celda(5, '75000.00'),
  base: '5850000.00', gmfEstimado: '23400.00', total: '5873400.00',
};
const CERO = celda(0, '0.00');
const TOTALES_CERO = { soat: CERO, impuesto: CERO, derecho: CERO, logistica: CERO, serviciosAdicionales: CERO, base: '0.00', gmfEstimado: '0.00', total: '0.00' };
const RESPUESTA = { desde: '2026-08-18', hasta: '2026-09-16', serie: [], totales: TOTALES };
const FACETAS = {
  estados: [], tipos: [], organismos: [],
  empresas: [{ valor: '900123456', nombre: 'Transportes Andina' }, { valor: '800111222,800111223', nombre: 'ACME SAS' }],
};

type Opciones = { status?: number; body?: unknown; totales?: typeof TOTALES };

/** Mockea la consulta y devuelve las URLs que la pantalla pidió: el aserto del AC5 cuenta aquí. */
async function mockGastos(page: Pagina, opciones: Opciones = {}) {
  const peticiones: string[] = [];
  await page.route('**/api/finanzas/gastos-diarios**', (route) => {
    peticiones.push(new URL(route.request().url()).search);
    const status = opciones.status ?? 200;
    const body = opciones.body ?? (status === 200 ? { ...RESPUESTA, totales: opciones.totales ?? TOTALES } : { error: 'Falló' });
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/finanzas/reporte-costos/facetas', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  return peticiones;
}

type Pagina = Parameters<typeof loginAs>[0];
const tarjeta = (page: Pagina, nombre: RegExp) => page.getByRole('region', { name: nombre });
/** Las cinco tarjetas (regiones «…, N pesos»); el bloque Total también es región y no cuenta aquí. */
const tarjetas = (page: Pagina) => page.getByRole('region', { name: / pesos$/ });

test.describe('FLITO — Finanzas · Gastos diarios (HU #12624)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('AC2 — con la página: ítem «Gastos diarios» tras «Reporte de costos», ruta protegida y ⌘K', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios');
    await expect(page.getByRole('heading', { name: 'Gastos diarios' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    const enlaces = page.locator('#flit-navbar-panel-finanzas a');
    const textos = await enlaces.allInnerTexts();
    const iCostos = textos.findIndex((t) => /^Reporte de costos$/.test(t.trim()));
    const iGastos = textos.findIndex((t) => /^Gastos diarios$/.test(t.trim()));
    expect(iCostos, 'Reporte de costos está en Finanzas').toBeGreaterThanOrEqual(0);
    expect(iGastos, 'Gastos diarios va justo después de Reporte de costos').toBe(iCostos + 1);
    await expect(page.getByRole('link', { name: 'Gastos diarios', exact: true })).toHaveAttribute('href', '/finanzas/gastos-diarios');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('dashboard');
    await expect(page.getByRole('option', { name: /Gastos diarios/ })).toBeVisible();
  });

  test('AC2 — sin la página: financiera ve NoAccess por URL, sin ítem de menú y sin consultar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const peticiones = await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios');
    await expect(page.getByRole('heading', { name: /no tienes acceso a finanzas — gastos diarios/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gastos diarios', exact: true })).toHaveCount(0);
    expect(peticiones).toHaveLength(0);

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Reporte de costos', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Gastos diarios', exact: true })).toHaveCount(0);
  });

  test('AC3/AC4/AC8 — cinco tarjetas en orden, rango una vez, total con GMF estimado y regiones con aria-label', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios');

    const regiones = tarjetas(page);
    await expect(regiones).toHaveCount(5);
    await expect(regiones.nth(0)).toHaveAttribute('aria-label', 'SOAT: 12 pagados, 3.450.000 pesos');
    await expect(regiones.nth(1)).toHaveAttribute('aria-label', 'Impuestos: 4 pagados, 1.200.000 pesos');
    await expect(regiones.nth(2)).toHaveAttribute('aria-label', 'Derechos de trámite: 9 pagados, 810.000 pesos');
    await expect(regiones.nth(3)).toHaveAttribute('aria-label', 'Logística: 7 trámites con logística, 315.000 pesos');
    await expect(regiones.nth(4)).toHaveAttribute('aria-label', 'Servicios adicionales: 5 asignados, 75.000 pesos');
    await expect(tarjeta(page, /^SOAT:/)).toContainText('12 · $ 3.450.000');
    await expect(tarjeta(page, /^SOAT:/)).toContainText('SOAT pagados');
    await expect(tarjeta(page, /^Servicios adicionales:/)).toContainText('Servicios asignados');

    // El rango cubierto, UNA vez sobre el conjunto (es el que devolvió el API, no el del campo).
    await expect(page.getByText('Gastos entre el 18 ago y el 16 sep 2026 · Todas las empresas')).toHaveCount(1);

    const total = page.getByRole('region', { name: 'Total del periodo' });
    await expect(total).toBeVisible();
    await expect(total.getByRole('term').filter({ hasText: 'Suma de categorías' })).toBeVisible();
    await expect(total.getByRole('definition').nth(0)).toHaveText('$ 5.850.000');
    const gmf = total.getByRole('term').filter({ hasText: 'GMF (4×1000) estimado' });
    await expect(gmf).toBeVisible();
    await expect(gmf).toHaveAttribute('title', 'Calculado sobre la suma del periodo; la liquidación lo calcula por trámite.');
    await expect(gmf).toHaveAttribute('aria-describedby', 'gastos-total-nota-gmf');
    await expect(total.locator('#gastos-total-nota-gmf')).toContainText('Calculado sobre la suma del periodo; la liquidación lo calcula por trámite.');
    await expect(total.getByRole('definition').nth(1)).toHaveText('$ 23.400');
    await expect(total.getByRole('term').filter({ hasText: 'Total con GMF' })).toBeVisible();
    await expect(total.getByRole('definition').nth(2)).toHaveText('$ 5.873.400');
    await expect(total.getByText('Incluye todas las categorías')).toHaveCount(0);

    await expect(page.getByText('Evolución diaria: próximamente')).toBeVisible();
    // Cabe en 1366×768 sin scroll horizontal.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // El enlace a la ficha, en la cabecera.
    await expect(page.getByRole('link', { name: '¿Qué cuenta cada categoría?' })).toHaveAttribute('href', '/flito/ayuda/finanzas_gastos_diarios');
  });

  test('AC3 — cantidad 0 se pinta «0 · $ 0» y la tarjeta sigue en su sitio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page, { totales: { ...TOTALES, impuesto: CERO } });
    await page.goto('/finanzas/gastos-diarios');
    const impuestos = tarjeta(page, /^Impuestos:/);
    await expect(impuestos).toHaveAttribute('aria-label', 'Impuestos: 0 pagados, 0 pesos');
    await expect(impuestos).toContainText('0 · $ 0');
    await expect(tarjetas(page)).toHaveCount(5);
  });

  test('AC5 — desmarcar «Impuestos» oculta su tarjeta SIN nueva petición; el total sigue sumando las cinco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios');
    await expect(tarjetas(page)).toHaveCount(5);
    // Cuántas hubo al montar, no «1»: en desarrollo StrictMode invoca el efecto dos veces al montar.
    // Lo que se afirma es que ocultar y mostrar tipos NO añade ninguna.
    const alMontar = peticiones.length;
    expect(alMontar).toBeGreaterThanOrEqual(1);
    expect(peticiones.every((q) => q === ''), 'sin query: el API aplica los últimos 30 días').toBe(true);

    const grupo = page.getByRole('group', { name: 'Tipo de gasto' });
    const impuestos = grupo.getByRole('button', { name: 'Impuestos' });
    await expect(impuestos).toHaveAttribute('aria-pressed', 'true');
    await impuestos.click();
    await expect(impuestos).toHaveAttribute('aria-pressed', 'false');
    await expect(tarjeta(page, /^Impuestos:/)).toHaveCount(0);
    await expect(tarjetas(page)).toHaveCount(4);
    await expect(page).toHaveURL(/[?&]tipos=soat%2Cderecho%2Clogistica%2CserviciosAdicionales/);

    // RN-08: el bloque no se recalcula con lo visible (4.650.000): sigue diciendo lo del API.
    const total = page.getByRole('region', { name: 'Total del periodo' });
    await expect(total.getByRole('definition').nth(0)).toHaveText('$ 5.850.000');
    await expect(total.getByRole('definition').nth(2)).toHaveText('$ 5.873.400');
    await expect(total.getByText('Incluye todas las categorías')).toBeVisible();

    // Y las cinco desmarcadas: el hueco lo dice y «Ver los cinco» las devuelve. Sin petición.
    for (const n of ['SOAT', 'Derechos de trámite', 'Logística', 'Servicios adicionales']) {
      await grupo.getByRole('button', { name: n, exact: true }).click();
    }
    await expect(page.getByText('Ningún tipo de gasto marcado.')).toBeVisible();
    await expect(total).toBeVisible();
    await page.getByRole('button', { name: 'Ver los cinco' }).click();
    await expect(tarjetas(page)).toHaveCount(5);
    await expect(page).not.toHaveURL(/tipos=/);
    expect(peticiones, 'ocultar y mostrar tipos no consulta').toHaveLength(alMontar);
  });

  test('AC5 — filtros en la URL: empresa y rango consultan con esos parámetros; el enlace se comparte', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios?desde=2026-09-01&hasta=2026-09-16&empresas=900123456&tipos=soat,impuesto');
    await expect(tarjetas(page)).toHaveCount(2);
    // `every` y no «la primera»: StrictMode monta el efecto dos veces en desarrollo. Lo que importa
    // es que TODAS llevan los parámetros de la URL y ninguna lleva `tipos`.
    expect(peticiones.length).toBeGreaterThanOrEqual(1);
    expect(peticiones.every((q) => q === '?desde=2026-09-01&hasta=2026-09-16&empresas=900123456')).toBe(true);
    await expect(page.getByLabel('Empresa')).toHaveValue('900123456');
    await expect(page.getByLabel('Periodo', { exact: true })).toContainText('1 sep 2026 → 16 sep 2026');
    await expect(page.getByText('Incluye todas las categorías')).toBeVisible();

    // Cambiar la empresa vuelve a consultar y queda en la URL.
    await page.getByLabel('Empresa').selectOption('800111222,800111223');
    await expect(page).toHaveURL(/empresas=800111222%2C800111223/);
    await expect.poll(() => peticiones.at(-1)).toBe('?desde=2026-09-01&hasta=2026-09-16&empresas=800111222%2C800111223');

    // «Limpiar filtros» vuelve al arranque: URL limpia, consulta sin parámetros, las cinco.
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page).toHaveURL(/\/finanzas\/gastos-diarios$/);
    await expect.poll(() => peticiones.at(-1)).toBe('');
    await expect(tarjetas(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeDisabled();
  });

  test('AC5 — el campo Periodo enseña los últimos 30 días aunque la URL no los lleve', async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 8, 16, 10, 0, 0));
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios');
    await expect(page.getByLabel('Periodo', { exact: true })).toContainText('18 ago 2026 → 16 sep 2026');
  });

  test('AC5 — hasta < desde y más de 366 días: error junto al campo y NO consulta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await mockGastos(page);
    await page.goto('/finanzas/gastos-diarios?desde=2026-09-16&hasta=2026-09-01');
    const alerta = page.getByRole('alert');
    await expect(alerta).toHaveText('La fecha final es anterior a la inicial.');
    await expect(page.getByLabel('Periodo', { exact: true })).toHaveAttribute('aria-describedby', 'gastos-rango-error');
    await expect(page.getByRole('status', { name: 'Cargando gastos diarios' })).toHaveCount(0);

    await page.goto('/finanzas/gastos-diarios?desde=2025-01-01&hasta=2026-09-16');
    await expect(page.getByRole('alert')).toHaveText('El periodo no puede superar 366 días. Acorta el rango.');
    expect(peticiones, 'un rango inválido no llega al API').toHaveLength(0);
  });

  test('AC6 — vacío: «Sin gastos entre … para <empresa>.» y «Últimos 30 días» quita desde/hasta/empresas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const peticiones = await mockGastos(page, { totales: TOTALES_CERO });
    await page.goto('/finanzas/gastos-diarios?desde=2026-08-18&hasta=2026-09-16&empresas=900123456');
    await expect(page.getByText('Sin gastos entre el 18 ago y el 16 sep 2026 para Transportes Andina.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Total del periodo' })).toHaveCount(0);
    await expect(page.getByText('Evolución diaria: próximamente')).toBeVisible();

    await page.getByRole('button', { name: 'Últimos 30 días' }).click();
    await expect(page).toHaveURL(/\/finanzas\/gastos-diarios$/);
    await expect.poll(() => peticiones.at(-1)).toBe('');
    await expect(page.getByText('Sin gastos en los últimos 30 días. Cambia el rango o la empresa arriba.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Últimos 30 días' })).toHaveCount(0);
  });

  test('AC6 — cargando: skeleton con role=status y aria-busy mientras la consulta no responde', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    await page.route('**/api/finanzas/gastos-diarios**', async (route) => {
      await espera;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPUESTA) });
    });
    await page.goto('/finanzas/gastos-diarios');
    const skeleton = page.getByRole('status', { name: 'Cargando gastos diarios' });
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-busy', 'true');
    // Los filtros ya se pueden usar.
    await expect(page.getByLabel('Empresa')).toBeVisible();
    soltar();
    await expect(skeleton).toHaveCount(0);
    await expect(tarjetas(page)).toHaveCount(5);
  });

  test('AC6 — 500: alerta «No se pudo cargar el gasto diario.» y Reintentar repite la MISMA consulta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Un interruptor y no un contador: StrictMode dispara el efecto dos veces al montar y un
    // contador «falla la primera» dejaría pasar la segunda con 200.
    let fallar = true;
    const peticiones: string[] = [];
    await page.route('**/api/finanzas/gastos-diarios**', (route) => {
      peticiones.push(new URL(route.request().url()).search);
      if (fallar) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Base no disponible' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESPUESTA) });
    });
    await page.goto('/finanzas/gastos-diarios?desde=2026-08-18&hasta=2026-09-16');
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudo cargar el gasto diario.');
    await expect(alerta).toContainText('Base no disponible');
    await expect(tarjetas(page)).toHaveCount(0);
    await expect(page.getByText('Evolución diaria: próximamente')).toBeVisible();

    const antes = peticiones.length;
    fallar = false;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(tarjetas(page)).toHaveCount(5);
    expect(peticiones.length).toBe(antes + 1);
    expect(peticiones.every((q) => q === '?desde=2026-08-18&hasta=2026-09-16'), 'Reintentar repite los mismos params').toBe(true);
  });

  test('AC6 — 403 del API: NoAccess, no el error genérico ni Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page, { status: 403, body: { error: 'Sin permiso', codigo: 'SIN_FUNCION' } });
    await page.goto('/finanzas/gastos-diarios');
    await expect(page.getByRole('heading', { name: /no tienes acceso a finanzas — gastos diarios/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByText('No se pudo cargar el gasto diario.')).toHaveCount(0);
  });

  test('R1 — la faceta de empresas en 403 no rompe: el selector queda en «Todas las empresas»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockGastos(page);
    await page.route('**/api/finanzas/reporte-costos/facetas', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Sin permiso' }) }));
    await page.goto('/finanzas/gastos-diarios');
    await expect(tarjetas(page)).toHaveCount(5);
    const empresa = page.getByLabel('Empresa');
    await expect(empresa).toHaveValue('');
    await expect(empresa.locator('option')).toHaveCount(1);
    await expect(empresa.locator('option')).toHaveText('Todas las empresas');
  });

  test('AC7 — la ficha de ayuda abre y dice de dónde sale el dato y que el GMF es estimado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/finanzas_gastos_diarios');
    const articulo = page.getByRole('article', { name: 'Gastos diarios' });
    await expect(articulo).toBeVisible();
    await expect(articulo).toContainText('no de la liquidación');
    await expect(articulo).toContainText('Reporte de costos');
    await expect(articulo).toContainText('GMF es un estimado');
    await expect(articulo).toContainText('el día del pago del SOAT');
    await expect(articulo).toContainText('el día de aprobación del trámite');
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Gastos diarios' })).toHaveAttribute('href', '/finanzas/gastos-diarios');
  });
});
