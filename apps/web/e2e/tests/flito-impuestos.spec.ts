import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Impuestos (Fase 6). Cola por organismo: factura de venta como
// precondición, envío atómico y solo-lectura para Auditoría. Backend mockeado.

const IMPUESTOS = [
  {
    id: 'i1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'ABC123', vin: 'VIN0000000000001',
    estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  },
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
  },
];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    const url = new URL(route.request().url());
    const estado = url.searchParams.get('estado');
    const data = estado ? IMPUESTOS.filter((i) => i.estado === estado) : IMPUESTOS;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
}

test.describe('FLITO — Impuestos', () => {
  test('operaciones lista, filtra y abre detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await expect(page.getByRole('heading', { name: 'Impuestos', exact: true })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('XYZ789')).toBeVisible();

    await page.getByRole('button', { name: 'Solicitado', exact: true }).click();
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Luis Gómez')).toBeVisible();
  });

  test('seleccionar pendientes envía al gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/impuestos\/enviar$/, (route) => {
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['i1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
    await page.getByRole('button', { name: /Enviar al gestor/i }).click();
    await expect.poll(() => enviado).not.toBeNull();
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
});
