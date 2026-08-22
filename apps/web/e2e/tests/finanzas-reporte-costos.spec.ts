import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// HU #10967 — Reporte de costos. Liquidar, facturar y consultar soportes sin salir de la pantalla.
// Las filas liquidadas muestran valores sellados; el resto, un estimado. Backend mockeado.

const FILA_ESTIMADA = {
  tramiteId: 'aaaa0000-0000-0000-0000-000000000001', idFlit: 'FLIT-2001', placa: 'ABC123',
  estado: 'Aprobado', empresa: 'ACME SAS', tipoTramite: 'Traspaso',
  vin: 'LRWYGCEK2TC771456', marca: 'Chevrolet', linea: 'Onix',
  fechaAprobacion: '2026-07-14T15:30:00.000Z', fechaCreacion: '2026-07-02T10:00:00.000Z',
  soat: 450000, impuesto: 120000, derechoTramite: 80000, logistica: 15000, tramiteDigital: 200000,
  gmf: 3460, total: 868460, sellada: false, estadoLiquidacion: null, noConfigurados: [], sinRecibo: [],
  pendientesPago: [], autogestionados: [], noAplican: [],
  // El reporte manda estas tres columnas en cada fila (HU #11329): la celda «Factura DIAN» las usa
  // para pintar «En cola» cuando todavía no existe ninguna factura.
  estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
  // Y estas tres desde la HU #11679: la conciliación del SOAT de la fila. El caso normal es que el
  // SOAT NO esté conciliado, y así queda en todas las fixtures salvo en la que lo prueba.
  soatConciliado: false, boletaReferencia: null, soatConciliadoEn: null,
};
const FILA_BLOQUEADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000002', idFlit: 'FLIT-2002',
  fechaAprobacion: null,
  tramiteDigital: null, total: null, noConfigurados: ['Trámite digital'], sinRecibo: [],
};
const FILA_LIQUIDADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000003', idFlit: 'FLIT-2003',
  sellada: true, estadoLiquidacion: 'liquidado',
};
const FILA_FACTURADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000004', idFlit: 'FLIT-2004',
  sellada: true, estadoLiquidacion: 'facturado',
};

/**
 * Derecho sin recibo, pero con TODAS las tarifas puestas. Distingue los dos motivos de ausencia: el
 * derecho de tránsito no se configura en ninguna pantalla, se lee del recibo pagado.
 */
const FILA_SIN_RECIBO = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000005', idFlit: 'FLIT-2005',
  derechoTramite: null, total: null, noConfigurados: [], sinRecibo: ['Derecho de tránsito'],
};

/** SOAT comprado pero aún sin pagar, y un impuesto que la compañía se gestiona sola. */
const FILA_SIN_PAGAR = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000006', idFlit: 'FLIT-2006',
  soat: null, impuesto: null, total: null,
  pendientesPago: ['SOAT'], autogestionados: ['Impuesto'],
};

/**
 * Un SOAT que ya se descontó de bolsa al conciliar una boleta de pago externo (Feature #11623).
 *
 * Clon EXACTO de la fila estimada salvo por los tres campos de conciliación —y por el id, que tiene
 * que ser único—. Esa igualdad es lo que sostiene la comprobación del hueco del AC2: si las dos
 * filas solo se diferencian en la conciliación, cualquier diferencia de alto entre ellas la produce
 * la marca, y ninguna otra cosa.
 */
const FILA_CONCILIADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000007', idFlit: 'FLIT-2007',
  soatConciliado: true, boletaReferencia: 'BOL-000123', soatConciliadoEn: '2026-08-14T15:30:00.000Z',
};

/** Lo que la marca dice cuando se le pide el detalle. Una sola definición: se afirma en tres tests. */
const DETALLE_BOLETA = 'Boleta BOL-000123 · 14 de ago de 26';

const REPORTE = {
  items: [FILA_ESTIMADA, FILA_BLOQUEADA, FILA_LIQUIDADA, FILA_FACTURADA, FILA_SIN_RECIBO, FILA_SIN_PAGAR],
  total: 6, page: 1, pageSize: 50,
  totales: {
    soat: 1800000, impuesto: 480000, derechoTramite: 320000, logistica: 60000,
    tramiteDigital: 600000, gmf: 10400, total: 3270400, filasIncompletas: 1,
  },
  resumen: { listo: 1, incompleto: 3, porFacturar: 1, facturado: 1 },
};

/** Las facetas del filtro. `empresas` trae una entrada por EMPRESA, con su nombre, nunca su NIT. */
async function mockFacetas(page: import('@playwright/test').Page, estados: string[]) {
  await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados, empresas: [{ valor: '900111,9001112', nombre: 'ACME SAS' }], tipos: ['Traspaso', 'Matricula'],
    }) }));
}

/**
 * Facturación electrónica (HU #11337). Se mockea SIEMPRE, aunque el test no la mire: la pantalla la
 * consulta al abrirse, y dejarla sin ruta haría que todos los casos anteriores pintaran el estado de
 * error de los contadores. Un mock que solo cubre lo que el test afirma deja el resto en un estado
 * que nadie eligió.
 */
const RESUMEN_FE = {
  no_enviado: 3, encolado: 0, en_proceso: 1, emitido: 0, aceptado: 1, rechazado: 1, anulado: 0,
  fallido: 0, total: 6,
};

const FICHA_ACEPTADA = {
  tramiteId: FILA_FACTURADA.tramiteId, facturaId: 'f-aceptada', numero: 'FV-1-100',
  estadoEmision: 'emitida', estado: 'aceptado', estadoDian: 'aceptada', motivo: null,
  // Timbrada: estas fichas son las de producción, que son las que tienen estado ante la DIAN.
  timbrada: true,
  motivoPendiente: false, verificadoEn: '2026-08-10T10:00:00.000Z', cufe: 'cufe-100',
  // Sin nada que revisar, que es el caso normal. Las fichas de la HU #11331 lo sobrescriben.
  revisionMotivo: null,
  documentos: { pdf: true, xml: true }, correo: { veces: 1, ultimoEnviadoEn: '2026-08-09T10:00:00.000Z' },
};

/**
 * A6 — creada en Siigo pero NO enviada a la DIAN, porque no se emitió desde producción.
 *
 * Sin CUFE y sin verificación, y las dos ausencias son consecuencia de `timbrada: false`, no ruido
 * de la fixture: el sondeo ni siquiera mira estas facturas, así que su `estadoDian` es `null` para
 * siempre.
 */
