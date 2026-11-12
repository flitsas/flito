import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, OPERACIONES_USER, AUDITOR_USER, FINANCIERA_USER, TOKEN_E2E } from '../helpers/auth';

// HU #10967 — Reporte de costos. Liquidar, facturar y consultar soportes sin salir de la pantalla.
// Las filas liquidadas muestran valores sellados; el resto, un estimado. Backend mockeado.

/** Un concepto de costo de proveedor con valor (`CostoProveedorConcepto`). */
const costo = (proveedor: string | null, valor: number | null, estado = 'costo', extra: Record<string, unknown> = {}) => ({
  estado, proveedorId: proveedor ? `p-${proveedor}` : null, proveedor, vigenciaId: valor !== null ? 'v-1' : null,
  valor, fechaReferencia: '2026-07-10T12:00:00.000Z', contadoEnTramiteId: null, contadoEnIdFlit: null, ...extra,
});
const COSTO_SOAT = costo('Seguros Demo', 48000);
const COSTO_LOGISTICA = costo('Transportes Demo Norte', 35000);

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
  // Origen y valor documental (HU #12653 los manda, la #12655 los pinta). El caso normal: los dos
  // honorarios salen de la tarifa y no hay comprobante aplicado. Van en la base para que en ampliada
  // el chip «Tarifa» pese en todas las filas, como en producción.
  origenes: { tramiteDigital: 'tarifa', logistica: 'tarifa' },
  valorDocumental: { tramiteDigital: null, logistica: null, serviciosAdicionales: null },
  // Costo de proveedor (ADR-0041 §13, Épica #13763): informativo, nunca suma al cobro. Claves
  // siempre presentes en el contrato; la base trae los dos conceptos con valor (C1).
  costoProveedorSoat: COSTO_SOAT,
  costoProveedorLogistica: COSTO_LOGISTICA,
  costoProveedorTotal: 83000,
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
  // Costo de proveedor del filtro (Épica #13763): hermano de `totales`, nunca dentro. A propósito
  // distinto de la suma de las filas de la página, por la misma razón que `serviciosAdicionales`.
  totalesCostosProveedor: {
    costoProveedorSoat: 1500000, costoProveedorLogistica: 240000, costoProveedorTotal: 1740000,
    tramitesCostoSinConfigurar: 0,
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
/** Los `id` de `definicionColumnasReporteCostos.tsx`, en su orden. */
const TODAS_LAS_COLUMNAS = [
  'tramite', 'placa', 'empresa', 'tipo', 'aprobacion', 'liquidacion', 'falta',
  'soat', 'impuesto', 'derecho', 'logistica', 'digital', 'adicionales', 'gmf', 'totalReintegro', 'servicio', 'viajes', 'total',
  'costoSoat', 'proveedorSoat', 'costoLogistica', 'proveedorLogistica', 'totalCostos',
  'creacion', 'estado', 'ot', 'mes', 'trimestre', 'facturaDian', 'marca', 'linea', 'vin',
  'nombres', 'apellidos', 'razonSocial', 'tipoDocumento', 'documento',
];

async function ampliarColumnas(page: import('@playwright/test').Page) {
  await page.addInitScript((TODAS_LAS_COLUMNAS) => {
    // Desde el rediseño (Épica #13763) la preferencia es la LISTA de columnas visibles, clave v2.
    try { localStorage.setItem('flito.reporteCostos.columnas.v2', JSON.stringify(TODAS_LAS_COLUMNAS)); } catch { /* sin storage */ }
  }, TODAS_LAS_COLUMNAS);
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

/**
 * Desde el rediseño (Épica #13763) la fila lleva UN botón y el ⋮: Soporte, Servicios, Viajes,
 * Aceptar diferencia y Reversar… se eligen en el menú de la fila.
 */
async function abrirMenuFila(page: import('@playwright/test').Page, idFlit: string) {
  // Un ⋮ ya abierto se cierra antes: un segundo clic sobre el mismo lo plegaría.
  if (await page.getByRole('menu').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `Más acciones de ${idFlit}`, exact: true }).click();
  return page.getByRole('menu');
}
async function accionDeFila(page: import('@playwright/test').Page, idFlit: string, opcion: string | RegExp) {
  const menu = await abrirMenuFila(page, idFlit);
  await menu.getByRole('menuitem', { name: opcion }).click();
}
/** Empresa, Tipo, Estado, OT, Creación y las casillas viven en «Más filtros» desde el rediseño. */
async function abrirMasFiltros(page: import('@playwright/test').Page) {
  const summary = page.locator('summary').filter({ hasText: 'Más filtros' });
  if (!(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open))) await summary.click();
}
/** El rango de aprobación es el «Rango personalizado» del control Periodo. */
async function abrirPeriodo(page: import('@playwright/test').Page) {
  const summary = page.locator('summary').filter({ hasText: /^Periodo/ });
  if (!(await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open))) await summary.click();
}

