import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, OPERACIONES_USER, AUDITOR_USER, TOKEN_E2E } from '../helpers/auth';

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
  // Titular, organismo, periodo y subtotales (HU #12432 → #12434). Persona natural con su OT. Los
  // dos subtotales los manda el API: 668460 = SOAT + impuesto + derecho + GMF + logística, y
  // 200000 = trámite digital. La pantalla NO los recalcula, y un test lo comprueba con un valor que
  // no cuadra.
  titularNombres: 'Ana María', titularApellidos: 'Pérez Gómez', titularRazonSocial: null,
  titularTipoDocumento: 'CC', titularDocumento: '1020304050',
  organismoCodigo: '05266', organismoNombre: 'Envigado', mes: '2026-07', trimestre: '2026-T3',
  totalReintegro: 668460, totalServicio: 200000,
  // Servicios adicionales (HU #12546 los manda, la #12548 los pinta). Los DOS campos, porque la
  // celda la gobierna la CANTIDAD: sin ellos en las fixtures la columna sale vacía en todos los
  // casos y media docena de asertos pasarían en verde vacío. El importe NO está sumado en
  // `totalServicio` a propósito (200000 es solo el trámite digital): así un cálculo local de la
  // pantalla se delata en vez de coincidir por casualidad.
  serviciosAdicionales: 125000, serviciosAdicionalesCantidad: 2,
  // Viajes de logística (HU #12627 lo manda, la #12628 lo pinta): el 1 incluido más dos adicionales.
  // Va en la fixture base para que el botón «Viajes · 3» pese en la medida de ancho de la compacta.
  logisticaViajesCantidad: 3,
};
const FILA_BLOQUEADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000002', idFlit: 'FLIT-2002',
  fechaAprobacion: null, mes: null, trimestre: null,
  tramiteDigital: null, total: null, noConfigurados: ['Trámite digital'], sinRecibo: [],
  // El servicio es el trámite digital, y sin tarifa el subtotal viene en null: no es $ 0.
  totalServicio: null,
  // Sin ningún servicio adicional, y eso es una AFIRMACIÓN: cantidad 0 → «—», el vacío del reporte.
  serviciosAdicionales: null, serviciosAdicionalesCantidad: 0,
  // Solo el viaje incluido: «1» en la celda y «Viajes» sin contador en el botón.
  logisticaViajesCantidad: 1,
};
/** Persona jurídica sin organismo: razón social y NIT, nombres vacíos, OT vacía (AC1). */
const FILA_JURIDICA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000008', idFlit: 'FLIT-2008J',
  titularNombres: null, titularApellidos: null, titularRazonSocial: 'Transportes Andes SAS',
  titularTipoDocumento: 'NIT', titularDocumento: '900123456',
  organismoCodigo: null, organismoNombre: null,
};
/**
 * Liquidada ANTES de la HU #12546: el sello no lleva la clave y el servidor no la inventa, así que
 * la cantidad es `null`. No es lo mismo que «no tiene ninguno» y no se puede pintar igual: aquí va
 * «Sin dato», y en la fila de arriba va «—».
 */
const FILA_LIQUIDADA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000003', idFlit: 'FLIT-2003',
  sellada: true, estadoLiquidacion: 'liquidado',
  serviciosAdicionales: null, serviciosAdicionalesCantidad: null,
  // Y tampoco sabe cuántos viajes llevaba (HU #12628): «Sin dato», nunca «0».
  logisticaViajesCantidad: null,
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
  totalReintegro: null,
};

/** SOAT comprado pero aún sin pagar, y un impuesto que la compañía se gestiona sola. */
const FILA_SIN_PAGAR = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000006', idFlit: 'FLIT-2006',
  soat: null, impuesto: null, total: null, totalReintegro: null,
  pendientesPago: ['SOAT'], autogestionados: ['Impuesto'],
  // DOS servicios que valen cero: un cobro legítimo de $ 0. Es el caso que separa «no hay nada» de
  // «hay dos cosas y suman cero», y el que mata tanto `pesos(valor ?? 0)` como `if (!valor) vacío`.
  serviciosAdicionales: 0, serviciosAdicionalesCantidad: 2,
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
    totalReintegro: 2670400, totalServicio: 600000,
    // A PROPÓSITO incoherente con los sumandos de `items` (125.000 × 3 + 0 = 375.000): el pie lo
    // agrega el SQL sobre el universo filtrado, no sobre la página, y una pantalla que lo sumara
    // ella misma pintaría 375.000 y caería aquí.
    serviciosAdicionales: 890000,
  },
  resumen: { listo: 1, incompleto: 3, porFacturar: 1, facturado: 1 },
};

/** Las facetas del filtro. `empresas` trae una entrada por EMPRESA, con su nombre, nunca su NIT. */
async function mockFacetas(page: import('@playwright/test').Page, estados: string[]) {
  await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados, empresas: [{ valor: '900111,9001112', nombre: 'ACME SAS' }], tipos: ['Traspaso', 'Matricula'],
      // Solo los organismos CON trámites, por código y con el nombre que enseña la columna «OT».
      organismos: [{ valor: '05266', nombre: 'Envigado' }, { valor: '05001', nombre: 'Medellín' }],
    }) }));
}

// ── Exportación a Excel (HU #12532) ──────────────────────────────────────────

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type Peticion = import('@playwright/test').Request;

/**
 * El mock de los dos POST de export. Responde un `.xlsx` de relleno con el nombre que se le pida
 * —o el error que se le pida— y devuelve la lista de peticiones que llegaron, que es sobre lo que
 * se afirma: método, cabecera de sesión y cuerpo. **Sin `$` en la ruta pasaría una URL con query**,
 * y la HU existe para que el criterio no vaya ahí.
 */
async function mockExport(
  page: import('@playwright/test').Page,
  opciones: { nombre?: string; status?: number; cuerpo?: object; demoraMs?: number } = {},
) {
  const peticiones: Peticion[] = [];
  await page.route(/\/api\/finanzas\/reporte-costos\/(consolidado\/)?export$/, async (route) => {
    peticiones.push(route.request());
    if (opciones.demoraMs) await new Promise((r) => setTimeout(r, opciones.demoraMs));
    if (opciones.status && opciones.status !== 200) {
      return route.fulfill({ status: opciones.status, contentType: 'application/json', body: JSON.stringify(opciones.cuerpo ?? {}) });
    }
    return route.fulfill({
      status: 200, contentType: XLSX, body: Buffer.from('relleno'),
      headers: { 'content-disposition': `attachment; filename="${opciones.nombre ?? 'reporte-costos_20260914-1530.xlsx'}"` },
    });
  });
  return peticiones;
}

/**
 * La banda VISIBLE del resultado. El mismo texto viaja también por la región `role="status"`
 * sr-only de la página (es lo que oye el lector, D-08), así que `getByText` a secas resuelve dos
 * nodos; este locator se queda con el que se ve.
 */
const bandaExport = (page: import('@playwright/test').Page, texto: string | RegExp) =>
  page.getByText(texto).and(page.locator(':not(.sr-only)'));

/** El cuerpo del POST vertido a query, tal como la pantalla arma los GET: para comparar los dos. */
const queryDeCuerpo = (cuerpo: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(cuerpo)) p.set(k, v === true ? 'si' : Array.isArray(v) ? v.join(',') : String(v));
  return p.toString();
};

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

/**
 * Desde la HU #12537 la tabla ARRANCA COMPACTA (9 de 30 columnas: nueve desde la #12539, la 29ª
 * es «Serv. adic.» de la #12548 y la 30ª «Viajes» de la #12628; ninguna entra en la compacta). Los casos que
 * leen una columna de las que se callan —VIN, marca, línea, el titular, OT, Estado, la fecha de
 * creación, un concepto suelto— la piden ampliada ANTES del `goto`, por la misma clave que escribe
 * el control: así prueban su columna, no el control. Los que leen «No configurado» / «Sin recibo»
 * en Servicio / Total reintegro o «Falta: …» junto a Liquidar NO la llaman: eso tiene que seguir a
 * la vista en compacta (AC7 de la #12539).
 */
async function ampliarColumnas(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('flito.reporteCostos.columnas', 'todas'); } catch { /* sin storage */ }
  });
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
    await ampliarColumnas(page);   // VIN, Marca y Línea se callan en compacta
    await page.goto('/finanzas/reporte-costos');

    // Desde la HU #12434 la fila es plana, como el Excel: marca y línea van en columnas propias
    // (RN-08), y las fechas siguen en su celda apilada de `columnasComunes`.
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2001' });
    await expect(fila).toContainText('Traspaso');
    await expect(fila).toContainText('LRWYGCEK2TC771456');
    await expect(fila.getByRole('cell', { name: 'Chevrolet', exact: true })).toBeVisible();
    await expect(fila.getByRole('cell', { name: 'Onix', exact: true })).toBeVisible();
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

  test('arranca filtrado por Aprobado y el mes en curso, y los dos rangos de fecha viajan por separado', async ({ page }) => {
    // El estado por defecto se comprueba sobre la petición, no sobre el estilo del control: es
    // lo que de verdad determina qué filas se traen. Desde la HU #12434 (CF-05) el punto de
    // partida es Aprobado + el mes en curso, y «en curso» se fija con el reloj para que el aserto
    // no dependa del día en que corre.
    await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado', 'Entregado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => urls[0] ?? '').toContain('estados=Aprobado');
    expect(urls[0]).toContain('aprobadoDesde=2026-09-01');
    expect(urls[0]).toContain('aprobadoHasta=2026-09-30');

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

  test('limpiar filtros vuelve a Aprobado y al mes en curso, no a todos los estados ni a un rango vacío', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mockFacetas(page, ['Aprobado', 'Entregado']);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORTE) });
    });

    await page.goto('/finanzas/reporte-costos');
    // Con el punto de partida puesto no hay nada que limpiar: el botón lo dice.
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeDisabled();
    await page.locator('summary').filter({ hasText: 'Estado' }).click();
    await page.getByRole('checkbox', { name: 'Entregado' }).check();
    await page.locator('summary').filter({ hasText: 'Creación' }).click();
    await page.getByRole('button', { name: 'Este mes' }).click();
    // Y el rango de aprobación a mano, para que «limpiar» tenga que volver al mes en curso, no
    // conservar lo que había.
    await page.locator('summary').filter({ hasText: 'Aprobación' }).click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('aprobadoDesde=2026-09-15');
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('estados=Aprobado');
    const ultima = urls.at(-1) ?? '';
    expect(ultima).not.toContain('Entregado');
    // El rango de CREACIÓN se vacía (`&desde=`, no el `aprobadoDesde=` que sí tiene que quedar)…
    expect(ultima).not.toMatch(/[?&]desde=/);
    // …y el de aprobación vuelve al mes en curso, no a un rango vacío (CF-05).
    expect(ultima).toContain('aprobadoDesde=2026-09-01');
    expect(ultima).toContain('aprobadoHasta=2026-09-30');
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeDisabled();
  });

  test('el derecho de tránsito sin recibo NO dice «No configurado»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // El derecho no se configura: es un desembolso real que se lee del recibo, como el SOAT y el
    // impuesto. El rótulo viejo mandaba a buscar una parametrización que no existe.
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2005' });
    // Desde la HU #12434 el motivo se repite en «Total reintegro» (RN-02), y desde la #12537 la tabla
    // arranca compacta: la celda «Trámite» está oculta y el motivo se lee en el subtotal (AC5).
    await expect(fila.getByText('Sin recibo').first()).toBeVisible();
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
    // Desde la HU #12434 el motivo se repite en «Total reintegro» (RN-02), y desde la #12537 la tabla
    // arranca compacta: SOAT está oculto y el motivo se lee en el subtotal (AC5).
    await expect(fila.getByText('Sin pagar').first()).toBeVisible();
    await expect(fila.getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(fila.getByText('Falta: SOAT')).toBeVisible();
  });

  test('lo que la compañía autogestiona se dice, no se deja en blanco', async ({ page }) => {
    // Un guion se leía como «falta algo». Aquí no falta nada: FLITO no lo cobra.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await ampliarColumnas(page);   // «Autogestiona» vive en la celda Impuesto, que se calla en compacta
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
    // En compacta (HU #12537) lo dice «Servicio», el subtotal: no hace falta ampliar (AC5).
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
// HU #11681 — la marca de conciliado en la celda de SOAT, y de dónde sale el archivo exportado.
//
// Describe propio: estos casos no comparten el reporte de seis filas de los de arriba. Se montan
// sobre DOS filas idénticas salvo por la conciliación, que es lo que permite atribuirle a la marca
// cualquier diferencia entre ellas.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Reporte de costos — conciliación del SOAT', () => {
  test('AC1 — el SOAT conciliado lo dice con texto, y al apuntarlo revela su boleta y su fecha', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    await ampliarColumnas(page);   // la marca vive en la celda SOAT, que se calla en compacta
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
    await ampliarColumnas(page);   // idem: la celda SOAT
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2007' });
    const marca = fila.getByRole('note', { name: /SOAT conciliado con la bolsa/ });

    // Sin foco y sin puntero: boleta y fecha ya están en el nombre accesible. Quien escucha la
    // tabla no depende ni de poder apuntar la marca ni de distinguir su color.
    await expect(marca).toHaveAccessibleName(`SOAT conciliado con la bolsa. ${DETALLE_BOLETA}.`);

    // Se llega con el TABULADOR, no con `marca.focus()`.
    //
    // `focus()` es foco programático: funciona igual con `tabIndex={-1}`, así que certificaba que la
    // marca «se puede enfocar» —cosa que nadie necesita— y no lo que el criterio pide: que quien
    // navega con teclado LLEGUE a ella. Con la marca fuera del orden de tabulación, el detalle sería
    // inalcanzable sin ratón y las cuatro pruebas de este bloque seguirían en verde.
    //
    // Se arranca desde la casilla de la propia fila para no tabular la pantalla entera, y el tope
    // está para que una marca inalcanzable ponga el caso ROJO en vez de dejar el bucle corriendo.
    await fila.getByRole('checkbox', { name: 'Seleccionar FLIT-2007' }).focus();
    let alcanzada = false;
    for (let i = 0; i < 8 && !alcanzada; i += 1) {
      await page.keyboard.press('Tab');
      alcanzada = await marca.evaluate((el) => el === document.activeElement);
    }
    expect(alcanzada, 'la marca no se alcanza con el tabulador desde su propia fila').toBe(true);
    await expect(marca).toBeFocused();
    await expect(page.getByText(DETALLE_BOLETA)).toBeVisible();

    // Y se quita de encima sin mover el foco: mientras está abierto tapa la celda de al lado
    // (WCAG 1.4.13).
    await page.keyboard.press('Escape');
    await expect(page.getByText(DETALLE_BOLETA)).toHaveCount(0);
  });

  test('AC2 — la fila sin conciliar se ve como siempre: ni marca, ni hueco reservado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    await ampliarColumnas(page);   // idem: se mide la celda SOAT
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

  test('AC3 — la pantalla PIDE el archivo al servidor con sus filtros, no lo arma por su cuenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConciliacion(page);
    // El cuerpo que devuelve el mock es de relleno: lo escribe este mismo archivo y **no se afirma
    // nada sobre él**. La columna «SOAT conciliado» la comprueba la prueba de la API, no esta.
    const pedidas = await mockExport(page);

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();

    // Lo que esta pantalla tiene que garantizar es que no se adelanta armando el archivo por su
    // cuenta —con las 50 filas de la página en vez de las del filtro—, así que lo que se afirma es
    // el PEDIDO: que sale, una sola vez, como POST con la sesión y con los filtros en el cuerpo.
    // `estados: ['Aprobado']` es el valor POR DEFECTO del filtro, no uno puesto a mano.
    await expect.poll(() => pedidas.length).toBe(1);
    expect(pedidas[0].method()).toBe('POST');                        // mutante: volver al GET
    expect(pedidas[0].postDataJSON()).toMatchObject({ estados: ['Aprobado'] });
    expect(pedidas[0].postDataJSON()).not.toHaveProperty('page');    // mutante: colar `page` en el cuerpo
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
    const exportadas = await mockExport(page);

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Falló al emitir 1' }).click();

    await expect.poll(() => urls.at(-1) ?? '').toContain('estadoFacturacion=fallido');
    // Convive con los que ya estaban: el filtro nuevo no borra el estado del trámite ni la etapa.
    expect(urls.at(-1)).toContain('estados=Aprobado');

    // Y el archivo sale del MISMO filtro que la tabla. Un archivo que ignore el filtro puesto es
    // peor que no exportar: parece el listado que se está viendo y no lo es.
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();
    await expect.poll(() => exportadas.length).toBe(1);
    // mutante: quitar `estadoFacturacion` de `cuerpoDeExport`
    expect(exportadas[0].postDataJSON()).toMatchObject({ estadoFacturacion: 'fallido', estados: ['Aprobado'] });
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

// ─────────────────────────────────────────────────────────────────────────────
// HU #12434 (Feature #12404) — secciones, titular, organismo, periodo y vista consolidada.
// ─────────────────────────────────────────────────────────────────────────────

type Pagina = import('@playwright/test').Page;

/** Lo que el API devuelve para el consolidado (HU #12433): las MISMAS sumas del detalle, plegadas. */
const CONSOLIDADO = {
  periodo: 'mes',
  items: [
    {
      clienteClave: 'c1', clienteNombre: 'ACME SAS', periodo: '2026-09', tramites: 41,
      soat: 1800000, impuesto: 480000, derechoTramite: 320000, gmf: 10400, logistica: 60000,
      tramiteDigital: 600000, serviciosAdicionales: 890000,
      totalReintegro: 2670400, totalServicio: 600000, total: 3270400, filasIncompletas: 0,
    },
    {
      clienteClave: 'n900222', clienteNombre: 'Logicargo', periodo: null, tramites: 4,
      soat: 0, impuesto: 0, derechoTramite: 0, gmf: 0, logistica: 0,
      tramiteDigital: 0, serviciosAdicionales: 0,
      totalReintegro: 0, totalServicio: 0, total: 0, filasIncompletas: 3,
    },
  ],
  totales: {
    soat: 1800000, impuesto: 480000, derechoTramite: 320000, gmf: 10400, logistica: 60000,
    tramiteDigital: 600000, serviciosAdicionales: 890000,
    totalReintegro: 2670400, totalServicio: 600000, total: 3270400, filasIncompletas: 3,
  },
};

/**
 * El reporte completo con las peticiones ANOTADAS: `detalle` y `consolidado` guardan las URL en el
 * orden en que salieron, que es sobre lo que afirman los AC3 a AC7. El consolidado responde con el
 * `periodo` que se le pidió, como hace el API.
 */
async function mockSecciones(page: Pagina, opciones: { consolidadoVacio?: boolean } = {}) {
  const detalle: string[] = [];
  const consolidado: string[] = [];
  await mockFacetas(page, ['Aprobado', 'Entregado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    detalle.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...REPORTE, items: [FILA_ESTIMADA, FILA_BLOQUEADA, FILA_JURIDICA], total: 3,
    }) });
  });
  await page.route(/\/api\/finanzas\/reporte-costos\/consolidado\?/, (route) => {
    const url = route.request().url();
    consolidado.push(url);
    const periodo = new URL(url).searchParams.get('periodo') ?? 'mes';
    const items = opciones.consolidadoVacio ? [] : CONSOLIDADO.items.map((i) => ({
      ...i, periodo: i.periodo === null ? null : periodo === 'trimestre' ? '2026-T3' : i.periodo,
    }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...CONSOLIDADO, periodo, items,
    }) });
  });
  return { detalle, consolidado };
}

