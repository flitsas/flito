// HU #13949 — Clientes: desactivar y activar un cliente desde el menú ⋮ de la fila. Feature #13939.
// Diseño: `docs/ux/clientes-menu-estado-13949-slim.md`. API existente (#13945):
// `GET /api/clients/:id/impacto` y `PATCH /api/clients/:id/estado` `{ activo, activoEsperado }`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER, funcionesDe } from '../helpers/auth';

// El catálogo de funciones de los fixtures no trae aún `clients.clientes.estado` (#13945): se suma
// explícitamente para el administrador que opera el ⋮.
const loginAdmin = (page: Page) =>
  loginAs(page, ADMIN_USER, { funciones: [...funcionesDe(ADMIN_USER), 'clients.clientes.estado'] });

const RE_CLIENTES = /\/api\/clients(\?|$)/;
const RE_IMPACTO = /\/api\/clients\/(\d+)\/impacto$/;
const RE_ESTADO = /\/api\/clients\/(\d+)\/estado$/;

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

const impacto = (p: Partial<Record<'soat' | 'impuestos' | 'tramites' | 'liquidaciones', number>>, usuarios = 0) => ({
  activo: true,
  procesosAbiertos: { soat: 0, impuestos: 0, tramites: 0, liquidaciones: 0, ...p },
  saldoBolsa: 0, usuariosAfectados: usuarios, puedeEliminar: false, motivoNoEliminable: null,
});

interface Montaje {
  impacto?: () => { status: number; body: unknown } | 'abort';
  estado?: () => { status: number; body: unknown } | 'abort';
}

/**
 * Lista de dos clientes (Acme activo, Beta inactivo). La lista que devuelve `GET /clients` es
 * MUTABLE: el PATCH simulado la cambia, así la recarga silenciosa muestra el estado «real».
 */
async function montar(page: Page, m: Montaje = {}) {
  const lista = [cliente(1, 'Acme S.A.S.', true), cliente(2, 'Beta Ltda.', false)];
  const patches: unknown[] = [];
  let impactos = 0;
  let listados = 0;
  await page.route(RE_CLIENTES, (route) => { listados += 1; return json(route, 200, lista); });
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (route) => json(route, 200, []));
  await page.route(RE_IMPACTO, (route) => {
    impactos += 1;
    const r = m.impacto?.() ?? { status: 200, body: impacto({ soat: 3, tramites: 2 }, 4) };
    return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
  });
  await page.route(RE_ESTADO, (route) => {
    const body = route.request().postDataJSON() as { activo: boolean; activoEsperado: boolean };
    patches.push(body);
    const r = m.estado?.() ?? { status: 200, body: { id: 1, activo: body.activo } };
    if (r === 'abort') return route.abort('failed');
    const id = Number(RE_ESTADO.exec(route.request().url())?.[1]);
    if (r.status === 200) { const c = lista.find((x) => x.id === id); if (c) c.active = body.activo; }
    return json(route, r.status, r.body);
  });
  await page.goto('/clients');
  await expect(filas(page)).toHaveCount(2);
  return { lista, patches, impactos: () => impactos, listados: () => listados };
}

const filas = (page: Page) => page.getByRole('table').locator('tbody tr');
const fila = (page: Page, nombre: string) => filas(page).filter({ hasText: nombre });
// HU #14105: el chip de estado va bajo el nombre, en la celda «Empresa».
const chip = (page: Page, nombre: string) => fila(page, nombre).locator('td').nth(0).getByText(/^(Activo|Inactivo)$/);
const kebab = (page: Page, nombre: string) => page.getByRole('button', { name: `Acciones de ${nombre}` });
const menu = (page: Page) => page.getByRole('menu');
const dialogo = (page: Page) => page.getByRole('dialog');

async function abrirOpcion(page: Page, nombre: string, opcion: string) {
  await kebab(page, nombre).click();
  await menu(page).getByRole('menuitem', { name: opcion }).click();
}

