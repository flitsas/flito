// HU #14342 — cada selector de asignación ofrece solo los proveedores activos con ese servicio. Backend mockeado: el filtro
// lo hace el API (HU #14339); aquí se mide que cada pantalla pida su servicio y pinte sus cuatro estados.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const AMBOS = 'aaaaaaaa-1111-4111-8111-111111111111';
const SOLO_SOAT = 'bbbbbbbb-2222-4222-8222-222222222222';
const SOLO_LOG = 'cccccccc-3333-4333-8333-333333333333';
const APAGADO = 'dddddddd-4444-4444-8444-444444444444';
const POR_SERVICIO: Record<string, { id: string; nombre: string }[]> = {
  soat: [{ id: AMBOS, nombre: 'Doble Servicio' }, { id: SOLO_SOAT, nombre: 'Seguros Alfa' }],
  logistica: [{ id: AMBOS, nombre: 'Doble Servicio' }, { id: SOLO_LOG, nombre: 'Rutas del Norte' }],
};

const compania = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, document: `9001${id}`, documentType: 'NIT', phone: null, email: null, address: null, city: 'Medellín',
  active: true, soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
  gestorSoatSinTramite: null, proveedorLogisticaId: null, proveedorLogisticaNombre: null, ...extra,
});

async function montarClientes(page: Page, filas: unknown[], patch?: { status: number; body: unknown }) {
  const pedidos: string[] = [];
  const patches: unknown[] = [];
  await page.route(/\/api\/clients(\?|$)/, (r) => json(r, 200, filas));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (r) => json(r, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=\w+$/, (r) => {
    const servicio = new URL(r.request().url()).searchParams.get('servicio') ?? '';
    pedidos.push(servicio);
    return json(r, 200, POR_SERVICIO[servicio]);
  });
  await page.route(/\/api\/flito\/parametrizacion\/companias\/\d+$/, (r) => {
    patches.push(r.request().postDataJSON());
    return patch ? json(r, patch.status, patch.body) : json(r, 200, { id: 1 });
  });
  await page.goto('/clients');
  return { pedidos, patches };
}
const abrir = async (page: Page, nombre: string) => {
  await page.getByRole('button', { name: `Editar ${nombre}`, exact: true }).click();
  return page.getByRole('dialog', { name: `Editar · ${nombre}` });
};

test.describe('HU #14342 · Compañías', () => {
  test('AC1 y AC2 · cada selector pide y ofrece su propio servicio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { pedidos } = await montarClientes(page, [compania(1, 'Compañía Uno')]);
    const modal = await abrir(page, 'Compañía Uno');
    await expect(modal.getByLabel(/Proveedor de logística/).locator('option')).toHaveText(['Elija un proveedor', 'Doble Servicio', 'Rutas del Norte']);
    await expect(modal.getByLabel('Proveedor de SOAT sin trámite').locator('option')).toHaveText(['Sin proveedor', 'Doble Servicio', 'Seguros Alfa']);
    expect(new Set(pedidos)).toEqual(new Set(['soat', 'logistica']));
  });

  test('AC4 · asignado solo en Logística: SOAT sigue sin proveedor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarClientes(page, [compania(1, 'Compañía Uno', { proveedorLogisticaId: AMBOS, proveedorLogisticaNombre: 'Doble Servicio' })]);
    const modal = await abrir(page, 'Compañía Uno');
    await expect(modal.getByLabel(/Proveedor de logística/)).toHaveValue(AMBOS);
    await expect(modal.getByLabel('Proveedor de SOAT sin trámite')).toHaveValue('');
  });

  test('el asignado de Logística que ya no se ofrece se conserva con su nombre', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { patches } = await montarClientes(page, [compania(1, 'Compañía Uno', { proveedorLogisticaId: APAGADO, proveedorLogisticaNombre: 'Antigua Logística' })]);
    const modal = await abrir(page, 'Compañía Uno');
    const selector = modal.getByLabel(/Proveedor de logística/);
    await expect(selector).toHaveValue(APAGADO);
    await expect(selector.getByRole('option', { name: 'Antigua Logística (Inactivo)' })).toHaveJSProperty('disabled', false);
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(modal).toHaveCount(0);
    expect(patches).toEqual([]);
  });

  test('AC5 · rechazo de Logística: copy pulido, vuelve el asignado y se pide la lista de nuevo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { pedidos } = await montarClientes(page,
      [compania(1, 'Compañía Uno', { proveedorLogisticaId: AMBOS, proveedorLogisticaNombre: 'Doble Servicio' })],
      { status: 422, body: { error: 'ProveedorLogisticaNoUsableError crudo', campo: 'proveedorLogisticaId' } });
    const modal = await abrir(page, 'Compañía Uno');
    const selector = modal.getByLabel(/Proveedor de logística/);
    await selector.selectOption(SOLO_LOG);
    const antes = pedidos.filter((s) => s === 'logistica').length;
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(modal.getByRole('alert')).toHaveText('Ese proveedor de logística ya no está activo. Elija otro.');
    await expect(page.getByText(/crudo/)).toHaveCount(0);
    await expect(selector).toHaveValue(AMBOS);
    await expect.poll(() => pedidos.filter((s) => s === 'logistica').length).toBeGreaterThan(antes);
  });
});

