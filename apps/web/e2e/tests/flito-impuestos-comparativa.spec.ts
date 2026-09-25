import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #12831: modal comparativo factura ↔ RUNT (desde el semáforo de la fila) y
// sección «Validación factura ↔ RUNT» del detalle. Backend mockeado, mismo patrón que
// `flito-impuestos-semaforo.spec.ts`. «Reintentar validación» es de la HU #12832: aquí no existe.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: null, documentos: null,
};

type Fila = Record<string, unknown> & { id: string };
const fila = (id: string, placa: string, extra: Partial<Fila>): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado',
  analisisEstado: 'completado', semaforo: null, motivoSemaforo: null, ...extra,
});

const FILAS: Fila[] = [
  fila('v1', 'VER001', { semaforo: 'verde' }),
  fila('v2', 'VER002', { semaforo: 'verde' }),
  // Sin semáforo guardado (filas previas a la columna): el chip cae a la regla del backend.
  fila('s1', 'SIN001', {}),
  fila('s2', 'SIN002', {}),
  fila('n1', 'NAR001', { semaforo: 'naranja' }),
  fila('r1', 'ROJ001', { semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta' }),
  fila('r2', 'ROJ002', { semaforo: 'rojo', motivoSemaforo: 'error_lectura_factura' }),
  fila('p1', 'PEN001', { estado: 'pendiente', analisisEstado: null }),
];

const campo = (c: string, resultado: string, f: string | null, r: string | null) =>
  ({ campo: c, resultado, valorFactura: f, valorRunt: r });

const IGUALES = [
  campo('vin', 'coincide', '9FB000000000012', '9FB000000000012'),
  campo('marca', 'coincide', 'RENAULT', 'RENAULT'),
  campo('linea', 'coincide', 'DUSTER', 'DUSTER'),
  campo('anio', 'coincide', '2025', '2025'),
];

const DIRECCION = {
  direccion: 'CL 10 # 4-21', municipio: 'Bogotá D.C.', departamento: 'Cundinamarca', origen: 'factura',
  pendienteRevision: false, propuesta: null, confirmadaPor: null, confirmadaEn: null,
};

const comparacion = (motivo: string | null, campos: unknown[]) => ({
  version: 1, motivo, campos, resumen: { coinciden: 0, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z',
});

const DETALLE: Record<string, unknown> = {
  v1: comparacion(null, [...IGUALES, campo('color', 'coincide', 'GRIS', 'GRIS'), campo('cilindrada', 'coincide', '1598', '1598')]),
  // Verde guardado con un dato sin verificar (repro FLIT-0130318): `no_verificable` no es diferencia.
  v2: comparacion(null, [...IGUALES, campo('color', 'coincide', 'GRIS', 'GRIS'), campo('cilindrada', 'no_verificable', null, '1598')]),
  s1: comparacion(null, [...IGUALES, campo('color', 'difiere', 'GRIS', 'NEGRO'), campo('cilindrada', 'coincide', '1598', '1598')]),
  s2: comparacion(null, [...IGUALES, campo('color', 'coincide', 'GRIS', 'GRIS'), campo('cilindrada', 'no_verificable', null, '1598')]),
  n1: comparacion(null, [...IGUALES,
    campo('color', 'difiere', 'GRIS ESTRELLA', 'GRIS CASSIOPEE'), campo('cilindrada', 'difiere', '1598', '1600')]),
  r1: comparacion('runt_sin_respuesta', []),
  r2: comparacion('error_lectura_factura', []),
  p1: null,
};

/** Cuántas veces se pidió `GET /:id`, por id. */
const pedidos: Record<string, number> = {};

/** Id cuyo `GET /:id` responde 500 mientras esté aquí (el modo estricto de React pide dos veces). */
const falla = { id: null as string | null };

async function mock(page: import('@playwright/test').Page) {
  falla.id = null;
  for (const k of Object.keys(pedidos)) delete pedidos[k];
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: FILAS, total: FILAS.length, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    pedidos[id] = (pedidos[id] ?? 0) + 1;
    if (falla.id === id) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'ECONNRESET pg pool' }) });
    }
    const f = FILAS.find((x) => x.id === id)!;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...f, comparacion: DETALLE[id], direccionComprador: DIRECCION, soportes: [] }),
    });
  });
}

