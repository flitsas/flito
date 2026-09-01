// Shell sin sidebar — FlitNavBar, dock flotante al pie (HU #11143).
// Cubre: dónde vive el dock, apertura de módulos hacia arriba y dentro del
// viewport, subgrupos de los módulos grandes, condensado por scroll, contrato
// de teclado (disclosure APG + Escape que devuelve el foco), filtrado por
// permisos y drawer mobile como única navegación en <lg.
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
    if (route.request().url().includes('/auth/me')) return route.fallback();
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
    document.querySelector('main')?.appendChild(relleno);
  });
}

const dockLocator = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Navegación principal' });

test.describe('Shell · FlitNavBar (dock de escritorio)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('admin ve los 10 módulos, Finanzas incluida; el panel de PESV abre, navega y cierra', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    const nav = dockLocator(page);
    await expect(nav).toBeVisible();
    // Módulos de 1 ítem → link directo; el resto → trigger de disclosure.
    //
    // HU #11900, AC8 — este bloque decía «los 9 módulos» y no nombraba Finanzas, mientras
    // `navItems.ts` declara diez secciones desde el PR #130. Y el desfase era doble: «Tablero»
    // figuraba como link de primer nivel, y dejó de serlo cuando «Ayuda FLITO» entró en la misma
    // sección —dos ítems hacen de «General» un disclosure— así que el link con ese nombre pasó a
    // vivir DENTRO del panel. Las dos cosas son deuda anterior a esta HU: el spec afirmaba un
    // menú que ya no existía y por eso no habría visto ninguna de las dos.
    //
    // Se afirma también la CUENTA. Sin ella, añadir una sección undécima —o perder una— dejaría
    // este test en verde: comprobar diez nombres no es comprobar que son diez.
    await expect(nav.getByRole('button')).toHaveCount(9);
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Flota', exact: true })).toBeVisible();
    for (const label of ['General', 'Gestión', 'Tránsito', 'Mantenimiento', 'PESV', 'RNDC',
      'Cumplimiento', 'Finanzas', 'Administración']) {
      await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // «Tablero» sigue existiendo, dentro de «General»: la deuda era del spec, no del menú.
    await nav.getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Tablero', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    const pesvTrigger = nav.getByRole('button', { name: 'PESV', exact: true });
    await pesvTrigger.click();
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

    // Esc cierra y devuelve el foco al trigger.
    await page.keyboard.press('Escape');
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pesvTrigger).toBeFocused();

    // Navegar desde el panel lo cierra y marca el módulo activo.
    await pesvTrigger.click();
    await page.getByRole('link', { name: 'Conductores', exact: true }).click();
    await expect(page).toHaveURL(/\/pesv\/conductores/);
    await expect(pesvTrigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('los módulos grandes se abren repartidos en subgrupos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');

    // Se busca el <p> del título y no el texto a secas: hay subgrupos que se
    // llaman igual que un ítem del propio panel (Logística es las dos cosas).
    const titulo = (panel: string, grupo: string) =>
      page.locator(`#${panel} p`).filter({ hasText: new RegExp(`^${grupo}$`) });

    const nav = dockLocator(page);
    await nav.getByRole('button', { name: 'PESV', exact: true }).click();
    for (const grupo of ['Dirección', 'Operación', 'Personas', 'Cumplimiento']) {
      await expect(titulo('flit-navbar-panel-pesv', grupo)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Gestión', exact: true }).click();
    for (const grupo of ['Trámites', 'Logística', 'Maestros']) {
      await expect(titulo('flit-navbar-panel-gestion', grupo)).toBeVisible();
    }
  });

  test('proveedor solo ve Gestión (vehicles + soat) — role-gating', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mockApi(page);
    await page.goto('/vehicles');

    const nav = dockLocator(page);
    await expect(nav.getByRole('button', { name: 'Gestión' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'PESV' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Administración' })).toHaveCount(0);

    await nav.getByRole('button', { name: 'Gestión' }).click();
    await expect(page.getByRole('link', { name: 'Vehículos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SOAT' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trámite Digital' })).toHaveCount(0);
  });
});

// El dock no ocupa sitio bajo el topbar: los offsets sticky de las páginas
// internas suman --flit-navbar-height al alto del topbar, así que ahora el
// token tiene que valer cero. Y desde el pie, el panel solo puede abrir hacia
// arriba — 1024px es el ancho donde el dock va más justo, y PESV con sus cuatro
// columnas es el panel que destapa los desbordes.
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

    await nav.getByRole('button', { name: 'PESV', exact: true }).click();
    // Se espera a que acabe la animación de entrada: mide 6px de translateY y
    // falsearía el rect.
    await page.waitForTimeout(300);
    const panel = (await page.locator('#flit-navbar-panel-pesv').boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y + 1);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  });
}

test('el dock se condensa al bajar, no oscila y se reexpande arriba', async ({ page }) => {
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

  const expandido = await alto();

  await page.mouse.wheel(0, 600);
  await expect.poll(alto).toBeLessThan(expandido);

  // No oscila: el rebote de scroll que provoca el propio cambio de layout no
  // puede devolverlo a expandido.
  await page.waitForTimeout(700);
  expect(await alto()).toBeLessThan(expandido);

  await page.mouse.wheel(0, -900);
  await expect.poll(alto).toBe(expandido);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HU #11900 · el dock se condensa por ANCHO, y eso se MIDE (AC1, AC2, AC2b, AC3)
//
// La cápsula lleva `flex-wrap`, así que «no wrappea» NO es observable a ojo: cuando no cabe, el
// dock no desborda ni recorta — se parte en dos filas y sigue pareciendo un dock. El AC2b fija por
// eso una medida y prohíbe inventar otra:
//
//   · todas las píldoras con la MISMA coordenada `y` (±1 px), y
//   · el alto del dock es el de UNA fila: no supera el alto de una píldora más el relleno de la
//     cápsula.
//
// Se afirman las dos porque el AC las exige literalmente, NO porque cubran dos fallos distintos:
// son el mismo evento medido dos veces. Ver el comentario del bloque de 1280/1100, que lo explica
// con la medición que lo comprobó.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Todo lo que el AC2b manda medir, en una sola lectura del DOM.
 *
 * `nombresVisibles` no se resuelve con `toBeVisible()` sobre un rótulo: el nombre del módulo NO
 * desaparece del DOM al condensar —pasa a `sr-only`, que es lo que exige el AC2— así que la
 * pregunta es si OCUPA ancho en pantalla, no si existe.
 */
async function medirDock(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-vt="floating-nav"]') as HTMLElement;
    const cs = getComputedStyle(nav);
    const pildoras = Array.from(nav.children).map((k) => (
      (k.tagName === 'A' ? k : k.querySelector('button, a')) as HTMLElement
    ));
    const cajas = pildoras.map((p) => p.getBoundingClientRect());
    return {
      pildoras: pildoras.length,
      alto: Math.round(nav.getBoundingClientRect().height),
      altoDeUnaFila: Math.round(
        Math.max(...cajas.map((c) => c.height))
        + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        + (nav.offsetHeight - nav.clientHeight),
      ),
      ysDistintas: Array.from(new Set(cajas.map((c) => Math.round(c.y)))).length,
      nombresVisibles: pildoras.filter((p) => {
        const rotulo = p.querySelector('span:not(.sr-only)');
        return rotulo instanceof HTMLElement && rotulo.offsetWidth > 0;
      }).length,
      // El nombre sigue en el DOM aunque no se vea: es el nombre accesible del trigger.
      nombresEnElDom: pildoras.filter((p) => (p.textContent ?? '').trim().length > 0).length,
      conTooltip: pildoras.filter((p) => (p.getAttribute('title') ?? '').length > 0).length,
    };
  });
}

test('1440 px · el dock del admin es UNA fila y con los nombres a la vista (AC1)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  // Con la página larga aparece la barra de desplazamiento y el hueco disponible encoge ~15 px:
  // es el caso REAL de la pantalla del operador y el que menos margen deja al «cabe a 1440».
  await alargarPagina(page);

  const m = await medirDock(page);
  expect(m.pildoras).toBe(10);
  expect(m.ysDistintas).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
  // Los diez nombres a la vista: a 1440 el condensado por ancho NO debe entrar.
  expect(m.nombresVisibles).toBe(10);
  // Y sin tooltip: repetir en un `title` el texto que está al lado es ruido.
  expect(m.conTooltip).toBe(0);
});

