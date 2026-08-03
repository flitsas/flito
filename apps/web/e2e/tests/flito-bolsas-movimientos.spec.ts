import { readFile } from 'node:fs/promises';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

// HU #11128 — Detalle de movimientos con filtros, exportación y soportes. Backend mockeado.

/** El periodo que la pantalla elige por defecto: el contable en curso, en hora de Colombia. */
const PERIODO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' })
  .format(new Date()).slice(0, 7);

const BOLSA = {
  id: 'b1', companiaId: 1, companiaNombre: 'ACME SAS', saldo: 1300000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: `${PERIODO}-01T10:00:00.000Z`,
  nivel: 'bajo', porcentaje: 26, entradasPeriodo: 5000000, salidasPeriodo: 3700000,
};

const RECARGA = {
  id: 'm1', companiaId: 1, tipo: 'entrada', origen: 'recarga', concepto: null,
  organismoCodigo: null, tramiteId: null, idFlit: null, valor: 5000000, saldoResultante: 5000000,
  periodo: PERIODO, fecha: `${PERIODO}-01`, observacion: 'Transferencia Bancolombia',
  soporteId: 'sop-1', registradoPorNombre: 'Financiera E2E', createdAt: `${PERIODO}-01T10:00:00.000Z`,
};
const SALIDA_SOAT = {
  id: 'm2', companiaId: 1, tipo: 'salida', origen: 'automatico', concepto: 'soat',
  organismoCodigo: '05001', tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
  valor: 450000, saldoResultante: 4550000, periodo: PERIODO, fecha: `${PERIODO}-10`,
  observacion: null, soporteId: 'sop-2', registradoPorNombre: 'sistema',
  createdAt: `${PERIODO}-10T10:00:00.000Z`,
};
const SALIDA_DERECHO = {
  id: 'm3', companiaId: 1, tipo: 'salida', origen: 'automatico', concepto: 'derecho',
  organismoCodigo: '11001', tramiteId: 'bbbb2222-0000-0000-0000-000000000002', idFlit: 'FLIT-3002',
  valor: 3250000, saldoResultante: 1300000, periodo: PERIODO, fecha: `${PERIODO}-20`,
  // Sin soporte: es justo el caso que la conciliación tiene que poder encontrar.
  observacion: null, soporteId: null, registradoPorNombre: 'sistema',
  createdAt: `${PERIODO}-20T10:00:00.000Z`,
};

const MOVIMIENTOS = [SALIDA_DERECHO, SALIDA_SOAT, RECARGA];

const EXTRACTO = {
  companiaId: 1, saldoActual: 1300000, totalEntradas: 5000000, totalSalidas: 3700000,
  porOrganismo: [
    { clave: '05001', entradas: 0, salidas: 450000, movimientos: 1 },
    { clave: '11001', entradas: 0, salidas: 3250000, movimientos: 1 },
    { clave: 'sin_asignar', entradas: 5000000, salidas: 0, movimientos: 1 },
  ],
  porConcepto: [
    { clave: 'soat', entradas: 0, salidas: 450000, movimientos: 1 },
    { clave: 'derecho', entradas: 0, salidas: 3250000, movimientos: 1 },
    // El gravamen es un concepto más del desglose desde la HU #11160.
    { clave: 'gmf', entradas: 0, salidas: 14800, movimientos: 1 },
    { clave: 'sin_asignar', entradas: 5000000, salidas: 0, movimientos: 1 },
  ],
};

async function mock(page: import('@playwright/test').Page) {
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BOLSA]) }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 1 } }) }));
  // El tablero pide las bolsas de organismo desde la HU #11210; sin esta ruta no llega a pintarse.
  await page.route(/\/api\/flito\/bolsas\/organismos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/1\/extracto/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EXTRACTO) }));
  await page.route(/\/api\/flito\/bolsas\/1\/movimientos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOVIMIENTOS) }));
  await page.route(/\/api\/flito\/bolsas\/1\/cierres/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/1$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOLSA) }));
}

/** Abre el detalle del cliente, que es donde vive la tabla de movimientos (modal desde la #11210). */
async function abrirCliente(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByTestId('tarjeta-cliente-1').getByRole('button', { name: /Ver el detalle/ }).click();
  await expect(page.getByText('Totales de lo filtrado (3 de 3)')).toBeVisible();
}

/** Despliega uno de los filtros de columna y devuelve su `<details>` para marcar opciones dentro. */
function filtro(page: import('@playwright/test').Page, etiqueta: string) {
  return page.locator('details').filter({ has: page.locator('summary', { hasText: etiqueta }) });
}

/** El libro. Va en su propia región porque en la pantalla conviven tres tablas. */
const libro = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Movimientos de la bolsa' });

