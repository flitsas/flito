import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';

// HU #11162 y #11210 — Bolsa prepago del Organismo de Tránsito. Backend mockeado.
//
// Lo que se comprueba, además de las cifras, es que la pantalla se lea en el sentido CORRECTO: un
// saldo que FLIT precarga y la secretaría consume, no una deuda que crece.
//
// Desde la HU #11210 los organismos ya no viven en una pestaña con buscador: el tablero los lista
// en el acordeón «Tránsitos» y el detalle se abre en un modal. Los organismos sin bolsa NO aparecen
// —a esas secretarías FLIT nunca les transfiere dinero—, así que aquí ya no se prueba un 404 por
// código sino su ausencia del listado.

const MEDELLIN_BOLSA = {
  id: 'ob-1', organismoCodigo: '05001', saldo: 2_500_000,
  ultimaCargaValor: 10_000_000, ultimaCargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 25, deuda: 0,
  totalCargado: 10_000_000, totalConsumido: 7_500_000,
};

/** Mismo organismo, ya en préstamo: el caso que distingue esta bolsa de la del cliente. */
const MEDELLIN_PRESTAMO = {
  ...MEDELLIN_BOLSA, saldo: -4_000_000, nivel: 'en_prestamo', porcentaje: -40, deuda: 4_000_000,
  totalCargado: 10_000_000, totalConsumido: 14_000_000,
};

/** Marcado para llevar bolsa pero sin una sola carga: ni alarma ni bolsa inexistente. */
const BOGOTA_SIN_CARGAS = {
  id: 'ob-2', organismoCodigo: '11001', saldo: 0,
  ultimaCargaValor: null, ultimaCargaEn: null,
  nivel: 'sin_cargas', porcentaje: null, deuda: 0,
  totalCargado: 0, totalConsumido: 0,
};

const MOVIMIENTOS = [
  {
    id: 'm2', organismoCodigo: '05001', tipo: 'salida', origen: 'automatico',
    tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
    valor: 7_500_000, saldoResultante: 2_500_000, periodo: '2026-07', fecha: '2026-07-10',
    observacion: null, soporteId: null, registradoPorNombre: 'sistema',
    createdAt: '2026-07-10T10:00:00.000Z',
  },
  {
    id: 'm1', organismoCodigo: '05001', tipo: 'entrada', origen: 'carga',
    tramiteId: null, idFlit: null,
    valor: 10_000_000, saldoResultante: 10_000_000, periodo: '2026-07', fecha: '2026-07-01',
    observacion: 'Transferencia del 01/07', soporteId: 'sop-10', registradoPorNombre: 'Financiera E2E',
    createdAt: '2026-07-01T10:00:00.000Z',
  },
];

async function mock(page: import('@playwright/test').Page, opts: {
  bolsa?: typeof MEDELLIN_BOLSA;
  listado?: unknown[];
} = {}) {
  const bolsa = opts.bolsa ?? MEDELLIN_BOLSA;
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } }) }));

  // El listado del acordeón «Tránsitos»: SOLO los organismos que llevan bolsa.
  await page.route(/\/api\/flito\/bolsas\/organismos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.listado ?? [bolsa]) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/bolsa$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bolsa) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/movimientos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOVIMIENTOS) }));
}

/** Abre el detalle de Medellín desde su tarjeta del acordeón. */
async function abrirDetalle(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByTestId('tarjeta-organismo-05001').getByRole('button', { name: /Ver el detalle/ }).click();
  return page.getByRole('dialog');
}

