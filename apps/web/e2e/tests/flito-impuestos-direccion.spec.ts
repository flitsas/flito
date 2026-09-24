import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, GESTOR_IMPUESTOS_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #12834: dirección del comprador en el detalle (aviso persistente, formulario
// con «Guardar dirección», sin permiso solo lectura) y aviso de direcciones sin confirmar al descargar
// el Excel ampliado. Backend mockeado, mismo patrón que `flito-impuestos-comparativa.spec.ts`.
// AC5 lo resuelve el servidor (`pendienteRevision` llega en false si el análisis no terminó, y el
// conteo de la cabecera no los suma): aquí se prueba que la pantalla lo respeta.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: null, documentos: null, semaforo: 'verde', motivoSemaforo: null,
};

type Fila = Record<string, unknown> & { id: string };
const fila = (id: string, placa: string, analisisEstado: string | null): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado', analisisEstado,
  ...(analisisEstado === 'completado' ? {} : { semaforo: null }),
});

const FILAS: Fila[] = [
  fila('d1', 'DIR001', 'completado'),
  fila('d2', 'DIR002', 'completado'),
  fila('a1', 'NUN001', null),
  fila('c1', 'CUR001', 'en_curso'),
];

const dir = (extra: Record<string, unknown>) => ({
  direccion: 'CL 10 # 4-21', municipio: 'Bogota', departamento: 'Cundinamarca', origen: 'factura',
  pendienteRevision: false, propuesta: null, confirmadaPor: null, confirmadaEn: null, ...extra,
});

const DIRECCIONES: Record<string, unknown> = {
  // Pendiente con propuesta leída de la factura: el formulario se prellena con la propuesta.
  d1: dir({
    pendienteRevision: true,
    propuesta: { direccion: 'CALLE 10 # 4-21 AP 301', municipio: 'Bogotá D.C.', departamento: 'Bogotá D.C.' },
  }),
  // Pendiente sin propuesta: se prellena con la dirección efectiva.
  d2: dir({ pendienteRevision: true, origen: 'flit' }),
  a1: dir({}),
  c1: dir({ origen: 'flit' }),
};

const campos = [
  { campo: 'vin', resultado: 'coincide', valorFactura: 'VIN1', valorRunt: 'VIN1' },
  { campo: 'marca', resultado: 'coincide', valorFactura: 'RENAULT', valorRunt: 'RENAULT' },
];
const comparacion = {
  version: 1, motivo: null, campos, resumen: { coinciden: 2, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z',
};

interface Parche { cuerpo: Record<string, unknown>; url: string }
const traza = { parches: [] as Parche[], fallosPendientes: 0 };

async function mock(page: Page) {
  traza.parches = [];
  traza.fallosPendientes = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: FILAS, total: FILAS.length, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const f = FILAS.find((x) => x.id === id);
    if (!f) return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...f, comparacion: f.analisisEstado === 'completado' ? comparacion : null, direccionComprador: DIRECCIONES[id], soportes: [] }),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/direccion$/, (route) => {
    const req = route.request();
    const cuerpo = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    traza.parches.push({ cuerpo, url: req.url() });
    if (traza.fallosPendientes > 0) {
      traza.fallosPendientes -= 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'ECONNRESET pg pool' }) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...cuerpo, origen: 'manual', pendienteRevision: false, propuesta: null,
        confirmadaPor: 'Operaciones E2E', confirmadaEn: '2026-09-24T15:00:00Z',
      }),
    });
  });
}

const filaDe = (page: Page, placa: string) => page.getByRole('row').filter({ hasText: placa });

async function abrirDetalle(page: Page, placa: string) {
  await filaDe(page, placa).getByRole('button', { name: 'Ver', exact: true }).click();
  const detalle = page.getByRole('dialog', { name: `Impuesto · ${placa}` });
  await expect(detalle).toBeVisible();
  return detalle;
}

const AVISO = 'Dirección sin confirmar — revísala y guárdala.';

