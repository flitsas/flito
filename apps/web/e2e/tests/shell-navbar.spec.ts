// Shell sin sidebar — FlitNavBar, dock flotante al pie (HU #11143), revestido con el UI Kit 2026 (Épica #14560).
// Cubre: dónde vive el dock, apertura de grupos hacia arriba y dentro del viewport, subgrupos de los grupos
// grandes, una sola fila y nombres por ancho, contrato de teclado (disclosure APG + Escape que devuelve el foco),
// filtrado por permisos, e «Inicio» (el Tablero) como isotipo central solo con permiso.
//
// Cambios de diseño del kit 2026 que este spec recoge (docs/ux/rediseno-2026, dockGrupos.ts):
//   · reparto 3 + 3 por grupos de trabajo (Trámites · Impuestos y SOAT · Logística | Flota · Finanzas ·
//     Cumplimiento) en lugar de las 10 secciones del catálogo; «Tablero» pasa a ser el isotipo «Inicio» del centro;
//   · Administración y Ayuda salen del dock y viven en el menú de usuario del topbar;
//   · el condensado es del CSS del kit: >1100 px con nombres, ≤1100 px solo íconos (nombre en el DOM). No hay
//     condensado por scroll ni medición por JS, y no hay `title` en las píldoras;
//   · el dock cubre también tableta y teléfono: ya no hay hamburguesa ni drawer en <lg.
import { test, expect } from '../helpers/fixtures';
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

const GRUPOS_ADMIN = ['Trámites', 'Impuestos y SOAT', 'Logística', 'Flota', 'Finanzas', 'Cumplimiento'];

