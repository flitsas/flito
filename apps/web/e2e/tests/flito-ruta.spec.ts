import { test, expect } from '../helpers/fixtures';
import { loginAs, MENSAJERO_USER } from '../helpers/auth';

// FLITO — Mi ruta (mensajero, Fase 2 · Incremento 2). Vista mobile de campo: recogidas por organismo
// y entregas de sus actas despachadas. Backend mockeado; verificamos el cableado de la UI.

const RUTA = {
  recogidas: [
    {
      organismoCodigo: '05001', organismoNombre: 'STT Medellín',
      documentos: [
        { id: 'doc-1', tipo: 'licencia_transito', tipoLabel: 'Licencia de tránsito', placa: 'ABC123', idFlit: 'FLIT-1' },
        { id: 'doc-2', tipo: 'placa', tipoLabel: 'Placa', placa: 'XYZ789', idFlit: 'FLIT-2' },
      ],
    },
  ],
  entregas: [
    {
      actaId: 'acta-1', companiaNombre: 'Concesionario Norte', direccionEntrega: 'Calle 10 #20-30', contactoNombre: 'Juan',
      documentos: [{ id: 'doc-3', tipo: 'placa', tipoLabel: 'Placa', placa: 'DEF456', idFlit: 'FLIT-3' }],
    },
  ],
};

test.describe('FLITO — Mi ruta (mensajero)', () => {
  test('ve recogidas y entregas; confirmar recogida envía los seleccionados', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    let body: unknown = null;
    await page.route(/\/api\/flito\/logistica\/recoger$/, async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recogidos: 1, clasificados: 1, omitidos: 0 }) });
    });

    await page.goto('/flito/ruta');
    await expect(page.getByRole('heading', { name: 'Mi ruta' })).toBeVisible();
    await expect(page.getByText('STT Medellín')).toBeVisible();
    await expect(page.getByText('ABC123', { exact: false })).toBeVisible();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();

    // Marca el primer documento y confirma la recogida.
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: /Confirmar recogida/ }).click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ documentoIds: ['doc-1'] });
  });

  test('registrar entrega envía nombre y documento del receptor', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    let body: unknown = null;
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1\/entregar$/, async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentos: 1 }) });
    });

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await page.getByPlaceholder('Nombre del receptor').fill('María Ruiz');
    await page.getByPlaceholder('Documento del receptor').fill('30303030');
    await page.getByRole('button', { name: 'Confirmar entrega' }).click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ receptorNombre: 'María Ruiz', receptorDocumento: '30303030' });
  });
});
