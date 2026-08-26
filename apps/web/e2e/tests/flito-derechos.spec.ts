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
    // Carga manual: solo hay nombre de fichero, no hay barrido ni páginas.
    archivoOrigen: 'recibos-mayo.pdf', paginas: null, procesamientoId: null, procesamientoArchivo: null,
  },
  {
    id: 'd2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', organismoCodigo: '05001',
    empresa: 'Concesionario Sur', valor: '198300.00', fechaPago: '2026-05-24',
    numeroRadicado: '1005504348', tipoTramiteRecibo: 'TRASPASO', origen: 'drive',
    advertencias: ['El concepto del recibo dice "TRASPASO" y el trámite es "MATRICULA INICIAL".'],
    soporteId: 'sop2', createdAt: '2026-05-24T10:00:00Z',
    // Del Drive: el consolidado, el barrido que lo leyó y las páginas de esta placa.
    archivoOrigen: 'FLIT 24-05-2026.pdf', paginas: [4, 5], procesamientoId: 12,
    procesamientoArchivo: 'FLIT 24-05-2026.pdf',
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
    // Sin `exact`: la celda lleva ahora también el archivo del que salió el recibo, debajo del chip.
    await expect(page.getByRole('cell', { name: /Drive de la secretaría/ })).toBeVisible();
    // Una discrepancia de concepto no bloquea el registro pero queda visible.
    // Acotado a la fila: «Con advertencia» es ahora también el nombre de un filtro inteligente, y
    // sin acotar la aserción no distinguiría el chip del trámite del preset del desplegable.
    await expect(page.getByRole('row', { name: /XYZ789/ }).getByText('Con advertencia')).toBeVisible();
    // La fecha de pago no lleva hora: formatearla con `new Date(...)` la interpretaría como
    // medianoche UTC y en hora de Colombia retrocedería un día (el recibo dice 23, se veía 22).
    await expect(page.getByRole('cell', { name: '23/5/2026', exact: true })).toBeVisible();
  });

  test('el origen dice de qué archivo salió el recibo, no solo por dónde entró', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);

    await page.goto('/flito/derechos');
    // «Drive» dice el canal; con un consolidado de trece páginas al día eso no basta para volver al
    // papel cuando alguien reclama. Hace falta el archivo, y la página dentro de él.
    await expect(page.getByText('FLIT 24-05-2026.pdf · pág. 4–5')).toBeVisible();
    // En la carga manual no hay páginas que citar: solo el fichero que se subió.
    await expect(page.getByText('recibos-mayo.pdf', { exact: true })).toBeVisible();
  });

  test('un derecho anterior al cambio lo dice, en vez de fingir que no vino de ningún sitio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/derechos\/facetas/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ organismos: [], origenes: [] }),
    }));
    await page.route(/\/api\/flito\/derechos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{ ...DERECHOS[0], archivoOrigen: null, procesamientoArchivo: null, paginas: null }],
        total: 1, page: 1, pageSize: 50,
      }),
    }));

    await page.goto('/flito/derechos');
    // Los 56 derechos que ya existían no son atribuibles: en cualquier ventana de diez minutos hubo
    // tres barridos. Se dice, en vez de dejar el hueco en blanco.
    await expect(page.getByText('Archivo no registrado')).toBeVisible();
  });

  test('desde un derecho se ven los documentos de los tres conceptos del trámite', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockListas(page);
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([
        { id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: 'https://x/soat.pdf', subidoEn: '2026-05-20T10:00:00Z' },
        { id: 's2', origen: 'impuesto', tipo: 'recibo_impuesto', nombreArchivo: 'impuesto.pdf', url: 'https://x/imp.pdf', subidoEn: '2026-05-21T10:00:00Z' },
        { id: 's3', origen: 'derecho', tipo: 'derecho_tramite', nombreArchivo: 'derecho.pdf', url: 'https://x/der.pdf', subidoEn: '2026-05-23T10:00:00Z' },
      ]),
    }));

    await page.goto('/flito/derechos');
    await page.getByRole('row', { name: /QTP701/ }).getByRole('button', { name: 'Ver todos' }).click();

    // Quien revisa un derecho quiere comprobar si el SOAT y el impuesto del mismo trámite están
    // cargados; hasta ahora tenía que irse al reporte de costos para averiguarlo.
    await expect(page.getByText('Documentos de FLIT-1001')).toBeVisible();
    await expect(page.getByText('3 documento(s)')).toBeVisible();
    await expect(page.getByRole('button', { name: /SOAT/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Impuesto/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Derecho de tránsito/ })).toBeVisible();
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
  { fileId: 'f1', nombre: 'FLIT 18-07-2026.pdf', tamanoBytes: 1_782_000, modificadoEn: '2026-07-18T10:00:00Z', modificadoPor: 'carteraitsmedellin', omitidoEn: null, procesadoEn: null },
  { fileId: 'f2', nombre: 'FLIT 17-07-2026.pdf', tamanoBytes: 900_000, modificadoEn: '2026-07-17T10:00:00Z', modificadoPor: 'carteraitsmedellin', omitidoEn: null, procesadoEn: '2026-07-17T18:00:00Z' },
];

async function mockDrive(page: import('@playwright/test').Page) {
  await mockListas(page);
  await page.route(/\/api\/flito\/derechos\/drive\/archivos/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ARCHIVOS_DRIVE) }));
  await page.route(/\/api\/flito\/derechos\/drive\/registro/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { id: 1, fileId: 'f2', nombreArchivo: 'FLIT 17-07-2026.pdf', estado: 'completado', modificadoPor: 'carteraitsmedellin', modificadoEn: '2026-07-17T10:00:00Z', totalPaginas: 13, cuentasDetectadas: 12, placasUnicas: 11, valorTotal: '4180000', error: null, procesadoEn: '2026-07-17T18:00:00Z', sigueEnDrive: true },
      { id: 2, fileId: 'f9', nombreArchivo: 'FLIT 01-06-2026.pdf', estado: 'completado', modificadoPor: 'carteraitsmedellin', modificadoEn: '2026-06-01T10:00:00Z', totalPaginas: 9, cuentasDetectadas: 8, placasUnicas: 8, valorTotal: '2900000', error: null, procesadoEn: '2026-06-01T18:00:00Z', sigueEnDrive: false },
    ]),
  }));
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

  test('la tabla dice quién modificó el archivo, no solo cuándo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDrive(page);

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Drive · Medellín/ }).click();
    // En una carpeta compartida la fecha sola no es accionable: hay que saber a quién preguntar.
    await expect(page.getByText('por carteraitsmedellin').first()).toBeVisible();
  });

  test('el registro conserva los archivos que ya no están en el Drive', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDrive(page);

    await page.goto('/flito/derechos');
    await page.getByRole('button', { name: /Drive · Medellín/ }).click();
    await page.getByRole('button', { name: /Ver el registro/ }).click();

    // Es el motivo de que el registro exista: si el organismo borra un consolidado, queda constancia
    // de que existió, de qué se extrajo y de quién lo había subido.
    const desaparecido = page.getByRole('row').filter({ hasText: 'FLIT 01-06-2026.pdf' });
    await expect(desaparecido.getByText('Ya no está en el Drive')).toBeVisible();
    await expect(desaparecido.getByText('8 cuenta(s) · 8 placa(s)')).toBeVisible();
    // El que sigue en la carpeta no lleva ese aviso.
    const vigente = page.getByRole('row').filter({ hasText: 'FLIT 17-07-2026.pdf' });
    await expect(vigente.getByText('Ya no está en el Drive')).toHaveCount(0);
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
