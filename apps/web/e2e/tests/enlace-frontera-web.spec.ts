// HU #13452 (Feature #12871, Épica #13411) — Corrección de la sesión de evidencias en DEV.
//
// Hallazgo 1: un rol con enlace (p. ej. «Prueba compañía», enlace `compania`) con «Clientes y
// proveedores» marcado veía el ítem en el menú y la pantalla abría con «Sin permisos»: el API la
// cierra por el enlace (ADR-0024, `FRONTERA_POR_ENLACE`). La web ya no ofrece lo que el enlace cierra:
// ni menú, ni ⌘K, y la ruta es «sin acceso». En Roles y permisos el ítem sale deshabilitado con nota.
// Hallazgo 2: copy interno («Sincroniza desde el Tablero», «Solo para Operaciones») a usuarios con enlace.
//
// Cada caso tiene su control positivo: el MISMO usuario sin enlace sigue viendo todo como antes.
//
//   TZ=UTC npx playwright test e2e/tests/enlace-frontera-web.spec.ts --reporter=line
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FUNCIONES_PERFIL } from '../helpers/auth';
import { accion, arbolRol, elemento, item, type NodoDef } from '../helpers/arbolPermisos';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const FUNCIONES = [
  // `soat.solicitud.enviar`: el vacío de siempre («Sincroniza desde el Tablero») es el de Operaciones.
  'soat.cola.ver', 'soat.solicitud.enviar', 'soat.excel.exportar', 'soat.excel.exportar_pago',
  'impuestos.cola.ver', 'impuestos.tramite.enviar', 'impuestos.excel.exportar_pago',
  // Gestión Trámites con su bloque «Sincronización» (visible con `sync.sync.ver_estado`) y Logística.
  'sync.sync.ver_estado', 'logistica.lote.cerrar',
  ...FUNCIONES_PERFIL,
];

/** El usuario de la sesión de evidencias: rol cualquiera, enlace `compania`, con Clientes marcado. */
const PRUEBA_COMPANIA = {
  id: 913, username: 'prueba.compania', name: 'Prueba Compañía', role: 'prueba_compania',
  allowedPages: ['flito_soat', 'flito_impuestos', 'clients', 'flito_tramites', 'flito_logistica'], tipoEnlace: 'compania', funciones: FUNCIONES,
};
/** Control: lo mismo, sin enlace. */
const PRUEBA_SIN_ENLACE = { ...PRUEBA_COMPANIA, tipoEnlace: 'ninguno' };

async function mockColas(page: Page) {
  await page.route(/\/api\/flito\/parametrizacion\//, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [], proveedores: [] })));
  await page.route(/\/api\/flito\/soat\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [] })));
  await page.route(/\/api\/flito\/impuestos\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill(json({ estados: [], tramites: [], ciudades: [], transitos: [] })));
  await page.route(/\/api\/flito\/tramites\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/logistica\/facetas/, (r) => r.fulfill(json({ estados: [], empresas: [], organismos: [], companiasCerrables: [], mensajeros: [] })));
  await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/logistica\?/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });
const enlaceMenu = (page: Page, nombre: string) => nav(page).getByRole('link', { name: nombre, exact: true });
const casillaPago = (page: Page) => page.getByRole('checkbox', { name: 'Incluir datos de pago y trazabilidad', exact: true });

async function abrirGestion(page: Page) {
  await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();
  const boton = nav(page).getByRole('button', { name: 'Gestión', exact: true });
  if (await boton.count()) await boton.click();
}

test.describe('HU #13452 · la web no ofrece lo que el enlace cierra', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('menú sin «Clientes y proveedores» para un usuario con enlace compañía (ni en ⌘K); SOAT sí', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/flito/soat');
    await abrirGestion(page);
    await expect(enlaceMenu(page, 'SOAT')).toBeVisible();
    await expect(enlaceMenu(page, 'Clientes y proveedores')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('clientes');
    await expect(page.getByRole('option', { name: /Clientes y proveedores/ })).toHaveCount(0);
  });

  test('la ruta /clients es «sin acceso» para el usuario con enlace y no pide el API', async ({ page }) => {
    let pedidas = 0;
    await page.route(/\/api\/flito\/parametrizacion\//, (r) => { pedidas += 1; return r.fulfill(json({ error: 'Sin permisos' }, 403)); });
    await page.route(/\/api\/companies/, (r) => { pedidas += 1; return r.fulfill(json({ error: 'Sin permisos' }, 403)); });
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo cliente' })).toHaveCount(0);
    await expect(page.getByText('Sin permisos')).toHaveCount(0);
    expect(pedidas).toBe(0);
  });

  test('control: el mismo usuario SIN enlace ve «Clientes y proveedores» y /clients no es «sin acceso»', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_SIN_ENLACE);
    await page.goto('/flito/soat');
    await abrirGestion(page);
    await expect(enlaceMenu(page, 'Clientes y proveedores')).toBeVisible();
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toHaveCount(0);
  });
});