const filaDe = (page: import('@playwright/test').Page, placa: string) =>
  page.getByRole('row').filter({ hasText: placa });

test.describe('FLITO — Impuestos · comparación factura ↔ RUNT (HU #12831)', () => {
  test('AC1 · naranja: el semáforo abre el modal sin salir de la cola, con resumen y tabla de dos columnas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'NAR001').getByRole('button', { name: /Con diferencias frente al RUNT/ }).click();
    const modal = page.getByRole('dialog', { name: 'Validación factura ↔ RUNT · NAR001' });
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/flito\/impuestos$/);
    await expect(modal.getByTestId('validacion-resumen')).toHaveText('2 datos no coinciden: Color, Cilindraje.');
    await expect(modal.getByText('Con diferencias', { exact: true })).toBeVisible();
    await expect(modal.getByText('Coincide con el RUNT', { exact: true })).toHaveCount(0);

    const tabla = modal.getByRole('region', { name: 'Comparación de la factura de venta con el RUNT' }).getByRole('table');
    await expect(tabla.getByRole('columnheader')).toHaveText(['Dato', 'En factura', 'En RUNT', 'Resultado']);
    await expect(tabla.getByRole('rowheader')).toHaveText([
      'VIN', 'Marca', 'Modelo (línea)', 'Año', 'Color', 'Cilindraje', 'Dirección del comprador',
    ]);
    const filaTabla = (dato: string) => tabla.getByRole('row').filter({ has: page.getByRole('rowheader', { name: dato, exact: true }) });
    await expect(filaTabla('Color')).toContainText('GRIS ESTRELLA');
    await expect(filaTabla('Color')).toContainText('GRIS CASSIOPEE');
    await expect(filaTabla('Color').locator('[data-resultado="difiere"]')).toContainText('No coincide');
    await expect(filaTabla('Marca').locator('[data-resultado="coincide"]')).toContainText('Coincide');
    await expect(filaTabla('Cilindraje').locator('[data-resultado="difiere"] svg')).toHaveCount(1);

    // Dirección: la de la factura; el RUNT «No aplica» y no se compara.
    const dir = filaTabla('Dirección del comprador');
    await expect(dir).toContainText('CL 10 # 4-21, Bogotá D.C., Cundinamarca');
    await expect(dir.getByRole('cell').nth(1)).toHaveText('No aplica');
    await expect(dir.getByRole('img', { name: 'No se compara' })).toBeVisible();

    // Visita de consulta: sin primaria; Esc cierra y la cola sigue ahí.
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(filaDe(page, 'NAR001')).toBeVisible();
  });

  test('AC1 · verde: todos coinciden; «Ver detalle» pasa al detalle del impuesto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'VER001').getByRole('button', { name: /Coincide con el RUNT/ }).click();
    const modal = page.getByRole('dialog', { name: 'Validación factura ↔ RUNT · VER001' });
    await expect(modal.getByTestId('validacion-resumen')).toHaveText('Los 6 datos coinciden con el RUNT.');
    await expect(modal.locator('[data-resultado="coincide"]')).toHaveCount(6);
    await modal.getByRole('button', { name: 'Ver detalle' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Impuesto · VER001' })).toBeVisible();
  });

  test('AC1 · verde con un dato sin verificar: el chip sigue el semáforo guardado, no «Con diferencias»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'VER002').getByRole('button', { name: /Coincide con el RUNT/ }).click();
    const modal = page.getByRole('dialog', { name: 'Validación factura ↔ RUNT · VER002' });
    await expect(modal.getByTestId('validacion-resumen')).toContainText('1 dato no se pudo verificar: Cilindraje.');
    await expect(modal.getByText('Coincide con el RUNT', { exact: true })).toBeVisible();
    await expect(modal.getByText('Con diferencias', { exact: true })).toHaveCount(0);
    await expect(modal.locator('[data-resultado="no_verificable"]')).toHaveCount(1);
  });

  test('AC1 · error al cargar: aviso dentro del modal, sin error crudo, y se vuelve a pedir', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    falla.id = 'n1';
    await page.goto('/flito/impuestos');

    await filaDe(page, 'NAR001').getByRole('button', { name: /Con diferencias/ }).click();
    const modal = page.getByRole('dialog', { name: /Validación factura ↔ RUNT/ });
    const alerta = modal.getByRole('alert');
    await expect(alerta).toContainText('No se pudo cargar la validación. Inténtalo de nuevo.');
    await expect(modal).not.toContainText('ECONNRESET');
    const antes = pedidos.n1;
    falla.id = null;
    await alerta.getByRole('button', { name: 'Volver a cargar' }).click();
    await expect(modal.getByTestId('validacion-resumen')).toHaveText('2 datos no coinciden: Color, Cilindraje.');
    expect(pedidos.n1).toBe(antes + 1);
  });

  test('AC2 · el detalle con análisis completado trae la sección con la misma tabla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'NAR001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion.getByTestId('validacion-resumen')).toHaveText('2 datos no coinciden: Color, Cilindraje.');
    await expect(seccion.getByRole('rowheader')).toHaveText([
      'VIN', 'Marca', 'Modelo (línea)', 'Año', 'Color', 'Cilindraje', 'Dirección del comprador',
    ]);
  });

  test('AC2 · verde guardado con un dato sin verificar: la sección del detalle muestra el chip verde', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'VER002').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion.getByTestId('validacion-resumen')).toContainText('1 dato no se pudo verificar: Cilindraje.');
    await expect(seccion.getByText('Coincide con el RUNT', { exact: true })).toBeVisible();
    await expect(seccion.getByText('Con diferencias', { exact: true })).toHaveCount(0);
  });

  test('AC2 · sin semáforo guardado y un dato que difiere: el chip cae a «Con diferencias»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'SIN001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion.getByTestId('validacion-resumen')).toHaveText('1 dato no coincide: Color.');
    await expect(seccion.getByText('Con diferencias', { exact: true })).toBeVisible();
    await expect(seccion.getByText('Coincide con el RUNT', { exact: true })).toHaveCount(0);
  });

  test('AC2 · sin semáforo guardado y solo un dato sin verificar: el chip cae a «Coincide con el RUNT»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'SIN002').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion.getByTestId('validacion-resumen')).toContainText('1 dato no se pudo verificar: Cilindraje.');
    await expect(seccion.getByText('Coincide con el RUNT', { exact: true })).toBeVisible();
    await expect(seccion.getByText('Con diferencias', { exact: true })).toHaveCount(0);
  });

  test('AC2 · nunca analizado: la sección lo dice y no pide nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'PEN001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion).toContainText('Este impuesto aún no se ha validado contra el RUNT.');
    // Desde la HU #12834 el detalle pide `GET /:id` una vez para la dirección del comprador (se muestra
    // aunque no haya análisis), pero la sección no lo usa: ni tabla, ni «Cargando», ni error.
    await expect(page.getByRole('region', { name: 'Dirección del comprador' })).toContainText('CL 10 # 4-21');
    await expect(seccion.getByRole('table')).toHaveCount(0);
    await expect(seccion).not.toContainText('Cargando la validación');
  });

  test('AC3 · rojo: el copy va por motivo, sin tabla vacía ni error crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'ROJ001').getByRole('button', { name: /El RUNT no respondió/ }).click();
    let modal = page.getByRole('dialog', { name: 'Validación factura ↔ RUNT · ROJ001' });
    await expect(modal.getByTestId('validacion-sin-validar')).toContainText(
      'El RUNT no respondió o no tiene registro del vehículo. Puede ser una caída momentánea');
    await expect(modal.getByTestId('validacion-sin-validar')).toContainText('Reintenta la validación en unos minutos.');
    await expect(modal.getByRole('table')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).last().click();

    await filaDe(page, 'ROJ002').getByRole('button', { name: /No se pudo leer la factura/ }).click();
    modal = page.getByRole('dialog', { name: 'Validación factura ↔ RUNT · ROJ002' });
    await expect(modal.getByTestId('validacion-sin-validar')).toContainText('No se pudo leer la factura.');
    await expect(modal).not.toContainText('error_lectura_factura');
  });
});
