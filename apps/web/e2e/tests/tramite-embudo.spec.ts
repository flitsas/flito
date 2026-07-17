// SPRINT-CONSOLIDACION-JUN-2026 #3 — Embudo (comprador en tarjeta) + resume wizard.
//
// Cubre: (1) la tarjeta del embudo muestra `comprador.nombre`; (2) click en una
// tarjeta de la Lista resume el wizard (continuarTramite → GET /tramites/:id).
// Patrón de mocks idéntico a tramite-wizard.spec (catch-all + rutas específicas).

import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { jsonRoute } from '../helpers/pesv-fixtures';

const VIN = 'MAZ123TEST456789';
const COMPRADOR = { nombre: 'Ana Pérez Comprador', tipoDoc: 'CC', documento: '1020304050' };

function cardData() {
  return {
    id: 77,
    vin: VIN,
    placa: 'ABC123',
    estado: 'borrador',
    paso: 5,
    tipologiaCodigo: 'matricula_inicial',
    vehiculo: { marca: 'Mazda', linea: 'CX-30' },
    comprador: { nombre: COMPRADOR.nombre, documento: COMPRADOR.documento },
  };
}

function tramitePaso5() {
  return {
    id: 77,
    vin: VIN,
    placa: 'ABC123',
    estado: 'borrador',
    paso: 5,
    vehiculo: {
      marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123',
      _orgTransito: { nombre: 'STT Medellín', ciudad: 'Medellín', codigo: '05001' },
    },
    comprador: { ...COMPRADOR, email: 'ana@x.co', telefono: '', direccion: '', ciudad: '' },
  };
}

const REQUIRED_DOCS = [
  { id: 1, tipo: 'factura', originalName: 'factura.pdf' },
  { id: 2, tipo: 'aduana', originalName: 'aduana.pdf' },
  { id: 3, tipo: 'impronta', originalName: 'impronta.pdf' },
];

const EMBUDO_RESPONSE = {
  columnas: [
    { id: 'borrador', label: 'Borrador', count: 1, tramites: [cardData()] },
    { id: 'en_transito', label: 'En Tránsito', count: 0, tramites: [] },
  ],
};

async function setupBase(page: import('@playwright/test').Page) {
  // Catch-all primero (menor prioridad): absorbe fetches incidentales.
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/api/auth/')) return route.continue();
    return jsonRoute(200, {})(route);
  });
  await loginAs(page, ADMIN_USER);
}

test.describe('Trámite · Embudo + resume wizard', () => {
  test('la tarjeta del embudo muestra el comprador', async ({ page }) => {
    await setupBase(page);
    await page.route('**/api/tramites/embudo**', (route) => jsonRoute(200, EMBUDO_RESPONSE)(route));

    await page.goto('/tramite');
    await page.getByRole('tab', { name: /^embudo$/i }).click();

    await expect(page.getByText(COMPRADOR.nombre)).toBeVisible();
    await expect(page.getByText(VIN).first()).toBeVisible();
  });

  test('resume desde Lista: click tarjeta → wizard abre en paso 5', async ({ page }) => {
    await setupBase(page);
    // Lista (vista por defecto) — GET /tramites?... devuelve {items,...}.
    await page.route('**/api/tramites**', (route) =>
      jsonRoute(200, { items: [cardData()], total: 1, limit: 50, offset: 0 })(route));
    await page.route('**/api/validacion-identidad/estado/77', (route) =>
      jsonRoute(200, { ok: true, validaciones: [{ estado: 'aprobado', score: 95 }] })(route));
    await page.route('**/api/tramites/77/documentos', (route) => jsonRoute(200, REQUIRED_DOCS)(route));
    await page.route('**/api/tramites/77', (route) => jsonRoute(200, tramitePaso5())(route));

    await page.goto('/tramite');
    // La Lista muestra el comprador en la tarjeta.
    await expect(page.getByText(COMPRADOR.nombre)).toBeVisible();
    // Click en el trámite → resume del wizard.
    await page.getByText(VIN).first().click();

    const enviarBtn = page.getByRole('button', { name: /enviar a tránsito/i });
    await expect(enviarBtn).toBeVisible();
    await expect(enviarBtn).toBeEnabled();
  });
});
