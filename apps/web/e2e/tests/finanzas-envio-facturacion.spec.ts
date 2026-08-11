import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// HU #11329 — enviar trámites a facturación electrónica desde el Reporte de costos.
//
// Backend mockeado. Los mocks de `/siigo/elegibilidad/tramites` y del `POST /siigo/facturacion` se
// ponen en TODOS los casos, incluidos los que no los miran: un mock que solo cubre lo que el test
// afirma deja el resto de la pantalla en un estado que nadie eligió.

type Page = import('@playwright/test').Page;

const BASE = {
  placa: 'ABC123', estado: 'Aprobado', empresa: 'ACME SAS', tipoTramite: 'Traspaso',
  vin: 'LRWYGCEK2TC771456', marca: 'Chevrolet', linea: 'Onix',
  fechaAprobacion: '2026-07-14T15:30:00.000Z', fechaCreacion: '2026-07-02T10:00:00.000Z',
  soat: 450000, impuesto: 120000, derechoTramite: 80000, logistica: 15000, tramiteDigital: 200000,
  gmf: 3460, total: 868460, noConfigurados: [], sinRecibo: [],
  pendientesPago: [], autogestionados: [], noAplican: [],
  estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false,
};

/** Sin sellar y sin nada pendiente: se puede liquidar, no se puede facturar electrónicamente. */
const LIQUIDABLE = {
  ...BASE, tramiteId: 'bbbb0000-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
  sellada: false, estadoLiquidacion: null,
};
/** Facturado y elegible: es el que sale. */
const ELEGIBLE = {
  ...BASE, tramiteId: 'bbbb0000-0000-0000-0000-000000000002', idFlit: 'FLIT-3002',
  sellada: true, estadoLiquidacion: 'facturado',
};
/** Facturado y NO elegible: nace con el botón apagado y con su porqué al lado. */
const NO_ELEGIBLE = {
  ...BASE, tramiteId: 'bbbb0000-0000-0000-0000-000000000003', idFlit: 'FLIT-3003',
  sellada: true, estadoLiquidacion: 'facturado',
};
/** Ya en cola: no se le vuelve a ofrecer el envío (AC6). */
const ENCOLADO = {
  ...BASE, tramiteId: 'bbbb0000-0000-0000-0000-000000000004', idFlit: 'FLIT-3004',
  sellada: true, estadoLiquidacion: 'facturado', estadoFacturacion: 'encolado',
};

const TOTALES = {
  soat: 1800000, impuesto: 480000, derechoTramite: 320000, logistica: 60000,
  tramiteDigital: 600000, gmf: 10400, total: 3270400, filasIncompletas: 0,
};

function reporte(items: unknown[]) {
  return {
    items, total: items.length, page: 1, pageSize: 50, totales: TOTALES,
    resumen: { listo: 1, incompleto: 0, porFacturar: 0, facturado: 3 },
  };
}

const SIN_MOTIVOS = {
  liquidacion_no_facturada: 0, documentacion_incompleta: 0, anterior_al_corte: 0,
  sin_compania: 0, tercero_sin_vincular: 0, cliente_no_facturable: 0,
  compuerta_cerrada: 0, ya_facturado: 0,
};

/** Los dos motivos de FLIT-3003, con un `detalle` deliberadamente raro: se pinta TAL CUAL (AC4). */
const MOTIVOS_3003 = [
  { motivo: 'tercero_sin_vincular', detalle: 'La compañía todavía no existe como tercero en Siigo. Sincronízala desde su ficha.' },
  { motivo: 'cliente_no_facturable', detalle: 'La ficha fiscal del cliente está incompleta: falta el código de ciudad (CO-11-001).' },
];

const ELEGIBILIDAD_POR_DEFECTO = {
  items: [
    { tramiteId: ELEGIBLE.tramiteId, elegible: true, motivos: [] },
    { tramiteId: NO_ELEGIBLE.tramiteId, elegible: false, motivos: MOTIVOS_3003 },
  ],
  resumen: {
    total: 2, elegibles: 1, noElegibles: 1, anterioresAlCorte: 0,
    porMotivo: { ...SIN_MOTIVOS, tercero_sin_vincular: 1, cliente_no_facturable: 1 },
  },
};

