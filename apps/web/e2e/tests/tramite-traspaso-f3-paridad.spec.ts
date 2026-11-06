// TRAM-TRASPASO-F3 — paridad CEA: paso 5 Fasecolda/ML/impuesto, paso 4 SIMIT
// comprador bloqueante + OCR, gate biométrico del contrato/FUR.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const SIMIT_OK = { _simitComprador: { documento: '222', consultado: true, total: 0, totalMonto: 0 } };
const COMERCIAL_OK = { _comercial: { valorVenta: 20000000, causal: 'COMPRAVENTA' } };

// El wizard retoma en el primer paso incompleto (traspaso-gates), no en `paso`. Con estos datos ese
// paso es el 4: falta SIMIT del comprador. `veh` completa o quita datos para abrir otro paso.
function tramite88(paso: number, veh: Record<string, unknown> = {}) {
  return {
    id: 88, vin: 'VIN88', placa: 'ABC123', estado: 'radicado', paso,
    modalidadEntrada: 'traspaso', tipologiaCodigo: 'traspaso_standard', numeroRadicado: 'TD-2026-00001',
    checklistEstado: {},
    vehiculo: {
      marca: 'MAZDA', linea: 'CX-30', modelo: '2020', vin: 'VIN88', cilindraje: 2000,
      _vendedor: { nombre: 'Carlos Vendedor', documento: '111', email: 'ven@x.co', ciudad: 'Medellín' },
      _runtVendedor: { documento: '111', tipoDoc: 'CC', consultado: true, consultadoAt: '2026-01-01T00:00:00.000Z' },
      _comprador: { nombre: 'Ana Compradora', documento: '222', email: 'comp@x.co', ciudad: 'Medellín' },
      _runtComprador: { documento: '222', tipoDoc: 'CC', consultado: true, consultadoAt: '2026-01-01T00:00:00.000Z' },
      ...veh,
    },
    comprador: { nombre: 'Ana Compradora', documento: '222', email: 'comp@x.co' },
  };
}

async function mockBackend(page: import('@playwright/test').Page, opts: { simitComprador?: number; valIniciales?: any[]; tramite?: unknown } = {}) {
  await page.route('**/api/runt/consulta-persona', async (r) => {
    const body = r.request().postDataJSON() as { documento?: string };
    const payload = body?.documento === '222'
      ? { ok: true, persona: { nombres: 'Ana', apellidos: 'Compradora', estadoPersona: 'ACTIVA' }, multas: [] }
      : body?.documento === '333'
        ? { ok: true, persona: { nombres: 'Pedro', apellidos: 'Sin Multas Run' } }
        : { ok: true, persona: { nombres: 'Carlos', apellidos: 'Vendedor' }, multas: [] };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/tramites/88/preflight', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ preflight: { overall: 'green', checks: [{ key: 'soat', label: 'SOAT vigente', status: 'ok', message: 'SOAT' }] } }) }));
  await page.route('**/api/tramites/88/documentos', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/tramites/88/firma', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firmas: [] }) }));
  await page.route('**/api/validacion-identidad/estado/88', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ validaciones: opts.valIniciales || [] }) }));
  await page.route('**/api/tramites/88', (r) => {
    if (r.request().method() === 'PATCH') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.tramite ?? tramite88(5)) });
  });
  await page.route('**/api/fasecolda/buscar**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mejorMatch: { codigo: '08123456', valorCOP: 50000000, descripcion: 'CX-30 TOURING' } }) }));
  await page.route('**/api/mercadolibre/precio**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, total: 30, precioMin: 45000000, precioPromedio: 52000000, precioMax: 60000000 }) }));
  await page.route('**/api/simit/consulta', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, total: opts.simitComprador ?? 0, totalMonto: (opts.simitComprador ?? 0) * 400000 }) }));
}

