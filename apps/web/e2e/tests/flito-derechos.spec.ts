import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Derechos de trámite (HU #10951). Carga de recibos, resultado clasificado por canasta y
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

const PENDIENTES = [
  {
    id: 'p1', placa: 'NOP111', valor: '150000.00', fechaPago: '2026-05-25',
    tipoTramiteRecibo: 'MATRICULA INICIAL', organismoCodigo: '05001', origen: 'manual',
    intentos: 3, ultimoIntentoEn: '2026-05-26T08:00:00Z', soporteId: 'sop3',
    nombreArchivo: 'NOP111.pdf', createdAt: '2026-05-25T10:00:00Z',
  },
];

async function mockListas(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/derechos\/pendientes$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDIENTES) }));
  await page.route(/\/api\/flito\/derechos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: DERECHOS, total: DERECHOS.length, page: 1, pageSize: 50 }) }));
}

test.describe('FLITO — Derechos de trámite', () => {
  test('operaciones ve el listado con valor, origen y advertencias', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);

    await page.goto('/flito/derechos');
    await expect(page.getByRole('heading', { name: 'Derechos de trámite' })).toBeVisible();
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
    await page.getByRole('button', { name: /Sin trámite \(1\)/ }).click();
    await expect(page.getByRole('cell', { name: 'NOP111', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'NOP111.pdf' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '3', exact: true })).toBeVisible(); // intentos

    await page.getByRole('button', { name: 'Reintentar ahora' }).click();
    await expect.poll(() => reintentado).toBe(true);
    await expect(page.getByText(/1 de 1 pendiente\(s\) asociado\(s\)/)).toBeVisible();
  });
});