/** La query de una URL sin los parámetros que se le indiquen, para comparar dos peticiones. */
const querySin = (url: string, ...claves: string[]) => {
  const p = new URL(url).searchParams;
  for (const k of claves) p.delete(k);
  return p.toString();
};

/**
 * Bajo qué GRUPO cae cada columna, leído de la cabecera real: la primera fila del `thead` lleva
 * los `th[scope=colgroup]` con su `colSpan`, y la segunda los `th[scope=col]` en orden. Se cruzan
 * por posición, que es lo que un lector de pantalla también hace.
 */
async function columnasPorGrupo(page: Pagina): Promise<Record<string, string[]>> {
  const tabla = page.getByRole('table').first();
  await expect(tabla.locator('th[scope="colgroup"]').first()).toBeVisible();
  const grupos = await tabla.locator('thead tr').first().locator('th[scope="colgroup"]').evaluateAll(
    (ths) => ths.map((th) => ({ titulo: th.textContent?.trim() ?? '', n: Number(th.getAttribute('colspan') ?? 1) })));
  const columnas = await tabla.locator('thead tr').nth(1).locator('th[scope="col"]').allTextContents();
  const resultado: Record<string, string[]> = {};
  let i = 0;
  for (const g of grupos) {
    // Desde la HU #12537 la fila de grupos SOLO titula: si volviera a llevar el «n de m» o un botón,
    // el nombre no cuadraría y los asertos por grupo caerían (mutante: dejar los botones por sección).
    resultado[g.titulo] = columnas.slice(i, i + g.n).map((c) => c.trim());
    i += g.n;
  }
  return resultado;
}

