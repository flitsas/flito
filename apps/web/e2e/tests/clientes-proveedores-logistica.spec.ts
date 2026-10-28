// HU #14105 (Feature #14089) — Clientes y proveedores: proveedor SOAT | Logística y proveedor por compañía.
// Diseño: `docs/ux/proveedores-logistica-formulario-14105-slim.md` + mockup aprobado.
// Todo con la API mockeada: el contrato real es `proveedores-logistica` y `PATCH /companias/:id` (HU #14103/#14104).
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, ADMIN_USER, AUDITOR_USER } from '../helpers/auth';

const CON_PROVEEDORES = { funciones: [...funcionesDe(ADMIN_USER), 'parametrizacion.proveedores.estado', 'parametrizacion.proveedores.crear'] };

const LOG_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const LOG_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const SOAT_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const base = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, document: `9001${id}`, documentType: 'NIT', phone: '3000000000', email: null, address: null, city: 'Medellín',
  active: true, soatAutogestionable: false, impuestosAutogestionable: true, logisticaAutogestionable: false,
  gestorSoatSinTramite: null, ...extra,
});
const CLIENTES = [
  base(1, 'Compañía Ejemplo 1'), // logística encendida con proveedor
  base(2, 'Compañía Ejemplo 2'), // encendida SIN proveedor
  base(3, 'Compañía Ejemplo 3', { logisticaAutogestionable: true }), // apagada, conserva proveedor
  base(4, 'Compañía Ejemplo 4', { gestorSoatSinTramite: { id: SOAT_1, nombre: 'SURA', activo: true } }), // encendida sin proveedor
  base(5, 'Compañía Ejemplo 5', { logisticaAutogestionable: true }), // autogestiona y sin proveedor: NO es «sin proveedor»
];
const asig = (c: ReturnType<typeof base>, prov: string | null) => ({
  id: c.id, nombre: c.name, activo: true, logisticaAutogestionable: c.logisticaAutogestionable,
  proveedorLogisticaId: prov, proveedorSoatSinTramiteId: null,
});
const COMPANIAS = [asig(CLIENTES[0]!, LOG_A), asig(CLIENTES[1]!, null), asig(CLIENTES[2]!, LOG_A), asig(CLIENTES[3]!, null), asig(CLIENTES[4]!, null)];

const PROV_LOG = [
  { id: LOG_A, nombre: 'Logística Andina S.A.S.', nit: '900123456-7', contacto: 'Ana Gómez', telefono: '3001112233', activo: true },
  { id: LOG_B, nombre: 'Rutas del Norte', nit: '800555111', contacto: null, telefono: null, activo: true },
];
const PROV_SOAT = [{ id: SOAT_1, nombre: 'SURA', estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24, activo: true }];

interface Opc { logistica?: 'ok' | 'error' | 'vacio'; companias?: unknown[]; proveedoresStatus?: number; patchEstado?: { status: number; cuerpo: unknown } }

async function montar(page: Page, ruta: string, o: Opc = {}) {
  const posts: Record<string, unknown>[] = [];
  const patchesCompania: Record<string, unknown>[] = [];
  const patchesEstado: string[] = [];
  await page.route(/\/api\/clients(\?|$)/, (r) => json(r, 200, CLIENTES));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (r) => json(r, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/companias$/, (r) => json(r, 200, o.companias ?? COMPANIAS));
  await page.route(/\/api\/flito\/parametrizacion\/companias\/\d+$/, (r) => {
    patchesCompania.push(r.request().postDataJSON() as Record<string, unknown>);
    return json(r, 200, { id: 1 });
  });
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => json(r, 200, PROV_SOAT));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-logistica$/, (r) => {
    if (r.request().method() === 'POST') {
      posts.push(r.request().postDataJSON() as Record<string, unknown>);
      return json(r, 201, { id: 'nuevo', nombre: 'x', activo: true });
    }
    if (o.logistica === 'error') return json(r, 500, { error: 'caído' });
    return json(r, 200, o.logistica === 'vacio' ? [] : PROV_LOG);
  });
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-logistica\/[^/]+\/estado$/, (r) => {
    patchesEstado.push(r.request().url());
    const p = o.patchEstado ?? { status: 200, cuerpo: {} };
    return json(r, p.status, p.cuerpo);
  });
  await page.goto(ruta);
  return { posts, patchesCompania, patchesEstado };
}

