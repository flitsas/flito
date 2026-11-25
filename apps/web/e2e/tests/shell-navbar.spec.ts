// Shell sin sidebar — FlitNavBar, dock flotante al pie (HU #11143), revestido con el UI Kit 2026 (Épica #14560).
// Cubre: dónde vive el dock, apertura de las opciones hacia arriba y dentro del viewport, rejilla y riel de
// subgrupos, una sola fila con nombres por ancho, contrato de teclado (disclosure APG + Escape que devuelve el foco,
// tablist del riel) y filtrado por permisos.
//
// Épica #14678 (menú por áreas, spec docs/ux/epica-14678-menu-por-areas.md):
//   · un botón por opción del menú, en SECTION_ORDER y con sus nombres: Operaciones, Financiera, Gerencial, Kyverum,
//     Administración y Ayuda (las áreas sin entradas no se pintan); una opción con una sola entrada es enlace directo
//     con el nombre de la entrada. Sin isotipo central;
//   · paneles sin scroll: rejilla de 3 columnas; Gerencial con el subencabezado «Torre de Control»; Kyverum (más de 24
//     entradas) con riel vertical de siete subgrupos;
//   · las seis opciones del admin caben en una fila desde 1024 px (sin «Más»);
//   · la barra superior no tiene Notificaciones ni la rejilla de Productos;
//   · <1024 px no hay dock: ☰ en el topbar + menú lateral (lo cubre shell-menu-responsive.spec.ts).
import { test, expect } from '../helpers/fixtures';
import { ARBOL_PERMISOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { LoginPage } from '../pages/LoginPage';
import {
  loginAs, sobreDeMe, sobreDeMios, ADMIN_USER, PROVEEDOR_USER, OPERACIONES_USER, GESTOR_IMPUESTOS_USER, CONDUCTOR_USER, MENSAJERO_USER,
} from '../helpers/auth';
import { COPY_MENU_ERROR, COPY_MENU_VACIO } from '../../src/components/shell/useEstadoMenu';

// El home (/) renderiza <FlitoTablero>, que consume /flito/tablero como OBJETO (no lista).
// Sin este shape el dashboard antes reventaba y dejaba el shell en blanco.
const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    // HU #12872: el menú también pregunta funciones (`/permisos/mios`, que mockea `loginAs`); el
    // catch-all no puede taparlo con `[]` o SOAT/Impuestos/«Mi ruta» desaparecerían por fail-closed.
    const url = route.request().url();
    if (url.includes('/auth/me') || url.includes('/permisos/mios')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  // Registrado después → tiene prioridad para /flito/tablero.
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
}

/** El tablero vacío no llega a una pantalla de alto; el condensado necesita scroll real. */
async function alargarPagina(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const relleno = document.createElement('div');
    relleno.style.height = '2400px';
    // Al principio de <main>: el pie legal del kit 2026 vive al final de <main> y tiene que seguir siendo lo último.
    document.querySelector('main')?.prepend(relleno);
  });
}

const dockLocator = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Navegación principal' });

const seccion = (clave: string) => ELEMENTOS_PERMISOS.find((n) => n.codigo === `menu.${clave}`)!.nombre;
const item = (slug: string) => ARBOL_PERMISOS.find((n) => n.tipo === 'item' && n.slug === slug)!.nombre;

/** Lo que el admin ve en el dock, en orden (Épica #14678): SECTION_ORDER; Ayuda tiene una sola entrada (enlace). */
const DOCK_ADMIN = () => [
  seccion('operaciones'), seccion('financiera'), seccion('gerencial'), seccion('kyverum'), seccion('administracion'), seccion('ayuda'),
];

/** Píldoras del dock en el orden del DOM (sin el indicador deslizante, que es decoración). */
const PILDORAS = ':scope > .dock__grupo, :scope > a.dock__item';

/** Nombres de las píldoras del dock en el orden del DOM (el rótulo sigue en el DOM aunque se condense). */
const nombresDelDock = (page: import('@playwright/test').Page) => page.evaluate((sel) =>
  Array.from(document.querySelector('[data-vt="floating-nav"]')!.querySelectorAll(sel))
    .map((k) => (k.querySelector('.dock__nombre')?.textContent ?? '').trim()), PILDORAS);

