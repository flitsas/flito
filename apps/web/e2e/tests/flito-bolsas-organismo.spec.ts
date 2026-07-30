import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';

// HU #11130 — Estado de cuenta del Organismo de Tránsito. Backend mockeado.
//
// Lo que se comprueba aquí, además de las cifras, es que la pantalla NO se lea como una bolsa: el
// saldo del organismo es simbólico y pagarle no toca el dinero de ningún cliente.

const MEDELLIN = {
  organismoCodigo: '05001',
  porConcepto: [
    { concepto: 'derecho', cobrado: 3250000, movimientos: 5 },
    { concepto: 'impuesto', cobrado: 1200000, movimientos: 2 },
  ],
  totalCobrado: 4450000,
  totalPagado: 1000000,
  saldoPendiente: 3450000,
};

const VACIO = {
  organismoCodigo: '76001', porConcepto: [], totalCobrado: 0, totalPagado: 0, saldoPendiente: 0,
};

// Las líneas que originaron el cobro: salidas automáticas con el trámite que las produjo.
const TRAMITES = [
  {
    tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001', companiaId: 1,
    concepto: 'derecho', valor: 3250000, fecha: '2026-07-10', soporteId: 'sop-9',
  },
  {
    tramiteId: 'bbbb2222-0000-0000-0000-000000000002', idFlit: 'FLIT-3002', companiaId: 1,
    // Sin soporte: la línea tiene que decirlo en vez de ofrecer un enlace roto.
    concepto: 'impuesto', valor: 1200000, fecha: '2026-07-12', soporteId: null,
  },
];

const PAGOS = [{
  id: 'p0', valor: 1000000, fecha: '2026-07-15', observacion: 'Transferencia del 15/07',
  soporteId: 'sop-10', registradoPorNombre: 'Financiera E2E', createdAt: '2026-07-15T10:00:00.000Z',
}];

const BOLSA = {
  id: 'b1', companiaId: 1, companiaNombre: 'ACME SAS', saldo: 1300000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 26, entradasPeriodo: 5000000, salidasPeriodo: 3700000,
};

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BOLSA]) }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } }) }));
  // El tablero pide el movimiento del mes de cada tarjeta al montarse, aunque el test viva en la
  // pestaña de organismos: sin este mock el catch-all lo delata en la consola del runner.
  await page.route(/\/api\/flito\/bolsas\/1\/extracto/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      companiaId: 1, saldoActual: 1300000, totalEntradas: 5000000, totalSalidas: 3700000,
      porOrganismo: [], porConcepto: [],
    }) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/tramites$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TRAMITES) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/pagos$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGOS) });
  });
  await page.route(/\/api\/flito\/bolsas\/organismos\/76001\/(tramites|pagos)$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEDELLIN) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/76001$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACIO) }));
}

/** Elige un organismo en el combobox compartido del módulo. */
async function elegirOrganismo(page: import('@playwright/test').Page, ciudad: string) {
  await page.getByRole('button', { name: 'Organismo de tránsito del estado de cuenta' }).click();
  await page.getByRole('option', { name: new RegExp(ciudad) }).locator('button').click();
}

async function abrirOrganismos(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByRole('button', { name: 'Organismos', exact: true }).click();
}

