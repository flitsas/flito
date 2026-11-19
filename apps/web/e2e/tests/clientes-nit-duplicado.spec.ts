// HU #13955 — Clientes: mostrar el NIT duplicado en el formulario de cliente. Feature #13943.
// UX: omit declarado (el AC fija el comportamiento; extensión del formulario existente).
//
// El API responde `409 { error: 'Ya existe un cliente con el NIT … y sucursal ….', campo: 'document' }`
// (RN-CLI-7). Ese texto, y SOLO ese, se pinta bajo el campo NIT; cualquier otro fallo va a un toast
// cerrable con copy propio. Se cubre el alta (Nuevo cliente) y la edición (ficha fiscal). Backend mockeado.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const RE_CLIENTES = /\/api\/clients(\?|$)/;
const MSG_DUPLICADO = 'Ya existe un cliente con el NIT 900123456 y sucursal 0.';
const TOAST_AC4 = 'No pudimos guardar el cliente. Intenta de nuevo.';
// Texto crudo que el API podría devolver en un 500: si aparece en pantalla, AC4 está roto.
const CRUDO_500 = 'duplicate key value violates unique constraint "clients_pkey" at Parser.parseErrorMessage';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const CLIENTE = {
  id: 1, name: 'TRANSPORTES 3M S.A.S.', document: '800999111', documentType: 'NIT',
  phone: null, email: null, address: 'Calle 10 # 20-30', city: 'BOGOTA D.C.', notes: null, active: true,
  soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
  gestorSoatSinTramite: null, permisoSinTramiteSinEfecto: false,
  personType: 'Company', idType: '31', checkDigit: 7, fiscalResponsibilities: ['R-99-PN'],
  countryCode: 'Co', stateCode: '11', cityCode: '11001', commercialName: null, branchOffice: 0,
  contactFirstName: 'Ana', contactLastName: 'Ramírez', contactEmail: 'ana@3m.co',
  phoneIndicative: '57', phoneNumber: '3001112233',
};
const VEREDICTO = { clienteId: 1, facturable: true, pendienteClasificacion: false, faltantes: [] };

type Respuesta = { status: number; body: unknown };

/**
 * Monta /clients con el listado mockeado. `alGuardar` responde el POST (alta) o el PATCH /clients/1
 * (edición) y recibe el cuerpo enviado; devuelve la lista de cuerpos para asertar lo que viajó.
 */
async function montar(page: Page, alGuardar: (intento: number) => Respuesta) {
  const enviados: Record<string, unknown>[] = [];
  const responder = (route: Route) => {
    enviados.push(route.request().postDataJSON() as Record<string, unknown>);
    const r = alGuardar(enviados.length);
    return json(route, r.status, r.body);
  };
  await page.route(RE_CLIENTES, (route) => (route.request().method() === 'POST' ? responder(route) : json(route, 200, [CLIENTE])));
  await page.route(/\/api\/clients\/1$/, (route) => (route.request().method() === 'PATCH' ? responder(route) : route.continue()));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { total: 1, data: [VEREDICTO] }));
  await page.route(/\/api\/siigo\/clientes\/\d+\/validacion/, (route) => json(route, 200, VEREDICTO));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (route) => json(route, 200, []));
  await page.route(/\/api\/siigo\/ciudades$/, (route) => json(route, 200, { cargado: true, total: 4605, activas: 4605, version: '2026-08-06' }));
  await page.route(/\/api\/siigo\/ciudades\/paises/, (route) => json(route, 200, { data: [{ codigo: 'Co', nombre: 'Colombia' }] }));
  await page.route(/\/api\/siigo\/ciudades\/Co\/departamentos/, (route) => json(route, 200, { data: [{ codigo: '11', nombre: 'Bogotá D.C' }] }));
  await page.route(/\/api\/siigo\/ciudades\/Co\/\d+\/ciudades/, (route) => json(route, 200, { data: [{ codigo: '11001', nombre: 'Bogotá' }] }));
  await page.goto('/clients');
  return enviados;
}

const DUPLICADO: Respuesta = { status: 409, body: { error: MSG_DUPLICADO, campo: 'document' } };

async function abrirAlta(page: Page) {
  await page.getByRole('button', { name: 'Nuevo cliente' }).click();
  await page.getByPlaceholder('Nombre o razón social *').fill('Nuevo Transporte S.A.S.');
  await page.getByLabel('NIT / Cédula').fill('900123456');
  await page.getByLabel('Sucursal').fill('0');
}

const guardarAlta = (page: Page) => page.getByRole('button', { name: 'Guardar', exact: true }).click();

/** AC2 — aria-invalid, aria-describedby apuntando al mensaje y foco en el campo. */
async function esperarErrorEnCampo(page: Page, campoNit: ReturnType<Page['getByLabel']>) {
  const mensaje = page.getByText(MSG_DUPLICADO, { exact: true });
  await expect(mensaje).toBeVisible();
  await expect(campoNit).toHaveAttribute('aria-invalid', 'true');
  const idMensaje = await mensaje.getAttribute('id');
  expect(idMensaje).toBeTruthy();
  await expect(campoNit).toHaveAttribute('aria-describedby', idMensaje!);
  await expect(campoNit).toHaveAccessibleDescription(MSG_DUPLICADO);
  await expect(campoNit).toBeFocused();
}

