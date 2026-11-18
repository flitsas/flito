// Torre de Control Gerencial (Épica #14590) — primaria «Exportar a Excel» de los tableros y opciones de la barra
// de filtros (`GET /flito/torre/opciones`). Backend mockeado con `page.route` (el fixture base responde `200 []` a
// lo no mockeado). Spec UX: docs/ux/flito-torre-control.md §4 y §7.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const COMERCIAL_CON_EXPORTAR: UsuarioFixture = {
  id: 702, username: 'e2e_comercial', name: 'Gerencia Comercial E2E', role: 'gerencia_comercial',
  allowedPages: ['torre_comercial', 'torre_explorador'],
  funciones: ['torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.tablero_comercial.ver', 'perfil.datos.ver'],
};
const COMERCIAL_SIN_EXPORTAR: UsuarioFixture = {
  ...COMERCIAL_CON_EXPORTAR,
  funciones: COMERCIAL_CON_EXPORTAR.funciones!.filter((f) => f !== 'torre.metricas.exportar'),
};

const META = { filtrosIgnorados: [] as string[] };
const CONC = { top: [{ companiaId: 1, compania: 'Compañía Demo A', valor: 30, pct: 60 }], demas: { n: 1, valor: 20, pct: 40 }, top3Pct: 60, top5Pct: 100, total: 50 };
const TABLERO_COMERCIAL = {
  rango: { desde: '2026-11-01', hasta: '2026-11-17' }, dineroVisible: false, generadoEn: '2026-11-17T12:00:00.000Z',
  cifras: {
    clientesEnCaida: 0, concentracionTop3Pct: 60, concentracionTop5Pct: 100, conversionFacturadoPct: 40,
    tramitesPeriodo: 50, tramitesPeriodoAnterior: 44, sparkline: [1, 3, 2, 4],
  },
  fuga: { ...META, umbralPct: 30, ventanaDias: 30, filas: [] },
  concentracion: { ...META, volumen: CONC, ingreso: null },
  embudo: { ...META, pasos: [{ paso: 'creados', valor: 50, pct: 100 }, { paso: 'facturados', valor: 20, pct: 40 }] },
  tendencia: { ...META, mensual: [{ clave: '2026-10', etiqueta: 'oct', valor: 44 }], trimestral: [{ clave: '2026-T4', etiqueta: 'T4', valor: 44 }] },
  ventaCruzada: { ...META, filas: [] },
};

const OPCIONES = {
  companias: [{ id: 2, nombre: 'Compañía Demo B' }, { id: 1, nombre: 'Compañía Demo A' }],
  organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }],
  flitEstados: [{ valor: 'aprobado', etiqueta: 'Aprobado' }],
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockOpciones(page: Pagina, demoraMs = 0, status = 200) {
  await page.route('**/api/flito/torre/opciones', async (route) => {
    if (demoraMs) await new Promise((r) => setTimeout(r, demoraMs));
    await route.fulfill(json(status === 200 ? OPCIONES : { error: 'x' }, status));
  });
}

async function mockTablero(page: Pagina, demoraMs = 0) {
  await page.route('**/api/flito/torre/tableros/comercial', async (route) => {
    if (demoraMs) await new Promise((r) => setTimeout(r, demoraMs));
    await route.fulfill(json(TABLERO_COMERCIAL));
  });
}

const TABLERO_VACIO = { ...TABLERO_COMERCIAL, cifras: { ...TABLERO_COMERCIAL.cifras, tramitesPeriodo: 0 }, ventaCruzada: { ...META, filas: [] } };

const exportar = (page: Pagina) => page.getByRole('button', { name: 'Exportar a Excel' });
const barra = (page: Pagina) => page.locator('[data-torre="barra-filtros"]');

