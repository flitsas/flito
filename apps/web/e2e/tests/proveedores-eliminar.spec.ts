// HU #13962 — Proveedores SOAT: eliminar desde el menú ⋮ y nombre duplicado bajo el campo Nombre.
// Feature #13940. Gemelo de `clientes-eliminar.spec.ts` (#13956). API existente:
// `GET …/proveedores-soat/:id/impacto` (`puedeEliminar` / `motivoNoEliminable`, RN-PROV-6, #13960),
// `DELETE …/proveedores-soat/:id` (#13960) y el 409 de nombre duplicado en POST/PATCH (#13957).
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, funcionesDe } from '../helpers/auth';

const ESTADO = 'parametrizacion.proveedores.estado';
const ELIMINAR = 'parametrizacion.proveedores.eliminar';
const loginAdmin = (page: Page) =>
  loginAs(page, ADMIN_USER, { funciones: [...funcionesDe(ADMIN_USER), ESTADO, ELIMINAR] });
const sinEliminar = (page: Page) =>
  loginAs(page, ADMIN_USER, { funciones: [...funcionesDe(ADMIN_USER).filter((f) => f !== ELIMINAR), ESTADO] });

const UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const RE_LISTA = /\/api\/flito\/parametrizacion\/proveedores-soat$/;
const RE_IMPACTO = /\/api\/flito\/parametrizacion\/proveedores-soat\/([0-9a-f-]+)\/impacto$/;
const RE_UNO = /\/api\/flito\/parametrizacion\/proveedores-soat\/([0-9a-f-]+)$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const proveedor = (n: number, nombre: string, activo: boolean) => ({
  id: UUID(n), nombre, estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo,
});

/** Forma real de `ImpactoProveedorSoat` (flito-proveedores-estado.service.ts). */
const impacto = (activo: boolean, soatEnCurso: number, companias: string[], motivo: string | null) => ({
  activo, soatEnCurso,
  companiasGestorPorDefecto: { cantidad: companias.length, nombres: companias },
  usuariosAfectados: 0, puedeEliminar: motivo === null, motivoNoEliminable: motivo,
});

const DUPLICADO = 'Ya existe un proveedor SOAT con el nombre Seguros Andinos.';
type Respuesta = { status: number; body: unknown } | 'abort';

interface Montaje {
  impacto?: (n: number) => Respuesta | undefined;
  eliminar?: () => Respuesta;
  crear?: () => Respuesta;
  editar?: () => Respuesta;
}

/**
 * 1 Seguros Andinos (activo) · 2 Con SOAT (inactivo, 4 SOAT) · 3 Sin trámite (inactivo, 2 compañías) ·
 * 4 Eliminable (inactivo). La lista es MUTABLE: el DELETE simulado la cambia y la recarga lo confirma.
 */
async function montar(page: Page, m: Montaje = {}) {
  const lista = [
    proveedor(1, 'Seguros Andinos', true), proveedor(2, 'Con SOAT', false),
    proveedor(3, 'Sin Tramite', false), proveedor(4, 'Eliminable', false),
  ];
  const porDefecto: Record<number, ReturnType<typeof impacto>> = {
    1: impacto(true, 0, [], 'Primero debe desactivarlo.'),
    2: impacto(false, 4, [], 'Tiene 4 SOAT en curso.'),
    3: impacto(false, 0, ['Alfa', 'Beta'], 'Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta).'),
    4: impacto(false, 0, [], null),
  };
  const deletes: string[] = [];
  const impactos: string[] = [];
  const envios: Record<string, unknown>[] = [];
  let listados = 0;
  await page.route(/\/api\/clients(\?|$)/, (route) => json(route, 200, []));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(RE_LISTA, (route) => {
    if (route.request().method() === 'POST') {
      envios.push(route.request().postDataJSON() as Record<string, unknown>);
      const r = m.crear?.() ?? { status: 201, body: proveedor(9, 'Nuevo', true) };
      return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
    }
    listados += 1;
    return json(route, 200, lista);
  });
  await page.route(RE_IMPACTO, (route) => {
    const id = RE_IMPACTO.exec(route.request().url())?.[1] ?? '';
    impactos.push(id);
    const n = Number(id.slice(-1));
    const r = m.impacto?.(n) ?? { status: 200, body: porDefecto[n] };
    return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
  });
  await page.route(RE_UNO, (route) => {
    const metodo = route.request().method();
    const id = RE_UNO.exec(route.request().url())?.[1] ?? '';
    if (metodo === 'PATCH') {
      envios.push(route.request().postDataJSON() as Record<string, unknown>);
      const r = m.editar?.() ?? { status: 200, body: {} };
      return r === 'abort' ? route.abort('failed') : json(route, r.status, r.body);
    }
    if (metodo !== 'DELETE') return route.fallback();
    deletes.push(id);
    const r = m.eliminar?.() ?? { status: 200, body: { id, eliminado: true } };
    if (r === 'abort') return route.abort('failed');
    if (r.status === 200) { const i = lista.findIndex((x) => x.id === id); if (i >= 0) lista.splice(i, 1); }
    return json(route, r.status, r.body);
  });
  await page.goto('/clients');
  await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
  await expect(filas(page)).toHaveCount(4);
  return { lista, deletes, impactos, envios, listados: () => listados };
}

