import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

// HU #11129 — Recargas, movimientos manuales y cierre de periodo. Backend mockeado.
//
// El grueso de este spec es el contrato de idempotencia: la clave se acuña AL ABRIR el formulario,
// sobrevive a los reintentos y muere con el modal. Comprobarlo sobre las cabeceras que salen del
// navegador es la única forma de que no se rompa por un refactor que la mueva al clic.

const PERIODO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' })
  .format(new Date()).slice(0, 7);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ETIQUETA_PERIODO = `${MESES[Number(PERIODO.slice(5)) - 1]} de ${PERIODO.slice(0, 4)}`;

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
const SALIDA = {
  id: 'm2', companiaId: 1, tipo: 'salida', origen: 'automatico', concepto: 'soat',
  organismoCodigo: '05001', tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
  valor: 3700000, saldoResultante: 1300000, periodo: PERIODO, fecha: `${PERIODO}-10`,
  observacion: null, soporteId: 'sop-2', registradoPorNombre: 'sistema',
  createdAt: `${PERIODO}-10T10:00:00.000Z`,
};

const CIERRE = {
  id: 'c1', companiaId: 1, periodo: PERIODO, saldoInicial: 0, totalEntradas: 5000000,
  totalSalidas: 3700000, saldoFinal: 1300000, movimientos: 2, observaciones: null,
  cerradoPorNombre: 'Financiera E2E', cerradoEn: `${PERIODO}-28T15:00:00.000Z`,
};

const PDF = { name: 'comprobante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') };

/** `cierres` arranca vacío y se rellena cuando el test simula que el cierre ya se aplicó. */
async function mock(page: import('@playwright/test').Page, estado: { cerrado: boolean } = { cerrado: false }) {
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BOLSA]) }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } }) }));
  await page.route(/\/api\/flito\/bolsas\/1\/extracto/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      companiaId: 1, saldoActual: 1300000, totalEntradas: 5000000, totalSalidas: 3700000,
      porOrganismo: [], porConcepto: [],
    }) }));
  await page.route(/\/api\/flito\/bolsas\/1\/movimientos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SALIDA, RECARGA]) }));
  await page.route(/\/api\/flito\/bolsas\/1\/movimientos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SALIDA, RECARGA]) }));
  await page.route(/\/api\/flito\/bolsas\/1\/cierres$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(estado.cerrado ? [CIERRE] : []) });
  });
  await page.route(/\/api\/flito\/bolsas\/1$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOLSA) }));
}

async function abrirCliente(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByRole('button', { name: 'Cliente', exact: true }).click();
  await page.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('1');
  await expect(page.getByRole('button', { name: 'Registrar una recarga' })).toBeVisible();
}

