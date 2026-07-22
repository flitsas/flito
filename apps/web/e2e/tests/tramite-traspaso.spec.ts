// TRAM-TRASPASO-F1.5 — wizard de traspaso 6 pasos (alineado a CEA), placa-first.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const VEH = { ok: true, data: { vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123', vin: 'VIN88' } } };
const PERSONA_VENDEDOR = { ok: true, persona: { nombres: 'Carlos', apellidos: 'Vendedor' } };
const PERSONA_COMPRADOR = { ok: true, persona: { nombres: 'Ana', apellidos: 'Compradora', estadoPersona: 'ACTIVA' } };

function tramite88(paso: number, extra: Record<string, unknown> = {}) {
  return {
    id: 88, vin: 'VIN88', placa: 'ABC123', estado: 'radicado', paso,
    modalidadEntrada: 'traspaso', tipologiaCodigo: 'traspaso_standard', numeroRadicado: 'TD-2026-00001',
    vehiculo: { marca: 'Mazda', linea: 'CX-30', vin: 'VIN88' }, comprador: null, ...extra,
  };
}

async function mockBackend(page: import('@playwright/test').Page, preflightOverall: 'green' | 'red' = 'green') {
  await page.route('**/api/runt/consulta-vehiculo', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VEH) }));
  await page.route('**/api/runt/consulta-persona', async (r) => {
    const body = r.request().postDataJSON() as { documento?: string };
    const payload = body?.documento === '222' ? PERSONA_COMPRADOR : PERSONA_VENDEDOR;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/tramites/preflight', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ overall: preflightOverall, checks: [{ key: 'soat', label: 'SOAT vigente', status: preflightOverall === 'red' ? 'fail' : 'ok', message: 'SOAT' }] }) }));
  await page.route('**/api/tramites/88/firma', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmas: [] }) }));
  await page.route('**/api/tramites/88', (r) => {
    if (r.request().method() === 'PATCH') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tramite88(3, { vehiculo: { marca: 'Mazda', linea: 'CX-30', vin: 'VIN88', _vendedor: { nombre: 'Carlos Vendedor', documento: '111' } } })) });
  });
  await page.route('**/api/tramites', (r) => {
    if (r.request().method() === 'POST') return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(tramite88(1)) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('Trámite · Traspaso wizard 6 pasos (F1.5)', () => {
  test('flujo completo placa-first → 6 pasos sin VIN', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page);
    await page.goto('/tramite/traspaso');

    // Paso 1 — vehículo (placa+doc, NUNCA VIN).
    await expect(page.getByText('1. Vehículo y propietario')).toBeVisible();
    await expect(page.getByPlaceholder('Numero VIN...')).toHaveCount(0); // AC-01: nunca VIN-first
    await page.getByLabel('Placa').fill('ABC123');
    await page.getByLabel('Documento propietario').fill('111');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await expect(page.getByText(/Mazda CX-30/)).toBeVisible();
    await page.getByRole('button', { name: /Radicar y continuar/i }).click();

    // Paso 2 — validación legal (pre-vuelo).
    await expect(page.getByText('2. Validación legal (RUNT/SIMIT)')).toBeVisible();
    await expect(page.getByText('SOAT vigente')).toBeVisible();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();

    // Paso 3 — vendedor (prellenado RUNT). F3: email obligatorio para la firma.
    await expect(page.getByText('3. Vendedor (titular saliente)')).toBeVisible();
    await page.getByRole('textbox', { name: '3. Vendedor (titular saliente) documento' }).fill('111');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await expect(page.getByText(/Persona en RUNT: Carlos Vendedor/)).toBeVisible();
    await page.getByRole('textbox', { name: '3. Vendedor (titular saliente) email' }).fill('ven@x.co');
    await page.getByRole('button', { name: /Guardar y continuar/i }).click();

    // Paso 4 — comprador (consulta RUNT, paridad con vendedor).
    await expect(page.getByText('4. Comprador (adquiriente)')).toBeVisible();
    await page.getByRole('textbox', { name: '4. Comprador (adquiriente) documento' }).fill('222');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await expect(page.getByText(/Persona en RUNT: Ana Compradora/)).toBeVisible();
    await expect(page.getByLabel(/Comprador.*nombre/)).toHaveValue('Ana Compradora');
    await page.getByRole('textbox', { name: '4. Comprador (adquiriente) email' }).fill('comp@x.co');
    await page.getByRole('button', { name: /Guardar y continuar/i }).click();

    // Paso 5 — comercial.
    await expect(page.getByText('5. Datos comerciales')).toBeVisible();
    await page.getByLabel('Valor de venta').fill('20000000');
    await page.getByRole('button', { name: /Guardar y continuar/i }).click();

    // Paso 6 — documentos + firma B3 (AC-05).
    await expect(page.getByText('6. Documentos y firma')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Firma electrónica' })).toBeVisible();
  });

  test('AC-02: abrir traspaso radicado por ?id retoma el wizard traspaso (no VIN)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page);
    await page.goto('/tramite/traspaso?id=88');
    // Hidrata en el paso guardado (3 = vendedor), nunca el wizard VIN.
    await expect(page.getByText('3. Vendedor (titular saliente)')).toBeVisible();
    await expect(page.getByPlaceholder('Numero VIN...')).toHaveCount(0);
  });

  test('AC-03: pre-vuelo con bloqueo crítico deshabilita Continuar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page, 'red');
    await page.goto('/tramite/traspaso');
    await page.getByLabel('Placa').fill('ABC123');
    await page.getByLabel('Documento propietario').fill('111');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await page.getByRole('button', { name: /Radicar y continuar/i }).click();
    await expect(page.getByText('2. Validación legal (RUNT/SIMIT)')).toBeVisible();
    await expect(page.getByText(/bloqueos críticos/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toBeDisabled();
  });
});