const FICHA_SIN_TIMBRAR = {
  ...FICHA_ACEPTADA, tramiteId: FILA_FACTURADA.tramiteId, facturaId: 'f-sin-timbrar',
  estado: 'emitido', estadoDian: null, timbrada: false, cufe: null, verificadoEn: null,
  documentos: { pdf: false, xml: false },
};

const FICHA_RECHAZADA = {
  ...FICHA_ACEPTADA, tramiteId: FILA_LIQUIDADA.tramiteId, facturaId: 'f-rechazada',
  estado: 'rechazado', estadoDian: 'rechazada',
  motivo: 'La resolución DIAN no es válida o está vencida. Revísala en Siigo Nube.',
  documentos: { pdf: false, xml: false },
};

/**
 * Elegibilidad (HU #11329). Se mockea SIEMPRE, por la misma razón que los contadores: con un rol que
 * puede emitir, la pantalla la consulta al abrirse en cuanto hay un trámite `facturado`, y dejarla
 * sin ruta pintaría la tarjeta de envío en su estado de error — con un «Reintentar» de más que
 * rompe las búsquedas por rol de los casos que ni la miran.
 */
async function mockElegibilidad(page: import('@playwright/test').Page) {
  await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      items: [{ tramiteId: FILA_FACTURADA.tramiteId, elegible: true, motivos: [] }],
      resumen: {
        total: 1, elegibles: 1, noElegibles: 0, anterioresAlCorte: 0,
        porMotivo: {
          liquidacion_no_facturada: 0, documentacion_incompleta: 0, anterior_al_corte: 0,
          sin_compania: 0, tercero_sin_vincular: 0, cliente_no_facturable: 0,
          compuerta_cerrada: 0, ya_facturado: 0,
        },
      },
    }) }));
}

async function mockFacturacion(
  page: import('@playwright/test').Page,
  fichas = [FICHA_ACEPTADA, FICHA_RECHAZADA],
  resumen: unknown = RESUMEN_FE,
) {
  await page.route(/\/api\/finanzas\/reporte-costos\/facturacion-electronica/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resumen) }));
  await page.route(/\/api\/siigo\/facturacion\/tramites/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: fichas }) }));
  await mockElegibilidad(page);
}

async function mock(page: import('@playwright/test').Page) {
  await mockFacetas(page, ['Aprobado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
}

/** Igual que `mock`, pero con las dos únicas filas que la marca de conciliado necesita (HU #11681). */
async function mockConciliacion(page: import('@playwright/test').Page) {
  await mockFacetas(page, ['Aprobado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...REPORTE, items: [FILA_ESTIMADA, FILA_CONCILIADA], total: 2,
    }) }));
}

