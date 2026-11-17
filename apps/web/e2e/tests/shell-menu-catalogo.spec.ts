// HU #13431 (Feature #13416, Épica #13411) — Shell: elemento «Ayuda», Perfil por permiso y menú con
// los nombres del catálogo.
//
// Certifica (smoke, `test:e2e:smoke`):
//   AC1 — «Ayuda» es el último elemento del menú, derivado de los capítulos visibles (sin permiso
//         propio); sin capítulos no se ve en barra ni en ⌘K y la ruta directa es «sin acceso».
//   AC2 — sin «Ver mis datos» no hay «Perfil» en el menú de usuario y `/perfil` es «sin acceso».
//   AC4 — rótulos de sección e ítem = nombres de `ARBOL_PERMISOS`; un elemento o ítem que el
//         resolutor no entrega (desmarcado) no aparece.
//   AC5 — el tablero pinta solo los bloques de los módulos visibles y no pide los demás.
//   AC6 — usuario enlazado a compañía: sin módulos sin compañía, catálogos ni configuración; sí
//         Tablero y Perfil.
//   AC7 — al volver a la pestaña, el menú deja de mostrar lo que se quitó.
//
//   npx playwright test e2e/tests/shell-menu-catalogo.spec.ts --reporter=line
//
// Shell del UI Kit 2026 (Épica #14560): el dock pinta las secciones del menú original (SECTION_ORDER) con los
// nombres del catálogo, sin reagrupar ni isotipo; «Ayuda» es la última sección (las que no caben, en el «Más»). La cuenta (Mi perfil, Ayuda,
// Cambiar contraseña, Salir) vive en el menú de usuario.

import type { Page } from '@playwright/test';
import { ARBOL_PERMISOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, sobreDeMios, FUNCIONES_POR_ROL, FUNCIONES_PERFIL,
  ADMIN_USER, CLIENTE_USER, CONDUCTOR_USER, FINANCIERA_USER, MENSAJERO_USER, OPERACIONES_USER,
} from '../helpers/auth';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });
const nombreElemento = (clave: string) => ELEMENTOS_PERMISOS.find((n) => n.codigo === `menu.${clave}`)!.nombre;
const nombreItem = (slug: string) => ARBOL_PERMISOS.find((n) => n.tipo === 'item' && n.slug === slug)!.nombre;
const sinPerfil = (rol: string) => FUNCIONES_POR_ROL[rol].filter((f) => !(FUNCIONES_PERFIL as readonly string[]).includes(f));

async function listo(page: Page) {
  await expect(page.getByRole('button', { name: /^Buscar placa, trámite o módulo/ })).toBeVisible();
}

/** Nombres visibles (el <strong>) de las entradas del menú de usuario, sin la línea de detalle. */
const entradasCuenta = (menu: ReturnType<Page['getByRole']>) =>
  menu.getByRole('menuitem').evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => (e.querySelector('strong')?.textContent ?? e.textContent ?? '').trim()));

async function opcionesDeUsuario(page: Page) {
  await page.getByRole('button', { name: /Menú de usuario/ }).click();
  return page.getByRole('menu', { name: 'Opciones de usuario' });
}

test.describe('HU #13431 — menú con los nombres del catálogo', () => {
  // 1920 px: caben todas las secciones con nombre; a 1440 las últimas pasan al «Más» (shell-menu-responsive).
  test.use({ viewport: { width: 1920, height: 900 } });

  test('AC4 — las secciones y los ítems se rotulan con el catálogo (LAFT, no «Cumplimiento»)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.goto('/');
    await listo(page);
    for (const clave of ['gestion', 'transito', 'laft', 'finanzas', 'administracion']) {
      await expect(nav(page).getByRole('button', { name: nombreElemento(clave), exact: true })).toBeVisible();
    }
    await expect(nav(page).getByRole('button', { name: 'Cumplimiento', exact: true })).toHaveCount(0);
    // «General» con solo Tablero se pinta como enlace directo con el nombre del ítem.
    await expect(nav(page).getByRole('link', { name: nombreItem('dashboard'), exact: true })).toHaveAttribute('href', '/');
    // Administración es sección del dock, no del menú de usuario.
    const menu = await opcionesDeUsuario(page);
    await expect(menu.locator('.menu-usuario__seccion')).toHaveCount(0);
    await page.getByRole('button', { name: /Menú de usuario/ }).click();

    await nav(page).getByRole('button', { name: nombreElemento('gestion'), exact: true }).click();
    // El ítem lleva el nombre del catálogo, no el rótulo fijo anterior («Derechos de tránsito»).
    await expect(page.getByRole('link', { name: nombreItem('flito_derechos'), exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Derechos de tránsito', exact: true })).toHaveCount(0);
  });

  test('AC4 — elemento o ítem que el resolutor no entrega no aparece', async ({ page }) => {
    // El resolutor (#13429) solo entrega `pagina.*` si su `menu.*` está efectivo: un elemento
    // desmarcado llega como «sin ninguna página suya». Aquí: solo Bolsas, de todo Finanzas.
    await loginAs(page, { ...MENSAJERO_USER, allowedPages: ['flito_bolsas'] }, { funciones: [] });
    await page.goto('/flito/bolsas');
    await listo(page);
    await expect(nav(page).getByRole('link', { name: nombreItem('flito_bolsas'), exact: true })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: nombreItem('flito_tarifas'), exact: true })).toHaveCount(0);
    // Un solo ítem visible: ninguna sección desplegable, ni Tablero (no tiene `dashboard`), ni Administración.
    await expect(nav(page).getByRole('button')).toHaveCount(0);
    const menu = await opcionesDeUsuario(page);
    await expect(menu.locator('.menu-usuario__seccion')).toHaveCount(0);
  });
});

