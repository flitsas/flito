import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Logística (Fase 1). Consola de Operaciones: trazabilidad por documento, recogida,
// cierre de lote → acta y despacho. El backend está mockeado; aquí verificamos el cableado de la UI.

const DOCS = [
  {
    id: 'doc-1', tramiteId: 'tr-1', idFlit: 'FLIT-2001', tipo: 'licencia_transito', tipoLabel: 'Licencia de tránsito',
    estado: 'generado', estadoLabel: 'Generado', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', placa: 'ABC123', vin: 'VIN0000000000001',
    identificador: null, actaId: null, motivo: null, creadoEn: '2026-07-20T10:00:00Z', actualizadoEn: '2026-07-20T10:00:00Z',
  },
  {
    id: 'doc-2', tramiteId: 'tr-2', idFlit: 'FLIT-2002', tipo: 'placa', tipoLabel: 'Placa',
    estado: 'clasificado', estadoLabel: 'Clasificado', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', placa: 'XYZ789', vin: 'VIN0000000000002',
    identificador: null, actaId: null, motivo: null, creadoEn: '2026-07-20T11:00:00Z', actualizadoEn: '2026-07-20T11:00:00Z',
  },
  {
    id: 'doc-3', tramiteId: 'tr-3', idFlit: 'FLIT-2003', tipo: 'licencia_transito', tipoLabel: 'Licencia de tránsito',
    estado: 'entregado', estadoLabel: 'Entregado', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', placa: 'DEF456', vin: 'VIN0000000000003',
    identificador: null, actaId: 'acta-9', motivo: null, creadoEn: '2026-07-19T09:00:00Z', actualizadoEn: '2026-07-21T09:00:00Z',
  },
];

const ACTAS = [
  { id: 'acta-1', companiaId: 5, companiaNombre: 'Concesionario Norte', estado: 'generada', estadoLabel: 'Generada', mensajeroId: null, mensajeroNombre: null, documentos: 2, receptorNombre: null, entregadoEn: null, creadoEn: '2026-07-21T08:00:00Z' },
  { id: 'acta-2', companiaId: 6, companiaNombre: 'Concesionario Sur', estado: 'despachada', estadoLabel: 'Despachada', mensajeroId: 9, mensajeroNombre: 'Mensajero E2E', documentos: 3, receptorNombre: null, entregadoEn: null, creadoEn: '2026-07-21T07:00:00Z' },
];

const FACETAS = {
  estados: ['generado', 'recogido', 'clasificado', 'en_acta', 'despachado', 'entregado', 'novedad', 'devuelto'],
  tipos: ['licencia_transito', 'placa', 'otro'],
  empresas: [{ nit: '900111', nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }],
  companiasCerrables: [{ companiaId: 5, nombre: 'Concesionario Norte', disponibles: 1 }],
  mensajeros: [{ id: 9, nombre: 'Mensajero E2E' }],
};

async function mockLogistica(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/logistica\/actas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTAS) }));
  // Listado paginado (el regex del listado no debe capturar /actas ni /facetas: usa el sufijo de query).
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: DOCS, total: DOCS.length, page: 1, pageSize: 50 }) }));
}

test.describe('FLITO — Logística', () => {
  test('operaciones ve la tabla, estados y las actas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLogistica(page);

    await page.goto('/flito/logistica');
    await expect(page.getByRole('heading', { name: 'Logística', exact: true })).toBeVisible();
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    // Chips de estado por documento (dentro de su fila; el mismo texto también aparece como píldora de filtro).
    await expect(page.getByRole('row', { name: /ABC123/ }).getByText('Generado')).toBeVisible();
    await expect(page.getByRole('row', { name: /DEF456/ }).getByText('Entregado')).toBeVisible();
    // Panel de actas (estado del acta, texto distinto a las píldoras de documento).
    await expect(page.getByText('Despachada', { exact: true })).toBeVisible();
    // Acción de Operaciones disponible.
    await expect(page.getByRole('button', { name: 'Cerrar lote' })).toBeVisible();
  });

  test('recoger un documento generado envía la solicitud', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLogistica(page);
    let body: unknown = null;
    await page.route(/\/api\/flito\/logistica\/recoger$/, async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recogidos: 1, clasificados: 1, omitidos: 0 }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Recoger' }).first().click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ documentoIds: ['doc-1'] });
  });

  test('cerrar lote genera el acta de una empresa', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLogistica(page);
    let body: unknown = null;
    await page.route(/\/api\/flito\/logistica\/cerrar-lote$/, async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ actaId: 'acta-nueva', documentos: 1 }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Cerrar lote' }).click();
    // Modal con la empresa cerrable.
    await expect(page.getByText('1 clasificado(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Generar acta' }).click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ companiaId: 5 });
  });

  test('auditor entra en solo lectura: sin acciones', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockLogistica(page);

    await page.goto('/flito/logistica');
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar lote' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recoger' })).toHaveCount(0);
  });
});
