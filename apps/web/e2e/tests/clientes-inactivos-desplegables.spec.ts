// HU #13950 (Feature #13939) — los clientes inactivos se ven en los desplegables de compañía pero no
// se eligen; los eliminados no salen; lo ya asignado se conserva. Backend mockeado.
//
// Pantallas: usuarios (rol Cliente, `GET /flito/parametrizacion/companias` → `activo`) y tarifas
// (`GET /clients` → `active`; lista lateral en `lg`, `<select>` por debajo). La regla vive en
// `components/flit/opcionesConEstado.ts`; aquí se mide en la pantalla.
//
// Lo que hace que los asertos midan algo:
//   · AC1 se afirma con `toBeDisabled()` Y con el texto «(Inactivo)»: el gris solo no basta (AC4) y
//     el texto solo no bloquea nada.
//   · AC3 se mide con el VALOR del `<select>` y con el PATCH: si el inactivo asignado se filtrara o
//     se deshabilitara, el campo se vaciaría y el guardado mandaría la compañía por delante.
//   · AC2 depende del API (#13953 ya no devuelve eliminados): la pantalla no reinyecta nada que no
//     venga, salvo el valor ASIGNADO, que se mide aparte.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, OPERACIONES_USER, FINANCIERA_USER } from '../helpers/auth';
import { arbolRol, arbolUsuario, codigosDe, elemento, item, type NodoDef } from '../helpers/arbolPermisos';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
type Fila = Record<string, unknown>;

// ───────────────────────────────────── Usuarios ──────────────────────────────────────────────────

/** `GET /flito/parametrizacion/companias`: vigentes, activas E inactivas. «Borrada S.A.» (eliminada) no viene. */
const COMPANIAS = [
  { id: 1, nombre: 'Andina Activa', nit: '900001', activo: true },
  { id: 2, nombre: 'Coomotor Inactiva', nit: '900002', activo: false },
  { id: 3, nombre: 'Logística Norte', nit: '900003', activo: true },
];

function usuario(over: Fila): Fila {
  return {
    id: 2, username: 'u', name: 'Usuario', email: null, role: 'admin', active: true,
    allowedPages: [], funciones: [], transitoCodigo: null, companiaId: null,
    flitoProveedorSoatId: null, organismosCodigos: [],
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

const rol = (codigo: string, nombre: string, tipoEnlace = 'ninguno'): Fila => ({
  codigo, nombre, descripcion: null, tipoEnlace, esSistema: true, activo: true, usuarios: 0, borrable: false,
  motivoNoBorrable: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const ROLES = [rol('admin', 'Administrador'), rol('cliente', 'Cliente', 'compania')];
const ARBOL: NodoDef[] = [elemento('general', 'General', [item('dashboard', 'Entrar al tablero')])];
const CUADRO = new Set(codigosDe(ARBOL));

async function mockUsuarios(page: Page, filas: Fila[]) {
  const patches: Fila[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/companias$/, (r) => r.fulfill(json(COMPANIAS)));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/parametrizacion\/organismos$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  await page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  await page.route(/\/api\/permisos\/roles\/[^/]+\/funciones$/, (r) => r.fulfill(json({ codigo: 'x', funciones: [] })));
  await page.route(/\/api\/permisos\/roles\/[^/]+\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    const enlace = ROLES.find((x) => x.codigo === codigo)?.tipoEnlace ?? 'ninguno';
    return r.fulfill(json({ rol: { codigo, nombre: codigo, tipoEnlace: enlace }, arbol: arbolRol(ARBOL, CUADRO), transversales: [] }));
  });
  await page.route(/\/api\/users\/(\d+)\/arbol$/, (r) =>
    r.fulfill(json({ userId: 5, rol: 'x', arbol: arbolUsuario(ARBOL, CUADRO, new Map()), transversales: [] })));
  await page.route(/\/api\/users$/, (r) => r.fulfill(json(filas)));
  await page.route(/\/api\/users\/\d+$/, (r) => {
    if (r.request().method() === 'PATCH') {
      patches.push(r.request().postDataJSON());
      return r.fulfill(json(filas[0]));
    }
    return r.fulfill(json({}, 405));
  });
  return { patches };
}

test.describe('HU #13950 · usuarios — desplegable de compañía', () => {
  test('AC1/AC2/AC4 · en el alta, la inactiva sale con «(Inactivo)», deshabilitada y con aria-disabled; la eliminada no sale', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockUsuarios(page, []);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    const rolBase = page.getByLabel('Rol base');
    await expect(rolBase).toBeEnabled();
    await rolBase.selectOption('cliente');

    const select = page.getByRole('combobox', { name: 'Compañía' });
    await expect(select).toBeEnabled();
    const inactiva = select.getByRole('option', { name: 'Coomotor Inactiva (Inactivo)' });
    await expect(inactiva).toHaveCount(1);
    await expect(inactiva).toBeDisabled();
    await expect(inactiva).toHaveJSProperty('disabled', true); // `disabled` nativo: `toBeDisabled` también acepta solo aria-disabled
    await expect(inactiva).toHaveAttribute('aria-disabled', 'true');
    // Las activas, elegibles y sin matiz.
    await expect(select.getByRole('option', { name: 'Andina Activa', exact: true })).toBeEnabled();
    // AC2: lo eliminado no viene del API y la pantalla no lo inventa.
    await expect(select.getByRole('option', { name: /Borrada/ })).toHaveCount(0);

    // No se puede elegir: el `<select>` nativo rechaza una opción deshabilitada.
    await select.selectOption('2', { force: true }).catch(() => undefined);
    await expect(select).not.toHaveValue('2');
    await select.selectOption('1');
    await expect(select).toHaveValue('1');
  });

  test('AC3 · el usuario atado a la inactiva la conserva, marcada, y el resto se guarda sin tocarla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const atado = usuario({ id: 5, username: 'cliente.coomotor', name: 'Atado', role: 'cliente', companiaId: 2 });
    const { patches } = await mockUsuarios(page, [atado]);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    const select = page.getByRole('combobox', { name: 'Compañía' });
    await expect(select).toHaveValue('2');
    const asignada = select.getByRole('option', { name: 'Coomotor Inactiva (Inactivo)' });
    await expect(asignada).toHaveCount(1);
    // Es la seleccionada: no se deshabilita, si no el navegador mostraría otra.
    await expect(asignada).toBeEnabled();

    await page.getByLabel('Nombre completo').fill('Atado editado');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ name: 'Atado editado' });
  });

  test('AC3 · si la asignada ya no viene en la lista, el campo la muestra como «no disponible» y no se vacía', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const atado = usuario({ id: 5, username: 'cliente.borrada', name: 'Huérfano', role: 'cliente', companiaId: 9 });
    const { patches } = await mockUsuarios(page, [atado]);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    const select = page.getByRole('combobox', { name: 'Compañía' });
    await expect(select).toHaveValue('9');
    await expect(select.getByRole('option', { name: 'Compañía asignada (No disponible)' })).toHaveCount(1);

    await page.getByLabel('Nombre completo').fill('Huérfano editado');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ name: 'Huérfano editado' });
  });
});

