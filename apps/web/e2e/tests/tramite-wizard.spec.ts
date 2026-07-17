// TRAM-07b — E2E del wizard admin `TramiteDigital` (matrícula inicial B01).
//
// Complementa TRAM-07 (bandeja tránsito). Cubre el tramo del wizard: arranque
// (VIN → RUNT) y el cierre (enviar a tránsito → enviado_transito), con dos
// negativos. La API se mockea con page.route (patrón transito-bandeja.spec).
//
// Nota: el wizard es state-heavy. Para el flujo de envío reutilizamos la
// hidratación de `continuarTramite` (resume un trámite en paso 5) en vez de
// teclear los 5 pasos, lo que sería frágil (polling de identidad, OCR, etc.).

import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { jsonRoute } from '../helpers/pesv-fixtures';

const VIN = 'MAZ123TEST456789';

function tramitePaso5(opts: { withOrg: boolean }) {
  return {
    id: 77,
    vin: VIN,
    placa: 'ABC123',
    estado: 'borrador',
    paso: 5,
    vehiculo: {
      marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123',
      ...(opts.withOrg ? { _orgTransito: { nombre: 'STT Medellín', ciudad: 'Medellín', codigo: '05001' } } : {}),
    },
    comprador: { nombre: 'Ana Pérez', tipoDoc: 'CC', documento: '1020304050' },
  };
}

const REQUIRED_DOCS = [
  { id: 1, tipo: 'factura', originalName: 'factura.pdf' },
  { id: 2, tipo: 'aduana', originalName: 'aduana.pdf' },
  { id: 3, tipo: 'impronta', originalName: 'impronta.pdf' },
];

// Catch-all: absorbe fetches incidentales (ExpedienteVisor, etc.) que no mockeamos
// explícitamente, para que no golpeen la red. Se registra PRIMERO (menor prioridad).
async function setupBase(page: import('@playwright/test').Page) {
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/api/auth/')) return route.continue();
    return jsonRoute(200, {})(route);
  });
  await loginAs(page, ADMIN_USER);
}