/** El panel abierto no tiene scroll propio: todo cabe a la vista (spec UX §2). */
const sinScroll = (panel: import('@playwright/test').Locator) =>
  panel.evaluate((el) => Array.from(el.querySelectorAll('*')).concat(el)
    .filter((n) => n.scrollHeight > n.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(n).overflowY)).length);

test.describe('Shell · FlitNavBar (dock de escritorio)', () => {
  test.use({ viewport: { width: 1920, height: 900 } });

  test('admin ve las 6 opciones del menú en su orden, sin «Más» ni isotipo; Kyverum abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav).toBeVisible();
    // La CUENTA además de los nombres: perder o sumar una opción no puede dejar esto en verde.
    const nombres = await nombresDelDock(page);
    expect(nombres).toHaveLength(6);
    expect(nombres).toEqual(DOCK_ADMIN());
    expect(nombres.at(-1)).toBe('Ayuda');
    await expect(nav.getByRole('button', { name: 'Más', exact: true })).toHaveCount(0);
    // Ninguna de las secciones viejas por dominio queda como botón.
    for (const vieja of ['General', 'Gestión', 'Tránsito', 'Flota', 'Mantenimiento', 'PESV', 'RNDC', 'LAFT', 'Finanzas', 'Torre de Control']) {
      await expect(nav.getByRole('button', { name: vieja, exact: true })).toHaveCount(0);
    }
    // Sin los grupos propios del kit ni el isotipo «Inicio».
    for (const grupo of ['Trámites', 'Impuestos y SOAT', 'Logística', 'Cumplimiento']) {
      await expect(nav.getByRole('button', { name: grupo, exact: true })).toHaveCount(0);
    }
    await expect(nav.getByRole('link', { name: 'Inicio', exact: true })).toHaveCount(0);
    await expect(nav.locator('.dock__fab')).toHaveCount(0);
    // Administración vuelve al dock: el menú de usuario ya no la lleva.
    await page.getByRole('button', { name: /^Menú de usuario/ }).click();
    const menuUsuario = page.getByRole('menu', { name: 'Opciones de usuario' });
    await expect(menuUsuario.locator('.menu-usuario__seccion')).toHaveCount(0);
    await expect(menuUsuario.getByRole('menuitem', { name: /^Usuarios/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^Menú de usuario/ }).click();
    await expect(menuUsuario).toHaveCount(0);

    const kyverum = nav.getByRole('button', { name: 'Kyverum', exact: true });
    await kyverum.click();
    await expect(kyverum).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('tab', { name: 'PESV', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(kyverum).toHaveAttribute('aria-expanded', 'false');
    await expect(kyverum).toBeFocused();

    // Navegar desde el panel lo cierra y marca la opción activa; al reabrir, el riel arranca en PESV.
    await kyverum.click();
    await page.getByRole('tab', { name: 'PESV', exact: true }).click();
    await page.getByRole('link', { name: 'Conductores', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\/conductores/);
    await expect(kyverum).toHaveAttribute('aria-expanded', 'false');
    await expect(kyverum).toHaveAttribute('aria-current', 'page');
    await kyverum.click();
    await expect(page.getByRole('tab', { name: 'PESV', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: 'Conductores', exact: true })).toHaveAttribute('aria-current', 'page');
    // `/pesv` es prefijo de `/pesv/conductores`: su entrada («PESV · Inicio») NO se marca (`finExacto`), y en el
    // panel hay una sola entrada actual.
    const panelKyverum = page.locator('#flit-navbar-panel-kyverum');
    await expect(panelKyverum.locator('a[href="/pesv"]')).toBeVisible();
    await expect(panelKyverum.locator('a[href="/pesv"]')).not.toHaveAttribute('aria-current', /.*/);
    await expect(panelKyverum.locator('a[aria-current="page"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Administración muestra sus ítems del catálogo, con Organismos STT al final.
    await nav.getByRole('button', { name: seccion('administracion'), exact: true }).click();
    const admin = page.locator('#flit-navbar-panel-administracion');
    for (const slug of ['users', 'roles_permisos']) {
      await expect(admin.getByRole('link', { name: new RegExp(`^${item(slug)}`) })).toBeVisible();
    }
    await expect(admin.getByRole('link').last()).toHaveAttribute('href', '/transito/organismos');
  });

  test('la barra superior: marca, buscador, tema y usuario; sin Notificaciones ni Productos de FLIT', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    const barra = page.getByRole('banner');
    await expect(barra.getByRole('link', { name: 'FLITO, ir al inicio' })).toBeVisible();
    await expect(barra.getByRole('button', { name: /^Buscar o ir a sección/ })).toBeVisible();
    await expect(barra.getByRole('button', { name: 'Tema oscuro' })).toBeVisible();
    await expect(barra.getByRole('button', { name: /^Menú de usuario/ })).toBeVisible();
    await expect(barra.getByRole('button', { name: /Notificaciones/ })).toHaveCount(0);
    await expect(barra.getByRole('button', { name: /Productos de FLIT/ })).toHaveCount(0);
    await expect(barra.getByRole('button')).toHaveCount(3);
  });

  test('aria-controls solo apunta a un panel que existe (axe aria-valid-attr-value)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await dockLocator(page).waitFor();

    const colgantes = () => page.evaluate(() => [...document.querySelectorAll('[aria-controls]')]
      .filter((el) => !document.getElementById(el.getAttribute('aria-controls')!))
      .map((el) => el.getAttribute('aria-controls')));
    expect(await colgantes()).toEqual([]);
    const trigger = dockLocator(page).getByRole('button', { name: 'Kyverum', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-controls', 'flit-navbar-panel-kyverum');
    // El riel: cada pestaña apunta a su tabpanel, que existe aunque esté oculto.
    await expect(page.getByRole('tab')).toHaveCount(7);
    expect(await colgantes()).toEqual([]);
  });

  // Épica #14560: el submenú se abre centrado sobre su ítem; solo se corre lo justo para no salirse del
  // margen de 12 px del viewport (MARGEN_PANEL de FlitNavBar → `--dock-desp`).
  for (const cual of ['primer', 'último'] as const) {
    test(`1366 px · el submenú del ${cual} ítem queda centrado sobre su disparador (o pegado al margen)`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await loginAs(page, ADMIN_USER);
      await mockApi(page);
      await page.goto('/');
      await dockLocator(page).waitFor();
      const disparadores = dockLocator(page).locator('button[aria-expanded]');
      expect(await disparadores.count()).toBeGreaterThan(1);
      const trigger = cual === 'primer' ? disparadores.first() : disparadores.last();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const panelEl = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
      await expect(panelEl).toBeVisible();
      // Esperar a que termine la animación de entrada (la caja se estabiliza).
      await expect.poll(async () => {
        const a = (await panelEl.boundingBox())!;
        await page.waitForTimeout(100);
        const b = (await panelEl.boundingBox())!;
        return Math.abs(a.x - b.x) + Math.abs(a.width - b.width);
      }).toBeLessThan(1);
      const t = (await trigger.boundingBox())!;
      const p = (await panelEl.boundingBox())!;
      const margen = 12;
      const recortadoIzq = p.x <= margen + 1;
      const recortadoDer = p.x + p.width >= 1366 - margen - 1;
      // Nunca se sale del margen.
      expect(p.x).toBeGreaterThanOrEqual(margen - 1);
      expect(p.x + p.width).toBeLessThanOrEqual(1366 - margen + 1);
      if (!recortadoIzq && !recortadoDer) {
        expect(Math.abs((p.x + p.width / 2) - (t.x + t.width / 2))).toBeLessThanOrEqual(4);
      } else {
        // Recortado: el panel sigue cubriendo al disparador horizontalmente (no queda «lejos» de él).
        expect(p.x).toBeLessThanOrEqual(t.x + t.width / 2);
        expect(p.x + p.width).toBeGreaterThanOrEqual(t.x + t.width / 2);
      }
    });
  }

  test('paneles sin scroll: rejilla plana, Gerencial con «Torre de Control» y Kyverum con su riel (teclado APG)', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    const nav = dockLocator(page);

    // Operaciones: rejilla plana de 3 columnas, sin subencabezados, sin scroll.
    await nav.getByRole('button', { name: 'Operaciones', exact: true }).click();
    const ops = page.locator('#flit-navbar-panel-operaciones');
    // Sus entradas (las que el admin del fixture ve: «Mi ruta» pide además su función), sin subencabezados.
    expect(await ops.getByRole('link').count()).toBeGreaterThanOrEqual(10);
    await expect(ops.locator('.rejilla-sub')).toHaveCount(0);
    expect(await ops.locator('ul.rejilla-entradas').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);
    expect(await sinScroll(ops)).toBe(0);

    // Gerencial: Tablero primero, sin subencabezado; luego «Torre de Control» con las ocho de la Torre.
    await nav.getByRole('button', { name: 'Gerencial', exact: true }).click();
    const ger = page.locator('#flit-navbar-panel-gerencial');
    await expect(ger.getByRole('link').first()).toHaveAttribute('href', '/');
    await expect(ger.locator('.rejilla-sub')).toHaveText(['Torre de Control']);
    await expect(ger.locator('.rejilla-sub + ul').getByRole('link')).toHaveCount(8);
    expect(await sinScroll(ger)).toBe(0);

    // Kyverum: riel vertical de siete subgrupos; sin página activa arranca en Tránsito.
    await nav.getByRole('button', { name: 'Kyverum', exact: true }).click();
    const kyv = page.locator('#flit-navbar-panel-kyverum');
    const riel = kyv.getByRole('tablist', { name: 'Subgrupos de Kyverum' });
    await expect(riel).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = riel.getByRole('tab');
    expect(await tabs.locator('.riel__nombre').allTextContents()).toEqual(['Tránsito', 'Flota', 'Mantenimiento', 'PESV', 'RNDC', 'LAFT', 'Trámites']);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.first()).toHaveAttribute('tabindex', '0');
    await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
    await expect(kyv.getByRole('tabpanel')).toHaveAccessibleName('Tránsito');

    // ↓ cambia con selección automática; Fin va al último; Inicio al primero; ↑ desde el primero va al último.
    await tabs.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(tabs.last()).toBeFocused();

    // PESV, el subgrupo mayor (25), cabe sin scroll.
    await riel.getByRole('tab', { name: 'PESV', exact: true }).click();
    await expect(kyv.getByRole('tabpanel').getByRole('link')).toHaveCount(25);
    await page.waitForTimeout(400);
    expect(await sinScroll(kyv)).toBe(0);
    const caja = (await kyv.boundingBox())!;
    expect(caja.y).toBeGreaterThanOrEqual(0);
  });

  test('proveedor solo ve lo suyo (SOAT) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = dockLocator(page);
    // Su Operaciones tiene una sola página: la opción se pinta como enlace directo con el nombre del ítem.
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('button')).toHaveCount(0);
    // Sin permiso de `/`, sin Tablero (HU #13452: el menú no ofrece lo que el guard cierra).
    await expect(nav.getByRole('link', { name: /^Tablero/ })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
  });
});

// Épica #14678 (spec UX §4): error y vacío van DENTRO de la cápsula del dock, sin toast ni caja propia.
test.describe('Shell · estados del dock', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('error: sin permisos efectivos, «No se pudo cargar el menú.» con «Reintentar»; al reintentar aparece el menú', async ({ page }) => {
    let falla = true;
    await loginAs(page, ADMIN_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => (falla
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMios(ADMIN_USER)) })));
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav.getByRole('alert')).toHaveText(COPY_MENU_ERROR);
    await expect(nav.getByRole('button', { name: 'Operaciones', exact: true })).toHaveCount(0);
    await expect(page.locator('.toast, [data-toast]')).toHaveCount(0);
    falla = false;
    await nav.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Operaciones', exact: true })).toBeVisible();
    await expect(nav.getByRole('alert')).toHaveCount(0);
  });

  test('cargando: mientras no llegan los permisos (tras el login), tres pastillas en la barra y ninguna opción', async ({ page }) => {
    // Tras el formulario, `/login` redirige al shell en cuanto hay usuario; `/permisos/mios` aún vuela.
    await mockApi(page);
    const me = sobreDeMe(ADMIN_USER);
    await page.route('**/api/auth/login', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'fake.jwt.e2e', user: me }) }));
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
    let soltar: () => void = () => undefined;
    const retenido = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(/\/api\/permisos\/mios$/, async (route) => {
      await retenido;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMios(ADMIN_USER)) });
    });

    const login = new LoginPage(page);
    await login.goto();
    await login.login('admin', 'clave-e2e');

    const nav = dockLocator(page);
    const esqueleto = nav.getByRole('status', { name: 'Cargando menú' });
    await expect(esqueleto).toBeVisible();
    await expect(esqueleto).toHaveAttribute('aria-busy', 'true');
    await expect(esqueleto).toHaveAttribute('data-kit', 'esqueleto');
    await expect(esqueleto.locator('.dock-esqueleto__pastilla')).toHaveCount(3);
    await expect(nav.getByRole('button')).toHaveCount(0);
    await expect(nav.getByRole('link')).toHaveCount(0);

    soltar();
    await expect(nav.getByRole('button', { name: 'Operaciones', exact: true })).toBeVisible();
    await expect(nav.getByRole('status', { name: 'Cargando menú' })).toHaveCount(0);
  });

  test('vacío: sin ninguna opción, el aviso con el siguiente paso dentro de la barra', async ({ page }) => {
    await loginAs(page, { ...MENSAJERO_USER, role: 'e2e_sin_modulos', allowedPages: [] }, { funciones: [] });
    await mockApi(page);
    await page.goto('/');
    const nav = dockLocator(page);
    await expect(nav.getByRole('status')).toHaveText(COPY_MENU_VACIO);
    await expect(nav.getByRole('button')).toHaveCount(0);
  });
});