test.describe('HU #13452 · sin copy interno para usuarios con enlace', () => {
  test('SOAT vacío con enlace: «No hay SOAT de su compañía en esta vista.» y sin la casilla «Solo para Operaciones»', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/flito/soat');
    await expect(page.getByText('No hay SOAT de su compañía en esta vista.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde el Tablero/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exportar a Excel', exact: true })).toBeVisible();
    await expect(casillaPago(page)).toHaveCount(0);
    await expect(page.getByText(/Solo para Operaciones/)).toHaveCount(0);
  });

  test('Impuestos vacío con enlace: «No hay impuestos de su compañía en esta vista.» y sin la casilla', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/flito/impuestos');
    await expect(page.getByText('No hay impuestos de su compañía en esta vista.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde el Tablero/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exportar a Excel', exact: true })).toBeVisible();
    await expect(casillaPago(page)).toHaveCount(0);
    await expect(page.getByText(/Solo para Operaciones/)).toHaveCount(0);
  });

  test('control: sin enlace, SOAT e Impuestos conservan su vacío y la casilla de pago', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_SIN_ENLACE);
    await page.goto('/flito/soat');
    await expect(page.getByText('No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.')).toBeVisible();
    await expect(casillaPago(page)).toHaveCount(1);
    await page.goto('/flito/impuestos');
    await expect(page.getByText('No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.')).toBeVisible();
    await expect(casillaPago(page)).toHaveCount(1);
  });
});

const VACIO_TRAMITES = 'No hay trámites. FLITO los trae de FLIT automáticamente.';
const VACIO_LOGISTICA = 'No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.';
const seccionSync = (page: Page) => page.getByTestId('seccion-sincronizacion');

test.describe('HU #13452 · Gestión Trámites y Logística sin copy interno para usuarios con enlace', () => {
  test('Trámites con enlace compañía: vacío sin «Sincroniza…» y sin el bloque «Sincronización» (FLIT 1 / FLIT 2)', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/flito/tramites');
    await expect(page.getByText('No hay trámites de su compañía en esta vista.')).toBeVisible();
    await expect(page.getByText(/Sincroniza/)).toHaveCount(0);
    await expect(seccionSync(page)).toHaveCount(0);
    await expect(page.getByTestId('cabecera-sincronizacion')).toHaveCount(0);
    await expect(page.getByText(/FLIT 1|FLIT 2/)).toHaveCount(0);
  });

  test('Logística con enlace compañía: vacío sin «Sincroniza desde FLIT»', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_COMPANIA);
    await page.goto('/flito/logistica');
    await expect(page.getByText('No hay trámites aprobados de su compañía en esta vista. Los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde FLIT/)).toHaveCount(0);
  });

  test('control: sin enlace, Trámites conserva el bloque «Sincronización» y su vacío; Logística su vacío', async ({ page }) => {
    await mockColas(page);
    await loginAs(page, PRUEBA_SIN_ENLACE);
    await page.goto('/flito/tramites');
    await expect(page.getByText(VACIO_TRAMITES)).toBeVisible();
    await expect(seccionSync(page)).toBeVisible();
    await expect(page.getByTestId('resumen-flit1')).toBeVisible();
    await page.goto('/flito/logistica');
    await expect(page.getByText(VACIO_LOGISTICA)).toBeVisible();
  });
});

// ───────────────────────────── Panel de Roles y permisos ─────────────────────────────────────────

const ARBOL: NodoDef[] = [
  elemento('gestion', 'Gestión', [
    item('flito_soat', 'SOAT', [accion('accion.soat.ver_listado', 'Ver el listado')]),
    item('clients', 'Clientes y proveedores', [accion('accion.clientes.ver', 'Ver clientes')]),
  ]),
];

const rol = (codigo: string, nombre: string, tipoEnlace: string) => ({
  codigo, nombre, descripcion: null, tipoEnlace, esSistema: false, activo: true, usuarios: 1,
  borrable: false, motivoNoBorrable: '1 usuario tiene este rol',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});
const ROLES = [rol('prueba_compania', 'Prueba compañía', 'compania'), rol('operaciones_x', 'Operaciones X', 'ninguno')];
const NOTA = 'Cerrado por el enlace «Compañía»: este rol no lo verá aunque lo marque.';

function mockPermisos(page: Page) {
  const marcas = ['menu.gestion', 'pagina.flito_soat', 'accion.soat.ver_listado', 'pagina.clients', 'accion.clientes.ver'];
  page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    const datos = ROLES.find((x) => x.codigo === codigo);
    return r.fulfill(json({ rol: { codigo, nombre: datos?.nombre ?? codigo, tipoEnlace: datos?.tipoEnlace ?? 'ninguno' }, arbol: arbolRol(ARBOL, new Set(marcas)) }));
  });
  page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    return r.fulfill(json({ codigo, funciones: marcas }));
  });
}

const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const fila = (page: Page, codigo: string) => page.locator(`li[data-codigo-fila="${codigo}"]`);

