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
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  },
  {
    id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
    estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1002'], enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
  },
  {
    id: 's3', vin: 'VIN0000000000003', placa: 'PAG777', marca: 'Mazda', linea: 'CX-30',
    estado: 'pagado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Sara Ríos', numeroDocumento: '30303030', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1003'], enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: '2026-04-05T12:00:00Z', valorPagado: 740800, estancado: false, motivoRechazo: null,
    creadoEn: '2026-04-02T12:00:00Z',
  },
];

const FACETAS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }, { codigo: '66001', nombre: 'STT Pereira' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

/** Guarda las URLs que pidió la página, para poder comprobar QUÉ filtros viajaron. */
const urlsPedidas: string[] = [];

async function mock(page: import('@playwright/test').Page) {
  urlsPedidas.length = 0;
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    const estado = url.searchParams.get('estado');
    const items = estado ? SOAT.filter((s) => s.estado === estado) : SOAT;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
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

    await page.getByRole('button', { name: 'Solicitado', exact: true }).click();
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

    // El proveedor es obligatorio desde que se retiraron las reglas de enrutamiento (HU #10979):
    // sin él el SOAT nacería sin proveedor y quedaría en la cola de nadie.
    const enviar = page.getByRole('button', { name: /Enviar al gestor/i });
    await expect(enviar).toBeDisabled();
    await page.getByRole('combobox').selectOption('p1');

    await enviar.click();
    await expect.poll(() => enviado).not.toBeNull();
    expect(enviado).toMatchObject({ proveedorSoatId: 'p1' });
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
  test('los filtros de la cola viajan al servidor', async ({ page }) => {
    // Se comprueba sobre la petición, no sobre las filas: el filtrado ocurre en SQL, así que lo
    // que importa es que el parámetro llegue.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    await page.getByLabel('Solicitado desde').fill('2026-04-01');
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('solicitadoDesde=2026-04-01');

    await page.getByLabel('Pagado hasta').fill('2026-04-30');
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('pagadoHasta=2026-04-30');
  });

  test('la búsqueda consulta una vez tras la pausa, no en cada tecla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    const antes = urlsPedidas.length;
    await page.getByPlaceholder('Buscar placa, VIN, comprador…').fill('ABC123');
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('buscar=ABC123');
    // Seis pulsaciones, una sola consulta: sin el retardo serían seis.
    expect(urlsPedidas.length - antes).toBe(1);
  });

  test('limpiar filtros los quita todos de la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').not.toContain('estancado');
  });

  test('un SOAT pagado no muestra los días desde la solicitud', async ({ page }) => {
    // Ya pagado, la antigüedad deja de ser una señal de riesgo: el chip de sin gestión tampoco se
    // pinta, y dejar los días sueltos hacía parecer atrasado algo que ya está resuelto.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const pendienteDeGestion = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(pendienteDeGestion.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(1);

    const pagado = page.getByRole('row').filter({ hasText: 'PAG777' });
    await expect(pagado.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(0);
  });
});