test.describe('Torre de Control · tableros: exportar y opciones de filtros (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('Exportar a Excel: deshabilitado mientras carga; llama a la ruta del tablero con el filtro de la barra', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    await mockOpciones(page);
    await mockTablero(page, 600);
    const cuerpos: unknown[] = [];
    await page.route('**/api/flito/torre/tableros/comercial/exportar', async (route) => {
      cuerpos.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200, body: 'xlsx',
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': 'attachment; filename="torre-comercial.xlsx"',
        },
      });
    });
    await page.goto('/flito/torre/comercial');

    await expect(page.getByRole('heading', { level: 1, name: 'Comercial' })).toBeVisible();
    await expect(exportar(page)).toBeDisabled();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
    await expect(exportar(page)).toBeEnabled();

    const descarga = page.waitForEvent('download');
    await exportar(page).click();
    expect((await descarga).suggestedFilename()).toMatch(/\.xlsx$/);
    expect(cuerpos).toHaveLength(1);
    // El body lleva el FiltroTorre de la barra (por defecto: «Este mes», todas las compañías).
    expect(cuerpos[0]).toEqual({ filtro: expect.objectContaining({ rango: expect.anything() }) });
    await expect(page.getByText('Listo: descargamos el Excel de este tablero.')).toBeVisible();
  });

  test('sin la función de exportar el tablero no tiene primaria', async ({ page }) => {
    await loginAs(page, COMERCIAL_SIN_EXPORTAR);
    await mockOpciones(page);
    await mockTablero(page);
    let llamadas = 0;
    await page.route('**/api/flito/torre/tableros/comercial/exportar', async (route) => { llamadas += 1; await route.fulfill(json({})); });
    await page.goto('/flito/torre/comercial');

    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
    await expect(exportar(page)).toHaveCount(0);
    expect(llamadas).toBe(0);
  });

  test('gráfica: al pasar el cursor sobre un punto el valor aparece al instante (sin el retardo del title nativo)', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    await mockOpciones(page);
    await mockTablero(page);
    await page.goto('/flito/torre/comercial');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');

    const linea = page.locator('[data-kit="linea"]').first();
    await linea.locator('.grafico__columna[data-etiqueta="oct"]').hover();
    const tip = linea.locator('.grafico__tip');
    await expect(tip).toBeVisible({ timeout: 300 });
    await expect(tip).toContainText('Trámites');
    await expect(tip).toContainText('44');
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
  });

  test('opciones cargando: selects deshabilitados con aviso; al llegar, la compañía sale de /torre/opciones', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    // Demora amplia: en dev, Vite sirve la barra en cascada de módulos y con 800 ms la petición podía resolverse antes
    // de que la aserción alcanzara a ver el «cargando».
    await mockOpciones(page, 3000);
    await mockTablero(page);
    let parametrizacion = 0;
    await page.route('**/api/flito/parametrizacion/companias', async (route) => { parametrizacion += 1; await route.fulfill(json([])); });
    await page.goto('/flito/torre/comercial');

    await expect(barra(page)).toHaveAttribute('data-opciones', 'cargando');
    await expect(page.getByLabel('Compañía', { exact: true })).toBeDisabled();
    await expect(barra(page).getByRole('status').filter({ hasText: 'Cargando las opciones…' })).toBeVisible();

    await expect(barra(page)).toHaveAttribute('data-opciones', 'listo');
    await expect(page.getByLabel('Compañía', { exact: true })).toBeEnabled();
    await page.getByLabel('Compañía', { exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Compañía' }).getByRole('option')).toHaveText(['Todas las compañías', 'Compañía Demo A', 'Compañía Demo B']);
    expect(parametrizacion).toBe(0);
  });

  test('opciones con error: «Todas» con aviso y reintento que vuelve a pedir', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    let pedidas = 0;
    await page.route('**/api/flito/torre/opciones', async (route) => {
      pedidas += 1;
      await route.fulfill(pedidas === 1 ? json({ error: 'x' }, 500) : json(OPCIONES));
    });
    await mockTablero(page);
    await page.goto('/flito/torre/comercial');

    await expect(barra(page)).toHaveAttribute('data-opciones', 'error');
    await expect(barra(page).getByText('No pudimos cargar las opciones de los filtros.')).toBeVisible();
    await barra(page).getByRole('button', { name: /Volver a cargar/ }).click();
    await expect(barra(page)).toHaveAttribute('data-opciones', 'listo');
    expect(pedidas).toBe(2);
  });
});

