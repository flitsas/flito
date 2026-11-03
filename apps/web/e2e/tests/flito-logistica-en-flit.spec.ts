import { test, expect } from '../helpers/fixtures';
import { loginAs, MENSAJERO_USER, OPERACIONES_USER } from '../helpers/auth';

// HU #14121 — «En FLIT» se ve en la consola (chip + filtro) y en Mi ruta (LT pendiente de firma).
// El backend está mockeado; se verifica el cableado de la UI.

const FILA_EN_FLIT = {
  tramiteId: 'tr-flit', idFlit: 'FLIT-14121', placa: 'QOX858', vin: 'VIN00000000014121', propietario: 'Ana Ruiz',
  companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
  docId: 'doc-flit', estado: 'en_flit', estadoLabel: 'En FLIT', estadoSimple: 'en_flit', estadoSimpleLabel: 'En FLIT',
  numeroLicencia: '100381', numeroLt: 'LT-14121', actaId: null, motivo: null, actualizadoEn: '2026-10-28T11:00:00Z',
};

const FACETAS = {
  estados: ['pendiente', 'registrada', 'en_flit', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }],
  companiasCerrables: [],
  mensajeros: [],
};

test.describe('FLITO — Logística · En FLIT (HU #14121)', () => {
  test('consola: la fila muestra En FLIT y el filtro lo ofrece', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
    await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route(/\/api\/flito\/logistica\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [FILA_EN_FLIT], total: 1, page: 1, pageSize: 50 }) }));

    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: 'En FLIT' })).toBeVisible();
    await expect(page.getByRole('row', { name: /QOX858/ }).getByText('En FLIT')).toBeVisible();
    await expect(page.getByRole('row', { name: /QOX858/ }).getByText('Pendiente')).toHaveCount(0);
  });

  test('Mi ruta: una LT en en_flit muestra En FLIT', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER, {
      funciones: ['logistica.ruta.ver', 'logistica.recogida.confirmar'],
    });
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entregas: [] }) }));
    await page.route(/\/api\/flito\/logistica\/recogidas\/mias$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recogidas: [], pendientesFirma: 1 }) }));
    await page.route(/\/api\/flito\/logistica\/recogidas\/pendientes-firma$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          pendientes: [{
            documentoId: 'p-flit', placa: 'QOX858', numeroLt: 'LT-14121', idFlit: 'FLIT-14121',
            companiaId: 5, companiaNombre: 'Concesionario Norte', organismoCodigo: '05001',
            pendienteTramite: false, estado: 'en_flit', fecha: '2026-10-28T15:00:00Z',
          }],
        }),
      }));

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: /Mis recogidas/ }).click();
    await expect(page.getByText('QOX858 · LT-14121')).toBeVisible();
    await expect(page.getByText('En FLIT', { exact: true })).toBeVisible();
    await expect(page.getByText('Pendiente de recogida')).toHaveCount(0);
  });
});