// ───────────────────────────────────── Tarifas ───────────────────────────────────────────────────

const CLIENTES = [
  { id: 3, name: 'Agrocarga del Norte', document: '900333', active: true },
  { id: 5, name: 'Coomotor', document: '900555', active: false },
  { id: 7, name: 'Transportes Andinos S.A.S.', document: '900777', active: true },
];

async function mockTarifas(page: Page) {
  await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json(CLIENTES)));
  await page.route(/\/api\/flito\/parametrizacion\/tarifas$/, (r) => r.fulfill(json([])));
}

test.describe('HU #13950 · tarifas — elegir cliente', () => {
  test('AC1/AC4 · en la lista lateral el inactivo se ve con «Inactivo» en texto, deshabilitado y no navega', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockTarifas(page);
    await page.goto('/flito/tarifas');

    const lista = page.getByRole('list', { name: 'Clientes' });
    const inactivo = lista.getByRole('button', { name: /Coomotor/ });
    await expect(inactivo).toContainText('Inactivo');
    await expect(inactivo).toBeDisabled();
    await expect(inactivo).toHaveJSProperty('disabled', true);
    await expect(inactivo).toHaveAttribute('aria-disabled', 'true');
    await inactivo.click({ force: true });
    await expect(page).toHaveURL(/\/flito\/tarifas$/);
    await expect(lista.getByRole('button', { name: /Agrocarga/ })).toBeEnabled();
  });

  test('AC1/AC4 · por debajo de lg el selector ofrece el inactivo con «(Inactivo)» y deshabilitado', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await loginAs(page, FINANCIERA_USER);
    await mockTarifas(page);
    await page.goto('/flito/tarifas');

    const select = page.getByRole('combobox', { name: 'Cliente' });
    const inactivo = select.getByRole('option', { name: 'Coomotor (Inactivo)' });
    await expect(inactivo).toHaveCount(1);
    await expect(inactivo).toBeDisabled();
    await expect(inactivo).toHaveJSProperty('disabled', true);
    await expect(inactivo).toHaveAttribute('aria-disabled', 'true');
    await expect(select.getByRole('option', { name: /Agrocarga/ })).toBeEnabled();
  });
});