test.describe('Finanzas — Reporte de costos', () => {
  test('distingue sellado, facturado y estimado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByText('Estimado')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2003' }).getByText('Liquidado')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2004' }).getByText('Facturado')).toBeVisible();
  });

  test('el estado va en su propia columna, no colgando del identificador', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // Bajo el id del trámite el chip se leía como un estado DEL TRÁMITE; es de su liquidación.
    await expect(page.getByRole('columnheader', { name: 'Liquidación' })).toBeVisible();

    // La prueba de que salió del identificador: la celda del estado contiene el estado y nada más.
    const celdaEstado = page.getByRole('row').filter({ hasText: 'FLIT-2003' })
      .getByRole('cell').filter({ hasText: 'Liquidado' });
    await expect(celdaEstado).toHaveText('Liquidado');
    await expect(celdaEstado).not.toContainText('FLIT-2003');
  });

  test('muestra la fecha de aprobación, y dice cuándo no la hay', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByText('14 de jul de 26')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2002' }).getByText('Sin aprobar')).toBeVisible();
  });

  test('las columnas comunes traen trámite, vehículo y las dos fechas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // Las mismas tres columnas que las demás tablas: la pregunta «¿de qué trámite hablamos?» se
    // contestaba distinto en cada pantalla.
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2001' });
    await expect(fila).toContainText('Traspaso');
    await expect(fila).toContainText('LRWYGCEK2TC771456');
    await expect(fila).toContainText('Chevrolet Onix');
    await expect(fila).toContainText('2 de jul de 26');
  });

  test('cada etapa del cobro se pide con un clic, y son excluyentes', async ({ page }) => {
    // Lo que se viene a preguntar aquí —«qué puedo liquidar ya», «qué falta por facturar»— era una
    // combinación de dos desplegables, y «listo para liquidar» no se podía pedir de ninguna manera.
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: /Listos para liquidar/ }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('etapa=listo');

    await page.getByRole('button', { name: /Facturados/ }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('etapa=facturado');
    // Excluyentes: elegir una quita la anterior, no se acumulan.
    expect(urls.at(-1)).not.toContain('etapa=listo');

    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect.poll(() => urls.at(-1) ?? '').not.toContain('etapa=');
  });

  test('cada etapa lleva cuántos trámites hay dentro', async ({ page }) => {
    // Sin el número hay que entrar en cada pestaña para saber si tiene trabajo dentro.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('button', { name: 'Listos para liquidar 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Por facturar 1' })).toBeVisible();
  });

  test('el filtro de soportes completos viaja al servidor y dice qué filtra', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    const soportes = page.getByText('Solo con soportes completos');
    // Un filtro que no dice qué está filtrando es peor que ninguno: quien mira la lista no sabe qué
    // se le está quedando fuera, y aquí lo que se salta son los conceptos que la compañía autogestiona.
    await expect(soportes).toHaveAttribute('title', /saltando los que la compañía autogestiona/);
    await soportes.click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('documentacionCompleta=si');
    await expect.poll(() => urls.at(-1) ?? '').toContain('estados=Aprobado');
  });

  test('arranca filtrado por Aprobado y los dos rangos de fecha viajan por separado', async ({ page }) => {
    // El estado por defecto se comprueba sobre la petición, no sobre el estilo del control: es
    // lo que de verdad determina qué filas se traen.
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado', 'Entregado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => urls[0] ?? '').toContain('estados=Aprobado');

    // Cada rango es un calendario propio (HU #11026): se elige el tramo y viaja completo.
    const rango = (etiqueta: string) => page.locator('summary').filter({ hasText: etiqueta });
    await rango('Creación').click();
    await page.getByRole('button', { name: 'Este mes' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('desde=');

    await rango('Aprobación').click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('aprobadoDesde=');
    // Los dos viajan a la vez y por separado: uno no pisa al otro.
    expect(urls.at(-1)).toContain('desde=');
  });

  test('el estado se elige en un solo control, que dice qué hay puesto sin abrirlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado', 'Entregado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    // Plegado ya dice cuál está puesto: no hay que abrirlo para saber qué se está mirando.
    const estado = page.locator('summary').filter({ hasText: 'Estado' });
    await expect(estado).toContainText('Aprobado');

    await estado.click();
    await page.getByRole('checkbox', { name: 'Entregado' }).check();
    await expect.poll(() => urls.at(-1) ?? '').toContain('Entregado');
    await expect(estado).toContainText('2 seleccionados');
  });

  test('limpiar filtros vuelve a Aprobado, no a todos los estados', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado', 'Entregado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.locator('summary').filter({ hasText: 'Estado' }).click();
    await page.getByRole('checkbox', { name: 'Entregado' }).check();
    await page.locator('summary').filter({ hasText: 'Creación' }).click();
    await page.getByRole('button', { name: 'Este mes' }).click();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('estados=Aprobado');
    expect(urls.at(-1)).not.toContain('Entregado');
    expect(urls.at(-1)).not.toContain('desde=');
  });

  test('el derecho de tránsito sin recibo NO dice «No configurado»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // El derecho no se configura: es un desembolso real que se lee del recibo, como el SOAT y el
    // impuesto. El rótulo viejo mandaba a buscar una parametrización que no existe.
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2005' });
    await expect(fila.getByText('Sin recibo')).toBeVisible();
    await expect(fila.getByText('No configurado')).toHaveCount(0);
    // Y sigue sin poder liquidarse: falta un costo que existe. Se nombra en el aviso.
    await expect(fila.getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(fila.getByText('Falta: Derecho de tránsito')).toBeVisible();
  });

  test('un SOAT sin pagar bloquea la liquidación, y lo dice', async ({ page }) => {
    // El botón se ofrecía activo y el backend rechazaba el sellado al pulsarlo: el reporte solo
    // miraba tarifas y recibos, y no que el SOAT o el impuesto siguieran sin pagar.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2006' });
    await expect(fila.getByText('Sin pagar')).toBeVisible();
    await expect(fila.getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(fila.getByText('Falta: SOAT')).toBeVisible();
  });

  test('lo que la compañía autogestiona se dice, no se deja en blanco', async ({ page }) => {
    // Un guion se leía como «falta algo». Aquí no falta nada: FLITO no lo cobra.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2006' }).getByText('Autogestiona')).toBeVisible();
  });

  test('el desplegable de empresas enseña el nombre, nunca el NIT', async ({ page }) => {
    // Cada empresa salía dos veces —una con su nombre y otra como un NIT crudo— porque sus trámites
    // llegan con el NIT escrito de dos maneras. Ahora es una sola entrada que filtra por las dos.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const empresas = page.getByLabel('Empresa');
    await expect(empresas.getByRole('option')).toHaveText(['Todas las empresas', 'ACME SAS']);
    await empresas.selectOption('900111,9001112');
  });

  test('un concepto sin tarifa se muestra como «No configurado», no como cero', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2002' });
    await expect(fila.getByText('No configurado').first()).toBeVisible();
    await expect(fila.getByText('$ 0')).toHaveCount(0);
  });

  test('avisa de que el total está incompleto y lleva a los trámites que lo causan', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText(/tienen algún concepto sin\s+resolver/)).toBeVisible();

    // El aviso servía de poco si para ver esos trámites había que armar el filtro a mano.
    await page.getByRole('button', { name: 'Ver cuáles' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('etapa=incompleto');
  });

  test('los totales son del filtro entero, no de la página', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('Totales (6 trámites del filtro)')).toBeVisible();
  });

  test('no se puede liquidar una fila con conceptos pendientes, y se dice cuál falta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const bloqueada = page.getByRole('row').filter({ hasText: 'FLIT-2002' });
    await expect(bloqueada.getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(bloqueada.getByText(/Falta: Trámite digital/)).toBeVisible();

    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Liquidar' })).toBeEnabled();
  });

  test('liquidar una fila llama al backend', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let llamado = '';
    await page.route(/\/api\/flito\/liquidacion\/.*\/liquidar/, (route) => {
      llamado = route.request().url();
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Liquidar' }).click();
    await expect.poll(() => llamado).toContain(FILA_ESTIMADA.tramiteId);
  });

  test('un trámite facturado ya no ofrece reversar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const liquidada = page.getByRole('row').filter({ hasText: 'FLIT-2003' });
    await expect(liquidada.getByRole('button', { name: 'Reversar' })).toBeVisible();
    await expect(liquidada.getByRole('button', { name: 'Facturar' })).toBeVisible();

    const facturada = page.getByRole('row').filter({ hasText: 'FLIT-2004' });
    await expect(facturada.getByRole('button', { name: 'Reversar' })).toHaveCount(0);
    await expect(facturada.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
  });

  test('el reverso exige un motivo antes de confirmar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const liquidada = page.getByRole('row').filter({ hasText: 'FLIT-2003' });
    await liquidada.getByRole('button', { name: 'Reversar' }).click();
    await expect(liquidada.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await liquidada.getByLabel('Motivo del reverso').fill('error de tarifa');
    await expect(liquidada.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
  });

  test('el visor lista TODOS los documentos del trámite, de los cuatro orígenes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: '/api/files?key=a', subidoEn: '2026-07-01T00:00:00Z' },
        { id: 's2', origen: 'derecho', tipo: 'derecho_tramite', nombreArchivo: 'recibo.pdf', url: '/api/files?key=b', subidoEn: '2026-07-02T00:00:00Z' },
        { id: 's3', origen: 'impuesto', tipo: 'recibo_impuesto', nombreArchivo: 'impuesto.pdf', url: '/api/files?key=c', subidoEn: '2026-07-03T00:00:00Z' },
        { id: 's4', origen: 'logistica', tipo: 'acta_entrega', nombreArchivo: 'Acta de entrega.pdf', url: '/api/files?key=d', subidoEn: '2026-07-04T00:00:00Z' },
      ]) }));

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByText('Documentos de FLIT-2001')).toBeVisible();
    // Un trámite con los cuatro cargados tiene que enseñar los cuatro, no el primero que se halló.
    await expect(page.getByRole('button').filter({ hasText: 'SOAT' }).filter({ hasText: 'soat.pdf' })).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'Derecho de tránsito' }).filter({ hasText: 'recibo.pdf' })).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'Impuesto' }).filter({ hasText: 'impuesto.pdf' })).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'Logística' }).filter({ hasText: 'Acta de entrega.pdf' })).toBeVisible();
    await expect(page.getByText(/4 documento\(s\)/)).toBeVisible();
  });

  test('un documento cargado después aparece al actualizar, sin cerrar el visor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    // Primero solo hay SOAT; el interruptor simula que alguien carga el impuesto en otra pestaña.
    // No sirve contar llamadas: en desarrollo StrictMode invoca el efecto dos veces al montar.
    let impuestoCargado = false;
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) => {
      const soat = { id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: '/api/files?key=a', subidoEn: '2026-07-01T00:00:00Z' };
      const imp = { id: 's3', origen: 'impuesto', tipo: 'recibo_impuesto', nombreArchivo: 'impuesto.pdf', url: '/api/files?key=c', subidoEn: '2026-07-03T00:00:00Z' };
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(impuestoCargado ? [soat, imp] : [soat]),
      });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByRole('button').filter({ hasText: 'impuesto.pdf' })).toHaveCount(0);

    impuestoCargado = true;
    await page.getByRole('button', { name: 'Actualizar' }).click();
    await expect(page.getByRole('button').filter({ hasText: 'impuesto.pdf' })).toBeVisible();
    // El documento que se estaba mirando no se pierde de vista al recargar la lista.
    await expect(page.getByRole('button').filter({ hasText: 'soat.pdf' })).toBeVisible();
  });

  test('un trámite sin soportes lo dice en vez de fallar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByText(/no tiene ningún documento cargado/)).toBeVisible();
  });

  test('auditor consulta y ve soportes, pero no liquida ni factura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Soporte' }).first()).toBeVisible();
    // Dentro de la tabla: las pestañas de etapa del filtro también se llaman «…liquidar» y
    // «…facturar», y lo que se comprueba aquí es que no haya acciones en las filas.
    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('button', { name: 'Liquidar' })).toHaveCount(0);
    await expect(tabla.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
    await expect(tabla.getByRole('button', { name: 'Reversar' })).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11337 — facturación electrónica dentro del reporte de costos.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Reporte de costos — facturación electrónica', () => {
  test('los contadores se ven y dicen cuántos hay en cada punto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // El total se muestra para poder comprobar que los grupos cuadran. Un tablero cuyos grupos no
    // suman el total no se nota mirando los grupos: se nota tres semanas después, conciliando.
    await expect(page.getByText('6 trámite(s) en el filtro actual')).toBeVisible();
    // Por el nombre COMPLETO de la pastilla: la celda de la fila rechazada es otro botón que se
    // llama igual, y una búsqueda parcial devuelve los dos.
    await expect(page.getByRole('button', { name: 'Rechazada por la DIAN 1' })).toBeVisible();
  });

  test('un rechazo se explica en la fila, sin abrir nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // El motivo va en el `title` de la celda: en una tabla de doscientas filas, obligar a abrir un
    // modal por fila para saber por qué falló es hacer doscientos clics para leer un informe.
    const celda = page.getByTitle(/resolución DIAN no es válida/);
    await expect(celda).toBeVisible();
  });

  test('la ficha explica el rechazo y NO ofrece una consulta que se queda esperando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-rechazada', veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null, envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/resolución DIAN no es válida/).click();

    await expect(page.getByText('Motivo del rechazo')).toBeVisible();
    await expect(page.getByText(/resolución DIAN no es válida/)).toBeVisible();
    // AC3 — la DIAN no responde al instante, así que no hay botón que prometa una consulta en vivo.
    await expect(page.getByRole('button', { name: /Consultar estado/i })).toHaveCount(0);
    await expect(page.getByText(/Última verificación ante la DIAN/)).toBeVisible();
  });

  test('auditor ve el estado pero no puede reenviar el correo', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-aceptada', veces: 1, vecesEnviado: 1,
        ultimo: { id: 'e1', origen: 'reenvio', resultado: 'enviado', destinatarios: [{ correo: 'pagos@acme.test', origen: 'compania' }], motivo: null, codigo: null, creadoEn: '2026-08-09T10:00:00.000Z' },
        ultimoEnviado: { id: 'e1', origen: 'reenvio', resultado: 'enviado', destinatarios: [], motivo: null, codigo: null, creadoEn: '2026-08-09T10:00:00.000Z' },
        envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/Aceptada por la DIAN — ver detalle/).first().click();

    // Auditar es mirar. Ve el estado y la entrega; no ve la acción que modifica.
    await expect(page.getByText('Entrega al cliente')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reenviar correo' })).toHaveCount(0);
  });

  test('A6 — una factura sin timbrar lo dice, y no promete una verificación que no va a llegar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page, [FICHA_SIN_TIMBRAR]);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-sin-timbrar', veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null, envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/Emitida — ver detalle/).first().click();

    await expect(page.getByText(/no se envió a la DIAN/)).toBeVisible();
    await expect(page.getByText('Sin enviar a la DIAN')).toBeVisible();
    // Lo que NO debe aparecer: el aviso de que la verificación corre sola. Después del filtro por
    // ambiente del sondeo, esa frase es falsa — el cron ya no mira estas facturas.
    await expect(page.getByText(/verificación ante la DIAN está en curso/)).toHaveCount(0);
    await expect(page.getByText(/Última verificación ante la DIAN/)).toHaveCount(0);
  });

  test('A6 — sin timbrar no se ofrece el reenvío, y se explica por qué', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page, [FICHA_SIN_TIMBRAR]);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-sin-timbrar', veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null, envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/Emitida — ver detalle/).first().click();

    // El botón existe y está apagado, no desaparece: quien opera tiene que poder ver que la acción
    // existe y por qué hoy no. Es el mismo reparto que «Enviar a facturación» hace con sus motivos.
    const boton = page.getByRole('button', { name: 'Reenviar correo' });
    await expect(boton).toBeDisabled();
    await expect(boton).toHaveAttribute('title', /no se envió a la DIAN/);
    // Y no se nombra el correo del cliente al lado de un botón que no va a enviar nada.
    await expect(page.getByText('El correo al cliente solo sale desde producción.')).toBeVisible();
  });

  test('antes de reenviar se ve a qué dirección va', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-aceptada', veces: 1, vecesEnviado: 1,
        ultimo: { id: 'e1', origen: 'reenvio', resultado: 'enviado', destinatarios: [{ correo: 'pagos@acme.test', origen: 'compania' }], motivo: null, codigo: null, creadoEn: '2026-08-09T10:00:00.000Z' },
        ultimoEnviado: { id: 'e1', origen: 'reenvio', resultado: 'enviado', destinatarios: [], motivo: null, codigo: null, creadoEn: '2026-08-09T10:00:00.000Z' },
        envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/Aceptada por la DIAN — ver detalle/).first().click();

    // AC5 — se ve el destinatario ANTES de confirmar. Reenviar una factura a una dirección que no
    // se ha visto es mandar un documento fiscal a ciegas.
    await expect(page.getByText(/pagos@acme.test/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reenviar correo' })).toBeEnabled();
  });

  test('los documentos que aún no están archivados se dicen, no se ofrecen', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        facturaId: 'f-rechazada', veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null, envios: [],
      }) }));
    await page.goto('/finanzas/reporte-costos');

    await page.getByTitle(/resolución DIAN no es válida/).click();

    // AC6 — ofrecer una descarga que va a fallar es peor que decir que todavía no está.
    await expect(page.getByText(/se archivan cuando la DIAN acepta/)).toBeVisible();
  });

  test('si los contadores fallan, se dice y se puede reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await page.route(/\/api\/finanzas\/reporte-costos\/facturacion-electronica/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Base no disponible' }) }));
    await page.route(/\/api\/siigo\/facturacion\/tramites/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
    await mockElegibilidad(page);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
    await page.goto('/finanzas/reporte-costos');

    // AC2 — el error va ANTES que el vacío: si la carga falló, no se sabe si hay datos, y decir
    // «no hay ninguna factura todavía» sería afirmar algo que nadie ha comprobado.
    await expect(page.getByText(/No se pudo consultar el estado de la facturación/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    // Y el reporte sigue en pie: un fallo de facturación no puede tumbar la conciliación de costos.
    await expect(page.getByText('FLIT-2001')).toBeVisible();
  });

  test('sin ningún trámite enviado a facturación, se explica cuál es el primer paso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page, [], {
      no_enviado: 0, encolado: 0, en_proceso: 0, emitido: 0, aceptado: 0, rechazado: 0, anulado: 0,
      fallido: 0, total: 0,
    });
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByText(/El primer paso es liquidarlos/)).toBeVisible();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11681 — la marca de conciliado en la celda de SOAT, y de dónde sale el CSV.
//
// Describe propio: estos casos no comparten el reporte de seis filas de los de arriba. Se montan
// sobre DOS filas idénticas salvo por la conciliación, que es lo que permite atribuirle a la marca
// cualquier diferencia entre ellas.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Reporte de costos — conciliación del SOAT', () => {
  test('AC1 — el SOAT conciliado lo dice con texto, y al apuntarlo revela su boleta y su fecha', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    await page.goto('/finanzas/reporte-costos');

    const marca = page.getByRole('row').filter({ hasText: 'FLIT-2007' })
      .getByTestId('marca-soat-conciliado');
    // Escrito, no insinuado por el tono: es la mitad del criterio que no puede quedarse en color.
    await expect(marca).toContainText('Conciliado · bolsa');

    // El detalle NO está antes de pedirlo: la columna del dinero no se llena de texto de boleta.
    await expect(page.getByText(DETALLE_BOLETA)).toHaveCount(0);
    await marca.hover();
    await expect(page.getByText(DETALLE_BOLETA)).toBeVisible();
  });

  test('AC1 — el detalle sale también por teclado, y lo accesible no depende de llegar a revelarlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    await page.goto('/finanzas/reporte-costos');

    const marca = page.getByRole('row').filter({ hasText: 'FLIT-2007' })
      .getByRole('note', { name: /SOAT conciliado con la bolsa/ });

    // Sin foco y sin puntero: boleta y fecha ya están en el nombre accesible. Quien escucha la
    // tabla no depende ni de poder apuntar la marca ni de distinguir su color.
    await expect(marca).toHaveAccessibleName(`SOAT conciliado con la bolsa. ${DETALLE_BOLETA}.`);

    await marca.focus();
    await expect(page.getByText(DETALLE_BOLETA)).toBeVisible();

    // Y se quita de encima sin mover el foco: mientras está abierto tapa la celda de al lado
    // (WCAG 1.4.13).
    await page.keyboard.press('Escape');
    await expect(page.getByText(DETALLE_BOLETA)).toHaveCount(0);
  });

  test('AC2 — la fila sin conciliar se ve como siempre: ni marca, ni hueco reservado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    await page.goto('/finanzas/reporte-costos');

    const sinConciliar = page.getByRole('row').filter({ hasText: 'FLIT-2001' });
    const conciliada = page.getByRole('row').filter({ hasText: 'FLIT-2007' });

    const celdaSoat = sinConciliar.getByRole('cell').filter({ hasText: /450\.000/ });
    await expect(celdaSoat).toHaveCount(1);
    await expect(celdaSoat.getByTestId('marca-soat-conciliado')).toHaveCount(0);
    // Un solo elemento dentro: el importe. Un hueco reservado —un envoltorio vacío, una pastilla
    // invisible— sería un segundo nodo aunque no se viera nada en pantalla.
    await expect(celdaSoat.locator('*')).toHaveCount(1);

    // Y el hueco tampoco está puesto por CSS, que es lo que ninguna aserción de texto vería.
    //
    // Se mide por DESPLAZAMIENTO: la celda centra su contenido, así que un hueco reservado debajo
    // del importe lo empujaría hacia arriba. En la fila sin conciliar el importe está en el centro
    // exacto de su celda; en la conciliada, la marca sí lo sube. La segunda medición está para
    // probar que la primera discrimina: si el desplazamiento no se pudiera medir, las dos pasarían.
    const centro = async (l: import('@playwright/test').Locator) => {
      const caja = (await l.boundingBox())!;
      return caja.y + caja.height / 2;
    };
    const importe = (celda: import('@playwright/test').Locator) => celda.getByText(/450\.000/);
    expect(Math.abs(await centro(importe(celdaSoat)) - await centro(celdaSoat))).toBeLessThan(1);

    const celdaConciliada = conciliada.getByRole('cell').filter({ hasText: /450\.000/ });
    expect(await centro(importe(celdaConciliada))).toBeLessThan(await centro(celdaConciliada));
  });

  test('AC3 — el CSV lo sigue armando el servidor, que es donde vive la columna «SOAT conciliado»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);

    // A nivel de CONTEXTO: la exportación se abre en una pestaña nueva, y `page.route` no la ve.
    const pedidas: string[] = [];
    await page.context().route(/\/api\/finanzas\/reporte-costos\/export/, (route) => {
      pedidas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/csv', body: 'Trámite;SOAT conciliado\r\n' });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Exportar CSV' }).click();

    // La columna la añadió la HU #11679 en `aCsv`, con su prueba en la API. Lo que esta pantalla
    // tiene que garantizar es que no se le adelanta armando el archivo por su cuenta —con las 50
    // filas de la página en vez de las del filtro, y sin la columna—, así que se afirma el pedido.
    await expect.poll(() => pedidas.length).toBe(1);
    expect(pedidas[0]).toContain('estados=Aprobado');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11331 — ver, filtrar y entender el estado de facturación electrónica.
//
// Describe propio, con su reporte de tres filas: una que nunca se envió, una cuya emisión falló y
// una emitida cuyo total no cuadra. Las tres a la vez, porque casi todo lo que esta historia añade
// consiste en que NO se parezcan entre sí.
// ─────────────────────────────────────────────────────────────────────────────

/** Emisión fallida. `estadoLiquidacion: 'facturado'` porque solo se emite sobre lo ya facturado. */
const FILA_FALLIDA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000008', idFlit: 'FLIT-2008',
  sellada: true, estadoLiquidacion: 'facturado', estadoFacturacion: 'fallido',
};