const SIN_RESULTADOS = {
  encolado: 0, ya_en_cola: 0, ya_enviado: 0, fallido_definitivo: 0, reactivado: 0,
  no_elegible: 0, error: 0,
};

const RESUMEN_FE = {
  no_enviado: 3, encolado: 1, en_proceso: 0, emitido: 0, aceptado: 0, rechazado: 0,
  anulado: 0, fallido: 0, total: 4,
};

/** Todo lo que la pantalla pide, con lo justo para que ningún estado quede al azar. */
async function mock(page: Page, opciones: {
  filas?: unknown[];
  elegibilidad?: unknown;
  estadoElegibilidad?: number;
} = {}) {
  const filas = opciones.filas ?? [LIQUIDABLE, ELEGIBLE, NO_ELEGIBLE, ENCOLADO];
  await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados: ['Aprobado'], empresas: [], tipos: ['Traspaso'],
    }) }));
  await page.route(/\/api\/finanzas\/reporte-costos\/facturacion-electronica/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_FE) }));
  await page.route(/\/api\/siigo\/facturacion\/tramites/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reporte(filas)) }));
  await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) =>
    route.fulfill({
      status: opciones.estadoElegibilidad ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(opciones.elegibilidad ?? ELEGIBILIDAD_POR_DEFECTO),
    }));
}

/** El `POST` del envío. Devuelve el 202 que se le pase y anota los cuerpos que recibió. */
async function mockEnvio(page: Page, respuesta: unknown, cuerpos: unknown[] = [], status = 202) {
  await page.route(/\/api\/siigo\/facturacion$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    cuerpos.push(route.request().postDataJSON());
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(respuesta) });
  });
}

const RESPUESTA_MIXTA = {
  ambiente: 'produccion',
  items: [
    { tramiteId: ELEGIBLE.tramiteId, resultado: 'encolado', motivos: [], estado: 'pendiente', colaId: 'c1', loteId: 'l1', detalle: null },
    { tramiteId: NO_ELEGIBLE.tramiteId, resultado: 'no_elegible', motivos: MOTIVOS_3003, estado: null, colaId: null, loteId: null, detalle: null },
    { tramiteId: ENCOLADO.tramiteId, resultado: 'error', motivos: [], estado: null, colaId: null, loteId: null, detalle: 'no se pudo reservar el lote (tiempo agotado)' },
  ],
  resumen: {
    total: 3, encolados: 1, yaEstaban: 0, rechazados: 2,
    porResultado: { ...SIN_RESULTADOS, encolado: 1, no_elegible: 1, error: 1 },
  },
};

// ─── AC1 · acceso y permisos ─────────────────────────────────────────────────

test.describe('Envío a facturación — permisos', () => {
  test('auditor ve la pantalla y el estado, pero ni la tarjeta ni la acción — y no gasta la consulta', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const consultas: string[] = [];
    await mock(page);
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) => {
      consultas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ELEGIBILIDAD_POR_DEFECTO) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-3002')).toBeVisible();

    // El estado sí lo tiene entero: la columna «Factura DIAN» pinta la cola.
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-3004' }).getByText('En cola')).toBeVisible();
    // La acción, no.
    await expect(page.getByRole('heading', { name: 'Envío a facturación electrónica' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /a facturación electrónica/ })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-3002' })).toHaveCount(0);
    // Cero peticiones: no se le paga una consulta cara por una acción que nunca podrá ejecutar.
    expect(consultas).toHaveLength(0);
  });

  test('quien puede emitir ve la tarjeta y el botón de la fila', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByRole('heading', { name: 'Envío a facturación electrónica' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' })).toBeEnabled();
  });
});

// ─── AC2 · los cuatro estados de la tarjeta ──────────────────────────────────