const irAProveedores = async (page: Page) => { await page.getByRole('button', { name: 'Proveedores', exact: true }).click(); };

test.describe('HU #14105 · AC1 — alta de proveedor con selector de tipo', () => {
  test('Logística pide nombre y NIT, valida el NIT y envía solo sus campos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const { posts } = await montar(page, '/clients');
    await irAProveedores(page);
    await page.getByRole('button', { name: 'Nuevo proveedor' }).click();
    const modal = page.getByRole('dialog', { name: 'Nuevo proveedor' });
    await expect(modal.getByRole('button', { name: 'SOAT', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await modal.getByRole('button', { name: 'Logística', exact: true }).click();
    await expect(modal.getByText('Presta el servicio de logística a las compañías que lo tengan asignado.')).toBeVisible();
    await expect(modal.getByLabel(/Estrategia/)).toHaveCount(0);
    await expect(modal.getByLabel('Contacto (opcional)')).toBeVisible();
    await expect(modal.getByLabel('Teléfono (opcional)')).toBeVisible();
    await expect(modal.getByRole('switch', { name: 'Activo' })).toHaveAttribute('aria-checked', 'true');

    await modal.getByLabel('Nombre *').fill('Mensajería Sur');
    await modal.getByLabel('NIT *').fill('1234');
    await modal.getByRole('button', { name: 'Crear proveedor' }).click();
    await expect(modal.getByText(/Escriba el NIT solo con números/)).toBeVisible();
    expect(posts).toHaveLength(0);

    await modal.getByLabel('NIT *').fill('900.123.456-7');
    await modal.getByRole('button', { name: 'Crear proveedor' }).click();
    await expect(modal).toBeHidden();
    expect(posts).toEqual([{ nombre: 'Mensajería Sur', nit: '900123456-7', contacto: null, telefono: null }]);
    await expect(page.getByText('Proveedor creado.')).toBeVisible();
  });

  test('cambiar de tipo limpia los campos del otro tipo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients');
    await irAProveedores(page);
    await page.getByRole('button', { name: 'Nuevo proveedor' }).click();
    const modal = page.getByRole('dialog', { name: 'Nuevo proveedor' });
    await modal.getByLabel('Estrategia').fill('portal');
    await modal.getByRole('button', { name: 'Logística', exact: true }).click();
    await modal.getByRole('button', { name: 'SOAT', exact: true }).click();
    await expect(modal.getByLabel('Estrategia')).toHaveValue('');
  });
});

