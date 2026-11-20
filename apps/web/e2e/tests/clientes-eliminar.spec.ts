// HU #13956 — Clientes: eliminar un cliente desde el menú ⋮ de la fila. Feature #13943.
// Diseño: extiende `docs/ux/clientes-menu-estado-13949-slim.md`. API existente (#13954):
// `GET /api/clients/:id/impacto` (motivo de no-eliminable) y `DELETE /api/clients/:id`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, funcionesDe } from '../helpers/auth';

const sinEliminar = (page: Page) =>
  loginAs(page, ADMIN_USER, {
    funciones: [...funcionesDe(ADMIN_USER).filter((f) => f !== 'clients.clientes.eliminar'), 'clients.clientes.estado'],
  });
const loginAdmin = (page: Page) =>
  loginAs(page, ADMIN_USER, { funciones: [...funcionesDe(ADMIN_USER), 'clients.clientes.estado', 'clients.clientes.eliminar'] });
// Solo eliminar (sin `clients.clientes.estado`): el ⋮ aparece igual, pero el contrato es que
// eliminar depende también de estado — el API protege `GET /impacto` con
// `exigirFuncion('clients.clientes.estado')` y responde 403. Ambas funciones son exclusivas del
// Administrador (#13944), así que la combinación no existe en producción; el test fija el contrato.
const soloEliminar = (page: Page) =>
  loginAs(page, ADMIN_USER, {
    funciones: [...funcionesDe(ADMIN_USER).filter((f) => f !== 'clients.clientes.estado'), 'clients.clientes.eliminar'],
  });

const RE_CLIENTES = /\/api\/clients(\?|$)/;
const RE_IMPACTO = /\/api\/clients\/(\d+)\/impacto$/;
const RE_UNO = /\/api\/clients\/(\d+)$/;

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

const impacto = (activo: boolean, saldoBolsa: number, motivo: string | null) => ({
  activo,
  procesosAbiertos: { soat: 0, impuestos: 0, tramites: 0, liquidaciones: 0 },
  saldoBolsa, usuariosAfectados: 0, puedeEliminar: motivo === null, motivoNoEliminable: motivo,
});

type Respuesta = { status: number; body: unknown } | 'abort';

interface Montaje {
  /** Por id; por defecto Acme (1) activo, Beta (2) inactivo con saldo, Gamma (3) eliminable. */
  impacto?: (id: number) => Respuesta | undefined;
  eliminar?: () => Respuesta;
}

async function montar(page: Page, m: Montaje = {}) {
  const lista = [cliente(1, 'Acme S.A.S.', true), cliente(2, 'Beta Ltda.', false), cliente(3, 'Gamma S.A.', false)];
  const deletes: number[] = [];
  const porDefecto: Record<number, ReturnType<typeof impacto>> = {
    1: impacto(true, 0, 'Primero debe desactivarlo.'),
    2: impacto(false, 150000, 'Su bolsa tiene saldo de $150.000; debe quedar en cero.'),
    3: impacto(false, 0, null),
  };
  await page.route(RE_CLIENTES, (route) => json(route, 200, lista));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (route) => json(route, 200, []));
  await page.route(RE_IMPACTO, (route) => {
    const id = Number(RE_IMPACTO.exec(route.request().url())?.[1]);
    const r = m.impacto?.(id) ?? { status: 200, body: porDefecto[id] };
    return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
  });
  await page.route(RE_UNO, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = Number(RE_UNO.exec(route.request().url())?.[1]);
    deletes.push(id);
    const r = m.eliminar?.() ?? { status: 200, body: { id, eliminado: true } };
    if (r === 'abort') return route.abort('failed');
    if (r.status === 200) { const i = lista.findIndex((x) => x.id === id); if (i >= 0) lista.splice(i, 1); }
    return json(route, r.status, r.body);
  });
  await page.goto('/clients');
  await expect(filas(page)).toHaveCount(3);
  return { lista, deletes };
}

