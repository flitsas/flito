import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';

// HU #11127 — Tablero de saldos por cliente. Quién necesita recarga, sin revisar trámite por
// trámite. Backend mockeado.

const CRITICO = {
  id: 'b1', companiaId: 1, companiaNombre: 'ACME SAS', saldo: 300000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'critico', porcentaje: 6, entradasPeriodo: 5000000, salidasPeriodo: 4700000,
};
const BAJO = {
  id: 'b2', companiaId: 2, companiaNombre: 'TRANSPORTES DEL SUR', saldo: 1200000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-06-20T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 24, entradasPeriodo: 0, salidasPeriodo: 0,
};
const NORMAL = {
  id: 'b3', companiaId: 3, companiaNombre: 'LOGISTICA ANDINA', saldo: 4500000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-07-15T10:00:00.000Z',
  nivel: 'normal', porcentaje: 90, entradasPeriodo: 5000000, salidasPeriodo: 500000,
};

// `/riesgo` llega YA ordenado de peor a mejor: el orden lo pone el servidor.
const RIESGO = [CRITICO, BAJO, NORMAL];

const ALERTAS = {
  saldo: [
    {
      tipo: 'saldo', nivel: 'critico', companiaId: 1, companiaNombre: 'ACME SAS',
      saldo: 300000, porcentaje: 6, mensaje: 'ACME SAS tiene saldo crítico: 6 % de su última recarga.',
    },
  ],
  conciliacion: { soportesSinTramite: 4, movimientosSinSoporte: 2 },
};

async function mock(page: import('@playwright/test').Page, opts: { bolsas?: unknown[]; organismos?: unknown[] } = {}) {
  const bolsas = opts.bolsas ?? RIESGO;
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: bolsas.length, saldoTotal: 6000000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bolsas) }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.bolsas ? { saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } } : ALERTAS) }));
  await page.route(/\/api\/flito\/bolsas\/(\d+)\/extracto/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      companiaId: 1, saldoActual: 300000, totalEntradas: 5000000, totalSalidas: 4700000,
      porOrganismo: [], porConcepto: [],
    }) }));
  // Desde la HU #11210 el tablero pide TAMBIÉN las bolsas de organismo: sin esta ruta la promesa
  // conjunta falla y la pantalla entera se va al estado de error.
  await page.route(/\/api\/flito\/bolsas\/organismos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.organismos ?? []) }));
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
}

