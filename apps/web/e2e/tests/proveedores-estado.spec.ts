// HU #13961 — Proveedores SOAT: estado, filtro, activar y desactivar en la pestaña Proveedores.
// Feature #13940. Reusa las piezas de Clientes (#13948 / #13949). API existente (#13958):
// `GET /api/flito/parametrizacion/proveedores-soat`, `GET …/:id/impacto` (`ImpactoProveedorSoat`) y
// `PATCH …/:id/estado` `{ activo, activoEsperado }`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER, funcionesDe } from '../helpers/auth';

const loginAdmin = (page: Page) =>
  loginAs(page, ADMIN_USER, { funciones: [...funcionesDe(ADMIN_USER), 'parametrizacion.proveedores.estado'] });

const UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const RE_LISTA = /\/api\/flito\/parametrizacion\/proveedores-soat$/;
const RE_IMPACTO = /\/api\/flito\/parametrizacion\/proveedores-soat\/([0-9a-f-]+)\/impacto$/;
const RE_ESTADO = /\/api\/flito\/parametrizacion\/proveedores-soat\/([0-9a-f-]+)\/estado$/;
const RE_UNO = /\/api\/flito\/parametrizacion\/proveedores-soat\/([0-9a-f-]+)$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const proveedor = (n: number, nombre: string, activo: boolean) => ({
  id: UUID(n), nombre, estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo,
});

/** Forma real de `ImpactoProveedorSoat` (flito-proveedores-estado.service.ts). */
const impacto = (soatEnCurso: number, companias: string[], usuarios = 0) => ({
  activo: true, soatEnCurso,
  companiasGestorPorDefecto: { cantidad: companias.length, nombres: companias },
  usuariosAfectados: usuarios, puedeEliminar: false, motivoNoEliminable: 'Primero debe desactivarlo.',
});

interface Montaje {
  lista?: ReturnType<typeof proveedor>[];
  impacto?: () => { status: number; body: unknown } | 'abort';
  estado?: () => { status: number; body: unknown } | 'abort';
  /** `true` → el listado responde 500. */
  listaFalla?: () => boolean;
}

const TRES_Y_UNO = () => [
  proveedor(1, 'Proveedor Uno', true), proveedor(2, 'Proveedor Dos', true),
  proveedor(3, 'Proveedor Tres', true), proveedor(4, 'Proveedor Cuatro', false),
];

/** La lista es MUTABLE: el PATCH simulado la cambia y la recarga silenciosa muestra el estado «real». */
async function montar(page: Page, m: Montaje = {}) {
  const lista = m.lista ?? TRES_Y_UNO();
  const patches: unknown[] = [];
  const ediciones: Record<string, unknown>[] = [];
  let listados = 0;
  await page.route(/\/api\/clients(\?|$)/, (route) => json(route, 200, []));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(RE_LISTA, (route) => {
    listados += 1;
    return m.listaFalla?.() ? json(route, 500, { error: 'boom interno' }) : json(route, 200, lista);
  });
  await page.route(RE_IMPACTO, (route) => {
    const r = m.impacto?.() ?? { status: 200, body: impacto(4, ['Acme S.A.S.', 'Beta Ltda.'], 2) };
    return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
  });
  await page.route(RE_ESTADO, (route) => {
    const body = route.request().postDataJSON() as { activo: boolean; activoEsperado: boolean };
    patches.push(body);
    const r = m.estado?.() ?? { status: 200, body: { id: 'x', activo: body.activo } };
    if (r === 'abort') return route.abort('failed');
    const id = RE_ESTADO.exec(route.request().url())?.[1];
    if (r.status === 200) { const p = lista.find((x) => x.id === id); if (p) p.activo = body.activo; }
    return json(route, r.status, r.body);
  });
  await page.route(RE_UNO, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    ediciones.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, 200, {});
  });
  await page.goto('/clients');
  await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
  return { lista, patches, ediciones, listados: () => listados };
}