// Spec UX §8: con `prefers-reduced-motion` nada se anima; el panel aparece al instante.
test('reduced-motion · el dock, el panel, sus entradas y el indicador no se animan', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  const nav = dockLocator(page);
  await nav.getByRole('button', { name: 'Operaciones', exact: true }).click();
  const panel = page.locator('#flit-navbar-panel-operaciones');
  await expect(panel).toBeVisible();
  const movimiento = await page.evaluate(() => {
    const leer = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { animacion: cs.animationName, transicion: cs.transitionDuration.split(',').every((d) => parseFloat(d) === 0) };
    };
    return {
      dock: leer('[data-vt="floating-nav"]'),
      panel: leer('#flit-navbar-panel-operaciones'),
      entrada: leer('#flit-navbar-panel-operaciones .rejilla-entradas > li'),
      indicador: leer('.dock__indicador'),
    };
  });
  expect(movimiento.dock).toEqual({ animacion: 'none', transicion: true });
  expect(movimiento.panel).toEqual({ animacion: 'none', transicion: true });
  expect(movimiento.entrada).toEqual({ animacion: 'none', transicion: true });
  expect(movimiento.indicador).toEqual({ animacion: 'none', transicion: true });
  // Al instante: opacidad plena en cuanto existe.
  expect(await panel.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

// El dock no ocupa sitio bajo el topbar: los offsets sticky de las páginas internas suman --flit-navbar-height
// al alto del topbar, así que el token tiene que valer cero. Y desde el pie, el panel solo puede abrir hacia
// arriba — 1024 px es el ancho donde el dock va más justo, Kyverum (con su riel) el panel más alto y Administración
// (penúltima) el panel más pegado al borde derecho.
for (const width of [1024, 1440]) {
  test(`${width}px · el dock vive al pie, no reserva alto arriba y abre hacia arriba`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await nav.waitFor();

    expect(await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--flit-navbar-height').trim(),
    )).toBe('0px');

    const dock = (await nav.boundingBox())!;
    expect(dock.y).toBeGreaterThan(900 / 2);

    // La primera, la más alta (Kyverum, con PESV elegido) y la penúltima (la más pegada al borde derecho).
    const paneles: Array<[import('@playwright/test').Locator, string]> = ['operaciones', 'kyverum', 'administracion']
      .map((id) => [nav.getByRole('button', { name: seccion(id), exact: true }), id]);
    for (const [trigger, id] of paneles) {
      await trigger.click();
      if (id === 'kyverum') await page.getByRole('tab', { name: 'PESV', exact: true }).click();
      // Se espera a que acabe la animación de entrada: falsearía el rect.
      await page.waitForTimeout(400);
      const panel = (await page.locator(`#flit-navbar-panel-${id}`).boundingBox())!;
      expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y + 1);
      expect(panel.y).toBeGreaterThanOrEqual(0);
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    }
  });
}