test.describe('Finanzas — Reporte de costos', () => {
  test('distingue sellado y facturado; sin liquidar la columna queda vacía (sin «Estimado»)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // Retoque 3 del humano (Épica #13763): «Liquidación» no dice «Estimado».
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' })).toBeVisible();
    await expect(page.getByRole('table').getByText('Estimado', { exact: true })).toHaveCount(0);
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
    await abrirMasFiltros(page);
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
    await abrirMasFiltros(page);
    await rango('Creación').click();
    await page.getByRole('button', { name: 'Este mes' }).click();
    await expect.poll(() => urls.at(-1) ?? '').toContain('desde=');

    // Desde el rediseño el rango de aprobación es el «Rango personalizado» del Periodo.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await abrirPeriodo(page);
    await rango('Rango personalizado').click();
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
    await abrirMasFiltros(page);
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
    // Con el punto de partida puesto no hay nada que limpiar: «Limpiar filtros» no se pinta.
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
    await abrirMasFiltros(page);
    await page.locator('summary').filter({ hasText: 'Estado' }).click();
    await page.getByRole('checkbox', { name: 'Entregado' }).check();
    await page.locator('summary').filter({ hasText: 'Creación' }).click();
    await page.getByRole('button', { name: 'Este mes' }).click();
    // Y el rango de aprobación a mano, para que «limpiar» tenga que volver al mes en curso, no
    // conservar lo que había.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await abrirPeriodo(page);
    await page.locator('summary').filter({ hasText: 'Rango personalizado' }).click();
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
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
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
    // Desde el rediseño lo dice la columna «Falta» y el `title` del botón.
    await expect(fila.getByRole('button', { name: 'Liquidar' })).toHaveAttribute('title', 'Falta: Derecho de tránsito');
    await expect(fila.getByRole('cell', { name: 'Derecho de tránsito', exact: true })).toBeVisible();
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
    await expect(fila.getByRole('button', { name: 'Liquidar' })).toHaveAttribute('title', 'Falta: SOAT');
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
    await abrirMasFiltros(page);

    const empresas = page.getByRole('combobox', { name: 'Empresa' });
    await expect(empresas.getByRole('option')).toHaveText(['Todas las empresas', 'ACME SAS']);
    await empresas.selectOption('900111,9001112');
  });

  test('un concepto sin tarifa se muestra como «Sin configurar», no como cero', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    const fila = page.getByRole('row').filter({ hasText: 'FLIT-2002' });
    // «Sin configurar» desde la Épica #13763: el mismo hecho se dice igual en cobro y costo.
    await expect(fila.getByText('Sin configurar').first()).toBeVisible();
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
    await expect(page.getByText(/tienen un concepto sin\s+resolver/)).toBeVisible();

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
    await expect(bloqueada.getByRole('button', { name: 'Liquidar' })).toHaveAttribute('title', /Falta: Trámite digital/);

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
    await expect(liquidada.getByRole('button', { name: 'Facturar' })).toBeVisible();
    // Reversar vive en el ⋮ desde el rediseño.
    await expect((await abrirMenuFila(page, 'FLIT-2003')).getByRole('menuitem', { name: 'Reversar…' })).toBeVisible();
    await page.keyboard.press('Escape');

    const facturada = page.getByRole('row').filter({ hasText: 'FLIT-2004' });
    await expect(facturada.getByRole('button', { name: 'Facturar' })).toHaveCount(0);
    await expect((await abrirMenuFila(page, 'FLIT-2004')).getByRole('menuitem', { name: 'Reversar…' })).toHaveCount(0);
  });

  test('el reverso exige un motivo antes de confirmar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    // El motivo se pide en un diálogo, no en un campo dentro de la celda.
    await accionDeFila(page, 'FLIT-2003', 'Reversar…');
    const dialogo = page.getByRole('dialog', { name: 'Reversar la liquidación de FLIT-2003' });
    await expect(dialogo.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await dialogo.getByLabel('Motivo del reverso').fill('error de tarifa');
    await expect(dialogo.getByRole('button', { name: 'Confirmar' })).toBeEnabled();
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
    await accionDeFila(page, 'FLIT-2001', 'Soporte');
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
    await accionDeFila(page, 'FLIT-2001', 'Soporte');
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
    await accionDeFila(page, 'FLIT-2001', 'Soporte');
    await expect(page.getByText(/no tiene ningún documento cargado/)).toBeVisible();
  });

  test('auditor consulta y ve soportes, pero no liquida ni factura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await expect((await abrirMenuFila(page, 'FLIT-2001')).getByRole('menuitem', { name: 'Soporte' })).toBeVisible();
    await page.keyboard.press('Escape');
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
  // «Factura DIAN» está en «Más del trámite», fuera de la vista por defecto desde el rediseño
  // (Épica #13763): estos casos la piden visible con la preferencia v2.
  test.beforeEach(async ({ page }) => { await ampliarColumnas(page); });

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
  // «Factura DIAN» está en «Más del trámite», fuera de la vista por defecto desde el rediseño
  // (Épica #13763): estos casos la piden visible con la preferencia v2.
  test.beforeEach(async ({ page }) => { await ampliarColumnas(page); });

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
      costoProveedorSoat: 1968000, costoProveedorLogistica: 1435000, costoProveedorTotal: 3403000, tramitesCostoSinConfigurar: 2,
    },
    {
      clienteClave: 'n900222', clienteNombre: 'Logicargo', periodo: null, tramites: 4,
      soat: 0, impuesto: 0, derechoTramite: 0, gmf: 0, logistica: 0,
      tramiteDigital: 0, serviciosAdicionales: 0,
      totalReintegro: 0, totalServicio: 0, total: 0, filasIncompletas: 3,
      costoProveedorSoat: 0, costoProveedorLogistica: 0, costoProveedorTotal: 0, tramitesCostoSinConfigurar: 0,
    },
  ],
  totales: {
    soat: 1800000, impuesto: 480000, derechoTramite: 320000, gmf: 10400, logistica: 60000,
    tramiteDigital: 600000, serviciosAdicionales: 890000,
    totalReintegro: 2670400, totalServicio: 600000, total: 3270400, filasIncompletas: 3,
    costoProveedorSoat: 1968000, costoProveedorLogistica: 1435000, costoProveedorTotal: 3403000, tramitesCostoSinConfigurar: 2,
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
  // Desde el rediseño (Épica #13763) las fijas (Trámite, Placa) llevan un `th` de grupo SIN título
  // ni `scope`; la casilla y las acciones, `rowspan=2`. Se recorren todos menos esos dos.
  const grupos = await tabla.locator('thead tr').first().locator('th:not([rowspan="2"])').evaluateAll(
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
    // Desde el rediseño (Épica #13763): las fijas, Esencial, Cobro al cliente, Costo de proveedor,
    // Más del trámite y Titular. Pertenencia por rol de columna, no solo presencia.
    expect(Object.keys(grupos)).toEqual(['', 'Esencial', 'Cobro al cliente', 'Costo de proveedor', 'Más del trámite', 'Titular']);
    expect(grupos['']).toEqual(['Trámite', 'Placa']);
    expect(grupos['Esencial']).toEqual(['Empresa', 'Tipo', 'Aprobación', 'Liquidación', 'Falta']);
    expect(grupos['Cobro al cliente']).toEqual(
      ['SOAT', 'Impuesto', 'Derecho', 'Logística', 'Trámite digital', 'Adicionales', 'GMF', 'Total reintegro', 'Servicio', 'Viajes', 'Total']);
    expect(grupos['Costo de proveedor']).toEqual(['Costo SOAT', 'Proveedor SOAT', 'Costo logística', 'Proveedor logística', 'Total costos']);
    expect(grupos['Más del trámite']).toEqual(['Creación', 'Estado', 'OT', 'Mes', 'Trimestre', 'Factura DIAN', 'Marca', 'Línea', 'VIN']);
    expect(grupos['Titular']).toEqual(['Nombres', 'Apellidos', 'Razón social', 'Tipo de documento', 'Documento']);
  });

  test('AC1 — persona natural y jurídica, con y sin organismo, con y sin aprobación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSecciones(page);
    await ampliarColumnas(page);   // titular, Mes y Trimestre se callan en compacta
    await page.goto('/finanzas/reporte-costos');

    const grupos = await columnasPorGrupo(page);
    const todas = Object.values(grupos).flat();
    // La casilla de selección va delante de las columnas para quien puede liquidar.
    const celda = (fila: import('@playwright/test').Locator, titulo: string) =>
      fila.getByRole('cell').nth(todas.indexOf(titulo) + 1);

    const natural = filaDe(page, 'FLIT-2001');
    await expect(celda(natural, 'Nombres')).toHaveText('Ana María');
    await expect(celda(natural, 'Apellidos')).toHaveText('Pérez Gómez');
    await expect(celda(natural, 'Razón social')).toHaveText('');
    await expect(celda(natural, 'Tipo de documento')).toHaveText('CC');
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
    const todas = Object.values(grupos).flat();
    const celda = (id: string, titulo: string) => filaDe(page, id).getByRole('cell').nth(todas.indexOf(titulo) + 1);

    await expect(celda('FLIT-2001', 'Total reintegro')).toHaveText('$ 668.460');
    await expect(celda('FLIT-2001', 'Servicio')).toHaveText('$ 200.000');
    await expect(celda('FLIT-2001', 'Total')).toHaveText('$ 868.460');
    await expect(celda('FLIT-2002', 'Total reintegro')).toHaveText('$ 1');
    // Servicio null con «Trámite digital» sin tarifa → el motivo, nunca $ 0.
    await expect(celda('FLIT-2002', 'Servicio')).toHaveText('Sin configurar');
    await expect(celda('FLIT-2002', 'Servicio')).not.toContainText('$');
    await expect(celda('FLIT-2002', 'Falta')).toHaveText('Trámite digital');

    // El pie: totales del universo filtrado, con los dos subtotales junto a los conceptos. Desde la
    // HU #12539 el rótulo va en un `th[scope=row]` que se come las columnas sin total: las `td` del
    // pie empiezan en la primera con total, y ese `colSpan` se resta al índice.
    // Desde la segunda pasada del rediseño (Épica #13763) el rótulo ocupa solo las columnas FIJAS
    // (sticky) y una celda vacía cubre el resto: cada celda con total se busca por su `data-pie`.
    const pie = page.getByRole('table').first().locator('tfoot tr');
    const celdaPie = (id: string) => pie.locator(`td[data-pie="${id}"]`);
    await expect(celdaPie('totalReintegro')).toHaveText('$ 2.670.400');
    await expect(celdaPie('servicio')).toHaveText('$ 600.000');
    await expect(celdaPie('soat')).toHaveText('$ 1.800.000');
  });

  test('AC3 — el filtro OT manda los códigos, se lee por nombre y viaja con los demás', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => detalle.length).toBeGreaterThan(0);
    await abrirMasFiltros(page);

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
    await page.getByRole('combobox', { name: 'Empresa' }).selectOption({ label: 'ACME SAS' });
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
    // Plegado, el Periodo ya lo dice; dentro, el selector y el rango personalizado.
    await expect(page.locator('summary').filter({ hasText: /^Periodo/ })).toContainText('Septiembre 2026');
    await abrirPeriodo(page);
    await expect(page.getByRole('status').filter({ hasText: 'Septiembre 2026' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Mes', exact: true })).toHaveValue('8');
    await expect(page.getByRole('combobox', { name: 'Año', exact: true })).toHaveValue('2026');
    await expect(page.locator('summary').filter({ hasText: 'Rango personalizado' })).toContainText('1 sep 2026');
    await expect(page.locator('summary').filter({ hasText: 'Rango personalizado' })).toContainText('30 sep 2026');
  });

  test('AC5 — trimestre, rango a mano («Personalizado») y vuelta a un mes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await expect.poll(() => detalle.length).toBeGreaterThan(0);

    // Trimestre → el que contiene septiembre: T3, cerrado el 30 de septiembre (no el 30 de agosto
    // ni el 1 de octubre).
    await abrirPeriodo(page);
    await page.getByRole('button', { name: 'Trimestre' }).click();
    await expect.poll(() => detalle.at(-1) ?? '').toContain('aprobadoDesde=2026-07-01');
    expect(detalle.at(-1)).toContain('aprobadoHasta=2026-09-30');
    await expect(page.getByRole('status').filter({ hasText: 'T3 2026' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Trimestre', exact: true })).toHaveValue('2');

    // A mano → «Personalizado», y el selector NO lo pisa aunque la pantalla se repinte.
    await page.locator('summary').filter({ hasText: 'Rango personalizado' }).click();
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
    await page.getByRole('combobox', { name: 'Mes', exact: true }).selectOption('9');
    await expect.poll(() => detalle.at(-1) ?? '').toContain('aprobadoDesde=2026-10-01');
    expect(detalle.at(-1)).toContain('aprobadoHasta=2026-10-31');
    await expect(page.getByRole('status').filter({ hasText: 'Octubre 2026' })).toBeVisible();
  });

  test('AC6 — el consolidado pide los mismos parámetros del detalle más el periodo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { detalle, consolidado } = await mockSecciones(page);
    await page.goto('/finanzas/reporte-costos');
    await abrirMasFiltros(page);
    await page.getByRole('combobox', { name: 'Empresa' }).selectOption({ label: 'ACME SAS' });
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
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await abrirPeriodo(page);
    await page.getByRole('button', { name: 'Trimestre' }).click();
    await expect.poll(() => consolidado.length).toBe(2);
    expect(new URL(consolidado[1]).searchParams.get('periodo')).toBe('trimestre');
    expect(consolidado[1]).toContain('aprobadoDesde=2026-07-01');
    await expect(page.getByRole('row').filter({ hasText: 'ACME SAS' })).toContainText('2026-T3');

    // De vuelta al detalle con los mismos filtros.
    await page.getByRole('tablist', { name: 'Vista del reporte' }).getByRole('button', { name: 'Detalle' }).click();
    await expect(page.getByText('FLIT-2001')).toBeVisible();
    await abrirMasFiltros(page);
    await expect(page.getByRole('combobox', { name: 'Empresa' })).toHaveValue('900111,9001112');
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
    // El del vacío; el de la fila de chips no se pinta sin nada distinto del punto de partida.
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(1);
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
    await abrirMasFiltros(page);
    await page.getByRole('combobox', { name: 'Empresa' }).selectOption('900111,9001112');
    await page.locator('summary').filter({ hasText: 'OT' }).click();
    await page.getByRole('checkbox', { name: 'Envigado' }).check();
    await expect.poll(() => consolidado.at(-1) ?? '').toContain('organismos=05266');
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await abrirPeriodo(page);
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
    await abrirMasFiltros(page);
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
    expect(Object.keys(grupos)).toEqual(['', 'Esencial', 'Cobro al cliente', 'Costo de proveedor', 'Más del trámite', 'Titular']);
    expect(grupos['Titular']).toContain('Documento');
    expect(grupos['Más del trámite']).toContain('OT');
    await expect(filaDe(page, 'FLIT-2001')).toContainText('CC 1020304050');
    await expect(page.locator('summary').filter({ hasText: /^Periodo/ })).toContainText('Septiembre 2026');
    await abrirMasFiltros(page);
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

// HU #12539 (compacta de nueve columnas) — RETIRADO por el rediseño de la Épica #13763: el binario
// compacta/ampliada lo sustituye el panel «Columnas» con clave v2, cubierto en el bloque
// «Reporte de costos — rediseño y costo de proveedor (Épica #13763)» al final de este archivo.

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

/**
 * Desde el rediseño (Épica #13763) «Servicios», «Viajes» y «Aceptar diferencia» son opciones del ⋮
 * de la fila, con el MISMO nombre accesible que tenían como botón. El helper abre el menú y devuelve
 * la opción; al cerrar el panel, el foco vuelve al ⋮ (`botonMenu`), que es quien lo abrió.
 */
const botonMenu = (page: import('@playwright/test').Page, flit: string) =>
  page.getByRole('button', { name: `Más acciones de ${flit}`, exact: true });
async function opcionDeMenu(page: import('@playwright/test').Page, flit: string, nombre: RegExp) {
  if (await page.getByRole('menu').count()) await page.keyboard.press('Escape');
  await botonMenu(page, flit).click();
  return page.getByRole('menu').getByRole('menuitem', { name: nombre });
}
const botonServicios = (page: Pagina, flit: string) =>
  opcionDeMenu(page, flit, new RegExp(`^Servicios adicionales de ${flit}:`));
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
    await expect(await botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 2');
    await expect(await botonServicios(page, 'FLIT-2002')).toHaveText('Servicios');   // cantidad 0
    await expect(await botonServicios(page, 'FLIT-2003')).toHaveText('Servicios');   // cantidad null
    await expect(await botonServicios(page, 'FLIT-2002')).toHaveAccessibleName('Servicios adicionales de FLIT-2002: ninguno');
    // El contador NO cuesta una petición: viaja en la fila del reporte.
    expect(panelPeticiones.get).toBe(0);

    await (await botonServicios(page, 'FLIT-2001')).click();
    // mutante: título sin la placa → este nombre accesible cambia
    await expect(panelServicios(page)).toHaveAttribute('aria-label', 'Servicios adicionales · FLIT-2001 · ABC123');
    // El catálogo NO se precarga al abrir el panel (§12-D5).
    expect(catalogo).toHaveLength(0);

    await page.keyboard.press('Escape');
    await expect(panelServicios(page)).toHaveCount(0);
    // mutante: quitar `useFocusTrap` / no restaurar → el foco se queda en <body>
    await expect(botonMenu(page, 'FLIT-2001')).toBeFocused();
  });

  test('AC1 — sin placa el título no deja un « · » colgando, y la ✕ también cierra y devuelve el foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado, { fila: { ...FILA_ESTIMADA, placa: null } });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await (await botonServicios(page, 'FLIT-2001')).click();

    // mutante: `[...].join(' · ')` sin filtrar nulos → «… · FLIT-2001 · »
    await expect(panelServicios(page)).toHaveAttribute('aria-label', 'Servicios adicionales · FLIT-2001');
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panelServicios(page)).toHaveCount(0);
    await expect(botonMenu(page, 'FLIT-2001')).toBeFocused();
  });

  test('AC2 — los cuatro estados: esqueleto, error con Reintentar que repite el GET, vacío y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado: EstadoPanel = { items: [], total: 0, liquidado: false, getDemoraMs: 1200 };
    await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await mockCatalogoTipos(page);
    await page.goto('/finanzas/reporte-costos');
    await (await botonServicios(page, 'FLIT-2001')).click();

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
    await (await botonServicios(page, 'FLIT-2001')).click();
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

    await (await botonServicios(page, 'FLIT-2001')).click();
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
    // Un renglón desde el rediseño: cuántos son va en el nombre accesible de la celda.
    await expect(fila.getByRole('cell', { name: /en 3 servicios adicionales/ })).toBeVisible();
    // Y el pie de totales: 890.000 + 210.000, que NO es la suma de las filas de la página.
    await expect(page.getByRole('table').first().locator('tfoot')).toContainText('$ 1.100.000');
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(await botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 3');

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
    await (await botonServicios(page, 'FLIT-2001')).click();
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
    await (await botonServicios(page, 'FLIT-2001')).click();
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
    await (await botonServicios(page, 'FLIT-2001')).click();
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
    await expect(await botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 2');
    const iniciales = reporte.length;

    await (await botonServicios(page, 'FLIT-2001')).click();
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
    await expect(await botonServicios(page, 'FLIT-2001')).toHaveText('Servicios · 1');
  });

  test('AC5 — liquidado: sin botones (no apagados) y con la instrucción de reversar para quien opera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado: EstadoPanel = { ...estadoLleno(), liquidado: true };
    await mockReporteDelPanel(page, estado, { fila: FILA_LIQUIDADA, otras: [] });
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await (await botonServicios(page, 'FLIT-2003')).click();

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
    await (await botonServicios(page, 'FLIT-2003')).click();

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
    await (await botonServicios(page, 'FLIT-2001')).click();

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

    await (await botonServicios(page, 'FLIT-2003')).click();
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toHaveCount(0);
    await panelServicios(page).getByRole('button', { name: 'Cerrar' }).click();

    await accionDeFila(page, 'FLIT-2003', 'Reversar…');
    await page.getByRole('dialog').getByLabel('Motivo del reverso').fill('Se cobró de más');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText(/reversada\./)).toBeVisible();

    // Sin F5: el panel repide y `liquidado: false` lo devuelve a editable.
    await (await botonServicios(page, 'FLIT-2003')).click();
    await expect(panelServicios(page).getByRole('button', { name: 'Añadir servicio' })).toBeVisible();
    await expect(panelServicios(page).getByRole('button', { name: 'Quitar · Diagnóstico' })).toBeVisible();
  });

  test('AC5 — carrera del sello: el 409 al quitar lo dice en línea y deja el panel de solo lectura', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = estadoLleno();
    await mockReporteDelPanel(page, estado);
    await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await (await botonServicios(page, 'FLIT-2001')).click();
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
    await (await botonServicios(page, 'FLIT-2001')).click();

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
    const menu = await abrirMenuFila(page, 'FLIT-2001');
    await expect(menu.getByRole('menuitem', { name: /^Servicios adicionales de/ })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Soporte' })).toBeVisible();
  });

  test('AC6 — la columna «Adicionales» (antes «Serv. adic.»): por defecto, tras Trámite digital, en UN renglón y sus cuatro lecturas', async ({ page }) => {
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

    // Desde el rediseño (Épica #13763, spec §3.2) va en la vista por defecto, se titula «Adicionales»
    // y pierde el segundo renglón: cuántos son pasa al nombre accesible y al «Servicios · n» del ⋮.
    const cabeceras = page.getByRole('table').first().locator('thead tr').nth(1).locator('th[scope="col"]');
    const titulos = await cabeceras.allTextContents();
    expect(titulos.indexOf('Adicionales')).toBe(titulos.indexOf('Trámite digital') + 1);

    const celdaDe = (flit: string) => page.getByRole('row').filter({ hasText: flit })
      .getByRole('cell').nth(titulos.indexOf('Adicionales') + 1);
    // Con servicios: UN renglón y el nombre accesible completo.
    await expect(celdaDe('FLIT-2001')).toHaveText('$ 125.000');
    await expect(celdaDe('FLIT-2001')).toHaveAttribute('aria-label', '$ 125.000 en 2 servicios adicionales');
    // cantidad 0 → el guion; cantidad null → «Sin dato» con su explicación. No son lo mismo.
    // mutante: `if (!valor) vacío` → FLIT-2006 perdería su cobro legítimo de cero.
    await expect(celdaDe('FLIT-2002')).toHaveText('—');
    await expect(celdaDe('FLIT-2003')).toHaveText('Sin dato');
    await expect(celdaDe('FLIT-2003').getByTitle('Se liquidó antes de que FLITO cobrara servicios adicionales.')).toBeVisible();
    // importe 0 con cantidad 2: el cero SÍ se pinta (mutante: `pesos(valor ?? 0)` pondría «$ 0» en las tres de arriba).
    await expect(celdaDe('FLIT-2006')).toHaveText('$ 0');

    // El pie trae su total, y es el del SERVIDOR: 890.000 no es la suma de las filas de la página.
    const pie = page.getByRole('table').first().locator('tfoot tr').first();
    await expect(pie.locator('td[data-pie="adicionales"]')).toHaveText('$ 890.000');
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
  opcionDeMenu(page, flit, new RegExp(`^Viajes de logística de ${flit}:`));
const panelViajes = (page: Pagina) => page.getByRole('dialog', { name: /^Viajes de logística · / });

test.describe('HU #12628 — columna «Viajes» en la ampliada y panel de solo lectura por viaje', () => {
  const cabeceras = (page: Pagina) => page.getByRole('table').first().locator('thead tr').nth(1).locator('th[scope="col"]');

  test('AC1 — «Viajes» está en «Columnas» (fuera de la vista por defecto), antes de «Total» y sin pie', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await expect(cabeceras(page)).toHaveCount(TODAS_LAS_COLUMNAS.length);
    const titulos = await cabeceras(page).allTextContents();
    // Desde el rediseño (Épica #13763, spec §3.2): Servicio y Viajes antes de Total, dentro del cobro.
    expect(titulos.indexOf('Viajes')).toBe(titulos.indexOf('Servicio') + 1);
    expect(titulos.indexOf('Total')).toBe(titulos.indexOf('Viajes') + 1);
    // mutante: `total` añadido a la entrada → el pie deja de estar vacío bajo «Viajes»
    const pie = page.getByRole('table').first().locator('tfoot tr').first();
    await expect(pie.locator('td[data-pie="viajes"]')).toHaveText('');
    await expect(pie.locator('td[data-pie="logistica"]')).not.toHaveText('');

    // mutante: `porDefecto: true` → seguiría a la vista tras restablecer
    await page.locator('summary').filter({ hasText: 'Columnas' }).click();
    await page.getByRole('button', { name: 'Restablecer columnas' }).click();
    await expect(cabeceras(page).filter({ hasText: 'Viajes' })).toHaveCount(0);
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
    await expect(await botonViajes(page, 'FLIT-2001')).toHaveText('Viajes · 3');
    await expect(await botonViajes(page, 'FLIT-2002')).toHaveText('Viajes');
    await expect(await botonViajes(page, 'FLIT-2031')).toHaveText('Viajes');
    await expect(await botonViajes(page, 'FLIT-2003')).toHaveText('Viajes');   // sellada: también lo lleva
    await expect(await botonViajes(page, 'FLIT-2001')).toHaveAccessibleName('Viajes de logística de FLIT-2001: 3 viajes');
    await expect(await botonViajes(page, 'FLIT-2002')).toHaveAccessibleName('Viajes de logística de FLIT-2002: 1 viaje');
    await expect(await botonViajes(page, 'FLIT-2031')).toHaveAccessibleName('Viajes de logística de FLIT-2031: autogestiona');
    await expect(await botonViajes(page, 'FLIT-2003')).toHaveAccessibleName('Viajes de logística de FLIT-2003: sin dato');
    // El contador NO cuesta una petición: viaja en la fila.
    expect(desglose.get).toBe(0);

    // Orden en el ⋮: Soporte → Servicios → Viajes; «Liquidar» es el botón de la fila (rediseño).
    const opciones = await (await abrirMenuFila(page, 'FLIT-2001')).getByRole('menuitem').allTextContents();
    expect(opciones.indexOf('Viajes · 3')).toBe(opciones.indexOf('Servicios · 2') + 1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: /^Liquidar/ })).toBeVisible();
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
    await expect(await botonViajes(page, 'FLIT-2001')).toBeVisible();
    await expect(await botonViajes(page, 'FLIT-2003')).toBeVisible();
    const opciones = await (await abrirMenuFila(page, 'FLIT-2001')).getByRole('menuitem').allTextContents();
    expect(opciones).not.toContain('Servicios · 2');
    expect(opciones.indexOf('Viajes · 3')).toBe(opciones.indexOf('Soporte') + 1);
    await page.keyboard.press('Escape');
    // Y sin Liquidar ni Facturar: el auditor solo consulta.
    const botones = await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button').allTextContents();
    expect(botones).not.toContain('Liquidar');

    await (await botonViajes(page, 'FLIT-2001')).click();
    await expect(panelViajes(page)).toBeVisible();
    await expect(panelViajes(page).getByText('Total logística')).toBeVisible();
  });

  test('AC4 — el panel lleno: título, origen, Viaje 1, cada viaje con su modo y motivo, y el total DEL SERVIDOR; cero acciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockReporteViajes(page);
    const desglose = await mockDesglose(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    await (await botonViajes(page, 'FLIT-2001')).click();
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

    // Por teclado, el patrón del ⋮: Enter abre en «Soporte», ↓↓ llega a «Viajes» y Enter lo elige.
    await botonMenu(page, 'FLIT-2002').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /^Viajes de logística de FLIT-2002:/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panelViajes(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(panelViajes(page).getByRole('button', { name: 'Cerrar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panelViajes(page)).toHaveCount(0);
    // mutante: devolver el foco al título → aquí cae
    await expect(botonMenu(page, 'FLIT-2002')).toBeFocused();

    await (await botonViajes(page, 'FLIT-2001')).click();
    await expect(panelViajes(page)).toBeVisible();
    await panelViajes(page).getByRole('button', { name: 'Cerrar' }).click();
    await expect(panelViajes(page)).toHaveCount(0);
    await expect(botonMenu(page, 'FLIT-2001')).toBeFocused();
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

    await (await botonViajes(page, 'FLIT-2003')).click();
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

    await (await botonViajes(page, 'FLIT-2031')).click();
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

    await (await botonViajes(page, 'FLIT-2002')).click();
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
    await (await botonViajes(page, 'FLIT-2002')).click();
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

    await (await botonViajes(page, 'FLIT-2001')).click();
    const panel = panelViajes(page);
    await expect(panel.getByRole('alert')).toHaveText('Tu usuario ya no puede ver los viajes de este trámite. Vuelve a entrar para actualizar tus permisos.');
    // mutante: Reintentar en 403
    await expect(panel.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Actualizar el reporte' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.unroute(/\/api\/finanzas\/tramites\/[^/]+\/viajes-logistica/);
    await mockDesglose(page, { status: 404, error: { error: 'Trámite no encontrado' } });
    await (await botonViajes(page, 'FLIT-2001')).click();
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

    await (await botonViajes(page, 'FLIT-2001')).click();
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

// ─────────────────────────────────────────────────────────────────────────────
// HU #12655 — Origen del valor, chips de diferencia, filtro «Con diferencias» y «Aceptar diferencia».
// Contrato: matriz TC-01…TC-21 del QA (comentario 29466735) y slim `finanzas-reporte-costos-diferencias-12655-slim.md`.
// ─────────────────────────────────────────────────────────────────────────────

const VD = (extra: Record<string, unknown> = {}) => ({
  comprobanteId: 'cccc0000-0000-0000-0000-000000000001', numero: 'FS-1023', fecha: '2026-09-12T15:00:00.000Z',
  tarifaReferencia: 80000, diferencia: 15000, aceptada: false, aceptadaPorNombre: null, aceptadaEn: null, aceptadaMotivo: null,
  ...extra,
});

/** TD del documento (+$15.000 sobre la tarifa), LG de tarifa. Sin faltantes: Liquidar sigue vivo. */
const FILA_DOCUMENTAL = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000101', idFlit: 'FLIT-2101', tramiteDigital: 95000,
  origenes: { tramiteDigital: 'documental', logistica: 'tarifa' },
  valorDocumental: { tramiteDigital: VD(), logistica: null, serviciosAdicionales: null },
};
/** Dos pendientes en la misma fila: TD +$15.000 y LG −$5.000. Dos comprobantes distintos. */
const FILA_DOS_PENDIENTES = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000102', idFlit: 'FLIT-2102', tramiteDigital: 95000, logistica: 25000,
  origenes: { tramiteDigital: 'documental', logistica: 'documental' },
  valorDocumental: {
    tramiteDigital: VD(), logistica: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000002', numero: 'FS-1024', tarifaReferencia: 30000, diferencia: -5000 }),
    serviciosAdicionales: null,
  },
};
/** LG documental con la diferencia ya aceptada (−$20.000). */
const FILA_ACEPTADA = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000103', idFlit: 'FLIT-2103', logistica: 10000,
  origenes: { tramiteDigital: 'tarifa', logistica: 'documental' },
  valorDocumental: {
    tramiteDigital: null, serviciosAdicionales: null,
    logistica: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000003', tarifaReferencia: 30000, diferencia: -20000, aceptada: true, aceptadaPorNombre: 'ana.perez', aceptadaEn: '2026-09-16T14:00:00.000Z', aceptadaMotivo: 'Factura del proveedor con IVA' }),
  },
};
/** Servicios adicionales: el catálogo suma $ 125.000 y el comprobante dijo $ 105.000. La celda sigue en el catálogo. */
const FILA_SA = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000104', idFlit: 'FLIT-2104',
  valorDocumental: { tramiteDigital: null, logistica: null, serviciosAdicionales: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000004', tarifaReferencia: 125000, diferencia: -20000 }) },
};
/** TD del documento sin tarifa configurada: la diferencia es el valor entero. */
const FILA_SIN_TARIFA = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000105', idFlit: 'FLIT-2105', tramiteDigital: 95000,
  origenes: { tramiteDigital: 'documental', logistica: 'tarifa' },
  valorDocumental: { tramiteDigital: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000005', tarifaReferencia: null, diferencia: 95000 }), logistica: null, serviciosAdicionales: null },
};
/** AC3: la compañía autogestiona la logística Y hay comprobante aplicado. La celda no lo dice. */
const FILA_AUTOGESTIONADA = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000106', idFlit: 'FLIT-2106',
  logistica: null, autogestionados: ['Logística'], totalReintegro: 653460, logisticaViajesCantidad: 0,
  origenes: { tramiteDigital: 'tarifa', logistica: null },
  valorDocumental: { tramiteDigital: null, logistica: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000006', tarifaReferencia: 30000, diferencia: 5000 }), serviciosAdicionales: null },
};
/** Documental que cuadra con la tarifa: «Documento» y nada más. */
const FILA_CUADRA = {
  ...FILA_ESTIMADA, tramiteId: 'dddd0000-0000-0000-0000-000000000107', idFlit: 'FLIT-2107', tramiteDigital: 80000,
  origenes: { tramiteDigital: 'documental', logistica: 'tarifa' },
  valorDocumental: { tramiteDigital: VD({ comprobanteId: 'cccc0000-0000-0000-0000-000000000007', diferencia: 0 }), logistica: null, serviciosAdicionales: null },
};
/** «Sin configurar» (origen null) sin chip: AC1. */
const FILA_NO_CONFIGURADA = { ...FILA_BLOQUEADA, tramiteId: 'dddd0000-0000-0000-0000-000000000108', idFlit: 'FLIT-2108', origenes: { tramiteDigital: null, logistica: 'tarifa' } };

const FILAS_DIFERENCIAS = [FILA_DOCUMENTAL, FILA_DOS_PENDIENTES, FILA_ACEPTADA, FILA_SA, FILA_SIN_TARIFA, FILA_AUTOGESTIONADA, FILA_CUADRA, FILA_NO_CONFIGURADA];

/** Los mocks de la HU: el reporte con las filas de diferencias, el consolidado, el export y el POST de aceptar. */
async function mockDiferencias(page: import('@playwright/test').Page, opciones: {
  filas?: unknown[];
  /** Qué responde el POST de aceptar, por comprobanteId; por defecto 200 `{ ok: true }`. */
  aceptar?: (comprobanteId: string, n: number) => { status: number; body?: unknown };
} = {}) {
  await mockFacetas(page, ['Aprobado']);
  await mockFacturacion(page, [], { ...RESUMEN_FE, items: [] });
  const gets: string[] = [];
  const consolidados: string[] = [];
  const aceptados: { comprobanteId: string; body: Record<string, unknown> }[] = [];
  const filas = opciones.filas ?? FILAS_DIFERENCIAS;
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    gets.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...REPORTE, items: filas, total: filas.length }) });
  });
  await page.route(/\/api\/finanzas\/reporte-costos\/consolidado\?/, (route) => {
    consolidados.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ periodo: 'mes', items: [], totales: REPORTE.totales }) });
  });
  await page.route(/\/api\/flito\/comprobantes\/([^/]+)\/diferencia\/aceptar$/, (route) => {
    const comprobanteId = route.request().url().match(/comprobantes\/([^/]+)\/diferencia/)?.[1] ?? '';
    aceptados.push({ comprobanteId, body: route.request().postDataJSON() });
    const r = opciones.aceptar?.(comprobanteId, aceptados.length) ?? { status: 200, body: { ok: true } };
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
  });
  return { gets, consolidados, aceptados };
}