/**
 * Emitida y con el total descuadrado (AC6). Las dos cosas a la vez y en la misma fila: es la única
 * forma de comprobar que la marca no le quita el estado.
 */
const FILA_EMITIDA_REVISION = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000009', idFlit: 'FLIT-2009',
  sellada: true, estadoLiquidacion: 'facturado', estadoFacturacion: 'emitido',
  facturaNumero: 'FV-1-200', facturaRequiereRevision: true,
};

const REPORTE_FE = {
  ...REPORTE, total: 3,
  items: [FILA_ESTIMADA, FILA_FALLIDA, FILA_EMITIDA_REVISION],
  resumen: { listo: 1, incompleto: 0, porFacturar: 0, facturado: 2 },
};

const CONTADORES_FE = {
  no_enviado: 1, encolado: 0, en_proceso: 0, emitido: 1, aceptado: 0, rechazado: 0, anulado: 0,
  fallido: 1, total: 3,
};

const FICHA_FALLIDA = {
  ...FICHA_ACEPTADA, tramiteId: FILA_FALLIDA.tramiteId, facturaId: 'f-fallida', numero: null,
  estadoEmision: 'fallida', estado: 'fallido', estadoDian: null, cufe: null, verificadoEn: null,
  motivo: null, documentos: { pdf: false, xml: false },
};