test.describe('FLITO — Impuestos · dirección del comprador (HU #12834)', () => {
  test('AC1 · pendiente y con permiso: aviso arriba, campos con label prellenados y el enlace lleva el foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'DIR001');

    const aviso = detalle.getByTestId('aviso-direccion');
    await expect(aviso).toContainText(AVISO);
    await expect(aviso).toHaveAttribute('role', 'status');
    // Arriba del detalle: antes de la sección de validación.
    const yAviso = (await aviso.boundingBox())!.y;
    const yValidacion = (await detalle.getByTestId('seccion-validacion').boundingBox())!.y;
    expect(yAviso).toBeLessThan(yValidacion);

    // Label asociado y prellenado con la propuesta de la factura.
    await expect(detalle.getByLabel('Dirección', { exact: true })).toHaveValue('CALLE 10 # 4-21 AP 301');
    await expect(detalle.getByLabel('Municipio', { exact: true })).toHaveValue('Bogotá D.C.');
    await expect(detalle.getByLabel('Departamento', { exact: true })).toHaveValue('Bogotá D.C.');
    await expect(detalle.getByTestId('direccion-origen')).toHaveText('Propuesta leída de la factura');

    await aviso.getByRole('button', { name: 'Revisar dirección' }).click();
    await expect(detalle.getByLabel('Dirección', { exact: true })).toBeFocused();

    // La tabla comparativa marca la dirección como «Sin confirmar».
    await expect(detalle.getByRole('row').filter({ hasText: 'Dirección del comprador' })).toContainText('Sin confirmar');

    // Una sola primaria: con un FormMotivo abierto, la dirección pasa a solo lectura.
    await expect(detalle.getByRole('button', { name: 'Guardar dirección' })).toHaveCount(1);
    await detalle.getByRole('button', { name: 'Rechazar', exact: true }).click();
    await expect(detalle.getByRole('button', { name: 'Guardar dirección' })).toHaveCount(0);
    await expect(detalle.getByLabel('Dirección', { exact: true })).toHaveCount(0);
    await expect(detalle.getByText('Termina o cancela la acción en curso para editar la dirección.')).toBeVisible();
    await detalle.getByRole('button', { name: 'Cancelar' }).click();
    await expect(detalle.getByRole('button', { name: 'Guardar dirección' })).toHaveCount(1);
  });

  test('AC2 · guardar: el aviso se va, la tabla muestra lo guardado y la dirección viaja solo en el body', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'DIR001');

    await detalle.getByLabel('Municipio', { exact: true }).fill('  Bogotá  ');
    await detalle.getByRole('button', { name: 'Guardar dirección' }).click();

    await expect(page.getByText('Dirección guardada.')).toBeVisible();
    await expect(detalle.getByTestId('aviso-direccion')).toHaveCount(0);
    await expect(detalle.getByLabel('Dirección', { exact: true })).toHaveCount(0);
    await expect(detalle.getByTestId('direccion-texto')).toHaveText('CALLE 10 # 4-21 AP 301, Bogotá, Bogotá D.C.');
    await expect(detalle.getByTestId('direccion-origen')).toContainText('Confirmada por Operaciones E2E');
    const filaDir = detalle.getByRole('row').filter({ hasText: 'Dirección del comprador' });
    await expect(filaDir).toContainText('CALLE 10 # 4-21 AP 301, Bogotá, Bogotá D.C.');
    await expect(filaDir).not.toContainText('Sin confirmar');

    expect(traza.parches).toHaveLength(1);
    expect(traza.parches[0].cuerpo).toEqual({ direccion: 'CALLE 10 # 4-21 AP 301', municipio: 'Bogotá', departamento: 'Bogotá D.C.' });
    expect(new URL(traza.parches[0].url).pathname).toBe('/api/flito/impuestos/d1/direccion');
    expect(new URL(traza.parches[0].url).search).toBe('');
    await expect(page).toHaveURL(/\/flito\/impuestos$/);
  });

  test('AC2 · error: mensaje claro sin el error crudo, y el mismo botón reintenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'DIR002');

    // Sin propuesta: prellenado con la dirección efectiva.
    await expect(detalle.getByLabel('Dirección', { exact: true })).toHaveValue('CL 10 # 4-21');
    await expect(detalle.getByTestId('direccion-origen')).toHaveText('Tomada de FLIT');

    // Campo vacío: error en línea y no sale petición.
    await detalle.getByLabel('Departamento', { exact: true }).fill('   ');
    await detalle.getByRole('button', { name: 'Guardar dirección' }).click();
    await expect(detalle.getByText('Escribe el departamento.')).toBeVisible();
    expect(traza.parches).toHaveLength(0);
    await detalle.getByLabel('Departamento', { exact: true }).fill('Cundinamarca');

    traza.fallosPendientes = 1;
    await detalle.getByRole('button', { name: 'Guardar dirección' }).click();
    const alerta = detalle.getByTestId('direccion-error');
    await expect(alerta).toHaveAttribute('role', 'alert');
    await expect(alerta).toHaveText('No se pudo guardar la dirección. Revisa tu conexión e inténtalo de nuevo.');
    await expect(detalle).not.toContainText('ECONNRESET');
    await expect(detalle.getByTestId('aviso-direccion')).toBeVisible();

    await detalle.getByRole('button', { name: 'Guardar dirección' }).click();
    await expect(detalle.getByTestId('aviso-direccion')).toHaveCount(0);
    await expect(detalle.getByTestId('direccion-error')).toHaveCount(0);
    expect(traza.parches).toHaveLength(2);
  });

  test('AC3 · sin el permiso: se ven la dirección y el aviso, sin campos ni botón', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'DIR001');

    await expect(detalle.getByTestId('aviso-direccion'))
      .toHaveText('Dirección sin confirmar. Debe revisarla alguien con permiso para corregir direcciones.');
    await expect(detalle.getByRole('button', { name: 'Revisar dirección' })).toHaveCount(0);
    await expect(detalle.getByTestId('direccion-texto')).toHaveText('CL 10 # 4-21, Bogota, Cundinamarca');
    await expect(detalle.getByTestId('seccion-direccion').getByRole('textbox')).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Guardar dirección' })).toHaveCount(0);
  });

  for (const [placa, caso] of [['NUN001', 'nunca analizado'], ['CUR001', 'análisis en curso']] as const) {
    test(`AC5 · ${caso}: sin aviso ni «Sin confirmar»; la dirección como texto`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mock(page);
      await page.goto('/flito/impuestos');
      const detalle = await abrirDetalle(page, placa);

      await expect(detalle.getByTestId('direccion-texto')).toHaveText('CL 10 # 4-21, Bogota, Cundinamarca');
      await expect(detalle.getByTestId('aviso-direccion')).toHaveCount(0);
      await expect(detalle.getByText('Sin confirmar')).toHaveCount(0);
      await expect(detalle.getByRole('button', { name: 'Guardar dirección' })).toHaveCount(0);
    });
  }
});