test.describe('HU #14105 · AC2 — lista con columnas comunes', () => {
  test('Nombre, Tipo, NIT, Contacto y teléfono, Compañías asignadas y Estado; sin Estrategia/Umbral/ANS', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients');
    await irAProveedores(page);
    const tabla = page.getByRole('table');
    for (const h of ['Nombre', 'Tipo', 'NIT', 'Contacto y teléfono', 'Compañías asignadas', 'Estado']) {
      await expect(tabla.getByRole('columnheader', { name: h })).toBeVisible();
    }
    await expect(tabla.getByRole('columnheader', { name: /Umbral|ANS|Estrategia/ })).toHaveCount(0);
    const fila = tabla.getByRole('row', { name: /Logística Andina/ });
    await expect(fila).toContainText('900123456-7');
    await expect(fila).toContainText('Ana Gómez · 3001112233');
    await expect(fila.getByRole('cell').nth(4)).toHaveText('2');
    await fila.getByRole('button', { name: 'Ver detalle de Logística Andina S.A.S.' }).click();
    await expect(page.getByRole('dialog', { name: /Detalle de Logística Andina/ })).toBeVisible();
    await expect(page.getByText(/Asignado a 2 compañías/)).toBeVisible();
  });

  test('sin la función de edición solo hay «Ver detalle»', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await montar(page, '/clients');
    await irAProveedores(page);
    await expect(page.getByRole('button', { name: 'Nuevo proveedor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Editar / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ver detalle de Rutas del Norte/ })).toBeVisible();
  });
});

test.describe('HU #14105 · AC3/AC4 — Clientes: servicios y compañías sin proveedor', () => {
  test('una columna Servicios con un chip por servicio, y el chip «Sin proveedor» marcado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients');
    const tabla = page.getByRole('table');
    for (const h of ['Empresa', 'Documento', 'Servicios', 'Facturación']) await expect(tabla.getByRole('columnheader', { name: h })).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: /Ciudad|Teléfono|Email|SOAT|Impuestos|Logística/ })).toHaveCount(0);
    const f1 = tabla.getByRole('row', { name: /Compañía Ejemplo 1/ });
    await expect(f1).toContainText('SOAT · FLITO gestiona');
    await expect(f1).toContainText('Impuestos · Autogestiona');
    await expect(f1).toContainText('Logística · Proveedor: Logística Andina S.A.S.');
    await expect(tabla.getByRole('row', { name: /Compañía Ejemplo 2/ })).toContainText('Logística · Sin proveedor');
    await expect(tabla.getByRole('row', { name: /Compañía Ejemplo 3/ })).toContainText('Logística · Autogestiona');
  });

  test('filtro «Sin proveedor (2)» y aviso de página; sin la función de edición el aviso no trae «Ver compañías»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients');
    const aviso = page.getByRole('status').filter({ hasText: 'no tienen proveedor asignado' });
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 5/ })).toContainText('Logística · Autogestiona');
    await expect(aviso).toContainText('2 compañías con logística no tienen proveedor asignado. Asígneles uno para que puedan registrar viajes.');
    await page.getByRole('button', { name: 'Sin proveedor (2)' }).click();
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 1/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 2/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 4/ })).toBeVisible();
    // Una compañía que autogestiona su logística y no tiene proveedor no cuenta ni se lista.
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 5/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 3/ })).toHaveCount(0);
  });

  test('auditor ve el chip, el filtro y el aviso, pero no «Ver compañías» ni abre la edición desde el chip', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await montar(page, '/clients');
    await expect(page.getByRole('status').filter({ hasText: 'no tienen proveedor asignado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver compañías' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Logística de .*sin proveedor/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sin proveedor (2)' })).toBeVisible();
  });

  test('asignar proveedor desde el chip: selector obligatorio y PATCH con proveedorLogisticaId', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const { patchesCompania } = await montar(page, '/clients');
    await page.getByRole('button', { name: 'Logística de Compañía Ejemplo 2: sin proveedor. Elegir proveedor' }).click();
    const modal = page.getByRole('dialog', { name: 'Editar · Compañía Ejemplo 2' });
    await expect(modal.getByRole('button', { name: 'Datos y servicios' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Datos fiscales' })).toBeVisible();
    await expect(modal.getByText('Elija el proveedor que atenderá los viajes de esta compañía.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    await expect(modal.getByLabel(/Parcial/)).toHaveCount(0);
    await modal.getByLabel(/Proveedor de logística/).selectOption(LOG_B);
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(modal).toBeHidden();
    expect(patchesCompania).toEqual([{ proveedorLogisticaId: LOG_B }]);
    await expect(page.getByText('Proveedor asignado a Compañía Ejemplo 2.')).toBeVisible();
  });

  test('apagar logística conserva el proveedor en solo lectura y envía solo el interruptor', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const { patchesCompania } = await montar(page, '/clients');
    await page.getByRole('button', { name: 'Editar Compañía Ejemplo 1' }).click();
    const modal = page.getByRole('dialog', { name: 'Editar · Compañía Ejemplo 1' });
    await modal.getByRole('switch', { name: 'FLITO gestiona Logística de Compañía Ejemplo 1' }).click();
    await expect(modal.getByText(/Proveedor conservado:/)).toContainText('Logística Andina S.A.S.');
    await expect(modal.getByText(/no se puede inactivar/)).toBeVisible();
    await expect(modal.getByLabel(/Proveedor de logística/)).toHaveCount(0);
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();
    expect(patchesCompania).toEqual([{ logisticaAutogestionable: true }]);
  });

  test('«Proveedor de SOAT sin trámite» solo con su función', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients');
    await page.getByRole('button', { name: 'Editar Compañía Ejemplo 4' }).click();
    await expect(page.getByRole('dialog').getByLabel('Proveedor de SOAT sin trámite')).toBeVisible();
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 4/ })).toContainText('Proveedor SOAT sin trámite: SURA');
  });

  test('sin la función de SOAT sin trámite no aparece ni selector ni parte del chip', async ({ page }) => {
    await loginAs(page, { ...ADMIN_USER, funciones: ['clients.clientes.ver', 'parametrizacion.companias.listar', 'parametrizacion.companias.autogestion', 'tramites.autogestion.desbloquear'] } as typeof ADMIN_USER);
    await montar(page, '/clients');
    await expect(page.getByRole('row', { name: /Compañía Ejemplo 4/ })).not.toContainText('sin trámite');
    await page.getByRole('button', { name: 'Editar Compañía Ejemplo 4' }).click();
    await expect(page.getByRole('dialog').getByLabel('Proveedor de SOAT sin trámite')).toHaveCount(0);
  });
});