test.describe('Shell · FlitNavBar (dock de escritorio)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('admin ve los 6 grupos e «Inicio»; Administración y Ayuda en el menú de usuario; Cumplimiento abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav).toBeVisible();
    // Se afirma la CUENTA además de los nombres: perder o sumar un grupo no puede dejar esto en verde.
    await expect(nav.getByRole('button')).toHaveCount(6);
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
    for (const label of GRUPOS_ADMIN) {
      await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // Fuera del dock por diseño, pero no perdidos: viven en el menú de usuario.
    await expect(nav.getByRole('button', { name: 'Administración', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Menú de usuario/ }).click();
    const menuUsuario = page.getByRole('menu', { name: 'Opciones de usuario' });
    for (const item of [/^Usuarios/, /^Roles y permisos/, /^Ayuda/]) {
      await expect(menuUsuario.getByRole('menuitem', { name: item })).toBeVisible();
    }
    await page.getByRole('button', { name: /^Menú de usuario/ }).click();
    await expect(menuUsuario).toHaveCount(0);

    const trigger = nav.getByRole('button', { name: 'Cumplimiento', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    // Navegar desde el panel lo cierra y marca el grupo activo.
    await trigger.click();
    await page.getByRole('link', { name: 'Alcoholimetría', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\//);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveAttribute('aria-current', 'page');
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
    const trigger = dockLocator(page).getByRole('button', { name: 'Flota', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-controls', 'flit-navbar-panel-flota');
    expect(await colgantes()).toEqual([]);
  });

  test('los grupos grandes se abren repartidos en subgrupos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    // Se busca el <p> del título y no el texto a secas: hay subgrupos que se llaman igual que un ítem (RNDC).
    const titulo = (panel: string, grupo: string) =>
      page.locator(`#${panel} p`).filter({ hasText: new RegExp(`^${grupo}$`) });

    const nav = dockLocator(page);
    await nav.getByRole('button', { name: 'Cumplimiento', exact: true }).click();
    for (const grupo of ['PESV', 'LAFT', 'RNDC', 'Privacidad']) {
      await expect(titulo('flit-navbar-panel-cumplimiento', grupo)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Flota', exact: true }).click();
    for (const grupo of ['Activos', 'Taller']) {
      await expect(titulo('flit-navbar-panel-flota', grupo)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Impuestos y SOAT', exact: true }).click();
    for (const grupo of ['Obligaciones', 'Validación']) {
      await expect(titulo('flit-navbar-panel-impuestos-soat', grupo)).toBeVisible();
    }
  });

  test('proveedor solo ve lo suyo (SOAT) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = dockLocator(page);
    // Un grupo de un solo módulo es enlace directo.
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('button')).toHaveCount(0);
    // Sin permiso de `/`, sin «Inicio» (HU #13452: el menú no ofrece lo que el guard cierra).
    await expect(nav.getByRole('link', { name: 'Inicio', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
    await page.getByRole('button', { name: /^Menú de usuario/ }).click();
    await expect(page.getByRole('menuitem', { name: /^Usuarios/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Roles y permisos/ })).toHaveCount(0);
  });
});

// El dock no ocupa sitio bajo el topbar: los offsets sticky de las páginas internas suman --flit-navbar-height
// al alto del topbar, así que el token tiene que valer cero. Y desde el pie, el panel solo puede abrir hacia
// arriba — 1024 px es el ancho donde el dock va más justo, y Cumplimiento con sus cuatro columnas es el panel
// que destapa los desbordes.
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

    await nav.getByRole('button', { name: 'Cumplimiento', exact: true }).click();
    // Se espera a que acabe la animación de entrada: falsearía el rect.
    await page.waitForTimeout(300);
    const panel = (await page.locator('#flit-navbar-panel-cumplimiento').boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y + 1);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
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
//   · todas las píldoras con el mismo CENTRO vertical (±1 px) — el isotipo central es más alto que las
//     píldoras, así que la `y` de la caja no sirve —, y
//   · el alto del dock es el de UNA fila: no supera el alto de la píldora más alta más el relleno de la cápsula.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Todo lo que el AC2b manda medir, en una sola lectura del DOM. `nombresVisibles` no se resuelve con
 * `toBeVisible()`: el nombre del grupo NO desaparece del DOM al condensar —pasa a oculto visualmente, que es lo
 * que exige el AC2—, así que la pregunta es si OCUPA ancho en pantalla, no si existe. El isotipo «Inicio» no
 * lleva rótulo (su nombre es el `aria-label`) y no cuenta como nombre.
 */
async function medirDock(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-vt="floating-nav"]') as HTMLElement;
    const cs = getComputedStyle(nav);
    const pildoras = Array.from(nav.children).map((k) => (
      (k.tagName === 'A' ? k : k.querySelector('button, a')) as HTMLElement
    ));
    const conRotulo = pildoras.filter((p) => !p.classList.contains('dock__fab'));
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
        const rotulo = p.querySelector(':scope > span:not(.kico)');
        return rotulo instanceof HTMLElement && rotulo.offsetWidth > 1;
      }).length,
      // El nombre sigue en el DOM aunque no se vea: es el nombre accesible del trigger.
      nombresEnElDom: conRotulo.filter((p) => (p.textContent ?? '').trim().length > 0).length,
    };
  });
}

test('1440 px · el dock del admin es UNA fila y con los nombres a la vista (AC1)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  // Con la página larga aparece la barra de desplazamiento y el hueco disponible encoge ~15 px.
  await alargarPagina(page);

  const m = await medirDock(page);
  expect(m.pildoras).toBe(7);
  expect(m.centrosDistintos).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
  expect(m.dentro).toBe(true);
  expect(m.nombresVisibles).toBe(6);
});

for (const [width, nombres] of [[1280, 6], [1100, 0]] as const) {
  test(`${width} px · una fila, sin wrap y con el nombre en el DOM (AC2, AC2b)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await dockLocator(page).waitFor();

    const m = await medirDock(page);
    expect(m.pildoras).toBe(7);
    // Las dos caras de la medida del AC2b (mismo evento medido dos veces; el AC las exige literalmente).
    expect(m.centrosDistintos).toBe(1);
    expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
    // Sin desbordar la pantalla: un `nowrap` roto pasaría las dos de arriba y moriría aquí.
    expect(m.dentro).toBe(true);
    // Dock 3 + 3 con nombre en todo el rango >1100 px (ronda 2); ≤1100 solo íconos.
    expect(m.nombresVisibles).toBe(nombres);
    // Los seis nombres siguen en el árbol: el nombre accesible no cambia al condensar.
    expect(m.nombresEnElDom).toBe(6);
    await expect(dockLocator(page).getByRole('button', { name: 'Finanzas', exact: true })).toBeVisible();
  });
}

test('1100 px · el panel abierto NO deshace el condensado por ancho (enmienda §3 de la spec)', async ({ page }) => {
  // El panel abierto no puede «restaurar» los nombres de las píldoras a 1100: partiría el dock en dos filas con
  // el panel encima. La compensación: el panel sí enseña los nombres de sus ítems.
  await page.setViewportSize({ width: 1100, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();

  const condensado = await medirDock(page);
  expect(condensado.nombresVisibles).toBe(0);
  const altoEnIconos = condensado.alto;

  const trigger = dockLocator(page).getByRole('button', { name: 'Cumplimiento', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(400);

  const conPanel = await medirDock(page);
  expect(conPanel.centrosDistintos, 'el dock sigue en UNA fila con el panel abierto').toBe(1);
  expect(conPanel.alto, 'el dock no crece al abrir el panel').toBe(altoEnIconos);
  expect(conPanel.nombresVisibles, 'las píldoras siguen en iconos').toBe(0);
  await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

  // Con sitio de sobra, abrir un grupo no quita los nombres.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1920, height: 900 });
  await trigger.click();
  await expect.poll(async () => (await medirDock(page)).nombresVisibles).toBe(6);
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
  expect(m.pildoras).toBeLessThan(7);
  expect(m.nombresVisibles).toBe(m.pildoras);
  expect(m.centrosDistintos).toBe(1);
  const caja = (await dockLocator(page).boundingBox())!;
  expect(Math.abs(caja.x + caja.width / 2 - 640)).toBeLessThanOrEqual(20);
});

test('1023 px · bajo lg el dock sigue siendo la navegación: sin hamburguesa ni rail lateral (AC3)', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  // 1023 es el píxel anterior a `lg`. El kit 2026 retira el drawer: el dock cubre tableta y teléfono.
  const nav = dockLocator(page);
  await expect(nav).toBeVisible();
  const m = await medirDock(page);
  expect(m.centrosDistintos).toBe(1);
  expect(m.dentro).toBe(true);
  expect(m.nombresEnElDom).toBe(6);
  await expect(page.getByRole('button', { name: 'Abrir menú de navegación' })).toHaveCount(0);
  // Y los grupos siguen abriendo dentro de la pantalla.
  await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
  await page.waitForTimeout(300);
  const panel = (await page.locator('#flit-navbar-panel-finanzas').boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(1023);
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

test('mobile: el dock de íconos es la navegación, dentro de la pantalla y sin hamburguesa', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  const nav = dockLocator(page);
  await expect(nav).toBeVisible();
  const m = await medirDock(page);
  expect(m.dentro).toBe(true);
  expect(m.nombresVisibles).toBe(0);
  await expect(page.getByRole('button', { name: 'Abrir menú de navegación' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Trámites', exact: true }).click();
  await expect(page.locator('#flit-navbar-panel-tramites')).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11151 — SOAT e Impuestos dejan de ser exclusivos de su gestor: Operaciones entra por
// contingencia (Feature #11150). Lo que faltaba era la ENTRADA DE MENÚ, así que los tests miran la
// puerta —menú y buscador— y no el contenido de la cola. En el kit 2026 viven en «Impuestos y SOAT».
const PANEL_OBLIGACIONES = '#flit-navbar-panel-impuestos-soat';
const buscadorTopbar = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^Buscar placa, trámite o módulo/ });

test.describe('Shell · SOAT e Impuestos abiertos a Operaciones (HU #11151)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Operaciones los ve en «Impuestos y SOAT», sin el sufijo del gestor ni subgrupo por quien lo atiende', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page);
    await page.goto('/');

    await dockLocator(page).getByRole('button', { name: 'Impuestos y SOAT', exact: true }).click();

    // `exact` es justo lo que comprueba el AC5: con «SOAT (gestor)» esto no pasaría.
    await expect(page.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Impuestos', exact: true })).toBeVisible();

    // El subgrupo nombra su contenido, no a quien lo atiende.
    await expect(page.locator(`${PANEL_OBLIGACIONES} p`).filter({ hasText: /^Obligaciones$/ })).toBeVisible();
    await expect(page.locator(PANEL_OBLIGACIONES)).not.toContainText('Colas de gestor');
    await expect(page.locator(PANEL_OBLIGACIONES)).not.toContainText('(gestor)');
  });

  for (const { label, url } of [
    { label: 'SOAT', url: /\/flito\/soat/ },
    { label: 'Impuestos', url: /\/flito\/impuestos/ },
  ]) {
    test(`Operaciones entra a ${label} desde el menú, sin pantalla de sin acceso`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockApi(page);
      await page.goto('/');

      await dockLocator(page).getByRole('button', { name: 'Impuestos y SOAT', exact: true }).click();
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

    // Un grupo con un solo módulo se pinta como enlace directo.
    const nav = dockLocator(page);
    await expect(nav.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Impuestos', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Impuestos y SOAT', exact: true })).toHaveCount(0);
  });

  test('el gestor de impuestos ve Impuestos y no SOAT', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mockApi(page);
    await page.goto('/flito/impuestos');

    const nav = dockLocator(page);
    await expect(nav.getByRole('button', { name: 'Impuestos y SOAT', exact: true })).toHaveCount(0);
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
