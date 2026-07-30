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

async function mock(page: import('@playwright/test').Page, opts: { bolsas?: unknown[] } = {}) {
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

    await page.getByRole('button', { name: 'Ver detalle' }).first().click();
    await expect(page.getByRole('combobox', { name: 'Cliente', exact: true })).toBeVisible();
    await expect(page.getByText('Consumo por organismo de tránsito')).toBeVisible();
  });

  test('sin ninguna bolsa creada se explica cómo abrir la primera, sin error ni tabla vacía', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsas: [] });
    await page.goto('/flito/bolsas');

    await expect(page.getByText('Ningún cliente tiene bolsa todavía.')).toBeVisible();
    await expect(page.getByText(/La bolsa nace con la primera recarga/)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
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