test.describe('Trámite · Wizard admin (matrícula inicial)', () => {
  test('arranque: VIN → RUNT (mock) → avanza a paso Documentos', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') return jsonRoute(201, { id: 1 })(route);
      return jsonRoute(200, [])(route); // lista vacía
    });
    await page.route('**/api/tramites/1', (route) => jsonRoute(200, { id: 1, paso: 2 })(route));
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123' } } })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    // Aparece la tarjeta del vehículo + botón de avance.
    await page.getByRole('button', { name: /guardar y continuar/i }).click();
    await expect(page.getByText(/Carga de documentos/i)).toBeVisible();
  });

  test('negativo: VIN no encontrado en RUNT → error, no avanza', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [], total: [].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: false, message: 'No encontrado en RUNT' })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill('NOEXISTE000000000');
    await page.getByRole('button', { name: /consultar runt/i }).click();

    await expect(page.locator('[role="status"]', { hasText: /no encontrado/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /guardar y continuar/i })).toHaveCount(0);
  });

  test('enviar a tránsito: resume paso 5 listo → enviado_transito', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso5({ withOrg: true })], total: [tramitePaso5({ withOrg: true })].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/validacion-identidad/estado/77', (route) =>
      jsonRoute(200, { ok: true, validaciones: [{ estado: 'aprobado', score: 95 }] })(route));
    await page.route('**/api/tramites/77/documentos', (route) => jsonRoute(200, REQUIRED_DOCS)(route));
    let enviado = false;
    await page.route('**/api/tramites/77', (route) => {
      if (route.request().method() === 'PATCH') {
        const b = route.request().postDataJSON();
        if (b?.estado === 'enviado_transito') enviado = true;
        return jsonRoute(200, { id: 77, estado: b?.estado ?? 'borrador' })(route);
      }
      return jsonRoute(200, tramitePaso5({ withOrg: true }))(route);
    });

    await page.goto('/tramite');
    // TRAM-OPS-01: la vista por defecto es el Embudo; el resume por VIN vive en la
    // pestaña Lista. Cambiamos de pestaña antes de abrir el trámite.
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click(); // abrir/resume el trámite
    const enviarBtn = page.getByRole('button', { name: /enviar a tránsito/i });
    await expect(enviarBtn).toBeEnabled();
    await enviarBtn.click();
    await expect(page.locator('[role="status"]', { hasText: /enviado a tr[aá]nsito/i })).toBeVisible();
    expect(enviado).toBe(true);
  });

  test('pre-vuelo: SOAT fail → CTA Subir SOAT visible', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') return jsonRoute(201, { id: 1 })(route);
      return jsonRoute(200, [])(route);
    });
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123' } } })(route));
    await page.route('**/api/tramites/preflight', (route) =>
      jsonRoute(200, {
        overall: 'red',
        checks: [
          // PRE-02: la CTA llega server-driven en `action`.
          { key: 'soat', label: 'SOAT vigente', status: 'fail', source: 'RUNT', message: 'SOAT vencido. Requiere renovación.', action: { kind: 'step', label: 'Subir SOAT', ctaId: 'soat_subir', step: 2 } },
        ],
      })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    await expect(page.getByText(/Pre-vuelo con bloqueos/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /subir soat/i })).toBeVisible();
  });

  // TRAM-TIPO-01: journeys diferenciados por tipología. Resume en paso 3 (Partes)
  // para validar el gate del vendedor sin teclear los 5 pasos.
  function tramitePaso3(opts: { tipologia: string }) {
    return {
      id: 78,
      vin: VIN,
      placa: 'ABC123',
      estado: 'borrador',
      paso: 3,
      tipologiaCodigo: opts.tipologia,
      vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123' },
      comprador: { nombre: 'Ana Pérez', tipoDoc: 'CC', documento: '1020304050', email: 'ana@x.co', telefono: '', direccion: '', ciudad: '' },
    };
  }

  test('tipología traspaso_standard: exige vendedor para avanzar del paso de partes', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso3({ tipologia: 'traspaso_standard' })], total: [tramitePaso3({ tipologia: 'traspaso_standard' })].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/tramites/78/documentos', (route) => jsonRoute(200, [])(route));
    let patched = false;
    await page.route('**/api/tramites/78', (route) => {
      if (route.request().method() === 'PATCH') { patched = true; return jsonRoute(200, { id: 78, paso: 4 })(route); }
      return jsonRoute(200, tramitePaso3({ tipologia: 'traspaso_standard' }))(route);
    });

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click();

    // La sección del vendedor (titular saliente) es visible para traspaso.
    await expect(page.getByText(/titular saliente/i)).toBeVisible();

    // Sin vendedor → bloqueado con aviso, no avanza a Identidad.
    await page.getByRole('button', { name: /guardar y continuar/i }).click();
    await expect(page.locator('[role="status"]', { hasText: /vendedor/i })).toBeVisible();
    await expect(page.getByText('Validación de identidad')).toHaveCount(0);
    expect(patched).toBe(false);

    // Con vendedor → avanza al paso 4.
    await page.getByPlaceholder('Número de documento del vendedor...').fill('9001234567');
    await page.getByPlaceholder('Nombre completo').fill('Carlos Vendedor');
    await page.getByRole('button', { name: /guardar y continuar/i }).click();
    await expect(page.getByText('Validación de identidad')).toBeVisible();
    expect(patched).toBe(true);
  });

  test('tipología sucesion: no pide vendedor y avanza directo', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso3({ tipologia: 'sucesion' })], total: [tramitePaso3({ tipologia: 'sucesion' })].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/tramites/78/documentos', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/tramites/78', (route) => {
      if (route.request().method() === 'PATCH') return jsonRoute(200, { id: 78, paso: 4 })(route);
      return jsonRoute(200, tramitePaso3({ tipologia: 'sucesion' }))(route);
    });

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click();

    // Adquirente relabelado y SIN sección de vendedor.
    await expect(page.getByText('Datos · Heredero / adjudicatario')).toBeVisible();
    await expect(page.getByText(/titular saliente/i)).toHaveCount(0);

    // Avanza directo a Identidad sin exigir vendedor.
    await page.getByRole('button', { name: /guardar y continuar/i }).click();
    await expect(page.getByText('Validación de identidad')).toBeVisible();
  });

  // TRAM-INNOV-TIPO-02 §6: remate → banner contextual + sin vendedor (paso 3).
  test('tipología remate: banner contextual de compliance + sin vendedor', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso3({ tipologia: 'remate' })], total: [tramitePaso3({ tipologia: 'remate' })].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/tramites/78/documentos', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/tramites/78', (route) => jsonRoute(200, tramitePaso3({ tipologia: 'remate' }))(route));

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click();

    await expect(page.getByText('Datos · Adjudicatario')).toBeVisible();
    await expect(page.getByText(/titular saliente/i)).toHaveCount(0);
    // Banner contextual server/shared-driven (matriz compliance).
    await expect(page.getByText(/no valida la legalidad del remate/i)).toBeVisible();
  });

  // TRAM-INNOV-TIPO-02 §6: importación → banner contextual + sin vendedor (paso 3).
  test('tipología importación: banner contextual de compliance + sin vendedor', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso3({ tipologia: 'importacion' })], total: [tramitePaso3({ tipologia: 'importacion' })].length, limit: 50, offset: 0 })(route));
    await page.route('**/api/tramites/78/documentos', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/tramites/78', (route) => jsonRoute(200, tramitePaso3({ tipologia: 'importacion' }))(route));

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click();

    await expect(page.getByText('Datos · Importador')).toBeVisible();
    await expect(page.getByText(/titular saliente/i)).toHaveCount(0);
    await expect(page.getByText(/documentos aduaneros son responsabilidad/i)).toBeVisible();
  });

  // TRAM-TIPO-02: smoke de la tipología importación (selector + checklist aduanero).
  test('tipología importación: selector + checklist aduanero visible', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') return jsonRoute(201, { id: 1 })(route);
      return jsonRoute(200, [])(route);
    });
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123' } } })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    // Selecciona la tipología Importación → el checklist muestra los anexos aduaneros.
    await page.getByRole('radio', { name: /importación/i }).click();
    await expect(page.getByText('Declaración de importación (DIAN)', { exact: true })).toBeVisible();
    await expect(page.getByText('Factura de importación / venta internacional', { exact: true })).toBeVisible();
  });

  // PR #120 — unicidad VIN matrícula inicial: modal de conflicto + recuperación.
  const DUP_VIN = 'LRWYGCEK8TC541064';

  function conflict409(existing: { id: number; estado: string; paso: number; placa: string }) {
    const code = existing.estado === 'completado' ? 'TRAMITE_MATRICULA_COMPLETADA' : 'TRAMITE_DUPLICADO';
    const msg = code === 'TRAMITE_MATRICULA_COMPLETADA'
      ? 'Este vehículo ya tiene una matrícula inicial completada. Un VIN solo puede matricularse una vez.'
      : `Ya existe un trámite de matrícula inicial para este VIN (placa ${existing.placa}). Continúe el trámite existente en lugar de crear uno nuevo.`;
    return {
      error: msg,
      code,
      existingTramite: { ...existing, vin: DUP_VIN },
    };
  }

  test('negativo: VIN duplicado → modal y no avanza a Documentos', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') {
        return jsonRoute(409, conflict409({ id: 18, estado: 'borrador', paso: 4, placa: 'QTP710' }))(route);
      }
      return jsonRoute(200, [])(route);
    });
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: { marca: 'TESLA', linea: 'MODELO Y', modelo: '2024', placa: 'QTP710' } } })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(DUP_VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    await page.getByRole('button', { name: /guardar y continuar/i }).click();

    const dlg = page.getByRole('dialog', { name: /trámite ya existe/i });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(/matrícula inicial/i)).toBeVisible();
    await expect(dlg.locator('dd', { hasText: 'QTP710' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: /abrir trámite existente/i })).toBeVisible();
    await expect(page.getByText(/Carga de documentos/i)).toHaveCount(0);
  });

  test('duplicado: Abrir trámite existente resume el wizard en el paso guardado', async ({ page }) => {
    const existing = {
      id: 18,
      vin: DUP_VIN,
      placa: 'QTP710',
      estado: 'borrador',
      paso: 4,
      vehiculo: { marca: 'TESLA', linea: 'MODELO Y', modelo: '2024', placa: 'QTP710' },
      comprador: { nombre: 'Ana Pérez', tipoDoc: 'CC', documento: '1020304050', email: 'ana@x.co', telefono: '', direccion: '', ciudad: '' },
    };
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') {
        return jsonRoute(409, conflict409({ id: 18, estado: 'borrador', paso: 4, placa: 'QTP710' }))(route);
      }
      return jsonRoute(200, [])(route);
    });
    await page.route('**/api/tramites/18/preflight', (route) => jsonRoute(200, { preflight: null })(route));
    await page.route('**/api/tramites/18/documentos', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/validacion-identidad/estado/18', (route) =>
      jsonRoute(200, { ok: true, validaciones: [] })(route));
    await page.route('**/api/tramites/18', (route) => jsonRoute(200, existing)(route));
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: existing.vehiculo } })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(DUP_VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    await page.getByRole('button', { name: /guardar y continuar/i }).click();
    await page.getByRole('button', { name: /abrir trámite existente/i }).click();

    await expect(page.getByText('Validación de identidad')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('negativo: matrícula completada → modal sin CTA de apertura', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites', (route) => {
      if (route.request().method() === 'POST') {
        return jsonRoute(409, conflict409({ id: 9, estado: 'completado', paso: 5, placa: 'ABC123' }))(route);
      }
      return jsonRoute(200, [])(route);
    });
    await page.route('**/api/runt/consulta-vehiculo', (route) =>
      jsonRoute(200, { ok: true, data: { vehiculo: { marca: 'Mazda', linea: 'CX-5', placa: 'ABC123' } } })(route));

    await page.goto('/tramite');
    await page.getByRole('button', { name: /nuevo trámite/i }).click();
    await page.getByPlaceholder('Numero VIN...').fill(DUP_VIN);
    await page.getByRole('button', { name: /consultar runt/i }).click();
    await page.getByRole('button', { name: /guardar y continuar/i }).click();

    const dlg = page.getByRole('dialog', { name: /matrícula ya registrada/i });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(/matricularse una vez/i)).toBeVisible();
    await expect(dlg.getByRole('button', { name: /abrir trámite existente/i })).toHaveCount(0);
    await expect(dlg.locator('button', { hasText: /^Cerrar$/ })).toBeVisible();
  });

  test('negativo: sin secretaría/documentos → Enviar a tránsito deshabilitado + aviso', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [tramitePaso5({ withOrg: false })], total: [tramitePaso5({ withOrg: false })].length, limit: 50, offset: 0 })(route));
    // continuarTramite hidrata con GET /tramites/:id; sin este mock devolvería el
    // shape de lista ({items}) y el wizard abriría en paso 1 (no en el 5).
    await page.route('**/api/tramites/77', (route) => jsonRoute(200, tramitePaso5({ withOrg: false }))(route));
    await page.route('**/api/validacion-identidad/estado/77', (route) => jsonRoute(200, { ok: true, validaciones: [] })(route));
    await page.route('**/api/tramites/77/documentos', (route) => jsonRoute(200, [])(route)); // sin docs

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click(); // TRAM-OPS-01: resume desde la pestaña Lista
    await page.getByText(VIN).click();
    await expect(page.getByText(/Selecciona la secretaría de tránsito/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /enviar a tránsito/i })).toBeDisabled();
  });

  // TRAM-INNOV-B3: panel «Firma electrónica» en paso 5 de traspaso_standard.
  test('B3: panel Firma electrónica + solicitar firma (traspaso_standard)', async ({ page }) => {
    const t88 = {
      id: 88, vin: VIN, placa: 'ABC123', estado: 'borrador', paso: 5, tipologiaCodigo: 'traspaso_standard',
      vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123', _orgTransito: { nombre: 'STT Medellín', ciudad: 'Medellín', codigo: '05001' } },
      comprador: { nombre: 'Ana Pérez', tipoDoc: 'CC', documento: '1020304050' },
    };
    await setupBase(page);
    await page.route('**/api/tramites**', (route) => jsonRoute(200, { items: [t88], total: 1, limit: 50, offset: 0 })(route));
    await page.route('**/api/validacion-identidad/estado/88', (route) => jsonRoute(200, { ok: true, validaciones: [{ estado: 'aprobado', score: 95 }] })(route));
    await page.route('**/api/tramites/88/documentos', (route) => jsonRoute(200, REQUIRED_DOCS)(route));
    let solicitado = false;
    await page.route('**/api/tramites/88/firma/solicitar', (route) => { solicitado = true; return jsonRoute(201, { firma: { id: 1, rol: 'comprador', estado: 'enviada' }, signUrl: 'https://x' })(route); });
    await page.route('**/api/tramites/88/firma', (route) => jsonRoute(200, { firmas: solicitado ? [{ id: 1, rol: 'comprador', estado: 'enviada', proveedor: 'mock' }] : [] })(route));
    await page.route('**/api/tramites/88', (route) => jsonRoute(200, t88)(route));

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^lista$/i }).click();
    await page.getByText(VIN).click();

    const panel = page.getByRole('region', { name: 'Firma electrónica' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Solicitar firma/i }).first().click();
    await expect(page.locator('[role="status"]', { hasText: /Firma solicitada/i })).toBeVisible();
  });
});
