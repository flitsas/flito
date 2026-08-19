import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';

// HU #11162 y #11210 (ajuste 0124) — Bolsa de tránsito. Backend mockeado.
//
// Lo que se comprueba, además de las cifras, es que la pantalla se lea en el sentido CORRECTO: un
// saldo que FLIT precarga y otro consume pagando ante las secretarías, no una deuda que crece.
//
// Una bolsa YA NO es una secretaría: tiene nombre propio y cubre varias secretarías y varios
// cobros. Por eso las tarjetas se identifican por el id de la bolsa y la cobertura se enseña
// siempre — sin ella, dos bolsas con saldos parecidos serían indistinguibles.

const BOLSA_ID = 'ob-1';

/** El ejemplo del refinamiento: varias secretarías y un solo cobro. */
const SECTOR = {
  id: BOLSA_ID, nombre: 'Bolsa de mi sector', saldo: 2_500_000,
  ultimaCargaValor: 10_000_000, ultimaCargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 25, deuda: 0,
  totalCargado: 10_000_000, totalConsumido: 7_500_000,
  cobertura: [
    { organismoCodigo: '05001', organismoNombre: 'Medellín', concepto: 'impuesto' },
    { organismoCodigo: '05266', organismoNombre: 'Envigado', concepto: 'impuesto' },
    { organismoCodigo: '05631', organismoNombre: 'Sabaneta', concepto: 'impuesto' },
  ],
};

/** La misma bolsa, ya en préstamo: el caso que la distingue de la del cliente. */
const SECTOR_PRESTAMO = {
  ...SECTOR, saldo: -4_000_000, nivel: 'en_prestamo', porcentaje: -40, deuda: 4_000_000,
  totalCargado: 10_000_000, totalConsumido: 14_000_000,
};

/** Creada pero sin una sola carga: ni alarma ni bolsa inexistente. */
const SIN_CARGAS = {
  id: 'ob-2', nombre: 'Bolsa nueva', saldo: 0,
  ultimaCargaValor: null, ultimaCargaEn: null,
  nivel: 'sin_cargas', porcentaje: null, deuda: 0,
  totalCargado: 0, totalConsumido: 0,
  cobertura: [{ organismoCodigo: '11001', organismoNombre: 'Bogotá', concepto: 'derecho' }],
};

const MOVIMIENTOS = [
  {
    id: 'm2', bolsaId: BOLSA_ID, organismoCodigo: '05001', concepto: 'impuesto',
    tipo: 'salida', origen: 'automatico',
    tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
    valor: 7_500_000, saldoResultante: 2_500_000, periodo: '2026-07', fecha: '2026-07-10',
    observacion: null, soporteId: null, registradoPorNombre: 'sistema',
    createdAt: '2026-07-10T10:00:00.000Z',
  },
  {
    id: 'm1', bolsaId: BOLSA_ID, organismoCodigo: null, concepto: null,
    tipo: 'entrada', origen: 'carga',
    tramiteId: null, idFlit: null,
    valor: 10_000_000, saldoResultante: 10_000_000, periodo: '2026-07', fecha: '2026-07-01',
    observacion: 'Transferencia del 01/07', soporteId: 'sop-10', registradoPorNombre: 'Financiera E2E',
    createdAt: '2026-07-01T10:00:00.000Z',
  },
];

async function mock(page: import('@playwright/test').Page, opts: {
  bolsa?: typeof SECTOR;
  listado?: unknown[];
} = {}) {
  const bolsa = opts.bolsa ?? SECTOR;
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } }) }));

  // El listado del acordeón «Tránsitos»: las bolsas creadas, con su cobertura.
  await page.route(/\/api\/flito\/bolsas\/transito$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.listado ?? [bolsa]) }));
  await page.route(/\/api\/flito\/bolsas\/transito\/ob-1$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bolsa) }));
  await page.route(/\/api\/flito\/bolsas\/transito\/ob-1\/movimientos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOVIMIENTOS) }));
}

