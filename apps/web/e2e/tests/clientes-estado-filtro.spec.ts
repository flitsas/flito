// HU #13948 — Clientes: mostrar el estado y filtrar por Activos / Inactivos. Feature #13939.
// Diseño: `docs/ux/clientes-estado-filtro-13948-slim.md`. El filtro es en cliente: cambiarlo no
// vuelve a pedir `GET /clients`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER } from '../helpers/auth';

const RE_CLIENTES = /\/api\/clients(\?|$)/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function cliente(id: number, name: string, active: boolean) {
  return {
    id, name, active, document: `9001${id}`, documentType: 'NIT', phone: null, email: null,
    address: null, city: 'Cali',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    gestorSoatSinTramite: null, permisoSinTramiteSinEfecto: false,
  };
}

const CINCO = [
  cliente(1, 'Acme S.A.S.', true),
  cliente(2, 'Beta Ltda.', false),
  cliente(3, 'Gamma S.A.', true),
  cliente(4, 'Delta S.A.S.', false),
  cliente(5, 'Épsilon Ltda.', true),
];

async function montar(page: Page, respuesta: () => { status: number; body: unknown }) {
  let pedidos = 0;
  await page.route(RE_CLIENTES, (route) => { pedidos += 1; const r = respuesta(); return json(route, r.status, r.body); });
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (route) => json(route, 200, []));
  await page.goto('/clients');
  return { pedidos: () => pedidos };
}

const tabla = (page: Page) => page.getByRole('table');
const filas = (page: Page) => tabla(page).locator('tbody tr');
const grupoEstado = (page: Page) => page.getByRole('group', { name: 'Estado' });
const pill = (page: Page, nombre: string) => grupoEstado(page).getByRole('button', { name: nombre, exact: true });
const pie = (page: Page) => page.getByRole('status').filter({ hasText: /^Mostrando/ });

test.describe('HU #13948 · Clientes — estado y filtro', () => {
  test('AC1 — «Todos» por defecto: 5 filas con el chip de Estado bajo la Empresa y «Mostrando 5 de 5»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 200, body: CINCO }));
    await expect(filas(page)).toHaveCount(5);
    await expect(pill(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
    const cabeceras = tabla(page).locator('thead th');
    await expect(cabeceras.nth(0)).toHaveText('Empresa');
    // HU #14105: el estado ya no es columna; el chip va bajo el nombre de la empresa.
    await expect(filas(page).filter({ hasText: 'Acme S.A.S.' }).locator('td').nth(0)).toContainText('Activo');
    await expect(filas(page).filter({ hasText: 'Beta Ltda.' }).locator('td').nth(0)).toContainText('Inactivo');
    await expect(pie(page)).toHaveText('Mostrando 5 de 5');
  });

  test('AC2 — «Inactivos» deja 2 filas y «Mostrando 2 de 5» sin volver a pedir datos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const { pedidos } = await montar(page, () => ({ status: 200, body: CINCO }));
    await expect(filas(page)).toHaveCount(5);
    const antes = pedidos();
    await pill(page, 'Inactivos').click();
    await expect(filas(page)).toHaveCount(2);
    await expect(filas(page).filter({ hasText: 'Beta Ltda.' })).toHaveCount(1);
    await expect(filas(page).filter({ hasText: 'Delta S.A.S.' })).toHaveCount(1);
    await expect(pie(page)).toHaveText('Mostrando 2 de 5');
    await expect(pill(page, 'Inactivos')).toHaveAttribute('aria-pressed', 'true');
    await pill(page, 'Activos').click();
    await expect(filas(page)).toHaveCount(3);
    await expect(pie(page)).toHaveText('Mostrando 3 de 5');
    await expect(page.getByText('Cargando compañías…')).toHaveCount(0);
    expect(pedidos()).toBe(antes);
  });

  test('AC3 — sin inactivos, «Inactivos» muestra el vacío del filtro y «Ver todos» lo deshace', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 200, body: CINCO.filter((c) => c.active) }));
    await pill(page, 'Inactivos').click();
    await expect(page.getByText('No hay registros con este filtro.')).toBeVisible();
    await expect(tabla(page)).toHaveCount(0);
    await expect(pie(page)).toHaveText('Mostrando 0 de 3');
    await page.getByRole('button', { name: 'Ver todos' }).click();
    await expect(filas(page)).toHaveCount(3);
    await expect(pill(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
  });

  test('vacío total — «No hay clientes» sin filtro ni pie (distinto del vacío del filtro)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 200, body: [] }));
    await expect(page.getByText(/No hay clientes\./)).toBeVisible();
    await expect(grupoEstado(page)).toHaveCount(0);
    await expect(pie(page)).toHaveCount(0);
  });

  test('AC4 — con solo «Ver clientes y proveedores» ve Estado, filtro y pie; sin menú ⋮', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: ['clients.clientes.ver'] });
    await montar(page, () => ({ status: 200, body: CINCO }));
    await expect(filas(page)).toHaveCount(5);
    await expect(filas(page).first().locator('td').nth(0)).toContainText(/Activo|Inactivo/);
    await expect(grupoEstado(page)).toBeVisible();
    await expect(pie(page)).toHaveText('Mostrando 5 de 5');
    await expect(page.getByRole('button', { name: /más acciones|⋮/i })).toHaveCount(0);
  });

  test('AC5 — el fallo de carga dice «No pudimos cargar los clientes.» y «Reintentar» recarga', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    let falla = true;
    await montar(page, () => (falla
      ? { status: 500, body: { error: 'relation "clients" does not exist' } }
      : { status: 200, body: CINCO }));
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos cargar los clientes.' })).toBeVisible();
    await expect(page.getByText('relation "clients" does not exist')).toHaveCount(0);
    await expect(grupoEstado(page)).toHaveCount(0);
    await expect(pie(page)).toHaveCount(0);
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(filas(page)).toHaveCount(5);
  });

  test('AC6 — grupo rotulado, operable con teclado y estado en texto', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 200, body: CINCO }));
    await expect(filas(page)).toHaveCount(5);
    await pill(page, 'Todos').focus();
    await page.keyboard.press('Tab');
    await expect(pill(page, 'Activos')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(pill(page, 'Inactivos')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pill(page, 'Inactivos')).toHaveAttribute('aria-pressed', 'true');
    await expect(pill(page, 'Todos')).toHaveAttribute('aria-pressed', 'false');
    await expect(pie(page)).toHaveText('Mostrando 2 de 5');
    await pill(page, 'Todos').focus();
    await page.keyboard.press('Space');
    await expect(pie(page)).toHaveText('Mostrando 5 de 5');
    // El estado no depende solo del color: el chip dice la palabra.
    await expect(tabla(page).getByText('Inactivo', { exact: true })).toHaveCount(2);
    await expect(tabla(page).getByText('Activo', { exact: true })).toHaveCount(3);
  });

  test('cambiar a Proveedores y volver deja el filtro en «Todos»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, () => ({ status: 200, body: CINCO }));
    await pill(page, 'Inactivos').click();
    await expect(pie(page)).toHaveText('Mostrando 2 de 5');
    await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
    await page.getByRole('button', { name: 'Clientes', exact: true }).click();
    await expect(pill(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
    await expect(pie(page)).toHaveText('Mostrando 5 de 5');
  });
});