// AC4 (4 estados): Comercial, Operativo, Financiero y Resumen 360° pintan cargando/error/vacío/lleno con el MISMO
// `MoldeTablero` + `useTablero` (components/torre/MoldeTablero.tsx); ninguna página tiene lógica de estado propia,
// solo su predicado `esVacio`. Por eso basta cubrir el molde una vez, sobre Comercial.
test.describe('Torre de Control · tableros: 4 estados del molde compartido (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('error con reintento: 500 → «Reintentar» → el tablero se ve lleno', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    await mockOpciones(page);
    // Falla hasta que se pulsa «Reintentar» (en dev, StrictMode dispara el efecto dos veces: no contamos por orden).
    let falla = true;
    let tras = 0;
    await page.route('**/api/flito/torre/tableros/comercial', async (route) => {
      if (!falla) tras += 1;
      await route.fulfill(falla ? json({ error: 'x' }, 500) : json(TABLERO_COMERCIAL));
    });
    await page.goto('/flito/torre/comercial');

    const tablero = page.locator('[data-torre="tablero"]');
    await expect(tablero).toHaveAttribute('data-estado', 'error');
    await expect(tablero.getByText('No pudimos cargar el tablero Comercial. Intente de nuevo.')).toBeVisible();
    await expect(exportar(page)).toBeDisabled();
    falla = false;
    await tablero.getByRole('button', { name: 'Reintentar' }).click();
    await expect(tablero).toHaveAttribute('data-estado', 'lleno');
    await expect(exportar(page)).toBeEnabled();
    expect(tras).toBe(1);
  });

  test('vacío: aviso con «Limpiar filtros», que devuelve la barra a sus valores por defecto', async ({ page }) => {
    await loginAs(page, COMERCIAL_CON_EXPORTAR);
    await mockOpciones(page);
    const cuerpos: Array<{ filtro: Record<string, unknown> }> = [];
    await page.route('**/api/flito/torre/tableros/comercial', async (route) => {
      cuerpos.push(route.request().postDataJSON());
      await route.fulfill(json(TABLERO_VACIO));
    });
    await page.goto('/flito/torre/comercial');

    const tablero = page.locator('[data-torre="tablero"]');
    await expect(tablero).toHaveAttribute('data-estado', 'vacio');
    await expect(tablero.getByText('No hay trámites en este periodo con los filtros puestos.')).toBeVisible();
    await expect(exportar(page)).toBeDisabled();

    await expect(barra(page)).toHaveAttribute('data-opciones', 'listo');
    const compania = page.getByLabel('Compañía', { exact: true });
    const inicial = JSON.stringify(cuerpos[0]);
    await compania.click();
    await page.getByRole('option', { name: 'Compañía Demo A' }).click();
    await page.getByRole('button', { name: 'Listo' }).click();
    await expect.poll(() => JSON.stringify(cuerpos.at(-1))).not.toBe(inicial);
    await expect(tablero).toHaveAttribute('data-estado', 'vacio');

    await tablero.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(compania).toHaveText('Todas las compañías');
    // Limpiar vuelve a pedir el tablero con el mismo filtro de la carga inicial.
    await expect.poll(() => JSON.stringify(cuerpos.at(-1))).toBe(inicial);
  });
});

