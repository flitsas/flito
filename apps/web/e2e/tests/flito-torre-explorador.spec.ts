// Torre de Control Gerencial (Épica #14590) — Explorador, ficha de placa, guardas de rol y umbrales.
// Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado). Spec UX:
// docs/ux/flito-torre-control.md §5, §6, §7.5, §14.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const FUNCIONES_TORRE = [
  'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
  'torre.tablero_ejecutivo.ver', 'torre.tablero_comercial.ver', 'torre.tablero_operativo.ver', 'torre.tablero_financiero.ver',
  'torre.umbrales.ver', 'torre.umbrales.editar', 'perfil.datos.ver',
];

const GERENCIA_GENERAL: UsuarioFixture = {
  id: 701, username: 'e2e_gerencia', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera', 'torre_explorador', 'torre_umbrales'],
  funciones: FUNCIONES_TORRE,
};
const GERENCIA_COMERCIAL: UsuarioFixture = {
  id: 702, username: 'e2e_comercial', name: 'Gerencia Comercial E2E', role: 'gerencia_comercial',
  allowedPages: ['torre_comercial', 'torre_explorador'],
  funciones: ['torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.tablero_comercial.ver', 'perfil.datos.ver'],
};

const RESULTADO = {
  metrica: 'tramites', unidad: 'conteo',
  total: { valor: 47, n: 47 },
  filas: [
    { clave: '1', etiqueta: 'Compañía Demo A', valor: 18, n: 18, participacion: 38.3 },
    { clave: '2', etiqueta: 'Compañía Demo B', valor: 12, n: 12, participacion: 25.5 },
    { clave: '3', etiqueta: 'Compañía Demo C', valor: 17, n: 17, participacion: 36.2 },
  ],
  baseFecha: { campo: 'fecha_aprobacion', excluidosSinFecha: 0, nBaseSincronizacion: 0, fechaBase: 'aprobacion' },
  truncado: false, generadoEn: '2026-11-17T12:00:00.000Z',
};
const VACIO = { ...RESULTADO, total: { valor: 0, n: 0 }, filas: [] };

