import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Trámites unificado (Fase 6). Vista de despacho: una fila por trámite,
// solicitud de SOAT/impuestos/ambos y entrega en lote. Operaciones muta; Auditoría
// observa. El backend está mockeado: aquí verificamos el cableado de la UI.

const PROVEEDORES = [
  { id: '11111111-1111-1111-1111-111111111111', nombre: 'Seguros Alfa', activo: true },
  { id: '22222222-2222-2222-2222-222222222222', nombre: 'Aseguradora Beta', activo: true },
];

const TRAMITES = [
  {
    tramiteId: 'aaaaaaaa-0000-0000-0000-000000000001', idFlit: 'FLIT-1001', estado: 'Asignado', asignado: true,
    tipoTramite: 'Matricula', ciudad: 'Manizales', empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
    transitoNombre: 'STT Manizales', facturaVentaFlitId: null,
    companiaNombre: 'Concesionario Norte', organismoNombre: 'STT Manizales',
    vehiculo: { vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix' },
    compradorPrincipal: { nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010' },
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010' }],
    soat: { id: 's1', estado: 'pendiente', proveedorSoatNombre: null, valorPagado: null },
    soatAutogestionado: false,
    impuesto: { id: 'i1', estado: 'pendiente', tieneFacturaVenta: false, valorPagado: null },
    listoParaEntregar: false,
  },
  {
    tramiteId: 'aaaaaaaa-0000-0000-0000-000000000002', idFlit: 'FLIT-1002', estado: 'Asignado', asignado: true,
    tipoTramite: 'Traspaso', ciudad: 'Pereira', empresaExiste: true, empresaNit: '900222', secretariaEmparejada: true,
    transitoNombre: 'STT Pereira', facturaVentaFlitId: 'fac-xyz',
    companiaNombre: 'Concesionario Sur', organismoNombre: 'STT Pereira',
    vehiculo: { vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid' },
    compradorPrincipal: { nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020' },
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020' }],
    soat: { id: 's2', estado: 'pagado', proveedorSoatNombre: 'Seguros Alfa', valorPagado: 450000 },
    soatAutogestionado: false,
    impuesto: { id: 'i2', estado: 'pagado', tieneFacturaVenta: true, valorPagado: 120000 },
    listoParaEntregar: true,
  },
  {
    tramiteId: 'aaaaaaaa-0000-0000-0000-000000000003', idFlit: 'FLIT-1003', estado: 'Asignado', asignado: true,
    tipoTramite: 'Matricula', ciudad: 'Armenia', empresaExiste: false, empresaNit: '900333', secretariaEmparejada: true,
    transitoNombre: 'STT Armenia', facturaVentaFlitId: null,
    companiaNombre: null, organismoNombre: 'STT Armenia',
    vehiculo: { vin: 'VIN0000000000003', placa: 'DEF456', marca: 'Mazda', linea: '2' },
    compradorPrincipal: { nombreCompleto: 'María Ruiz', numeroDocumento: '30303030' },
    compradores: [{ nombreCompleto: 'María Ruiz', numeroDocumento: '30303030' }],
    soat: { id: 's3', estado: 'pendiente', proveedorSoatNombre: null, valorPagado: null },
    soatAutogestionado: false,
    impuesto: { id: 'i3', estado: 'pendiente', tieneFacturaVenta: false, valorPagado: null },
    listoParaEntregar: false,
  },
];

async function mockLista(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  // Facetas para los dropdowns (endpoint sin query).
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados: ['Asignado'], tramites: ['Matricula', 'Traspaso'], ciudades: ['Manizales', 'Pereira', 'Armenia'],
      transitos: ['STT Manizales', 'STT Pereira', 'STT Armenia'],
    }) }));
  // Listado paginado: { items, total, page, pageSize }.
  await page.route(/\/api\/flito\/tramites\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      items: TRAMITES, total: TRAMITES.length, page: 1, pageSize: 50,
    }) }));
}