test.describe('Envío a facturación — los cuatro estados', () => {
  test('mientras se comprueba lo dice, y todavía no ofrece enviar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ELEGIBILIDAD_POR_DEFECTO) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('Comprobando cuáles se pueden facturar…')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Enviar \d+ a facturación electrónica$/ })).toHaveCount(0);
    // Y la acción de la fila NACE inhabilitada, no se inhabilita después (AC4).
    await expect(page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' })).toBeDisabled();
  });

  test('si la comprobación falla se dice, se puede reintentar y NO se ofrece enviar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const consultas: string[] = [];
    await mock(page);
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) => {
      consultas.push(route.request().url());
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Base no disponible' }) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText(/No se pudo comprobar cuáles se pueden facturar: Base no disponible/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Enviar \d+ a facturación electrónica$/ })).toHaveCount(0);
    // Un fallo de facturación no tumba la conciliación de costos.
    await expect(page.getByText('FLIT-3001')).toBeVisible();

    const antes = consultas.length;
    await page.getByRole('button', { name: 'Reintentar' }).first().click();
    await expect.poll(() => consultas.length).toBeGreaterThan(antes);
  });

  test('sin ningún trámite facturado explica qué falta, con el texto del catálogo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mock(page, { filas: [LIQUIDABLE] });
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reporte([LIQUIDABLE])) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('Ninguno de los 1 trámites de esta página está facturado todavía.')).toBeVisible();
    // Palabra por palabra el motivo del catálogo compartido: un solo texto, el del servidor.
    await expect(page.getByText(/La liquidación todavía no está sellada y facturada\. Púlsala en el reporte de costos/)).toBeVisible();

    await page.getByRole('button', { name: 'Ver los que están por facturar' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('etapa=por_facturar');
  });

  test('con candidatos pero ninguno elegible, desglosa qué falta y separa el corte del histórico', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page, {
      filas: [ELEGIBLE, NO_ELEGIBLE],
      elegibilidad: {
        items: [
          { tramiteId: ELEGIBLE.tramiteId, elegible: false, motivos: [{ motivo: 'anterior_al_corte', detalle: 'x' }] },
          { tramiteId: NO_ELEGIBLE.tramiteId, elegible: false, motivos: MOTIVOS_3003 },
        ],
        resumen: {
          total: 2, elegibles: 0, noElegibles: 2, anterioresAlCorte: 1,
          porMotivo: { ...SIN_MOTIVOS, tercero_sin_vincular: 1, cliente_no_facturable: 1, anterior_al_corte: 1 },
        },
      },
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText(/Ninguno de los 2 trámites facturados de esta página se puede enviar/)).toBeVisible();
    await expect(page.getByText('La compañía todavía no existe como tercero en Siigo. Sincronízala desde su ficha.').first()).toBeVisible();
    // Los que delegan el diagnóstico lo dicen: su texto de catálogo es un encabezado.
    await expect(page.getByText(/el detalle exacto está en cada fila/)).toBeVisible();
    // El corte va en su propio bloque, y NO repetido arriba.
    await expect(page.getByText(/quedaron fuera por la fecha de corte del histórico/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la configuración' })).toBeVisible();
  });

  test('sin trámites anteriores al corte, ese bloque no existe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page, {
      filas: [NO_ELEGIBLE],
      elegibilidad: {
        items: [{ tramiteId: NO_ELEGIBLE.tramiteId, elegible: false, motivos: MOTIVOS_3003 }],
        resumen: {
          total: 1, elegibles: 0, noElegibles: 1, anterioresAlCorte: 0,
          porMotivo: { ...SIN_MOTIVOS, tercero_sin_vincular: 1, cliente_no_facturable: 1 },
        },
      },
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText(/quedaron fuera por la fecha de corte/)).toHaveCount(0);
  });
});

// ─── AC3 y AC4 · por fila, sobre la selección, y el porqué ───────────────────

