// Ficha fiscal del cliente (HU #11298, Feature #11241). Backend mockeado.
//
// La pantalla de Clientes ya existía; esto añade la ficha con lo que Siigo exige. Lo que estas
// pruebas cuidan por encima de todo es que **nada catalogado se pueda escribir a mano** y que
// cambiar el tipo de persona avise antes de reinterpretar el nombre: los dos son la diferencia
// entre una factura correcta y una emitida ante la DIAN contra datos que nadie verificó.

import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, AUDITOR_USER, CONDUCTOR_USER } from '../helpers/auth';

type Page = import('@playwright/test').Page;

const CLIENTE_COMPLETO = {
  id: 1, name: 'TRANSPORTES 3M S.A.S.', document: '900123456', documentType: 'NIT',
  phone: '3001112233', email: 'contacto@3m.co', address: 'Calle 10 # 20-30', city: 'BOGOTA D.C.',
  notes: null, active: true,
  soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
  logisticaPermiteParcial: false,
  personType: 'Company', idType: '31', checkDigit: 7, fiscalResponsibilities: ['R-99-PN'],
  countryCode: 'Co', stateCode: '11', cityCode: '11001', commercialName: null, branchOffice: 0,
  contactFirstName: 'Ana', contactLastName: 'Ramírez', contactEmail: 'ana@3m.co',
  phoneIndicative: '57', phoneNumber: '3001112233',
};

const CLIENTE_VACIO = {
  ...CLIENTE_COMPLETO, id: 2, name: 'Sin datos fiscales', document: null,
  personType: null, idType: null, checkDigit: null, fiscalResponsibilities: [],
  countryCode: null, stateCode: null, cityCode: null, address: null, city: 'Medelin',
  contactFirstName: null, contactLastName: null, contactEmail: null,
  phoneIndicative: null, phoneNumber: null,
};

const VEREDICTO_OK = { clienteId: 1, facturable: true, pendienteClasificacion: false, faltantes: [] };
const VEREDICTO_FALTA = {
  clienteId: 2, facturable: false, pendienteClasificacion: true,
  faltantes: [
    { motivo: 'tipo_persona_sin_clasificar', detalle: 'Falta clasificar si es empresa o persona natural.', campo: 'personType' },
    { motivo: 'direccion_faltante', detalle: 'Falta la dirección.', campo: 'address' },
  ],
};

interface Opciones {
  clientes?: unknown[];
  veredictos?: unknown[];
  catalogoCargado?: boolean;
  propuesta?: unknown;
}

async function mock(page: Page, o: Opciones = {}) {
  await page.route(/\/api\/clients(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(o.clientes ?? [CLIENTE_COMPLETO, CLIENTE_VACIO]),
    });
  });
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ total: 2, data: o.veredictos ?? [VEREDICTO_OK, VEREDICTO_FALTA] }),
  }));
  await page.route(/\/api\/siigo\/clientes\/(\d+)\/validacion/, (route) => {
    const id = Number(/clientes\/(\d+)\/validacion/.exec(route.request().url())![1]);
    const v = (o.veredictos ?? [VEREDICTO_OK, VEREDICTO_FALTA]) as { clienteId: number }[];
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(v.find((x) => x.clienteId === id) ?? VEREDICTO_OK),
    });
  });
  await page.route(/\/api\/siigo\/ciudades$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ cargado: o.catalogoCargado ?? true, total: 4605, activas: 4605, version: '2026-08-06' }),
  }));
  await page.route(/\/api\/siigo\/ciudades\/paises/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ codigo: 'Co', nombre: 'Colombia' }] }),
  }));
  await page.route(/\/api\/siigo\/ciudades\/Co\/departamentos/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ codigo: '11', nombre: 'Bogotá D.C' }, { codigo: '05', nombre: 'Antioquia' }] }),
  }));
  await page.route(/\/api\/siigo\/ciudades\/Co\/\d+\/ciudades/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ codigo: '11001', nombre: 'Bogotá' }] }),
  }));
  await page.route(/\/api\/siigo\/clientes-ciudades\/\d+\/propuesta/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(o.propuesta ?? {
      textoOrigen: 'Medelin', certeza: 'aproximada',
      candidatas: [{ countryCode: 'Co', stateCode: '05', stateName: 'Antioquia', cityCode: '05001', cityName: 'Medellín' }],
    }),
  }));
}