test.describe('FLITO — Trámites unificado', () => {
  test('operaciones ve la tabla, estados y filtros', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page);

    await page.goto('/flito/tramites');
    await expect(page.getByRole('heading', { name: 'Trámites', exact: true })).toBeVisible();
    await expect(page.getByText('FLIT-1001')).toBeVisible();
    await expect(page.getByText('FLIT-1002')).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    // Un trámite listo para entregar muestra su chip.
    await expect(page.getByText('Listo para entregar')).toBeVisible();
    // Filtros multiselect embebidos en el encabezado de columna (SOAT/Impuestos por estado).
    await expect(page.getByRole('columnheader', { name: /SOAT/ }).getByText('Todos')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Impuestos/ }).getByText('Todos')).toBeVisible();
  });

  test('seleccionar filas abre la barra de acciones y el diálogo de proveedor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page);
    let solicitudSoat: unknown = null;
    await page.route(/\/api\/flito\/tramites\/solicitar-soat$/, async (route) => {
      solicitudSoat = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: 1, yaEnviados: 0, autogestionados: 0, sinRegistro: 0 }) });
    });

    await page.goto('/flito/tramites');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();

    await page.getByRole('button', { name: 'Solicitar SOAT', exact: true }).click();
    // Diálogo de aseguradora.
    await expect(page.getByRole('heading', { name: /Solicitar SOAT/i })).toBeVisible();
    // El botón queda deshabilitado hasta elegir aseguradora.
    const confirmar = page.getByRole('button', { name: 'Solicitar SOAT', exact: true }).last();
    await expect(confirmar).toBeDisabled();
    await page.getByRole('combobox').last().selectOption(PROVEEDORES[0].id);
    await confirmar.click();

    await expect.poll(() => solicitudSoat).not.toBeNull();
    await expect(page.getByRole('heading', { name: /Resultado de solicitar SOAT/i })).toBeVisible();
    await expect(page.getByText(/1 SOAT enviado/i)).toBeVisible();
  });

  test('entregar en lote reporta habilitados y no habilitados', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page);
    await page.route(/\/api\/flito\/tramites\/entregar$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        entregados: 1,
        noHabilitados: [{ tramiteId: 'x', idFlit: 'FLIT-1001', placa: 'ABC123', motivo: 'SOAT sin resolver' }],
      }) }));

    await page.goto('/flito/tramites');
    await page.getByLabel('Seleccionar accionables').check();
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Resultado de la entrega/i })).toBeVisible();
    await expect(page.getByText(/1 trámite\(s\) entregado/i)).toBeVisible();
    await expect(page.getByText('SOAT sin resolver')).toBeVisible();
  });

  test('operaciones crea la empresa de un trámite con empresa inexistente (NIT precargado)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page);
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/tramites\/crear-empresa$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companiaId: 99, yaExistia: false, revinculados: 1 }) });
    });

    await page.goto('/flito/tramites');
    await expect(page.getByText('FLIT-1003')).toBeVisible();
    await expect(page.getByText('Empresa no existe')).toBeVisible();

    await page.getByRole('button', { name: 'Crear empresa' }).first().click();
    await expect(page.getByRole('heading', { name: 'Crear empresa' })).toBeVisible();
    await expect(page.getByLabel('NIT', { exact: true })).toHaveValue('900333');
    await page.getByLabel(/Nombre o razón social/).fill('ACME SAS');
    await page.getByRole('button', { name: 'Crear empresa', exact: true }).last().click();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ nombre: 'ACME SAS', nit: '900333' });
  });

  test('auditor entra en solo lectura: sin checkboxes ni barra de acciones', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockLista(page);

    await page.goto('/flito/tramites');
    await expect(page.getByText('FLIT-1001')).toBeVisible();
    await expect(page.getByLabel('Seleccionar accionables')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Solicitar SOAT', exact: true })).toHaveCount(0);
  });
});