test('el dock no cambia de alto al bajar ni al volver arriba (sin oscilación)', async ({ page }) => {
  // El kit 2026 retiró el condensado por scroll: lo que se conserva de la intención original es que el
  // dock no oscile con el scroll (el rebote de layout no puede moverlo).
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const nav = dockLocator(page);
  await nav.waitFor();
  await alargarPagina(page);

  const alto = () => page.evaluate(() => {
    const el = document.querySelector('[data-vt="floating-nav"]');
    return el ? Math.round(el.getBoundingClientRect().height) : -1;
  });

  const inicial = await alto();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(700);
  expect(await alto()).toBe(inicial);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(300);
  expect(await alto()).toBe(inicial);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HU #11900 · el dock es UNA fila y enseña los nombres según el ancho (AC1, AC2, AC2b, AC3)
//
// La cápsula puede partirse en dos filas sin desbordar, así que «no wrappea» NO es observable a ojo. Medida:
//
//   · todas las píldoras con el mismo CENTRO vertical (±1 px), y
//   · el alto del dock es el de UNA fila: no supera el alto de la píldora más alta más el relleno de la cápsula.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Todo lo que el AC2b manda medir, en una sola lectura del DOM. `nombresVisibles` no se resuelve con
 * `toBeVisible()`: el nombre del grupo NO desaparece del DOM al condensar —pasa a oculto visualmente, que es lo
 * que exige el AC2—, así que la pregunta es si OCUPA ancho en pantalla, no si existe.
 */
async function medirDock(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-vt="floating-nav"]') as HTMLElement;
    const cs = getComputedStyle(nav);
    // Sin el indicador deslizante (decoración `aria-hidden`): solo las píldoras.
    const pildoras = Array.from(nav.querySelectorAll(':scope > .dock__grupo, :scope > a.dock__item')).map((k) => (
      (k.tagName === 'A' ? k : k.querySelector('button, a')) as HTMLElement
    ));
    const conRotulo = pildoras;
    const cajas = pildoras.map((p) => p.getBoundingClientRect());
    return {
      pildoras: pildoras.length,
      alto: Math.round(nav.getBoundingClientRect().height),
      altoDeUnaFila: Math.round(
        Math.max(...cajas.map((c) => c.height))
        + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        + (nav.offsetHeight - nav.clientHeight),
      ),
      centrosDistintos: Array.from(new Set(cajas.map((c) => Math.round((c.y + c.height / 2) / 2)))).length,
      dentro: cajas.every((c) => c.left >= 0 && c.right <= innerWidth),
      nombresVisibles: conRotulo.filter((p) => {
        const rotulo = p.querySelector(':scope > .dock__nombre');
        return rotulo instanceof HTMLElement && rotulo.offsetWidth > 1;
      }).length,
      // El nombre sigue en el DOM aunque no se vea: es el nombre accesible del trigger.
      nombresEnElDom: conRotulo.filter((p) => (p.textContent ?? '').trim().length > 0).length,
      conMas: nav.querySelector(':scope > [data-seccion="mas"]') !== null,
    };
  });
}