/** Abre la ficha fiscal de un cliente por su nombre. */
async function abrirFicha(page: Page, nombre: string) {
  await page.goto('/clients');
  await page.getByRole('button', { name: `Datos fiscales de ${nombre}` }).click();
}

test.describe('AC1 — acceso y permisos', () => {
  test('un rol sin permiso sobre clientes no entra', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mock(page);
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
  });

  test('admin edita los datos fiscales', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByRole('button', { name: 'Guardar datos fiscales' })).toBeVisible();
    await expect(page.getByLabel('Tipo de persona')).toBeEnabled();
  });

  test('un rol de solo lectura los ve pero no los guarda', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByLabel('Tipo de persona')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Guardar datos fiscales' })).toHaveCount(0);
    await expect(page.getByText('Tu rol puede consultar estos datos, no modificarlos.')).toBeVisible();
  });
});

test.describe('AC2 — los cuatro estados', () => {
  test('cargando y luego con datos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByLabel('Identificación', { exact: true })).toHaveValue('900123456');
  });

  test('vacío: explica cuál es el primer dato a llenar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    // No un «no hay datos» a secas: dice por dónde empezar y por qué.
    await expect(page.getByText(/Empieza por el/)).toBeVisible();
    await expect(page.getByText(/de él dependen la forma del nombre/)).toBeVisible();
  });

  test('el error ofrece reintentar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    let intentos = 0;
    await page.route(/\/api\/siigo\/clientes\/1\/validacion/, (route) => {
      intentos += 1;
      return intentos === 1
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Error interno' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VEREDICTO_OK) });
    });
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByLabel('Identificación', { exact: true })).toHaveValue('900123456');
  });
});

test.describe('AC3 — el tipo de persona decide la forma del nombre', () => {
  test('compañía pide razón social y nombre comercial', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByLabel('Razón social')).toBeVisible();
    await expect(page.getByLabel('Nombre comercial (opcional)')).toBeVisible();
    await expect(page.getByLabel('Nombres')).toHaveCount(0);
  });

  test('cambiar de compañía a persona AVISA antes de aplicar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await page.getByLabel('Tipo de persona').selectOption('Person');

    // Todavía NO se aplicó: la razón social sigue ahí.
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByText(/reinterpreta el nombre/)).toBeVisible();
    await expect(page.getByLabel('Razón social')).toBeVisible();

    await page.getByRole('button', { name: 'Entiendo, cambiar' }).click();
    await expect(page.getByLabel('Nombres')).toBeVisible();
    await expect(page.getByLabel('Apellidos')).toBeVisible();
    await expect(page.getByLabel('Razón social')).toHaveCount(0);
  });

  test('cancelar el aviso deja el tipo como estaba', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await page.getByLabel('Tipo de persona').selectOption('Person');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByLabel('Razón social')).toBeVisible();
    await expect(page.getByLabel('Tipo de persona')).toHaveValue('Company');
  });

  test('el primer tipo de persona NO pide confirmación: no hay nada que reinterpretar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    await page.getByLabel('Tipo de persona').selectOption('Person');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByLabel('Nombres')).toBeVisible();
  });
});

test.describe('AC4 — la ubicación se elige, no se escribe', () => {
  test('país, departamento y ciudad son listas en cascada', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    for (const campo of ['País', 'Departamento', 'Ciudad']) {
      await expect(page.getByLabel(campo)).toHaveJSProperty('tagName', 'SELECT');
    }
    await expect(page.getByLabel('Ciudad')).toHaveValue('11001');
  });

  test('el departamento y la ciudad quedan bloqueados hasta elegir el anterior', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    await expect(page.getByLabel('Departamento')).toBeDisabled();
    await expect(page.getByLabel('Ciudad')).toBeDisabled();
    await page.getByLabel('País').selectOption('Co');
    await expect(page.getByLabel('Departamento')).toBeEnabled();
    await expect(page.getByLabel('Ciudad')).toBeDisabled();
  });

  test('la ciudad en texto libre se muestra junto a la equivalencia propuesta', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    await expect(page.getByText(/Ciudad registrada en la ficha/)).toBeVisible();
    await expect(page.getByText(/Equivalencia propuesta para «Medelin»/)).toBeVisible();
    // Una coincidencia aproximada se anuncia como tal, no como certeza.
    await expect(page.getByText('Parecida — revísala')).toBeVisible();
    // Y no se aplica sola.
    await expect(page.getByText('Nada se aplica solo: elige la que corresponda y guarda.')).toBeVisible();
    await expect(page.getByLabel('Ciudad')).toHaveValue('');
  });

  test('elegir una candidata llena la cascada completa', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    await page.getByRole('button', { name: /Medellín · Antioquia/ }).click();
    await expect(page.getByLabel('País')).toHaveValue('Co');
    await expect(page.getByLabel('Departamento')).toHaveValue('05');
  });

  test('sin catálogo cargado lo dice, en vez de mostrar listas vacías', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page, { catalogoCargado: false });
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByText(/catálogo de ubicaciones de Siigo no está cargado/)).toBeVisible();
  });
});