test.describe('HU #13452 · panel de roles: lo que el enlace cierra sale deshabilitado', () => {
  test('rol con enlace compañía: «Clientes y proveedores» deshabilitado con la nota; SOAT editable', async ({ page }) => {
    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/roles-permisos');
    await page.getByRole('button', { name: /^Prueba compañía/ }).click();
    await expect(page.getByRole('heading', { name: 'Prueba compañía', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Contenido de Gestión', exact: true }).click();

    await expect(casilla(page, 'pagina.clients')).toBeDisabled();
    const nota = fila(page, 'pagina.clients').locator('[data-aviso="cerrado-por-enlace"]').first();
    await expect(nota).toHaveText(NOTA);
    // La nota describe la casilla (lector de pantalla), no solo se ve.
    const idNota = await nota.getAttribute('id');
    await expect(casilla(page, 'pagina.clients')).toHaveAttribute('aria-describedby', new RegExp(`(^| )${idNota}( |$)`));
    // Lo que cuelga del ítem cerrado también queda deshabilitado, sin repetir la nota.
    await page.getByRole('button', { name: 'Contenido de Clientes y proveedores', exact: true }).click();
    await expect(casilla(page, 'accion.clientes.ver')).toBeDisabled();
    await expect(page.locator('[data-aviso="cerrado-por-enlace"]')).toHaveCount(1);

    await expect(casilla(page, 'pagina.flito_soat')).toBeEnabled();
    await expect(fila(page, 'pagina.flito_soat').locator('[data-aviso="cerrado-por-enlace"]')).toHaveCount(0);
  });

  test('control: un rol sin enlace no tiene nada deshabilitado por enlace', async ({ page }) => {
    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/roles-permisos');
    await page.getByRole('button', { name: /^Operaciones X/ }).click();
    await expect(page.getByRole('heading', { name: 'Operaciones X', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Contenido de Gestión', exact: true }).click();
    await expect(casilla(page, 'pagina.clients')).toBeEnabled();
    await expect(page.locator('[data-aviso="cerrado-por-enlace"]')).toHaveCount(0);
  });
});

// ───────────────────────── Tablero de General (`pagina.dashboard`) ───────────────────────────────
// El Tablero de General es el módulo `tablero` de la frontera (P-11 unió Tablero FLITO a General), y
// `FRONTERA_POR_ENLACE.tablero` lo abre a `compania` (#13426). La PR #508 no mapeaba `dashboard` y la
// compañía lo perdía en menú, ⌘K y ruta; proveedor y organismos siguen sin él.

const TABLERO = { revisionesPendientes: { soat: 2 }, estancados: { soat: 1 }, diferenciasDeValor: 0, compuertaHabilitados: 0, soat: {} };
const conTablero = (enlace: string) => ({
  ...PRUEBA_COMPANIA, tipoEnlace: enlace,
  allowedPages: ['dashboard', 'flito_soat'], funciones: ['tablero.tablero.ver', 'soat.cola.ver', ...FUNCIONES_PERFIL],
});

const NOTA_AUDITORIA = 'Solo lectura · Auditoría observa el tablero; no ejecuta acciones sobre él.';

async function mockTablero(page: Page) {
  await mockColas(page);
  await page.route(/\/api\/flito\/tablero$/, (r) => r.fulfill(json(TABLERO)));
}

test.describe('HU #13452 · el Tablero de General sigue abierto al enlace Compañía', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('compañía: «Tablero» en el menú y / abre el Tablero (no «sin acceso»)', async ({ page }) => {
    await mockTablero(page);
    await loginAs(page, conTablero('compania'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tablero', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: /^Tablero/ })).toHaveCount(1);
    // Sin copy interno: ni la nota de Auditoría ni mención a Operaciones o a sincronizar.
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();
    await expect(page.getByText(NOTA_AUDITORIA)).toHaveCount(0);
    await expect(page.getByRole('main').getByText(/Auditoría|Operaciones|Sincroniz/)).toHaveCount(0);
  });

  test('compañía con `sync.sync.lanzar` en el rol: sin «Sincronizar desde FLIT» (la sincronización le queda cerrada)', async ({ page }) => {
    await mockTablero(page);
    const u = conTablero('compania');
    await loginAs(page, { ...u, funciones: [...u.funciones, 'sync.sync.lanzar'] });
    await page.goto('/');
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sincronizar/ })).toHaveCount(0);
  });

  test('sin enlace, el Tablero tampoco lleva la nota de Auditoría (HU #13630 AC7)', async ({ page }) => {
    await mockTablero(page);
    await loginAs(page, conTablero('ninguno'));
    await page.goto('/');
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();
    await expect(page.getByText(NOTA_AUDITORIA)).toHaveCount(0);
  });

  for (const enlace of ['proveedor', 'organismos_transito']) {
    test(`${enlace}: sin «Tablero» en el menú y / no pide el tablero`, async ({ page }) => {
      let pedidas = 0;
      await mockColas(page);
      await page.route(/\/api\/flito\/tablero$/, (r) => { pedidas += 1; return r.fulfill(json({ error: 'Sin permisos' }, 403)); });
      await loginAs(page, conTablero(enlace));
      await page.goto('/flito/soat');
      await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();
      await expect(nav(page).getByRole('link', { name: /^Tablero/ })).toHaveCount(0);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Tablero', level: 1 })).toHaveCount(0);
      expect(pedidas).toBe(0);
    });
  }
});