// ─────────────────────── Bolsas · Conciliación · Remesa RNDC (`GET /clients`) ─────────────────────
//
// Las tres pantallas reciben `active` de `GET /clients` y lo pasan por `opcionesConEstado`. Si el map
// que adapta la respuesta dejara caer `active`, el inactivo saldría elegible y sin «(Inactivo)»: estos
// asertos son los que lo detectan.

const CLIENTES_MIXTOS = [
  { id: 11, name: 'Andina Carga', document: '900111', active: true },
  { id: 12, name: 'Coomotor', document: '900122', active: false },
];

/** Asertos comunes: inactivo marcado, deshabilitado (también para AT) y el activo elegible. */
async function inactivoNoElegible(select: ReturnType<Page['locator']>) {
  const inactivo = select.getByRole('option', { name: 'Coomotor (Inactivo)' });
  await expect(inactivo).toHaveCount(1);
  await expect(inactivo).toBeDisabled();
  await expect(inactivo).toHaveJSProperty('disabled', true);
  await expect(inactivo).toHaveAttribute('aria-disabled', 'true');
  const activo = select.getByRole('option', { name: 'Andina Carga', exact: true });
  await expect(activo).toBeEnabled();
  await expect(activo).not.toHaveAttribute('aria-disabled', 'true');
  await select.selectOption('12', { force: true }).catch(() => undefined);
  await expect(select).not.toHaveValue('12');
  await select.selectOption('11');
  await expect(select).toHaveValue('11');
}

test.describe('HU #13950 · bolsas — crear bolsa de compañía', () => {
  test('AC1/AC4 · el cliente inactivo sale con «(Inactivo)», deshabilitado y con aria-disabled; el activo se elige', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: ['bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.bolsa.crear'] });
    await page.route(/\/api\/flito\/bolsas\/consolidado/, (r) => r.fulfill(json({ clientes: 0, saldoTotal: 0 })));
    await page.route(/\/api\/flito\/bolsas\/alertas/, (r) => r.fulfill(json({
      saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0, boletasSinComprobante: 0 },
    })));
    await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => r.fulfill(json([])));
    await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json(CLIENTES_MIXTOS)));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).first().click();
    // Con solo `bolsas.bolsa.crear` el alcance es fijo (compañía): no hay radio que marcar.

    await inactivoNoElegible(page.getByRole('combobox', { name: /Compañía/ }));
  });
});

test.describe('HU #13950 · conciliación — cargar boleta', () => {
  test('AC1/AC4 · en el modal, el cliente inactivo sale con «(Inactivo)», deshabilitado y con aria-disabled', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route(/\/api\/flito\/conciliacion\/boletas.*/, (r) => r.fulfill(json({ items: [], total: 0 })));
    await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json(CLIENTES_MIXTOS)));
    await page.goto('/flito/conciliacion');
    await page.getByRole('button', { name: /Cargar boleta/ }).first().click();

    const modal = page.getByRole('dialog', { name: 'Cargar boleta del portal' });
    await inactivoNoElegible(modal.getByRole('combobox', { name: /Cliente/ }));
  });
});

test.describe('HU #13950 · remesa RNDC — cliente', () => {
  const vacio = { data: [] };
  async function mockRemesa(page: Page, remesa?: Fila) {
    await page.route(/\/api\/rndc\/(catalogos\/[^/?]+|propietarios-carga|destinatarios-carga)(\?|$)/, (r) => r.fulfill(json(vacio)));
    await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json(CLIENTES_MIXTOS)));
    if (remesa) await page.route(/\/api\/rndc\/remesas\/\d+$/, (r) => r.fulfill(json({ data: remesa })));
  }
  /** El `<label>` de `Field` no está asociado (deuda previa): se llega al select por su contenedor. */
  const selectCliente = (page: Page) =>
    page.locator('div').filter({ has: page.locator('label', { hasText: /^Cliente$/ }) }).last().locator('select');

  test('AC1/AC4 · en la nueva remesa, el cliente inactivo sale con «(Inactivo)», deshabilitado y con aria-disabled', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockRemesa(page);
    await page.goto('/rndc/remesas/nueva');
    await inactivoNoElegible(selectCliente(page));
  });

  test('AC3 · la remesa atada al cliente inactivo lo conserva, seleccionado y habilitado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockRemesa(page, { id: 40, clientId: 12 });
    await page.goto('/rndc/remesas/40');
    const select = selectCliente(page);
    await expect(select).toHaveValue('12');
    const asignado = select.getByRole('option', { name: 'Coomotor (Inactivo)' });
    await expect(asignado).toBeEnabled();
    await expect(select.getByRole('option', { name: 'Andina Carga', exact: true })).toBeEnabled();
  });
});