const marcaDe = (page: import('@playwright/test').Page, idFlit: string) => filaDe(page, idFlit).getByTestId('marca-diferencia');
const botonAceptar = async (page: import('@playwright/test').Page, idFlit?: string) =>
  idFlit ? opcionDeMenu(page, idFlit, /^Aceptar diferencia de /) : page.getByRole('menuitem', { name: /^Aceptar diferencia de / });

test.describe('HU #12655 · diferencias documentales', () => {
  test('TC-01/TC-02 — AC1: en ampliada TD y LG llevan «Documento»/«Tarifa»; SA no lleva origen; «Sin configurar» va sin chip', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockDiferencias(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');

    const doc = filaDe(page, 'FLIT-2101');
    await expect(doc.getByText('$ 95.000')).toBeVisible();
    await expect(doc.getByText('Documento', { exact: true })).toHaveCount(1);   // mutante: invertir el mapa → 2 «Tarifa» y 0 «Documento»
    await expect(doc.getByText('Tarifa', { exact: true })).toHaveCount(1);
    // El orden: el chip «Documento» está en la celda de trámite digital, no en logística.
    const celdas = doc.getByRole('cell');
    const tdIdx = (await page.getByRole('columnheader', { name: 'Trámite digital', exact: true }).evaluate((el) => (el as HTMLTableCellElement).cellIndex));
    const lgIdx = (await page.getByRole('columnheader', { name: 'Logística', exact: true }).evaluate((el) => (el as HTMLTableCellElement).cellIndex));
    // La columna de la casilla de selección va antes: +1 en el índice de celda para financiera (puede liquidar).
    await expect(celdas.nth(tdIdx + 1)).toContainText('Documento');
    await expect(celdas.nth(lgIdx + 1)).toContainText('Tarifa');
    // Con diferencia 0 contra la tarifa: «Documento» y nada más.
    await expect(filaDe(page, 'FLIT-2107').getByText('Documento', { exact: true })).toHaveCount(1);
    await expect(marcaDe(page, 'FLIT-2107')).toHaveCount(0);
    // SA nunca lleva origen: la fila FLIT-2104 es de tarifa en TD y LG (2 chips «Tarifa») y ninguno más.
    await expect(filaDe(page, 'FLIT-2104').getByText('Tarifa', { exact: true })).toHaveCount(2);
    await expect(filaDe(page, 'FLIT-2104').getByText('Documento', { exact: true })).toHaveCount(0);
    // «Sin configurar» (antes «No configurado», Épica #13763) y sin chip de origen en TD (solo el «Tarifa» de LG).
    const noConf = filaDe(page, 'FLIT-2108');
    await expect(noConf.getByText('Sin configurar').first()).toBeVisible();
    await expect(noConf.getByText('Tarifa', { exact: true })).toHaveCount(1);
    await expect(noConf.getByText('Documento', { exact: true })).toHaveCount(0);
  });

  test('TC-03/TC-04/TC-05/TC-06 — AC2: chips con importe y signo; aceptada en neutro con quién/cuándo/motivo; SA sigue en el catálogo; sin tarifa', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockDiferencias(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');

    // Pendiente contra tarifa: importe documental + chip warning con signo.
    const pendiente = marcaDe(page, 'FLIT-2101');
    await expect(pendiente).toHaveCount(1);
    await expect(pendiente).toHaveText('Difiere de tarifa +$15.000');
    await expect(pendiente).toHaveAttribute('role', 'note');
    // `\s`: el separador de `es-CO` entre «$» y la cifra es un espacio duro.
    await expect(pendiente).toHaveAttribute('aria-label', /^Trámite digital: el comprobante dice \$\s95\.000 y la tarifa \$\s80\.000\. Diferencia \+\$15\.000\. Sin aceptar\.$/);

    // Aceptada: signo negativo conservado (mutante: Math.abs), tono neutro, constancia en el nombre accesible.
    const aceptada = marcaDe(page, 'FLIT-2103');
    await expect(aceptada).toHaveText('Diferencia aceptada −$20.000');
    await expect(aceptada).toHaveAttribute('aria-label', /aceptada por ana\.perez el 16 sep 2026: «Factura del proveedor con IVA»/);
    // Tonos del kit: warning (pendiente) vs neutral (aceptada); el fondo del chip es el que los distingue.
    await expect(pendiente.locator('span').first()).toHaveCSS('background-color', 'rgb(253, 240, 224)'); // --flit-chip-warning-bg: crema, no rosa (Épica #13763)
    await expect(aceptada.locator('span').first()).toHaveCSS('background-color', 'rgb(239, 241, 243)');
    // La aceptada NO ofrece el botón, aunque financiera tenga la función.
    await expect(await botonAceptar(page, 'FLIT-2103')).toHaveCount(0);

    // SA: el importe de la celda SIGUE siendo el catálogo (mutante: pintar el documental).
    const sa = filaDe(page, 'FLIT-2104');
    await expect(sa.getByText('$ 125.000')).toBeVisible();
    await expect(sa.getByText('$ 105.000')).toHaveCount(0);
    await expect(marcaDe(page, 'FLIT-2104')).toHaveText('Difiere del catálogo −$20.000');
    await expect(marcaDe(page, 'FLIT-2104')).toHaveAttribute('aria-label', /el catálogo suma \$\s125\.000\. Diferencia −\$20\.000\. Sin aceptar\. El costo usa el valor del comprobante; el catálogo queda como referencia\./);

    // Sin tarifa: rótulo sin importe (mutante: «Sin tarifa +$95.000»); el importe de la celda es el documental.
    const sinTarifa = filaDe(page, 'FLIT-2105');
    await expect(sinTarifa.getByText('$ 95.000')).toBeVisible();
    await expect(marcaDe(page, 'FLIT-2105')).toHaveText('Sin tarifa configurada');
    await expect(marcaDe(page, 'FLIT-2105')).toHaveAttribute('aria-label', /no hay tarifa configurada\. Diferencia \+\$95\.000\. Sin aceptar\./);
  });

  test('TC-07 — la marca se alcanza con Tab, revela el globo, y Esc lo cierra sin mover el foco', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockDiferencias(page, { filas: [FILA_DOCUMENTAL] });
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    const marca = marcaDe(page, 'FLIT-2101');
    await expect(marca).toHaveAttribute('tabindex', '0');           // mutante: quitar tabIndex
    const globo = 'Comprobante $ 95.000 · Tarifa $ 80.000 · N.º FS-1023 · 12 sep 2026';
    await expect(page.getByText(globo)).toHaveCount(0);
    await marca.focus();
    await expect(marca).toBeFocused();
    await expect(page.getByText(globo)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(globo)).toHaveCount(0);
    await expect(marca).toBeFocused();
    await marca.hover();
    await expect(page.getByText(globo)).toBeVisible();
  });

  test('TC-08 — AC3: la fila autogestionada con comprobante se ve exactamente como hoy, sin chips ni botón', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockDiferencias(page, { filas: [FILA_AUTOGESTIONADA] });
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    const fila = filaDe(page, 'FLIT-2106');
    await expect(fila.getByText('Autogestiona')).toBeVisible();
    await expect(fila.getByText('Documento', { exact: true })).toHaveCount(0);
    await expect(marcaDe(page, 'FLIT-2106')).toHaveCount(0);          // mutante 9: decidir por valorDocumental
    await expect(await botonAceptar(page, 'FLIT-2106')).toHaveCount(0);
    await expect(page.getByText(/Difiere|Diferencia aceptada/)).toHaveCount(0);
    // Solo el «Tarifa» del trámite digital.
    await expect(fila.getByText('Tarifa', { exact: true })).toHaveCount(1);
  });

  test('TC-09 — el ⋮ lleva «Aceptar diferencia» en la fila con diferencia pendiente, con su nombre y sus importes', async ({ page }) => {
    // Desde el rediseño (Épica #13763) «Aceptar diferencia» es una opción del ⋮, no un botón de la fila.
    await loginAs(page, FINANCIERA_USER);
    await mockDiferencias(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2101')).toBeVisible();
    await expect(await botonAceptar(page, 'FLIT-2101')).toHaveCount(1);
    await expect(await botonAceptar(page, 'FLIT-2101')).toContainText('Aceptar diferencia');
    await expect(await botonAceptar(page, 'FLIT-2101')).toHaveAccessibleName('Aceptar diferencia de trámite digital de FLIT-2101');
    await expect(await botonAceptar(page, 'FLIT-2102')).toHaveAccessibleName('Aceptar diferencia de trámite digital y logística de FLIT-2102');
    // Los importes, visibles bajo la opción (antes iban en el `title` del botón).
    await expect(await botonAceptar(page, 'FLIT-2102')).toContainText('Trámite digital +$15.000 · Logística −$5.000');
    // Uno por fila con pendiente: 2101, 2102, 2104 (catálogo) y 2105 (sin tarifa). Ni 2103 (aceptada) ni 2106/2107/2108.
    for (const id of ['FLIT-2104', 'FLIT-2105']) await expect(await botonAceptar(page, id)).toHaveCount(1);
    for (const id of ['FLIT-2103', 'FLIT-2106', 'FLIT-2107', 'FLIT-2108']) await expect(await botonAceptar(page, id)).toHaveCount(0);
    // Tras «Viajes» en el ⋮; y Liquidar no cambia por tener diferencias.
    const opciones = await (await abrirMenuFila(page, 'FLIT-2101')).getByRole('menuitem').allTextContents();
    expect(opciones.slice(0, 3)).toEqual(['Soporte', 'Servicios · 2', 'Viajes · 3']);
    expect(opciones[3]).toContain('Aceptar diferencia');
    await page.keyboard.press('Escape');
    await expect(filaDe(page, 'FLIT-2101').getByRole('button', { name: 'Liquidar' })).toBeEnabled();
  });

  test('TC-10/TC-11 — AC4: «Con diferencias» viaja como conDiferencias=si al GET, al consolidado y al export; la URL lo conserva; Limpiar lo apaga', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const { gets, consolidados } = await mockDiferencias(page);
    const exportadas = await mockExport(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2101')).toBeVisible();
    await abrirMasFiltros(page);

    const casilla = page.getByRole('checkbox', { name: 'Con diferencias' });
    await expect(casilla).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
    expect(gets[gets.length - 1]).not.toContain('conDiferencias');
    await expect(page.getByText('Con diferencias', { exact: true })).toHaveAttribute('title', 'Solo trámites con al menos una diferencia sin aceptar.');

    await casilla.check();
    await expect.poll(() => gets[gets.length - 1]).toContain('conDiferencias=si');     // mutante: `=1` / `=true` / fuera de cuerpoDeExport
    expect(gets[gets.length - 1]).not.toMatch(/conDiferencias=(1|true)/);
    await expect(page).toHaveURL(/conDiferencias=si/);
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();   // mutante: fuera de claveDe

    // El export del detalle lleva el booleano en el cuerpo.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.getByRole('button', { name: 'Exportar a Excel' }).click();
    await expect.poll(() => exportadas.length).toBe(1);
    expect(exportadas[0].postDataJSON()).toMatchObject({ conDiferencias: true, estados: ['Aprobado'] });

    // El consolidado, con los mismos criterios.
    await page.getByRole('button', { name: 'Consolidado' }).click();
    await expect.poll(() => consolidados.length).toBeGreaterThan(0);
    expect(consolidados[consolidados.length - 1]).toContain('conDiferencias=si');
    await page.getByRole('button', { name: 'Detalle' }).click();

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await abrirMasFiltros(page);
    await expect(casilla).not.toBeChecked();
    await expect(page).not.toHaveURL(/conDiferencias/);
    await expect.poll(() => gets[gets.length - 1]).not.toContain('conDiferencias');
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
  });

  test('TC-12 — AC4: la casilla desde la URL abre marcada, y con 0 filas el vacío dice qué desmarcar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const { gets } = await mockDiferencias(page, { filas: [] });
    await page.goto('/finanzas/reporte-costos?conDiferencias=si');
    await abrirMasFiltros(page);
    await expect(page.getByRole('checkbox', { name: 'Con diferencias' })).toBeChecked();
    await expect.poll(() => gets[0]).toContain('conDiferencias=si');
    await expect(page.getByText('No hay trámites con diferencias sin aceptar en este filtro. Desmarca «Con diferencias» o amplía el periodo.')).toBeVisible();
    await expect(page.getByText(/No hay trámites que coincidan con los filtros/)).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Con diferencias' }).uncheck();
    await expect(page.getByText(/No hay trámites que coincidan con los filtros/)).toBeVisible();
  });

  test('TC-13/TC-14/TC-15 — AC5: el modal exige motivo (5 caracteres), no dispara POST con menos, y al 200 avisa, refresca y devuelve el foco al título', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const { gets, aceptados } = await mockDiferencias(page, { filas: [FILA_DOCUMENTAL, FILA_ESTIMADA] });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-2101')).toBeVisible();
    // La selección de liquidación tiene que SEGUIR tras aceptar (refrescar, no ejecutar).
    await page.getByRole('checkbox', { name: 'Seleccionar FLIT-2001' }).check();
    const getsAntes = gets.length;

    await (await botonAceptar(page, 'FLIT-2101')).click();
    const modal = page.getByRole('dialog', { name: 'Aceptar diferencia · FLIT-2101 · ABC123' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Trámite digital', { exact: true })).toBeVisible();
    await expect(modal.getByText('Comprobante $ 95.000 · Tarifa $ 80.000')).toBeVisible();
    await expect(modal.getByText('+$15.000')).toBeVisible();
    await expect(modal.getByText('N.º FS-1023 · 12 sep 2026')).toBeVisible();
    // Una sola pendiente: sin casillas.
    await expect(modal.getByRole('checkbox')).toHaveCount(0);

    const motivo = modal.getByLabel('Por qué se acepta (obligatorio)');
    await expect(motivo).toBeFocused();
    const confirmar = modal.getByRole('button', { name: 'Aceptar diferencia', exact: true });
    await expect(confirmar).toBeDisabled();
    await expect(modal.getByRole('status')).toHaveText('Escribe el motivo para poder aceptar.');
    await motivo.fill('abc');
    await expect(confirmar).toBeDisabled();                           // mutante: mínimo < 5
    await expect(modal.getByText('3/500')).toBeVisible();
    await expect(modal.getByRole('status')).toHaveText('Escribe el motivo para poder aceptar.');
    await page.keyboard.press('Enter');
    expect(aceptados).toHaveLength(0);                                // mutante: POST con motivo vacío/corto
    await motivo.fill('Factura del proveedor con IVA');
    await expect(modal.getByRole('status')).toHaveText('Motivo listo: ya se puede aceptar.');
    await expect(confirmar).toBeEnabled();

    await confirmar.click();
    await expect(modal).toHaveCount(0);
    expect(aceptados).toHaveLength(1);
    expect(aceptados[0].comprobanteId).toBe('cccc0000-0000-0000-0000-000000000001');
    expect(aceptados[0].body).toEqual({ motivo: 'Factura del proveedor con IVA' });
    await expect(page.getByText('Diferencia de trámite digital de FLIT-2101 aceptada.')).toBeVisible();
    await expect.poll(() => gets.length).toBeGreaterThan(getsAntes);   // mutante: no refrescar
    await expect(page.getByRole('checkbox', { name: 'Seleccionar FLIT-2001' })).toBeChecked(); // mutante: ejecutar() vacía la selección
    // Este mock devuelve la misma fila al refrescar, así que el botón sigue y el foco vuelve a él
    // (el kit restaura al disparador). Cuando el botón desaparece, el foco va al título: TC-16.
    await expect(botonMenu(page, 'FLIT-2101')).toBeFocused();
  });

  test('TC-16 — AC5: la celda pasa a «Diferencia aceptada» con el importe aún visible tras recargar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let aceptada = false;
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page, [], { ...RESUMEN_FE, items: [] });
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
      const fila = aceptada
        ? { ...FILA_DOCUMENTAL, valorDocumental: { ...FILA_DOCUMENTAL.valorDocumental, tramiteDigital: VD({ aceptada: true, aceptadaPorNombre: 'e2e_financiera', aceptadaEn: '2026-09-17T12:00:00.000Z', aceptadaMotivo: 'Factura con IVA' }) } }
        : FILA_DOCUMENTAL;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...REPORTE, items: [fila], total: 1 }) });
    });
    await page.route(/\/diferencia\/aceptar$/, (route) => { aceptada = true; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(marcaDe(page, 'FLIT-2101')).toHaveText('Difiere de tarifa +$15.000');
    await (await botonAceptar(page, 'FLIT-2101')).click();
    await page.getByLabel('Por qué se acepta (obligatorio)').fill('Factura con IVA');
    await page.getByRole('dialog').getByRole('button', { name: 'Aceptar diferencia', exact: true }).click();
    await expect(marcaDe(page, 'FLIT-2101')).toHaveText('Diferencia aceptada +$15.000');
    await expect(filaDe(page, 'FLIT-2101').getByText('$ 95.000')).toBeVisible();
    // Desde el rediseño el disparador es el ⋮, que sigue en la fila: el foco vuelve a él, no a `<body>`.
    await expect(botonMenu(page, 'FLIT-2101')).toBeFocused();
    await expect(await botonAceptar(page, 'FLIT-2101')).toHaveCount(0);      // mutante: opción visible tras aceptar
  });

  test('TC-17 — AC5: 409 sin_diferencia / 403 / 400 se pintan con errorMessage en el modal y la fila no cambia', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const respuestas = [
      { status: 409, body: { error: 'La diferencia ya fue aceptada', codigo: 'sin_diferencia' } },
      { status: 403, body: { error: 'Sin permiso para aceptar diferencias' } },
      { status: 400, body: { error: 'El motivo va entre 5 y 500 caracteres' } },
    ];
    let i = 0;
    const { aceptados } = await mockDiferencias(page, { filas: [FILA_DOCUMENTAL, FILA_SIN_TARIFA, FILA_SA], aceptar: () => respuestas[i++] });
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');

    // 409: mensaje del servidor + «La fila se actualizó.»; el modal sigue abierto; la fila no cambia.
    await (await botonAceptar(page, 'FLIT-2101')).click();
    let modal = page.getByRole('dialog');
    await modal.getByLabel('Por qué se acepta (obligatorio)').fill('Motivo válido');
    await modal.getByRole('button', { name: 'Aceptar diferencia', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('La diferencia ya fue aceptada La fila se actualizó.');
    await expect(modal.getByRole('status')).toHaveText('No queda nada por aceptar. Cierra el diálogo.');
    await expect(modal.getByRole('button', { name: 'Aceptar diferencia', exact: true })).toBeDisabled();
    await expect(marcaDe(page, 'FLIT-2101')).toHaveText('Difiere de tarifa +$15.000');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toHaveCount(0);

    // 403: sufijo de permisos y la primaria apagada.
    await (await botonAceptar(page, 'FLIT-2105')).click();
    modal = page.getByRole('dialog');
    await expect(modal.getByText('Comprobante $ 95.000 · Sin tarifa configurada')).toBeVisible();
    await modal.getByLabel('Por qué se acepta (obligatorio)').fill('Motivo válido');
    await modal.getByRole('button', { name: 'Aceptar diferencia', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('Sin permiso para aceptar diferencias Vuelve a entrar para actualizar tus permisos.');
    await expect(modal.getByRole('button', { name: 'Aceptar diferencia', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancelar' }).click();

    // 400: el mensaje tal cual y la primaria sigue viva; lo escrito se conserva.
    await (await botonAceptar(page, 'FLIT-2104')).click();
    modal = page.getByRole('dialog');
    await expect(modal.getByText('Comprobante $ 105.000 · Catálogo $ 125.000')).toBeVisible();
    await expect(modal.getByText(/El costo usa el valor del comprobante; el catálogo queda como referencia\./)).toBeVisible();
    await modal.getByLabel('Por qué se acepta (obligatorio)').fill('Motivo válido');
    await modal.getByRole('button', { name: 'Aceptar diferencia', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('El motivo va entre 5 y 500 caracteres');
    await expect(modal.getByRole('button', { name: 'Aceptar diferencia', exact: true })).toBeEnabled();
    await expect(modal.getByLabel('Por qué se acepta (obligatorio)')).toHaveValue('Motivo válido');
    expect(aceptados).toHaveLength(3);
    await expect(page.getByText(/aceptada\.$/)).toHaveCount(0);
  });

  test('TC-18 — AC5: dos pendientes en la fila = casillas, un motivo y dos POST en secuencia; la segunda en 409 deja el modal abierto', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const { aceptados } = await mockDiferencias(page, {
      filas: [FILA_DOS_PENDIENTES],
      aceptar: (id) => id.endsWith('0002') ? { status: 409, body: { error: 'La diferencia ya fue aceptada', codigo: 'sin_diferencia' } } : { status: 200, body: { ok: true } },
    });
    await page.goto('/finanzas/reporte-costos');
    await (await botonAceptar(page, 'FLIT-2102')).click();
    const modal = page.getByRole('dialog', { name: 'Aceptar diferencia · FLIT-2102 · ABC123' });
    const casillas = modal.getByRole('checkbox');
    await expect(casillas).toHaveCount(2);
    await expect(casillas.nth(0)).toBeChecked();
    await expect(casillas.nth(1)).toBeChecked();
    await expect(modal.getByText('Comprobante $ 25.000 · Tarifa $ 30.000')).toBeVisible();
    await expect(modal.getByText('−$5.000')).toBeVisible();

    const motivo = modal.getByLabel('Por qué se acepta (obligatorio)');
    await motivo.fill('Factura con IVA');
    const confirmar = modal.getByRole('button', { name: 'Aceptar diferencia', exact: true });
    // Ninguna marcada: la primaria se apaga y el estado lo explica.
    await casillas.nth(0).uncheck();
    await casillas.nth(1).uncheck();
    await expect(confirmar).toBeDisabled();
    await expect(modal.getByRole('status')).toHaveText('Marca al menos una diferencia para poder aceptar.');
    await casillas.nth(0).check();
    await casillas.nth(1).check();
    await confirmar.click();

    // Dos POST, en orden, con el MISMO motivo; el segundo cae en 409.
    await expect.poll(() => aceptados.length).toBe(2);
    expect(aceptados.map((a) => a.comprobanteId)).toEqual(['cccc0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002']);
    expect(aceptados.every((a) => a.body.motivo === 'Factura con IVA')).toBe(true);
    // El modal NO cierra: la primera pasa a «Aceptada» sin casilla y la segunda lleva su error.
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Aceptada', { exact: true })).toHaveCount(2);
    await expect(modal.getByRole('checkbox')).toHaveCount(0);
    await expect(modal.getByRole('alert')).toHaveText('La diferencia ya fue aceptada La fila se actualizó.');
    await expect(modal.getByRole('status')).toHaveText('No queda nada por aceptar. Cierra el diálogo.');
  });

  test('TC-19 — AC5: dos pendientes en 200 y 200 = un aviso en plural', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const { aceptados } = await mockDiferencias(page, { filas: [FILA_DOS_PENDIENTES] });
    await page.goto('/finanzas/reporte-costos');
    await (await botonAceptar(page, 'FLIT-2102')).click();
    await page.getByLabel('Por qué se acepta (obligatorio)').fill('Factura con IVA');
    await page.getByRole('dialog').getByRole('button', { name: 'Aceptar diferencia', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(aceptados).toHaveLength(2);
    await expect(page.getByText('Diferencias de trámite digital y logística de FLIT-2102 aceptadas.')).toBeVisible();
  });

  test('TC-20 — AC5: sin la función el chip es informativo, la casilla se usa y no hay botón (financiera sin la función y auditor)', async ({ page }) => {
    const sinLaFuncion = funcionesDe(FINANCIERA_USER).filter((f) => f !== 'comprobantes.diferencia.aceptar');
    await loginAs(page, FINANCIERA_USER, { funciones: sinLaFuncion });
    const { aceptados, gets } = await mockDiferencias(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(marcaDe(page, 'FLIT-2101')).toHaveText('Difiere de tarifa +$15.000');
    // mutante: pintar sin hasFuncion → la opción saldría en el ⋮ de las filas con pendiente.
    for (const id of ['FLIT-2101', 'FLIT-2102']) await expect(await botonAceptar(page, id)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Aceptar diferencia' })).toHaveCount(0);
    // Liquidar sigue igual.
    await expect(filaDe(page, 'FLIT-2101').getByRole('button', { name: 'Liquidar' })).toBeEnabled();
    await abrirMasFiltros(page);
    await page.getByRole('checkbox', { name: 'Con diferencias' }).check();
    await expect.poll(() => gets[gets.length - 1]).toContain('conDiferencias=si');
    expect(aceptados).toHaveLength(0);
  });

  test('TC-21 — auditor: chips visibles en ampliada, casilla usable, cero botones «Aceptar diferencia»', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    const { gets } = await mockDiferencias(page);
    await ampliarColumnas(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(marcaDe(page, 'FLIT-2103')).toHaveText('Diferencia aceptada −$20.000');
    await expect(filaDe(page, 'FLIT-2101').getByText('Documento', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Aceptar diferencia/ })).toHaveCount(0);
    for (const id of ['FLIT-2101', 'FLIT-2102']) await expect(await botonAceptar(page, id)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await abrirMasFiltros(page);
    await page.getByRole('checkbox', { name: 'Con diferencias' }).check();
    await expect.poll(() => gets[gets.length - 1]).toContain('conDiferencias=si');
  });
});

// ═══════════════ Bug #12913 — la asignación que escribió un comprobante de pago ═══════════════
test.describe('Bug #12913 · panel de servicios — asignación «Desde comprobante»', () => {
  /** Mutantes: chip por `origen !== 'manual'` o sin chip (la manual lo pintaría / la de comprobante no); copy crudo del 409. */
  test('la asignación de comprobante lleva el chip neutral y quitarla da el 409 con copy pulido', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const deComprobante = { ...ASIGNADO_DIAGNOSTICO, origen: 'comprobante' as const };
    const manual = { ...ASIGNADO_PETICION, origen: 'manual' as const };
    const estado: EstadoPanel = {
      items: [deComprobante, manual], total: 125000, liquidado: false,
      borrarStatus: 409, borrarCuerpo: { error: 'asignacion_de_comprobante', codigo: 'ASIGNACION_DE_COMPROBANTE' },
    };
    await mockReporteDelPanel(page, estado);
    const peticiones = await mockPanelServicios(page, estado);
    await page.goto('/finanzas/reporte-costos');
    await (await botonServicios(page, 'FLIT-2001')).click();
    const panel = panelServicios(page);
    await expect(panel.getByText('Diagnóstico', { exact: true })).toBeVisible();

    const filaComprobante = panel.locator('li', { has: page.getByText('Diagnóstico', { exact: true }) });
    await expect(filaComprobante.getByText('Desde comprobante')).toBeVisible();
    await expect(filaComprobante.locator('[title="Asignado al aplicar un comprobante de pago"]')).toHaveCount(1);
    await expect(panel.getByText('Desde comprobante')).toHaveCount(1);

    await panel.getByRole('button', { name: 'Quitar · Diagnóstico' }).click();
    await panel.getByRole('button', { name: 'Quitar', exact: true }).click();
    await expect.poll(() => peticiones.borrar).toBe(1);
    await expect(panel.getByRole('alert')).toContainText('Este servicio viene de un comprobante de pago aplicado; no se puede quitar desde el panel.');
    await expect(panel.getByRole('alert')).not.toContainText('ASIGNACION_DE_COMPROBANTE');
    // La fila sigue: el 409 dice la verdad sobre lo que hay.
    await expect(panel.getByText('Diagnóstico', { exact: true })).toBeVisible();
  });
});

// ── Rediseño «Esencial + desglose» y costo de proveedor (Épica #13763) ───────────────────────────
// Spec `docs/ux/flito-reporte-costos-rediseno.md` y sus retoques del humano al aprobar la maqueta:
// sin recortar empresa ni proveedor, «Exportar a Excel» en la cabecera, «Liquidación» vacía sin
// liquidar y ninguna etiqueta pegada al importe.

const EMPRESA_LARGA = 'Compañía Demo Uno de Transporte Especial y Logística Integral S.A.S.';
const PROVEEDOR_LARGO = 'Transportes Demo Norte Operadora Logística del Valle de Aburrá Ltda.';

/** Una fila por estado de costo (C1–C6) y una con nombres largos. */
const FILAS_COSTO = [
  { ...FILA_LIQUIDADA, tramiteId: 'cccc0000-0000-0000-0000-000000000001', idFlit: 'FLIT-3001' },
  {
    ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000002', idFlit: 'FLIT-3002',
    empresa: EMPRESA_LARGA,
    costoProveedorLogistica: costo(PROVEEDOR_LARGO, 35000),
  },
  {
    ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000003', idFlit: 'FLIT-3003',
    costoProveedorSoat: costo('Seguros Demo', null, 'sin_configurar'), costoProveedorTotal: 35000,
  },
  {
    ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000004', idFlit: 'FLIT-3004',
    costoProveedorLogistica: costo(null, null, 'sin_proveedor'), costoProveedorTotal: 48000,
  },
  {
    ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000005', idFlit: 'FLIT-3005',
    costoProveedorSoat: costo(null, null, 'gestionado_operaciones'), costoProveedorTotal: 35000,
  },
  {
    ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000006', idFlit: 'FLIT-3006',
    costoProveedorSoat: costo(null, null, 'ya_contado', { contadoEnTramiteId: 'x', contadoEnIdFlit: '10234' }), costoProveedorTotal: 35000,
  },
  {
    ...FILA_FACTURADA, tramiteId: 'cccc0000-0000-0000-0000-000000000007', idFlit: 'FLIT-3007',
    costoProveedorSoat: costo('Seguros Demo', 48000, 'estimado'),
  },
];
const REPORTE_COSTO = { ...REPORTE, items: FILAS_COSTO, total: FILAS_COSTO.length };

async function mockRediseno(page: import('@playwright/test').Page, reporte: unknown = REPORTE_COSTO) {
  const urls: string[] = [];
  await mockFacetas(page, ['Aprobado', 'Entregado']);
  await mockFacturacion(page);
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    urls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reporte) });
  });
  return urls;
}

const filaRc = (page: import('@playwright/test').Page, idFlit: string) =>
  page.getByRole('row').filter({ hasText: idFlit });
/** La celda de la columna `titulo` en la fila: por índice de cabecera, no por texto. */
async function celda(page: import('@playwright/test').Page, idFlit: string, titulo: string) {
  await expect(filaRc(page, idFlit)).toBeVisible();
  const titulos = await page.getByRole('region', { name: 'Reporte de costos, detalle' }).getByRole('table')
    .locator('thead tr').nth(1).locator('th').allTextContents();
  const i = titulos.findIndex((t) => t.trim() === titulo);
  expect(i, `columna «${titulo}»`).toBeGreaterThanOrEqual(0);
  // El cuerpo lleva la casilla delante cuando se puede liquidar: la cabecera la tiene en la fila de grupos.
  const conCasilla = await page.getByRole('checkbox', { name: 'Seleccionar los trámites con acciones de esta página' }).count();
  return filaRc(page, idFlit).locator('td').nth(i + conCasilla);
}

test.describe('Reporte de costos — rediseño y costo de proveedor (Épica #13763)', () => {
  test('por defecto: Esencial, Cobro al cliente y Costo de proveedor; sin Total reintegro ni Servicio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');

    const tabla = page.getByRole('region', { name: 'Reporte de costos, detalle' }).getByRole('table');
    await expect(tabla.locator('thead tr').nth(1).locator('th')).toHaveText([
      'Trámite', 'Placa', 'Empresa', 'Tipo', 'Aprobación', 'Liquidación', 'Falta',
      'SOAT', 'Impuesto', 'Derecho', 'Logística', 'Trámite digital', 'Adicionales', 'GMF', 'Total',
      'Costo SOAT', 'Proveedor SOAT', 'Costo logística', 'Proveedor logística', 'Total costos',
    ]);
    await expect(tabla.locator('th[scope="colgroup"]')).toHaveText(['Esencial', 'Cobro al cliente', 'Costo de proveedor']);
    await expect(tabla.locator('th[scope="colgroup"]', { hasText: 'Costo de proveedor' }))
      .toHaveAttribute('title', 'Lo que FLITO le paga al proveedor. No se suma al cobro.');
    await expect(tabla.getByRole('columnheader', { name: 'Total reintegro' })).toHaveCount(0);
    await expect(tabla.getByRole('columnheader', { name: 'Servicio', exact: true })).toHaveCount(0);
  });

  test('«Columnas» añade, recuerda en la clave v2 tras recargar y restablece; la clave vieja se ignora', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.addInitScript(() => {
      // La preferencia de antes del rediseño no amplía nada.
      if (!sessionStorage.getItem('sembrado')) { localStorage.setItem('flito.reporteCostos.columnas', 'todas'); sessionStorage.setItem('sembrado', '1'); }
    });
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    const tabla = page.getByRole('region', { name: 'Reporte de costos, detalle' }).getByRole('table');
    await expect(tabla.getByRole('columnheader', { name: 'VIN' })).toHaveCount(0);

    await page.locator('summary').filter({ hasText: 'Columnas' }).click();
    await page.getByRole('checkbox', { name: 'Total reintegro' }).check();
    await expect(tabla.getByRole('columnheader', { name: 'Total reintegro' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Columnas: \d+ de 37 visibles\./ })).toHaveCount(1);
    // Trámite y Placa no se pueden ocultar: no tienen casilla.
    await expect(page.getByRole('checkbox', { name: 'Trámite', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('flito.reporteCostos.columnas.v2'))).toContain('totalReintegro');

    await page.reload();
    await expect(tabla.getByRole('columnheader', { name: 'Total reintegro' })).toBeVisible();

    await page.locator('summary').filter({ hasText: 'Columnas' }).click();
    await page.getByRole('button', { name: 'Restablecer columnas' }).click();
    await expect(tabla.getByRole('columnheader', { name: 'Total reintegro' })).toHaveCount(0);
  });

  test('cada estado de costo se pinta con su texto, sin «estimado» ni «parcial» junto al valor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');

    await expect(await celda(page, 'FLIT-3001', 'Costo SOAT')).toHaveText('$ 48.000');
    await expect(await celda(page, 'FLIT-3001', 'Proveedor SOAT')).toHaveText('Seguros Demo');
    await expect(await celda(page, 'FLIT-3003', 'Costo SOAT')).toHaveText('Sin configurar');
    await expect(await celda(page, 'FLIT-3004', 'Costo logística')).toHaveText('Sin proveedor');
    await expect(await celda(page, 'FLIT-3004', 'Proveedor logística')).toHaveText('—');
    await expect(await celda(page, 'FLIT-3005', 'Costo SOAT')).toHaveText('Gestionado por Operaciones');
    await expect(await celda(page, 'FLIT-3006', 'Costo SOAT')).toHaveText('Ya contado en el trámite 10234');

    // Estimado (sello sin el concepto congelado) y total parcial: SOLO el valor en la celda…
    const estimado = await celda(page, 'FLIT-3007', 'Costo SOAT');
    await expect(estimado).toHaveText('$ 48.000');
    await expect(estimado).toHaveAttribute('aria-label', /estimado: el trámite se liquidó antes/);
    const parcial = await celda(page, 'FLIT-3003', 'Total costos');
    await expect(parcial).toHaveText('$ 35.000');
    // …y el matiz en el nombre accesible, donde no se suma con la vista.
    await expect(parcial).toHaveAttribute('aria-label', /parcial: falta el costo SOAT \(sin configurar\)/);
    // Ninguna celda del cuerpo dice «estimado» o «parcial» a la vista.
    await expect(page.getByRole('region', { name: 'Reporte de costos, detalle' }).getByRole('table').locator('tbody')).not.toContainText(/estimado|parcial/i);
  });

  test('«Sin proveedor» se explica según el concepto: el SOAT no habla de una entrega', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const filas = [
      ...FILAS_COSTO,
      {
        ...FILA_ESTIMADA, tramiteId: 'cccc0000-0000-0000-0000-000000000008', idFlit: 'FLIT-3008',
        costoProveedorSoat: costo(null, null, 'sin_proveedor'), costoProveedorTotal: 35000,
      },
    ];
    await mockRediseno(page, { ...REPORTE, items: filas, total: filas.length });
    await page.goto('/finanzas/reporte-costos');

    const soat = await celda(page, 'FLIT-3008', 'Costo SOAT');
    await expect(soat).toHaveText('Sin proveedor');
    await expect(soat).toHaveAttribute('aria-label', /El SOAT de este trámite no pasó por un proveedor de FLITO\./);
    await expect(soat).toHaveAttribute('title', /El SOAT de este trámite no pasó por un proveedor de FLITO\./);
    await expect(soat).not.toHaveAttribute('aria-label', /entrega/);   // mutante: la frase de logística para los dos
    await expect(soat).not.toHaveAttribute('title', /entrega/);

    const logistica = await celda(page, 'FLIT-3004', 'Costo logística');
    await expect(logistica).toHaveText('Sin proveedor');
    await expect(logistica).toHaveAttribute('aria-label', /no tuvo entrega con proveedor/);
    await expect(logistica).not.toHaveAttribute('aria-label', /SOAT/);
  });

  test('«Liquidación» queda vacía sin liquidar, y dice Liquidado o Facturado cuando lo está', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(await celda(page, 'FLIT-3002', 'Liquidación')).toHaveText('');
    await expect(await celda(page, 'FLIT-3001', 'Liquidación')).toHaveText('Liquidado');
    await expect(await celda(page, 'FLIT-3007', 'Liquidación')).toHaveText('Facturado');
    await expect(page.getByRole('region', { name: 'Reporte de costos, detalle' }).getByRole('table').getByText('Estimado', { exact: true })).toHaveCount(0);
  });

  test('empresa y proveedor largos se leen enteros, sin recorte', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    for (const [titulo, texto] of [['Empresa', EMPRESA_LARGA], ['Proveedor logística', PROVEEDOR_LARGO]] as const) {
      const c = await celda(page, 'FLIT-3002', titulo);
      await expect(c).toHaveText(texto);
      // Sin elipsis: el contenido no desborda su caja.
      expect(await c.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await c.evaluate((el) => !!el.querySelector('.truncate'))).toBe(false);
    }
  });

  test('«Exportar a Excel» está en la cabecera, junto a Detalle/Consolidado, y no en la barra de la tabla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    const exportar = page.locator('#exportar-excel');
    await expect(exportar).toHaveText('Exportar a Excel');
    await expect(exportar).toHaveAttribute('title', 'Todo el filtro con todas sus columnas, no solo esta página.');
    const cajaExport = await exportar.boundingBox();
    const cajaConmutador = await page.getByRole('button', { name: 'Consolidado' }).boundingBox();
    const cajaFiltros = await page.getByRole('button', { name: /Listos para liquidar/ }).boundingBox();
    // En la misma banda que el conmutador y por encima de los filtros.
    expect(Math.abs((cajaExport?.y ?? 0) - (cajaConmutador?.y ?? 0))).toBeLessThan(30);
    expect(cajaExport!.y).toBeLessThan(cajaFiltros!.y);
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toHaveCount(1);
  });

  test('«Más filtros» con «Costo de proveedor sin configurar»: cuenta, chip, query `=true` y cuerpo del export', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls = await mockRediseno(page);
    const peticiones = await mockExport(page);
    await page.goto('/finanzas/reporte-costos');

    await page.locator('summary').filter({ hasText: 'Más filtros' }).click();
    const casilla = page.getByRole('checkbox', { name: 'Costo de proveedor sin configurar' });
    await expect(casilla.locator('xpath=..')).toHaveAttribute('title', 'Trámites con al menos un costo de proveedor sin configurar. No impide liquidar.');
    await casilla.check();
    await expect.poll(() => urls.at(-1) ?? '').toContain('costoProveedorSinConfigurar=true');
    await expect(page.locator('summary').filter({ hasText: 'Más filtros · 2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Quitar filtro Costo de proveedor sin configurar' })).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar' }).click();
    await page.locator('#exportar-excel').click();
    await expect.poll(() => peticiones.length).toBe(1);
    expect(peticiones[0].postDataJSON()).toMatchObject({ costoProveedorSinConfigurar: true });
  });

  test('chips de lo puesto, ✕ que quita uno y «Limpiar filtros» que vuelve a Aprobado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls = await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    // El estado por defecto se ve como chip; sin nada distinto del punto de partida no hay «Limpiar».
    await expect(page.getByRole('button', { name: 'Quitar filtro Estado: Aprobado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);

    await page.locator('summary').filter({ hasText: 'Más filtros' }).click();
    await page.getByRole('combobox', { name: 'Empresa' }).selectOption('900111,9001112');
    await page.getByRole('checkbox', { name: 'Con diferencias' }).check();
    // El panel se superpone a la fila de chips mientras está abierto: se cierra para usarlos.
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Quitar filtro Empresa: ACME SAS' })).toBeVisible();

    await page.getByRole('button', { name: 'Quitar filtro Empresa: ACME SAS' }).click();
    await expect.poll(() => urls.at(-1) ?? '').not.toContain('empresas=');
    await expect(page.getByRole('button', { name: /Quitar filtro Empresa/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urls.at(-1) ?? '').not.toContain('conDiferencias');
    await expect(page.getByRole('button', { name: /Quitar filtro/ })).toHaveText(['Estado: Aprobado✕']);
  });

  test('ningún filtro de antes se pierde: Periodo con rango personalizado y Más filtros completo', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(page.locator('summary').filter({ hasText: 'Periodo' })).toContainText('Septiembre 2026');
    await page.locator('summary').filter({ hasText: 'Periodo' }).click();
    await expect(page.getByRole('button', { name: 'Trimestre' })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'Rango personalizado' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('summary').filter({ hasText: 'Más filtros' }).click();
    for (const nombre of ['Empresa', 'Tipo de trámite']) await expect(page.getByRole('combobox', { name: nombre })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'Estado' })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'OT' })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: 'Creación' })).toBeVisible();
    for (const nombre of ['Solo con soportes completos', 'Con diferencias', 'Costo de proveedor sin configurar']) {
      await expect(page.getByRole('checkbox', { name: nombre })).toBeVisible();
    }
  });

  test('el consolidado lleva el grupo «Costo de proveedor» aparte, sin margen y con un solo scroll', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.route(/\/api\/finanzas\/reporte-costos\/consolidado\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONSOLIDADO) }));
    await page.goto('/finanzas/reporte-costos?vista=consolidado');

    const tabla = page.getByRole('region', { name: 'Consolidado por cliente y periodo' }).getByRole('table');
    await expect(tabla.locator('th[scope="colgroup"]')).toHaveText(['Cobro al cliente', 'Costo de proveedor']);
    await expect(tabla.getByRole('columnheader', { name: 'Total costos' })).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: /margen/i })).toHaveCount(0);
    await expect(tabla.getByRole('row').filter({ hasText: 'ACME SAS' })).toContainText('$ 3.403.000');
    // El total cobrado no cambia por el costo.
    await expect(tabla.getByRole('row').filter({ hasText: 'ACME SAS' })).toContainText('$ 3.270.400');
    // UNA región de scroll: la de FlitTable, sin un `overflow-x-auto` alrededor.
    expect(await tabla.evaluate((t) => {
      let n = 0; let el: HTMLElement | null = t.parentElement;
      while (el && el !== document.body) { if (getComputedStyle(el).overflowX === 'auto') n++; el = el.parentElement; }
      return n;
    })).toBe(1);
  });

  test('el error del consolidado no es rojo ni enseña el error crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.route(/\/api\/finanzas\/reporte-costos\/consolidado\?/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom interno' }) }));
    await page.goto('/finanzas/reporte-costos?vista=consolidado');
    const alerta = page.getByRole('alert').filter({ hasText: 'No se pudo calcular el consolidado. Vuelve a intentarlo.' });
    await expect(alerta).toBeVisible();
    await expect(alerta).not.toContainText('boom');
    await expect(alerta.locator('.text-red-600')).toHaveCount(0);
  });

  test('4 estados del detalle: cargando, error con Reintentar, vacío (genérico y por costo) y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockFacetas(page, ['Aprobado']);
    await mockFacturacion(page);
    let modo: 'lento' | 'error' | 'vacio' | 'lleno' = 'lento';
    await page.route(/\/api\/finanzas\/reporte-costos\?/, async (route) => {
      if (modo === 'lento') { await new Promise((r) => setTimeout(r, 1500)); }
      if (modo === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
      const cuerpo = modo === 'vacio' ? { ...REPORTE_COSTO, items: [], total: 0 } : REPORTE_COSTO;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
    });
    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('Cargando trámites…').first()).toBeVisible();
    await expect(filaRc(page, 'FLIT-3001')).toBeVisible();

    modo = 'error';
    await page.getByRole('button', { name: /Listos para liquidar/ }).click();
    const alerta = page.getByRole('alert').filter({ hasText: 'No se pudo cargar el reporte. Revisa tu conexión y vuelve a intentarlo.' });
    await expect(alerta).toBeVisible();
    // Los filtros siguen usables durante el error.
    await expect(page.getByRole('button', { name: /Incompletos/ })).toBeEnabled();
    modo = 'vacio';
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText(/No hay trámites que coincidan con los filtros/)).toBeVisible();
    await expect(page.getByText('Prueba otro periodo o quita un filtro.')).toBeVisible();

    await page.locator('summary').filter({ hasText: 'Más filtros' }).click();
    await page.getByRole('checkbox', { name: 'Costo de proveedor sin configurar' }).check();
    await expect(page.getByText('Todos los trámites de este filtro tienen su costo de proveedor configurado.')).toBeVisible();
  });

  for (const ancho of [375, 768]) {
    test(`sin scroll horizontal de página a ${ancho} px (la tabla usa el scroll del kit)`, async ({ page }) => {
      await page.setViewportSize({ width: ancho, height: 812 });
      await loginAs(page, OPERACIONES_USER);
      await mockRediseno(page);
      await page.goto('/finanzas/reporte-costos');
      await expect(filaRc(page, 'FLIT-3001')).toBeVisible();
      await page.locator('summary').filter({ hasText: 'Más filtros' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.keyboard.press('Escape');
      await page.locator('summary').filter({ hasText: 'Columnas' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  // ── Pie «Totales del filtro» del costo de proveedor (segunda pasada) ──
  // Mutantes que caen: sumar las filas de la página (la fixture va descuadrada a propósito), meter el
  // costo dentro de `totales`, pintar la etiqueta «parcial» junto al importe, o no avisar del parcial.
  const pieDe = (page: import('@playwright/test').Page, id: string) =>
    page.getByRole('region', { name: 'Reporte de costos, detalle' }).locator(`tfoot td[data-pie="${id}"]`);

  test('pie: las tres sumas del costo de proveedor bajo sus columnas, del servidor y sin aviso si todo está configurado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(filaRc(page, 'FLIT-3001')).toBeVisible();

    await expect(pieDe(page, 'costoSoat')).toHaveText('$ 1.500.000');
    await expect(pieDe(page, 'costoLogistica')).toHaveText('$ 240.000');
    await expect(pieDe(page, 'totalCostos')).toHaveText('$ 1.740.000');
    // Proveedor no es un importe: su celda del pie queda vacía.
    await expect(pieDe(page, 'proveedorSoat')).toHaveText('');
    // El cobro sigue intacto: el costo no se suma al Total.
    await expect(pieDe(page, 'total')).toHaveText('$ 3.270.400');
    await expect(pieDe(page, 'totalCostos')).not.toHaveAttribute('aria-label', /.+/);
    await expect(pieDe(page, 'totalCostos')).not.toHaveAttribute('title', /.+/);
  });

  test('pie: con costos sin configurar la suma es parcial y se dice en aria-label/title, sin texto pegado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page, {
      ...REPORTE_COSTO,
      totalesCostosProveedor: {
        costoProveedorSoat: 96000, costoProveedorLogistica: 35000, costoProveedorTotal: 131000,
        tramitesCostoSinConfigurar: 2,
      },
    });
    await page.goto('/finanzas/reporte-costos');
    await expect(filaRc(page, 'FLIT-3001')).toBeVisible();

    // La celda muestra solo el valor (retoque 4 del humano).
    await expect(pieDe(page, 'totalCostos')).toHaveText('$ 131.000');
    // `\s`: el formato de moneda de es-CO separa el símbolo con un espacio duro.
    await expect(pieDe(page, 'totalCostos')).toHaveAttribute('aria-label',
      /^Total costos: \$\s131\.000\. Suma parcial: 2 trámites tienen un costo de proveedor sin configurar\.$/);
    await expect(pieDe(page, 'costoSoat')).toHaveAttribute('title',
      /^Costo SOAT: \$\s96\.000\. Suma parcial: 2 trámites tienen un costo de proveedor sin configurar\.$/);
    await expect(pieDe(page, 'costoLogistica')).toHaveAttribute('aria-label', /^Costo logística: \$\s35\.000\. Suma parcial/);
    await expect(page.locator('tfoot')).not.toContainText(/parcial/i);
  });

  test('pie: si se oculta el grupo Costo de proveedor, sus sumas no se pintan', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRediseno(page);
    await page.goto('/finanzas/reporte-costos');
    await expect(pieDe(page, 'totalCostos')).toHaveText('$ 1.740.000');
    await page.locator('summary').filter({ hasText: 'Columnas' }).click();
    for (const nombre of ['Costo SOAT', 'Costo logística', 'Total costos']) {
      await page.getByRole('checkbox', { name: nombre, exact: true }).uncheck();
    }
    await expect(pieDe(page, 'costoSoat')).toHaveCount(0);
    await expect(pieDe(page, 'totalCostos')).toHaveCount(0);
    await expect(page.locator('tfoot')).not.toContainText('$ 1.740.000');
  });
});
