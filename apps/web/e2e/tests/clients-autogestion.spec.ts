// Clientes (/clients) — una sola tabla: info de empresa + checkboxes de servicio
// (SOAT/Impuestos/Logística) inline. Un cliente ES una compañía FLITO (§correcciones-UX).
// Solo Operaciones/admin lo ven; backend mockeado.
//
// HU #13935: los checks se leen «FLITO gestiona este servicio». El dato `*Autogestionable` conserva
// su sentido, así que marcado = `false` en el dato.
// HU #13936: sin check «Parcial» — Logística permite siempre entregas parciales.
// HU #13937: la empresa nueva nace sin servicios gestionados por FLITO (casillas desmarcadas).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

const CLIENTES = [
  {
    id: 1, name: 'Concesionario Norte', document: '900111', documentType: 'NIT',
    phone: '3001112233', email: 'norte@x.co', address: null, city: 'Manizales', notes: null, active: true,
    soatAutogestionable: true, soatSinTramite: false, impuestosAutogestionable: false, logisticaAutogestionable: true,
  },
];

async function mock(page: import('@playwright/test').Page, clientes = CLIENTES) {
  await page.route(/\/api\/clients(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(clientes) }));
}

const check = (page: import('@playwright/test').Page, servicio: string) =>
  page.getByRole('checkbox', { name: `FLITO gestiona ${servicio} de Concesionario Norte` });

test.describe('Clientes · servicios que gestiona FLITO (HU #13935)', () => {
  test('AC1/AC5: el check marcado es «FLITO gestiona» y lee el dato invertido', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let patches = 0;
    await page.route(/\/api\/flito\/parametrizacion\/companias\//, (route) => { patches += 1; return route.fulfill({ status: 200, body: '{}' }); });

    await page.goto('/clients');
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('cell', { name: /900111/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Manizales' })).toBeVisible();
    // soat=true → desmarcado; impuestos=false → marcado; logística=true → desmarcado.
    await expect(check(page, 'SOAT')).not.toBeChecked();
    await expect(check(page, 'Impuestos')).toBeChecked();
    await expect(check(page, 'Logística')).not.toBeChecked();
    // AC5: ningún nombre accesible ni nota habla de «Autogestión» del check.
    await expect(page.getByRole('checkbox', { name: /Autogestión/ })).toHaveCount(0);
    await expect(page.getByText(/Marca «Autogestiona»/)).toHaveCount(0);
    await expect(page.getByText(/cuando FLITO gestiona ese servicio/)).toBeVisible();
    // Solo pintar no escribe nada.
    expect(patches).toBe(0);
    await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Tolerancia/i })).toHaveCount(0);
  });

  test('AC4 (#13936): no existe la columna «Parcial» ni las notas hablan de entregas parciales', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Aunque el API siguiera mandando el campo, la pantalla no lo pinta.
    await mock(page, CLIENTES.map((c) => ({ ...c, logisticaPermiteParcial: false })));

    await page.goto('/clients');
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Logística' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Parcial' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /Entregas parciales/ })).toHaveCount(0);
    // Solo quedan los tres checks de servicio por fila.
    await expect(page.getByRole('checkbox', { name: /^FLITO gestiona .* de Concesionario Norte$/ })).toHaveCount(3);
    await expect(page.getByText(/cuando FLITO gestiona ese servicio/)).toBeVisible();
    await expect(page.getByText(/Parcial/)).toHaveCount(0);
    await expect(page.getByText(/Solo completo/i)).toHaveCount(0);
  });

  test('AC4 (#13936): la ficha de ayuda de Clientes no menciona «Parcial» ni «Solo completo»', () => {
    const ficha = readFileSync(fileURLToPath(new URL('../../src/content/ayuda/clients.md', import.meta.url)), 'utf8');
    expect(ficha).not.toMatch(/Parcial/);
    expect(ficha).not.toMatch(/Solo completo/i);
  });

  test('AC2: marcar Logística envía logisticaAutogestionable=false y sigue marcado al recargar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let datos = CLIENTES.map((c) => ({ ...c }));
    await page.route(/\/api\/clients(\?|$)/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(datos) }));
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      expect(route.request().method()).toBe('PATCH');
      datos = datos.map((c) => ({ ...c, ...body }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1 }) });
    });

    await page.goto('/clients');
    await check(page, 'Logística').check();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toEqual({ logisticaAutogestionable: false });
    await expect(check(page, 'Logística')).toBeChecked();

    await page.reload();
    await expect(check(page, 'Logística')).toBeChecked();
  });

  test('desmarcar Impuestos envía impuestosAutogestionable=true', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1 }) });
    });

    await page.goto('/clients');
    await check(page, 'Impuestos').uncheck();
    await expect.poll(() => body).toEqual({ impuestosAutogestionable: true });
    await expect(check(page, 'Impuestos')).not.toBeChecked();
  });

  test('AC3: si el PATCH falla, el check vuelve y sale un toast cerrable sin el error crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'DB_TIMEOUT pg_pool' }) }));

    await page.goto('/clients');
    await check(page, 'SOAT').click();
    await expect(check(page, 'SOAT')).not.toBeChecked();

    const aviso = page.getByRole('alert').filter({ hasText: 'No se pudo guardar «SOAT» de Concesionario Norte' });
    await expect(aviso).toBeVisible();
    await expect(aviso).not.toContainText('DB_TIMEOUT');
    await aviso.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(aviso).toHaveCount(0);
  });
});

