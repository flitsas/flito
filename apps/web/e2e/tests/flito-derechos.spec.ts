import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Derechos de tránsito (HU #10951). Carga de recibos, resultado clasificado por canasta y
// bandeja de los que aún no cruzan con un trámite. El backend está mockeado: lo que se verifica
// aquí es el cableado de la UI, no el OCR.

const DERECHOS = [
  {
    id: 'd1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'QTP701', organismoCodigo: '05001',
    empresa: 'Concesionario Norte', valor: '236700.00', fechaPago: '2026-05-23',
    numeroRadicado: '1005504347', tipoTramiteRecibo: 'MATRICULA INICIAL', origen: 'manual',
    advertencias: null, soporteId: 'sop1', createdAt: '2026-05-23T10:00:00Z',
  },
  {
    id: 'd2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', organismoCodigo: '05001',
    empresa: 'Concesionario Sur', valor: '198300.00', fechaPago: '2026-05-24',
    numeroRadicado: '1005504348', tipoTramiteRecibo: 'TRASPASO', origen: 'drive',
    advertencias: ['El concepto del recibo dice "TRASPASO" y el trámite es "MATRICULA INICIAL".'],
    soporteId: 'sop2', createdAt: '2026-05-24T10:00:00Z',
  },
];

// La bandeja es de los tres conceptos (HU #10982): un recibo de SOAT sin placa legible también se
// archiva, y es el caso en el que más caro sale perder el archivo.

async function mockListas(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/derechos\/facetas/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ organismos: ['05001', '05266'], origenes: ['manual', 'drive'] }),
  }));
  await page.route(/\/api\/flito\/derechos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: DERECHOS, total: DERECHOS.length, page: 1, pageSize: 50 }) }));
}

test.describe('FLITO — Derechos de tránsito', () => {
  test('operaciones ve el listado con valor, origen y advertencias', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);

    await page.goto('/flito/derechos');
    await expect(page.getByRole('heading', { name: 'Derechos de tránsito' })).toBeVisible();
    await expect(page.getByText('QTP701')).toBeVisible();
    await expect(page.getByText('FLIT-1001')).toBeVisible();
    await expect(page.getByText('$ 236.700')).toBeVisible();
    // El origen distingue lo cargado a mano de lo que llegó por el Drive de la secretaría, y se
    // rotula: en la columna se veía el valor crudo de la base («drive»).
    await expect(page.getByRole('cell', { name: 'Drive de la secretaría', exact: true })).toBeVisible();
    // Una discrepancia de concepto no bloquea el registro pero queda visible.
    await expect(page.getByText('Con advertencia')).toBeVisible();
    // La fecha de pago no lleva hora: formatearla con `new Date(...)` la interpretaría como
    // medianoche UTC y en hora de Colombia retrocedería un día (el recibo dice 23, se veía 22).
    await expect(page.getByRole('cell', { name: '23/5/2026', exact: true })).toBeVisible();
  });

  test('la carga muestra el resultado clasificado por canasta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    await page.route(/\/api\/flito\/derechos\/cargar$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          registrados: [{ archivo: 'QTP701.pdf', placa: 'QTP701', idFlit: 'FLIT-1001', registroId: 'd1', valor: '236700', detalle: 'Registrado y asociado al trámite.' }],
          enRevision: [{ archivo: 'AMB222.pdf', placa: 'AMB222', idFlit: null, registroId: null, valor: '100000', detalle: 'Varios trámites con la placa AMB222: requiere que Operaciones elija.' }],
          duplicados: [], pendientes: [], omitidas: [], fallidos: [],
        }),
      }));

    await page.goto('/flito/derechos');
    await page.setInputFiles('input[type="file"]', {
      name: 'QTP701.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
    });
    await page.getByRole('button', { name: /^Cargar/ }).click();

    // Cada archivo cae en su canasta con el motivo textual que devolvió el backend: eso es lo que
    // el usuario necesita leer, no un «ok» global.
    await expect(page.getByRole('heading', { name: /Resultado de la carga/ })).toBeVisible();
    await expect(page.getByText('Registrado y asociado al trámite.')).toBeVisible();
    await expect(page.getByText(/requiere que Operaciones elija/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'AMB222', exact: true })).toBeVisible();
  });

  test('un error del servidor se informa sin romper la página', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    await page.route(/\/api\/flito\/derechos\/cargar$/, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Servicio de IA no configurado' }) }));

    await page.goto('/flito/derechos');
    await page.setInputFiles('input[type="file"]', {
      name: 'QTP701.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
    });
    await page.getByRole('button', { name: /^Cargar/ }).click();

    await expect(page.getByText(/Servicio de IA no configurado/)).toBeVisible();
    // La página sigue viva: el listado se mantiene visible.
    await expect(page.getByText('QTP701')).toBeVisible();
  });

  test('los registrados se pueden filtrar por secretaría, origen y fecha de pago', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    await page.route(/\/api\/flito\/derechos\/facetas/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ organismos: ['05001', '05266'], origenes: ['manual', 'drive'] }),
    }));
    let ultima = '';
    await page.route(/\/api\/flito\/derechos\?/, (route) => {
      ultima = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0 }) });
    });

    await page.goto('/flito/derechos');
    // El origen se rotula: en la tabla se veía el valor crudo de la columna.
    await page.locator('summary').filter({ hasText: 'Origen' }).click();
    await page.getByRole('checkbox', { name: 'Drive de la secretaría' }).check();
    await expect.poll(() => ultima).toContain('origenes=drive');

    await page.locator('summary').filter({ hasText: 'Secretaría' }).click();
    await page.getByRole('checkbox', { name: '05001' }).check();
    await expect.poll(() => ultima).toContain('organismos=05001');

    await page.locator('summary').filter({ hasText: 'Pagado' }).click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => ultima).toContain('pagadoDesde=');
  });




});