const filas = (page: Page) => page.getByRole('table').locator('tbody tr');
const fila = (page: Page, nombre: string) => filas(page).filter({ hasText: nombre });
const chip = (page: Page, nombre: string) => fila(page, nombre).locator('td').nth(1);
const kebab = (page: Page, nombre: string) => page.getByRole('button', { name: `Acciones de ${nombre}` });
const menu = (page: Page) => page.getByRole('menu');
const dialogo = (page: Page) => page.getByRole('dialog');
const pill = (page: Page, nombre: string) =>
  page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: nombre, exact: true });

async function abrirOpcion(page: Page, nombre: string, opcion: string) {
  await kebab(page, nombre).click();
  await menu(page).getByRole('menuitem', { name: opcion }).click();
}

test.describe('HU #13961 · Proveedores SOAT — estado, filtro, activar y desactivar', () => {
  test('AC1 — 3 activos y 1 inactivo: filtro en Todos, columna Estado y «Mostrando 4 de 4»', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await expect(filas(page)).toHaveCount(4);
    await expect(pill(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('columnheader', { name: 'Estado' })).toBeVisible();
    await expect(chip(page, 'Proveedor Cuatro')).toHaveText('Inactivo');
    await expect(chip(page, 'Proveedor Uno')).toHaveText('Activo');
    await expect(page.getByText('Mostrando 4 de 4')).toBeVisible();
    await pill(page, 'Inactivos').click();
    await expect(filas(page)).toHaveCount(1);
    await expect(page.getByText('Mostrando 1 de 4')).toBeVisible();
  });

  test('AC2 — sin inactivos y filtro Inactivos: «No hay registros con este filtro»', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { lista: [proveedor(1, 'Proveedor Uno', true), proveedor(2, 'Proveedor Dos', true)] });
    await pill(page, 'Inactivos').click();
    await expect(page.getByText('No hay registros con este filtro')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('AC3 — 4 SOAT y 2 compañías: frase del impacto; confirmar → Inactivo + «Proveedor desactivado.»', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await kebab(page, 'Proveedor Uno').click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Desactivar']);
    await menu(page).getByRole('menuitem', { name: 'Desactivar' }).click();
    await expect(dialogo(page)).toHaveAttribute('aria-label', 'Desactivar «Proveedor Uno»');
    await expect(dialogo(page).getByText('4 SOAT en curso, proveedor de SOAT sin trámite de 2 compañías.', { exact: true })).toBeVisible();
    await expect(dialogo(page).getByText('Se cerrará la sesión de sus 2 usuarios.')).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Proveedor desactivado.')).toBeVisible();
    await expect(chip(page, 'Proveedor Uno')).toHaveText('Inactivo');
    expect(m.patches).toEqual([{ activo: false, activoEsperado: true }]);
  });

  test('AC3 — singular y vacío: «1 SOAT en curso, … de 1 compañía.» / «No tiene procesos en curso.»', async ({ page }) => {
    await loginAdmin(page);
    let cuerpo = impacto(1, ['Acme S.A.S.'], 1);
    await montar(page, { impacto: () => ({ status: 200, body: cuerpo }) });
    await abrirOpcion(page, 'Proveedor Uno', 'Desactivar');
    await expect(dialogo(page).getByText('1 SOAT en curso, proveedor de SOAT sin trámite de 1 compañía.', { exact: true })).toBeVisible();
    await expect(dialogo(page).getByText('Se cerrará la sesión de su usuario.')).toBeVisible();
    await page.keyboard.press('Escape');
    cuerpo = impacto(0, []);
    await abrirOpcion(page, 'Proveedor Dos', 'Desactivar');
    await expect(dialogo(page).getByText('No tiene procesos en curso.')).toBeVisible();
    await expect(dialogo(page).getByText(/Se cerrará la sesión/)).toHaveCount(0);
  });

  test('AC4 — inactivo: solo «Activar»; confirmar → Activo + «Proveedor activado.»', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await kebab(page, 'Proveedor Cuatro').click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Activar']);
    await menu(page).getByRole('menuitem', { name: 'Activar' }).click();
    await expect(dialogo(page).getByRole('button', { name: 'Activar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Activar' }).click();
    await expect(page.getByText('Proveedor activado.')).toBeVisible();
    await expect(chip(page, 'Proveedor Cuatro')).toHaveText('Activo');
    expect(m.patches).toEqual([{ activo: true, activoEsperado: false }]);
  });

  test('AC5 — editar: sin casilla «Activo» y el PATCH no envía `activo`', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await page.getByRole('button', { name: 'Editar Proveedor Uno' }).click();
    await expect(dialogo(page)).toBeVisible();
    await expect(dialogo(page).getByRole('checkbox')).toHaveCount(0);
    await expect(dialogo(page).getByText('Activo', { exact: true })).toHaveCount(0);
    await dialogo(page).getByRole('button', { name: 'Guardar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.ediciones).toHaveLength(1);
    expect(m.ediciones[0]).not.toHaveProperty('activo');
  });

  test('AC6 — solo «Ver clientes y proveedores»: estado y filtro sí, menú ⋮ no', async ({ page }) => {
    // «Ver clientes y proveedores» con su opcional `listar`: sin él, GET /proveedores-soat responde 403.
    await loginAs(page, FINANCIERA_USER, { funciones: ['clients.clientes.ver', 'parametrizacion.proveedores.listar'] });
    await montar(page);
    await expect(filas(page)).toHaveCount(4);
    await expect(page.getByRole('columnheader', { name: 'Estado' })).toBeVisible();
    await expect(pill(page, 'Todos')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Acciones de / })).toHaveCount(0);
  });

  test('AC7 — 409: «Otro administrador ya cambió su estado.» y la recarga trae el estado real', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page, { estado: () => ({ status: 409, body: { error: 'Otro administrador ya cambió su estado' } }) });
    await abrirOpcion(page, 'Proveedor Uno', 'Desactivar');
    await expect(dialogo(page).getByText(/4 SOAT en curso/)).toBeVisible();
    m.lista[0].activo = false;
    const antes = m.listados();
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Otro administrador ya cambió su estado.')).toBeVisible();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(chip(page, 'Proveedor Uno')).toHaveText('Inactivo');
    expect(m.listados()).toBeGreaterThan(antes);
  });

  test('AC7 — red caída: alerta con «Reintentar» y el chip no cambia', async ({ page }) => {
    await loginAdmin(page);
    let caida = true;
    const m = await montar(page, { estado: () => (caida ? 'abort' : { status: 200, body: {} }) });
    await abrirOpcion(page, 'Proveedor Uno', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No pudimos conectar con FLITO\./);
    await expect(chip(page, 'Proveedor Uno')).toHaveText('Activo');
    caida = false;
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Proveedor desactivado.')).toBeVisible();
    expect(m.patches).toHaveLength(2);
  });

  test('AC7 — 403: «No tiene permiso para esta acción.» y solo queda Cancelar', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { estado: () => ({ status: 403, body: { error: 'Forbidden: parametrizacion.proveedores.estado' } }) });
    await abrirOpcion(page, 'Proveedor Uno', 'Desactivar');
    await dialogo(page).getByRole('button', { name: 'Desactivar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No tiene permiso para esta acción\./);
    await expect(dialogo(page).getByRole('button', { name: /^(Desactivar|Reintentar)$/ })).toHaveCount(0);
    await expect(page.getByText('Forbidden: parametrizacion.proveedores.estado')).toHaveCount(0);
  });

  test('AC8 — teclado: Enter abre el ⋮, Esc lo cierra, el diálogo atrapa el foco y lo devuelve al ⋮', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    const boton = kebab(page, 'Proveedor Uno');
    await expect(boton).toHaveAttribute('aria-haspopup', 'menu');
    await boton.focus();
    await page.keyboard.press('Enter');
    const item = menu(page).getByRole('menuitem', { name: 'Desactivar' });
    await expect(item).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(boton).toBeFocused();
    await page.keyboard.press('Space');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expect(dialogo(page).getByRole('button', { name: 'Desactivar' })).toBeEnabled();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialogo(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialogo(page)).toHaveCount(0);
    await expect(boton).toBeFocused();
  });

  test('error de carga: aviso sin texto crudo y «Reintentar» recupera la lista', async ({ page }) => {
    await loginAdmin(page);
    let falla = true;
    const m = await montar(page, { listaFalla: () => falla });
    await expect(page.getByRole('alert')).toHaveText('No pudimos cargar los proveedores.');
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(filas(page)).toHaveCount(4);
    expect(m.listados()).toBeGreaterThan(0);
  });
});