test.describe('Reporte de costos — secciones, periodo y consolidado (HU #12434)', () => {
  test.beforeEach(async ({ page }) => {
    // AC4: «el mes en curso» es septiembre de 2026 para todos los casos de este bloque.
    await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  });

  test('AC1 — tres grupos rotulados y cada columna bajo el suyo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await ampliarColumnas(page);   // las 30: este caso es de la ampliada; su gemelo compacto está en el bloque de la #12539
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    const grupos = await columnasPorGrupo(page);
    expect(Object.keys(grupos)).toEqual(['Identificación', 'Datos del trámite', 'Valores']);
    // Pertenencia por rol de columna, no solo presencia: «Trámite» (pesos) bajo Valores y «OT»
    // bajo Datos. Si se cruzaran, este aserto cae.
    expect(grupos['Identificación']).toEqual(
      ['Empresa', 'Flit', 'Placa', 'VIN', 'Nombres', 'Apellidos', 'Razón social', 'Tipo', 'Documento']);
    expect(grupos['Datos del trámite']).toEqual(
      ['Tipo trámite', 'Marca', 'Línea', 'OT', 'Estado', 'Fechas', 'Mes', 'Trimestre', 'Factura DIAN']);
    expect(grupos['Valores']).toEqual(
      ['SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística', 'Viajes', 'Total reintegro', 'Trámite digital', 'Serv. adic.', 'Servicio', 'Total', 'Liquidación']);
  });

  test('AC1 — persona natural y jurídica, con y sin organismo, con y sin aprobación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await ampliarColumnas(page);   // titular, Mes y Trimestre se callan en compacta
    await page.goto('/finanzas/reporte-costos');

    const grupos = await columnasPorGrupo(page);
    const todas = [...grupos['Identificación'], ...grupos['Datos del trámite'], ...grupos['Valores']];
    // La casilla de selección va delante de las columnas para quien puede liquidar.
    const celda = (fila: import('@playwright/test').Locator, titulo: string) =>
      fila.getByRole('cell').nth(todas.indexOf(titulo) + 1);

    const natural = filaDe(page, 'FLIT-2001');
    await expect(celda(natural, 'Nombres')).toHaveText('Ana María');
    await expect(celda(natural, 'Apellidos')).toHaveText('Pérez Gómez');
    await expect(celda(natural, 'Razón social')).toHaveText('');
    await expect(celda(natural, 'Tipo')).toHaveText('CC');
    await expect(celda(natural, 'Documento')).toHaveText('CC 1020304050');
    await expect(celda(natural, 'OT')).toHaveText('Envigado');
    await expect(celda(natural, 'Mes')).toHaveText('2026-07');
    await expect(celda(natural, 'Trimestre')).toHaveText('2026-T3');

    const juridica = filaDe(page, 'FLIT-2008J');
    await expect(celda(juridica, 'Nombres')).toHaveText('');
    await expect(celda(juridica, 'Razón social')).toHaveText('Transportes Andes SAS');
    await expect(celda(juridica, 'Documento')).toHaveText('NIT 900123456');
    await expect(celda(juridica, 'OT')).toHaveText('');

    const sinAprobar = filaDe(page, 'FLIT-2002');
    await expect(celda(sinAprobar, 'Mes')).toHaveText('');
    await expect(celda(sinAprobar, 'Trimestre')).toHaveText('');
  });

  test('AC2 — reintegro y servicio se pintan tal cual llegan, en la fila y en los totales', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const detalle: string[] = [];
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      detalle.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ...REPORTE, total: 2,
        // `totalReintegro: 1` NO cuadra con los conceptos a propósito: si la pantalla sumara en el
        // navegador, aquí saldría $ 668.460 y no $ 1.
        items: [FILA_ESTIMADA, { ...FILA_BLOQUEADA, totalReintegro: 1 }],
      }) });
    });
    await ampliarColumnas(page);   // el pie lee SOAT, que se calla en compacta
    await page.goto('/finanzas/reporte-costos');

    const grupos = await columnasPorGrupo(page);
    const todas = [...grupos['Identificación'], ...grupos['Datos del trámite'], ...grupos['Valores']];
    const celda = (id: string, titulo: string) => filaDe(page, id).getByRole('cell').nth(todas.indexOf(titulo) + 1);

    await expect(celda('FLIT-2001', 'Total reintegro')).toHaveText('$ 668.460');
    await expect(celda('FLIT-2001', 'Servicio')).toHaveText('$ 200.000');
    await expect(celda('FLIT-2001', 'Total')).toHaveText('$ 868.460');
    await expect(celda('FLIT-2002', 'Total reintegro')).toHaveText('$ 1');
    // Servicio null con «Trámite digital» sin tarifa → el motivo, nunca $ 0.
    await expect(celda('FLIT-2002', 'Servicio')).toHaveText('No configurado');
    await expect(celda('FLIT-2002', 'Servicio')).not.toContainText('$');
    await expect(filaDe(page, 'FLIT-2002').getByText('Falta: Trámite digital')).toBeVisible();

    // El pie: totales del universo filtrado, con los dos subtotales junto a los conceptos. Desde la
    // HU #12539 el rótulo va en un `th[scope=row]` que se come las columnas sin total: las `td` del
    // pie empiezan en la primera con total, y ese `colSpan` se resta al índice.
    const pie = page.getByRole('table').first().locator('tfoot tr');
    const rotulo = Number(await pie.locator('th[scope="row"]').getAttribute('colspan'));
    const celdaPie = (titulo: string) => pie.getByRole('cell').nth(todas.indexOf(titulo) - rotulo + 1);
    await expect(celdaPie('Total reintegro')).toHaveText('$ 2.670.400');
    await expect(celdaPie('Servicio')).toHaveText('$ 600.000');
    await expect(celdaPie('SOAT')).toHaveText('$ 1.800.000');
  });

  test('AC3 — el filtro OT manda los códigos, se lee por nombre y viaja con los demás', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => detalle.length).toBeGreaterThan(0);

    const ot = page.locator('summary').filter({ hasText: 'OT' });
    await expect(ot).toContainText('Todos');
    await ot.click();
    // Solo lo que ofrece la faceta, con su nombre: el código no se enseña.
    await expect(page.getByRole('checkbox', { name: 'Envigado' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Medellín' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '05266' })).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Envigado' }).check();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('organismos=05266');
    await expect(ot).toContainText('OT');
    await expect(ot).toContainText('Envigado');

    await page.getByRole('checkbox', { name: 'Medellín' }).check();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('organismos=05266%2C05001');
    await expect(ot).toContainText('2 organismos');

    // Combinado con la empresa en la MISMA petición.
    await page.getByLabel('Empresa', { exact: true }).selectOption({ label: 'ACME SAS' });
    await expect.poll(() => detalle.at(-1) ?? '').toContain('empresas=');
    const ultima = detalle.at(-1) ?? '';
    expect(ultima).toContain('organismos=05266%2C05001');
    expect(ultima).toContain('estados=Aprobado');
    expect(ultima).toContain('aprobadoDesde=2026-09-01');
  });

  test('AC4 — al entrar, el selector dice el mes en curso y la primera petición ya lo lleva', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');

    await expect.poll(() => detalle[0] ?? '').toContain('estados=Aprobado');
    expect(detalle[0]).toContain('aprobadoDesde=2026-09-01');
    expect(detalle[0]).toContain('aprobadoHasta=2026-09-30');
    await expect(page.getByRole('status').filter({ hasText: 'Septiembre 2026' })).toBeVisible();
    await expect(page.getByLabel('Mes', { exact: true })).toHaveValue('8');
    await expect(page.getByLabel('Año', { exact: true })).toHaveValue('2026');
    await expect(page.locator('summary').filter({ hasText: 'Aprobación' })).toContainText('1 sep 2026');
    await expect(page.locator('summary').filter({ hasText: 'Aprobación' })).toContainText('30 sep 2026');
  });

  test('AC5 — trimestre, rango a mano («Personalizado») y vuelta a un mes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => detalle.length).toBeGreaterThan(0);

    // Trimestre → el que contiene septiembre: T3, cerrado el 30 de septiembre (no el 30 de agosto
    // ni el 1 de octubre).
    await page.getByRole('button', { name: 'Trimestre' }).click();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('aprobadoDesde=2026-07-01');
    expect(detalle.at(-1)).toContain('aprobadoHasta=2026-09-30');
    await expect(page.getByRole('status').filter({ hasText: 'T3 2026' })).toBeVisible();
    await expect(page.getByLabel('Trimestre', { exact: true })).toHaveValue('2');

    // A mano → «Personalizado», y el selector NO lo pisa aunque la pantalla se repinte.
    await page.locator('summary').filter({ hasText: 'Aprobación' }).click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('aprobadoDesde=2026-09-15');
    await expect(page.getByRole('status').filter({ hasText: 'Personalizado' })).toBeVisible();
    // Un rerender ajeno al periodo: cambiar la etapa. El rango manual sigue.
    await page.getByRole('button', { name: 'Incompletos' }).click();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('etapa=incompleto');
    expect(detalle.at(-1)).toContain('aprobadoDesde=2026-09-15');
    expect(detalle.at(-1)).toContain('aprobadoHasta=2026-09-15');
    await expect(page.getByRole('status').filter({ hasText: 'Personalizado' })).toBeVisible();

    // Mes → Octubre 2026.
    await page.getByRole('button', { name: 'Mes', exact: true }).click();
    await page.getByLabel('Mes', { exact: true }).selectOption('9');
    await expect.poll(() => detalle.at(-1) ?? '').toContain('aprobadoDesde=2026-10-01');
    expect(detalle.at(-1)).toContain('aprobadoHasta=2026-10-31');
    await expect(page.getByRole('status').filter({ hasText: 'Octubre 2026' })).toBeVisible();
  });

  test('AC6 — el consolidado pide los mismos parámetros del detalle más el periodo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle, consolidado } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await page.getByLabel('Empresa', { exact: true }).selectOption({ label: 'ACME SAS' });
    await expect.poll(() => detalle.at(-1) ?? '').toContain('empresas=');
    // Nada del consolidado hasta conmutar: se carga solo cuando se mira.
    expect(consolidado).toHaveLength(0);

    await page.getByRole('tablist', { name: 'Vista del reporte' }).getByRole('button', { name: 'Consolidado' }).click();
    await expect.poll(() => consolidado.length).toBe(1);
    expect(new URL(consolidado[0]).searchParams.get('periodo')).toBe('mes');
    // La MISMA query que el detalle, salvo `page` (del detalle) y `periodo` (del consolidado).
    expect(querySin(consolidado[0], 'periodo')).toBe(querySin(detalle.at(-1)!, 'page'));
    expect(page.url()).toContain('vista=consolidado');

    // Una fila por cliente y periodo, con sus columnas y el pie.
    const tabla = page.getByRole('table');
    for (const h of ['Cliente', 'Periodo', 'Trámites', 'SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística',
      'Total reintegro', 'Trámite digital', 'Servicio', 'Total', 'Incompletos']) {
      await expect(tabla.getByRole('columnheader', { name: h, exact: true })).toBeVisible();
    }
    const acme = page.getByRole('row').filter({ hasText: 'ACME SAS' });
    await expect(acme).toContainText('2026-09');
    await expect(acme).toContainText('41');
    await expect(acme).toContainText('$ 3.270.400');
    // El grupo con incompletas lo señala con el número, no con un color.
    const logicargo = page.getByRole('row').filter({ hasText: 'Logicargo' });
    await expect(logicargo).toContainText('Sin aprobar');
    await expect(logicargo.getByLabel('3 trámites con conceptos sin resolver')).toBeVisible();
    await expect(tabla.locator('tfoot')).toContainText('$ 2.670.400');
    // Sin nada que operar: ni casillas ni acciones.
    await expect(tabla.getByRole('checkbox')).toHaveCount(0);
    await expect(tabla.getByRole('button')).toHaveCount(0);

    // Cambiar a trimestre RECARGA el consolidado con periodo=trimestre.
    await page.getByRole('button', { name: 'Trimestre' }).click();
    await expect.poll(() => consolidado.length).toBe(2);
    expect(new URL(consolidado[1]).searchParams.get('periodo')).toBe('trimestre');
    expect(consolidado[1]).toContain('aprobadoDesde=2026-07-01');
    await expect(page.getByRole('row').filter({ hasText: 'ACME SAS' })).toContainText('2026-T3');

    // De vuelta al detalle con los mismos filtros.
    await page.getByRole('tablist', { name: 'Vista del reporte' }).getByRole('button', { name: 'Detalle' }).click();
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect(page.getByLabel('Empresa', { exact: true })).toHaveValue('900111,9001112');
    expect(page.url()).not.toContain('vista=consolidado');
  });

  test('AC6 — el consolidado vacío lo dice y ofrece limpiar; ?vista=consolidado abre directo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { consolidado } = await mockSecciones(page, { consolidadoVacio: true });
    await page.goto('/finanzas/reporte-costos?vista=consolidado');
    // `>= 1` y no `1`: en desarrollo StrictMode monta los efectos dos veces y la carga inicial
    // puede salir duplicada; lo que importa es que se pidió y qué se pintó.
    await expect.poll(() => consolidado.length).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('No hay trámites que coincidan con los filtros.')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(2);
  });

  test('AC6 — si el consolidado falla se dice, y «Reintentar» repite la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    let intentos = 0;
    await page.route(/\/api\/finanzas\/reporte-costos\/consolidado\?/, (route) => {
      intentos += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'se cayó la base' }) });
    });
    await page.goto('/finanzas/reporte-costos?vista=consolidado');
    await expect(page.getByRole('alert')).toContainText('No se pudo calcular el consolidado');
    const antes = intentos;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => intentos).toBe(antes + 1);
  });

  test('AC7 — «Exportar consolidado» pide el archivo del consolidado con los mismos filtros y periodo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { consolidado } = await mockSecciones(page);
    const exportadas = await mockExport(page, { nombre: 'consolidado-costos_20260914-1530.xlsx' });
    await page.goto('/finanzas/reporte-costos?vista=consolidado');
    await expect(page.getByRole('row').filter({ hasText: 'ACME SAS' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Empresa' }).selectOption('900111,9001112');
    await page.locator('summary').filter({ hasText: 'OT' }).click();
    await page.getByRole('checkbox', { name: 'Envigado' }).check();
    await expect.poll(() => consolidado.at(-1) ?? '').toContain('organismos=05266');
    await page.getByRole('button', { name: 'Trimestre' }).click();
    await expect.poll(() => consolidado.at(-1) ?? '').toContain('periodo=trimestre');

    // En el consolidado el botón es «Exportar consolidado», el único; no hay «Exportar a Excel».
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Exportar consolidado' }).click();
    await expect.poll(() => exportadas.length).toBe(1);
    const peticion = exportadas[0];
    expect(new URL(peticion.url()).pathname).toBe('/api/finanzas/reporte-costos/consolidado/export');
    expect(new URL(peticion.url()).search).toBe('');                 // mutante: criterio en la query
    expect(peticion.method()).toBe('POST');
    expect(peticion.headers()['authorization']).toBe(`Bearer ${TOKEN_E2E}`); // mutante: quitar Authorization
    // La faceta trae los NIT de la empresa en un solo valor con coma; el cuerpo los manda partidos,
    // que es lo que el esquema `.strict()` del API entiende como lista.
    // mutante: `empresas: [f.empresa]` sin partir
    expect(peticion.postDataJSON()).toMatchObject({ periodo: 'trimestre', empresas: ['900111', '9001112'], organismos: ['05266'] });
    // Y el cuerpo es EXACTAMENTE el criterio de la vista: el mismo que el último GET del consolidado.
    expect(queryDeCuerpo(peticion.postDataJSON())).toBe(querySin(consolidado.at(-1)!));
    await expect(bandaExport(page, 'Archivo descargado: consolidado-costos_20260914-1530.xlsx')).toBeVisible();
  });

  test('AC7 — «Exportar a Excel» del detalle lleva el filtro por organismo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    const exportadas = await mockExport(page);
    await page.goto('/finanzas/reporte-costos');
    await page.locator('summary').filter({ hasText: 'OT' }).click();
    await page.getByRole('checkbox', { name: 'Medellín' }).check();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('organismos=05001');

    await page.getByRole('button', { name: 'Exportar a Excel' }).click();
    await expect.poll(() => exportadas.length).toBe(1);
    const peticion = exportadas[0];
    expect(new URL(peticion.url()).pathname).toBe('/api/finanzas/reporte-costos/export');
    expect(peticion.method()).toBe('POST');
    // mutante: quitar `organismos` de `cuerpoDeExport`
    expect(peticion.postDataJSON()).toMatchObject({ organismos: ['05001'], aprobadoDesde: '2026-09-01' });
    expect(peticion.postDataJSON()).not.toHaveProperty('periodo');   // mutante: mandar `periodo` al detalle (400 por `.strict()`)
    // Sin `page`: el archivo es el filtro entero, la tabla es una página de él.
    expect(queryDeCuerpo(peticion.postDataJSON())).toBe(querySin(detalle.at(-1)!, 'page'));
  });

  test('AC8 — auditor ve las secciones, el titular, la OT, el periodo y el consolidado; sigue sin acciones', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const { consolidado } = await mockSecciones(page);
    await ampliarColumnas(page);   // Documento y OT se callan en compacta; el control lo prueba el AC7 de la #12539
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    const grupos = await columnasPorGrupo(page);
    expect(Object.keys(grupos)).toEqual(['Identificación', 'Datos del trámite', 'Valores']);
    expect(grupos['Identificación']).toContain('Documento');
    expect(grupos['Datos del trámite']).toContain('OT');
    await expect(filaDe(page, 'FLIT-2001')).toContainText('CC 1020304050');
    await expect(page.getByRole('status').filter({ hasText: 'Septiembre 2026' })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'OT' })).toBeVisible();

    // Sin casillas ni acciones, como hoy.
    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('checkbox')).toHaveCount(0);
    await expect(tabla.getByRole('button', { name: 'Liquidar' })).toHaveCount(0);
    await expect(tabla.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enviar .* a facturación electrónica/ })).toHaveCount(0);

    // Y conmuta al consolidado, que no está detrás de ninguna página nueva: ve filas y exporta.
    await page.getByRole('tablist', { name: 'Vista del reporte' }).getByRole('button', { name: 'Consolidado' }).click();
    await expect.poll(() => consolidado.length).toBe(1);
    await expect(page.getByRole('row').filter({ hasText: 'ACME SAS' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exportar consolidado' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #12539 — la compacta se recorta a NUEVE columnas para que quepa en la pantalla de un portátil.
// (La #12548 añade «Serv. adic.» a la AMPLIADA —29— y un botón más a Acciones; la #12628 añade
// «Viajes» —30— y otro botón; la compacta sigue en nueve y este bloque es el que lo vigila.)
//
// Sustituye al bloque de la #12537 (12 columnas, colSpan 3/5/4), que solo medía que la compacta
// fuera menor que la ampliada: en 1366×768 seguía desbordando (1628 px frente a 1258). Ahora lo que
// se afirma es que CABE —`scrollWidth === clientWidth` en la región de scroll de `FlitTable`, y sin
// `tabindex`, que es como el kit dice que no desborda—, la cabecera real (`th[scope=col]` en orden y
// el `colSpan` de los grupos), el pie en un `th[scope=row]`, el tipo bajo el Flit, una sola fecha,
// y lo de la #12537 que no cambia: un control, anuncio, `localStorage`, la frase del Excel.
// Cada aserto lleva su mutante en una línea. Backend mockeado.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Reporte de costos — compacta de nueve columnas que cabe en pantalla (HU #12539)', () => {
  const CLAVE = 'flito.reporteCostos.columnas';
  const COMPACTA: Record<string, string[]> = {
    'Identificación': ['Empresa', 'Flit', 'Placa'],
    'Datos del trámite': ['Aprobación', 'Factura DIAN'],
    'Valores': ['Total reintegro', 'Servicio', 'Total', 'Liquidación'],
  };
  const AMPLIADA: Record<string, string[]> = {
    'Identificación': ['Empresa', 'Flit', 'Placa', 'VIN', 'Nombres', 'Apellidos', 'Razón social', 'Tipo', 'Documento'],
    'Datos del trámite': ['Tipo trámite', 'Marca', 'Línea', 'OT', 'Estado', 'Fechas', 'Mes', 'Trimestre', 'Factura DIAN'],
    // «Serv. adic.» va entre «Trámite digital» y «Servicio» (HU #12548, AC6): la fila se lee como
    // la cuenta que es. Va DESPUÉS de la primera de Valores, así que `antesDelPrimerTotal` —y con
    // él el `colSpan` del rótulo del pie— no se mueve; ponerla antes de SOAT lo arrastraría.
    // «Viajes» va justo tras «Logística» (HU #12628, AC1): es la explicación de ese importe.
    'Valores': ['SOAT', 'Impuesto', 'Trámite', 'GMF', 'Logística', 'Viajes', 'Total reintegro', 'Trámite digital', 'Serv. adic.', 'Servicio', 'Total', 'Liquidación'],
  };
  // Las cifras que la pantalla tiene que decir salen de ESTAS listas, no se escriben: si mañana
  // entra una columna, el test cambia con ella y un «9» literal en el código se delata.
  const N_COMPACTA = Object.values(COMPACTA).flat().length;
  const N_AMPLIADA = Object.values(AMPLIADA).flat().length;
  const planas = (g: Record<string, string[]>) => Object.values(g).flat();
  /** Cuántas columnas visibles hay ANTES de la primera con total —la primera de Valores—: el `colSpan` del rótulo del pie. */
  const antesDelPrimerTotal = (g: Record<string, string[]>) => planas(g).indexOf(g['Valores'][0]);
  /** Una razón social de 40 caracteres: la que decidía sola si la tabla cabía. */
  const EMPRESA_LARGA = 'Transportes y Logística del Norte S.A.S.';

  const tabla = (page: Pagina) => page.getByRole('table').first();
  /** La región de scroll de `FlitTable`: el padre directo de la `<table>`. Es la que mide `useDesbordaX`. */
  const region = (page: Pagina) => tabla(page).locator('xpath=..');
  const columnas = (page: Pagina) => tabla(page).locator('thead tr').nth(1).locator('th[scope="col"]');
  const colSpans = (page: Pagina) => tabla(page).locator('th[scope="colgroup"]')
    .evaluateAll((ths) => ths.map((th) => Number(th.getAttribute('colspan'))));
  const control = (page: Pagina) => page.getByRole('button', { name: /columnas/ });
  const anuncio = (page: Pagina, texto: string) => page.getByRole('status').filter({ hasText: texto });
  const fraseExcel = (page: Pagina) => page.getByText('Las demás van en el Excel');
  const enlaceExcel = (page: Pagina) => page.locator('a[href="#exportar-excel"]');
  const rotuloPie = (page: Pagina) => tabla(page).locator('tfoot th[scope="row"]');
  /** Un `th[scope=col]` por su título EXACTO («OT» no es «Total»). */
  const cabecera = (page: Pagina, titulo: string) => columnas(page).filter({ has: page.getByText(titulo, { exact: true }) });
  /** La celda de una columna por su título, contando la casilla que va delante para quien liquida. */
  const celda = (fila: import('@playwright/test').Locator, titulo: string, vista: Record<string, string[]>, conCasilla = true) =>
    fila.getByRole('cell').nth(planas(vista).indexOf(titulo) + (conCasilla ? 1 : 0));
  /**
   * Ancho de la región y de su contenido —«cabe» es que los dos midan lo mismo— y el ancho MÍNIMO
   * de la tabla: lo que pide como poco (`min-content`, con Acciones y los títulos de dos palabras
   * plegados), que es lo que mide `scrollWidth` cuando desborda y por tanto la cifra comparable con
   * los 1628 px de la #12537. Es la que la HU pide registrar y la que dice el margen. Se mide y se
   * restaura en el mismo paso.
   */
  const medida = (page: Pagina) => region(page).evaluate((el) => {
    const t = el.querySelector('table') as HTMLTableElement;
    const antes = t.style.width;
    t.style.width = 'min-content';
    const minimo = t.offsetWidth;
    t.style.width = antes;
    return { scroll: el.scrollWidth, cliente: el.clientWidth, minimo };
  });
  const elegibilidad = (items: Array<{ tramiteId: string; elegible: boolean; motivos: Array<{ motivo: string; detalle: string }> }>) => ({
    items,
    resumen: {
      total: items.length, elegibles: items.filter((i) => i.elegible).length, noElegibles: items.filter((i) => !i.elegible).length,
      anterioresAlCorte: 0,
      porMotivo: {
        liquidacion_no_facturada: 0, documentacion_incompleta: 0, anterior_al_corte: 0,
        sin_compania: 0, tercero_sin_vincular: 0, cliente_no_facturable: 0, compuerta_cerrada: 0, ya_facturado: 0,
      },
    },
  });

  /**
   * Las diez filas del gate de ancho (nota QA 1): las tres combinaciones de acciones alternadas
   * —Soporte + Liquidar + «Falta: SOAT»; Soporte + Facturar + Reversar; Soporte + Enviar a
   * facturación (o ¿Por qué no?)— y la empresa de 40 caracteres en todas.
   */
  async function mockDiezFilasAnchas(page: Pagina) {
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    // Las facturadas van «Aceptada por la DIAN» con su número, que es lo que llevan en la práctica
    // y lo más ancho que pinta Factura DIAN; un «Sin enviar» en todas mediría de menos.
    const base = [FILA_SIN_PAGAR, FILA_LIQUIDADA, { ...FILA_FACTURADA, estadoFacturacion: 'aceptado', facturaNumero: 'FV-1-100' }];
    const filas = Array.from({ length: 10 }, (_, i) => ({
      ...base[i % 3], empresa: EMPRESA_LARGA,
      tramiteId: `aaaa0000-0000-0000-0000-0000000000${20 + i}`, idFlit: `FLIT-30${i}`,
    }));
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...REPORTE, items: filas, total: 10 }) }));
    // La última ruta registrada gana: las facturadas son elegibles salvo la última, que lleva
    // «¿Por qué no?» —la otra forma de la tercera combinación—.
    const facturadas = filas.filter((f) => f.estadoLiquidacion === 'facturado');
    await page.route(/\/api\/siigo\/elegibilidad\/tramites/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(elegibilidad(
        facturadas.map((f, i) => i === facturadas.length - 1
          ? { tramiteId: f.tramiteId, elegible: false, motivos: [{ motivo: 'documentacion_incompleta', detalle: 'Faltan soportes' }] }
          : { tramiteId: f.tramiteId, elegible: true, motivos: [] }),
      )) }));
    return filas;
  }

  /**
   * El montaje del gate de ancho (notas QA 1 y 2): viewport, las diez filas, y la prueba de que las
   * tres combinaciones de acciones están de verdad en la tabla (el lote «Liquidar N» no cuenta).
   * Devuelve las medidas de la compacta; el aserto lo pone cada viewport, porque no dicen lo mismo.
   */
  async function montarGateDeAncho(page: Pagina, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await loginAs(page, OPERACIONES_USER);
    await mockDiezFilasAnchas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-309')).toBeVisible();
    const t = tabla(page);
    await expect(t.getByRole('button', { name: 'Liquidar', exact: true })).toHaveCount(4);
    await expect(t.getByText('Falta: SOAT')).toHaveCount(4);
    await expect(t.getByRole('button', { name: 'Facturar' })).toHaveCount(3);
    await expect(t.getByRole('button', { name: 'Reversar' })).toHaveCount(3);
    await expect(t.getByRole('button', { name: /Enviar .* a facturación electrónica/ })).toHaveCount(3);
    await expect(t.getByRole('button', { name: /^Por qué .* no se puede enviar/ })).toHaveCount(1);
    await expect(t.getByRole('button', { name: 'Soporte' })).toHaveCount(10);
    // El sexto control de la celda (HU #12548). Se afirma AQUÍ, dentro del montaje del gate de
    // ancho: sin esto el gate mediría una tabla sin el botón nuevo y pasaría en verde vacío.
    await expect(t.getByRole('button', { name: /^Servicios adicionales de/ })).toHaveCount(10);
    await expect(t.getByText('Factura FV-1-100')).toHaveCount(3);
    await expect(columnas(page)).toHaveCount(N_COMPACTA);

    const compacta = await medida(page);
    // Se deja escrito en la salida del test: es el dato que la HU pide registrar.
    console.log(`[HU #12539] ${width}×${height} compacta: mínimo ${compacta.minimo} px · contenedor ${compacta.cliente} px · contenido ${compacta.scroll} px`);
    if (process.env.MEDIR_COLUMNAS) {
      // Qué pide cada columna, para volver a repartir el presupuesto del doc UX sin adivinar.
      console.log(await region(page).evaluate((el) => {
        const tb = el.querySelector('table') as HTMLTableElement;
        tb.style.width = 'min-content';
        const ths = [...tb.querySelectorAll('thead tr:nth-child(2) th, thead tr:first-child th[rowspan]')] as HTMLElement[];
        const r = ths.map((th) => `${th.textContent?.trim() || '(sin título)'}=${th.offsetWidth}`).join(' · ');
        tb.style.width = '';
        return r;
      }));
    }
    await page.screenshot({ path: test.info().outputPath(`compacta-${width}.png`), fullPage: true });
    return compacta;
  }

  test('AC1 — en 1366×768 la compacta cabe: diez filas con las tres acciones y una empresa de 40 caracteres', async ({ page }) => {
    const compacta = await montarGateDeAncho(page, 1366, 768);
    // mutante: «OT con compacta: true» (+105 px) → el contenido supera al contenedor y hay scroll. A «px-4 de
    // vuelta» este aserto NO lo mata (medido: 1256 frente a 1258, quedan 2 px); lo matan el caso de 1280 y el AC5.
    expect(compacta.scroll, `compacta desborda: ${compacta.scroll} > ${compacta.cliente}`).toBe(compacta.cliente);
    expect(compacta.minimo).toBeLessThanOrEqual(compacta.cliente);
    // mutante: dejar el `div.overflow-x-auto` exterior → el que desplaza es otro y `FlitTable` no lo sabe
    await expect(region(page)).toHaveAttribute('role', 'region');
    await expect(region(page)).not.toHaveAttribute('tabindex', /.*/);
    await expect(page.locator('[data-desborde]')).toHaveCount(0);

    // Control positivo: la ampliada sí desborda, y entonces el kit sí marca la región.
    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    const ampliada = await medida(page);
    console.log(`[HU #12539] 1366×768 ampliada: mínimo ${ampliada.minimo} px · contenedor ${ampliada.cliente} px · contenido ${ampliada.scroll} px`);
    expect(ampliada.scroll).toBeGreaterThan(ampliada.cliente);
    await expect(region(page)).toHaveAttribute('tabindex', '0');
  });

  /**
   * 1280×720 queda AL LÍMITE, como preveía el doc UX. Medido el 2026-09-14 con estas diez filas
   * (facturadas «Aceptada por la DIAN» con su número, que es lo ancho de verdad): 1192 px frente a
   * 1172 de contenedor; con la palanca D-21 ya aplicada (Empresa a 8rem, −16) quedan 1176: 4 px de
   * desborde. Lo que sigue —alternativa C— no es del frontend sino del PO, y hasta entonces este
   * caso guarda el estado registrado: cualquier columna de vuelta (OT +105, Estado +105, `px-4`
   * +48, el tipo en su columna +110) lo pone en rojo, y si mañana cabe del todo también sigue en verde.
   */
  const DESBORDE_REGISTRADO_1280 = 4;

  test(`AC1 — en 1280×720 queda al límite: con la palanca D-21 desborda ${DESBORDE_REGISTRADO_1280} px (registrado en la HU)`, async ({ page }) => {
    const compacta = await montarGateDeAncho(page, 1280, 720);
    // mutante: OT con `compacta: true` → +105 px
    expect(compacta.minimo - compacta.cliente, `mínimo ${compacta.minimo} px frente a ${compacta.cliente} px de contenedor`)
      .toBeLessThanOrEqual(DESBORDE_REGISTRADO_1280);
  });

  test('AC2 — sin preferencia guardada: nueve columnas en su orden, grupos 3/2/4 y un solo control', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: estado inicial ampliado (`useState(() => true)`) → aquí salen las 30
    // mutante: OT con `compacta: true` → cuatro bajo Datos del trámite y colSpan 3/3/4
    expect(await columnasPorGrupo(page)).toEqual(COMPACTA);
    expect(await colSpans(page)).toEqual(Object.values(COMPACTA).map((c) => c.length));
    await expect(columnas(page)).toHaveCount(N_COMPACTA);
    await expect(columnas(page)).toHaveText(planas(COMPACTA));
    for (const titulo of ['OT', 'Estado', 'Tipo trámite', 'Fechas']) {
      await expect(cabecera(page, titulo), `«${titulo}» no es columna en compacta`).toHaveCount(0);
    }

    // mutante: dejar los botones por sección → tres botones (o cuatro)
    await expect(page.getByRole('button', { name: /Compactar|Mostrar todas/ })).toHaveCount(1);
    await expect(control(page)).toHaveText('Mostrar todas las columnas');
    await expect(control(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(tabla(page).locator('th[scope="colgroup"]')).toHaveText(['Identificación', 'Datos del trámite', 'Valores']);
    await expect(tabla(page).locator('th[scope="colgroup"] button')).toHaveCount(0);
    // mutante: «9» escrito como literal — con una columna más en la lista seguiría diciendo 9
    await expect(page.getByText(`${await columnas(page).count()} de ${N_AMPLIADA} columnas`, { exact: true })).toBeVisible();
  });

  test('AC3 — el tipo de trámite va bajo el Flit en compacta; al ampliar vuelve a su columna', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    const fila = filaDe(page, 'FLIT-2001');
    await expect(fila).toBeVisible();

    const flitCompacta = celda(fila, 'Flit', COMPACTA);
    // mutante: tipo pintado en los dos modos (`celda` con los dos renglones) → la ampliada de abajo cae
    // mutante: tipo en su propia columna también en compacta → habría `th` «Tipo trámite»
    await expect(flitCompacta).toContainText('FLIT-2001');
    await expect(flitCompacta).toContainText('Traspaso');
    // Dos renglones: el Flit arriba y el tipo debajo, en su propio bloque con el texto entero en `title`.
    await expect(flitCompacta.locator('div').nth(0)).toHaveText('FLIT-2001');
    await expect(flitCompacta.locator('div').nth(1)).toHaveText('Traspaso');
    await expect(flitCompacta.locator('div').nth(1)).toHaveAttribute('title', 'Traspaso');
    await expect(cabecera(page, 'Tipo trámite')).toHaveCount(0);
    // Y sin paradas de tabulador nuevas: la celda es texto.
    await expect(flitCompacta.locator('[tabindex], a, button')).toHaveCount(0);

    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    await expect(cabecera(page, 'Tipo trámite')).toHaveCount(1);
    await expect(celda(fila, 'Flit', AMPLIADA)).toHaveText('FLIT-2001');
    await expect(celda(fila, 'Tipo trámite', AMPLIADA)).toHaveText('Traspaso');
  });

  test('AC4 — una sola fecha en compacta: «Aprobación», con «Sin aprobar» y sin «Creado»; al ampliar, «Fechas» con las dos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);   // FLIT-2001 aprobado el 14 de julio; FLIT-2002 sin fecha
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: `CeldaFechas` también en compacta → «Creado» aparece y la cabecera sigue diciendo «Fechas»
    await expect(cabecera(page, 'Aprobación')).toHaveCount(1);
    await expect(cabecera(page, 'Fechas')).toHaveCount(0);
    await expect(celda(filaDe(page, 'FLIT-2001'), 'Aprobación', COMPACTA)).toHaveText('14 de jul de 26');
    await expect(celda(filaDe(page, 'FLIT-2002'), 'Aprobación', COMPACTA)).toHaveText('Sin aprobar');
    await expect(tabla(page).getByText('Creado')).toHaveCount(0);
    await expect(tabla(page).getByText('02 de jul de 26')).toHaveCount(0);

    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    await expect(cabecera(page, 'Fechas')).toHaveCount(1);
    await expect(cabecera(page, 'Aprobación')).toHaveCount(0);
    const fechas = celda(filaDe(page, 'FLIT-2001'), 'Fechas', AMPLIADA);
    await expect(fechas).toContainText('Creado 02 de jul de 26');
    await expect(fechas).toContainText('Aprob. 14 de jul de 26');
    await expect(celda(filaDe(page, 'FLIT-2002'), 'Fechas', AMPLIADA)).toContainText('Sin aprobar');
  });

  test('AC5 — el rótulo del pie va en un th[scope=row] con colSpan 5 / 18, y Empresa no pasa de 168 px', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ...REPORTE, total: 3, items: [{ ...FILA_ESTIMADA, empresa: EMPRESA_LARGA }, FILA_BLOQUEADA, FILA_JURIDICA],
      }) }));
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    const pie = tabla(page).locator('tfoot tr');
    const totalesDelPie = pie.getByRole('cell').filter({ hasText: '$' });
    /** La celda del pie bajo una columna: detrás de la casilla y del rótulo, que se come `colSpan` columnas. */
    const celdaPie = (titulo: string, vista: Record<string, string[]>) =>
      pie.getByRole('cell').nth(planas(vista).indexOf(titulo) - antesDelPrimerTotal(vista) + 1);

    // mutante: rótulo en la primera `td` (como en la #12537) → no hay `th[scope=row]`
    await expect(rotuloPie(page)).toHaveCount(1);
    await expect(rotuloPie(page)).toHaveText('Totales (3 trámites del filtro)');
    await expect(pie.getByRole('rowheader')).toHaveText('Totales (3 trámites del filtro)');
    await expect(pie.getByRole('cell').filter({ hasText: 'Totales' })).toHaveCount(0);
    // mutante: `colSpan` escrito (5) → al ampliar seguiría siendo 5 y los totales se corren
    expect(antesDelPrimerTotal(COMPACTA)).toBe(5);
    await expect(rotuloPie(page)).toHaveAttribute('colspan', String(antesDelPrimerTotal(COMPACTA)));
    // mutante: pie recorriendo `COLUMNAS` en vez de `visibles` → nueve importes
    await expect(totalesDelPie).toHaveCount(3);
    await expect(celdaPie('Total reintegro', COMPACTA)).toHaveText('$ 2.670.400');
    await expect(celdaPie('Servicio', COMPACTA)).toHaveText('$ 600.000');
    await expect(celdaPie('Total', COMPACTA)).toHaveText('$ 3.270.400');
    await expect(celdaPie('Liquidación', COMPACTA)).toHaveText('');

    // Empresa: tope de ancho con el nombre entero en el `title` y en el DOM (D-16). El AC pide
    // ≤ 168 px (9rem + px-3); con la palanca D-21 aplicada (8rem) son 152, y es eso lo que se guarda.
    // mutante: quitar el `max-w` → la celda mide lo que mida la razón social (> 168); volver a 9rem → 168
    const TOPE_EMPRESA = 8 * 16 + 2 * 12;
    const empresa = celda(filaDe(page, 'FLIT-2001'), 'Empresa', COMPACTA);
    await expect(empresa).toHaveText(EMPRESA_LARGA);
    await expect(empresa.locator('[title]')).toHaveAttribute('title', EMPRESA_LARGA);
    const ancho = (await empresa.boundingBox())?.width ?? Infinity;
    expect(ancho, `Empresa mide ${ancho} px`).toBeLessThanOrEqual(TOPE_EMPRESA);
    await expect(empresa.locator('[tabindex], a, button')).toHaveCount(0);

    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    expect(antesDelPrimerTotal(AMPLIADA)).toBe(18);
    await expect(rotuloPie(page)).toHaveAttribute('colspan', String(antesDelPrimerTotal(AMPLIADA)));
    await expect(totalesDelPie).toHaveCount(10);
    await expect(celdaPie('SOAT', AMPLIADA)).toHaveText('$ 1.800.000');
    await expect(celdaPie('Total reintegro', AMPLIADA)).toHaveText('$ 2.670.400');
    await expect(celdaPie('Total', AMPLIADA)).toHaveText('$ 3.270.400');
    // El tope de Empresa es el mismo en los dos modos: no hay dos anchos para la misma celda.
    const anchoAmpliada = (await celda(filaDe(page, 'FLIT-2001'), 'Empresa', AMPLIADA).boundingBox())?.width ?? Infinity;
    expect(anchoAmpliada).toBeLessThanOrEqual(TOPE_EMPRESA);
  });

  test('AC6 — un clic amplía a 30 y otro vuelve a 9; el foco no se mueve, se anuncia y se recuerda en UNA clave', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Dos filas, una con el SOAT conciliado: la marca vive en la celda SOAT, que se calla en compacta.
    await mockConciliacion(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2007')).toBeVisible();

    const boton = control(page);
    const marca = page.getByTestId('marca-soat-conciliado');
    await expect(columnas(page)).toHaveCount(N_COMPACTA);
    await expect(marca).toHaveCount(0);

    // Por TECLADO, para que «el foco se queda en el botón» sea una afirmación y no un efecto del clic.
    await boton.focus();
    await boton.press('Enter');
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    // mutante: cambiar el orden o quitar una de las 30 al ampliar
    expect(await columnasPorGrupo(page)).toEqual(AMPLIADA);
    expect(await colSpans(page)).toEqual(Object.values(AMPLIADA).map((c) => c.length));
    await expect(boton).toHaveText('Compactar columnas');
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    // mutante: mover el foco a la tabla al ampliar
    await expect(boton).toBeFocused();
    // mutante: segunda región `role="status"` para el anuncio → 2 nodos (D-07)
    await expect(anuncio(page, `Todas las columnas: ${N_AMPLIADA}.`)).toHaveCount(1);
    await expect(page.getByText(`${await columnas(page).count()} columnas`, { exact: true })).toBeVisible();
    await expect(marca).toBeVisible();
    // mutante: no escribir la clave (o escribir otra) → tras el reload vuelve a 9
    expect(await page.evaluate((k) => localStorage.getItem(k), CLAVE)).toBe('todas');

    await boton.press('Enter');
    await expect(columnas(page)).toHaveCount(N_COMPACTA);
    expect(await colSpans(page)).toEqual(Object.values(COMPACTA).map((c) => c.length));
    await expect(boton).toHaveText('Mostrar todas las columnas');
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(boton).toBeFocused();
    // mutante: «9» escrito como literal en el anuncio
    await expect(anuncio(page, `Vista compacta: ${N_COMPACTA} de ${N_AMPLIADA} columnas.`)).toHaveCount(1);
    await expect(marca).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), CLAVE)).toBe('compacta');

    // La preferencia sobrevive al reload, y cualquier valor que no sea `todas` es compacta (D-06).
    await page.evaluate((k) => localStorage.setItem(k, 'todas'), CLAVE);
    await page.reload();
    await expect(page.getByText('FLIT-2007')).toBeVisible();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    // mutante: `!== 'compacta'` como condición → «ampliada» abriría las 30
    await page.evaluate((k) => localStorage.setItem(k, 'ampliada'), CLAVE);
    await page.reload();
    await expect(page.getByText('FLIT-2007')).toBeVisible();
    await expect(columnas(page)).toHaveCount(N_COMPACTA);
  });

  test('AC7 — lo que no cambia: «Las demás van en el Excel» solo en compacta, el enlace lleva al botón y NO exporta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    const pedidas = await mockExport(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await expect(fraseExcel(page)).toBeVisible();
    const enlace = enlaceExcel(page);
    await expect(enlace).toHaveText('Exportar a Excel');
    const boton = page.getByRole('button', { name: 'Exportar a Excel' });
    await expect(boton).toHaveAttribute('id', 'exportar-excel');

    await enlace.click();
    // mutante: enlace sin destino (quitar el `id` del botón) → el foco no llega
    await expect(boton).toBeFocused();
    // mutante: segundo disparador del export en el enlace → 1
    expect(pedidas.length).toBe(0);
    await boton.click();
    await expect.poll(() => pedidas.length).toBe(1);

    // Ampliada: nada oculto que explicar → ni frase ni enlace. mutante: frase permanente
    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    await expect(fraseExcel(page)).toHaveCount(0);
    await expect(enlace).toHaveCount(0);
    await control(page).click();
    await expect(fraseExcel(page)).toBeVisible();
  });

  test('AC7 — lo que no cambia: en compacta se sigue leyendo por qué no se puede liquidar, y los filtros OT y Estado siguen', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);   // seis filas: FLIT-2002 sin tarifa digital, FLIT-2005 sin recibo, FLIT-2006 sin pagar
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    expect(await columnasPorGrupo(page)).toEqual(COMPACTA);

    // mutante: Servicio fuera de la compacta → la celda es otra
    await expect(celda(filaDe(page, 'FLIT-2002'), 'Servicio', COMPACTA)).toHaveText('No configurado');
    // mutante: Total reintegro fuera de la compacta
    await expect(celda(filaDe(page, 'FLIT-2005'), 'Total reintegro', COMPACTA)).toHaveText('Sin recibo');
    await expect(celda(filaDe(page, 'FLIT-2006'), 'Total reintegro', COMPACTA)).toHaveText('Sin pagar');
    await expect(filaDe(page, 'FLIT-2002').getByText('Falta: Trámite digital')).toBeVisible();
    await expect(filaDe(page, 'FLIT-2005').getByText('Falta: Derecho de tránsito')).toBeVisible();
    await expect(filaDe(page, 'FLIT-2006').getByRole('button', { name: 'Liquidar' })).toBeDisabled();
    await expect(filaDe(page, 'FLIT-2005').getByText('$ 0')).toHaveCount(0);
    // Liquidación y Factura DIAN siguen en la fila, con sus textos.
    await expect(celda(filaDe(page, 'FLIT-2003'), 'Liquidación', COMPACTA)).toHaveText('Liquidado');
    await expect(celda(filaDe(page, 'FLIT-2001'), 'Factura DIAN', COMPACTA)).toContainText('Sin enviar');
    await expect(filaDe(page, 'FLIT-2003').getByRole('button', { name: 'Facturar' })).toBeVisible();
    await expect(filaDe(page, 'FLIT-2003').getByRole('button', { name: 'Reversar' })).toBeVisible();
    await expect(filaDe(page, 'FLIT-2001').getByRole('button', { name: 'Soporte' })).toBeVisible();
    // OT y Estado salen de la fila, no del filtro (D-19, D-20).
    await expect(page.locator('summary').filter({ hasText: 'OT' })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'Estado' })).toBeVisible();
    // El lote: marcar una fila enseña la barra con «Liquidar N».
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-2001' }).check();
    await expect(page.getByRole('button', { name: /^Liquidar \d+$/ })).toBeVisible();
  });

  test('AC7 — el auditor ve las nueve, el control y el enlace al Excel; sin casillas ni acciones, y en 1366 le cabe', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, AUDITOR_USER);
    await mockDiezFilasAnchas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-309')).toBeVisible();

    expect(await columnasPorGrupo(page)).toEqual(COMPACTA);
    await expect(fraseExcel(page)).toBeVisible();
    await expect(enlaceExcel(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toBeVisible();
    // mutante: esconder el control a quien no liquida (es lectura: lo ven los tres roles)
    await expect(control(page)).toHaveCount(1);
    // Sin casilla: la primera celda de la fila es Empresa.
    await expect(celda(filaDe(page, 'FLIT-300'), 'Empresa', COMPACTA, false)).toHaveText(EMPRESA_LARGA);

    const t = tabla(page);
    await expect(t.getByRole('checkbox')).toHaveCount(0);
    await expect(t.getByRole('button', { name: 'Liquidar' })).toHaveCount(0);
    await expect(t.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
    await expect(t.getByRole('button', { name: 'Reversar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enviar .* a facturación electrónica/ })).toHaveCount(0);
    await expect(t.getByRole('button', { name: 'Soporte' })).toHaveCount(10);

    const m = await medida(page);
    console.log(`[HU #12539] auditor 1366×768 compacta: mínimo ${m.minimo} px · contenedor ${m.cliente} px · contenido ${m.scroll} px`);
    expect(m.scroll).toBe(m.cliente);
    await expect(region(page)).not.toHaveAttribute('tabindex', /.*/);

    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_AMPLIADA);
    await expect(anuncio(page, `Todas las columnas: ${N_AMPLIADA}.`)).toHaveCount(1);
    await control(page).click();
    await expect(columnas(page)).toHaveCount(N_COMPACTA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #12532 — descargar el Excel del reporte de costos con la sesión del usuario.
//
// Lo que se afirma es la PETICIÓN (método, cabecera, cuerpo, cuántas) y lo que la pantalla dice
// después; el contenido del `.xlsx` es del API y lo prueba su spec. Backend mockeado.
test.describe('HU #12532 — exportar a Excel con la sesión', () => {
  test('AC1/AC3/AC6 — un POST con la sesión, sin pestaña nueva; se guarda con el nombre del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    const exportadas = await mockExport(page, { nombre: 'reporte-costos_20260914-1530.xlsx' });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // AC6: un solo botón de exportar en Detalle y ningún «CSV» en la pantalla.
    await expect(page.getByRole('button', { name: /Exportar/ })).toHaveCount(1);
    await expect(page.getByText(/CSV/)).toHaveCount(0);

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar a Excel' }).click(),
    ]);
    await expect.poll(() => exportadas.length).toBe(1);
    const peticion = exportadas[0];
    expect(peticion.method()).toBe('POST');                          // mutante: `window.open` / GET
    expect(new URL(peticion.url()).search).toBe('');                 // mutante: criterio en la query
    expect(peticion.headers()['authorization']).toBe(`Bearer ${TOKEN_E2E}`); // mutante: quitar Authorization
    expect(peticion.postDataJSON()).toMatchObject({ estados: ['Aprobado'] });
    expect(peticion.postDataJSON()).not.toHaveProperty('page');
    // Sin pestaña nueva: la descarga la hace la propia página.
    expect(page.context().pages()).toHaveLength(1);                  // mutante: `window.open`

    // AC3: el archivo se guarda con el nombre que declaró el servidor, y el aviso lo repite.
    expect(descarga.suggestedFilename()).toBe('reporte-costos_20260914-1530.xlsx'); // mutante: nombre fabricado en el cliente
    await expect(bandaExport(page, 'Archivo descargado: reporte-costos_20260914-1530.xlsx')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Archivo descargado: reporte-costos_20260914-1530.xlsx' })).toHaveCount(1);
    // El aviso de éxito no es un `alert`, y se puede quitar.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await expect(bandaExport(page, /Archivo descargado/)).toHaveCount(0);
  });

  test('AC3 — un nombre que no tiene la forma esperada cae al respaldo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    // Un NIT con forma de sello: ocho cifras que no son una fecha.
    await mockExport(page, { nombre: 'reporte-costos_900123456.xlsx' });
    await page.goto('/finanzas/reporte-costos');
    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar a Excel' }).click(),
    ]);
    expect(descarga.suggestedFilename()).toBe('reporte-costos.xlsx');   // mutante: aceptar cualquier nombre
    await expect(bandaExport(page, 'Archivo descargado: reporte-costos.xlsx')).toBeVisible();
  });

  test('AC4 — «Generando…» y deshabilitado en vuelo; un segundo clic no dispara otra petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    const exportadas = await mockExport(page, { demoraMs: 800 });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    const boton = page.getByRole('button', { name: 'Exportar a Excel' });
    // Dos clics en el MISMO tick: el segundo llega antes de que React escriba `disabled` en el DOM.
    // Lo que lo para es la `ref` del hook, no el atributo. mutante: quitar la `ref` y dejar `disabled`
    await boton.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });

    const generando = page.getByRole('button', { name: 'Generando…' });
    await expect(generando).toBeVisible();
    await expect(generando).toBeDisabled();
    await expect(generando).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Generando el archivo del reporte de costos.' })).toHaveCount(1);
    // El candado NO es el de liquidar: exportar no enciende `enProceso` (mutante: reutilizar `ejecutar`).
    await expect(page.getByRole('button', { name: 'Liquidar' }).first()).toBeEnabled();

    await expect(bandaExport(page, /Archivo descargado/)).toBeVisible();
    expect(exportadas).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).not.toHaveAttribute('aria-busy', 'true');
  });

  test('AC5 — el 422 del tope se ve en pantalla con el texto del servidor y no se guarda nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await mockExport(page, { status: 422, cuerpo: {
      codigo: 'export_demasiado_grande', error: 'El filtro trae más de 20000 filas; acota el periodo o el filtro.',
    } });
    let descargas = 0;
    page.on('download', () => { descargas += 1; });
    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();

    const alerta = page.getByRole('alert');
    // Eco del servidor y no un copy propio: el tope es del entorno del API. mutante: decidir por texto
    await expect(alerta).toContainText('El filtro trae más de 20000 filas; acota el periodo o el filtro.');
    // Repetir daría el mismo 422: sin reintento. mutante: decidir solo por `status` (el 422 genérico sí reintenta)
    await expect(alerta.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);
    await expect(alerta.getByRole('button', { name: 'Cerrar el aviso' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toBeEnabled();
    expect(descargas).toBe(0);                                       // mutante: entregar el blob aunque `!res.ok`
  });

  test('AC5 — el 429 pide esperar y «Reintentar la descarga» repite el mismo POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    const exportadas = await mockExport(page, { status: 429, cuerpo: { error: 'Demasiados exports seguidos, espera 1 minuto' } });
    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('Demasiados exports seguidos, espera 1 minuto');
    await alerta.getByRole('button', { name: 'Reintentar la descarga' }).click();
    await expect.poll(() => exportadas.length).toBe(2);
    expect(exportadas[1].method()).toBe('POST');
    expect(exportadas[1].postData()).toBe(exportadas[0].postData()); // mutante: reintentar sin criterio
  });

  test('AC7 — el auditor ve «Exportar a Excel» y exporta con su sesión', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockSecciones(page);
    const exportadas = await mockExport(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();   // mutante: ocultar al auditor
    await expect.poll(() => exportadas.length).toBe(1);
    expect(exportadas[0].headers()['authorization']).toBe(`Bearer ${TOKEN_E2E}`);
    await expect(bandaExport(page, /Archivo descargado: reporte-costos_/)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #12548 — panel de servicios adicionales del trámite, y la columna «Serv. adic.».
//
// Diseño: `docs/ux/finanzas-reporte-costos-servicios-adicionales.md`. Lo que se afirma aquí está
// escrito para que un mutante MUERA, no para que la pantalla «se vea bien»:
//   · el refresco se mide contando peticiones AL REPORTE y comprobando que cambian la celda y el
//     pie — que el panel se repinte a sí mismo no prueba nada;
//   · el foco, con `toBeFocused()` sobre el botón que abrió el panel;
//   · «Cancelar» de la confirmación, con el contador de DELETE en 0 sobre estado ya asentado;
//   · los totales del reporte van a propósito INCOHERENTES con los sumandos, para que una pantalla
//     que sumara por su cuenta cayera;
//   · el panel se abre con el importe del SNAPSHOT (85.000), distinto del vigente del catálogo
//     (120.000): pintar el del catálogo se delata.
// Backend mockeado.
// ─────────────────────────────────────────────────────────────────────────────

const HORA = '2026-09-12T14:14:00.000Z';
const tipo = (id: string, nombre: string, valor: number, descripcion: string | null = null) => ({
  id, nombre, descripcion, valor, activo: true, dadoDeBajaEn: null, dadoDeBajaPorId: null,
  creadoEn: HORA, creadoPorId: null, actualizadoEn: HORA, actualizadoPorId: null,
});
const TIPO_DIAGNOSTICO = tipo('tttt0000-0000-0000-0000-000000000001', 'Diagnóstico', 120000, 'Revisión visual del vehículo en sede.');
const TIPO_PETICION = tipo('tttt0000-0000-0000-0000-000000000002', 'Derecho de petición', 40000);
const TIPO_GRUA = tipo('tttt0000-0000-0000-0000-000000000003', 'Grúa', 85000, 'Traslado en grúa hasta el organismo.');
const CATALOGO = [TIPO_DIAGNOSTICO, TIPO_PETICION, TIPO_GRUA];

/** El valor es el del INSTANTE de asignar (85.000), no el vigente del catálogo (120.000). */
const ASIGNADO_DIAGNOSTICO = {
  id: 'ssss0000-0000-0000-0000-000000000001', tipoId: TIPO_DIAGNOSTICO.id, nombre: 'Diagnóstico',
  descripcion: TIPO_DIAGNOSTICO.descripcion, valor: 85000,
  asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez', asignadoEn: HORA,
};
const ASIGNADO_PETICION = {
  id: 'ssss0000-0000-0000-0000-000000000002', tipoId: TIPO_PETICION.id, nombre: 'Derecho de petición',
  descripcion: null, valor: 40000,
  asignadoPorId: 7, asignadoPorNombre: 'Ana Pérez', asignadoEn: '2026-09-12T14:15:00.000Z',
};

interface EstadoPanel {
  items: Array<typeof ASIGNADO_DIAGNOSTICO>;
  total: number;
  liquidado: boolean;
  getStatus?: number; getCuerpo?: object; getDemoraMs?: number;
  postStatus?: number; postCuerpo?: object;
  borrarStatus?: number; borrarCuerpo?: object;
}

const estadoLleno = (): EstadoPanel => ({
  items: [{ ...ASIGNADO_DIAGNOSTICO }, { ...ASIGNADO_PETICION }], total: 125000, liquidado: false,
});

/**
 * Los tres verbos del trámite sobre la MISMA ruta, con contadores. El POST y el DELETE mutan
 * `estado`, así que el GET siguiente —y el reporte, que se deriva del mismo estado— dicen lo nuevo.
 */
async function mockPanelServicios(page: Pagina, estado: EstadoPanel) {
  const peticiones = { get: 0, post: 0, borrar: 0 };
  await page.route(/\/api\/finanzas\/tramites\/[^/]+\/servicios-adicionales/, async (route) => {
    const metodo = route.request().method();
    const json = (status: number, cuerpo: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });

    if (metodo === 'GET') {
      peticiones.get += 1;
      if (estado.getDemoraMs) await new Promise((r) => setTimeout(r, estado.getDemoraMs));
      if (estado.getStatus) return json(estado.getStatus, estado.getCuerpo ?? { error: 'Error del servidor' });
      return json(200, { items: estado.items, total: estado.total, liquidado: estado.liquidado });
    }
    if (metodo === 'POST') {
      peticiones.post += 1;
      if (estado.postStatus) return json(estado.postStatus, estado.postCuerpo ?? { error: 'Error del servidor' });
      const { tipoId } = JSON.parse(route.request().postData() ?? '{}') as { tipoId: string };
      const t = CATALOGO.find((c) => c.id === tipoId)!;
      const nuevo = {
        id: `ssss0000-0000-0000-0000-9999${t.id.slice(-4)}`, tipoId: t.id, nombre: t.nombre,
        descripcion: t.descripcion, valor: t.valor,
        asignadoPorId: 7, asignadoPorNombre: 'Operaciones E2E', asignadoEn: '2026-09-15T10:00:00.000Z',
      };
      estado.items = [...estado.items, nuevo];
      estado.total += t.valor;
      return json(201, nuevo);
    }
    peticiones.borrar += 1;
    if (estado.borrarStatus) return json(estado.borrarStatus, estado.borrarCuerpo ?? { error: 'Error del servidor' });
    const id = route.request().url().split('/').pop()!;
    const fuera = estado.items.find((i) => i.id === id);
    estado.items = estado.items.filter((i) => i.id !== id);
    if (fuera) estado.total -= fuera.valor;
    // 204 SIN CUERPO: si la pantalla intentara `res.json()` aquí, reventaría.
    return route.fulfill({ status: 204, body: '' });
  });
  return peticiones;
}

/** El catálogo de tipos ACTIVOS, con las URL que llegaron (para afirmar que no se pide al abrir). */
async function mockCatalogoTipos(page: Pagina, opciones: { tipos?: typeof CATALOGO; status?: number; cuerpo?: object } = {}) {
  const peticiones: string[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/servicios-adicionales/, (route) => {
    peticiones.push(route.request().url());
    if (opciones.status) {
      return route.fulfill({ status: opciones.status, contentType: 'application/json',
        body: JSON.stringify(opciones.cuerpo ?? { error: 'Sin permisos para esta operación' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opciones.tipos ?? CATALOGO) });
  });
  return peticiones;
}

/**
 * El reporte se DERIVA del estado del panel: así, tras un 201 o un 204, lo que cambia en la fila y
 * en el pie es consecuencia de la escritura y no de un segundo mock escrito a mano.
 *
 * El pie NO es la suma de las filas de la página (es el agregado del filtro, que el SQL calcula
 * sobre todo el universo): se mantiene deliberadamente descuadrado para que una pantalla que lo
 * sumara ella misma pintara otra cifra y cayera aquí.
 */
async function mockReporteDelPanel(
  page: Pagina,
  estado: EstadoPanel,
  { fila = FILA_ESTIMADA, otras = [FILA_BLOQUEADA, FILA_LIQUIDADA] }: { fila?: typeof FILA_ESTIMADA; otras?: unknown[] } = {},
) {
  const peticiones: string[] = [];
  await mockFacetas(page, ['Aprobado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    peticiones.push(route.request().url());
    const n = estado.items.length;
    const items = [
      { ...fila, serviciosAdicionales: n === 0 ? null : estado.total, serviciosAdicionalesCantidad: n },
      ...otras,
    ];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...REPORTE, items, total: items.length,
      totales: { ...REPORTE.totales, serviciosAdicionales: 890000 + estado.total },
    }) });
  });
  return peticiones;
}