const FICHA = {
  tramiteUuid: '00000000-0000-4000-8000-000000000001', placa: 'XXX000', tipoTramite: 'TRASPASO', vinMascara: '•••••1234',
  compania: { id: 1, nombre: 'Compañía Demo A' }, organismo: { codigo: '05001', nombre: 'OT Demo Norte' },
  flitEstado: 'aprobado', fechaCreacion: '2026-10-02T10:00:00.000Z', fechaAprobacion: '2026-10-16T10:00:00.000Z', duracionHoras: 336,
  baseFecha: { campo: 'fecha_creacion_flit', conFallback: false },
  pasos: { creado: '2026-10-02T10:00:00.000Z', radicado: '2026-10-10T10:00:00.000Z', aprobado: '2026-10-16T10:00:00.000Z', facturado: null },
  lineaTiempo: [
    { estado: 'radicado', anterior: 'creado', desde: '2026-10-10T10:00:00.000Z' },
    { estado: 'aprobado', anterior: 'radicado', desde: '2026-10-16T10:00:00.000Z' },
  ],
  soat: { estado: 'vigente' }, impuesto: { estado: 'pagado' }, derecho: { estado: 'pagado' }, logistica: { estado: 'entregado' },
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Mockea la consulta del Explorador. `responder` decide por número de petición; devuelve los cuerpos enviados. */
async function mockConsulta(page: Pagina, responder: (n: number) => { status?: number; body: unknown; demoraMs?: number }) {
  const cuerpos: unknown[] = [];
  await page.route('**/api/flito/torre/metricas/consultar', async (route) => {
    cuerpos.push(route.request().postDataJSON());
    const r = responder(cuerpos.length);
    if (r.demoraMs) await new Promise((res) => setTimeout(res, r.demoraMs));
    await route.fulfill(json(r.body, r.status ?? 200));
  });
  return cuerpos;
}

const resultado = (page: Pagina) => page.locator('[data-torre="resultado"]');
const exportar = (page: Pagina) => page.getByRole('button', { name: 'Exportar a Excel' });

test.describe('Torre de Control · Explorador (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('cargando → lleno: esqueleto, cifra, participación y tabla; Exportar solo con resultado', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await mockConsulta(page, () => ({ body: RESULTADO, demoraMs: 600 }));
    await page.goto('/flito/torre/explorador');

    await expect(page.getByRole('heading', { level: 1, name: 'Explorador de métricas' })).toBeVisible();
    await expect(resultado(page)).toHaveAttribute('data-estado', 'cargando');
    await expect(exportar(page)).toBeDisabled();

    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    await expect(page.getByRole('heading', { name: /^Trámites aprobados · Este mes · por compañía$/ })).toBeVisible();
    await expect(resultado(page).locator('.metrica__cifra').first()).toHaveText('47');
    await expect(page.getByRole('list', { name: 'Trámites aprobados por grupo' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('table', { name: /Desglose/ })).toBeVisible();
    await expect(exportar(page)).toBeEnabled();
  });

  test('error con reintento y vacío sin filtros con periodo corto → «Ver los últimos 6 meses»; Exportar deshabilitado en ambos', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    // En dev, StrictMode monta dos veces y la primera consulta sale doble: se falla hasta pulsar «Reintentar».
    let fallar = true;
    const cuerpos = await mockConsulta(page, () => (fallar ? { status: 500, body: { error: 'boom' } } : { body: VACIO }));
    await page.goto('/flito/torre/explorador');

    await expect(resultado(page)).toHaveAttribute('data-estado', 'error');
    await expect(page.getByText('No pudimos calcular esta consulta. Revise su conexión e intente de nuevo.')).toBeVisible();
    await expect(page.getByText('boom')).toHaveCount(0);
    await expect(exportar(page)).toBeDisabled();

    const antes = cuerpos.length;
    fallar = false;
    await resultado(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(resultado(page)).toHaveAttribute('data-estado', 'vacio');
    await expect(resultado(page).getByText('No hay trámites aprobados este mes.')).toBeVisible();
    await expect(resultado(page).getByText('Pruebe con un periodo más amplio.')).toBeVisible();
    await expect(exportar(page)).toBeDisabled();
    expect(cuerpos.length).toBe(antes + 1);
    await resultado(page).getByRole('button', { name: 'Ver los últimos 6 meses' }).click();
    await expect.poll(() => (cuerpos.at(-1) as { filtro: { rango: unknown } }).filtro.rango).toEqual({ preset: 'ultimos_6m' });
    // Vistas flexibles: el «Periodo» pasó a atajos (spec vistas flexibles §3).
    await expect(page.getByRole('group', { name: 'Atajos de periodo' }).getByRole('button', { name: 'Últimos 6 meses' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('una pregunta frecuente recalcula sola y cambia el periodo de la barra compartida', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    const cuerpos = await mockConsulta(page, () => ({ body: RESULTADO }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');

    await page.getByRole('button', { name: 'Aprobados hoy' }).click();
    await expect(page.getByRole('button', { name: 'Aprobados hoy' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => (cuerpos.at(-1) as { filtro: { rango: unknown } }).filtro.rango).toEqual({ preset: 'hoy' });
    await expect(page.getByRole('group', { name: 'Atajos de periodo' }).getByRole('button', { name: 'Hoy' })).toHaveAttribute('aria-pressed', 'true');
    const guardado = await page.evaluate(() => sessionStorage.getItem('flito-torre-filtros'));
    expect(JSON.parse(guardado ?? '{}').periodo).toBe('hoy');
    expect(page.url()).not.toContain('hoy');
  });

  test('sin la función de dinero no se ofrecen las métricas de dinero', async ({ page }) => {
    await loginAs(page, GERENCIA_COMERCIAL);
    await mockConsulta(page, () => ({ body: RESULTADO }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    const medir = page.getByLabel('Medir');
    await expect(medir.locator('option').filter({ hasText: /^Trámites$/ })).toHaveCount(1);
    await expect(medir.locator('option', { hasText: 'Costo de logística' })).toHaveCount(0);
    await expect(medir.locator('option', { hasText: 'Impuestos pagados' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Costo de logística del mes' })).toHaveCount(0);
  });
});

test.describe('Torre de Control · Ficha de placa (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('Enter en «Buscar placa» abre la ficha por POST; la placa no toca la URL, el historial ni sessionStorage', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await mockConsulta(page, () => ({ body: RESULTADO }));
    const busquedas: unknown[] = [];
    await page.route('**/api/flito/torre/placa/buscar', async (route) => {
      busquedas.push(route.request().postDataJSON());
      await route.fulfill(json({ placa: 'XXX000', tramites: [FICHA] }));
    });
    await page.goto('/flito/torre/explorador');
    const largoHistorial = await page.evaluate(() => history.length);

    const buscador = page.getByRole('combobox', { name: /Buscar placa: escriba 3 o más caracteres/ });
    await buscador.fill('xxx 000');
    await buscador.press('Enter');

    const ficha = page.getByRole('dialog', { name: 'Ficha de la placa' });
    await expect(ficha).toBeVisible();
    await expect(ficha.getByText('14 días')).toBeVisible();
    await expect(ficha.getByText('Historial de estados')).toBeVisible();
    // La placa va normalizada y SOLO en el cuerpo (StrictMode puede duplicar la petición en dev).
    expect(busquedas.length).toBeGreaterThan(0);
    for (const b of busquedas) expect(b).toEqual({ placa: 'XXX000' });

    expect(page.url()).not.toMatch(/xxx|XXX000/i);
    expect(await page.evaluate(() => history.length)).toBe(largoHistorial);
    const almacenado = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    expect(almacenado).not.toContain('XXX000');

    await page.keyboard.press('Escape');
    await expect(ficha).toHaveCount(0);
    await expect(buscador).toBeFocused();
  });

  test('línea de tiempo: aprobado sin radicado → Radicado superado «sin fecha» y el paso actual es Facturado', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await mockConsulta(page, () => ({ body: RESULTADO }));
    const aprobadoSinRadicado = {
      ...FICHA, fechaCreacion: '2026-04-24T10:00:00.000Z', fechaAprobacion: '2026-07-06T10:00:00.000Z',
      pasos: { creado: '2026-04-24T10:00:00.000Z', radicado: null, aprobado: '2026-07-06T10:00:00.000Z', facturado: null },
    };
    await page.route('**/api/flito/torre/placa/buscar', (route) => route.fulfill(json({ placa: 'XXX000', tramites: [aprobadoSinRadicado] })));
    await page.goto('/flito/torre/explorador');
    const buscador = page.getByRole('combobox', { name: /Buscar placa/ });
    await buscador.fill('XXX000');
    await buscador.press('Enter');

    const ficha = page.getByRole('dialog', { name: 'Ficha de la placa' });
    const pasos = ficha.locator('.linea__paso');
    await expect(pasos).toHaveCount(4);
    await expect(ficha.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(ficha.locator('[aria-current="step"]')).toContainText('Facturado');
    for (const i of [0, 1, 2]) await expect(pasos.nth(i)).toHaveClass(/linea__paso--hecho/);
    await expect(pasos.nth(1)).toContainText('sin fecha');
  });

  test('placa corta: error en línea y ninguna petición; 404 = «no encontrada»', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await mockConsulta(page, () => ({ body: RESULTADO }));
    let peticiones = 0;
    await page.route('**/api/flito/torre/placa/buscar', async (route) => {
      peticiones += 1;
      await route.fulfill(json({ error: 'No encontrada' }, 404));
    });
    await page.goto('/flito/torre/explorador');
    const buscador = page.getByRole('combobox', { name: /Buscar placa/ });

    await buscador.fill('AB1');
    await buscador.press('Enter');
    await expect(page.getByText('Escriba la placa completa, por ejemplo XXX000.')).toBeVisible();
    expect(peticiones).toBe(0);

    await buscador.fill('ZZZ999');
    await buscador.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Ficha de la placa' }).getByText('No encontramos la placa ZZZ999 en FLITO.')).toBeVisible();
    expect(peticiones).toBeGreaterThan(0);
  });
});

test.describe('Torre de Control · guardas de rol (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('gerencia_comercial: sus 2 pestañas, y una URL directa sin permiso cae en la guarda', async ({ page }) => {
    await loginAs(page, GERENCIA_COMERCIAL);
    await mockConsulta(page, () => ({ body: RESULTADO }));
    await page.goto('/flito/torre/explorador');
    const pestanas = page.getByRole('navigation', { name: 'Páginas de la Torre de Control' }).getByRole('link');
    await expect(pestanas).toHaveText(['Comercial', 'Explorador']);

    await page.goto('/flito/torre/financiera');
    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    await page.goto('/flito/torre/umbrales');
    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
  });

  test('gerencia_general entra por su primera página de la Torre (Resumen 360°)', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await page.route('**/api/flito/torre/tableros/ejecutivo', (route) => route.fulfill(json({ error: 'x' }, 500)));
    await page.goto('/');
    await expect(page).toHaveURL(/\/flito\/torre\/resumen$/);
    await expect(page.getByText('No pudimos cargar el tablero Resumen 360°. Intente de nuevo.')).toBeVisible();
  });
});

test.describe('Torre de Control · Umbrales y alertas (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  const UMBRALES = [
    { clave: 'pct_caida_volumen', valor: 30, unidad: 'porcentaje', descripcion: 'Caída de volumen…', actualizadoPor: null, actualizadoEn: null },
    { clave: 'dias_ventana_fuga', valor: 30, unidad: 'dias', descripcion: 'Días sin trámites…', actualizadoPor: null, actualizadoEn: null },
  ];

  test('con la función de editar: modal, validación en línea y «Guardar» con PUT', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await page.route('**/api/flito/torre/umbrales', (route) => route.fulfill(json(UMBRALES)));
    const puts: unknown[] = [];
    await page.route('**/api/flito/torre/umbrales/pct_caida_volumen', async (route) => {
      puts.push(route.request().postDataJSON());
      await route.fulfill(json({ ...UMBRALES[0], valor: 25, actualizadoPor: { id: 701, nombre: 'Gerencia' }, actualizadoEn: '2026-11-17T12:00:00.000Z' }));
    });
    await page.goto('/flito/torre/umbrales');
    await page.getByRole('button', { name: 'Editar Caída de volumen' }).click();
    const modal = page.getByRole('dialog', { name: 'Editar umbral' });
    const campo = modal.getByLabel(/Nuevo valor/);
    await campo.fill('150');
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(modal.getByText('El valor no puede pasar de 100.')).toBeVisible();
    expect(puts).toHaveLength(0);

    await campo.fill('25');
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByText('Umbral actualizado.')).toBeVisible();
    expect(puts).toEqual([{ valor: 25 }]);
  });

  test('4 estados: cargando → error con «Reintentar» → lleno', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    // Falla (con demora, para ver el cargando) hasta que se pulsa «Reintentar»; StrictMode duplica el efecto en dev.
    let falla = true;
    let tras = 0;
    await page.route('**/api/flito/torre/umbrales', async (route) => {
      if (falla) { await new Promise((r) => setTimeout(r, 700)); await route.fulfill(json({ error: 'x' }, 500)); return; }
      tras += 1;
      await route.fulfill(json(UMBRALES));
    });
    await page.goto('/flito/torre/umbrales');

    await expect(page.getByTestId('ui-loading')).toBeVisible();
    const error = page.getByTestId('ui-error');
    await expect(error.getByText('No pudimos cargar los umbrales. Intente de nuevo.')).toBeVisible();
    falla = false;
    await error.getByRole('button', { name: 'Reintentar' }).click();
    const tabla = page.getByRole('table', { name: 'Umbrales Comercial' });
    await expect(tabla).toBeVisible();
    await expect(tabla.getByText('Caída de volumen', { exact: true })).toBeVisible();
    await expect(page.getByTestId('ui-error')).toHaveCount(0);
    expect(tras).toBe(1);
  });

  test('4 estados: vacío cuando no hay umbrales configurados', async ({ page }) => {
    await loginAs(page, GERENCIA_GENERAL);
    await page.route('**/api/flito/torre/umbrales', (route) => route.fulfill(json([])));
    await page.goto('/flito/torre/umbrales');

    await expect(page.getByTestId('ui-empty').getByText('Aún no hay umbrales configurados.')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Umbrales Comercial' })).toHaveCount(0);
  });

  test('sin la función de editar: solo lectura y aviso en página', async ({ page }) => {
    await loginAs(page, { ...GERENCIA_GENERAL, funciones: FUNCIONES_TORRE.filter((f) => f !== 'torre.umbrales.editar') });
    await page.route('**/api/flito/torre/umbrales', (route) => route.fulfill(json(UMBRALES)));
    await page.goto('/flito/torre/umbrales');
    await expect(page.getByText('Usted puede consultar los umbrales; para cambiarlos, pida a un administrador.')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Umbrales Comercial' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Editar/ })).toHaveCount(0);
  });
});
