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
const PENDIENTES = [
  {
    id: 'p1', concepto: 'derecho', placa: 'NOP111', valor: '150000.00', fechaPago: '2026-05-25',
    tipoTramiteRecibo: 'MATRICULA INICIAL', organismoCodigo: '05001', origen: 'manual',
    intentos: 3, ultimoIntentoEn: '2026-05-26T08:00:00Z', soporteId: 'sop3',
    nombreArchivo: 'NOP111.pdf', createdAt: '2026-05-25T10:00:00Z',
  },
  {
    id: 'p2', concepto: 'soat', placa: null, valor: null, fechaPago: null,
    tipoTramiteRecibo: null, organismoCodigo: null, origen: 'carga_masiva',
    intentos: 1, ultimoIntentoEn: '2026-05-26T08:00:00Z', soporteId: 'sop4',
    nombreArchivo: 'ilegible.pdf', createdAt: '2026-05-26T10:00:00Z',
  },
];

async function mockListas(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/derechos\/pendientes(\?|$)/, (route) => {
    const concepto = new URL(route.request().url()).searchParams.get('concepto');
    const filtrados = concepto ? PENDIENTES.filter((p) => p.concepto === concepto) : PENDIENTES;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filtrados) });
  });
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
    // El origen distingue lo cargado a mano de lo que llegó por el Drive del organismo.
    // Se acota a la celda: "drive" también aparece en el enlace «Google Drive» del menú lateral.
    await expect(page.getByRole('cell', { name: 'drive', exact: true })).toBeVisible();
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

  test('la bandeja de pendientes muestra los intentos y permite reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    let reintentado = false;
    await page.route(/\/api\/flito\/derechos\/pendientes\/reintentar$/, (route) => {
      reintentado = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revisados: 1, asociados: 1 }) });
    });

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Sin cruzar \(2\)/ }).click();
    await expect(page.getByRole('cell', { name: 'NOP111', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'NOP111.pdf' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '3', exact: true })).toBeVisible(); // intentos

    await page.getByRole('button', { name: 'Reintentar ahora' }).click();
    await expect.poll(() => reintentado).toBe(true);
    await expect(page.getByText(/1 de 1 pendiente\(s\) asociado\(s\)/)).toBeVisible();
  });

  test('la bandeja distingue el origen del recibo y se puede filtrar por él', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Sin cruzar \(2\)/ }).click();

    // Los tres conceptos conviven en una sola bandeja: es una cosa que atender, no tres.
    await expect(page.getByRole('cell', { name: 'Derecho' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'SOAT' })).toBeVisible();

    await page.getByRole('button', { name: 'SOAT', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'ilegible.pdf' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'NOP111.pdf' })).toHaveCount(0);
  });

  test('un recibo sin placa legible se archiva igual, y se dice que no la tiene', async ({ page }) => {
    // Es el caso peor: sin placa nadie lo puede volver a buscar, así que descartarlo era lo más caro.
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Sin cruzar \(2\)/ }).click();
    await expect(page.getByRole('cell', { name: 'Sin placa' })).toBeVisible();
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

    // Las otras dos siguen funcionando.
    await page.getByRole('button', { name: /Sin cruzar/ }).click();
    await expect(page.getByRole('cell', { name: 'NOP111', exact: true })).toBeVisible();
  });
});
