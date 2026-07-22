import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Portal SOAT (Fase 6). Cola de adquisición: envío atómico al gestor,
// detalle por VIN y solo-lectura para Auditoría. Backend mockeado.

const PROVEEDORES = [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }];

const SOAT = [
  {
    id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
    estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
    organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1001'], enviadoPorNombre: null, enviadoEn: null,
    valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  },
  {
    id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
    estado: 'en_adquisicion', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1002'], enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
  },
];

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    const estado = url.searchParams.get('estado');
    const data = estado ? SOAT.filter((s) => s.estado === estado) : SOAT;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
}

test.describe('FLITO — Portal SOAT', () => {
  test('operaciones lista, filtra y abre detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('XYZ789')).toBeVisible();

    await page.getByRole('button', { name: 'En adquisición', exact: true }).click();
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Seguros Alfa')).toBeVisible();
  });

  test('seleccionar pendientes envía al gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/soat\/enviar$/, (route) => {
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['s1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/soat');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
    await page.getByRole('button', { name: /Enviar al gestor/i }).click();
    await expect.poll(() => enviado).not.toBeNull();
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
});
