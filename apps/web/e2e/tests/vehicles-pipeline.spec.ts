import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// SPRINT-CONSOLIDACION-JUN-2026 #2 — Pipeline «Progreso global» (#140).
// Cubre: tab Pipeline visible, resumen «Progreso global», y click en el
// propietario → modal con la etapa («SOAT pendiente»).

const VEHICLE_SOAT_PENDIENTE = {
  id: 501,
  vin: 'VIN00PIPELINE0001',
  plate: 'PIP001',
  ownerName: 'Propietario Pipeline E2E',
  ownerDocument: '80012345',
  brand: 'Renault',
  model: 'Kangoo',
  year: 2022,
  vehicleClass: 'AUTOMOVIL',
  stage: 'soat_pendiente',
  clientId: null,
  taxPaid: true,
  soatStatus: 'pendiente',
  policyNumber: null,
  insurer: null,
  expiryDate: null,
  multasEstado: 'no_consultado' as const,
  multasTotal: null,
  multasCount: null,
  multasConsultadoAt: null,
  createdAt: '2026-06-01T12:00:00Z',
};

test.describe('Vehicles · Pipeline progreso global', () => {
  test('muestra «Progreso global» y abre modal de etapa al click en propietario', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/vehicles**', (route) => {
      // Excluir sub-rutas (upload/export/:id) — solo el listado base.
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/api/vehicles')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([VEHICLE_SOAT_PENDIENTE]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/vehicles');
    // Pipeline es el tab por defecto; lo seleccionamos explícitamente por robustez.
    await page.getByRole('button', { name: 'Pipeline', exact: true }).click();

    // Resumen «Progreso global».
    await expect(page.getByText('Progreso global')).toBeVisible();
    await expect(page.getByText(/1 veh[íi]culo/)).toBeVisible();

    // Click en el propietario → modal de etapa.
    await page.getByRole('button', { name: /Propietario Pipeline E2E/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Etapa actual')).toBeVisible();
    await expect(dialog.getByText('SOAT pendiente')).toBeVisible();

    // Cerrar modal (Esc).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  // #142 — abrir pasaporte vehicular desde el modal de etapa.
  test('abre pasaporte vehicular desde modal de etapa', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/vehicles**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/historial')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            vin: VEHICLE_SOAT_PENDIENTE.vin,
            eventos: [{ id: 1, eventoTipo: 'vehiculo_registrado', payload: {}, hashSelf: 'a'.repeat(64), createdAt: '2026-06-01T12:00:00Z' }],
            integridad: { valido: true, rotoEnId: null },
            ultimoHash: 'a'.repeat(64),
            desde: '2026-06-01T12:00:00Z',
            hasta: '2026-06-01T12:00:00Z',
          }),
        });
      }
      if (path.endsWith('/api/vehicles')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([VEHICLE_SOAT_PENDIENTE]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/vehicles');
    await page.getByRole('button', { name: 'Pipeline', exact: true }).click();
    await page.getByRole('button', { name: /Propietario Pipeline E2E/ }).click();

    const stageDialog = page.getByRole('dialog');
    await expect(stageDialog).toBeVisible();
    await stageDialog.getByRole('button', { name: 'Pasaporte vehicular' }).click();

    // Modal de etapa cierra; abre pasaporte con el VIN del vehículo.
    await expect(page.getByText('Etapa actual')).toBeHidden();
    const pasaporteDialog = page.getByRole('dialog', { name: 'Pasaporte vehicular' });
    await expect(pasaporteDialog).toBeVisible();
    await expect(pasaporteDialog.getByText(VEHICLE_SOAT_PENDIENTE.vin)).toBeVisible();
    await expect(pasaporteDialog.getByText('Vehículo registrado en FLIT')).toBeVisible();
  });

  // MIMI F1 — el modal compartido (FlitModal) atrapa el foco y lo restaura al cerrar.
  test('modal de etapa: foco entra, se mantiene dentro y se restaura al cerrar (a11y)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/vehicles**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/api/vehicles')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([VEHICLE_SOAT_PENDIENTE]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/vehicles');
    const trigger = page.getByRole('button', { name: /Propietario Pipeline E2E/ });
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Foco inicial en el diálogo (anuncia su aria-label).
    await expect(dialog).toBeFocused();

    // Tab varias veces: el foco nunca sale del diálogo (trap).
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside).toBe(true);
    }

    // Esc cierra y restaura el foco al disparador.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  // MIMI F2 — mover-en-lote reporta los fallos con veracidad (antes: toast de éxito).
  test('mover en lote con un fallo → toast de error y el fallido queda seleccionado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const v2 = { ...VEHICLE_SOAT_PENDIENTE, id: 502, vin: 'VIN00PIPELINE0002', plate: 'PIP002', ownerName: 'Segundo Propietario E2E' };
    await page.route('**/api/vehicles**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/api/vehicles')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([VEHICLE_SOAT_PENDIENTE, v2]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    // El PATCH del 501 falla; el del 502 va OK.
    await page.route('**/api/vehicles/501/stage', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.route('**/api/vehicles/502/stage', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

    await page.goto('/vehicles');
    // Seleccionar todos → aparece la barra de lote.
    await page.getByRole('checkbox', { name: /Seleccionar todos/i }).check();
    await expect(page.getByText('2 seleccionados')).toBeVisible();

    // Botón de lote «Listo» (accessible name exacto, no choca con leyenda/CTA de fila).
    await page.getByRole('button', { name: 'Listo', exact: true }).click();

    // Toast veraz: 1 movido · 1 no se pudo mover.
    await expect(page.locator('[role="status"]', { hasText: /1 movido.*1 no se pudo mover/i })).toBeVisible();
    // El fallido (501) queda seleccionado para reintentar.
    await expect(page.getByText('1 seleccionados')).toBeVisible();
  });
});