/**
 * Los TRES motivos que el servidor sabe escribir en `revision_motivo`, literales.
 *
 * Están los tres porque la marca es una sola y las causas no: el descuadre es el que el AC6 nombra,
 * pero la reconciliación escribe ahí lo que no puede concluir y la resolución a mano deja constancia
 * de quién la cerró. Con un solo motivo de fixture, una pantalla que rotulara todo como «diferencia
 * de totales» pasaría en verde mintiendo en dos casos de cada tres.
 */
const MOTIVO_DESCUADRE = 'El total devuelto por Siigo (200000.00) no coincide con la suma de los '
  + 'conceptos facturados (150000.00). Diferencia: 50000.00.';
const MOTIVO_RECONCILIACION = 'La reconciliación no puede concluir y no se resolverá sola: hay dos '
  + 'facturas en Siigo para este trámite y ninguna coincide con lo que FLITO envió.';
const MOTIVO_A_MANO = 'Resuelta a mano: una persona la localizó en Siigo y FLITO comprobó el '
  + 'documento.';

const FICHA_REVISION = {
  ...FICHA_ACEPTADA, tramiteId: FILA_EMITIDA_REVISION.tramiteId, facturaId: 'f-revision',
  numero: 'FV-1-200', estado: 'emitido', estadoDian: null, verificadoEn: null,
  revisionMotivo: MOTIVO_DESCUADRE,
  documentos: { pdf: false, xml: false },
};