test.describe('FLITO — Bolsas · movimientos', () => {
  test('la tabla trae cliente, OT, trámite, concepto, valor, saldo resultante, usuario y soporte', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    for (const col of ['Cliente', 'Fecha', 'Organismo', 'Trámite', 'Concepto', 'Origen', 'Valor',
      'Saldo resultante', 'Usuario', 'Soporte']) {
      await expect(libro(page).getByRole('columnheader', { name: col, exact: true })).toBeVisible();
    }

    const soat = libro(page).getByRole('row').filter({ hasText: 'FLIT-3001' });
    await expect(soat).toContainText('ACME SAS');
    await expect(soat).toContainText('Medellín');
    await expect(soat).toContainText('SOAT');
    await expect(soat).toContainText('450.000');
    await expect(soat).toContainText('4.550.000');
    await expect(soat).toContainText('sistema');
  });

  test('el desglose por OT y por concepto acompaña a la tabla, y lo que no tiene OT se agrupa aparte', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    await expect(page.getByText('Consumo por organismo de tránsito')).toBeVisible();
    await expect(page.getByText('Consumo por concepto')).toBeVisible();
    // Una recarga no tiene OT ni concepto: 'sin_asignar' es una agrupación legítima, no una fila rota.
    await expect(page.getByText('Sin organismo')).toBeVisible();
    await expect(page.getByText('Recarga o ajuste sin concepto')).toBeVisible();
  });

  test('los filtros se combinan y el total se recalcula sobre lo filtrado', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    // Tres condiciones a la vez: rango de fechas, organismo y concepto.
    const rango = page.locator('summary').filter({ hasText: 'Fecha' });
    await rango.click();
    await page.getByRole('button', { name: `${PERIODO}-05` }).click();
    await page.getByRole('button', { name: `${PERIODO}-15` }).click();
    // El calendario se cierra a mano: es un `<details>` y su panel tapa a los filtros de al lado.
    await rango.click();

    const porOrganismo = filtro(page, 'Organismo');
    await porOrganismo.locator('summary').click();
    await porOrganismo.getByRole('checkbox', { name: 'Medellín' }).check();

    const porConcepto = filtro(page, 'Concepto');
    await porConcepto.locator('summary').click();
    await porConcepto.getByRole('checkbox', { name: 'SOAT' }).check();

    await expect(page.getByText('Totales de lo filtrado (1 de 3)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-3002' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-3001' })).toHaveCount(1);
  });

  test('un movimiento sin soporte lo dice en vez de ofrecer un enlace roto', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    const conSoporte = page.getByRole('row').filter({ hasText: 'Transferencia Bancolombia' });
    await expect(conSoporte.getByRole('button', { name: /Abrir el soporte/ })).toBeVisible();

    const sinSoporte = page.getByRole('row').filter({ hasText: 'FLIT-3002' });
    await expect(sinSoporte.getByText('Sin soporte')).toBeVisible();
  });

  test('la exportación contiene exactamente las filas filtradas, con formato de moneda', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    const porOrigen = filtro(page, 'Origen');
    await porOrigen.locator('summary').click();
    await porOrigen.getByRole('checkbox', { name: 'Recarga' }).check();
    await expect(page.getByRole('button', { name: 'Exportar CSV (1)' })).toBeVisible();

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Exportar CSV/ }).click(),
    ]);
    expect(descarga.suggestedFilename()).toContain('ACME_SAS');

    const ruta = await descarga.path();
    const csv = await readFile(ruta, 'utf8');
    expect(csv).toContain('Saldo resultante');
    expect(csv).toContain('Transferencia Bancolombia');
    // Con formato de moneda, no en crudo: el archivo se lee y se pega en una conciliación.
    expect(csv).toContain('5.000.000');
    // Y nada más: las dos salidas quedaron fuera del filtro.
    expect(csv).not.toContain('4.550.000');
    expect(csv).not.toContain('FLIT-3001');
  });

  test('un filtro sin resultados ofrece limpiarlo, no un error', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    await page.locator('summary').filter({ hasText: 'Vista' }).click();
    // Un preset dice qué filtra: sin la descripción sería una caja negra.
    await expect(page.getByText(/Lo que registró una persona/)).toBeVisible();
    await page.getByRole('button', { name: /Ajustes manuales/ }).click();

    await expect(page.getByText('Ningún movimiento cumple los filtros aplicados.')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).first().click();
    await expect(page.getByText('Totales de lo filtrado (3 de 3)')).toBeVisible();
  });

  // HU #11162, AC6. El extracto rotula los conceptos por índice sobre el enum compartido, así que la
  // línea de GMF apareció sola cuando la HU #11160 lo añadió. Se fija aquí para que nadie retire el
  // gravamen del desglose creyendo que no es un concepto «de verdad».
  test('el GMF aparece como línea propia en el desglose por concepto', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirCliente(page);

    const fila = page.getByRole('row').filter({ hasText: 'GMF (4x1000)' });
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText(/14\.800/);
  });
});