test.describe('Trámite · Traspaso F3 (paridad CEA)', () => {
  test('AC-F3-01/02/03: paso 5 Fasecolda + MercadoLibre + cálculo total', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page, { tramite: tramite88(5, SIMIT_OK) });
    await page.goto('/tramite/traspaso?id=88');

    await expect(page.getByText('5. Datos comerciales')).toBeVisible();

    // AC-F3-01: Fasecolda prellena valor de venta.
    await page.getByRole('button', { name: 'Traer valor' }).click();
    await expect(page.getByText(/Código 08123456/)).toBeVisible();
    await expect(page.getByLabel('Valor de venta')).toHaveValue('50000000');

    // AC-F3-02: MercadoLibre min/promedio/máx + usar promedio.
    await page.getByRole('button', { name: 'Consultar MercadoLibre' }).click();
    await expect(page.getByText(/Prom/)).toBeVisible();
    await page.getByRole('button', { name: 'Usar precio promedio' }).click();
    await expect(page.getByLabel('Valor de venta')).toHaveValue('52000000');

    // AC-F3-03: cálculo total = derechos + impuesto (1% de 52.000.000 = 520.000).
    await page.getByLabel('Tasa impuesto').fill('1');
    await page.getByLabel('Derechos del trámite').fill('100000');
    const total = page.getByTestId('comercial-total');
    await expect(total).toContainText('620.000');
  });

  test('AC-F3-03b: email inválido muestra error inline (MIMI H3)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    // Vendedor sin email: el paso 3 es el activo. Con el vendedor completo estaría cerrado (solo lectura).
    await mockBackend(page, { tramite: tramite88(3, { _vendedor: { nombre: 'Carlos Vendedor', documento: '111', ciudad: 'Medellín' } }) });
    await page.goto('/tramite/traspaso?id=88');
    await page.getByRole('button', { name: /Vendedor/ }).first().click();
    await page.getByRole('textbox', { name: '3. Vendedor (titular saliente) email' }).fill('no-es-email');
    await page.getByRole('button', { name: 'Guardar y continuar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /email es obligatorio/i })).toBeVisible();
  });

  test('AC-F3-04a: paso 4 sin consultar SIMIT bloquea continuar (MIMI H1)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page, { simitComprador: 3 });
    await page.goto('/tramite/traspaso?id=88');
    await page.getByRole('button', { name: /Comprador/ }).first().click();

    await expect(page.getByText('4. Comprador (adquiriente)')).toBeVisible();
    await page.getByRole('textbox', { name: '4. Comprador (adquiriente) documento' }).fill('333');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await expect(page.getByText(/Use «Consultar RUNT» arriba — trae multas y comparendos/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar y continuar' })).toBeDisabled();
  });

  test('AC-F3-04: paso 4 con multas SIMIT del comprador bloquea continuar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page, { simitComprador: 3 });
    // Paso guardado 5, pero sin SIMIT del comprador retoma en el 4.
    await page.goto('/tramite/traspaso?id=88');
    await page.getByRole('button', { name: /Comprador/ }).first().click();

    await expect(page.getByText('4. Comprador (adquiriente)')).toBeVisible();
    // 333: RUNT no trae multas. SIMIT directo solo se ofrece entonces; si RUNT las trae (222), ya resuelve.
    await page.getByRole('textbox', { name: '4. Comprador (adquiriente) documento' }).fill('333');
    await page.getByRole('button', { name: /Consultar RUNT/i }).click();
    await page.getByRole('button', { name: 'Consultar SIMIT directo' }).click();
    await expect(page.getByText(/comparendo\(s\) pendientes/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar y continuar' })).toBeDisabled();
  });

  test('AC-F3-05: sin biométrica el FUR queda deshabilitado y el contrato disponible como borrador', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    // Sin validaciones aprobadas → gate activo.
    await mockBackend(page, { valIniciales: [], tramite: tramite88(6, { ...SIMIT_OK, ...COMERCIAL_OK }) });
    await page.goto('/tramite/traspaso?id=88');

    await expect(page.getByText('6. Documentos y firma')).toBeVisible();
    const identidad = page.getByText('Validación de identidad (vendedor y comprador)');
    const legales = page.getByText('Contrato de compraventa y documentos legales');
    await expect(identidad).toBeVisible();
    await expect(legales).toBeVisible();
    const [identidadY, legalesY] = await Promise.all([
      identidad.evaluate((el) => el.getBoundingClientRect().top),
      legales.evaluate((el) => el.getBoundingClientRect().top),
    ]);
    expect(identidadY).toBeLessThan(legalesY);
    // El contrato sin sellos no exige biométrica: lo dicen este aviso, `requiereBiometria` y /generar-contrato.
    await expect(page.getByText(/Puedes generar el/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Generar Contrato de compraventa/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: /Generar FUR/i })).toBeDisabled();
    // Improntas no requiere biométrica.
    await expect(page.getByRole('button', { name: /Generar Improntas/i })).toBeEnabled();
  });

  test('AC-F3-05b: con ambas biométricas aprobadas el contrato se habilita', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockBackend(page, { valIniciales: [
      { id: 1, documento: '111', estado: 'aprobado', score: 95 },
      { id: 2, documento: '222', estado: 'aprobado', score: 92 },
    ], tramite: tramite88(6, { ...SIMIT_OK, ...COMERCIAL_OK }) });
    await page.goto('/tramite/traspaso?id=88');

    await expect(page.getByText('6. Documentos y firma')).toBeVisible();
    await expect(page.getByRole('button', { name: /Generar Contrato de compraventa/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: /Generar FUR/i })).toBeEnabled();
  });
});