test.describe('Envío a facturación — por fila y sobre la selección', () => {
  test('lo no elegible nace inhabilitado y «¿Por qué no?» lista los motivos del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const consultas: string[] = [];
    await mock(page);
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) => {
      consultas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ELEGIBILIDAD_POR_DEFECTO) });
    });

    await page.goto('/finanzas/reporte-costos');
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-3003' });
    await expect(fila.getByRole('button', { name: 'Enviar FLIT-3003 a facturación electrónica' })).toBeDisabled();

    const porQue = fila.getByRole('button', { name: 'Por qué FLIT-3003 no se puede enviar a facturación electrónica' });
    await expect(porQue).toHaveAttribute('aria-expanded', 'false');
    const antes = consultas.length;
    await porQue.click();
    await expect(porQue).toHaveAttribute('aria-expanded', 'true');

    // Un `<li>` por motivo, con el texto EXACTO del servidor. Nada de comas ni de `title`.
    const motivos = fila.getByRole('listitem');
    await expect(motivos).toHaveCount(2);
    await expect(motivos.nth(1)).toHaveText('La ficha fiscal del cliente está incompleta: falta el código de ciudad (CO-11-001).');
    // Y sin una sola petición nueva: el veredicto ya estaba en la caché de la vista.
    expect(consultas).toHaveLength(antes);
  });

  test('una fila ya en cola no ofrece el envío, y su estado se ve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-3004' });
    await expect(fila.getByText('En cola')).toBeVisible();
    await expect(fila.getByRole('button', { name: /a facturación electrónica/ })).toHaveCount(0);
  });

  test('la barra dice cuántos de los seleccionados sirven a cada acción, antes de pulsar nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const liquidaciones: unknown[] = [];
    await mock(page);
    await page.route(/\/api\/flito\/liquidacion\/lote\/liquidar/, (route) => {
      liquidaciones.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ liquidados: [], fallidos: [] }) });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('checkbox', { name: 'Seleccionar los trámites con acciones de esta página' }).check();

    await expect(page.getByText('3 seleccionado(s) · 1 se pueden liquidar · 1 se pueden enviar a facturación electrónica')).toBeVisible();

    // Y liquidar manda SOLO los liquidables, no la selección entera: desde que la casilla también
    // se pinta en los `facturado`, mandarla entera enviaría a liquidar cosas ya selladas.
    await page.getByRole('button', { name: 'Liquidar 1', exact: true }).click();
    await expect.poll(() => liquidaciones.length).toBe(1);
    expect(liquidaciones[0]).toEqual({ tramiteIds: [LIQUIDABLE.tramiteId] });
  });

  test('marcar casillas no dispara ninguna consulta de elegibilidad', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const consultas: string[] = [];
    await mock(page);
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) => {
      consultas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ELEGIBILIDAD_POR_DEFECTO) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' })).toBeEnabled();
    const antes = consultas.length;
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-3002' }).check();
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-3003' }).check();
    await expect(page.getByText('2 seleccionado(s) · 0 se pueden liquidar · 1 se pueden enviar a facturación electrónica')).toBeVisible();
    expect(consultas).toHaveLength(antes);
  });
});

// ─── AC5 y AC6 · el resultado, trámite a trámite ─────────────────────────────

