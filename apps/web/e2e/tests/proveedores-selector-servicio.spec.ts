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

  test('AC6 · selector de Logística: cargando bloquea el selector y al responder se libera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarClientes(page, [compania(1, 'Compañía Uno')]);
    // Se pide al abrir el modal, así que esta ruta (la última registrada, la que manda) entra antes de abrirlo.
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=logistica$/, async (r) => {
      await colgada;
      return json(r, 200, POR_SERVICIO.logistica);
    });
    const modal = await abrir(page, 'Compañía Uno');
    const selector = modal.getByLabel(/Proveedor de logística/);
    await expect(modal.getByLabel('Proveedor de SOAT sin trámite')).toBeEnabled();
    await expect(modal.getByText('Cargando proveedores…')).toBeVisible();
    await expect(selector).toBeDisabled();

    soltar();
    await expect(selector).toBeEnabled();
    await expect(modal.getByText('Cargando proveedores…')).toHaveCount(0);
    await expect(selector.locator('option')).toHaveText(['Elija un proveedor', 'Doble Servicio', 'Rutas del Norte']);
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

  /** Abre el detalle de la fila y el formulario de `boton`, con el catálogo que diga `responder`. */
  async function montarDetalle(page: Page, boton: string, fila: typeof SOAT, responder: (r: Route) => unknown) {
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, responder as (r: Route) => void);
    await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [fila], total: 1, page: 1, pageSize: 50 }));
    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByRole('button', { name: boton }).click();
    return dialogo;
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

  test('AC6 · selector «Nuevo proveedor» del detalle: cargando, error con reintento y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let cae = true;
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    const dialogo = await montarDetalle(page, 'Cambiar proveedor', SOAT, async (r) => {
      await colgada;
      return cae ? json(r, 500, { error: 'Catálogo caído' }) : json(r, 200, POR_SERVICIO.soat);
    });
    const select = dialogo.getByLabel('Nuevo proveedor');
    await expect(dialogo.getByText('Cargando proveedores…')).toBeVisible();
    await expect(select).toBeDisabled();

    soltar();
    await expect(dialogo.getByText('No se pudieron cargar los proveedores.')).toBeVisible();
    await expect(dialogo.getByText(/Catálogo caído/)).toHaveCount(0);
    await expect(select).toBeDisabled();

    cae = false;
    await dialogo.getByRole('button', { name: 'Volver a cargar proveedores' }).click();
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveText(['Selecciona…', 'Doble Servicio', 'Seguros Alfa']);
  });

  // 409 del API (F3): proveedor no utilizable o inexistente. Copy de negocio del servidor, sin nada colgado.
  const RECHAZO_INEXISTENTE = 'El gestor seleccionado no existe o fue eliminado.';
  const EN_GESTION = { ...SOAT, estado: 'solicitado', gestionOperaciones: true, proveedorSoatId: SOLO_SOAT, proveedorSoatNombre: 'Seguros Alfa' };
  for (const caso of [
    { etiqueta: 'Nuevo proveedor', boton: 'Cambiar proveedor', ruta: 'proveedor', fila: SOAT, motivo: 'Motivo del cambio' },
    { etiqueta: 'Proveedor que lo retoma', boton: 'Devolver al proveedor', ruta: 'devolver-gestor', fila: EN_GESTION, motivo: 'Motivo de la devolución (mín. 5 caracteres)' },
  ]) {
    test(`409 · DetalleSoat «${caso.etiqueta}»: mensaje de negocio a la vista, el formulario sigue vivo y se puede corregir`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const envios: unknown[] = [];
      let rechaza = true;
      await page.route(new RegExp(`/api/flito/soat/${caso.fila.id}/${caso.ruta}$`), (r) => {
        envios.push(r.request().postDataJSON());
        return rechaza ? json(r, 409, { error: RECHAZO_INEXISTENTE }) : json(r, 200, { ok: true });
      });
      const dialogo = await montarDetalle(page, caso.boton, caso.fila, (r) => json(r, 200, POR_SERVICIO.soat));
      await dialogo.getByLabel(caso.etiqueta).selectOption(AMBOS);
      await dialogo.getByLabel(caso.motivo).fill('Cambio de aseguradora');
      await dialogo.getByRole('button', { name: 'Confirmar' }).click();

      const aviso = dialogo.getByRole('alert');
      await expect(aviso).toHaveText(RECHAZO_INEXISTENTE);
      await expect(aviso).toBeInViewport();
      await expect(dialogo.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
      await expect(dialogo.getByLabel(caso.motivo)).toHaveValue('Cambio de aseguradora');

      rechaza = false;
      await dialogo.getByLabel(caso.etiqueta).selectOption(SOLO_SOAT);
      await dialogo.getByRole('button', { name: 'Confirmar' }).click();
      await expect(dialogo.getByRole('alert')).toHaveCount(0);
      expect(envios).toEqual([
        { proveedorSoatId: AMBOS, motivo: 'Cambio de aseguradora' },
        { proveedorSoatId: SOLO_SOAT, motivo: 'Cambio de aseguradora' },
      ]);
    });
  }

  test('DetalleSoat: el asignado que ya no se ofrece no se reenvía en silencio; hay que elegir otro', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const fila = { ...EN_GESTION, proveedorSoatId: APAGADO, proveedorSoatNombre: 'Antigua Aseguradora' };
    const dialogo = await montarDetalle(page, 'Devolver al proveedor', fila, (r) => json(r, 200, POR_SERVICIO.soat));
    const select = dialogo.getByLabel('Proveedor que lo retoma');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('');
    await dialogo.getByLabel('Motivo de la devolución (mín. 5 caracteres)').fill('Cambio de aseguradora');
    await expect(dialogo.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await select.selectOption(SOLO_SOAT);
    await expect(dialogo.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
  });

  test('409 · FlitoSoat, barra de envío: toast con el mensaje de negocio y la selección sigue para reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/soat\/enviar$/, (r) => json(r, 409, { error: RECHAZO_INEXISTENTE }));
    await montarCola(page, (r) => json(r, 200, POR_SERVICIO.soat));
    await page.getByLabel('Enviar a').selectOption(SOLO_SOAT);
    const enviar = page.getByRole('button', { name: 'Enviar al gestor (1)' });
    await enviar.click();
    await expect(page.getByText(RECHAZO_INEXISTENTE)).toBeInViewport();
    await expect(page.getByLabel('Seleccionar ABC123')).toBeChecked();
    await expect(enviar).toBeEnabled();
    await expect(page.getByLabel('Enviar a')).toBeEnabled();
    await page.getByRole('button', { name: /^(Cerrar|Descartar)/ }).first().click();
    await expect(page.getByText(RECHAZO_INEXISTENTE)).toHaveCount(0);
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

  test('AC6 · FlitoTramites: cargando bloquea el selector y la confirmación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let soltar: () => void = () => {};
    const colgada = new Promise<void>((resolve) => { soltar = resolve; });
    const dialogo = await montarTramites(page, async (r) => { await colgada; return json(r, 200, POR_SERVICIO.soat); });
    await expect(dialogo.getByText('Cargando proveedores…')).toBeVisible();
    await expect(dialogo.getByLabel('Aseguradora')).toBeDisabled();
    await expect(dialogo.getByRole('button', { name: 'Solicitar SOAT', exact: true })).toBeDisabled();

    soltar();
    await expect(dialogo.getByLabel('Aseguradora')).toBeEnabled();
    await expect(dialogo.getByText('Cargando proveedores…')).toHaveCount(0);
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

  for (const caso of [
    { boton: 'Solicitar SOAT (1)', dialogo: 'Solicitar SOAT', confirma: 'Solicitar SOAT', ruta: 'solicitar-soat' },
    { boton: 'Solicitar ambos (1)', dialogo: 'Solicitar SOAT e impuestos', confirma: 'Solicitar ambos', ruta: 'solicitar-ambos' },
  ]) {
    test(`409 · FlitoTramites «${caso.confirma}»: mensaje de negocio, sin resultado falso y se puede volver a pedir`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await page.route(new RegExp(`/api/flito/tramites/${caso.ruta}$`), (r) => json(r, 409, { error: RECHAZO_INEXISTENTE }));
      const inicial = await montarTramites(page, (r) => json(r, 200, POR_SERVICIO.soat));
      await inicial.getByRole('button', { name: 'Cancelar' }).click();
      const boton = page.getByRole('button', { name: caso.boton, exact: true });
      await boton.click();
      const dialogo = page.getByRole('dialog', { name: caso.dialogo, exact: true });
      await dialogo.getByLabel('Aseguradora').selectOption(AMBOS);
      await dialogo.getByRole('button', { name: caso.confirma, exact: true }).click();

      await expect(page.getByText(RECHAZO_INEXISTENTE)).toBeInViewport();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText(/^Resultado de solicitar/)).toHaveCount(0);
      await expect(page.getByLabel('Seleccionar ABC123')).toBeChecked();
      await expect(boton).toBeEnabled();
    });
  }

  test('409 · FlitoTramites, «Solicitar» de una fila lejana: el mensaje se ve sin volver arriba', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/tramites\/solicitar-soat$/, (r) => json(r, 409, { error: RECHAZO_INEXISTENTE }));
    await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, (r) => json(r, 200, POR_SERVICIO.soat));
    await page.route(/\/api\/flito\/tramites\/facetas/, (r) => json(r, 200, { estados: [], tramites: [], ciudades: [], transitos: [] }));
    const filas = Array.from({ length: 30 }, (_, i) => ({
      ...TRAMITE, tramiteId: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`, idFlit: `FLIT-${2000 + i}`,
      vehiculo: { ...TRAMITE.vehiculo, placa: `ABC${String(i).padStart(3, '0')}` },
      soat: { id: `s${i}`, estado: 'pendiente', valorPagado: null, enviadoEn: null, estancado: false, motivoRechazo: null },
    }));
    await page.route(/\/api\/flito\/tramites\?/, (r) => json(r, 200, { items: filas, total: filas.length, page: 1, pageSize: 50 }));
    await page.goto('/flito/tramites');
    // Cada fila trae dos «Solicitar», SOAT e impuestos, en ese orden: 58 es el de SOAT de la última.
    const ultima = page.getByRole('button', { name: 'Solicitar', exact: true }).nth(58);
    await ultima.scrollIntoViewIfNeeded();
    await ultima.click();
    const dialogo = page.getByRole('dialog', { name: 'Solicitar SOAT' });
    await dialogo.getByLabel('Aseguradora').selectOption(AMBOS);
    await dialogo.getByRole('button', { name: 'Solicitar SOAT', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(RECHAZO_INEXISTENTE)).toBeInViewport();
  });
});