/**
 * Cambia el motivo de la ficha emitida sin tocar nada más. `null` = marcada y sin motivo escrito.
 *
 * `unroute` primero: registrar una segunda ruta sobre el mismo patrón deja las dos vivas, y el test
 * dependería del orden en que Playwright las resuelve en vez de de lo que se quiere probar.
 */
async function refichaConMotivo(page: import('@playwright/test').Page, motivo: string | null) {
  await page.unroute(/\/api\/siigo\/facturacion\/tramites/);
  await page.route(/\/api\/siigo\/facturacion\/tramites/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      items: [{ ...FICHA_REVISION, revisionMotivo: motivo }],
    }) }));
}

/**
 * La fila de cola del trámite fallido (AC5).
 *
 * `errorDetalle` es lo que el servidor guarda de verdad: la `descripcionOperativa` del catálogo de
 * `siigo.errors.ts`, no el `Message` crudo de Siigo. Que la fixture lleve el texto traducido no es
 * un atajo del test — es el contrato: si algún día ahí llegara el mensaje crudo, el arreglo sería
 * del servidor, y traducirlo en la pantalla habría creado una segunda copia del catálogo.
 */
const COLA_FALLIDA = {
  id: 'cola-1', loteId: 'lote-1', ambiente: 'produccion', estado: 'error',
  intentos: 3, maxIntentos: 5, esperas: 0, maxEsperas: 20,
  proximoIntentoAt: '2026-08-14T18:00:00.000Z', ultimoIntentoAt: '2026-08-14T17:00:00.000Z',
  facturaId: 'f-fallida', desenlace: 'fallida',
  errorCode: 'invalid_customer_identification',
  errorDetalle: 'El cliente no existe en Siigo o su identificación no coincide con la registrada.',
  createdAt: '2026-08-14T16:00:00.000Z', updatedAt: '2026-08-14T17:00:00.000Z',
};

/**
 * La cola. Se enruta por `pathname` exacto y no por expresión regular: `/api/siigo/facturacion` y
 * `/api/siigo/facturacion/tramites` comparten prefijo, y un patrón laxo se quedaría con las dos.
 */
async function mockCola(page: import('@playwright/test').Page, cola: unknown = COLA_FALLIDA) {
  await page.route((url) => url.pathname === '/api/siigo/facturacion', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ambiente: 'produccion',
      items: cola === null ? [] : [{ tramiteId: FILA_FALLIDA.tramiteId, cola }],
    }) }));
}