const filas = (page: Page) => page.getByRole('table').locator('tbody tr');
const fila = (page: Page, nombre: string) => filas(page).filter({ hasText: nombre });
const kebab = (page: Page, nombre: string) => page.getByRole('button', { name: `Acciones de ${nombre}` });
const menu = (page: Page) => page.getByRole('menu');
const opcionEliminar = (page: Page) => menu(page).getByRole('menuitem', { name: 'Eliminar', exact: true });
const dialogo = (page: Page) => page.getByRole('dialog');

async function abrirDialogo(page: Page, nombre = 'Gamma S.A.') {
  await kebab(page, nombre).click();
  await expect(opcionEliminar(page)).not.toHaveAttribute('aria-disabled', 'true');
  await opcionEliminar(page).click();
  await expect(dialogo(page)).toHaveAttribute('aria-label', `Eliminar «${nombre}»`);
}

test.describe('HU #13956 · Clientes — eliminar desde el menú ⋮', () => {
  test('AC1 — activo: «Eliminar» deshabilitada (aria-disabled, enfocable) con «Primero debe desactivarlo.»', async ({ page }) => {
    await loginAdmin(page);
    const { deletes } = await montar(page);
    await kebab(page, 'Acme S.A.S.').click();
    await expect(menu(page).getByRole('menuitem')).toHaveCount(2);
    await expect(menu(page).getByRole('separator')).toHaveCount(1);
    const op = opcionEliminar(page);
    await expect(op).toHaveAttribute('aria-disabled', 'true');
    await expect(op).not.toHaveAttribute('disabled');
    // Playwright lee `aria-disabled` como deshabilitada (bien); lo que AC6 exige es que reciba foco.
    await expect(op).toBeDisabled();
    await op.focus();
    await expect(op).toBeFocused();
    await expect(op).toHaveAccessibleDescription('Primero debe desactivarlo.');
    // El clic de un usuario no la ejecuta (force: saltar la espera de actionability).
    await op.click({ force: true });
    await expect(dialogo(page)).toHaveCount(0);
    expect(deletes).toEqual([]);
  });

  test('AC2 — inactivo con saldo $150.000: el motivo lo dice', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await kebab(page, 'Beta Ltda.').click();
    await expect(opcionEliminar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(opcionEliminar(page)).toHaveAccessibleDescription('Su bolsa tiene saldo de $150.000; debe quedar en cero.');
  });

  test('AC3 — eliminable: el diálogo dice la consecuencia y el foco empieza en Cancelar', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await abrirDialogo(page);
    await expect(dialogo(page).getByText('Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.')).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(fila(page, 'Gamma S.A.')).toHaveCount(1);
  });

  test('AC4 — confirmar: toast «Cliente eliminado.» y desaparece de Todos, Activos e Inactivos', async ({ page }) => {
    await loginAdmin(page);
    const { deletes } = await montar(page);
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Cliente eliminado.')).toBeVisible();
    expect(deletes).toEqual([3]);
    await expect(fila(page, 'Gamma S.A.')).toHaveCount(0);
    for (const filtro of ['Activos', 'Inactivos', 'Todos']) {
      await page.getByRole('button', { name: filtro, exact: true }).click();
      await expect(fila(page, 'Gamma S.A.')).toHaveCount(0);
    }
  });

  test('AC5 — 409 de concurrencia: toast «Otro administrador ya cambió su estado» y la fila no cambia', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 409, body: { error: 'Otro administrador ya cambió su estado' } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Otro administrador ya cambió su estado.')).toBeVisible();
    await expect(fila(page, 'Gamma S.A.')).toHaveCount(1);
  });

  test('AC5 — red caída: alerta con «Reintentar» en el diálogo; reintentar elimina', async ({ page }) => {
    await loginAdmin(page);
    let falla = true;
    const { deletes } = await montar(page, {
      eliminar: () => (falla ? 'abort' : { status: 200, body: { id: 3, eliminado: true } }),
    });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No pudimos conectar con FLITO/);
    await expect(fila(page, 'Gamma S.A.')).toHaveCount(1);
    falla = false;
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Cliente eliminado.')).toBeVisible();
    expect(deletes).toEqual([3, 3]);
  });

  test('AC5 — 403: «No tiene permiso para esta acción», solo Cancelar y la fila sigue', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 403, body: { error: 'Forbidden: falta clients.clientes.eliminar' } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No tiene permiso para esta acción/);
    await expect(dialogo(page).getByRole('button', { name: /Eliminar|Reintentar/ })).toHaveCount(0);
    await expect(page.getByText(/Forbidden/)).toHaveCount(0);
    await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(fila(page, 'Gamma S.A.')).toHaveCount(1);
  });

  test('409 de no-eliminable al confirmar: el motivo de producto en el diálogo, sin reintento', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 409, body: { error: 'Su bolsa tiene saldo de $20.000; debe quedar en cero.' } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/Su bolsa tiene saldo de \$20\.000; debe quedar en cero\./);
    await expect(dialogo(page).getByRole('button', { name: /^(Eliminar|Reintentar)$/ })).toHaveCount(0);
  });

  test('AC6 — teclado: ↓ llega a «Eliminar» deshabilitada, su motivo por aria-describedby; Intro no abre nada', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await kebab(page, 'Acme S.A.S.').focus();
    await page.keyboard.press('Enter');
    await expect(menu(page).getByRole('menuitem', { name: 'Desactivar' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const op = opcionEliminar(page);
    await expect(op).toBeFocused();
    const idMotivo = await op.getAttribute('aria-describedby');
    expect(idMotivo).toBeTruthy();
    await expect(page.locator(`[id="${idMotivo}"]`)).toHaveText('Primero debe desactivarlo.');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(dialogo(page)).toHaveCount(0);
  });

  test('comprobación caída: motivo de reintento; elegirla reintenta sin cerrar el menú', async ({ page }) => {
    await loginAdmin(page);
    let falla = true;
    await montar(page, { impacto: (id) => (id === 3 && falla ? { status: 500, body: { error: 'boom interno' } } : undefined) });
    await kebab(page, 'Gamma S.A.').click();
    await expect(opcionEliminar(page)).toHaveAccessibleDescription('No pudimos comprobar si se puede eliminar. Elíjala para reintentar.');
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await opcionEliminar(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(opcionEliminar(page)).not.toHaveAttribute('aria-describedby');
    await opcionEliminar(page).click();
    await expect(dialogo(page)).toBeVisible();
  });

  test('permiso — sin `clients.clientes.eliminar` no hay «Eliminar»; con solo esa función sí hay ⋮', async ({ page }) => {
    await sinEliminar(page);
    await montar(page);
    await kebab(page, 'Gamma S.A.').click();
    await expect(opcionEliminar(page)).toHaveCount(0);
  });

  test('permiso — eliminar sin estado: /impacto responde 403 y «Eliminar» queda deshabilitada (eliminar requiere también estado)', async ({ page }) => {
    await soloEliminar(page);
    // Como el API real: `/impacto` exige `clients.clientes.estado`.
    await montar(page, { impacto: () => ({ status: 403, body: { error: 'Forbidden' } }) });
    await kebab(page, 'Gamma S.A.').click();
    await expect(menu(page).getByRole('menuitem')).toHaveCount(1);
    await expect(menu(page).getByRole('separator')).toHaveCount(0);
    const op = opcionEliminar(page);
    await expect(op).toHaveAttribute('aria-disabled', 'true');
    await expect(op).toHaveAccessibleDescription('No tiene permiso para esta acción.');
    await op.focus();
    await expect(op).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText(/Forbidden/)).toHaveCount(0);
  });
});