test('1920 px · el dock del admin es UNA fila y con los nombres a la vista (AC1)', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  // Con la página larga aparece la barra de desplazamiento y el hueco disponible encoge ~15 px.
  await alargarPagina(page);

  const m = await medirDock(page);
  // Épica #14678: las seis opciones del admin caben en la fila, sin «Más».
  expect(m.conMas).toBe(false);
  expect(m.pildoras).toBe(6);
  expect(m.centrosDistintos).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
  expect(m.dentro).toBe(true);
  expect(m.nombresVisibles).toBe(m.pildoras);
});

// Épica #14678 (spec UX §1 y §7): con las seis opciones la fila del admin cabe con nombres a 1440/1280/1024 px.
for (const width of [1440, 1280, 1024] as const) {
  test(`${width} px · una fila con las seis opciones, todas con nombre y sin «Más» (AC2, AC2b)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await dockLocator(page).waitFor();

    const m = await medirDock(page);
    // Las dos caras de la medida del AC2b (mismo evento medido dos veces; el AC las exige literalmente).
    expect(m.centrosDistintos).toBe(1);
    expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
    // Sin desbordar la pantalla: un `nowrap` roto pasaría las dos de arriba y moriría aquí.
    expect(m.dentro).toBe(true);
    // Toda píldora de la fila enseña su nombre.
    expect(m.nombresVisibles).toBe(m.pildoras);
    expect(m.conMas).toBe(false);
    expect(m.pildoras).toBe(6);
  });
}

test('1280 px · abrir un panel no cambia cuántas opciones caben', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();

  const antes = await medirDock(page);
  const trigger = dockLocator(page).getByRole('button', { name: 'Operaciones', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(400);

  const conPanel = await medirDock(page);
  expect(conPanel.centrosDistintos, 'el dock sigue en UNA fila con el panel abierto').toBe(1);
  expect(conPanel.alto, 'el dock no crece al abrir el panel').toBe(antes.alto);
  expect(conPanel.pildoras, 'no entra ni sale ninguna opción').toBe(antes.pildoras);
  expect(conPanel.nombresVisibles).toBe(conPanel.pildoras);
  expect(conPanel.conMas).toBe(false);
});

test('1920 px con scroll abajo · el dock sigue en una fila y con nombres', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  await alargarPagina(page);

  expect((await medirDock(page)).nombresVisibles).toBe(6);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  const m = await medirDock(page);
  expect(m.nombresVisibles).toBe(6);
  expect(m.centrosDistintos).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
});

test('1280 px · un rol con pocos módulos: una fila, con su nombre y centrado', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, PROVEEDOR_USER);
  await mockApi(page);
  await page.goto('/vehicles');
  await dockLocator(page).waitFor();

  const m = await medirDock(page);
  expect(m.pildoras).toBeLessThan(6);
  expect(m.nombresVisibles).toBe(m.pildoras);
  expect(m.centrosDistintos).toBe(1);
  const caja = (await dockLocator(page).boundingBox())!;
  expect(Math.abs(caja.x + caja.width / 2 - 640)).toBeLessThanOrEqual(20);
});

test('1023 px · bajo lg no hay dock: la navegación es el ☰ del topbar (AC3)', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  // 1023 es el píxel anterior a `lg`: sin dock, como en develop (`hidden lg:flex`).
  await expect(page.getByRole('button', { name: 'Abrir menú de navegación' })).toBeVisible();
  await expect(page.locator('[data-vt="floating-nav"]')).toHaveCount(0);
});

test('al final de la página el dock no tapa el pie legal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const nav = dockLocator(page);
  await nav.waitFor();
  await alargarPagina(page);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);

  // La pregunta no es "¿se ve el pie?" —estaría pintado igual debajo del dock— sino qué elemento hay
  // REALMENTE en ese punto de la pantalla.
  const pie = await page.evaluate(() => {
    // Kit 2026: el pie legal es la nota «ISO 27001 · Decreto 1079/2015» al final de <main> (AppShell).
    const el = [...document.querySelectorAll('main p')].find((p) => p.textContent?.includes('ISO 27001'));
    if (!el) return { error: 'no hay pie legal' };
    const b = el.getBoundingClientRect();
    const encima = document.elementFromPoint(b.left + 40, b.top + 6);
    return { visible: el.contains(encima) || encima === el };
  });
  expect(pie).toMatchObject({ visible: true });
});

for (const width of [360, 390]) test(`mobile ${width} px: sin dock; el ☰ cabe en la barra y abre el menú lateral`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const boton = page.getByRole('button', { name: 'Abrir menú de navegación' });
  await expect(boton).toBeVisible();
  await expect(page.locator('[data-vt="floating-nav"]')).toHaveCount(0);
  const caja = (await boton.boundingBox())!;
  expect(caja.x).toBeGreaterThanOrEqual(0);
  expect(caja.x + caja.width).toBeLessThanOrEqual(width);
  await boton.click();
  const menu = page.getByRole('dialog', { name: 'Menú de navegación' });
  await menu.getByRole('button', { name: 'Operaciones', exact: true }).click();
  await expect(menu.locator('#flit-menu-lateral-operaciones')).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11151 — SOAT e Impuestos dejan de ser exclusivos de su gestor: Operaciones entra por
// contingencia (Feature #11150). Lo que faltaba era la ENTRADA DE MENÚ, así que los tests miran la
// puerta —menú y buscador— y no el contenido de la cola. Épica #14678: viven en Operaciones (rejilla plana).
const PANEL_OPERACIONES = '#flit-navbar-panel-operaciones';
const buscadorTopbar = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^Buscar o ir a sección/ });

test.describe('Shell · SOAT e Impuestos abiertos a Operaciones (HU #11151)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Operaciones los ve en la opción Operaciones, sin el sufijo del gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page);
    await page.goto('/');

    await dockLocator(page).getByRole('button', { name: 'Operaciones', exact: true }).click();

    // `exact` es justo lo que comprueba el AC5: con «SOAT (gestor)» esto no pasaría.
    await expect(page.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Impuestos', exact: true })).toBeVisible();

    // Nada nombra a quien lo atiende.
    await expect(page.locator(PANEL_OPERACIONES)).not.toContainText('Colas de gestor');
    await expect(page.locator(PANEL_OPERACIONES)).not.toContainText('(gestor)');
  });

  for (const { label, url } of [
    { label: 'SOAT', url: /\/flito\/soat/ },
    { label: 'Impuestos', url: /\/flito\/impuestos/ },
  ]) {
    test(`Operaciones entra a ${label} desde el menú, sin pantalla de sin acceso`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockApi(page);
      await page.goto('/');

      await dockLocator(page).getByRole('button', { name: 'Operaciones', exact: true }).click();
      await page.getByRole('link', { name: label, exact: true }).click();

      await expect(page).toHaveURL(url);
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
      await expect(page.getByText(/No tienes acceso a/)).toHaveCount(0);
    });
  }

  test('el buscador se los ofrece a Operaciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page);
    await page.goto('/');

    const resultados = page.getByRole('listbox', { name: 'Resultados' });
    // Se abre por el botón del topbar y no por Ctrl+K: el atajo vive en un efecto del Layout y, como primera
    // interacción tras cargar, pierde la carrera con los efectos de montaje.
    for (const { query, label } of [
      { query: 'soat', label: 'SOAT' },
      { query: 'impuesto', label: 'Impuestos' },
    ]) {
      await buscadorTopbar(page).click();
      const buscador = page.getByPlaceholder('Buscar o ir a…');
      await expect(buscador).toBeVisible();
      await buscador.fill(query);
      await expect(resultados.getByRole('option', { name: label })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(buscador).toHaveCount(0);
    }
  });

  test('a cada gestor no le cambia nada: sigue viendo solo su cola', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    // Su Operaciones tiene un solo ítem: enlace directo, sin panel.
    const nav = dockLocator(page);
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Impuestos', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Operaciones', exact: true })).toHaveCount(0);
  });

  test('el gestor de impuestos ve Impuestos y no SOAT', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mockApi(page);
    await page.goto('/flito/impuestos');

    // Sus permisos dejan Operaciones con un solo ítem, y una opción de un ítem el dock la pinta como
    // enlace directo en vez de panel desplegable: aquí no hay botón «Operaciones» que abrir.
    const nav = dockLocator(page);
    await expect(nav.getByRole('button', { name: 'Operaciones', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Impuestos', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toHaveCount(0);
  });

  test('abrir el módulo a Operaciones no se lo abre a nadie más', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await mockApi(page);
    await page.goto('/');
    // El atajo ⌘K lo escucha `Layout`: esperar a un control suyo antes de teclear.
    await expect(buscadorTopbar(page)).toBeVisible();

    // Ni en el menú…
    await expect(page.getByRole('link', { name: 'SOAT', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Impuestos', exact: true })).toHaveCount(0);

    // …ni en el buscador…
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('soat');
    await expect(page.getByRole('option', { name: 'SOAT' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // …ni escribiendo la URL a mano: ahí responde el guard del router, no el menú.
    await page.goto('/flito/soat');
    await expect(page.getByText(/No tienes acceso a/)).toBeVisible();
  });
});