/** Actas de envío: las pide la ficha en cuanto se abre, con cualquier factura. */
async function mockEnvios(page: import('@playwright/test').Page) {
  await page.route(/\/api\/siigo\/envios\/factura\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      facturaId: 'f', veces: 0, vecesEnviado: 0, ultimo: null, ultimoEnviado: null, envios: [],
    }) }));
}

/**
 * El reporte de esta historia. `fichas` admite un número de estado para que el caso de error del
 * AC2 use exactamente la misma ruta que el resto y solo cambie lo que se está probando.
 */
async function mockFe(
  page: import('@playwright/test').Page,
  opciones: { fichas?: unknown[] | number; retardoMs?: number } = {},
) {
  const { fichas = [FICHA_FALLIDA, FICHA_REVISION], retardoMs = 0 } = opciones;
  await mockFacetas(page, ['Aprobado']);
  await mockElegibilidad(page);
  await mockEnvios(page);
  await page.route(/\/api\/finanzas\/reporte-costos\/facturacion-electronica/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTADORES_FE) }));
  await page.route(/\/api\/siigo\/facturacion\/tramites/, async (route) => {
    if (retardoMs > 0) await new Promise((r) => setTimeout(r, retardoMs));
    if (typeof fichas === 'number') {
      return route.fulfill({ status: fichas, contentType: 'application/json', body: JSON.stringify({ error: 'Base no disponible' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: fichas }) });
  });
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE_FE) }));
}

const filaDe = (page: import('@playwright/test').Page, idFlit: string) =>
  page.getByRole('row').filter({ hasText: idFlit });