for (const width of [1280, 1100]) {
  test(`${width} px · una fila de ICONOS, sin wrap y con el nombre en el DOM (AC2, AC2b)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await dockLocator(page).waitFor();

    const m = await medirDock(page);
    expect(m.pildoras).toBe(10);

    // La medida del AC2b, por sus dos caras. **Y las dos caras NO son dos salvaguardas
    // independientes**, que es justo lo que parece y lo que hay que dejar escrito para que nadie
    // «simplifique» este bloque:
    //
    //   · en cualquier estado de UNA fila, `alto === altoDeUnaFila` EXACTAMENTE — el alto del dock
    //     es el de su píldora más el relleno de la cápsula, por construcción;
    //   · lo único que sube ese alto es el wrap, y el wrap produce necesariamente una segunda
    //     coordenada `y`.
    //
    // O sea que son el MISMO evento medido dos veces. Se conservan porque el AC2b las exige
    // literalmente («todas las píldoras comparten la misma `y`» **y** «el alto es el de una
    // fila»), no porque cubran dos fallos distintos.
    //
    // Lo que de verdad NO cubren, medido: con `flex-nowrap` en la cápsula, el dock mide 1381 px en
    // un hueco de 1068 y se sale ~300 px fuera de la pantalla — y las dos aserciones de abajo lo
    // dan por BUENO (una sola fila, un solo alto). El caso lo mata `nombresVisibles === 0`, que es
    // del AC2, no del AC2b. Por eso ese aserto no es decorativo y por eso la cápsula conserva su
    // `flex-wrap`: sin él, un condensado roto se pinta como desbordamiento invisible para la
    // medida en vez de como dos filas.
    expect(m.ysDistintas).toBe(1);
    expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
    // Iconos: ningún rótulo ocupa ancho…
    expect(m.nombresVisibles).toBe(0);
    // …pero los diez nombres siguen en el árbol y además hay tooltip para quien solo ve el icono.
    expect(m.nombresEnElDom).toBe(10);
    expect(m.conTooltip).toBe(10);
    // El nombre accesible no cambia al condensar: es lo que hace que el `sr-only` sea la fuente
    // del nombre y el `title` un extra. Si el rótulo se hubiera borrado del DOM, esto no pasaría.
    await expect(dockLocator(page).getByRole('button', { name: 'Finanzas', exact: true })).toBeVisible();
  });
}

test('1100 px · el panel abierto NO deshace el condensado por ancho (enmienda §3 de la spec)', async ({ page }) => {
  // La spec §3 decía «un panel abierto fuerza expansión (ya existe)» sin distinguir de qué
  // condensado hablaba, y leída literal choca con «una fila SIEMPRE» del párrafo anterior. La
  // enmienda del 26 ago 2026 en docs/ux/shell-tema-y-responsive.md separa los dos casos: el panel
  // deshace el condensado por SCROLL —para el que se escribió— y NUNCA el de ancho.
  //
  // Este TC existe porque sin él nada sujeta esa distinción: la próxima HU que lea el párrafo
  // original «restauraría» la expansión y la suite entera seguiría verde. Lo que pasaría de verdad
  // está medido: a 1100 px la fila expandida necesita 1381 px en un hueco de 1068, o sea
  // `ysDistintas: 2` y 104 px de alto — el dock partido en dos CON un panel abierto encima.
  //
  // Qué mata este TC y qué NO, comprobado con dos mutantes en vez de suponerlo:
  //   · `condensed = openSection ? false : (…)` —la lectura literal del párrafo original, y la
  //     forma en que cualquiera lo implementaría— muere aquí: `ysDistintas` 1 → 2.
  //   · añadir `setCondensadoPorAncho(false)` al efecto que abre el panel TAMBIÉN muere aquí
  //     (`ysDistintas` 1 → 2). Una versión anterior de este comentario lo declaraba «mutante
  //     equivalente» y explicaba que `medir()` recondensaría antes de pintar: era FALSO, y era un
  //     modelo equivocado del código. `medir()` cierra sus dos puertas sobre
  //     `anchoRef.current.condensado`, que ese mutante no toca: calcula `siguiente = true`, lo
  //     compara con un `ref` que sigue en `true`, y NO llama al setter. El estado queda
  //     desincronizado del ref y el dock se parte en dos filas. Este TC es más fuerte de lo que
  //     aquel comentario anunciaba: mata los dos mutantes, no uno.
  await page.setViewportSize({ width: 1100, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();

  const condensado = await medirDock(page);
  expect(condensado.nombresVisibles).toBe(0);
  const altoEnIconos = condensado.alto;

  const pesv = dockLocator(page).getByRole('button', { name: 'PESV', exact: true });
  await pesv.click();
  await expect(pesv).toHaveAttribute('aria-expanded', 'true');
  // La animación de la píldora mide 200 ms: sin esperar, un alto intermedio no probaría nada.
  await page.waitForTimeout(400);

  const conPanel = await medirDock(page);
  expect(conPanel.ysDistintas, 'el dock sigue en UNA fila con el panel abierto').toBe(1);
  expect(conPanel.alto, 'el dock no crece al abrir el panel').toBe(altoEnIconos);
  expect(conPanel.nombresVisibles, 'las píldoras siguen en iconos').toBe(0);

  // Y la compensación que hace aceptable lo anterior: el panel abierto SÍ enseña los nombres de
  // sus ítems, que es lo que el usuario está mirando. No se pierde ningún rótulo, cambia dónde.
  await expect(page.getByRole('link', { name: 'Alcoholimetría' })).toBeVisible();

  // La otra mitad de la enmienda, la que no se toca: el panel SIGUE deshaciendo el condensado por
  // SCROLL. A 1920 px hay sitio de sobra, así que ahí el único condensado posible es el del scroll
  // y abrir un módulo tiene que devolver los nombres.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1920, height: 900 });
  await alargarPagina(page);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await medirDock(page)).nombresVisibles).toBe(0);

  await dockLocator(page).getByRole('button', { name: 'PESV', exact: true }).click();
  await expect.poll(async () => (await medirDock(page)).nombresVisibles,
    { message: 'con sitio de sobra, el panel abierto sí reexpande' }).toBe(10);
});

test('1920 px con scroll abajo · el condensado por scroll NO se pierde: se SUMA al de ancho', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');
  await dockLocator(page).waitFor();
  await alargarPagina(page);

  // A 1920 sobra sitio: arriba de página el dock enseña los nombres.
  expect((await medirDock(page)).nombresVisibles).toBe(10);

  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await medirDock(page)).nombresVisibles).toBe(0);
  // Y sigue siendo una fila, claro.
  const m = await medirDock(page);
  expect(m.ysDistintas).toBe(1);
  expect(m.alto).toBeLessThanOrEqual(m.altoDeUnaFila);
});

test('1100 px · un rol con pocos módulos NO se condensa: la cota es el ancho ocupado, no un breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await loginAs(page, PROVEEDOR_USER);
  await mockApi(page);
  await page.goto('/vehicles');
  await dockLocator(page).waitFor();

  // Este es el test que separa «medir» de «poner un `xl:` de Tailwind»: al proveedor le sobran
  // 800 px a 1100 y con un breakpoint ciego estaría viendo iconos sin motivo. Un `lg:`/`xl:`
  // aplicado a todos pasaría los dos tests de arriba y moriría aquí.
  const m = await medirDock(page);
  expect(m.pildoras).toBeLessThan(10);
  expect(m.nombresVisibles).toBe(m.pildoras);
  expect(m.ysDistintas).toBe(1);
});

test('1023 px · bajo lg no hay dock: hamburguesa y drawer, y ningún rail lateral (AC3)', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  // 1023 es el píxel anterior a `lg`: la frontera exacta, no «una pantalla pequeña».
  await expect(dockLocator(page)).toBeHidden();
  await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menú de navegación' });
  await expect(drawer).toBeVisible();
  // Las secciones con NOMBRE visible — el drawer no condensa — y Finanzas entre ellas (AC8).
  for (const label of ['General', 'Gestión', 'Finanzas', 'Administración']) {
    await expect(drawer.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // El rail lateral de escritorio sigue descartado (decisión PO 2026-06-12): cerrado el drawer,
  // en <lg no queda ninguna navegación permanente en pantalla.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(dockLocator(page)).toBeHidden();
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
  await page.waitForTimeout(400); // el dock se condensa al bajar

  // La pregunta no es "¿se ve el pie?" —estaría pintado igual debajo del dock—
  // sino qué elemento hay REALMENTE en ese punto de la pantalla.
  const pie = await page.evaluate(() => {
    const el = document.querySelector('footer');
    if (!el) return { error: 'no hay pie legal' };
    const b = el.getBoundingClientRect();
    const encima = document.elementFromPoint(b.left + 40, b.top + 6);
    return { visible: el.contains(encima) || encima === el };
  });
  expect(pie).toMatchObject({ visible: true });
});

test('mobile: navbar oculta, hamburguesa abre el drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, ADMIN_USER);
  await mockApi(page);
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeHidden();
  await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
  await expect(page.getByRole('dialog', { name: 'Menú de navegación' })).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11151 — SOAT e Impuestos dejan de ser exclusivos de su gestor: Operaciones entra por
// contingencia (Feature #11150). Ojo con lo que se prueba aquí: el permiso de PÁGINA ya lo tenía
// admin (`ROLE_DEFAULT_PAGES.admin` es el catálogo entero) y el servidor nunca le aplicó frontera.
// Lo que faltaba era la ENTRADA DE MENÚ, porque `navItems` filtraba por `roles` y admin no estaba
// en la lista. Por eso los tests miran la puerta —menú y buscador— y no el contenido de la cola.
const PANEL_GESTION = '#flit-navbar-panel-gestion';

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

    // El subgrupo dejó de llamarse por quien lo atiende y pasó a nombrar su contenido.
    await expect(
      page.locator(`${PANEL_GESTION} p`).filter({ hasText: /^SOAT e Impuestos$/ }),
    ).toBeVisible();
    await expect(page.locator(PANEL_GESTION)).not.toContainText('Colas de gestor');
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
    // Se abre por el botón del topbar y no por Ctrl+K: el atajo vive en un efecto del Layout y,
    // como primera interacción tras cargar, pierde la carrera con los efectos de montaje. El botón
    // además solo existe con el shell ya pintado, que es justo la garantía que hace falta aquí.
    const abrirBuscador = page.getByRole('button', { name: /^Buscar o ir a sección/ });

    for (const { query, label } of [
      { query: 'soat', label: 'SOAT' },
      { query: 'impuesto', label: 'Impuestos' },
    ]) {
      await abrirBuscador.click();
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

    await dockLocator(page).getByRole('button', { name: 'Gestión', exact: true }).click();
    await expect(page.getByRole('link', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Impuestos', exact: true })).toHaveCount(0);
  });

  test('el gestor de impuestos ve Impuestos y no SOAT', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mockApi(page);
    await page.goto('/flito/impuestos');

    // Sus permisos dejan Gestión con un solo ítem, y un módulo de un ítem el dock lo pinta como
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