test.describe('HU #13949 · Clientes — menú ⋮ para desactivar y activar', () => {
  test('AC1 — activo con 3 SOAT y 2 trámites: frase del conteo, confirmar → Inactivo + «Cliente desactivado.»', async ({ page }) => {
    await loginAdmin(page);
    const { patches } = await montar(page);
    await kebab(page, 'Acme S.A.S.').click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Desactivar']);
    await menu(page).getByRole('menuitem', { name: 'Desactivar' }).click();
    await expect(dialogo(page)).toHaveAttribute('aria-label', 'Desactivar «Acme S.A.S.»');
    await expect(dialogo(page).getByText('Este cliente tiene 3 SOAT, 2 trámites en curso.')).toBeVisible();
    await expect(dialogo(page).getByText('Se cerrará la sesión de sus 4 usuarios.')).toBeVisible();
    await expect(dialogo(page).getByText('Mientras esté inactivo no recibirá SOAT, impuestos ni trámites nuevos.')).toBeVisible();
    // Foco inicial en Cancelar: Intro por inercia no desactiva.
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Cliente desactivado.')).toBeVisible();
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Inactivo');
    expect(patches).toEqual([{ activo: false, activoEsperado: true }]);
    await expect(page.getByText('Cargando compañías…')).toHaveCount(0);
  });

  test('AC2 — sin procesos: «No tiene procesos en curso.» y sin línea de usuarios', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { impacto: () => ({ status: 200, body: impacto({}) }) });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await expect(dialogo(page).getByText('No tiene procesos en curso.')).toBeVisible();
    await expect(dialogo(page).getByText(/Se cerrará la sesión/)).toHaveCount(0);
    await expect(dialogo(page).getByRole('button', { name: 'Desactivar' })).toBeEnabled();
  });

  test('singular — 1 impuesto, 1 trámite, 1 liquidación y 1 usuario', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { impacto: () => ({ status: 200, body: impacto({ impuestos: 1, tramites: 1, liquidaciones: 1 }, 1) }) });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await expect(dialogo(page).getByText('Este cliente tiene 1 impuesto, 1 trámite, 1 liquidación en curso.')).toBeVisible();
    await expect(dialogo(page).getByText('Se cerrará la sesión de su usuario.')).toBeVisible();
  });

  test('impacto caído — alerta + «Reintentar»; Desactivar no se habilita a ciegas', async ({ page }) => {
    await loginAdmin(page);
    let falla = true;
    const m = await montar(page, {
      impacto: () => (falla ? { status: 500, body: { error: 'boom interno' } } : { status: 200, body: impacto({ soat: 1 }) }),
    });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No pudimos revisar los procesos en curso de este cliente\./);
    await expect(dialogo(page).getByRole('button', { name: 'Desactivar' })).toBeDisabled();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    // Contador relativo: en dev, StrictMode dispara el efecto de montaje dos veces.
    const antes = m.impactos();
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(dialogo(page).getByText('Este cliente tiene 1 SOAT en curso.')).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Desactivar' })).toBeEnabled();
    expect(m.impactos()).toBe(antes + 1);
  });

  test('AC3 — inactivo: solo «Activar», sin /impacto; confirmar → Activo + «Cliente activado.»', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await kebab(page, 'Beta Ltda.').click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Activar']);
    await menu(page).getByRole('menuitem', { name: 'Activar' }).click();
    await expect(dialogo(page)).toHaveAttribute('aria-label', 'Activar «Beta Ltda.»');
    await expect(dialogo(page).getByText(/Vuelve a recibir SOAT, impuestos y trámites/)).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Activar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Activar' }).click();
    await expect(page.getByText('Cliente activado.')).toBeVisible();
    await expect(chip(page, 'Beta Ltda.')).toHaveText('Activo');
    expect(m.patches).toEqual([{ activo: true, activoEsperado: false }]);
    expect(m.impactos()).toBe(0);
  });

  test('AC4 — Cancelar, ✕ y Esc cierran sin PATCH ni toast', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await abrirOpcion(page, 'Beta Ltda.', 'Activar');
    await page.keyboard.press('Escape');
    await expect(dialogo(page)).toHaveCount(0);
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await dialogo(page).getByRole('button', { name: /Cerrar/ }).first().click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.patches).toEqual([]);
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Activo');
    await expect(chip(page, 'Beta Ltda.')).toHaveText('Inactivo');
    await expect(page.getByText(/Cliente (des)?activado\./)).toHaveCount(0);
  });

  test('AC5 — 409: toast «Otro administrador ya cambió su estado.» y la fila muestra el estado real', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page, { estado: () => ({ status: 409, body: { error: 'activoEsperado no coincide' } }) });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await expect(dialogo(page).getByText('Este cliente tiene 3 SOAT, 2 trámites en curso.')).toBeVisible();
    // Otro administrador lo desactivó mientras tanto: la recarga debe traer ese estado.
    m.lista[0].active = false;
    const antes = m.listados();
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Otro administrador ya cambió su estado.')).toBeVisible();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Inactivo');
    expect(m.listados()).toBeGreaterThan(antes);
    await expect(page.getByText('activoEsperado no coincide')).toHaveCount(0);
    await expect(page.getByText('Cargando compañías…')).toHaveCount(0);
  });

  test('AC6 — red caída al confirmar: alerta en el diálogo, botón «Reintentar» y el chip no cambia', async ({ page }) => {
    await loginAdmin(page);
    let caida = true;
    const m = await montar(page, { estado: () => (caida ? 'abort' : { status: 200, body: {} }) });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No pudimos conectar con FLITO\. Revise su conexión e inténtelo de nuevo\./);
    await expect(dialogo(page).getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Activo');
    caida = false;
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Cliente desactivado.')).toBeVisible();
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Inactivo');
    expect(m.patches).toHaveLength(2);
  });

  test('AC7 — 403: «No tiene permiso para esta acción.» y solo queda Cancelar', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { estado: () => ({ status: 403, body: { error: 'Forbidden: clients.clientes.estado' } }) });
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No tiene permiso para esta acción\./);
    await expect(dialogo(page).getByRole('button', { name: /^(Desactivar|Reintentar)$/ })).toHaveCount(0);
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeVisible();
    await expect(page.getByText('Forbidden: clients.clientes.estado')).toHaveCount(0);
    await expect(chip(page, 'Acme S.A.S.')).toHaveText('Activo');
  });

  test('AC8 — teclado: Enter/Espacio/flechas/Esc en el ⋮; el diálogo atrapa el foco y lo devuelve al ⋮', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    const boton = kebab(page, 'Acme S.A.S.');
    await expect(boton).toHaveAttribute('aria-haspopup', 'menu');
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await boton.focus();
    await page.keyboard.press('Enter');
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    const item = menu(page).getByRole('menuitem', { name: 'Desactivar' });
    await expect(item).toBeFocused();
    await page.keyboard.press('ArrowDown'); // circular: con una opción se queda en ella
    await expect(item).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(boton).toBeFocused();
    await page.keyboard.press('Space');
    await expect(item).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowUp');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialogo(page)).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expect(dialogo(page).getByRole('button', { name: 'Desactivar' })).toBeEnabled();
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Tab');
      const dentro = await dialogo(page).evaluate((d) => d.contains(document.activeElement));
      expect(dentro).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialogo(page)).toHaveCount(0);
    await expect(boton).toBeFocused();
  });

  test('clic fuera cierra el menú sin elegir', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await kebab(page, 'Acme S.A.S.').click();
    await expect(menu(page)).toBeVisible();
    await page.getByRole('heading', { name: 'Clientes y proveedores' }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect(dialogo(page)).toHaveCount(0);
  });

  test('la fila sale del filtro tras desactivar: el foco va a la pill marcada, no a <body>', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { impacto: () => ({ status: 200, body: impacto({}) }) });
    const pillActivos = page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: 'Activos', exact: true });
    await pillActivos.click();
    await expect(filas(page)).toHaveCount(1);
    await abrirOpcion(page, 'Acme S.A.S.', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Cliente desactivado.')).toBeVisible();
    await expect(pillActivos).toBeFocused();
  });

  test('sin «clients.clientes.estado» no hay ⋮', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: ['clients.clientes.ver'] });
    await montar(page);
    await expect(page.getByRole('button', { name: /^Acciones de / })).toHaveCount(0);
  });
});