test.describe('AC5 — lo que falta se ve en la ficha y en la lista', () => {
  test('el listado señala quién no se puede facturar', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await page.goto('/clients');
    await expect(page.getByRole('columnheader', { name: 'Facturación' })).toBeVisible();
    await expect(page.getByText('Lista')).toBeVisible();
    await expect(page.getByText('Por clasificar')).toBeVisible();
  });

  test('la ficha enumera los datos faltantes uno por uno', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'Sin datos fiscales');
    await expect(page.getByText('Este cliente todavía no se puede facturar')).toBeVisible();
    // Nombrados, no un «datos incompletos».
    await expect(page.getByText('Falta clasificar si es empresa o persona natural.')).toBeVisible();
    await expect(page.getByText('Falta la dirección.')).toBeVisible();
  });

  test('un cliente completo lo dice en positivo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByText(/tiene todo lo que Siigo exige/)).toBeVisible();
  });

  test('al guardar, la señal se actualiza sin recargar la pantalla', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await page.route(/\/api\/clients\/2$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ id: 2 }),
    }));
    await abrirFicha(page, 'Sin datos fiscales');
    await expect(page.getByText('Este cliente todavía no se puede facturar')).toBeVisible();

    // Tras guardar, el veredicto ya viene limpio.
    await page.route(/\/api\/siigo\/clientes\/2\/validacion/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ clienteId: 2, facturable: true, pendienteClasificacion: false, faltantes: [] }),
    }));
    await page.getByRole('button', { name: 'Guardar datos fiscales' }).click();
    await expect(page.getByText(/tiene todo lo que Siigo exige/)).toBeVisible();
  });
});

test.describe('AC6 — listas cerradas y formato señalado en el campo', () => {
  test('el tipo de identificación sale de la lista de Siigo, en español', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    const select = page.getByLabel('Tipo de identificación');
    await expect(select).toHaveJSProperty('tagName', 'SELECT');
    await expect(select.getByRole('option', { name: 'NIT', exact: true })).toHaveCount(1);
    await expect(select.getByRole('option', { name: 'Cédula de ciudadanía' })).toHaveCount(1);
  });

  test('las responsabilidades fiscales también, y con su nombre', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByRole('checkbox', { name: 'Gran contribuyente' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /No aplica/ })).toBeChecked();
  });

  test('el dígito de verificación va junto a la identificación', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await expect(page.getByLabel('Dígito de verificación')).toHaveValue('7');
  });

  const FORMATOS: { campo: string; valor: string; mensaje: RegExp }[] = [
    { campo: 'Dígito de verificación', valor: '12', mensaje: /Un solo dígito/ },
    { campo: 'Indicativo', valor: '+57', mensaje: /Solo dígitos/ },
    { campo: 'Teléfono', valor: '31112223334', mensaje: /Solo dígitos/ },
    { campo: 'Correo del contacto', valor: 'sin-arroba', mensaje: /formato inválido/ },
  ];

  for (const { campo, valor, mensaje } of FORMATOS) {
    test(`«${campo}» inválido se señala ANTES de intentar guardar`, async ({ page }) => {
      await loginAs(page, ADMIN_USER);
      await mock(page);
      let sePidio = false;
      await page.route(/\/api\/clients\/1$/, (route) => { sePidio = true; return route.continue(); });

      await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
      await page.getByLabel(campo).fill(valor);
      await expect(page.getByText(mensaje)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Guardar datos fiscales' })).toBeDisabled();
      expect(sePidio).toBe(false);
    });
  }

  test('una sucursal fuera de rango bloquea el guardado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mock(page);
    await abrirFicha(page, 'TRANSPORTES 3M S.A.S.');
    await page.getByLabel('Sucursal en Siigo').fill('1000');
    await expect(page.getByText(/entre 0 y 999/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar datos fiscales' })).toBeDisabled();
  });
});