const filas = (page: Page) => page.getByRole('table').locator('tbody tr');
const fila = (page: Page, nombre: string) => filas(page).filter({ hasText: nombre });
const kebab = (page: Page, nombre: string) => page.getByRole('button', { name: `Acciones de ${nombre}` });
const menu = (page: Page) => page.getByRole('menu');
const opcionEliminar = (page: Page) => menu(page).getByRole('menuitem', { name: 'Eliminar', exact: true });
const dialogo = (page: Page) => page.getByRole('dialog');

async function abrirDialogo(page: Page, nombre = 'Eliminable') {
  await kebab(page, nombre).click();
  await expect(opcionEliminar(page)).not.toHaveAttribute('aria-disabled', 'true');
  await opcionEliminar(page).click();
  await expect(dialogo(page)).toHaveAttribute('aria-label', `Eliminar «${nombre}»`);
}

test.describe('HU #13962 · Proveedores SOAT — eliminar y nombre duplicado', () => {
  test('AC1 — activo: «Eliminar» deshabilitada con «Primero debe desactivarlo.» sin pedir impacto', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await kebab(page, 'Seguros Andinos').click();
    await expect(menu(page).getByRole('menuitem')).toHaveCount(2);
    await expect(menu(page).getByRole('menuitem', { name: 'Desactivar' })).toBeVisible();
    const op = opcionEliminar(page);
    await expect(op).toHaveAttribute('aria-disabled', 'true');
    await expect(op).toHaveAccessibleDescription('Primero debe desactivarlo.');
    await op.click({ force: true });
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.impactos).toEqual([]);
    expect(m.deletes).toEqual([]);
  });

  test('AC1 — con SOAT en curso: «Tiene 4 SOAT en curso.»', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await kebab(page, 'Con SOAT').click();
    await expect(opcionEliminar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(opcionEliminar(page)).toHaveAccessibleDescription('Tiene 4 SOAT en curso.');
  });

  test('AC1 — proveedor de SOAT sin trámite: nombra las compañías; teclado llega al motivo', async ({ page }) => {
    await loginAdmin(page);
    await montar(page);
    await kebab(page, 'Sin Tramite').focus();
    await page.keyboard.press('Enter');
    await expect(menu(page).getByRole('menuitem', { name: 'Activar' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const op = opcionEliminar(page);
    await expect(op).toBeFocused();
    await expect(op).toHaveAccessibleDescription('Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta).');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(dialogo(page)).toHaveCount(0);
  });

  test('AC2 — eliminable: consecuencia en el diálogo; confirmar → «Proveedor eliminado.» y sale del listado', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page);
    await abrirDialogo(page);
    await expect(dialogo(page).getByText('Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.')).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Proveedor eliminado.')).toBeVisible();
    await expect(fila(page, 'Eliminable')).toHaveCount(0);
    await expect(filas(page)).toHaveCount(3);
    expect(m.deletes).toEqual([UUID(4)]);
  });

  test('AC3 — crear con nombre existente: error bajo Nombre (aria-describedby, foco) y conserva los datos', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page, { crear: () => ({ status: 409, body: { error: DUPLICADO } }) });
    await page.getByRole('button', { name: /Nuevo proveedor/ }).click();
    const nombre = dialogo(page).getByLabel('Nombre *');
    await nombre.fill('Seguros Andinos');
    await dialogo(page).getByLabel('Estrategia').fill('correo');
    await dialogo(page).getByRole('button', { name: 'Guardar' }).click();
    await expect(dialogo(page)).toBeVisible();
    await expect(nombre).toHaveAttribute('aria-invalid', 'true');
    await expect(nombre).toHaveAccessibleDescription(DUPLICADO);
    await expect(nombre).toBeFocused();
    await expect(nombre).toHaveValue('Seguros Andinos');
    await expect(dialogo(page).getByLabel('Estrategia')).toHaveValue('correo');
    expect(m.envios).toHaveLength(1);
    // Al cambiar el nombre el error se retira.
    await nombre.fill('Seguros Andinos 2');
    await expect(nombre).not.toHaveAttribute('aria-invalid', 'true');
    await expect(dialogo(page).getByText(DUPLICADO)).toHaveCount(0);
  });

  test('AC3 — renombrar a un nombre existente: mismo error bajo Nombre y el formulario sigue abierto', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { editar: () => ({ status: 409, body: { error: DUPLICADO } }) });
    await page.getByRole('button', { name: 'Editar Eliminable' }).click();
    const nombre = dialogo(page).getByLabel('Nombre *');
    await nombre.fill('Seguros Andinos');
    await dialogo(page).getByRole('button', { name: 'Guardar' }).click();
    await expect(nombre).toHaveAccessibleDescription(DUPLICADO);
    await expect(nombre).toHaveValue('Seguros Andinos');
  });

  test('guardar con otro fallo: frase propia, nunca el texto crudo del API', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { editar: () => ({ status: 500, body: { error: 'boom interno' } }) });
    await page.getByRole('button', { name: 'Editar Eliminable' }).click();
    await dialogo(page).getByRole('button', { name: 'Guardar' }).click();
    await expect(dialogo(page).getByText('No pudimos guardar el proveedor. Inténtelo de nuevo.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
  });

  test('AC4 — 409 de concurrencia: toast y recarga', async ({ page }) => {
    await loginAdmin(page);
    const m = await montar(page, { eliminar: () => ({ status: 409, body: { error: 'Otro administrador ya cambió su estado' } }) });
    await abrirDialogo(page);
    const antes = m.listados();
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Otro administrador ya cambió su estado.')).toBeVisible();
    await expect.poll(m.listados).toBeGreaterThan(antes);
    await expect(fila(page, 'Eliminable')).toHaveCount(1);
  });

  test('AC4 — red caída: alerta con «Reintentar» en el diálogo; reintentar elimina', async ({ page }) => {
    await loginAdmin(page);
    let falla = true;
    const m = await montar(page, { eliminar: () => (falla ? 'abort' : { status: 200, body: { eliminado: true } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No pudimos conectar con FLITO/);
    await expect(fila(page, 'Eliminable')).toHaveCount(1);
    falla = false;
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Proveedor eliminado.')).toBeVisible();
    expect(m.deletes).toEqual([UUID(4), UUID(4)]);
  });

  test('AC4 — 5xx: alerta con «Reintentar» sin texto crudo', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 500, body: { error: 'boom interno' } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toBeVisible();
    await expect(dialogo(page).getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
  });

  test('AC4 — 403: «No tiene permiso para esta acción.», solo Cancelar y la fila sigue', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 403, body: { error: `Forbidden: ${ELIMINAR}` } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/No tiene permiso para esta acción\./);
    await expect(dialogo(page).getByRole('button', { name: /^(Eliminar|Reintentar)$/ })).toHaveCount(0);
    await expect(page.getByText(/Forbidden/)).toHaveCount(0);
    await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(fila(page, 'Eliminable')).toHaveCount(1);
  });

  test('409 de no-eliminable al confirmar: el motivo de producto en el diálogo, sin reintento', async ({ page }) => {
    await loginAdmin(page);
    await montar(page, { eliminar: () => ({ status: 409, body: { error: 'Tiene 1 SOAT en curso.' } }) });
    await abrirDialogo(page);
    await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
    await expect(dialogo(page).getByRole('alert')).toHaveText(/Tiene 1 SOAT en curso\./);
    await expect(dialogo(page).getByRole('button', { name: /^(Eliminar|Reintentar)$/ })).toHaveCount(0);
  });

  test('visibilidad — sin `parametrizacion.proveedores.eliminar` no hay «Eliminar»', async ({ page }) => {
    await sinEliminar(page);
    const m = await montar(page);
    await kebab(page, 'Eliminable').click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Activar']);
    await expect(opcionEliminar(page)).toHaveCount(0);
    expect(m.impactos).toEqual([]);
  });
});
