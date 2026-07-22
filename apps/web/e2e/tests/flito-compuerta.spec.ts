import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Compuerta de entrega (Fase 6). Habilita, no entrega: el paso a Entregado lo ejecuta
// Operaciones (revalidado en backend). Auditoría no ve el botón Entregar. Backend mockeado.

const HABILITADO = {
  tramiteId: 't1', idFlit: 'FLIT-1', placa: 'ABC123', companiaNombre: 'Concesionario Norte', estadoTramite: 'asignado',
  soatResuelto: true, soatDetalle: 'SOAT pagado con factura validada', impuestosResueltos: true, impuestosDetalle: 'Impuesto pagado y conciliado',
  valorSoat: 250000, valorImpuesto: 634900, habilitado: true,
};
const NO_HABILITADO = {
  tramiteId: 't2', idFlit: 'FLIT-2', placa: 'XYZ789', companiaNombre: 'Concesionario Norte', estadoTramite: 'asignado',
  soatResuelto: false, soatDetalle: 'SOAT en estado "en_adquisicion"', impuestosResueltos: true, impuestosDetalle: 'Impuesto pagado y conciliado',
  valorSoat: null, valorImpuesto: 634900, habilitado: false,
};

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/compuerta\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([HABILITADO, NO_HABILITADO]) }));
}

test.describe('FLITO — Compuerta de entrega', () => {
  test('operaciones ve las filas, el veredicto y el botón Entregar del habilitado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/compuerta');
    await expect(page.getByRole('heading', { name: 'Compuerta de entrega', exact: true })).toBeVisible();
    await expect(page.getByText('La compuerta habilita; no entrega.')).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('SOAT pagado con factura validada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entregar', exact: true })).toBeVisible();
  });

  test('entregar dispara la petición y refresca', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let entregado = false;
    await page.route(/\/api\/flito\/compuerta\/t1\/entregar$/, (route) => {
      entregado = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...HABILITADO, estadoTramite: 'entregado', habilitado: false }) });
    });

    await page.goto('/flito/compuerta');
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await expect.poll(() => entregado).toBe(true);
  });

  test('auditor ve la tabla pero no el botón Entregar', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/compuerta');
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entregar', exact: true })).toHaveCount(0);
  });
});
