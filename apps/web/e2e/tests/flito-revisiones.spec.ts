import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Revisiones OCR (Fase 6). Cola resoluble campo por campo (RN-04/RN-05): nada se da por
// válido sin confirmación humana. Operaciones resuelve; Auditoría solo lee. Backend mockeado.

const REVISION_SOAT = {
  id: 'r1', modulo: 'soat', motivo: 'llave_no_cruza', detalle: 'La placa leída no coincide con el trámite',
  registroId: null, placaSugerida: 'ABC123',
  extraccion: { placa: { valor: 'ABC123', confianza: 0.6, confiable: false }, valorTotal: { valor: '250000', confianza: 0.9, confiable: true } },
  resuelto: false, creadoEn: '2026-07-10T12:00:00Z', soporte: { id: 'sop1', nombreArchivo: 'comprobante-soat.pdf' },
};
const SOAT_CANDIDATOS = [{ id: 'soat1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix' }];

async function mockLista(page: import('@playwright/test').Page, soat: unknown[]) {
  await page.route(/\/api\/flito\/revisiones\?/, (route) => {
    const url = route.request().url();
    const body = url.includes('modulo=soat') ? soat : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/\/api\/flito\/revisiones\/campos\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['placa', 'vin', 'valorTotal']) }));
  await page.route(/\/api\/flito\/revisiones\/soporte\/.*\/archivo$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }));
  await page.route(/\/api\/flito\/soat$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SOAT_CANDIDATOS) }));
  await page.route(/\/api\/flito\/impuestos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
}

test.describe('FLITO — Revisiones OCR', () => {
  test('operaciones ve la cola, el documento seleccionado y el formulario de confirmación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page, [REVISION_SOAT]);

    await page.goto('/flito/revisiones');
    await expect(page.getByRole('heading', { name: 'Revisiones OCR', exact: true })).toBeVisible();
    await expect(page.getByText('comprobante-soat.pdf').first()).toBeVisible();
    // El formulario auto-selecciona el primer ítem: detalle + selector de trámite visibles.
    await expect(page.getByText('La placa leída no coincide con el trámite')).toBeVisible();
    await expect(page.getByText('Trámite contra el que se concilia *')).toBeVisible();
    // Botón de resolver deshabilitado hasta elegir un trámite.
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toBeDisabled();
  });

  test('cola vacía muestra el estado vacío', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page, []);

    await page.goto('/flito/revisiones');
    await expect(page.getByText('No hay nada en revisión.', { exact: false })).toBeVisible();
  });

  test('auditor entra en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockLista(page, [REVISION_SOAT]);

    await page.goto('/flito/revisiones');
    await expect(page.getByText(/Auditoría ve la cola y los soportes, pero no los resuelve/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar y resolver' })).toHaveCount(0);
  });
});