test.describe('Envío a facturación — el diálogo y su resultado', () => {
  test('confirma, envía solo los elegibles y enseña el desenlace de cada trámite', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cuerpos: unknown[] = [];
    await mock(page);
    await mockEnvio(page, RESPUESTA_MIXTA, cuerpos);

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Enviar 1 a facturación electrónica' }).click();

    // Fase 1 — se dice qué se va a enviar y qué se queda fuera, con su porqué plegado.
    await expect(page.getByText(/Se van a enviar/)).toBeVisible();
    await expect(page.getByText(/Se emite una factura electrónica por trámite/)).toBeVisible();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();

    // Fase 4 — encabezado con los tres números del `resumen`, y CINCO desenlaces no colapsados en
    // un único «listo»: cada grupo con su etiqueta, su explicación y su detalle.
    await expect(page.getByRole('heading', { name: '1 enviados a la cola · 0 ya estaban · 2 no se pudieron enviar' })).toBeVisible();
    await expect(page.getByText('No se pudo encolar')).toBeVisible();
    await expect(page.getByText('no se pudo reservar el lote (tiempo agotado)')).toBeVisible();
    await expect(page.getByText('No se puede facturar todavía')).toBeVisible();
    await expect(page.getByText('En cola para emitir')).toBeVisible();

    // `error` ofrece reintento; `no_elegible` no: reintentar sin arreglar nada devolvería lo mismo.
    await expect(page.getByRole('button', { name: 'Reintentar 1 que falló' })).toBeVisible();

    // Solo los elegibles salieron a la red, y sin `reactivar` ni ningún campo de más (`.strict()`).
    expect(cuerpos).toEqual([{ tramiteIds: [ELEGIBLE.tramiteId] }]);
  });

  test('las filas encoladas pasan a «En cola» sin recargar, y cerrar refresca los datos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let cargas = 0;
    await mock(page);
    await mockEnvio(page, RESPUESTA_MIXTA);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      cargas += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reporte([LIQUIDABLE, ELEGIBLE, NO_ELEGIBLE, ENCOLADO])) });
    });

    await page.goto('/finanzas/reporte-costos');
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-3002' });
    await expect(fila.getByText('En cola')).toHaveCount(0);

    await page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' }).click();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();
    await expect(page.getByRole('heading', { name: /enviados a la cola/ })).toBeVisible();

    // Sin navegación: la fila cambia debajo del diálogo abierto.
    await expect(fila.getByText('En cola')).toBeVisible();

    const antes = cargas;
    await page.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect.poll(() => cargas).toBeGreaterThan(antes);
  });

  test('volver a pulsar no duplica: se dice que ya estaba en cola, no se trata como error', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockEnvio(page, {
      ambiente: 'produccion',
      items: [{ tramiteId: ELEGIBLE.tramiteId, resultado: 'ya_en_cola', motivos: [], estado: 'pendiente', colaId: 'c1', loteId: 'l1', detalle: null }],
      resumen: { total: 1, encolados: 0, yaEstaban: 1, rechazados: 0, porResultado: { ...SIN_RESULTADOS, ya_en_cola: 1 } },
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' }).click();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();

    await expect(page.getByRole('heading', { name: '0 enviados a la cola · 1 ya estaban · 0 no se pudieron enviar' })).toBeVisible();
    await page.getByText('Ya estaba en cola').click();
    await expect(page.getByText('Ya se habían enviado y siguen esperando su turno. No se pidieron dos veces.')).toBeVisible();
  });

  test('con el freno puesto lo dice y deja reintentar; sin respuesta, avisa y NO ofrece reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/facturacion$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'La emisión está frenada por incidencia', codigo: 'integracion_frenada' }),
      });
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' }).click();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();

    await expect(page.getByText(/La facturación electrónica está frenada ahora mismo: La emisión está frenada por incidencia/)).toBeVisible();
    await expect(page.getByText(/No se encoló ningún trámite/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('si el servidor no responde, se dice que puede haberse registrado y no se ofrece repetir', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/siigo\/facturacion$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.abort('failed');
    });

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' }).click();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();

    // Reintentar a ciegas es justo lo que el AC6 evita: la idempotencia del servidor protegería,
    // pero una interfaz que empuja a repetir lo que no sabe si ocurrió enseña a desconfiar de sí.
    await expect(page.getByText(/Puede que el envío sí se haya registrado/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cerrar', exact: true }).last()).toBeVisible();
  });

  test('lo dado por perdido solo se reactiva con permiso, y el cuerpo lo pide explícito', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cuerpos: unknown[] = [];
    await mock(page);
    await mockEnvio(page, {
      ambiente: 'produccion',
      items: [{ tramiteId: ELEGIBLE.tramiteId, resultado: 'fallido_definitivo', motivos: [], estado: 'fallido_definitivo', colaId: 'c1', loteId: 'l1', detalle: null }],
      resumen: { total: 1, encolados: 0, yaEstaban: 0, rechazados: 1, porResultado: { ...SIN_RESULTADOS, fallido_definitivo: 1 } },
    }, cuerpos);

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Enviar FLIT-3002 a facturación electrónica' }).click();
    await page.getByRole('button', { name: 'Enviar 1 a facturación', exact: true }).click();

    await page.getByRole('button', { name: 'Volver a intentar los 1 dados por perdidos' }).click();
    await expect.poll(() => cuerpos.length).toBe(2);
    expect(cuerpos[1]).toEqual({ tramiteIds: [ELEGIBLE.tramiteId], reactivar: true });
  });
});