test.describe('Reporte de costos — estado de facturación electrónica (HU #11331)', () => {
  test('AC3 — un trámite emitido muestra el número de su factura sin abrir nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await page.goto('/finanzas/reporte-costos');

    // El número identifica el documento ante la DIAN. Tenerlo que buscar abriendo un modal por fila
    // es hacer un clic por cada dato de una línea, justo el que se copia a un correo o a un ticket.
    await expect(filaDe(page, 'FLIT-2009')).toContainText('Factura FV-1-200');
  });

  test('AC3 — nunca enviado y falló no se pintan igual, ni cuando la consulta de fichas se cae', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // 500 en las fichas A PROPÓSITO: es el caso que la columna pintaba mal. El estado de cada fila
    // lo manda el reporte, que no depende de esa consulta, así que un fallo de enriquecido no puede
    // convertir una emisión fallida en un trámite que nadie tocó nunca.
    await mockFe(page, { fichas: 500 });
    await page.goto('/finanzas/reporte-costos');

    await expect(filaDe(page, 'FLIT-2008')).toContainText('Falló al emitir');
    await expect(filaDe(page, 'FLIT-2001')).toContainText('Sin enviar');
    // Y la que falló no se lee como la que nunca se envió: no es solo que digan cosas distintas,
    // es que ninguna de las dos dice la de la otra.
    await expect(filaDe(page, 'FLIT-2008')).not.toContainText('Sin enviar');
    await expect(filaDe(page, 'FLIT-2001')).not.toContainText('Falló al emitir');
  });

  test('AC2 — el detalle de un trámite nunca enviado dice que aún no se ha enviado, no que falte un dato', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await page.goto('/finanzas/reporte-costos');

    await filaDe(page, 'FLIT-2001').getByTitle('Sin enviar — ver detalle').click();

    await expect(page.getByText(/todavía no se le ha pedido factura electrónica/)).toBeVisible();
    // Vacío NO es error: si se dijera «no se pudo consultar» sobre algo que sí se consultó, quien
    // lee saldría a buscar una avería que no existe.
    await expect(page.getByText(/No se pudo consultar/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('AC2 — si el detalle no se puede consultar, se dice con su nombre y se reintenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page, { fichas: 500 });
    await page.goto('/finanzas/reporte-costos');

    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();

    await expect(page.getByText(/No se pudo consultar la facturación electrónica de este trámite/)).toBeVisible();
    // Y no se cuela el vacío: un error que dijera «todavía no se ha enviado» estaría afirmando algo
    // que nadie ha comprobado.
    await expect(page.getByText(/todavía no se le ha pedido factura/)).toHaveCount(0);

    // El reintento es de verdad: se repite la consulta, y esta vez responde.
    await page.unroute(/\/api\/siigo\/facturacion\/tramites/);
    await page.route(/\/api\/siigo\/facturacion\/tramites/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [FICHA_REVISION] }) }));
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText('Entrega al cliente')).toBeVisible();
  });

  test('AC2 — mientras el detalle carga se ve que está cargando, no un vacío', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page, { retardoMs: 1200 });
    await page.goto('/finanzas/reporte-costos');
    // La primera carga (la del lote de la tabla) también pasa por el retardo: se espera a que la
    // fila exista antes de pulsar, o el clic caería sobre una tabla a medio pintar.
    await expect(filaDe(page, 'FLIT-2009')).toBeVisible();

    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();

    await expect(page.getByText('Consultando el estado de la facturación electrónica de este trámite…')).toBeVisible();
    // Y lo que sale después es el contenido, no un vacío que se quedó puesto.
    await expect(page.getByText('Entrega al cliente')).toBeVisible();
  });

  test('AC5 — el fallo se explica en lenguaje operativo, con los intentos y el último', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await mockCola(page);
    await page.goto('/finanzas/reporte-costos');

    await filaDe(page, 'FLIT-2008').getByTitle('Falló al emitir — ver detalle').click();

    // El motivo, traducido por el servidor. La pantalla no traduce ni un código de Siigo.
    await expect(page.getByText(/El cliente no existe en Siigo o su identificación no coincide/)).toBeVisible();
    // Y qué hacer al respecto, que es la mitad que convierte un diagnóstico en una tarea.
    await expect(page.getByText(/Se reintenta sola/)).toBeVisible();
    await expect(page.getByText(/Intentos:/)).toContainText('3');
    await expect(page.getByText(/Último intento: 14\/08\/26/)).toBeVisible();
    // El código crudo está, pero como referencia y no como única explicación: el motivo se lee
    // arriba en castellano y esto sirve para buscar en Siigo Nube o pegarlo en un ticket.
    await expect(page.getByText('Código de Siigo: invalid_customer_identification')).toBeVisible();
  });

  test('AC6 — el total descuadrado se marca Y la factura sigue apareciendo como emitida', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await page.goto('/finanzas/reporte-costos');

    // LAS DOS AFIRMACIONES A LA VEZ, y en la misma celda: ante la DIAN el documento existe, así que
    // una implementación que sacara la fila de «Emitida» para poder marcarla incumpliría la mitad
    // del criterio sin que se notara mirando solo la marca.
    const celda = filaDe(page, 'FLIT-2009').getByTestId('marca-revision-factura');
    await expect(celda).toContainText('Pendiente de revisión');
    await expect(filaDe(page, 'FLIT-2009')).toContainText('Emitida');
    // La marca lleva escrito lo que significa, para quien no ve el color ni puede parar el ratón.
    await expect(celda).toHaveAttribute('aria-label', /sigue emitida ante la DIAN/);

    // Una factura sin descuadre no lleva marca: si la llevaran todas, no marcaría nada.
    await expect(filaDe(page, 'FLIT-2008').getByTestId('marca-revision-factura')).toHaveCount(0);

    // Y en el detalle, lo mismo: estado y marca conviven.
    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();
    await expect(page.getByRole('dialog').getByTestId('marca-revision-factura')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Emitida');
  });

  test('AC6 — al abrirla se leen los dos totales y la diferencia, en la frase del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await page.goto('/finanzas/reporte-costos');

    // En la FILA no: son hasta doscientas por página y esto es un párrafo. La fila lleva la marca,
    // que es lo que se recorre de un vistazo; el porqué se lee al abrir, que es cuando se pregunta.
    await expect(filaDe(page, 'FLIT-2009')).not.toContainText('200000.00');

    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();

    // La frase ENTERA y literal: el total que devolvió Siigo, la suma de los conceptos facturados y
    // la resta. Comprobarla completa y no cifra a cifra es el criterio: el AC6 pide los dos totales
    // Y la diferencia, y tres asertos sueltos pasarían en verde con las cifras descolocadas.
    await expect(page.getByTestId('motivo-revision-factura')).toContainText(MOTIVO_DESCUADRE);
    // Y sigue emitida mientras se explica el descuadre: la marca amplía el estado, no lo sustituye.
    await expect(page.getByRole('dialog')).toContainText('Emitida');
  });

  test('AC6 — los motivos que no son de totales se leen tal cual, sin rótulo que los llame descuadre', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);

    // Los otros dos autores de la marca. Se prueban los dos porque el error que se está evitando
    // —poner encima un rótulo fijo de «diferencia de totales»— no lo delata el caso del descuadre,
    // que es justo aquel en el que el rótulo sería cierto.
    for (const motivo of [MOTIVO_RECONCILIACION, MOTIVO_A_MANO]) {
      await refichaConMotivo(page, motivo);
      // `goto` y no cerrar el modal: recargar deja la pantalla en el mismo punto de partida para la
      // segunda vuelta, sin arrastrar estado de la primera.
      await page.goto('/finanzas/reporte-costos');
      await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();

      const bloque = page.getByTestId('motivo-revision-factura');
      await expect(bloque).toContainText(motivo);
      // Lo que NO puede aparecer: ni «diferencia» ni «totales» en ninguna forma. Aquí no hay
      // descuadre que contar, y titularlo así mandaría a cuadrar dos cifras que nadie ha comparado.
      await expect(bloque).not.toContainText(/diferencia|totales/i);
      // La pastilla sí sigue, porque lo que la marca afirma —hay algo que comprobar— vale para los
      // tres motivos. Es el único encabezado que puede llevar el bloque sin mentir en dos de ellos.
      await expect(bloque).toContainText('Pendiente de revisión');
    }
  });

  test('AC6 — marcada y sin motivo escrito lo dice, en vez de dejar un hueco o pintar «null»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFe(page);
    await refichaConMotivo(page, null);
    await page.goto('/finanzas/reporte-costos');

    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();

    const bloque = page.getByTestId('motivo-revision-factura');
    // Quien abre el detalle viene a preguntar por qué. La pastilla sola se lee como una pantalla a
    // medio cargar, así que se dice lo único que se sabe —que no quedó escrito— y adónde ir.
    await expect(bloque).toContainText(/No quedó escrito por qué/);
    await expect(bloque).toContainText(/Siigo Nube/);
    // Y no se cuela el valor crudo, que es la otra forma de dejar el hueco.
    await expect(bloque).not.toContainText(/null|undefined/i);
  });

  test('AC4 — el filtro por estado viaja al servidor, convive con los demás y la exportación lo respeta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFe(page);
    await page.unroute(/\/api\/finanzas\/reporte-costos\?/);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE_FE) });
    });
    const exportadas: string[] = [];
    await page.context().route(/\/api\/finanzas\/reporte-costos\/export/, (route) => {
      exportadas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/csv', body: 'Trámite\r\n' });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Falló al emitir 1' }).click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('estadoFacturacion=fallido');
    // Convive con los que ya estaban: el filtro nuevo no borra el estado del trámite ni la etapa.
    expect(urls.at(-1)).toContain('estados=Aprobado');

    // Y el archivo sale del MISMO filtro que la tabla. Un CSV que ignore el filtro puesto es peor
    // que no exportar: parece el listado que se está viendo y no lo es.
    await page.getByRole('button', { name: 'Exportar CSV' }).click();
    await expect.poll(() => exportadas.length).toBe(1);
    expect(exportadas[0]).toContain('estadoFacturacion=fallido');
  });

  test('AC1 — un rol de solo lectura ve estado, filtro y detalle, y ninguna acción de emisión', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const urls: string[] = [];
    await mockFe(page);
    await page.unroute(/\/api\/finanzas\/reporte-costos\?/);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE_FE) });
    });
    await page.goto('/finanzas/reporte-costos');

    // Ve el estado de cada fila…
    await expect(filaDe(page, 'FLIT-2008')).toContainText('Falló al emitir');
    // …puede filtrar por él…
    await page.getByRole('button', { name: 'Emitida 1' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('estadoFacturacion=emitido');
    // …y abre el detalle entero.
    await filaDe(page, 'FLIT-2009').getByTitle('Emitida — ver detalle').click();
    await expect(page.getByText('Entrega al cliente')).toBeVisible();

    // Lo que no ve es ninguna acción que emita o reenvíe. Auditar es mirar.
    await expect(page.getByRole('button', { name: 'Reenviar correo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enviar .* a facturación electrónica/ })).toHaveCount(0);
  });
});