test.describe('FLITO — Bolsas · organismo de tránsito', () => {
  test('el acordeón de tránsitos lista cada organismo con cargado, consumido y deuda', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    // El nombre sale del catálogo compartido: «ciudad — organismo», no del mock.
    const tarjeta = page.getByTestId('tarjeta-organismo-05001');
    await expect(tarjeta).toContainText('Medellín');
    await expect(tarjeta).toContainText('2.500.000');
    // Las tres cifras que pide la HU, además del saldo.
    await expect(tarjeta.getByText('Cargado por FLIT')).toBeVisible();
    await expect(tarjeta).toContainText('10.000.000');
    await expect(tarjeta).toContainText('7.500.000');
    await expect(tarjeta.getByText('Deuda actual')).toBeVisible();
  });

  test('el organismo en préstamo enseña el saldo en negativo y lo que se le debe', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsa: MEDELLIN_PRESTAMO });
    await page.goto('/flito/bolsas');

    // La deuda NO es una tabla aparte: es el saldo en negativo, y así se lee en la tarjeta.
    const tarjeta = page.getByTestId('tarjeta-organismo-05001');
    await expect(tarjeta).toContainText('-$');
    await expect(tarjeta).toContainText('4.000.000');
    await expect(tarjeta.getByText('En préstamo')).toBeVisible();
  });

  test('un organismo marcado sin cargas no se pinta como alarma', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [BOGOTA_SIN_CARGAS] });
    await page.goto('/flito/bolsas');

    // «Nunca se le ha cargado» no es lo mismo que «se quedó sin saldo»: no es una urgencia.
    const tarjeta = page.getByTestId('tarjeta-organismo-11001');
    await expect(tarjeta).toContainText('Sin cargas');
    await expect(tarjeta).toContainText('nunca se le ha cargado');
  });

  test('sin ningún organismo con bolsa se explica dónde se habilita, sin ofrecer cargar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [] });
    await page.goto('/flito/bolsas');

    await expect(page.getByTestId('sin-bolsas-organismo')).toContainText('Tránsito → Organismos');
    // Sin bolsa no hay dinero que mover: ofrecer la acción invitaría a preguntarse por qué no hace nada.
    await expect(page.getByRole('button', { name: 'Cargar saldo' })).toHaveCount(0);
  });

  test('el detalle abre en modal con la alerta de nivel escrita, no solo en color', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsa: MEDELLIN_PRESTAMO });
    const modal = await abrirDetalle(page);

    // El nivel va SIEMPRE escrito: quien no distinga el color no puede quedarse sin la información.
    const alerta = modal.getByTestId('alerta-nivel-organismo');
    await expect(alerta).toContainText('En préstamo');
    await expect(alerta).toContainText('4.000.000');
    await expect(alerta).toHaveAttribute('role', 'alert');
  });

  test('el libro distingue la carga del consumo y enlaza el trámite que lo originó', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    const modal = await abrirDetalle(page);

    const libro = modal.getByRole('region', { name: 'Movimientos de la bolsa del organismo' });
    await expect(libro.getByText('Consumo de derecho')).toBeVisible();
    await expect(libro.getByText('Carga', { exact: true })).toBeVisible();
    // Los consumos cuelgan de un trámite; las cargas no.
    await expect(libro.getByRole('link', { name: 'FLIT-3001' })).toBeVisible();
  });

  test('registrar una carga refresca el saldo sin recargar la página', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let cargado = false;
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/cargas$/, (route) => {
      cargado = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ saldo: 12_500_000 }) });
    });
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/bolsa$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cargado
          ? { ...MEDELLIN_BOLSA, saldo: 12_500_000, nivel: 'normal', porcentaje: 125, totalCargado: 20_000_000 }
          : MEDELLIN_BOLSA),
      }));

    const modal = await abrirDetalle(page);
    await modal.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByLabel('Valor de la carga *').fill('10000000');
    await page.getByRole('button', { name: 'Registrar carga' }).click();

    await expect(modal.getByText('12.500.000').first()).toBeVisible();
  });

  test('una carga en cero se para antes de salir a la red', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let llamadas = 0;
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/cargas$/, (route) => {
      llamadas += 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ saldo: 0 }) });
    });

    const modal = await abrirDetalle(page);
    await modal.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByLabel('Valor de la carga *').fill('0');

    await expect(page.getByRole('button', { name: 'Registrar carga' })).toBeDisabled();
    expect(llamadas).toBe(0);
  });

  test('un rol distinto de admin o financiera no ve un solo saldo', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Bolsas prepago/ })).toBeVisible();
    await expect(page.getByTestId('tarjeta-organismo-05001')).toHaveCount(0);
  });
});
