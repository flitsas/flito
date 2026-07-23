// HUM-05 / TRAM-MT-02 — E2E Organismos STT (admin).
// API mockeada; no requiere BD ni rol real en CI.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { jsonRoute } from '../helpers/pesv-fixtures';

const ORG_LIST = [
  {
    codigo: '05001',
    nombre: 'STRIA TTEyTTO MEDELLIN',
    ciudad: 'Medellín',
    alias: null,
    logoUrl: null,
    activo: true,
    userCount: 1,
    updatedAt: null,
  },
  {
    codigo: '05266',
    nombre: 'STRIA TTEyTTO ENVIGADO',
    ciudad: 'Envigado',
    alias: 'STT Envigado',
    logoUrl: 'https://example.com/envigado.png',
    activo: true,
    userCount: 0,
    updatedAt: '2026-06-07T12:00:00.000Z',
  },
];

const FLITO_ORG = [
  { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN', alias: null, activo: true,
    modalidadVigente: 'requiere_gestion', umbralOcr: 0.8, slaHoras: 48, diferenciaValorActiva: false, tramitesRetenidos: 2 },
];

test.describe('Tránsito · Organismos STT (admin)', () => {
  // El panel de autogestión FLITO consume /flito/parametrizacion/organismos; por defecto vacío
  // para que los tests de la tabla superior no golpeen la red (se sobrescribe donde importa).
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/flito\/parametrizacion\/organismos/, (route) => jsonRoute(200, [])(route));
  });

  test('lista organismos y abre modal editar', async ({ page }) => {
    await page.route('**/api/transito/organismos-config', (route) => jsonRoute(200, ORG_LIST)(route));

    await loginAs(page, ADMIN_USER);
    await page.goto('/transito/organismos');

    await expect(page.getByRole('heading', { name: /organismos de tránsito/i })).toBeVisible();
    await expect(page.getByText('STRIA TTEyTTO MEDELLIN')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'STT Envigado', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Editar' }).first().click();
    await expect(page.getByText(/editar —/i)).toBeVisible();
    await expect(page.getByPlaceholder('Medellín')).toBeVisible();
  });

  test('guardar alias dispara PUT y cierra modal', async ({ page }) => {
    let putBody: Record<string, unknown> | null = null;
    await page.route('**/api/transito/organismos-config', (route) => jsonRoute(200, ORG_LIST)(route));
    await page.route('**/api/transito/organismos-config/05001', async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON() as Record<string, unknown>;
        return jsonRoute(200, { ...ORG_LIST[0], alias: 'STT Medellín', updatedAt: '2026-06-07T13:00:00.000Z' })(route);
      }
      return route.continue();
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/transito/organismos');

    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByPlaceholder('Medellín').fill('STT Medellín');
    await page.getByRole('button', { name: /^guardar$/i }).click();

    await expect(page.locator('[role="status"]', { hasText: /actualizado/i })).toBeVisible();
    expect(putBody?.alias).toBe('STT Medellín');
  });

  test('pestaña Plantilla documentos guarda override hide', async ({ page }) => {
    let putChecklist: Record<string, unknown> | null = null;
    await page.route('**/api/transito/organismos-config', (route) => jsonRoute(200, ORG_LIST)(route));
    await page.route('**/api/transito/organismos-config/05001/checklist/traspaso_standard', async (route) => {
      if (route.request().method() === 'GET') {
        return jsonRoute(200, {
          organismoCodigo: '05001',
          tipologiaCodigo: 'traspaso_standard',
          override: { hide: [], require: [], add: [] },
          version: 0,
          updatedAt: null,
        })(route);
      }
      if (route.request().method() === 'PUT') {
        putChecklist = route.request().postDataJSON() as Record<string, unknown>;
        return jsonRoute(200, {
          organismoCodigo: '05001',
          tipologiaCodigo: 'traspaso_standard',
          override: putChecklist,
          version: 1,
          updatedAt: '2026-06-07T14:00:00.000Z',
        })(route);
      }
      return route.continue();
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/transito/organismos');

    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByRole('button', { name: 'Plantilla documentos' }).click();
    await expect(page.getByText('Contrato de compraventa autenticado')).toBeVisible();

    await page.getByLabel(/ocultar/i).first().click();
    await page.getByRole('button', { name: /guardar plantilla/i }).click();

    await expect(page.locator('[role="status"]', { hasText: /plantilla guardada/i })).toBeVisible();
    expect(putChecklist?.hide).toEqual(expect.arrayContaining(['contrato_compraventa']));
  });

  test('la tabla única muestra la modalidad FLITO por secretaría (columna + Editar › Autogestión)', async ({ page }) => {
    await page.route('**/api/transito/organismos-config', (route) => jsonRoute(200, ORG_LIST)(route));
    await page.route(/\/api\/flito\/parametrizacion\/organismos(\?|$)/, (route) => jsonRoute(200, FLITO_ORG)(route));

    await loginAs(page, ADMIN_USER);
    await page.goto('/transito/organismos');

    // Modalidad integrada como columna de la MISMA tabla (no una segunda tabla).
    await expect(page.getByRole('columnheader', { name: /Modalidad FLITO/i })).toBeVisible();
    await expect(page.getByText(/requiere gestión/i).first()).toBeVisible();
    // La autogestión vive dentro de la acción Editar → pestaña "Autogestión" (ya no hay botón "Gestionar").
    await page.getByRole('button', { name: 'Editar' }).first().click();
    await page.getByRole('button', { name: 'Autogestión' }).click();
    await expect(page.getByText(/Modalidad de gestión/i)).toBeVisible();
  });
});
