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

async function mock(page: import('@playwright/test').Page) {
  await mockFacetas(page, ['Aprobado']);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) }));
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
