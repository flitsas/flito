// Shell sin sidebar — FlitNavBar, dock flotante al pie (HU #11143), revestido con el UI Kit 2026 (Épica #14560).
// Cubre: dónde vive el dock, apertura de secciones hacia arriba y dentro del viewport, subgrupos de las secciones
// grandes, una sola fila y nombres por ancho, contrato de teclado (disclosure APG + Escape que devuelve el foco)
// y filtrado por permisos.
//
// Estructura = la del menú original; piel = la del kit 2026 (docs/ux/rediseno-2026):
//   · un botón por sección del catálogo de permisos, en SECTION_ORDER y con sus nombres (General, Gestión,
//     Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración, Ayuda); una sección de una sola
//     página es enlace directo con el nombre del ítem (General → Tablero). Sin isotipo central ni reagrupado;
//   · «Más» medido (desde 1024 px): las secciones que caben van con nombre; las que no, en el panel del «Más», en el
//     mismo orden. Ya no hay modo solo-íconos;
//   · la barra superior no tiene Notificaciones ni la rejilla de Productos;
//   · <1024 px no hay dock: ☰ en el topbar + menú lateral (lo cubre shell-menu-responsive.spec.ts).
import { test, expect } from '../helpers/fixtures';
import { ARBOL_PERMISOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import {
  loginAs, ADMIN_USER, PROVEEDOR_USER, OPERACIONES_USER, GESTOR_IMPUESTOS_USER, CONDUCTOR_USER,
} from '../helpers/auth';

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

/** Lo que el admin ve en el dock, en orden: SECTION_ORDER; General, Flota y Ayuda tienen un solo ítem (enlace). */
const DOCK_ADMIN = () => [
  item('dashboard'), seccion('gestion'), seccion('transito'), item('fleet'), seccion('mantenimiento'),
  seccion('pesv'), seccion('rndc'), seccion('laft'), seccion('finanzas'), seccion('administracion'), seccion('ayuda'),
];

/** Nombres de las píldoras del dock en el orden del DOM (el rótulo sigue en el DOM aunque se condense). */
const nombresDelDock = (page: import('@playwright/test').Page) => page.evaluate(() =>
  Array.from(document.querySelector('[data-vt="floating-nav"]')!.children)
    .map((k) => (k.querySelector('.dock__nombre')?.textContent ?? '').trim()));

// A 1920 px caben las 11 secciones del admin con nombre (sin «Más»); el «Más» se prueba aparte.
test.describe('Shell · FlitNavBar (dock de escritorio)', () => {
  test.use({ viewport: { width: 1920, height: 900 } });

  test('admin ve las 11 secciones del menú original en su orden, sin isotipo; PESV abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav).toBeVisible();
    // La CUENTA además de los nombres: perder o sumar una sección no puede dejar esto en verde.
    await expect(nav.getByRole('button')).toHaveCount(8);
    await expect(nav.getByRole('link')).toHaveCount(3);
    expect(await nombresDelDock(page)).toEqual(DOCK_ADMIN());
    await expect(nav.getByRole('link').last()).toHaveAccessibleName('Ayuda');
    // Sin los grupos propios del kit ni el isotipo «Inicio».
    for (const grupo of ['Trámites', 'Impuestos y SOAT', 'Logística', 'Cumplimiento', 'Más']) {
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

    const pesvTrigger = nav.getByRole('button', { name: 'PESV', exact: true });
    await pesvTrigger.click();
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pesvTrigger).toBeFocused();

    // Navegar desde el panel lo cierra y marca la sección activa.
    await pesvTrigger.click();
    await page.getByRole('link', { name: 'Conductores', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\/conductores/);
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pesvTrigger).toHaveAttribute('aria-current', 'page');

    // Administración abre con sus ítems del catálogo.
    await nav.getByRole('button', { name: seccion('administracion'), exact: true }).click();
    for (const slug of ['users', 'roles_permisos']) {
      await expect(page.locator('#flit-navbar-panel-admin').getByRole('link', { name: new RegExp(`^${item(slug)}`) })).toBeVisible();
    }
  });

  test('la barra superior: marca, buscador, tema y usuario; sin Notificaciones ni Productos de FLIT', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    const barra = page.getByRole('banner');
    await expect(barra.getByRole('link', { name: 'FLITO, ir al inicio' })).toBeVisible();
    await expect(barra.getByRole('button', { name: /^Buscar placa, trámite o módulo/ })).toBeVisible();
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
    const trigger = dockLocator(page).getByRole('button', { name: 'Mantenimiento', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-controls', 'flit-navbar-panel-mantenimiento');
    expect(await colgantes()).toEqual([]);
  });

  test('las secciones grandes se abren repartidas en subgrupos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    // Se busca el <p> del título y no el texto a secas: hay subgrupos que se llaman igual que un ítem (Logística).
    const titulo = (panel: string, grupo: string) =>
      page.locator(`#${panel} p`).filter({ hasText: new RegExp(`^${grupo}$`) });

    const nav = dockLocator(page);
    await nav.getByRole('button', { name: 'PESV', exact: true }).click();
    for (const grupo of ['Dirección', 'Operación', 'Personas', 'Cumplimiento']) {
      await expect(titulo('flit-navbar-panel-pesv', grupo)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Gestión', exact: true }).click();
    for (const grupo of ['Trámites', 'Logística', 'Maestros', 'SOAT e Impuestos', 'Comparendos', 'Auditoría']) {
      await expect(titulo('flit-navbar-panel-gestion', grupo)).toBeVisible();
    }
  });

  test('proveedor solo ve lo suyo (SOAT) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = dockLocator(page);
    // Su Gestión tiene una sola página: la sección se pinta como enlace directo con el nombre del ítem.
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('button')).toHaveCount(0);
    // Sin permiso de `/`, sin Tablero (HU #13452: el menú no ofrece lo que el guard cierra).
    await expect(nav.getByRole('link', { name: /^Tablero/ })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
  });
});

// El dock no ocupa sitio bajo el topbar: los offsets sticky de las páginas internas suman --flit-navbar-height
// al alto del topbar, así que el token tiene que valer cero. Y desde el pie, el panel solo puede abrir hacia
// arriba — 1024 px es el ancho donde el dock va más justo, PESV con sus cuatro subgrupos es el panel que destapa
// los desbordes, y Administración (penúltima) el panel estrecho más pegado al borde derecho.
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

    // Gestión (siempre en la fila, el panel más ancho) y el «Más» (el último, pegado al borde derecho). Qué
    // secciones quedan en el «Más» depende del ancho: lo mide el dock, el test no lo fija.
    const mas = nav.getByRole('button', { name: 'Más', exact: true });
    const paneles: Array<[import('@playwright/test').Locator, string]> = [[nav.getByRole('button', { name: 'Gestión', exact: true }), 'gestion']];
    if (await mas.count()) paneles.push([mas, 'mas']);
    for (const [trigger, id] of paneles) {
      await trigger.click();
      // Se espera a que acabe la animación de entrada: falsearía el rect.
      await page.waitForTimeout(300);
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
    const pildoras = Array.from(nav.children).map((k) => (
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
  expect(m.pildoras).toBe(11);
  expect(m.centrosDistintos).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
  expect(m.dentro).toBe(true);
  expect(m.nombresVisibles).toBe(11);
});

// Con 11 secciones la fila del admin con nombres no cabe a 1440/1280/1024 px: las que caben van CON nombre y el
// resto pasa al «Más» (nunca solo íconos). Fila + «Más» = las 11, sin perder ni repetir ninguna.
for (const width of [1440, 1280, 1024] as const) {
  test(`${width} px · una fila, todas con nombre y el resto en «Más» (AC2, AC2b)`, async ({ page }) => {
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
    // Toda píldora de la fila enseña su nombre, «Más» incluido.
    expect(m.nombresVisibles).toBe(m.pildoras);
    expect(m.conMas).toBe(true);
    const mas = dockLocator(page).getByRole('button', { name: 'Más', exact: true });
    await mas.click();
    const enMas = await page.locator('#flit-navbar-panel-mas .dock__seccion').count();
    expect(m.pildoras - 1 + enMas).toBe(11);
  });
}

test('1280 px · abrir un panel no cambia cuántas secciones caben', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();

  const antes = await medirDock(page);
  const trigger = dockLocator(page).getByRole('button', { name: 'Gestión', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(400);

  const conPanel = await medirDock(page);
  expect(conPanel.centrosDistintos, 'el dock sigue en UNA fila con el panel abierto').toBe(1);
  expect(conPanel.alto, 'el dock no crece al abrir el panel').toBe(antes.alto);
  expect(conPanel.pildoras, 'no entra ni sale ninguna sección del «Más»').toBe(antes.pildoras);
  expect(conPanel.nombresVisibles).toBe(conPanel.pildoras);

  // Con sitio de sobra, todas vuelven a la fila y el «Más» desaparece.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(async () => (await medirDock(page)).nombresVisibles).toBe(11);
  await expect(dockLocator(page).getByRole('button', { name: 'Más', exact: true })).toHaveCount(0);
});

test('1920 px con scroll abajo · el dock sigue en una fila y con nombres', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  await alargarPagina(page);

  expect((await medirDock(page)).nombresVisibles).toBe(11);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  const m = await medirDock(page);
  expect(m.nombresVisibles).toBe(11);
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
  expect(m.pildoras).toBeLessThan(11);
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
  await menu.getByRole('button', { name: 'Gestión', exact: true }).click();
  await expect(menu.locator('#flit-menu-lateral-gestion')).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11151 — SOAT e Impuestos dejan de ser exclusivos de su gestor: Operaciones entra por
// contingencia (Feature #11150). Lo que faltaba era la ENTRADA DE MENÚ, así que los tests miran la
// puerta —menú y buscador— y no el contenido de la cola. Viven en Gestión, subgrupo «SOAT e Impuestos».
const PANEL_GESTION = '#flit-navbar-panel-gestion';
const buscadorTopbar = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^Buscar placa, trámite o módulo/ });

test.describe('Shell · SOAT e Impuestos abiertos a Operaciones (HU #11151)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Operaciones los ve en Gestión, sin el sufijo del gestor y bajo el subgrupo renombrado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page);
    await page.goto('/');

    await dockLocator(page).getByRole('button', { name: 'Gestión', exact: true }).click();

    // `exact` es justo lo que comprueba el AC5: con «SOAT (gestor)» esto no pasaría.
    await expect(page.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Impuestos', exact: true })).toBeVisible();

    // El subgrupo nombra su contenido, no a quien lo atiende.
    await expect(page.locator(`${PANEL_GESTION} p`).filter({ hasText: /^SOAT e Impuestos$/ })).toBeVisible();
    await expect(page.locator(PANEL_GESTION)).not.toContainText('Colas de gestor');
    await expect(page.locator(PANEL_GESTION)).not.toContainText('(gestor)');
  });

  for (const { label, url } of [
    { label: 'SOAT', url: /\/flito\/soat/ },
    { label: 'Impuestos', url: /\/flito\/impuestos/ },
  ]) {
    test(`Operaciones entra a ${label} desde el menú, sin pantalla de sin acceso`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockApi(page);
      await page.goto('/');

      await dockLocator(page).getByRole('button', { name: 'Gestión', exact: true }).click();
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

    // Su Gestión tiene un solo ítem: enlace directo, sin panel.
    const nav = dockLocator(page);
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Impuestos', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Gestión', exact: true })).toHaveCount(0);
  });

  test('el gestor de impuestos ve Impuestos y no SOAT', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mockApi(page);
    await page.goto('/flito/impuestos');

    // Sus permisos dejan Gestión con un solo ítem, y una sección de un ítem el dock la pinta como
    // enlace directo en vez de panel desplegable: aquí no hay botón «Gestión» que abrir.
    const nav = dockLocator(page);
    await expect(nav.getByRole('button', { name: 'Gestión', exact: true })).toHaveCount(0);
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