const FINANCIERA: UsuarioFixture = {
  id: 703, username: 'e2e_financiera', name: 'Gerencia Financiera E2E', role: 'gerencia_general',
  allowedPages: ['torre_financiera'],
  funciones: ['torre.tablero_financiero.ver', 'torre.metricas.dinero', 'perfil.datos.ver'],
};
const TABLERO_FINANCIERO = {
  rango: { desde: '2026-11-01', hasta: '2026-11-17' }, dineroVisible: true, generadoEn: '2026-11-17T12:00:00.000Z',
  cifras: {
    menorCobertura: { companiaId: 1, compania: 'Compañía Demo A', dias: 0, severidad: 'critico' },
    sinFacturarValor: 0, sinFacturarTramites: 0, margenPct: null, soportesCompletosPct: null,
  },
  bolsas: {
    ...META, umbralAtencionDias: 15, umbralCriticoDias: 7,
    filas: [
      { companiaId: 1, compania: 'Compañía Demo A', saldo: -262_000, consumoDiario: 10_000, diasCobertura: 0, severidad: 'critico' },
      { companiaId: 2, compania: 'Compañía Demo B', saldo: 500_000, consumoDiario: 50_000, diasCobertura: 10, severidad: 'atencion' },
    ],
  },
  sinFacturar: { ...META, filas: [] },
  margen: null,
  conciliacion: { ...META, completos: 0, dos: 0, uno: 0, cero: 0, total: 0, pctCompletos: null },
};

test.describe('Torre de Control · Financiero: bolsa agotada (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('saldo ≤ 0: KPI y tabla dicen «Agotada», nunca días negativos ni «0 días»', async ({ page }) => {
    await loginAs(page, FINANCIERA);
    await mockOpciones(page);
    await page.route('**/api/flito/torre/tableros/financiera', (route) => route.fulfill(json(TABLERO_FINANCIERO)));
    await page.goto('/flito/torre/financiera');

    await expect(page.getByText('Bolsa con menor cobertura')).toBeVisible();
    await expect(page.getByText('Agotada').first()).toBeVisible();
    const tabla = page.getByRole('table', { name: 'Cobertura de bolsas' });
    await expect(tabla.getByRole('row', { name: /Compañía Demo A/ })).toContainText('Agotada');
    await expect(tabla.getByRole('row', { name: /Compañía Demo B/ })).toContainText('10');
    const texto = await page.locator('main').innerText();
    expect(texto).not.toMatch(/[-−]\d+(,\d+)? días|\b0 días/);
  });
});

// D9 (P-4 = sí): la barra es la misma en las 5 páginas y los tableros reciben VARIAS compañías.
test.describe('Torre de Control · tableros con varias compañías (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('Financiera: 2 compañías elegidas en la barra → una sola petición con las dos al cerrar la lista', async ({ page }) => {
    await loginAs(page, FINANCIERA);
    await mockOpciones(page);
    const cuerpos: Array<{ filtro: { companiaIds?: number[] } }> = [];
    await page.route('**/api/flito/torre/tableros/financiera', async (route) => {
      cuerpos.push(route.request().postDataJSON());
      await route.fulfill(json(TABLERO_FINANCIERO));
    });
    await page.goto('/flito/torre/financiera');
    await expect(barra(page)).toHaveAttribute('data-opciones', 'listo');
    await expect(page.getByText('Bolsa con menor cobertura')).toBeVisible();

    // Con 2+ elegidas el `aria-label` del botón las nombra todas: se ubica por su contenedor.
    const compania = page.locator('[data-torre-selector="Compañía"] [aria-haspopup="listbox"]');
    await compania.click();
    const lista = page.getByRole('listbox', { name: 'Compañía' });
    await expect(lista).toHaveAttribute('aria-multiselectable', 'true');
    const antes = cuerpos.length;
    await lista.getByRole('option', { name: 'Compañía Demo A' }).click();
    await lista.getByRole('option', { name: 'Compañía Demo B' }).click();
    await expect(page.getByText('2 elegidas')).toBeVisible();
    // Marcar no consulta: aplica al cerrar.
    expect(cuerpos.length).toBe(antes);
    await page.getByRole('button', { name: 'Listo' }).click();

    await expect.poll(() => cuerpos.at(-1)?.filtro.companiaIds).toEqual([1, 2]);
    await expect(compania).toHaveText('Compañía Demo A y 1 más');
    await expect(compania).toHaveAttribute('aria-label', 'Compañía: Compañía Demo A y Compañía Demo B');
    const guardado = JSON.parse(await page.evaluate(() => sessionStorage.getItem('flito-torre-filtros') ?? '{}'));
    expect(guardado.companiaIds).toEqual([1, 2]);
    expect(guardado).not.toHaveProperty('companiaId');
  });
});