test.describe('FLITO — Bolsas · tablero', () => {
  test('cada cliente tiene su tarjeta con saldo, nivel y movimiento del periodo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const urls: string[] = [];
    await mock(page);
    await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RIESGO) });
    });
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: 'Bolsas prepago' })).toBeVisible();
    const tarjetas = page.getByRole('region', { name: 'Bolsas por cliente' });
    await expect(tarjetas.getByRole('heading', { name: 'ACME SAS' })).toBeVisible();
    await expect(tarjetas.getByText('Saldo crítico')).toBeVisible();
    await expect(tarjetas.getByText('Saldo bajo')).toBeVisible();
    await expect(tarjetas.getByText('Normal')).toBeVisible();
    // El movimiento del mes viene dentro de /riesgo: una sola petición para toda la rejilla, no una
    // por tarjeta.
    await expect(tarjetas.getByText(/4\.700\.000/)).toBeVisible();
    await expect.poll(() => urls.at(-1) ?? '').toMatch(/periodo=\d{4}-\d{2}/);
  });

  test('un mes sin movimientos muestra cero, no un guion', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    // `0` y `null` no significan lo mismo: cero es «ese mes no hubo movimientos» y hay que decirlo.
    const sinMovimientos = page.getByRole('region', { name: 'Bolsas por cliente' })
      .getByRole('article').filter({ hasText: 'TRANSPORTES DEL SUR' });
    await expect(sinMovimientos.getByText(/\$\s*0$/).first()).toBeVisible();
  });

  test('las bolsas en riesgo salen primero, en el orden que manda el servidor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    // Reordenar en la pantalla abriría la puerta a que dos vistas del mismo dato prioricen distinto.
    const nombres = page.getByRole('region', { name: 'Bolsas por cliente' }).getByRole('heading');
    await expect(nombres).toHaveText(['ACME SAS', 'TRANSPORTES DEL SUR', 'LOGISTICA ANDINA']);
  });

  test('el panel de alertas dice el motivo y lleva al detalle del cliente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.route(/\/api\/flito\/bolsas\/1$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRITICO) }));
    await page.route(/\/api\/flito\/bolsas\/1\/(movimientos|cierres)/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/flito/bolsas');
    // El motivo lo redacta el servidor: es el mismo texto que verá quien reciba la alerta por otro canal.
    await expect(page.getByText('ACME SAS tiene saldo crítico: 6 % de su última recarga.')).toBeVisible();
    await expect(page.getByText(/4 soporte\(s\) sin trámite/)).toBeVisible();

    // El detalle es un modal SOBRE el tablero (HU #11210): al cerrarlo se sigue donde se estaba.
    await page.getByRole('button', { name: 'Ver detalle' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Consumo por organismo de tránsito')).toBeVisible();
    await modal.getByRole('button', { name: /Cerrar/ }).first().click();
    await expect(page.getByRole('region', { name: 'Bolsas por cliente' })).toBeVisible();
  });

  test('sin ninguna bolsa creada se explica cómo abrir la primera, sin error ni tabla vacía', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsas: [] });
    await page.goto('/flito/bolsas');

    await expect(page.getByTestId('sin-bolsas-cliente')).toContainText('Ningún cliente tiene bolsa todavía');
    await expect(page.getByTestId('sin-bolsas-cliente')).toContainText('Abrir bolsa');
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('todo vive en una sola vista: ya no hay pestañas que saltar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    // La HU #11210 retira «Cliente» y «Organismos»: clientes y tránsitos conviven en acordeones.
    await expect(page.getByRole('button', { name: 'Cliente', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Organismos', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Clientes/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /^Tránsitos/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('el acordeón se pliega y su contenido sale del DOM, no solo de la vista', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: /^Clientes/ }).click();
    await expect(page.getByRole('button', { name: /^Clientes/ })).toHaveAttribute('aria-expanded', 'false');
    // Desmontado y no oculto: si solo se escondiera, sus botones seguirían en el orden de tabulación.
    await expect(page.getByRole('region', { name: 'Bolsas por cliente' })).toHaveCount(0);
  });

  test('el botón + solo ofrece las compañías que aún no tienen bolsa', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    // ACME (1) ya tiene bolsa; RENTING (9) no. Solo la segunda puede abrirse.
    await page.route(/\/api\/clients/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 1, name: 'ACME SAS' }, { id: 9, name: 'RENTING' },
      ]) }));
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: 'Abrir la bolsa de un cliente nuevo' }).click();
    const selector = page.getByRole('combobox', { name: 'Compañía a la que abrirle bolsa' });
    await expect(selector.getByRole('option')).toHaveText(['Elige una compañía…', 'RENTING']);
  });

  test('sin compañías pendientes el + lo dice, en vez de enseñar un formulario imposible', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    // La única compañía de la lista ya tiene bolsa.
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: 'Abrir la bolsa de un cliente nuevo' }).click();
    await expect(page.getByTestId('sin-clientes-por-abrir')).toBeVisible();
    await expect(page.getByLabel('Valor de la recarga *')).toHaveCount(0);
  });

  test('la primera recarga abre la bolsa y la compañía aparece en el tablero', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsas: [] });
    await page.route(/\/api\/clients/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, name: 'RENTING' }]) }));

    let abierta = false;
    await page.route(/\/api\/flito\/bolsas\/9\/recargas/, (route) => {
      abierta = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        duplicado: false, saldo: 3_000_000,
        movimiento: { id: 'm9', valor: 3_000_000, registradoPorNombre: 'Financiera E2E' },
      }) });
    });
    // El tablero se relee tras la recarga: la bolsa recién abierta ya tiene que estar.
    await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(abierta ? [{
        id: 'b9', companiaId: 9, companiaNombre: 'RENTING', saldo: 3_000_000,
        ultimaRecargaValor: 3_000_000, ultimaRecargaEn: '2026-08-01T10:00:00.000Z',
        nivel: 'normal', porcentaje: 100, entradasPeriodo: 3_000_000, salidasPeriodo: 0,
      }] : []) }));

    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Abrir la bolsa de un cliente nuevo' }).click();
    await page.getByRole('combobox', { name: 'Compañía a la que abrirle bolsa' }).selectOption('9');
    await page.getByLabel('Valor de la recarga *').fill('3000000');
    await page.locator('input[type=file]').setInputFiles({
      name: 'comprobante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
    });
    await page.getByRole('button', { name: 'Registrar recarga' }).click();

    await expect(page.getByTestId('tarjeta-cliente-9')).toContainText('RENTING');
  });

  test('un rol distinto de admin o financiera no entra ni por URL directa', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Bolsas prepago/ })).toBeVisible();
    // Ni un solo importe: la pantalla no llega a pedir nada.
    await expect(page.getByText('ACME SAS')).toHaveCount(0);
  });
});