test.describe('HU #14105 · AC5 — no se inactiva un proveedor asignado', () => {
  test('el diálogo de bloqueo dice cuántas compañías y sus nombres, sin confirmar', async ({ page }) => {
    await loginAs(page, ADMIN_USER, CON_PROVEEDORES);
    const { patchesEstado } = await montar(page, '/clients');
    await irAProveedores(page);
    await page.getByRole('button', { name: 'Acciones de Logística Andina S.A.S.' }).click();
    await page.getByRole('menuitem', { name: 'Desactivar' }).click();
    const d = page.getByRole('dialog', { name: 'No se puede inactivar' });
    await expect(d).toContainText('No se puede inactivar a Logística Andina S.A.S.: está asignado a 2 compañías (Compañía Ejemplo 1, Compañía Ejemplo 3).');
    await expect(d.getByRole('button', { name: 'Entendido' })).toBeVisible();
    await d.getByRole('button', { name: 'Entendido' }).click();
    expect(patchesEstado).toHaveLength(0);
  });
});

test.describe('HU #14105 · AC6 — 4 estados del selector y de la lista', () => {
  test('error de proveedores de logística: mensaje y reintento, guardar no bloquea otros servicios', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await montar(page, '/clients', { logistica: 'error' });
    await page.getByRole('button', { name: 'Editar Compañía Ejemplo 1' }).click();
    const modal = page.getByRole('dialog', { name: 'Editar · Compañía Ejemplo 1' });
    await expect(modal.getByText('No pudimos cargar los proveedores de logística.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Volver a cargar' }).last()).toBeVisible();
  });

  test('sin proveedores de logística activos: vacío con siguiente paso', async ({ page }) => {
    await loginAs(page, ADMIN_USER, CON_PROVEEDORES);
    await montar(page, '/clients', { logistica: 'vacio', companias: [] });
    await page.getByRole('button', { name: 'Editar Compañía Ejemplo 2' }).click();
    await expect(page.getByRole('dialog').getByText(/No hay proveedores de logística activos\. Cree uno en la pestaña Proveedores\./)).toBeVisible();
  });
});