test.describe('HU #14342 · Enviar SOAT', () => {
  const SOAT = {
    id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix', cilindraje: '1598', carroceria: 'SEDAN',
    tipoServicio: 'Particular', estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
    organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', tipoDocumento: 'CC', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1001'], tipoTramite: 'Matricula', fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-04-01T12:00:00Z', gestionOperaciones: false,
  };

  async function montarCola(page: Page, responder: (r: Route) => unknown) {
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, responder as (r: Route) => void);
    await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [SOAT], total: 1, page: 1, pageSize: 50 }));
    await page.goto('/flito/soat');
    await page.getByLabel('Seleccionar ABC123').check();
  }

  test('AC3 · FlitoSoat ofrece lo del selector de SOAT', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page, (r) => json(r, 200, POR_SERVICIO.soat));
    await expect(page.getByLabel('Enviar a').getByRole('option', { name: 'Seguros Alfa' })).toHaveCount(1);
    await expect(page.getByLabel('Enviar a').getByRole('option', { name: 'Rutas del Norte' })).toHaveCount(0);
  });

  test('AC6 · FlitoSoat: cargando, error con reintento y vacío; Operaciones sigue disponible', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let modo: 'colgado' | 'error' | 'vacio' = 'colgado';
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    await montarCola(page, async (r) => {
      if (modo === 'colgado') { await colgada; return json(r, 200, []); }
      return modo === 'error' ? json(r, 500, { error: 'Catálogo caído' }) : json(r, 200, []);
    });
    await expect(page.getByText('Cargando proveedores…')).toBeVisible();
    await expect(page.getByLabel('Enviar a').getByRole('option', { name: 'Gestionado por Operaciones' })).toHaveCount(1);

    modo = 'error';
    soltar();
    await page.reload();
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('No se pudieron cargar los proveedores.')).toBeVisible();
    await expect(page.getByText(/Catálogo caído/)).toHaveCount(0);

    modo = 'vacio';
    await page.getByRole('button', { name: 'Volver a cargar proveedores' }).click();
    await expect(page.getByText('No hay proveedores de SOAT activos.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a cargar proveedores' })).toHaveCount(0);
    await expect(page.getByLabel('Enviar a').getByRole('option', { name: 'Gestionado por Operaciones' })).toHaveCount(1);
  });

  test('AC6 · selector del detalle: cargando, error con reintento, vacío y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let modo: 'colgado' | 'error' | 'vacio' | 'lleno' = 'colgado';
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, async (r) => {
      if (modo === 'colgado') { await colgada; return json(r, 200, []); }
      if (modo === 'error') return json(r, 500, { error: 'Catálogo caído' });
      return json(r, 200, modo === 'lleno' ? POR_SERVICIO.soat : []);
    });
    await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [{ ...SOAT, estado: 'solicitado', gestionOperaciones: true, proveedorSoatNombre: 'Seguros Alfa' }], total: 1, page: 1, pageSize: 50 }));
    const abrirSelector = async () => {
      await page.goto('/flito/soat');
      await page.getByRole('button', { name: 'Ver' }).first().click();
      const dialogo = page.getByRole('dialog');
      await dialogo.getByRole('button', { name: 'Devolver al proveedor' }).click();
      return dialogo;
    };

    let dialogo = await abrirSelector();
    const select = () => dialogo.getByLabel('Proveedor que lo retoma');
    await expect(dialogo.getByText('Cargando proveedores…')).toBeVisible();
    await expect(select()).toBeDisabled();

    modo = 'error';
    soltar();
    dialogo = await abrirSelector();
    await expect(dialogo.getByText('No se pudieron cargar los proveedores.')).toBeVisible();
    await expect(dialogo.getByText(/Catálogo caído/)).toHaveCount(0);
    await expect(select()).toBeDisabled();

    modo = 'vacio';
    await dialogo.getByRole('button', { name: 'Volver a cargar proveedores' }).click();
    await expect(dialogo.getByText('No hay proveedores de SOAT activos.')).toBeVisible();
    await expect(dialogo.getByRole('button', { name: 'Volver a cargar proveedores' })).toHaveCount(0);
    await expect(select()).toBeDisabled();

    modo = 'lleno';
    dialogo = await abrirSelector();
    await expect(select()).toBeEnabled();
    await expect(select().locator('option')).toHaveText(['Selecciona…', 'Doble Servicio', 'Seguros Alfa']);
  });

  const TRAMITE = {
    fechaCreacion: '2026-03-01T10:00:00Z', tramiteId: 'aaaaaaaa-0000-0000-0000-000000000001', idFlit: 'FLIT-1001', estado: 'Asignado', asignado: true,
    tipoTramite: 'Matricula', ciudad: 'Manizales', empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
    transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte', organismoNombre: 'STT Manizales',
    vehiculo: { vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix' },
    compradorPrincipal: { nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', tipoDocumento: 'CC', correo: null },
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010' }],
    soat: null, excepcionesAutogestion: [], soatAutogestionado: false,
    impuesto: { id: 'i1', estado: 'pendiente', tieneFacturaVenta: false, valorPagado: null }, listoParaEntregar: false,
  };

  async function montarTramites(page: Page, responder: (r: Route) => unknown) {
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, responder as (r: Route) => void);
    await page.route(/\/api\/flito\/tramites\/facetas/, (r) => json(r, 200, { estados: [], tramites: [], ciudades: [], transitos: [] }));
    await page.route(/\/api\/flito\/tramites\?/, (r) => json(r, 200, { items: [TRAMITE], total: 1, page: 1, pageSize: 50 }));
    await page.goto('/flito/tramites');
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByRole('button', { name: 'Solicitar SOAT (1)', exact: true }).click();
    return page.getByRole('dialog', { name: 'Solicitar SOAT' });
  }

  test('AC3 · FlitoTramites ofrece lo del selector de SOAT', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const dialogo = await montarTramites(page, (r) => json(r, 200, POR_SERVICIO.soat));
    await expect(dialogo.getByLabel('Aseguradora').locator('option')).toHaveText(['Elige una aseguradora…', 'Doble Servicio', 'Seguros Alfa']);
  });

  test('AC6 · FlitoTramites: error con reintento y vacío', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let modo: 'error' | 'vacio' = 'error';
    const dialogo = await montarTramites(page, (r) => (modo === 'error' ? json(r, 500, { error: 'x' }) : json(r, 200, [])));
    await expect(dialogo.getByText('No se pudieron cargar los proveedores.')).toBeVisible();
    await expect(dialogo.getByLabel('Aseguradora')).toBeDisabled();
    modo = 'vacio';
    await dialogo.getByRole('button', { name: 'Volver a cargar proveedores' }).click();
    await expect(dialogo.getByText('No hay proveedores de SOAT activos.')).toBeVisible();
    await expect(dialogo.getByLabel('Aseguradora')).toBeDisabled();
    await expect(dialogo.getByRole('button', { name: 'Solicitar SOAT', exact: true })).toBeDisabled();
  });
});