test.describe('FLITO — Bolsas · registrar y cerrar', () => {
  test('la clave de idempotencia se acuña al abrir el formulario y sobrevive al reintento', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    const claves: string[] = [];
    await page.route(/\/api\/flito\/bolsas\/1\/recargas/, (route) => {
      claves.push(route.request().headers()['idempotency-key'] ?? '');
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'El almacenamiento no responde' }) });
    });

    await abrirCliente(page);
    await page.getByRole('button', { name: 'Registrar una recarga' }).click();
    await page.getByLabel('Valor de la recarga *').fill('5000000');
    await page.locator('input[type=file]').setInputFiles(PDF);
    await page.getByRole('button', { name: 'Registrar recarga' }).click();
    await expect(page.getByText('El almacenamiento no responde')).toBeVisible();

    // Mismo formulario, segundo intento: si la clave se generara en el clic, un doble clic acabaría
    // acreditando el dinero dos veces y esta clave sería distinta.
    await page.getByRole('button', { name: 'Registrar recarga' }).click();
    await expect.poll(() => claves.length).toBe(2);
    expect(claves[0]).not.toBe('');
    expect(claves[1]).toBe(claves[0]);

    // Y muere con el modal: una recarga distinta no puede heredar la clave de la anterior.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Registrar una recarga' }).click();
    await page.getByLabel('Valor de la recarga *').fill('2000000');
    await page.locator('input[type=file]').setInputFiles(PDF);
    await page.getByRole('button', { name: 'Registrar recarga' }).click();
    await expect.poll(() => claves.length).toBe(3);
    expect(claves[2]).not.toBe(claves[0]);
  });

  test('un reenvío duplicado enseña el movimiento original y no anuncia un registro nuevo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    // 200 con `duplicado: true`: el servidor no acreditó nada.
    await page.route(/\/api\/flito\/bolsas\/1\/recargas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ movimiento: RECARGA, saldo: 1300000, duplicado: true }) }));

    await abrirCliente(page);
    await page.getByRole('button', { name: 'Registrar una recarga' }).click();
    await page.getByLabel('Valor de la recarga *').fill('5000000');
    await page.locator('input[type=file]').setInputFiles(PDF);
    await page.getByRole('button', { name: 'Registrar recarga' }).click();

    await expect(page.getByRole('heading', { name: 'Esta recarga ya estaba registrada' })).toBeVisible();
    await expect(page.getByText(/no se sumó nada al\s+saldo/)).toBeVisible();
    // Nada de «recarga registrada»: sería hacer creer que el dinero entró dos veces.
    await expect(page.getByText(/Recarga de .* registrada/)).toHaveCount(0);
  });

  test('sin valor, con valor cero o sin soporte, el botón no envía la petición', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let peticiones = 0;
    await page.route(/\/api\/flito\/bolsas\/1\/recargas/, (route) => {
      peticiones += 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ movimiento: RECARGA, saldo: 6300000, duplicado: false }) });
    });

    await abrirCliente(page);
    await page.getByRole('button', { name: 'Registrar una recarga' }).click();
    const guardar = page.getByRole('button', { name: 'Registrar recarga' });
    await expect(guardar).toBeDisabled();

    await page.getByLabel('Valor de la recarga *').fill('0');
    await expect(page.getByText('El valor de la recarga debe ser mayor que cero.')).toBeVisible();
    await expect(guardar).toBeDisabled();

    // Con valor válido pero sin comprobante sigue bloqueado: una entrada sin soporte no es auditable.
    await page.getByLabel('Valor de la recarga *').fill('5000000');
    await expect(guardar).toBeDisabled();

    await page.locator('input[type=file]').setInputFiles(PDF);
    await expect(guardar).toBeEnabled();
    expect(peticiones).toBe(0);
  });

  test('el movimiento manual exige motivo y muestra el mensaje del servidor si lo rechaza', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.route(/\/api\/flito\/bolsas\/1\/movimientos-manuales/, (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'El periodo 2026-06 ya está cerrado' }) }));

    await abrirCliente(page);
    await page.getByRole('button', { name: 'Movimiento manual' }).click();

    const guardar = page.getByRole('button', { name: 'Registrar movimiento' });
    await page.getByLabel('Valor *').fill('120000');
    await page.getByLabel('Motivo *').fill('mal');
    await expect(page.getByText('Indica el motivo del movimiento (al menos 5 caracteres).')).toBeVisible();
    await expect(guardar).toBeDisabled();

    await page.getByLabel('Motivo *').fill('ajuste por recibo duplicado');
    await page.locator('input[type=file]').setInputFiles(PDF);
    await expect(guardar).toBeEnabled();
    await guardar.click();

    // El mensaje del servidor tal cual (AC5), y el saldo en pantalla sin tocar.
    await expect(page.getByText('El periodo 2026-06 ya está cerrado')).toBeVisible();
    await expect(page.getByText('1.300.000').first()).toBeVisible();
  });

  test('el cierre pide confirmación con entradas, salidas y saldo final, y deja descargar el reporte', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const estado = { cerrado: false };
    await mock(page, estado);
    await page.route(/\/api\/flito\/bolsas\/1\/cierres$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      estado.cerrado = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CIERRE) });
    });

    await abrirCliente(page);
    await page.getByRole('button', { name: `Cerrar ${ETIQUETA_PERIODO}` }).click();

    // Un cierre es irreversible: las cifras van delante, no detrás.
    await expect(page.getByText(/no hay forma de reabrirlo/)).toBeVisible();
    const resumen = page.getByRole('dialog');
    await expect(resumen).toContainText('5.000.000');
    await expect(resumen).toContainText('3.700.000');
    await expect(resumen).toContainText('1.300.000');

    await page.getByRole('button', { name: 'Confirmar el cierre' }).click();
    await expect(page.getByRole('heading', { name: `${ETIQUETA_PERIODO} cerrado` })).toBeVisible();

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Descargar el reporte de cierre', exact: true }).click(),
    ]);
    expect(descarga.suggestedFilename()).toContain(PERIODO);

    // Y las acciones de registro quedan cerradas para ese periodo.
    await page.getByRole('button', { name: 'Volver a la bolsa' }).click();
    await expect(page.getByRole('button', { name: 'Registrar una recarga' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Movimiento manual' })).toBeDisabled();
    await expect(page.getByText('Periodo cerrado')).toBeVisible();
  });
});