/** Abre el detalle de Medellín desde su tarjeta del acordeón. */
async function abrirDetalle(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByTestId('tarjeta-bolsa-transito-ob-1').getByRole('button', { name: /Ver el detalle/ }).click();
  return page.getByRole('dialog');
}

test.describe('FLITO — Bolsas · bolsa de tránsito', () => {
  test('el acordeón de tránsitos lista cada bolsa con su cobertura, cargado, consumido y deuda', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    const tarjeta = page.getByTestId('tarjeta-bolsa-transito-ob-1');
    // El nombre de la bolsa es lo que la identifica, y la cobertura lo que la distingue de otra.
    await expect(tarjeta).toContainText('Bolsa de mi sector');
    await expect(tarjeta).toContainText('Impuestos');
    await expect(tarjeta).toContainText('Medellín');
    await expect(tarjeta).toContainText('2.500.000');
    // Las tres cifras que pide la HU, además del saldo.
    await expect(tarjeta.getByText('Cargado por FLIT')).toBeVisible();
    await expect(tarjeta).toContainText('10.000.000');
    await expect(tarjeta).toContainText('7.500.000');
    await expect(tarjeta.getByText('Deuda actual')).toBeVisible();
  });

  test('la bolsa en préstamo enseña el saldo en negativo y lo que se debe', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsa: SECTOR_PRESTAMO });
    await page.goto('/flito/bolsas');

    // La deuda NO es una tabla aparte: es el saldo en negativo, y así se lee en la tarjeta.
    const tarjeta = page.getByTestId('tarjeta-bolsa-transito-ob-1');
    await expect(tarjeta).toContainText('-$');
    await expect(tarjeta).toContainText('4.000.000');
    await expect(tarjeta.getByText('En préstamo')).toBeVisible();
  });

  test('una bolsa creada sin cargas no se pinta como alarma', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [SIN_CARGAS] });
    await page.goto('/flito/bolsas');

    // «Nunca se le ha cargado» no es lo mismo que «se quedó sin saldo»: no es una urgencia.
    const tarjeta = page.getByTestId('tarjeta-bolsa-transito-ob-2');
    await expect(tarjeta).toContainText('Sin cargas');
    await expect(tarjeta).toContainText('nunca se le ha cargado');
  });

  test('sin ninguna bolsa se explica cómo crear la primera, sin ofrecer cargar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [] });
    await page.goto('/flito/bolsas');

    await expect(page.getByTestId('sin-bolsas-transito')).toContainText('Crear bolsa');
    // Sin bolsa no hay dinero que mover: ofrecer la acción invitaría a preguntarse por qué no hace nada.
    await expect(page.getByRole('button', { name: 'Cargar saldo' })).toHaveCount(0);
  });

  test('crear una bolsa pide nombre, secretarías y cobros, y manda el estado final completo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [] });
    await page.route(/\/api\/transito\/organismos-config/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { codigo: '05001', nombre: 'Secretaría de Movilidad', ciudad: 'Medellín', alias: 'Medellín' },
          { codigo: '05266', nombre: 'Tránsito de Envigado', ciudad: 'Envigado', alias: 'Envigado' },
        ]),
      }));

    let enviado: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/bolsas\/transito$/, (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(SECTOR) });
    });

    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear una bolsa de tránsito' }).click();
    await page.getByLabel('Nombre de la bolsa *').fill('Bolsa de mi sector');
    await page.getByLabel('Impuestos').check();
    await page.getByLabel('Medellín').check();
    await page.getByLabel('Envigado').check();
    await page.getByRole('button', { name: 'Crear bolsa' }).click();

    // El servidor recibe el estado FINAL, no un diff: la cobertura es el producto de ambas listas.
    await expect.poll(() => enviado).toMatchObject({
      nombre: 'Bolsa de mi sector',
      organismos: ['05001', '05266'],
      conceptos: ['impuesto'],
    });
  });

  test('el 409 de solapamiento se lee dentro del formulario, sin cerrarlo', async ({ page }) => {
    // La regla la impone el servidor con un índice único; la pantalla solo tiene que enseñar QUÉ
    // se solapa, para que quien la ve pueda corregir la selección sin adivinar.
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { listado: [] });
    await page.route(/\/api\/transito\/organismos-config/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ codigo: '05266', nombre: 'Tránsito de Envigado', ciudad: 'Envigado', alias: 'Envigado' }]),
      }));
    await page.route(/\/api\/flito\/bolsas\/transito$/, (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Una secretaría no puede tener el mismo concepto en dos bolsas: Envigado (impuesto) ya está en «Bolsa de mi sector».' }),
      });
    });

    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear una bolsa de tránsito' }).click();
    await page.getByLabel('Nombre de la bolsa *').fill('Bolsa del sur');
    await page.getByLabel('Impuestos').check();
    await page.getByLabel('Envigado').check();
    await page.getByRole('button', { name: 'Crear bolsa' }).click();

    await expect(page.getByRole('alert')).toContainText('ya está en «Bolsa de mi sector»');
    // El formulario sigue abierto con lo escrito: cerrarlo obligaría a rehacer la selección entera.
    await expect(page.getByLabel('Nombre de la bolsa *')).toHaveValue('Bolsa del sur');
  });

  test('el detalle abre en modal con la alerta de nivel escrita, no solo en color', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page, { bolsa: SECTOR_PRESTAMO });
    const modal = await abrirDetalle(page);

    // El nivel va SIEMPRE escrito: quien no distinga el color no puede quedarse sin la información.
    const alerta = modal.getByTestId('alerta-nivel-transito');
    await expect(alerta).toContainText('En préstamo');
    await expect(alerta).toContainText('4.000.000');
    await expect(alerta).toHaveAttribute('role', 'alert');
  });

  test('el libro distingue la carga del consumo y enlaza el trámite que lo originó', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    const modal = await abrirDetalle(page);

    const libro = modal.getByRole('region', { name: 'Movimientos de la bolsa de tránsito' });
    // El consumo dice de qué cobro salió y ante qué secretaría; la carga no lleva ninguno de los dos.
    await expect(libro.getByText('Pago de impuestos')).toBeVisible();
    await expect(libro.getByText('Carga', { exact: true })).toBeVisible();
    // Los consumos cuelgan de un trámite; las cargas no.
    await expect(libro.getByRole('link', { name: 'FLIT-3001' })).toBeVisible();
  });

  test('registrar una carga refresca el saldo sin recargar la página', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let cargado = false;
    await page.route(/\/api\/flito\/bolsas\/transito\/ob-1\/cargas$/, (route) => {
      cargado = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ saldo: 12_500_000 }) });
    });
    await page.route(/\/api\/flito\/bolsas\/transito\/ob-1$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cargado
          ? { ...SECTOR, saldo: 12_500_000, nivel: 'normal', porcentaje: 125, totalCargado: 20_000_000 }
          : SECTOR),
      }));

    const modal = await abrirDetalle(page);
    await modal.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByLabel('Valor de la carga *').fill('10000000');
    await page.getByRole('button', { name: 'Registrar carga' }).click();

    await expect(modal.getByText('12.500.000').first()).toBeVisible();
  });

  test('una carga en cero se para antes de salir a la red', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    let llamadas = 0;
    await page.route(/\/api\/flito\/bolsas\/transito\/ob-1\/cargas$/, (route) => {
      llamadas += 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ saldo: 0 }) });
    });

    const modal = await abrirDetalle(page);
    await modal.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByLabel('Valor de la carga *').fill('0');

    await expect(page.getByRole('button', { name: 'Registrar carga' })).toBeDisabled();
    expect(llamadas).toBe(0);
  });

  test('un rol distinto de admin o financiera no ve un solo saldo', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Bolsas/ })).toBeVisible();
    await expect(page.getByTestId('tarjeta-bolsa-transito-ob-1')).toHaveCount(0);
  });
});