// AC4 — modal «Crear empresa» de Gestión Trámites: mismo sentido de lectura.
const FILA_SIN_EMPRESA = {
  tramiteId: 'cccccccc-0000-0000-0000-000000000001', idFlit: 'FLIT-3001', estado: 'Asignado', asignado: true,
  fuente: 'flit', tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: false, empresaNit: '900999', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Empresa Nueva',
  organismoNombre: 'STT Manizales', vehiculo: { vin: 'VIN000000000301', placa: 'PLC301', marca: 'Mazda', linea: '2', tipoVehiculo: null },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], listoParaEntregar: false,
};

async function abrirCrearEmpresa(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado'], tramites: ['Matricula'], ciudades: ['Manizales'], transitos: ['STT Manizales'] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [FILA_SIN_EMPRESA], total: 1, page: 1, pageSize: 50 }) }));
  const enviado: { body: Record<string, unknown> | null } = { body: null };
  await page.route(/\/api\/flito\/tramites\/crear-empresa$/, (route) => {
    enviado.body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 9 }) });
  });
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await page.getByRole('button', { name: 'Crear empresa' }).click();
  return { modal: page.getByRole('dialog'), enviado };
}

test('AC4: «Crear empresa» titula «Servicios que gestiona FLITO» y lo marcado viaja como *Autogestionable=false', async ({ page }) => {
  const { modal, enviado } = await abrirCrearEmpresa(page);

  await expect(modal.getByText('Servicios que gestiona FLITO')).toBeVisible();
  await expect(modal.getByText(/Autogestión/)).toHaveCount(0);
  // Desde la HU #13937 las casillas nacen desmarcadas: `check()` cambia el estado de verdad.
  await modal.getByRole('checkbox', { name: 'SOAT' }).check();
  await expect(modal.getByRole('checkbox', { name: 'SOAT' })).toBeChecked();
  // Ida y vuelta en Logística: recorre los dos sentidos del onChange y termina desmarcada.
  await modal.getByRole('checkbox', { name: 'Logística' }).check();
  await modal.getByRole('checkbox', { name: 'Logística' }).uncheck();
  await expect(modal.getByRole('checkbox', { name: 'Logística' })).not.toBeChecked();
  await modal.getByRole('button', { name: 'Crear empresa' }).click();

  await expect.poll(() => enviado.body).not.toBeNull();
  expect(enviado.body).toMatchObject({
    nit: '900999', soatAutogestionable: false, impuestosAutogestionable: true, logisticaAutogestionable: true,
  });
});

test.describe('Empresa nueva sin servicios gestionados por FLITO (HU #13937)', () => {
  test('AC2: al abrir «Crear empresa», SOAT, Impuestos y Logística aparecen desmarcados', async ({ page }) => {
    const { modal } = await abrirCrearEmpresa(page);
    for (const servicio of ['SOAT', 'Impuestos', 'Logística']) {
      await expect(modal.getByRole('checkbox', { name: servicio })).not.toBeChecked();
    }
  });

  test('AC3: guardar sin marcar nada envía los tres *Autogestionable=true', async ({ page }) => {
    const { modal, enviado } = await abrirCrearEmpresa(page);
    await modal.getByRole('button', { name: 'Crear empresa' }).click();

    await expect.poll(() => enviado.body).not.toBeNull();
    expect(enviado.body).toMatchObject({
      nit: '900999', soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
    });
  });

  test('AC1: la compañía recién creada (tres *Autogestionable=true) se ve en Clientes con las tres casillas desmarcadas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page, CLIENTES.map((c) => ({
      ...c, soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
    })));

    await page.goto('/clients');
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    for (const servicio of ['SOAT', 'Impuestos', 'Logística']) {
      await expect(check(page, servicio)).not.toBeChecked();
    }
  });
});

// ─────────────────────── Módulo fusionado (HU #10979) ───────────────────────
//
// «Clientes y proveedores» absorbió la antigua Parametrización: los proveedores SOAT viven en su
// propia pestaña. Las tarifas ya NO se abren aquí (HU #12375): el botón «Tarifas» de la fila es un
// enlace al configurador de valores, y la ventana emergente se retiró con todo su código.

const PROVEEDORES = [
  { id: 'p1', nombre: 'Seguros Alfa', estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo: true },
];

async function mockModulo(page: import('@playwright/test').Page) {
  await mock(page);
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
}

test.describe('Clientes y proveedores · módulo fusionado', () => {
  test('las dos pestañas conviven en una sola pantalla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clientes y proveedores' })).toBeVisible();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();

    await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Seguros Alfa', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'portal' })).toBeVisible();
  });

  test('«Tarifas» de la fila es un enlace al configurador y ya no abre ninguna ventana (AC11 #12375)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    const enlace = page.getByRole('link', { name: 'Tarifas de Concesionario Norte' });
    await expect(enlace).toHaveAttribute('href', '/flito/tarifas/1');
    // Ni botón ni ventana: la tarifa se administra en su pantalla.
    await expect(page.getByRole('button', { name: /^Tarifas/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nueva tarifa' })).toHaveCount(0);
  });

  test('auditoría ve Clientes pero no el enlace a Tarifas: no tiene esa página', async ({ page }) => {
    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['clients'] });
    await mockModulo(page);

    await page.goto('/clients');
    await expect(page.getByText('Concesionario Norte')).toBeVisible();
    await expect(page.getByRole('link', { name: /Tarifas de/ })).toHaveCount(0);
  });

  test('ya no existe la pestaña de reglas de enrutamiento', async ({ page }) => {
    // El proveedor se elige al enviar el SOAT al gestor; las reglas por ámbito se retiraron.
    await loginAs(page, OPERACIONES_USER);
    await mockModulo(page);

    await page.goto('/clients');
    await expect(page.getByRole('button', { name: /Reglas/ })).toHaveCount(0);
  });
});