test.describe('FLITO — Bolsas · estado de cuenta del organismo', () => {
  test('muestra lo cobrado por concepto, lo pagado y lo pendiente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    await expect(page.getByText('Cobrado a los clientes')).toBeVisible();
    await expect(page.getByText(/4\.450\.000/).first()).toBeVisible();
    await expect(page.getByText('Pagado por FLIT')).toBeVisible();
    await expect(page.getByText(/1\.000\.000/).first()).toBeVisible();
    await expect(page.getByText('Pendiente de pago')).toBeVisible();
    await expect(page.getByText(/3\.450\.000/).first()).toBeVisible();

    // Acotado a su tabla: «Derecho de tránsito» también rotula la línea del trámite que lo originó.
    const fila = page.getByRole('region', { name: 'Consumo por concepto del organismo' })
      .getByRole('row').filter({ hasText: 'Derecho de tránsito' });
    await expect(fila).toContainText('3.250.000');
    await expect(fila).toContainText('5');
  });

  test('la pantalla aclara que el saldo es simbólico y no altera al cliente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);

    // La aclaración está siempre visible, no escondida tras un icono de ayuda.
    await expect(page.getByText(/Saldo simbólico de conciliación/)).toBeVisible();
    await expect(page.getByText(/no altera el saldo de ningún cliente/)).toBeVisible();
  });

  test('registrar un pago baja el pendiente y no toca la bolsa del cliente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let pagado = false;
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/pagos$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      pagado = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'p1', saldoPendiente: 2450000 }) });
    });
    // Tras el pago, el estado de cuenta ya refleja el millón adicional.
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(pagado ? { ...MEDELLIN, totalPagado: 2000000, saldoPendiente: 2450000 } : MEDELLIN),
      }));

    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');
    await page.getByRole('button', { name: 'Registrar un pago al organismo' }).click();

    await page.getByLabel('Valor del pago *').fill('1000000');
    // El soporte es OPCIONAL aquí: la transferencia se ordena antes de que el banco emita el comprobante.
    await expect(page.getByRole('button', { name: 'Registrar pago' })).toBeEnabled();
    await page.getByRole('button', { name: 'Registrar pago' }).click();

    await expect.poll(() => pagado).toBe(true);
    await expect(page.getByText(/2\.450\.000/).first()).toBeVisible();
    // Y aparece en el historial del organismo (AC2).
    await expect(page.getByRole('region', { name: 'Pagos al organismo' })
      .getByRole('row').filter({ hasText: 'Transferencia del 15/07' })).toBeVisible();
    // La bolsa del cliente no se toca: el tablero sigue enseñando su mismo saldo.
    await page.getByRole('button', { name: 'Tablero', exact: true }).click();
    await expect(page.getByText(/1\.300\.000/).first()).toBeVisible();
  });

  test('cada línea del cobro trae su trámite, su cliente y su soporte', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let soporteAbierto = '';
    await page.route(/\/api\/flito\/bolsas\/soportes\/(.+)$/, (route) => {
      soporteAbierto = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        url: '/api/files?key=x', nombreArchivo: 'recibo.pdf', contentType: 'application/pdf',
      }) });
    });
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const lineas = page.getByRole('region', { name: 'Trámites del organismo' });
    const conSoporte = lineas.getByRole('row').filter({ hasText: 'FLIT-3001' });
    await expect(conSoporte).toContainText('ACME SAS');
    await expect(conSoporte).toContainText('Derecho de tránsito');
    await expect(conSoporte).toContainText('3.250.000');

    // El soporte sale por la ruta del módulo, no por la de derechos: aquella daba 403 a financiera.
    await conSoporte.getByRole('button', { name: /Abrir el soporte del trámite/ }).click();
    await expect.poll(() => soporteAbierto).toContain('/api/flito/bolsas/soportes/sop-9');

    await expect(lineas.getByRole('row').filter({ hasText: 'FLIT-3002' }).getByText('Sin soporte')).toBeVisible();
  });

  test('el historial de pagos lista lo que ya se le transfirió', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const historial = page.getByRole('region', { name: 'Pagos al organismo' });
    const pago = historial.getByRole('row').filter({ hasText: 'Transferencia del 15/07' });
    await expect(pago).toContainText('1.000.000');
    await expect(pago).toContainText('Financiera E2E');
    await expect(pago.getByRole('button', { name: /Abrir el soporte del pago/ })).toBeVisible();
  });

  test('un organismo sin movimientos enseña ceros, no un error', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Cali');

    await expect(page.getByText('Este organismo todavía no tiene conceptos cobrados. Los totales están en cero.')).toBeVisible();
    await expect(page.getByText('Ningún trámite ha consumido bolsa por cuenta de este organismo.')).toBeVisible();
    await expect(page.getByText('Todavía no se le ha registrado ningún pago a este organismo.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('un rol sin permiso no llega al estado de cuenta', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Bolsas prepago/ })).toBeVisible();
    await expect(page.getByText('Cobrado a los clientes')).toHaveCount(0);
  });
});
