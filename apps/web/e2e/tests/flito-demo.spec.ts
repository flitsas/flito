import { test, expect } from '@playwright/test';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Panel de demo (Fase 6). Andamiaje solo-Operaciones para fabricar
// trámites en el FLIT simulado. Backend mockeado.

const TRAMITES = [
  {
    idFlit: 'FLIT-9001', estado: 'asignado', processStatus: 5, placa: 'DEM001', vin: 'VINDEMO000000001',
    marca: 'Chevrolet', linea: 'Onix', companiaNit: '900111', organismoCodigo: 'STT-MZL',
    tipoPropiedad: 'unico_propietario', valorImpuestoLiquidado: 120000, creadoEn: '2026-04-01T12:00:00Z',
  },
];
const COMPANIAS = [{ id: 1, nombre: 'Concesionario Norte' }];
const ORGANISMOS = [{ codigo: 'STT-MZL', nombre: 'STT Manizales' }];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/demo\/tramites$/, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TRAMITES) });
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ idFlit: 'FLIT-9002' }) });
  });
  await page.route(/\/api\/flito\/parametrizacion\/companias/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COMPANIAS) }));
  await page.route(/\/api\/flito\/parametrizacion\/organismos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORGANISMOS) }));
}

test.describe('FLITO — Panel de demo', () => {
  test('operaciones ve el panel, el formulario y la lista', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/demo');
    await expect(page.getByRole('heading', { name: 'Panel de demo', exact: true })).toBeVisible();
    await expect(page.getByText('Crear trámite simulado')).toBeVisible();
    await expect(page.getByText('FLIT-9001')).toBeVisible();
    await expect(page.getByText('DEM001')).toBeVisible();
  });

  test('sincronizar desde FLIT dispara la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let sincronizado = false;
    await page.route(/\/api\/flito\/sync\/sincronizar$/, (route) => {
      sincronizado = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/flito/demo');
    await page.getByRole('button', { name: /Sincronizar desde FLIT/i }).click();
    await expect.poll(() => sincronizado).toBe(true);
    await expect(page.getByText(/Sincronización ejecutada/i)).toBeVisible();
  });

  test('auditor no tiene acceso al panel de demo', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/demo');
    await expect(page.getByRole('heading', { name: 'Panel de demo', exact: true })).toHaveCount(0);
  });
});