const botonServicios = (page: Pagina, flit: string) =>
  page.getByRole('button', { name: new RegExp(`^Servicios adicionales de ${flit}:`) });
const panelServicios = (page: Pagina) => page.getByRole('dialog', { name: /^Servicios adicionales · / });

test.describe('Reporte de costos — panel de servicios adicionales del trámite (HU #12548)', () => {
  test('AC1 — el botón lleva el contador de la fila, el panel se identifica y Escape devuelve el foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    const panelPeticiones = await mockPanelServicios(page, estado);
    const catalogo = await mockCatalogoTipos(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: contador con `?? 0` → «Servicios · 0» en las dos de abajo
    await expect(botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 2');
    await expect(botonServicios(page, 'FLIT-2002')).toHaveText('Servicios');   // cantidad 0
    await expect(botonServicios(page, 'FLIT-2003')).toHaveText('Servicios');   // cantidad null
    await expect(botonServicios(page, 'FLIT-2002')).toHaveAccessibleName('Servicios adicionales de FLIT-2002: ninguno');
    // El contador NO cuesta una petición: viaja en la fila del reporte.
    expect(panelPeticiones.get).toBe(0);

    await botonServicios(page, 'FLIT-2001').click();
    // mutante: título sin la placa → este nombre accesible cambia
    await expect(panelServicios(page)).toHaveAttribute('aria-label', 'Servicios adicionales · FLIT-2001 · ABC123');
    // El catálogo NO se precarga al abrir el panel (§12-D5).
    expect(catalogo).toHaveLength(0);

    await page.keyboard.press('Escape');
    await expect(panelServicios(page)).toHaveCount(0);
    // mutante: quitar `useFocusTrap` / no restaurar → el foco se queda en <body>
    await expect(botonServicios(page, 'FLIT-2001')).toBeFocused();
  });

  test('AC1 — sin placa el título no deja un « · » colgando, y la ✕ también cierra y devuelve el foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado, { fila: { ...FILA_ESTIMADA, placa: null } });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();

    // mutante: `[...].join(' · ')` sin filtrar nulos → «… · FLIT-2001 · »
    await expect(panelServicios(page)).toHaveAttribute('aria-label', 'Servicios adicionales · FLIT-2001');
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panelServicios(page)).toHaveCount(0);
    await expect(botonServicios(page, 'FLIT-2001')).toBeFocused();
  });

  test('AC2 — los cuatro estados: esqueleto, error con Reintentar que repite el GET, vacío y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado: EstadoPanel = { items: [], total: 0, liquidado: false, getDemoraMs: 1200 };
    await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await mockCatalogoTipos(page);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();

    // Cargando: esqueleto con la FORMA de la lista, no un spinner (mutante: quitar `aria-busy`).
    const esqueleto = panelServicios(page).getByRole('status', { name: 'Cargando los servicios adicionales del trámite' });
    await expect(esqueleto).toHaveAttribute('aria-busy', 'true');

    // Vacío: el texto dice cómo se añade el primero, y la primaria está a la vista una sola vez.
    await expect(panelServicios(page).getByText('Este trámite no tiene servicios adicionales.')).toBeVisible();
    await expect(panelServicios(page).getByText(/Añade el primero desde el catálogo/)).toBeVisible();
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(1);
    await expect(panelServicios(page).getByText('Sin servicios')).toBeVisible();
    // En el PIE el cero sí se escribe: es el total del panel, no un concepto ausente de la tabla.
    await expect(panelServicios(page).getByText('$ 0')).toBeVisible();

    // Error del GET: mensaje + Reintentar que REPITE la petición (mutante: Reintentar que no repide).
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    estado.getDemoraMs = undefined;
    estado.getStatus = 500;
    estado.getCuerpo = { error: 'La base de datos no responde' };
    await botonServicios(page, 'FLIT-2001').click();
    const antes = peticiones.get;
    await expect(panelServicios(page).getByRole('alert')).toContainText('No se pudieron cargar los servicios adicionales de este trámite.');
    await expect(panelServicios(page).getByRole('alert')).toContainText('La base de datos no responde');
    estado.getStatus = undefined;
    estado.items = [{ ...ASIGNADO_DIAGNOSTICO }, { ...ASIGNADO_PETICION }];
    estado.total = 125000;
    await panelServicios(page).getByRole('button', { name: 'Reintentar' }).click();
    expect(peticiones.get).toBe(antes + 1);

    // Lleno: dos renglones por servicio —valor SNAPSHOT, no el del catálogo— y el total al pie.
    await expect(panelServicios(page).getByText('Diagnóstico', { exact: true })).toBeVisible();
    // mutante: pintar el valor vigente del catálogo → $ 120.000
    await expect(panelServicios(page).getByText('$ 85.000')).toBeVisible();
    await expect(panelServicios(page).getByText(/^Añadió Ana Pérez · /).first()).toBeVisible();
    await expect(panelServicios(page).getByText('2 servicios')).toBeVisible();
    // mutante: sumar en la pantalla en vez de pintar el `total` del servidor → coincidiría igual,
    // por eso el caso que lo mata es el del pie del reporte (AC6) y el del 201 de más abajo.
    await expect(panelServicios(page).getByText('$ 125.000')).toBeVisible();
  });

  test('AC3 — el buscador filtra sin tildes, excluye lo asignado, y el 201 refresca la fila y el pie sin aviso global', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    const reporte = await mockReporteDelPanel(page, estado);
    const panelPeticiones = await mockPanelServicios(page, estado);
    const catalogo = await mockCatalogoTipos(page);
    // Ampliada desde el arranque: la celda «Serv. adic.» se comprueba EN VIVO tras el 201. Un
    // `page.reload()` a mitad probaría otra cosa —y de paso borraría la selección, que es justo lo
    // que este test tiene que ver intacta—.
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // La selección de filas marcadas para liquidar, que `ejecutar()` vaciaría (§12-D11).
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-2001' }).check();
    await expect(page.getByText(/1 seleccionado\(s\)/)).toBeVisible();
    const peticionesIniciales = reporte.length;

    await botonServicios(page, 'FLIT-2001').click();
    await expect(panelServicios(page).getByText('Diagnóstico', { exact: true })).toBeVisible();
    await panelServicios(page).getByRole('button', { name: 'Añadir servicio' }).click();
    // El catálogo se pide AL PULSAR, no al abrir el panel.
    // `>= 1` y no `=== 1`: en desarrollo `StrictMode` monta dos veces y el efecto sale dos veces.
    // Lo que importa es que SALIÓ, y que salió SIN `incluirBajas` (un tipo dado de baja no se cobra).
    await expect.poll(() => catalogo.length).toBeGreaterThanOrEqual(1);
    expect(catalogo.every((u) => new URL(u).searchParams.get('incluirBajas') === null)).toBe(true);

    const opciones = panelServicios(page).getByRole('option');
    // Los dos ya asignados quedan fuera: de tres tipos activos solo Grúa es asignable (AC3).
    await expect(opciones).toHaveCount(1);
    await expect(opciones).toHaveText(/Grúa/);
    // Sin tildes ni mayúsculas, y desde el primer carácter (mutante: `includes` sin normalizar).
    await panelServicios(page).getByRole('combobox').fill('GRUA');
    await expect(opciones).toHaveCount(1);
    await panelServicios(page).getByRole('combobox').fill('diagnost');
    await expect(opciones).toHaveCount(0);
    await expect(panelServicios(page).getByText('Ningún tipo activo coincide con «diagnost».')).toBeVisible();

    await panelServicios(page).getByRole('combobox').fill('');
    await opciones.first().click();
    await expect.poll(() => panelPeticiones.post).toBe(1);

    // El buscador sigue abierto y limpio, con el foco en el campo, y el añadido desaparece.
    await expect(panelServicios(page).getByRole('combobox')).toHaveValue('');
    await expect(panelServicios(page).getByRole('combobox')).toBeFocused();
    await expect(panelServicios(page).getByText('Este trámite ya tiene todos los tipos activos del catálogo.')).toBeVisible();
    await expect(panelServicios(page).getByText('3 servicios')).toBeVisible();

    // SIN RECARGAR: el reporte se repide y cambian la celda, el contador del botón y el pie.
    // mutante: no llamar a `refrescar()` tras el 201 → sigue en «$ 125.000 / 2 servicios».
    await expect.poll(() => reporte.length).toBe(peticionesIniciales + 1);
    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2001' });
    // mutante: pintar la celda con una suma local en vez del dato que trae el servidor.
    await expect(fila.getByText('$ 210.000')).toBeVisible();
    await expect(fila.getByText('3 servicios')).toBeVisible();
    // Y el pie de totales: 890.000 + 210.000, que NO es la suma de las filas de la página.
    await expect(page.getByRole('table').first().locator('tfoot')).toContainText('$ 1.100.000');
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 3');

    // Ni aviso global de la página —el resultado y el error viven DENTRO del panel—, ni selección
    // perdida: `ejecutar()` habría hecho las dos cosas (AC3, §12-D11).
    await expect(page.getByText(/1 seleccionado\(s\)/)).toBeVisible();
    await expect(page.locator('main').getByText('Grúa añadido.')).toHaveCount(0);
  });

  test('AC3 — los errores del alta se dicen EN LÍNEA, y el 403 del catálogo nombra la función que falta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await mockCatalogoTipos(page, { status: 403 });
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();
    await panelServicios(page).getByRole('button', { name: 'Añadir servicio' }).click();

    // mutante: un 403 tratado como error genérico → saldría «No se pudo cargar…» y un Reintentar
    await expect(panelServicios(page).getByRole('alert')).toContainText('Pídele a un administrador la función «Ver el catálogo de servicios adicionales».');
    await expect(panelServicios(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    // Y nada de esto sube al aviso global de la pantalla.
    await expect(page.locator('main').getByText(/Pídele a un administrador/)).toHaveCount(0);
  });

  test('AC3 — el 409 de «ya asignado» se explica en línea y recarga la lista; el buscador sigue abierto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await mockCatalogoTipos(page);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();
    await panelServicios(page).getByRole('button', { name: 'Añadir servicio' }).click();
    await expect(panelServicios(page).getByRole('option')).toHaveCount(1);

    const gets = peticiones.get;
    estado.postStatus = 409;
    estado.postCuerpo = { error: 'Ese servicio ya está asignado a este trámite', codigo: 'SERVICIO_YA_ASIGNADO' };
    await panelServicios(page).getByRole('option').first().click();

    await expect(panelServicios(page).getByRole('alert')).toContainText('Ese servicio ya está asignado a este trámite.');
    // mutante: no repedir la lista → el contador de GET no se mueve
    await expect.poll(() => peticiones.get).toBe(gets + 1);
    await expect(panelServicios(page).getByRole('combobox')).toBeVisible();
  });

  test('AC4 — la confirmación de «Quitar» va en línea con nombre y valor; Cancelar no envía nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();
    await expect(panelServicios(page).getByText('Diagnóstico', { exact: true })).toBeVisible();

    await panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' }).click();
    // mutante: confirmación sin el valor → este texto exacto falla
    await expect(panelServicios(page).getByText('¿Quitar «Diagnóstico» ($ 85.000)?')).toBeVisible();
    // No es un diálogo encima del diálogo: sigue habiendo UN solo `role="dialog"` (§12-D2).
    await expect(page.getByRole('dialog')).toHaveCount(1);
    // El foco entra en «Cancelar», NO en el «Quitar» que confirma: en una acción sin vuelta el foco
    // no se pone por defecto sobre la que la ejecuta. Sin este aserto, mover el foco al botón
    // destructivo —o dejarlo en `<body>` al desmontarse el que abrió— no lo vería nadie.
    await expect(panelServicios(page).getByRole('button', { name: 'Cancelar' })).toBeFocused();

    await panelServicios(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(panelServicios(page).getByText('¿Quitar «Diagnóstico»')).toHaveCount(0);
    // El foco vuelve al «Quitar» de esa fila, y sobre ESTADO ASENTADO no salió ninguna petición.
    await expect(panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' })).toBeFocused();
    expect(peticiones.borrar).toBe(0);
    await expect(panelServicios(page).getByText('$ 125.000')).toBeVisible();
  });

  test('AC4 — confirmar quita la fila, baja el total y refresca el reporte sin recargar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    const reporte = await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await expect(botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 2');
    const iniciales = reporte.length;

    await botonServicios(page, 'FLIT-2001').click();
    await panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' }).click();
    await panelServicios(page).getByRole('button', { name: 'Quitar', exact: true }).click();

    await expect.poll(() => peticiones.borrar).toBe(1);
    await expect(panelServicios(page).getByText('Diagnóstico', { exact: true })).toHaveCount(0);
    await expect(panelServicios(page).getByText('1 servicio', { exact: true })).toBeVisible();
    // El TOTAL del pie, que es el único `<strong>` del panel: bajó de 125.000 a 40.000.
    await expect(panelServicios(page).locator('strong')).toHaveText('$ 40.000');
    // El foco no se queda en el aire: el botón que lo abrió ya no existe, así que va a la primaria.
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toBeFocused();
    // mutante: no llamar a `refrescar()` tras el 204
    await expect.poll(() => reporte.length).toBe(iniciales + 1);
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 1');
  });

  test('AC5 — liquidado: sin botones (no apagados) y con la instrucción de reversar para quien opera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado: EstadoPanel = { ...estadoLleno(), liquidado: true };
    await mockReporteDelPanel(page, estado, { fila: FILA_LIQUIDADA, otras: [] });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2003').click();

    await expect(panelServicios(page).getByText(/Liquidado: estos servicios quedaron sellados\./)).toBeVisible();
    await expect(panelServicios(page).getByText(/Reversa la liquidación para cambiarlos\./)).toBeVisible();
    // NO existen: no se pintan apagados (mutante: `disabled` en vez de no montarlos).
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
    await expect(panelServicios(page).getByRole('button', { name: /^Quitar · / })).toHaveCount(0);
    // Y sigue siendo la única forma de ver qué se le cobró: la lista y el total están.
    await expect(panelServicios(page).getByText('$ 125.000')).toBeVisible();
    // No es un error: ni `role="alert"` ni icono de alerta bajo el título.
    await expect(panelServicios(page).getByRole('alert')).toHaveCount(0);
  });

  test('AC5 — el auditor ve el panel en solo lectura y NUNCA la frase de reversar', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const estado: EstadoPanel = { ...estadoLleno(), liquidado: true };
    await mockReporteDelPanel(page, estado, { fila: FILA_LIQUIDADA, otras: [] });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2003').click();

    await expect(panelServicios(page).getByText(/Liquidado: estos servicios quedaron sellados\./)).toBeVisible();
    // mutante: pintar la segunda frase sin mirar las funciones → reversar no es su trabajo (AC5)
    await expect(panelServicios(page).getByText(/Reversa la liquidación/)).toHaveCount(0);
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
  });

  test('AC5 — el auditor sobre un trámite NO liquidado: sin botones y sin línea de estado', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();

    await expect(panelServicios(page).getByText('Diagnóstico', { exact: true })).toBeVisible();
    // mutante: línea de estado por «no puede operar» en vez de por «liquidado»
    await expect(panelServicios(page).getByText(/quedaron sellados/)).toHaveCount(0);
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
    await expect(panelServicios(page).getByRole('button', { name: /^Quitar · / })).toHaveCount(0);
  });

  test('AC5 — tras reversar en la fila, el panel vuelve a ser editable sin recargar la página', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado: EstadoPanel = { ...estadoLleno(), liquidado: true };
    // La fila vive en el mismo estado que el panel: reversar la desella para los dos.
    const sellada = { ...FILA_LIQUIDADA, serviciosAdicionales: 125000, serviciosAdicionalesCantidad: 2 };
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ...REPORTE, total: 1,
        items: [estado.liquidado
          ? sellada
          : { ...sellada, sellada: false, estadoLiquidacion: null }],
      }),
    }));
    await page.route(/\/api\/flito\/liquidacion\/[^/]+\/reversar/, (route) => {
      estado.liquidado = false;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');

    await botonServicios(page, 'FLIT-2003').click();
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();

    await page.getByRole('button', { name: 'Reversar' }).click();
    await page.getByLabel('Motivo del reverso').fill('Se cobró de más');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText(/reversada\./)).toBeVisible();

    // Sin F5: el panel repide y `liquidado: false` lo devuelve a editable.
    await botonServicios(page, 'FLIT-2003').click();
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toBeVisible();
    await expect(panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' })).toBeVisible();
  });

  test('AC5 — carrera del sello: el 409 al quitar lo dice en línea y deja el panel de solo lectura', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();
    await panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' }).click();

    estado.borrarStatus = 409;
    estado.borrarCuerpo = { error: 'Reversa la liquidación para cambiar los servicios', codigo: 'TRAMITE_LIQUIDADO' };
    estado.liquidado = true;
    await panelServicios(page).getByRole('button', { name: 'Quitar', exact: true }).click();

    // El literal del servidor, en línea dentro del panel, nunca en el aviso global.
    await expect(panelServicios(page).getByRole('alert')).toContainText('Reversa la liquidación para cambiar los servicios');
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
    await expect(panelServicios(page).getByRole('button', { name: /^Quitar · / })).toHaveCount(0);
  });

  test('§9 — Escape por capas: cancela la confirmación, luego cierra el buscador, y solo al final el panel', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await mockCatalogoTipos(page);
    await page.goto('/finanzas/reporte-costos');
    await botonServicios(page, 'FLIT-2001').click();

    // 1) La confirmación de «Quitar» (mutante: quitar el `stopPropagation` → se cierra el panel).
    await panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' }).click();
    await page.keyboard.press('Escape');
    await expect(panelServicios(page).getByText('¿Quitar «Diagnóstico»')).toHaveCount(0);
    await expect(panelServicios(page)).toHaveCount(1);

    // 2) El buscador.
    await panelServicios(page).getByRole('button', { name: 'Añadir servicio' }).click();
    await expect(panelServicios(page).getByRole('combobox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelServicios(page).getByRole('combobox')).toHaveCount(0);
    await expect(panelServicios(page)).toHaveCount(1);
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toBeFocused();

    // 3) Sin nada abierto, el panel.
    await page.keyboard.press('Escape');
    await expect(panelServicios(page)).toHaveCount(0);
  });

  test('AC1/permisos — sin `finanzas.servicios_adicionales.ver` el botón no existe', async ({ page }) => {
    const sinVer = funcionesDe(OPERACIONES_USER).filter((f) => f !== 'finanzas.servicios_adicionales.ver');
    await loginAs(page, OPERACIONES_USER, { funciones: sinVer });
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: pintar el botón apagado en vez de no pintarlo
    await expect(page.getByRole('button', { name: /^Servicios adicionales de/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Soporte' }).first()).toBeVisible();
  });

  test('AC6 — la columna «Serv. adic.»: fuera de la compacta, entre Trámite digital y Servicio, y sus cuatro lecturas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ...REPORTE, total: 4,
        items: [FILA_ESTIMADA, FILA_BLOQUEADA, FILA_LIQUIDADA, FILA_SIN_PAGAR],
      }),
    }));
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // En compacta NO está (mutante: `compacta: true` en la entrada de COLUMNAS).
    const cabeceras = page.getByRole('table').first().locator('thead tr').nth(1).locator('th[scope="col"]');
    await expect(cabeceras).toHaveCount(9);
    await expect(cabeceras.filter({ hasText: 'Serv. adic.' })).toHaveCount(0);

    await page.getByRole('button', { name: /Mostrar todas las columnas/ }).click();
    await expect(cabeceras).toHaveCount(30);
    // `allTextContents` y no `allInnerTexts`: la cabecera va en versalitas por CSS y `innerText`
    // devolvería «SERV. ADIC.», que no es lo que dice el DOM ni lo que lee un lector de pantalla.
    const titulos = await cabeceras.allTextContents();
    // mutante: ponerla después de «Servicio» → la cuenta deja de leerse como tal
    expect(titulos.indexOf('Serv. adic.')).toBe(titulos.indexOf('Trámite digital') + 1);
    expect(titulos.indexOf('Servicio')).toBe(titulos.indexOf('Serv. adic.') + 1);

    const celdaDe = (flit: string) => page.getByRole('row').filter({ hasText: flit })
      .getByRole('cell').nth(titulos.indexOf('Serv. adic.') + 1);
    // Con servicios: dos renglones y el nombre accesible completo.
    await expect(celdaDe('FLIT-2001')).toHaveText('$ 125.0002 servicios');
    await expect(celdaDe('FLIT-2001')).toHaveAttribute('aria-label', '$ 125.000 en 2 servicios adicionales');
    // cantidad 0 → el guion; cantidad null → «Sin dato» con su explicación. No son lo mismo.
    // mutante: `if (!valor) vacío` → FLIT-2006 perdería su cobro legítimo de cero.
    await expect(celdaDe('FLIT-2002')).toHaveText('—');
    await expect(celdaDe('FLIT-2003')).toHaveText('Sin dato');
    await expect(celdaDe('FLIT-2003').getByTitle('Se liquidó antes de que FLITO cobrara servicios adicionales.')).toBeVisible();
    // importe 0 con cantidad 2: el cero SÍ se pinta (mutante: `pesos(valor ?? 0)` pondría «$ 0» en las tres de arriba).
    await expect(celdaDe('FLIT-2006')).toHaveText('$ 02 servicios');

    // El pie trae su total, y es el del SERVIDOR: 890.000 no es la suma de las filas de la página.
    const pie = page.getByRole('table').first().locator('tfoot tr').first();
    await expect(pie.getByRole('cell').nth(titulos.indexOf('Serv. adic.') - titulos.indexOf('SOAT') + 1)).toHaveText('$ 890.000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #12628 — columna «Viajes» en la ampliada y panel de SOLO LECTURA con el desglose por viaje.
// Diseño: `docs/ux/finanzas-reporte-costos-viajes.md`. Cada aserto lleva su mutante:
//   · la celda la gobierna `logisticaViajesCantidad` de la fila (nunca `items.length`): 0 y null
//     son afirmaciones distintas («—» / «Sin dato») y ningún «0» se cuela;
//   · el contador del botón solo con n ≥ 2, en TODAS las filas y para el auditor, sin función nueva;
//   · el pie del panel pinta `totalLogistica` DEL SERVIDOR: la fixture va descuadrada a propósito
//     (35.000 + 35.000 + 62.000 = 132.000, pero el servidor dice 99.000) para que sumar en cliente caiga;
//   · 403 sin Reintentar, 404 con «Actualizar el reporte», red con Reintentar que repite el GET;
//   · el foco vuelve al botón «Viajes» de la misma fila. Backend mockeado.
// ─────────────────────────────────────────────────────────────────────────────

const viaje = (
  numero: number, valor: number, modo: 'inicial' | 'manual', tarifaVigente: number | null,
  motivo: 'devolucion' | 'segunda_entrega' | 'documento_faltante' | 'otro', motivoDetalle: string | null = null,
  registradoPorNombre: string | null = 'Ana Ríos',
) => ({
  id: `vvvv0000-0000-0000-0000-00000000000${numero}`, numero, modo, valor, tarifaVigente, motivo, motivoDetalle,
  registradoPorNombre, registradoEn: '2026-09-15T15:12:00.000Z',
});

/** El desglose vigente de FLIT-2001: tarifa 35.000, un viaje a tarifa y uno manual; el total NO cuadra a propósito. */
const DESGLOSE_VIGENTE = {
  tramiteId: FILA_ESTIMADA.tramiteId, idFlit: 'FLIT-2001', placa: 'ABC123',
  gestionaLogistica: true, liquidado: false, liquidadoEn: null, origen: 'vigente' as const,
  tarifa: 35000, totalViajes: 3, totalLogistica: 99000,
  items: [
    viaje(2, 35000, 'inicial', 35000, 'devolucion'),
    viaje(3, 62000, 'manual', 45000, 'otro', 'cliente pidió entrega en sede norte', 'L. Mora'),
  ],
};

/** Las filas del reporte de este bloque: 3 viajes, solo el incluido, autogestiona y sellada sin desglose. */
const FILA_AUTOGESTIONA = {
  ...FILA_ESTIMADA, tramiteId: 'aaaa0000-0000-0000-0000-000000000031', idFlit: 'FLIT-2031',
  logistica: null, autogestionados: ['Logística'], logisticaViajesCantidad: 0,
};
const FILAS_VIAJES = [FILA_ESTIMADA, FILA_BLOQUEADA, FILA_AUTOGESTIONA, FILA_LIQUIDADA];

async function mockReporteViajes(page: Pagina, filas: unknown[] = FILAS_VIAJES) {
  const peticiones: string[] = [];
  await mockFacetas(page, ['Aprobado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    peticiones.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...REPORTE, items: filas, total: filas.length,
    }) });
  });
  return peticiones;
}