// ─────────────────── Drive de la secretaría (HU #11010) ─────────────────────
//
// Antes esto vivía en Administración → Google Drive, un explorador genérico. Ahora se procesa
// desde el propio módulo, que es donde se ve el resultado.

const ARCHIVOS_DRIVE = [
  { fileId: 'f1', nombre: 'FLIT 18-07-2026.pdf', tamanoBytes: 1_782_000, modificadoEn: '2026-07-18T10:00:00Z', procesadoEn: null },
  { fileId: 'f2', nombre: 'FLIT 17-07-2026.pdf', tamanoBytes: 900_000, modificadoEn: '2026-07-17T10:00:00Z', procesadoEn: '2026-07-17T18:00:00Z' },
];

async function mockDrive(page: import('@playwright/test').Page) {
  await mockListas(page);
  await page.route(/\/api\/flito\/derechos\/drive\/archivos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARCHIVOS_DRIVE) }));
}

test.describe('FLITO — Derechos · Drive de la secretaría', () => {
  test('lista los consolidados y distingue el ya procesado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDrive(page);

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Drive · Medellín/ }).click();

    await expect(page.getByRole('cell', { name: 'FLIT 18-07-2026.pdf' })).toBeVisible();
    // El ya procesado se marca, pero se puede reprocesar: el organismo puede reemplazar el archivo.
    await expect(page.getByRole('row').filter({ hasText: 'FLIT 18-07-2026.pdf' }).getByRole('button', { name: 'Procesar' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT 17-07-2026.pdf' }).getByRole('button', { name: 'Reprocesar' })).toBeVisible();
  });

  test('procesar el día asocia y muestra el resultado por canasta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDrive(page);
    let pedido = '';
    await page.route(/\/api\/flito\/derechos\/drive\/procesar/, (route) => {
      pedido = route.request().postData() ?? '';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        archivo: 'FLIT 18-07-2026.pdf', totalPaginas: 13, cuentasDetectadas: 12, placasUnicas: 12,
        registrados: [{ archivo: 'QYS441.pdf', placa: 'QYS441', idFlit: 'FLIT-0125621', registroId: 'd1', valor: '236700', detalle: 'Registrado.' }],
        enRevision: [], duplicados: [],
        pendientes: [{ archivo: 'QYS999.pdf', placa: 'QYS999', idFlit: null, registroId: null, valor: null, detalle: 'Sin trámite todavía.' }],
        omitidas: [], fallidos: [],
      }) });
    });

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Drive · Medellín/ }).click();
    await page.getByRole('row').filter({ hasText: 'FLIT 18-07-2026.pdf' }).getByRole('button', { name: 'Procesar' }).click();

    await expect.poll(() => pedido).toContain('f1');
    // El panel de resultados vive por encima de las pestañas: se ve sin cambiar de sitio.
    await expect(page.getByText(/Resultado de la carga/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'QYS441', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'FLIT-0125621' })).toBeVisible();
  });

  test('si el Drive no responde se dice, sin romper las otras pestañas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    await page.route(/\/api\/flito\/derechos\/drive\/archivos/, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'El Drive no está disponible' }) }));

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Drive · Medellín/ }).click();
    await expect(page.getByText(/no está disponible/)).toBeVisible();

    // La otra pestaña sigue funcionando: un Drive caído no puede tumbar el listado de registrados.
    await page.getByRole('button', { name: /Registrados/ }).click();
    await expect(page.getByRole('cell', { name: 'QTP701' })).toBeVisible();
  });
});
