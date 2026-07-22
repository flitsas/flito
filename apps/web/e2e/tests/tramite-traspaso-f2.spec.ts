// TRAM-TRASPASO-F2 — capa legal CEA en el paso 6 del traspaso:
// checklist + generación de documentos (proxy CEA) + gate de firma por contrato.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

function tramite88(extra: Record<string, unknown> = {}) {
  return {
    id: 88, vin: 'VIN88', placa: 'ABC123', estado: 'radicado', paso: 6,
    modalidadEntrada: 'traspaso', tipologiaCodigo: 'traspaso_standard', numeroRadicado: 'TD-2026-00001',
    checklistEstado: {},
    vehiculo: {
      marca: 'Mazda', linea: 'CX-30', vin: 'VIN88',
      _vendedor: { nombre: 'Carlos Vendedor', documento: '111', ciudad: 'Medellín' },
      _comprador: { nombre: 'Ana Compradora', documento: '222', ciudad: 'Medellín' },
      _comercial: { valorVenta: 20000000, causal: 'COMPRAVENTA' },
    },
    comprador: { nombre: 'Ana Compradora', documento: '222' },
    ...extra,
  };
}

async function mockPaso6(page: import('@playwright/test').Page) {
  await page.route('**/api/tramites/88/documentos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/tramites/88/firma', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmas: [] }) }));
  // F3: el contrato exige biométrica aprobada de ambas partes → mock aprobado.
  await page.route('**/api/validacion-identidad/estado/88', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ validaciones: [
      { id: 1, documento: '111', estado: 'aprobado', score: 95 },
      { id: 2, documento: '222', estado: 'aprobado', score: 92 },
    ] }) }));
  await page.route('**/api/tramites/88', (r) => {
    if (r.request().method() === 'PATCH') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tramite88()) });
  });
}

test.describe('Trámite · Traspaso F2 (documentos legales CEA)', () => {
  test('AC-F2: microcopy de gastos al comprador + gate de firma sin contrato', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPaso6(page);
    await page.goto('/tramite/traspaso?id=88');

    await expect(page.getByText('6. Documentos y firma')).toBeVisible();
    await expect(page.getByText(/Siguiente:/i)).toBeVisible();
    await expect(page.getByText('Anexos del expediente')).toBeVisible();
    await expect(page.getByText('Validación de identidad (vendedor y comprador)')).toBeVisible();

    // Cláusula quinta: los gastos del traspaso y el impuesto los asume el comprador.
    await expect(page.getByText(/gastos del traspaso y el impuesto derivado serán asumidos por el comprador/i)).toBeVisible();

    // Gate: sin contrato, la firma muestra el aviso y deshabilita "Solicitar firma".
    await expect(page.getByText(/Genera o sube el contrato de compraventa antes de solicitar la firma/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solicitar firma' }).first()).toBeDisabled();
  });

  test('AC-F2: generar contrato habilita la firma electrónica', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockPaso6(page);
    // El proxy CEA devuelve el PDF del contrato.
    await page.route('**/api/tramites/88/generar-contrato', (r) =>
      r.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 contrato' }));
    await page.goto('/tramite/traspaso?id=88');

    await expect(page.getByText('6. Documentos y firma')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solicitar firma' }).first()).toBeDisabled();

    // Generar el contrato (descarga el PDF).
    const downloadPromise = page.waitForEvent('download').catch(() => null);
    await page.getByRole('button', { name: /Generar Contrato de compraventa/i }).click();
    await downloadPromise;

    // Tras generar, el gate se libera: el aviso desaparece y la firma se habilita.
    await expect(page.getByText(/antes de solicitar la firma/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Solicitar firma' }).first()).toBeEnabled();
  });
});