// ═══════════════════════ AC4 — aviso de la descarga ampliada ═══════════════════════

const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NOMBRE = 'impuestos_20991231-2359.xlsx';

async function mockExport(page: Page, cabecera: string | null) {
  const cuerpos: Record<string, unknown>[] = [];
  await page.route(/\/api\/flito\/impuestos\/export$/, (route: Route) => {
    cuerpos.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    return route.fulfill({
      status: 200, contentType: CT_XLSX, body: 'PKFLITO-E2E',
      headers: {
        'content-disposition': `attachment; filename="${NOMBRE}"`,
        ...(cabecera === null ? {} : { 'x-direcciones-sin-confirmar': cabecera }),
      },
    });
  });
  return cuerpos;
}

async function descargarAmpliado(page: Page) {
  await page.getByRole('checkbox', { name: 'Incluir datos de pago y trazabilidad', exact: true }).check();
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar a Excel', exact: true }).click()]);
}

test.describe('FLITO — Impuestos · aviso de direcciones sin confirmar en el Excel ampliado (HU #12834, AC4)', () => {
  const casos: Array<[string, string | null, string | null]> = [
    ['N>1', '3', 'El archivo incluye 3 impuestos con dirección sin confirmar. Revísalos en su detalle antes de usar el archivo.'],
    ['N=1', '1', 'El archivo incluye 1 impuesto con dirección sin confirmar. Revísalo en su detalle antes de usar el archivo.'],
    ['N=0', '0', null],
    ['sin cabecera', null, null],
  ];
  for (const [nombre, cabecera, esperado] of casos) {
    test(`${nombre}`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mock(page);
      const cuerpos = await mockExport(page, cabecera);
      await page.goto('/flito/impuestos');
      await descargarAmpliado(page);

      expect(cuerpos).toHaveLength(1);
      expect(cuerpos[0].incluirPago).toBe(true);
      const banda = page.locator('[data-tono]');
      await expect(banda).toContainText(`Archivo descargado: ${NOMBRE}`);
      if (esperado) {
        await expect(banda).toHaveAttribute('data-tono', 'aviso');
        await expect(banda).toContainText(esperado);
        // Cerrable.
        await banda.getByRole('button', { name: 'Cerrar el aviso' }).click();
        await expect(page.locator('[data-tono]')).toHaveCount(0);
      } else {
        await expect(banda).toHaveAttribute('data-tono', 'ok');
        await expect(banda).not.toContainText('dirección sin confirmar');
      }
    });
  }
});