test.describe('HU #13431 — AC1 · «Ayuda» derivada de los capítulos visibles', () => {
  // 1920 px: caben todas las secciones con nombre; a 1440 las últimas pasan al «Más» (shell-menu-responsive).
  test.use({ viewport: { width: 1920, height: 900 } });

  test('con capítulos visibles: «Ayuda» es la última sección, en el dock y en ⌘K (y en el menú de usuario)', async ({ page }) => {
    // Financiera: rol sin enlace con capítulos de Finanzas (no admin, que lo ve todo).
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/');
    await listo(page);
    const enlace = nav(page).getByRole('link', { name: 'Ayuda', exact: true });
    await expect(enlace).toHaveAttribute('href', '/flito/ayuda');
    await expect(nav(page).locator('a, button').last()).toHaveAccessibleName('Ayuda');
    const menu = await opcionesDeUsuario(page);
    await menu.getByRole('menuitem', { name: /^Ayuda/ }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    await listo(page);

    await page.keyboard.press('Control+k');
    const grupo = page.getByRole('group', { name: nombreElemento('ayuda') });
    await expect(grupo.getByRole('option', { name: /^Ayuda/ })).toBeVisible();
    await expect(page.getByRole('group').last()).toHaveAccessibleName(nombreElemento('ayuda'));
  });

  test('sin capítulos visibles: no hay «Ayuda» y la ruta directa es «sin acceso»', async ({ page }) => {
    // Desde las HU #13775 (ficha «Tablero de control», permiso `dashboard`) y #13914 (cada usuario ve las
    // fichas de las pantallas que abre), el Conductor YA tiene un capítulo: `dashboard` le llega por los
    // defaults de su rol. El caso «sin capítulos» exige un rol sin defaults (creado por el admin, HU #12169)
    // con una sola página que no tiene ficha (`pesv`).
    await loginAs(page, { ...CONDUCTOR_USER, role: 'e2e_sin_fichas', allowedPages: ['pesv'] });
    await page.goto('/');
    await expect(nav(page)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);
    const menu = await opcionesDeUsuario(page);
    await expect(menu.getByRole('menuitem', { name: /^Ayuda/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
    await expect(page.getByRole('option', { name: /^Ayuda/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // El índice sin capítulos ya no es NoAccess (gate de App.tsx, igual en develop): es el vacío con su
    // siguiente paso. La puerta sigue cerrada: ni enlace, ni ⌘K, ni capítulo que abrir.
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('heading', { name: 'Su usuario aún no tiene módulos con ayuda' })).toBeVisible();
  });
});

test.describe('HU #13431 — AC2 · Perfil por «Ver mis datos»', () => {
  test('con la función: «Mi perfil» (y «Cambiar contraseña») encima de «Salir»', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/');
    const menu = await opcionesDeUsuario(page);
    // «Ayuda» puede ir entre medias según los capítulos visibles (AC1); aquí se mira el orden de la cuenta.
    const cuenta = (await entradasCuenta(menu)).filter((e) => e !== 'Ayuda');
    expect(cuenta).toEqual(['Mi perfil', 'Cambiar contraseña', 'Salir']);
  });

  test('sin la función: solo «Cerrar sesión» y `/perfil` es «sin acceso» (aunque tenga la página)', async ({ page }) => {
    let pedidasPerfil = 0;
    await loginAs(page, { ...ADMIN_USER }, { funciones: sinPerfil('admin') });
    await page.route('**/api/auth/perfil', (r) => { pedidasPerfil += 1; return r.fulfill(json({})); });
    await page.goto('/');
    const menu = await opcionesDeUsuario(page);
    const entradas = await entradasCuenta(menu);
    // Sin «Ver mis datos»: ni «Mi perfil» ni «Cambiar contraseña» (que lleva a /perfil); «Salir» siempre, al final.
    expect(entradas).not.toContain('Mi perfil');
    expect(entradas).not.toContain('Cambiar contraseña');
    expect(entradas.at(-1)).toBe('Salir');
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    await page.goto('/perfil');
    await expect(page.getByRole('heading', { level: 1, name: 'No tienes acceso a Perfil' })).toBeVisible();
    await expect(page.getByLabel('Contraseña actual')).toHaveCount(0);
    expect(pedidasPerfil).toBe(0);
  });
});

test.describe('HU #13431 — AC5 · tablero por bloques', () => {
  async function contarTablero(page: Page) {
    const pedidas = { soat: 0, flota: 0, rndc: 0 };
    await page.route(/\/api\/soat\/stats/, (r) => { pedidas.soat += 1; return r.fulfill(json({ totalVehicles: 3, pendiente: 1, enviado: 0, comprado: 0, verificado: 2, rechazado: 0 })); });
    await page.route(/\/api\/fleet\/documents\/expiring/, (r) => { pedidas.flota += 1; return r.fulfill(json({ data: [], count: 0 })); });
    await page.route(/\/api\/rndc\/manifiestos/, (r) => { pedidas.rndc += 1; return r.fulfill(json({ data: [], total: 0 })); });
    return pedidas;
  }

  test('solo RNDC visible: solo su bloque, sin pedir SOAT ni flota', async ({ page }) => {
    const pedidas = await contarTablero(page);
    await loginAs(page, { ...MENSAJERO_USER, allowedPages: ['rndc'] }, { funciones: [] });
    await page.goto('/');
    await expect(page.getByText('Envíos al día')).toBeVisible();
    expect(pedidas.soat).toBe(0);
    expect(pedidas.flota).toBe(0);
  });

  test('ningún módulo con bloque: vacío útil, sin pedir nada', async ({ page }) => {
    const pedidas = await contarTablero(page);
    await loginAs(page, MENSAJERO_USER, { funciones: [] });
    await page.goto('/');
    await expect(page.getByTestId('tablero-vacio')).toContainText('Tu tablero no tiene indicadores con tus permisos actuales.');
    expect(pedidas).toEqual({ soat: 0, flota: 0, rndc: 0 });
  });
});

test.describe('HU #13431 — AC6 · usuario enlazado a compañía', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('no ve módulos sin compañía, catálogos ni configuración; sí Perfil', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await page.goto('/');
    await listo(page);
    // Secciones que solo tienen módulos sin compañía, catálogos o configuración.
    for (const clave of ['finanzas', 'administracion', 'transito', 'pesv', 'laft', 'rndc', 'mantenimiento']) {
      await expect(nav(page).getByRole('button', { name: nombreElemento(clave), exact: true })).toHaveCount(0);
    }
    await expect(nav(page).getByRole('link', { name: nombreItem('flito_tarifas'), exact: true })).toHaveCount(0);
    const menu = await opcionesDeUsuario(page);
    await expect(menu.locator('.menu-usuario__seccion')).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /^Mi perfil/ })).toBeVisible();
  });
});

test.describe('HU #13431 — AC7 · el menú se refresca con la sesión abierta', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('al volver a la pestaña, «Perfil» desaparece si se quitó «Ver mis datos»', async ({ page }) => {
    const estado = { funciones: [...FUNCIONES_POR_ROL.admin], mios: 0 };
    await loginAs(page, OPERACIONES_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => {
      estado.mios += 1;
      return route.fulfill(json(sobreDeMios(OPERACIONES_USER, estado.funciones)));
    });
    await page.goto('/');
    let menu = await opcionesDeUsuario(page);
    await expect(menu.getByRole('menuitem', { name: /^Mi perfil/ })).toBeVisible();
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    await expect(menu).toHaveCount(0);

    estado.funciones = sinPerfil('admin');
    const antes = estado.mios;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => estado.mios).toBeGreaterThan(antes);
    menu = await opcionesDeUsuario(page);
    await expect(menu.getByRole('menuitem', { name: /^Mi perfil/ })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Salir' })).toBeVisible();
  });
});
