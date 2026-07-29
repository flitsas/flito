import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Logística. Consola de Operaciones en tres pestañas: Trámites (aprobados, con su estado
// logístico), Generación de actas (LT registradas por empresa) y Actas (despacho y firma).
//
// El vocabulario es de CINCO estados —pendiente, registrada, despachada, entregada, novedad— que
// colapsan los internos del documento; la fila los trae ya resueltos en `estadoSimple` y
// `estadoSimpleLabel`. El backend está mockeado; se verifica el cableado de la UI.

const TRAMITES = [
  {
    tramiteId: 'tr-1', idFlit: 'FLIT-2001', placa: 'ABC123', vin: 'VIN0000000000001', propietario: 'Emmanuel David',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    docId: null, estadoSimple: 'pendiente', estadoSimpleLabel: 'Pendiente de recogida', numeroLicencia: null, numeroLt: null,
    actaId: null, motivo: null, actualizadoEn: null,
  },
  {
    tramiteId: 'tr-2', idFlit: 'FLIT-2002', placa: 'XYZ789', vin: 'VIN0000000000002', propietario: 'Ana Ruiz',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    docId: 'doc-2', estadoSimple: 'registrada', estadoSimpleLabel: 'Registrada', numeroLicencia: '100381', numeroLt: 'LT-77',
    actaId: null, motivo: null, actualizadoEn: '2026-07-20T11:00:00Z',
  },
  {
    tramiteId: 'tr-3', idFlit: 'FLIT-2003', placa: 'DEF456', vin: 'VIN0000000000003', propietario: 'Carlos Paz',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    docId: 'doc-3', estadoSimple: 'entregada', estadoSimpleLabel: 'Entregada', numeroLicencia: '100382', numeroLt: 'LT-88',
    actaId: 'acta-9', motivo: null, actualizadoEn: '2026-07-21T09:00:00Z',
  },
];

const ACTAS = [
  { id: 'acta-1', companiaId: 5, companiaNombre: 'Concesionario Norte', estado: 'generada', estadoLabel: 'Generada', mensajeroId: null, mensajeroNombre: null, documentos: 2, receptorNombre: null, entregadoEn: null, creadoEn: '2026-07-21T08:00:00Z' },
  { id: 'acta-2', companiaId: 6, companiaNombre: 'Concesionario Sur', estado: 'despachada', estadoLabel: 'Despachada', mensajeroId: 9, mensajeroNombre: 'Mensajero E2E', documentos: 3, receptorNombre: null, entregadoEn: null, creadoEn: '2026-07-21T07:00:00Z' },
];

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }],
  companiasCerrables: [{ companiaId: 5, nombre: 'Concesionario Norte', disponibles: 1 }],
  mensajeros: [{ id: 9, nombre: 'Mensajero E2E' }],
};

async function mockLogistica(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTAS) }));
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: TRAMITES, total: TRAMITES.length, page: 1, pageSize: 50 }) }));
}

test.describe('FLITO — Logística', () => {
  test('operaciones ve los trámites aprobados, estados y las actas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLogistica(page);

    await page.goto('/flito/logistica');
    await expect(page.getByRole('heading', { name: 'Logística', exact: true })).toBeVisible();
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    // Estado logístico por trámite, dentro de su fila y en el vocabulario de cinco.
    await expect(page.getByRole('row', { name: /ABC123/ }).getByText('Pendiente de recogida')).toBeVisible();
    await expect(page.getByRole('row', { name: /XYZ789/ }).getByText('Registrada')).toBeVisible();
    await expect(page.getByRole('row', { name: /DEF456/ }).getByText('Entregada')).toBeVisible();

    // Las actas viven en su propia pestaña: la consola dejó de mezclarlas con los trámites.
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('row', { name: /Concesionario Sur/ }).getByText('Despachada')).toBeVisible();
  });

  test('firmar y despachar un acta envía la firma de entrega', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLogistica(page);
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1\/despachar$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentos: 2 }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: 'Firmar y despachar' }).first().click();
    await page.getByRole('combobox').last().selectOption('9');

    // Firma de quien entrega (Operaciones): PointerEvents con bubbles para la delegación de React.
    await page.getByLabel('Firma del receptor').evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
    });

    const confirmar = page.getByRole('button', { name: 'Firmar y despachar' }).last();
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ mensajeroId: 9 });
    expect(typeof body!.firmaEntrega).toBe('string');
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
    // El «Cerrar lote» de un solo botón pasó a ser una pestaña con una empresa por fila: cada una
    // genera SU acta con las LT que su mensajero radicó.
    await page.getByRole('button', { name: /^Generación de actas/ }).click();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByText('1 LT registrada(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Generar acta' }).click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ companiaId: 5 });
  });

  test('auditor entra en solo lectura: sin acciones', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockLogistica(page);

    await page.goto('/flito/logistica');
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await page.getByRole('button', { name: /^Generación de actas/ }).click();
    await expect(page.getByRole('button', { name: 'Generar acta' })).toHaveCount(0);
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: 'Firmar y despachar' })).toHaveCount(0);
  });
});
