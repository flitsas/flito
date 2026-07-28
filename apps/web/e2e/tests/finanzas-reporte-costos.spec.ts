import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// HU #10967 — Reporte de costos. Liquidar, facturar y consultar soportes sin salir de la pantalla.
// Las filas liquidadas muestran valores sellados; el resto, un estimado. Backend mockeado.

const FILA_ESTIMADA = {
  tramiteId: 'aaaa0000-0000-0000-0000-000000000001', idFlit: 'FLIT-2001', placa: 'ABC123',
  estado: 'Aprobado', empresa: 'ACME SAS', tipoTramite: 'Traspaso',
  fechaAprobacion: '2026-07-14T15:30:00.000Z',
  soat: 450000, impuesto: 120000, derechoTramite: 80000, logistica: 15000, tramiteDigital: 200000,
  gmf: 3460, total: 868460, sellada: false, estadoLiquidacion: null, noConfigurados: [],
};
const FILA_BLOQUEADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000002', idFlit: 'FLIT-2002',
  fechaAprobacion: null,
  tramiteDigital: null, total: null, noConfigurados: ['Trámite digital'],
};
const FILA_LIQUIDADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000003', idFlit: 'FLIT-2003',
  sellada: true, estadoLiquidacion: 'liquidado',
};
const FILA_FACTURADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000004', idFlit: 'FLIT-2004',
  sellada: true, estadoLiquidacion: 'facturado',
};

const REPORTE = {
  items: [FILA_ESTIMADA, FILA_BLOQUEADA, FILA_LIQUIDADA, FILA_FACTURADA],
  total: 4, page: 1, pageSize: 50,
  totales: {
    soat: 1800000, impuesto: 480000, derechoTramite: 320000, logistica: 60000,
    tramiteDigital: 600000, gmf: 10400, total: 3270400, filasIncompletas: 1,
  },
};

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados: ['Aprobado'], empresas: [{ nit: '900111', nombre: 'ACME SAS' }], tipos: ['Traspaso', 'Matricula'],
    }) }));
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
}

test.describe('Finanzas — Reporte de costos', () => {
  test('distingue sellado, facturado y estimado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByText('Estimado')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2003' }).getByText('Liquidado')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2004' }).getByText('Facturado')).toBeVisible();
  });

  test('muestra la fecha de aprobación, y dice cuándo no la hay', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByText('14 de jul de 26')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2002' }).getByText('Sin aprobar')).toBeVisible();
  });

  test('arranca filtrado por Aprobado y los dos rangos de fecha viajan por separado', async ({ page }) => {
    // El estado por defecto se comprueba sobre la petición, no sobre el estilo de la pastilla: es
    // lo que de verdad determina qué filas se traen.
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        estados: ['Aprobado', 'Entregado'], empresas: [], tipos: [],
      }) }));
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => urls[0] ?? '').toContain('estados=Aprobado');

    await page.getByLabel('Creado desde').fill('2026-06-01');
    await page.getByLabel('Aprobado hasta').fill('2026-07-31');
    await expect.poll(() => urls.at(-1) ?? '').toContain('aprobadoHasta=2026-07-31');
    expect(urls.at(-1)).toContain('desde=2026-06-01');
  });

  test('limpiar filtros vuelve a Aprobado, no a todos los estados', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        estados: ['Aprobado', 'Entregado'], empresas: [], tipos: [],
      }) }));
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Entregado' }).click();
    await page.getByLabel('Creado desde').fill('2026-06-01');
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('estados=Aprobado');
    expect(urls.at(-1)).not.toContain('Entregado');
    expect(urls.at(-1)).not.toContain('desde=');
  });

  test('un concepto sin tarifa se muestra como «No configurado», no como cero', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2002' });
    await expect(fila.getByText('No configurado').first()).toBeVisible();
    await expect(fila.getByText('$ 0')).toHaveCount(0);
  });

  test('avisa de que el total está incompleto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText(/tienen algún concepto sin\s+configurar/)).toBeVisible();
  });

  test('los totales son del filtro entero, no de la página', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('Totales (4 trámites del filtro)')).toBeVisible();
  });

  test('no se puede liquidar una fila con conceptos pendientes, y se dice cuál falta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const bloqueada = page.getByRole('row').filter({ hasText: 'FLIT-2002' });
    await expect(bloqueada.getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(bloqueada.getByText(/Falta: Trámite digital/)).toBeVisible();

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Liquidar' })).toBeEnabled();
  });

  test('liquidar una fila llama al backend', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let llamado = '';
    await page.route(/\/api\/flito\/liquidacion\/.*\/liquidar/, (route) => {
      llamado = route.request().url();
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Liquidar' }).click();
    await expect.poll(() => llamado).toContain(FILA_ESTIMADA.tramiteId);
  });

  test('un trámite facturado ya no ofrece reversar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const liquidada = page.getByRole('row').filter({ hasText: 'FLIT-2003' });
    await expect(liquidada.getByRole('button', { name: 'Reversar' })).toBeVisible();
    await expect(liquidada.getByRole('button', { name: 'Facturar' })).toBeVisible();

    const facturada = page.getByRole('row').filter({ hasText: 'FLIT-2004' });
    await expect(facturada.getByRole('button', { name: 'Reversar' })).toHaveCount(0);
    await expect(facturada.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
  });

  test('el reverso exige un motivo antes de confirmar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const liquidada = page.getByRole('row').filter({ hasText: 'FLIT-2003' });
    await liquidada.getByRole('button', { name: 'Reversar' }).click();
    await expect(liquidada.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await liquidada.getByLabel('Motivo del reverso').fill('error de tarifa');
    await expect(liquidada.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
  });

  test('el visor lista los soportes del trámite', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: '/api/files?key=a', subidoEn: '2026-07-01T00:00:00Z' },
        { id: 's2', origen: 'derecho', tipo: 'derecho_tramite', nombreArchivo: 'recibo.pdf', url: '/api/files?key=b', subidoEn: '2026-07-02T00:00:00Z' },
      ]) }));

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByText('Soportes de FLIT-2001')).toBeVisible();
    await expect(page.getByRole('button', { name: /soat · soat.pdf/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /derecho · recibo.pdf/ })).toBeVisible();
  });

  test('un trámite sin soportes lo dice en vez de fallar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByText(/no tiene ningún soporte cargado/)).toBeVisible();
  });

  test('auditor consulta y ve soportes, pero no liquida ni factura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Soporte' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Liquidar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reversar' })).toHaveCount(0);
  });
});