test.describe('HU #13955 · alta — NIT duplicado', () => {
  test('AC1 — el 409 se pinta bajo el NIT y el formulario sigue abierto con lo escrito', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const enviados = await montar(page, () => DUPLICADO);
    await abrirAlta(page);
    await guardarAlta(page);
    await expect(page.getByText(MSG_DUPLICADO, { exact: true })).toBeVisible();
    expect(enviados[0]).toMatchObject({ document: '900123456', branchOffice: 0 });
    await expect(page.getByRole('heading', { name: 'Nuevo cliente' })).toBeVisible();
    await expect(page.getByPlaceholder('Nombre o razón social *')).toHaveValue('Nuevo Transporte S.A.S.');
    await expect(page.getByLabel('NIT / Cédula')).toHaveValue('900123456');
    await expect(page.getByLabel('Sucursal')).toHaveValue('0');
    // El mensaje va en el campo, no repetido en un toast.
    await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toHaveCount(0);
  });

  test('AC2 — aria-invalid, aria-describedby al mensaje y foco en el NIT', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => DUPLICADO);
    await abrirAlta(page);
    await guardarAlta(page);
    await esperarErrorEnCampo(page, page.getByLabel('NIT / Cédula'));
  });

  test('AC3 — cambiar la sucursal y guardar crea el cliente y el error desaparece', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const enviados = await montar(page, (n) => (n === 1 ? DUPLICADO : { status: 201, body: { ...CLIENTE, id: 2 } }));
    await abrirAlta(page);
    await guardarAlta(page);
    await expect(page.getByText(MSG_DUPLICADO, { exact: true })).toBeVisible();
    await page.getByLabel('Sucursal').fill('1');
    await expect(page.getByText(MSG_DUPLICADO, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('NIT / Cédula')).not.toHaveAttribute('aria-invalid', 'true');
    await guardarAlta(page);
    await expect(page.getByText('Cliente creado')).toBeVisible();
    expect(enviados[1]).toMatchObject({ document: '900123456', branchOffice: 1 });
    await expect(page.getByRole('heading', { name: 'Nuevo cliente' })).toHaveCount(0);
  });

  test('AC4 — un 500 muestra el toast cerrable pulido y nunca el texto crudo del API', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 500, body: { error: CRUDO_500 } }));
    await abrirAlta(page);
    await guardarAlta(page);
    await expect(page.getByText(TOAST_AC4, { exact: true })).toBeVisible();
    await expect(page.getByText(CRUDO_500)).toHaveCount(0);
    await expect(page.getByText(/duplicate key|clients_pkey|Error del servidor/)).toHaveCount(0);
    await expect(page.getByLabel('NIT / Cédula')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('NIT / Cédula')).toHaveValue('900123456');
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(TOAST_AC4, { exact: true })).toHaveCount(0);
  });

  test('un 409 que no es del NIT (sin `campo`) va al toast pulido, no al campo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 409, body: { error: 'El cliente cambió de estado mientras lo editabas.' } }));
    await abrirAlta(page);
    await guardarAlta(page);
    await expect(page.getByText(TOAST_AC4, { exact: true })).toBeVisible();
    await expect(page.getByText('El cliente cambió de estado mientras lo editabas.')).toHaveCount(0);
    await expect(page.getByLabel('NIT / Cédula')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('HU #13955 · edición (ficha fiscal) — NIT duplicado', () => {
  async function abrirFicha(page: Page) {
    await page.getByRole('button', { name: `Editar ${CLIENTE.name}`, exact: true }).click();
    await page.getByRole('button', { name: 'Datos fiscales', exact: true }).click();
    await expect(page.getByLabel('Identificación', { exact: true })).toHaveValue('800999111');
    await page.getByLabel('Identificación', { exact: true }).fill('900123456');
  }
  const guardarFicha = (page: Page) => page.getByRole('button', { name: 'Guardar datos fiscales' }).click();

  test('AC1+AC2 — el 409 de la edición se pinta bajo Identificación, con aria y foco', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const enviados = await montar(page, () => DUPLICADO);
    await abrirFicha(page);
    await guardarFicha(page);
    await esperarErrorEnCampo(page, page.getByLabel('Identificación', { exact: true }));
    expect(enviados[0]).toMatchObject({ document: '900123456', branchOffice: 0 });
    await expect(page.getByLabel('Identificación', { exact: true })).toHaveValue('900123456');
  });

  test('AC3 — cambiar la sucursal limpia el error y el guardado pasa', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const enviados = await montar(page, (n) => (n === 1 ? DUPLICADO : { status: 200, body: CLIENTE }));
    await abrirFicha(page);
    await guardarFicha(page);
    await expect(page.getByText(MSG_DUPLICADO, { exact: true })).toBeVisible();
    await page.getByLabel('Sucursal en Siigo').fill('1');
    await expect(page.getByText(MSG_DUPLICADO, { exact: true })).toHaveCount(0);
    await guardarFicha(page);
    await expect(page.getByText('Datos fiscales guardados')).toBeVisible();
    expect(enviados[1]).toMatchObject({ document: '900123456', branchOffice: 1 });
  });

  test('AC4 — un 500 en la edición muestra el toast pulido, no el texto crudo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 500, body: { error: CRUDO_500 } }));
    await abrirFicha(page);
    await guardarFicha(page);
    await expect(page.getByText(TOAST_AC4, { exact: true })).toBeVisible();
    await expect(page.getByText(/duplicate key|clients_pkey|Error del servidor/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(TOAST_AC4, { exact: true })).toHaveCount(0);
  });
});