/**
 * El GET del desglose, con contador y con la respuesta que se le diga (cuerpo, código o demora).
 * `opciones` se lee EN CADA petición: el test puede mutarlo (quitar el `status`) para que el
 * siguiente GET —el de «Reintentar»— responda bien. Los contadores se comparan por «creció», no por
 * un número exacto: en dev `StrictMode` monta dos veces y el primer GET se descarta (`vivo = false`).
 */
async function mockDesglose(
  page: Pagina,
  opciones: { cuerpo?: unknown; status?: number; error?: object; demoraMs?: number } = {},
) {
  const peticiones = { get: 0 };
  await page.route(/\/api\/finanzas\/tramites\/[^/]+\/viajes-logistica/, async (route) => {
    peticiones.get += 1;
    if (opciones.demoraMs) await new Promise((r) => setTimeout(r, opciones.demoraMs));
    const json = (status: number, cuerpo: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });
    if (opciones.status) return json(opciones.status, opciones.error ?? { error: 'Error del servidor' });
    return json(200, opciones.cuerpo ?? DESGLOSE_VIGENTE);
  });
  return peticiones;
}

const botonViajes = (page: Pagina, flit: string) =>
  page.getByRole('button', { name: new RegExp(`^Viajes de logística de ${flit}:`) });
const panelViajes = (page: Pagina) => page.getByRole('dialog', { name: /^Viajes de logística · / });

test.describe('HU #12628 — columna «Viajes» en la ampliada y panel de solo lectura por viaje', () => {
  const cabeceras = (page: Pagina) => page.getByRole('table').first().locator('thead tr').nth(1).locator('th[scope="col"]');

  test('AC1 — «Viajes» va tras «Logística» solo en la ampliada (30), sin pie; la compacta sigue en 9 de 30', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await expect(cabeceras(page)).toHaveCount(30);
    const titulos = await cabeceras(page).allTextContents();
    // mutante: ponerla tras «Serv. adic.» → deja de leerse como la explicación de Logística
    expect(titulos.indexOf('Viajes')).toBe(titulos.indexOf('Logística') + 1);
    expect(titulos.indexOf('Total reintegro')).toBe(titulos.indexOf('Viajes') + 1);
    // mutante: `total` añadido a la entrada → el pie deja de estar vacío bajo «Viajes»
    const pie = page.getByRole('table').first().locator('tfoot tr').first();
    await expect(pie.getByRole('cell').nth(titulos.indexOf('Viajes') - titulos.indexOf('SOAT') + 1)).toHaveText('');
    await expect(pie.getByRole('cell').nth(titulos.indexOf('Logística') - titulos.indexOf('SOAT') + 1)).not.toHaveText('');

    // mutante: `compacta: true` → aparece en la compacta y el anuncio dice 10 de 30
    await page.getByRole('button', { name: /Compactar columnas/ }).click();
    await expect(cabeceras(page)).toHaveCount(9);
    await expect(cabeceras(page).filter({ hasText: 'Viajes' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Vista compacta: 9 de 30 columnas.' })).toHaveCount(1);
  });

  test('AC2 — la celda: «3» y «1» con su nombre accesible, «—» para 0 y «Sin dato» para null; ningún «0»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    const titulos = await cabeceras(page).allTextContents();
    const celdaDe = (flit: string) => page.getByRole('row').filter({ hasText: flit })
      .getByRole('cell').nth(titulos.indexOf('Viajes') + 1);

    await expect(celdaDe('FLIT-2001')).toHaveText('3');
    await expect(celdaDe('FLIT-2001')).toHaveAttribute('aria-label', '3 viajes de logística');
    // mutante: plural fijo → «1 viajes de logística»
    await expect(celdaDe('FLIT-2002')).toHaveText('1');
    await expect(celdaDe('FLIT-2002')).toHaveAttribute('aria-label', '1 viaje de logística');
    // 0 = autogestiona → el guion del reporte, con su `title`
    await expect(celdaDe('FLIT-2031')).toHaveText('—');
    await expect(celdaDe('FLIT-2031').getByTitle('Autogestiona')).toBeVisible();
    // null = sellada antes del concepto → «Sin dato» (mutante: `?? 0` → «0»)
    await expect(celdaDe('FLIT-2003')).toHaveText('Sin dato');
    await expect(celdaDe('FLIT-2003').getByTitle('Se liquidó antes de que FLITO cobrara viajes adicionales.')).toBeVisible();
    await expect(celdaDe('FLIT-2003')).not.toHaveText(/0/);
  });

  test('AC3 — el botón «Viajes» en todas las filas: contador solo con n ≥ 2, tras «Servicios», y el auditor lo ve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    const desglose = await mockDesglose(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: contador con `n >= 1` → «Viajes · 1» en FLIT-2002; con `?? 0` → «· 0» en la sellada
    await expect(botonViajes(page, 'FLIT-2001')).toHaveText('Viajes · 3');
    await expect(botonViajes(page, 'FLIT-2002')).toHaveText('Viajes');
    await expect(botonViajes(page, 'FLIT-2031')).toHaveText('Viajes');
    await expect(botonViajes(page, 'FLIT-2003')).toHaveText('Viajes');   // sellada: también lo lleva
    await expect(botonViajes(page, 'FLIT-2001')).toHaveAccessibleName('Viajes de logística de FLIT-2001: 3 viajes');
    await expect(botonViajes(page, 'FLIT-2002')).toHaveAccessibleName('Viajes de logística de FLIT-2002: 1 viaje');
    await expect(botonViajes(page, 'FLIT-2031')).toHaveAccessibleName('Viajes de logística de FLIT-2031: autogestiona');
    await expect(botonViajes(page, 'FLIT-2003')).toHaveAccessibleName('Viajes de logística de FLIT-2003: sin dato');
    // El contador NO cuesta una petición: viaja en la fila.
    expect(desglose.get).toBe(0);

    // Orden: Soporte → Servicios → Viajes → Liquidar (consultar antes que operar).
    const botones = await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button').allTextContents();
    expect(botones.indexOf('Viajes · 3')).toBe(botones.indexOf('Servicios · 2') + 1);
    expect(botones.indexOf('Liquidar')).toBeGreaterThan(botones.indexOf('Viajes · 3'));
  });

  test('AC3 — el auditor SIN la función de servicios ve «Viajes» en todas las filas y abre el panel', async ({ page }) => {
    // Se le quita `finanzas.servicios_adicionales.ver` a propósito: el fixture del auditor la trae, y con
    // ella un gating por `puedeVerServicios` pasaría desapercibido. Sin la función, «Servicios» no se
    // pinta y «Viajes» tiene que seguir ahí, justo tras «Soporte».
    const sinVerServicios = funcionesDe(AUDITOR_USER).filter((f) => f !== 'finanzas.servicios_adicionales.ver');
    await loginAs(page, AUDITOR_USER, { funciones: sinVerServicios });
    await mockReporteViajes(page);
    await mockDesglose(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    // mutante: gating por `puedeVerServicios` → el auditor se queda sin botón
    await expect(botonViajes(page, 'FLIT-2001')).toBeVisible();
    await expect(botonViajes(page, 'FLIT-2003')).toBeVisible();
    const botones = await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button').allTextContents();
    expect(botones).not.toContain('Servicios · 2');
    expect(botones.indexOf('Viajes · 3')).toBe(botones.indexOf('Soporte') + 1);
    // Y sin Liquidar ni Facturar: el auditor solo consulta.
    expect(botones).not.toContain('Liquidar');

    await botonViajes(page, 'FLIT-2001').click();
    await expect(panelViajes(page)).toBeVisible();
    await expect(panelViajes(page).getByText('Total logística')).toBeVisible();
  });

  test('AC4 — el panel lleno: título, origen, Viaje 1, cada viaje con su modo y motivo, y el total DEL SERVIDOR; cero acciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    const desglose = await mockDesglose(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await botonViajes(page, 'FLIT-2001').click();
    const panel = panelViajes(page);
    // mutante: título sin la placa
    await expect(panel).toHaveAttribute('aria-label', 'Viajes de logística · FLIT-2001 · ABC123');
    expect(desglose.get).toBeGreaterThanOrEqual(1);
    await expect(panel.getByText('Estimado con los viajes registrados')).toBeVisible();
    await expect(panel.getByText('Viaje 1 · incluido en la tarifa · $ 35.000')).toBeVisible();

    const filas = panel.getByRole('listitem');
    await expect(filas).toHaveCount(2);
    await expect(filas.nth(0)).toContainText('Viaje 2');
    await expect(filas.nth(0)).toContainText('$ 35.000');
    await expect(filas.nth(0)).toContainText('Tarifa · Tarifa del momento $ 35.000');
    await expect(filas.nth(0)).toContainText('Devolución · Ana Ríos · 15 sep 2026');
    await expect(filas.nth(1)).toContainText('Viaje 3');
    await expect(filas.nth(1)).toContainText('$ 62.000');
    // mutante: modo sin la tarifa del momento → no se ve la desviación
    await expect(filas.nth(1)).toContainText('Precio manual · Tarifa del momento $ 45.000');
    await expect(filas.nth(1)).toContainText('Otro: cliente pidió entrega en sede norte · L. Mora');
    // Los uuid van en `data-id`, nunca en pantalla.
    await expect(filas.nth(0)).toHaveAttribute('data-id', DESGLOSE_VIGENTE.items[0].id);
    await expect(panel).not.toContainText('vvvv0000');

    // mutante: sumar en cliente → 132.000. El servidor dice 99.000 y eso es lo que se pinta.
    await expect(panel.getByText('3 viajes', { exact: true })).toBeVisible();
    await expect(panel.getByText('$ 99.000')).toBeVisible();
    await expect(panel).not.toContainText('132.000');

    // Solo lectura: el único botón del diálogo es el ✕ del kit; ningún input.
    await expect(panel.getByRole('button')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Cerrar' })).toBeVisible();
    await expect(panel.locator('input, select, textarea')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Registrar|Quitar|Añadir/ })).toHaveCount(0);
  });

  test('AC4 — el foco: entra al ✕, y Esc y el ✕ lo devuelven al botón «Viajes» de la misma fila', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await mockDesglose(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await botonViajes(page, 'FLIT-2002').focus();
    await page.keyboard.press('Enter');
    await expect(panelViajes(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(panelViajes(page).getByRole('button', { name: 'Cerrar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panelViajes(page)).toHaveCount(0);
    // mutante: devolver el foco al título → aquí cae
    await expect(botonViajes(page, 'FLIT-2002')).toBeFocused();

    await botonViajes(page, 'FLIT-2001').click();
    await expect(panelViajes(page)).toBeVisible();
    await panelViajes(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panelViajes(page)).toHaveCount(0);
    await expect(botonViajes(page, 'FLIT-2001')).toBeFocused();
  });

  test('AC5 — sin_desglose: «Sin dato…», «Sellado el …», el total sellado y SIN «Viaje 1»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await mockDesglose(page, { cuerpo: {
      ...DESGLOSE_VIGENTE, tramiteId: FILA_LIQUIDADA.tramiteId, idFlit: 'FLIT-2003',
      liquidado: true, liquidadoEn: '2026-09-12T14:14:00.000Z', origen: 'sin_desglose',
      tarifa: null, totalViajes: null, totalLogistica: 15000, items: null,
    } });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2003')).toBeVisible();

    await botonViajes(page, 'FLIT-2003').click();
    const panel = panelViajes(page);
    await expect(panel.getByText('Sin dato: se liquidó antes de que FLITO cobrara viajes adicionales.')).toBeVisible();
    await expect(panel.getByText(/^Sellado el 12 sep 2026, \d{1,2}:\d{2}/)).toBeVisible();
    await expect(panel.getByText('$ 15.000')).toBeVisible();
    // mutante: pintar la cabecera del viaje 1 en sin_desglose
    await expect(panel.getByText(/Viaje 1/)).toHaveCount(0);
    await expect(panel.getByRole('listitem')).toHaveCount(0);
  });

  test('AC5 — autogestiona: «La logística de esta compañía la gestiona el cliente…» y ningún «$ 0»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await mockDesglose(page, { cuerpo: {
      ...DESGLOSE_VIGENTE, tramiteId: FILA_AUTOGESTIONA.tramiteId, idFlit: 'FLIT-2031',
      gestionaLogistica: false, tarifa: null, totalViajes: 0, totalLogistica: null, items: [],
    } });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2031')).toBeVisible();

    await botonViajes(page, 'FLIT-2031').click();
    const panel = panelViajes(page);
    await expect(panel.getByText('La logística de esta compañía la gestiona el cliente: no hay viajes que cobrar.')).toBeVisible();
    await expect(panel.getByText(/Viaje 1/)).toHaveCount(0);
    await expect(panel.getByText('Total logística')).toHaveCount(0);
    await expect(panel).not.toContainText('$ 0');
    await expect(panel).not.toContainText('0 viajes');
  });

  test('AC5 — solo el incluido: Viaje 1 arriba, «Sin viajes adicionales.» y «1 viaje»; sin tarifa, «Sin tarifa configurada»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    const desglose = await mockDesglose(page, { cuerpo: {
      ...DESGLOSE_VIGENTE, tramiteId: FILA_BLOQUEADA.tramiteId, idFlit: 'FLIT-2002',
      totalViajes: 1, totalLogistica: 35000, items: [],
    } });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2002')).toBeVisible();

    await botonViajes(page, 'FLIT-2002').click();
    const panel = panelViajes(page);
    await expect(panel.getByText('Viaje 1 · incluido en la tarifa · $ 35.000')).toBeVisible();
    await expect(panel.getByText('Sin viajes adicionales.')).toBeVisible();
    await expect(panel.getByText('1 viaje', { exact: true })).toBeVisible();
    await expect(panel.getByText('$ 35.000')).toHaveCount(2);   // cabecera y total
    await page.keyboard.press('Escape');

    // Sin tarifa configurada: la cabecera lo dice con palabras, sin «$ 0».
    await page.unroute(/\/api\/finanzas\/tramites\/[^/]+\/viajes-logistica/);
    await mockDesglose(page, { cuerpo: {
      ...DESGLOSE_VIGENTE, tramiteId: FILA_BLOQUEADA.tramiteId, idFlit: 'FLIT-2002',
      tarifa: null, totalViajes: 1, totalLogistica: null, items: [],
    } });
    await botonViajes(page, 'FLIT-2002').click();
    await expect(panelViajes(page).getByText('Viaje 1 · incluido en la tarifa · Sin tarifa configurada')).toBeVisible();
    await expect(panelViajes(page)).not.toContainText('$ 0');
    // La segunda apertura pintó lo del mock nuevo: cada apertura repide, no cachea.
    expect(desglose.get).toBeGreaterThanOrEqual(1);
  });

  test('AC5 — 403 sin Reintentar; 404 con «Actualizar el reporte» que cierra y refresca', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const reporte = await mockReporteViajes(page);
    await mockDesglose(page, { status: 403, error: { error: 'Sin permisos para esta operación' } });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    const pedidasAntes = reporte.length;

    await botonViajes(page, 'FLIT-2001').click();
    const panel = panelViajes(page);
    await expect(panel.getByRole('alert')).toHaveText('Tu usuario ya no puede ver los viajes de este trámite. Vuelve a entrar para actualizar tus permisos.');
    // mutante: Reintentar en 403
    await expect(panel.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Actualizar el reporte' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.unroute(/\/api\/finanzas\/tramites\/[^/]+\/viajes-logistica/);
    await mockDesglose(page, { status: 404, error: { error: 'Trámite no encontrado' } });
    await botonViajes(page, 'FLIT-2001').click();
    await expect(panelViajes(page).getByRole('alert')).toHaveText('El trámite ya no existe.');
    await expect(panelViajes(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await panelViajes(page).getByRole('button', { name: 'Actualizar el reporte' }).click();
    // mutante: no cerrar, o no refrescar (`window.location.reload` también caería: el mock cuenta URLs del reporte)
    await expect(panelViajes(page)).toHaveCount(0);
    await expect.poll(() => reporte.length).toBe(pedidasAntes + 1);
  });

  test('AC5 — red/5xx: esqueleto mientras carga, `role="alert"` y Reintentar que repite el mismo GET', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    const opciones = { status: 500, error: { error: 'Se cayó la base' }, demoraMs: 300 };
    const desglose = await mockDesglose(page, opciones);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await botonViajes(page, 'FLIT-2001').click();
    const panel = panelViajes(page);
    // mutante: spinner sin `role="status"` o sin `aria-busy`
    const esqueleto = panel.getByRole('status', { name: 'Consultando los viajes…' });
    await expect(esqueleto).toBeVisible();
    await expect(esqueleto).toHaveAttribute('aria-busy', 'true');

    await expect(panel.getByRole('alert')).toContainText('No se pudieron cargar los viajes de este trámite.');
    await expect(panel.getByRole('alert')).toContainText('Se cayó la base');
    await expect(panel.getByText('Total logística')).toHaveCount(0);
    const antes = desglose.get;
    // El servidor se recupera; «Reintentar» tiene que REPEDIR para enterarse (mutante: no repide).
    opciones.status = 0;
    await panel.getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel.getByText('Viaje 1 · incluido en la tarifa · $ 35.000')).toBeVisible();
    expect(desglose.get).toBeGreaterThan(antes);
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });
});
