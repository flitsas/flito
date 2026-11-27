import { test, expect } from '../helpers/fixtures';
import type { Page, Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

// HU #13901 — Bolsas: crear, editar, inactivar y reactivar la bolsa de una compañía (Feature #13886).
// Spec UX: docs/ux/flito-bolsas.md. Backend mockeado (contrato de la HU #13900).

const TODAS = [
  'bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.bolsa.crear', 'bolsas.bolsa.editar',
  'bolsas.bolsa.inactivar', 'bolsas.transito.crear', 'bolsas.movimientos.ver', 'bolsas.cierres.ver',
  'bolsas.recarga.registrar', 'bolsas.cierre.crear',
];
/** Con y sin acceso a la página `clients` (de ella depende el enlace a Parametrización, AC10). */
const CON_CLIENTES = { ...FINANCIERA_USER, allowedPages: ['flito_bolsas', 'clients'] };

/**
 * Financiera trae `clients` entre las páginas por defecto de su rol (y `loginAs` las une como el
 * servidor), así que el caso «sin acceso» se monta sobrescribiendo `/me` DESPUÉS de `loginAs`: en
 * Playwright gana la ruta registrada al último.
 */
async function entrarSinClientes(page: Page) {
  await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
  await page.route('**/api/auth/me', (r) => json(r, { ...FINANCIERA_USER, allowedPages: ['flito_bolsas'] }));
}

const SOLO_VER = ['bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.movimientos.ver', 'bolsas.cierres.ver'];

const resumen = (o: Record<string, unknown>) => ({
  alcance: 'compania', companiaNombre: o.nombre, conceptos: ['soat', 'derecho'], cobertura: [],
  ultimaEntradaValor: 5000000, ultimaEntradaEn: '2026-10-02T10:00:00.000Z', porcentaje: 62, ...o,
});

const ANDINOS = resumen({ id: 'b-1', nombre: 'TRANSPORTES ANDINOS', companiaId: 1, activa: true, saldo: 4250000, nivel: 'normal' });
const RENTACAR = resumen({ id: 'b-3', nombre: 'RENTACAR NORTE', companiaId: 3, activa: false, saldo: -85000, nivel: 'agotada' });
const FILAS = [ANDINOS, RENTACAR];

const detalle = (r: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...r, inactivadaEn: null, inactivadaPorNombre: null, motivoInactivacion: null, conceptosAutogestionados: [], ...extra,
});

const CLIENTES = [
  { id: 1, name: 'TRANSPORTES ANDINOS' },
  { id: 2, name: 'LOGISTICA DEL VALLE' },
  { id: 3, name: 'RENTACAR NORTE' },
];

function mov(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, bolsaId: 'b-1', companiaId: 1, tipo: 'salida', origen: 'manual', concepto: 'soat', organismoCodigo: null,
    tramiteId: null, idFlit: null, valor: 10000, saldoResultante: 4250000, periodo: '2026-10',
    fecha: '2026-10-05', observacion: null, soporteId: null, comprobanteId: null, revierteMovimientoId: null,
    registradoPorNombre: 'Ana Pérez', createdAt: '2026-10-05T15:00:00.000Z', ...extra,
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Opts {
  filas?: unknown[];
  detalles?: Record<string, unknown>;
  movimientos?: unknown[];
  autogestion?: Record<number, string[]>;
  existe?: Record<number, boolean>;
  alertas?: unknown[];
}

/** Mock del módulo. Devuelve las peticiones a `/buscar` (cuerpo + url) para comprobar AC1/Ley 1581. */
async function mock(page: Page, o: Opts = {}) {
  const buscar: Array<{ url: string; body: unknown }> = [];
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (r) => json(r, { clientes: 2, saldoTotal: 4165000 }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (r) => json(r, {
    saldo: o.alertas ?? [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0, boletasSinComprobante: 0 },
  }));
  await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => {
    const body = (r.request().postDataJSON() ?? {}) as { alcance?: string; activa?: boolean };
    buscar.push({ url: r.request().url(), body });
    // Como el servidor: el alcance y el estado filtran (HU #13908, AC3).
    const filas = (o.filas ?? FILAS) as Array<{ alcance: string; activa: boolean }>;
    return json(r, filas.filter((f) => (body.alcance === undefined || f.alcance === body.alcance)
      && (body.activa === undefined || f.activa === body.activa)));
  });
  await page.route(/\/api\/flito\/bolsas\/bolsa\/([^/]+)$/, (r) => {
    const id = r.request().url().split('/').pop()!;
    const d = o.detalles?.[id];
    return d ? json(r, d) : json(r, { error: 'La bolsa no existe' }, 404);
  });
  await page.route(/\/api\/flito\/bolsas\/compania\/(\d+)\/estado/, (r) => {
    const id = Number(r.request().url().match(/compania\/(\d+)/)![1]);
    return json(r, { existe: o.existe?.[id] ?? false, activa: false, conceptosAutogestionados: o.autogestion?.[id] ?? [] });
  });
  await page.route(/\/api\/flito\/bolsas\/\d+\/extracto/, (r) => json(r, {
    companiaId: 1, saldoActual: 4250000, totalEntradas: 0, totalSalidas: 0, porOrganismo: [], porConcepto: [],
  }));
  await page.route(/\/api\/flito\/bolsas\/\d+\/movimientos/, (r) => json(r, o.movimientos ?? []));
  await page.route(/\/api\/flito\/bolsas\/\d+\/cierres/, (r) => json(r, []));
  await page.route(/\/api\/clients/, (r) => json(r, CLIENTES));
  return buscar;
}

test.describe('FLITO — Bolsas · catálogo de la bolsa de una compañía (HU #13901)', () => {
  test('AC1 + AC8: listado en tabla con estado, saldo y nivel; el texto viaja en el body, nunca en la URL', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    const buscar = await mock(page);
    await page.goto('/flito/bolsas');

    const tabla = page.getByRole('region', { name: 'Bolsas de compañías' });
    await expect(tabla.getByText('TRANSPORTES ANDINOS')).toBeVisible();
    await expect(tabla.getByText('Activa', { exact: true })).toBeVisible();
    await expect(tabla.getByText('Inactiva', { exact: true })).toBeVisible();
    await expect(tabla.getByText('Bolsa agotada')).toBeVisible();
    await expect(tabla.getByText(/−\s*\$\s*85\.000/)).toBeVisible();
    // Columna Expediente (#13893): sin `bolsas.documentos.ver` no existe (su spec: flito-bolsas-documentos-chip).
    await expect(tabla.getByRole('columnheader', { name: /Expediente/ })).toHaveCount(0);
    // Una sola primaria en la cabecera; los acordeones ya no traen botón propio.
    await expect(page.getByRole('button', { name: 'Crear bolsa' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Abrir bolsa/ })).toHaveCount(0);

    await page.getByRole('searchbox', { name: 'Buscar' }).fill('900123');
    await expect.poll(() => buscar.some((b) => (b.body as { texto?: string })?.texto === '900123')).toBe(true);
    expect(buscar.every((b) => !b.url.includes('?'))).toBe(true);
    expect(page.url()).not.toContain('900123');

    await page.getByRole('group', { name: 'Estado de la bolsa' }).getByRole('button', { name: 'Inactivas' }).click();
    await expect.poll(() => buscar.some((b) => (b.body as { activa?: boolean })?.activa === false)).toBe(true);
  });

  test('AC1: error con Reintentar (sin texto crudo) y vacío total con «Crear bolsa»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page, { filas: [] });
    let falla = true;
    await page.route(/\/api\/flito\/bolsas\/buscar/, (r) =>
      (falla ? json(r, { error: 'boom interno' }, 500) : json(r, [])));
    await page.goto('/flito/bolsas');

    await expect(page.getByText('No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByTestId('bolsas-vacio-total')).toContainText('Todavía no hay bolsas');
    await expect(page.getByTestId('bolsas-vacio-total').getByRole('button', { name: 'Crear bolsa' })).toBeVisible();
  });

  test('AC2: alta de compañía sin GMF ni conceptos marcados; toast y se abre el detalle de la nueva', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    const nueva = detalle(resumen({ id: 'b-2', nombre: 'LOGISTICA DEL VALLE', companiaId: 2, activa: true, saldo: 0, nivel: 'sin_recargas', porcentaje: null, ultimaEntradaValor: null, ultimaEntradaEn: null, conceptos: ['derecho'] }));
    await mock(page, { detalles: { 'b-2': nueva } });
    let cuerpo: unknown = null;
    await page.route(/\/api\/flito\/bolsas$/, (r) => {
      cuerpo = r.request().postDataJSON();
      return json(r, nueva, 201);
    });
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await expect(modal.getByRole('radio', { name: /Compañía/ })).toBeChecked();
    await expect(modal.getByText(/GMF/)).toHaveCount(0);
    await expect(modal.getByText(/documento/i)).toHaveCount(0);
    await expect(modal.getByRole('checkbox', { checked: true })).toHaveCount(0);

    await modal.getByLabel('Compañía *').selectOption('2');
    await expect(modal.getByRole('button', { name: 'Crear bolsa' })).toBeDisabled();
    await modal.getByRole('checkbox', { name: 'Derecho de tránsito' }).check();
    await modal.getByRole('button', { name: 'Crear bolsa' }).click();

    expect(cuerpo).toEqual({ alcance: 'compania', companiaId: 2, conceptos: ['derecho'] });
    await expect(page.getByText('Bolsa de LOGISTICA DEL VALLE creada.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'LOGISTICA DEL VALLE' })).toBeVisible();
  });

  test('AC3: compañía con bolsa inactiva → aviso con enlace a su bolsa; el 409 pinta el mismo aviso', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page, { detalles: { 'b-3': detalle(RENTACAR) } });
    await page.route(/\/api\/flito\/bolsas$/, (r) => json(r, {
      error: 'La compañía ya tiene bolsa', codigo: 'bolsa_compania_existe', bolsaId: 'b-3', activa: false,
    }, 409));
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByLabel('Compañía *').selectOption('3');
    await expect(modal.getByTestId('aviso-bolsa-existente')).toContainText('Esta compañía ya tiene bolsa (inactiva).');
    await expect(modal.getByRole('button', { name: 'Crear bolsa' })).toBeDisabled();

    // Carrera: la compañía 2 no está en el mapa, pero el servidor responde 409.
    await modal.getByLabel('Compañía *').selectOption('2');
    await expect(modal.getByTestId('aviso-bolsa-existente')).toHaveCount(0);
    await modal.getByRole('checkbox', { name: 'SOAT' }).check();
    await modal.getByRole('button', { name: 'Crear bolsa' }).click();
    await expect(modal.getByTestId('aviso-bolsa-existente')).toContainText('Esta compañía ya tiene bolsa (inactiva).');
    await expect(modal.getByText('La compañía ya tiene bolsa')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Ver su bolsa' }).click();
    await expect(page.getByRole('dialog', { name: 'RENTACAR NORTE' })).toBeVisible();
  });

  test('AC10: concepto autogestionado con marca, aviso y enlace a Clientes; se puede marcar igual', async ({ page }) => {
    await loginAs(page, CON_CLIENTES, { funciones: TODAS });
    await mock(page, { autogestion: { 2: ['soat', 'logistica'] } });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByLabel('Compañía *').selectOption('2');

    await expect(modal.getByText('Autogestionado')).toHaveCount(2);
    await expect(modal.getByTestId('aviso-autogestion')).toContainText(
      'Esta compañía gestiona su SOAT y su logística por su cuenta: no llegarán movimientos a la bolsa por esos conceptos salvo excepciones.',
    );
    const enlace = modal.getByTestId('aviso-autogestion').getByRole('link', { name: 'Cambiarlo en Clientes y proveedores' });
    await expect(enlace).toHaveAttribute('href', '/clients');
    await modal.getByRole('checkbox', { name: /SOAT/ }).check();
    await expect(modal.getByRole('checkbox', { name: /SOAT/ })).toBeChecked();
  });

  test('AC10: sin acceso a Clientes y proveedores el aviso queda sin enlace', async ({ page }) => {
    await entrarSinClientes(page);
    await mock(page, { autogestion: { 2: ['soat'] } });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByLabel('Compañía *').selectOption('2');
    const aviso = modal.getByTestId('aviso-autogestion');
    await expect(aviso).toContainText('Esta compañía gestiona su SOAT por su cuenta: no llegarán movimientos a la bolsa salvo excepciones.');
    await expect(aviso).toContainText('Lo cambia Operaciones en Clientes y proveedores.');
    await expect(aviso.getByRole('link')).toHaveCount(0);
  });

  test('AC4 + AC10: el detalle muestra el aviso de autogestión y la reversión enlaza al original', async ({ page }) => {
    await loginAs(page, CON_CLIENTES, { funciones: TODAS });
    await mock(page, {
      detalles: { 'b-1': detalle(ANDINOS, { conceptosAutogestionados: ['soat'] }) },
      movimientos: [
        mov('m-2', { tipo: 'entrada', fecha: '2026-10-08', revierteMovimientoId: 'm-1', observacion: 'Reversa' }),
        mov('m-1', { fecha: '2026-10-05' }),
      ],
    });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const detalleModal = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(detalleModal.getByTestId('aviso-autogestion')).toContainText('Esta compañía gestiona su SOAT por su cuenta');
    await expect(detalleModal.getByTestId('aviso-autogestion').getByRole('link', { name: 'Cambiarlo en Clientes y proveedores' }))
      .toHaveAttribute('href', '/clients');
    await expect(detalleModal.getByText('Revertido el 5/10/2026')).toHaveCount(0);
    await expect(detalleModal.getByText(/Revertido el 8\/10\/2026/)).toBeVisible();
    await detalleModal.getByRole('button', { name: 'Revierte el movimiento del 5/10/2026' }).click();
    await expect(detalleModal.locator('tr[data-marcada="true"]')).toHaveCount(1);
    await expect(detalleModal.locator('#mov-m-1')).toBeFocused();
  });

  test('AC5 + AC6: inactivar exige motivo ≥ 5; luego no hay recarga ni manual y se avisa «Reactiva la bolsa primero»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    const detalles: Record<string, unknown> = { 'b-1': detalle(ANDINOS) };
    const buscar = await mock(page, { detalles });
    let motivo: unknown = null;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/b-1\/inactivar$/, (r) => {
      motivo = r.request().postDataJSON();
      detalles['b-1'] = detalle({ ...ANDINOS, activa: false }, {
        inactivadaEn: '2026-10-12T20:40:00.000Z', inactivadaPorNombre: 'Ana Pérez', motivoInactivacion: 'Cliente suspendido',
      });
      return json(r, detalles['b-1']);
    });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(d.getByRole('button', { name: 'Registrar una recarga' })).toBeVisible();

    await d.getByRole('button', { name: 'Inactivar', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'Inactivar la bolsa de TRANSPORTES ANDINOS' });
    await m.getByLabel('Motivo *').fill('     abcd');
    await expect(m.getByRole('button', { name: 'Inactivar bolsa' })).toBeDisabled();
    await m.getByLabel('Motivo *').fill('Cliente suspendido');
    const antes = buscar.length;
    await m.getByRole('button', { name: 'Inactivar bolsa' }).click();

    expect(motivo).toEqual({ motivo: 'Cliente suspendido' });
    await expect(page.getByText('Bolsa inactivada.')).toBeVisible();
    // AC4 «cuándo»: 2026-10-12T20:40Z es 12/10/26 3:40 p. m. en Colombia.
    await expect(d.getByTestId('aviso-inactiva')).toContainText(/Inactiva desde el 12\/10\/(20)?26,? 3:40/);
    await expect(d.getByTestId('aviso-inactiva')).toContainText('por Ana Pérez');
    await expect(d.getByTestId('aviso-inactiva')).toContainText('Motivo: «Cliente suspendido».');
    await expect(d.getByTestId('aviso-inactiva')).toContainText('Reactiva la bolsa primero.');
    await expect(d.getByRole('button', { name: 'Registrar una recarga' })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Movimiento manual' })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Corregir un movimiento' })).toHaveCount(0);
    await expect(d.getByRole('button', { name: /^Cerrar / })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Reactivar bolsa' })).toBeVisible();
    // El listado se relee.
    await expect.poll(() => buscar.length).toBeGreaterThan(antes);
  });

  test('AC6: compañía sin bolsa (desde una alerta) → «Crea la bolsa de la compañía primero» con «Crear bolsa»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page, {
      alertas: [{ tipo: 'saldo', nivel: 'critico', companiaId: 2, companiaNombre: 'LOGISTICA DEL VALLE', saldo: 0, porcentaje: 0, mensaje: 'Saldo crítico' }],
    });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de LOGISTICA DEL VALLE (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'LOGISTICA DEL VALLE' });
    await expect(d.getByTestId('aviso-sin-bolsa')).toContainText('Crea la bolsa de la compañía primero');
    await d.getByRole('button', { name: 'Crear bolsa' }).click();
    const form = page.getByRole('dialog', { name: 'Crear bolsa' });
    await expect(form.getByLabel('Compañía *')).toHaveValue('2');
  });

  test('AC10: sin acceso a Clientes, el aviso del detalle queda sin enlace', async ({ page }) => {
    await entrarSinClientes(page);
    await mock(page, { detalles: { 'b-1': detalle(ANDINOS, { conceptosAutogestionados: ['soat'] }) } });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const aviso = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' }).getByTestId('aviso-autogestion');
    await expect(aviso).toContainText('Lo cambia Operaciones en Clientes y proveedores.');
    await expect(aviso.getByRole('link')).toHaveCount(0);
  });

  test('AC4: error al cargar la bolsa, sin texto crudo, y «Reintentar» la recupera', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page);
    let falla = true;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/b-1$/, (r) =>
      (falla ? json(r, { error: 'boom interno del detalle' }, 500) : json(r, detalle(ANDINOS))));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(d.getByText('No pudimos cargar la bolsa. Intenta de nuevo.')).toBeVisible();
    await expect(d.getByText('boom interno del detalle')).toHaveCount(0);
    falla = false;
    await d.getByRole('button', { name: 'Reintentar' }).click();
    await expect(d.getByText('Descuenta:')).toBeVisible();
    await expect(d.getByText('No pudimos cargar la bolsa. Intenta de nuevo.')).toHaveCount(0);
  });

  test('AC4: bolsa sin movimientos en el periodo → vacío con el siguiente paso', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page, { detalles: { 'b-1': detalle(ANDINOS) }, movimientos: [] });
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(d.getByText(/Esta bolsa no tiene movimientos en .+\. Marca «Ver el libro completo» para ver los demás periodos\./)).toBeVisible();
  });

  test('AC4: error al cargar los movimientos con «Reintentar», sin texto crudo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page, { detalles: { 'b-1': detalle(ANDINOS) } });
    let falla = true;
    await page.route(/\/api\/flito\/bolsas\/\d+\/movimientos/, (r) =>
      (falla ? json(r, { error: 'boom interno del libro' }, 500) : json(r, [mov('m-1')])));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(d.getByText('No pudimos cargar los movimientos de la bolsa. Intenta de nuevo.')).toBeVisible();
    await expect(d.getByText('boom interno del libro')).toHaveCount(0);
    falla = false;
    await d.getByRole('button', { name: 'Reintentar' }).click();
    await expect(d.getByRole('region', { name: 'Movimientos de la bolsa' })).toBeVisible();
  });

  test('AC7: sin crear / editar / inactivar los botones no existen en el DOM', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SOLO_VER });
    await mock(page, { detalles: { 'b-1': detalle(ANDINOS), 'b-3': detalle(RENTACAR) } });
    await page.goto('/flito/bolsas');
    await expect(page.getByRole('region', { name: 'Bolsas de compañías' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Crear bolsa' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
    const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
    await expect(d.getByText('Descuenta:')).toBeVisible();
    await expect(d.getByRole('button', { name: 'Editar conceptos' })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Inactivar', exact: true })).toHaveCount(0);
    await d.getByRole('button', { name: 'Cerrar' }).first().click();
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de RENTACAR NORTE (compañía)' }).click();
    const d2 = page.getByRole('dialog', { name: 'RENTACAR NORTE' });
    await expect(d2.getByTestId('aviso-inactiva')).toContainText('alguien con permiso tiene que reactivarla primero');
    await expect(d2.getByRole('button', { name: 'Reactivar bolsa' })).toHaveCount(0);
  });

  for (const vista of [{ w: 1366, h: 768 }, { w: 375, h: 812 }]) {
    test(`AC9: el detalle se desplaza hasta el final con teclado, sin scroll horizontal (${vista.w}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vista.w, height: vista.h });
      await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
      await mock(page, {
        detalles: { 'b-1': detalle(ANDINOS) },
        movimientos: Array.from({ length: 60 }, (_, i) => mov(`m-${i}`, { fecha: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` })),
      });
      await page.goto('/flito/bolsas');
      await page.getByRole('button', { name: 'Ver el detalle de la bolsa de TRANSPORTES ANDINOS (compañía)' }).click();
      const d = page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' });
      const region = d.getByTestId('region-detalle');
      await expect(region.getByText('Totales de lo filtrado')).toBeAttached();

      const medidas = await region.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
      expect(medidas.sh).toBeGreaterThan(medidas.ch);
      expect(medidas.sw).toBeLessThanOrEqual(medidas.cw);

      await region.focus();
      await page.keyboard.press('End');
      await expect.poll(() => region.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 2)).toBe(true);
      await expect(d.getByRole('heading', { name: 'TRANSPORTES ANDINOS' }).first()).toBeInViewport();
      await expect(d.getByRole('button', { name: 'Cerrar' }).first()).toBeInViewport();
      await expect(region.getByText('Totales de lo filtrado')).toBeInViewport();
    });
  }
});

// ─────────────────────────── HU #13908 — tránsito ───────────────────────────
//
// Bolsas de tránsito en el catálogo único (Feature #13887). Spec UX: docs/ux/flito-bolsas-transito-13908-slim.md.
// Backend mockeado con el contrato de la HU #13907 (`/bolsa/:id/*`, nunca `/bolsas/transito/*`).

const TRANSITO = [
  'bolsas.transito.listar', 'bolsas.transito.crear', 'bolsas.transito.ver', 'bolsas.transito.editar',
  'bolsas.transito.inactivar', 'bolsas.transito.ver_movimientos', 'bolsas.transito.cargar',
  'bolsas.transito.cierres.ver', 'bolsas.transito.cierre.crear',
];
const CON_TRANSITO = [...TODAS, ...TRANSITO];

const SECRETARIAS = [
  { codigo: '11001', nombre: 'Secretaría de Movilidad', ciudad: 'Bogotá', alias: 'Secretaría de Movilidad de Bogotá' },
  { codigo: '76001', nombre: 'Secretaría de Tránsito', ciudad: 'Cali', alias: 'Secretaría de Tránsito de Cali' },
  { codigo: '05001', nombre: 'Secretaría de Movilidad', ciudad: 'Medellín', alias: null },
];

const datosT = (nivel: string, deuda = 0) => ({ nivel, deuda, totalCargado: 40000000, totalConsumido: 27600000 });
const tr = (o: Record<string, unknown>) => ({
  alcance: 'transito', companiaId: null, companiaNombre: null, conceptos: ['derecho', 'impuesto'],
  cobertura: [{ organismoCodigo: '11001', concepto: 'derecho' }, { organismoCodigo: '11001', concepto: 'impuesto' }],
  ultimaEntradaValor: null, ultimaEntradaEn: null, nivel: 'normal', porcentaje: null, transito: datosT('normal'), ...o,
});
const CENTRO = tr({ id: 't-1', nombre: 'Bolsa Centro', activa: true, saldo: 12400000 });
const OCCIDENTE = tr({ id: 't-2', nombre: 'Bolsa Occidente', activa: true, saldo: -850000, transito: datosT('en_prestamo', 850000) });
const COSTA = tr({ id: 't-3', nombre: 'Bolsa Costa', activa: false, saldo: 0, transito: datosT('agotada') });
const TODAS_LAS_FILAS = [...FILAS, CENTRO, OCCIDENTE, COSTA];

const detalleT = (r: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...r, inactivadaEn: null, inactivadaPorNombre: null, motivoInactivacion: null,
  conceptosAutogestionados: [], paresAutogestionados: [], ...extra,
});

function movT(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, bolsaId: 't-1', tipo: 'salida', origen: 'automatico', concepto: 'derecho', organismoCodigo: '11001',
    tramiteId: null, idFlit: null, valor: 150000, saldoResultante: 12400000, fecha: '2026-10-05',
    observacion: null, soporteId: null, registradoPorNombre: 'Ana Pérez', createdAt: '2026-10-05T15:00:00.000Z', ...extra,
  };
}
function cierreT(periodo: string, extra: Record<string, unknown> = {}) {
  return {
    id: `c-${periodo}`, bolsaId: 't-1', periodo, saldoInicial: 10000000, totalEntradas: 5000000, totalSalidas: 2600000,
    saldoFinal: 12400000, movimientos: 14, observaciones: null, cerradoPorNombre: 'Ana Pérez',
    cerradoEn: '2026-12-01T14:00:00.000Z', ...extra,
  };
}

interface OptsT {
  detalles?: Record<string, unknown>;
  movimientos?: unknown[];
  cierres?: unknown[];
}

/** Rutas propias del detalle de tránsito. Se registran DESPUÉS de `mock`: en Playwright gana la última. */
async function mockTransito(page: Page, o: OptsT = {}) {
  const detalles: Record<string, unknown> = o.detalles ?? {
    't-1': detalleT(CENTRO), 't-2': detalleT(OCCIDENTE), 't-3': detalleT(COSTA, {
      inactivadaEn: '2026-10-12T20:40:00.000Z', inactivadaPorNombre: 'Ana Pérez', motivoInactivacion: 'Fin del convenio',
    }),
  };
  await mock(page, { filas: TODAS_LAS_FILAS, detalles });
  await page.route(/\/api\/transito\/organismos-config/, (r) => json(r, SECRETARIAS));
  await page.route(/\/api\/flito\/bolsas\/bolsa\/[^/]+\/movimientos$/, (r) => json(r, o.movimientos ?? [movT('m-1')]));
  await page.route(/\/api\/flito\/bolsas\/bolsa\/[^/]+\/cierres$/, (r) => json(r, o.cierres ?? []));
  return detalles;
}

const abrirDetalle = async (page: Page, nombre: string) => {
  await page.getByRole('button', { name: `Ver el detalle de la bolsa ${nombre} (tránsito)` }).click();
  return page.getByRole('dialog', { name: nombre, exact: true });
};

test.describe('FLITO — Bolsas · bolsa de tránsito en el catálogo único (HU #13908)', () => {
  test('AC1 · tránsito: crear con nombre, cobros y secretarías → aviso cerrable y detalle de la bolsa nueva activa', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    const nueva = detalleT(tr({ id: 't-9', nombre: 'Norte', activa: true, saldo: 0, transito: datosT('sin_cargas'),
      conceptos: ['impuesto'], cobertura: [{ organismoCodigo: '76001', concepto: 'impuesto' }] }));
    await mockTransito(page, { detalles: { 't-9': nueva } });
    let cuerpo: unknown = null;
    await page.route(/\/api\/flito\/bolsas$/, (r) => { cuerpo = r.request().postDataJSON(); return json(r, nueva, 201); });
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByRole('radio', { name: /Tránsito/ }).check();
    await expect(modal.getByRole('button', { name: 'Continuar' })).toHaveCount(0);
    const crear = modal.getByRole('button', { name: 'Crear bolsa' });
    await expect(crear).toBeDisabled();
    await modal.getByLabel('Nombre *').fill('Norte');
    await modal.getByRole('checkbox', { name: 'Impuestos' }).check();
    await modal.getByRole('checkbox', { name: 'Secretaría de Tránsito de Cali' }).check();
    await crear.click();

    expect(cuerpo).toEqual({ alcance: 'transito', nombre: 'Norte', organismos: ['76001'], conceptos: ['impuesto'] });
    const aviso = page.getByRole('status').filter({ hasText: 'Bolsa Norte creada.' });
    await expect(aviso).toBeVisible();
    const detalle = page.getByRole('dialog', { name: 'Norte', exact: true });
    await expect(detalle.getByText('Activa', { exact: true })).toBeVisible();
    await aviso.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(aviso).toHaveCount(0);
  });

  test('AC2 · tránsito: pareja ocupada → se señala con el nombre de la otra bolsa y se conserva lo escrito', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    await mockTransito(page);
    await page.route(/\/api\/flito\/bolsas$/, (r) => json(r, {
      error: 'cobertura ocupada: 11001/impuesto', codigo: 'cobertura_ocupada',
      pares: [{ organismoCodigo: '11001', concepto: 'impuesto', bolsaId: 't-1', bolsaNombre: 'Bolsa Centro' }],
    }, 409));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByRole('radio', { name: /Tránsito/ }).check();
    await modal.getByLabel('Nombre *').fill('Bolsa Sur');
    await modal.getByRole('checkbox', { name: 'Impuestos' }).check();
    await modal.getByRole('checkbox', { name: 'SOAT' }).check();
    await modal.getByRole('checkbox', { name: 'Secretaría de Movilidad de Bogotá' }).check();
    await modal.getByRole('button', { name: 'Crear bolsa' }).click();

    const aviso = modal.getByTestId('aviso-cobertura-ocupada');
    await expect(aviso).toContainText('Secretaría de Movilidad de Bogotá · Impuestos — en «Bolsa Centro»');
    await expect(modal.getByTestId('secretaria-11001')).toContainText('Ya la cubre «Bolsa Centro» para Impuestos.');
    await expect(modal.getByText(/cobertura ocupada: 11001/)).toHaveCount(0);
    await expect(modal.getByLabel('Nombre *')).toHaveValue('Bolsa Sur');
    await expect(modal.getByRole('checkbox', { name: 'Impuestos' })).toBeChecked();
    await expect(modal.getByRole('checkbox', { name: 'Secretaría de Movilidad de Bogotá' })).toBeChecked();
    await expect(modal.getByRole('button', { name: 'Crear bolsa' })).toBeDisabled();
    // Al desmarcar el cobro en conflicto, la pareja sale del aviso y se puede volver a guardar.
    await modal.getByRole('checkbox', { name: 'Impuestos' }).uncheck();
    await expect(aviso).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Crear bolsa' })).toBeEnabled();
  });

  test('AC3 · tránsito: Alcance «Tránsito» + Estado «Inactivas» → solo tránsito inactivas, sin celda de expediente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...CON_TRANSITO, 'bolsas.documentos.ver'] });
    await mockTransito(page);
    const buscar: Array<{ url: string; body: { alcance?: string; activa?: boolean } }> = [];
    page.on('request', (rq) => {
      if (/\/api\/flito\/bolsas\/buscar/.test(rq.url())) buscar.push({ url: rq.url(), body: rq.postDataJSON() ?? {} });
    });
    await page.route(/\/api\/flito\/bolsas-documentos\/estado-lote/, (r) => json(r, { error: 'boom' }, 500));
    await page.goto('/flito/bolsas');

    // Con «Todas», las dos tablas; la de compañías conserva su columna Expediente y la de tránsito no la tiene.
    const companias = page.getByRole('region', { name: 'Bolsas de compañías' });
    const transitos = page.getByRole('region', { name: 'Bolsas de tránsito' });
    await expect(transitos.getByText('Bolsa Centro')).toBeVisible();
    await expect(transitos.getByText(/−\s*\$\s*850\.000/)).toBeVisible();
    await expect(transitos.getByText('En préstamo')).toBeVisible();
    await expect(companias.getByRole('columnheader', { name: /Expediente/ })).toHaveCount(1);
    await expect(transitos.getByRole('columnheader', { name: /Expediente/ })).toHaveCount(0);
    await expect(transitos.getByRole('columnheader')).toHaveCount(5);

    await page.getByRole('group', { name: 'Alcance de la bolsa' }).getByRole('button', { name: 'Tránsito' }).click();
    await page.getByRole('group', { name: 'Estado de la bolsa' }).getByRole('button', { name: 'Inactivas' }).click();
    await expect.poll(() => buscar.some((b) => b.body.alcance === 'transito' && b.body.activa === false)).toBe(true);
    expect(buscar.every((b) => !b.url.includes('?'))).toBe(true);
    await expect(transitos.getByText('Bolsa Costa')).toBeVisible();
    await expect(transitos.getByText('Bolsa Centro')).toHaveCount(0);
    await expect(transitos.locator('tbody tr')).toHaveCount(1);
    await expect(companias).toHaveCount(0);
  });

  test('AC4 · tránsito: inactivar con motivo ≥ 5 deja la carga deshabilitada; reactivar con pareja tomada avisa y sigue inactiva', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    const detalles = await mockTransito(page);
    let motivo: unknown = null;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/inactivar$/, (r) => {
      motivo = r.request().postDataJSON();
      detalles['t-1'] = detalleT({ ...CENTRO, activa: false }, {
        inactivadaEn: '2026-10-12T20:40:00.000Z', inactivadaPorNombre: 'Ana Pérez', motivoInactivacion: 'Cambio de operador',
      });
      return json(r, detalles['t-1']);
    });
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/reactivar$/, (r) => json(r, {
      error: 'crudo', codigo: 'cobertura_ocupada',
      pares: [{ organismoCodigo: '11001', concepto: 'derecho', bolsaId: 't-2', bolsaNombre: 'Bolsa Occidente' }],
    }, 409));
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByRole('button', { name: 'Cargar saldo' })).toBeEnabled();

    await d.getByRole('button', { name: 'Inactivar', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'Inactivar la bolsa Bolsa Centro' });
    await expect(m).toContainText('sus secretarías quedan libres para otra bolsa');
    await m.getByLabel('Motivo *').fill('  abcd ');
    await expect(m.getByRole('button', { name: 'Inactivar bolsa' })).toBeDisabled();
    await m.getByLabel('Motivo *').fill('Cambio de operador');
    await m.getByRole('button', { name: 'Inactivar bolsa' }).click();
    expect(motivo).toEqual({ motivo: 'Cambio de operador' });

    await expect(d.getByTestId('aviso-inactiva')).toContainText('Reactiva la bolsa primero.');
    await expect(d.getByText('Inactiva', { exact: true })).toBeVisible();
    const cargar = d.getByRole('button', { name: 'Cargar saldo' });
    await expect(cargar).toBeDisabled();
    await expect(cargar).toHaveAccessibleDescription(/Reactiva la bolsa primero/);
    await expect(d.getByRole('button', { name: 'Editar cobertura' })).toHaveCount(0);

    await d.getByRole('button', { name: 'Reactivar bolsa' }).click();
    const r = page.getByRole('dialog', { name: 'Reactivar la bolsa Bolsa Centro' });
    await r.getByLabel('Motivo *').fill('Vuelve el operador');
    await r.getByRole('button', { name: 'Reactivar bolsa' }).click();
    await expect(r).toHaveCount(0);
    const conflicto = d.getByTestId('aviso-reactivar-conflicto');
    await expect(conflicto).toContainText('No pudimos reactivarla: otra bolsa activa ya cubre estas secretarías para el mismo cobro.');
    await expect(conflicto).toContainText('Derechos de tránsito — en «Bolsa Occidente»');
    await expect(d.getByText('crudo')).toHaveCount(0);
    await expect(d.getByText('Inactiva', { exact: true })).toBeVisible();
    await conflicto.getByRole('button', { name: 'Ver «Bolsa Occidente»' }).click();
    await expect(page.getByRole('dialog', { name: 'Bolsa Occidente', exact: true })).toBeVisible();
  });

  test('AC5 · tránsito: cerrar 2026-11 lo suma a cierres con totales; ya cerrado avisa sin error crudo', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-12-05T15:00:00.000Z'));
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    await mockTransito(page);
    const cierres: unknown[] = [];
    const pedidos: unknown[] = [];
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/cierres$/, (r) => {
      if (r.request().method() === 'GET') return json(r, cierres);
      const body = r.request().postDataJSON() as { periodo: string };
      pedidos.push(body);
      if (body.periodo === '2026-10') return json(r, { error: 'periodo 2026-10 cerrado', codigo: 'periodo_cerrado' }, 409);
      const c = cierreT(body.periodo);
      cierres.push(c);
      return json(r, c, 201);
    });
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByTestId('cierres-transito-vacio')).toContainText('Usa «Cerrar un mes»');

    await d.getByRole('button', { name: 'Cerrar un mes' }).click();
    const m = page.getByRole('dialog', { name: 'Cerrar un mes de Bolsa Centro' });
    await expect(m.getByLabel('Mes *')).toHaveValue('2026-11');
    await m.getByRole('button', { name: 'Cerrar noviembre de 2026' }).click();
    expect(pedidos[0]).toEqual({ periodo: '2026-11' });
    await expect(page.getByRole('status').filter({ hasText: 'Noviembre de 2026 cerrado.' })).toBeVisible();
    const fila = d.getByRole('region', { name: 'Cierres de la bolsa de tránsito' }).getByRole('row', { name: /Noviembre de 2026/ });
    await expect(fila).toContainText(/12\.400\.000/);
    await expect(fila).toContainText('14');

    // Carrera: otro lo cerró antes. Aviso en el modal, nunca el texto del servidor.
    await d.getByRole('button', { name: 'Cerrar un mes' }).click();
    await expect(m.getByLabel('Mes *')).toHaveValue('2026-10');
    await expect(m.getByRole('option', { name: 'Noviembre de 2026' })).toHaveCount(0);
    await m.getByRole('button', { name: 'Cerrar octubre de 2026' }).click();
    await expect(m.getByRole('alert')).toHaveText('Octubre de 2026 ya estaba cerrado. Lo verás en la lista de cierres.');
    await expect(m.getByText(/periodo 2026-10 cerrado/)).toHaveCount(0);
    await expect(m.getByRole('option', { name: 'Octubre de 2026' })).toHaveCount(0);
  });

  test('AC5 · tránsito: sin bolsas.transito.cierre.crear no existe «Cerrar un mes»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO.filter((f) => f !== 'bolsas.transito.cierre.crear') });
    await mockTransito(page, { cierres: [cierreT('2026-09')] });
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByRole('region', { name: 'Cierres de la bolsa de tránsito' })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Cerrar un mes' })).toHaveCount(0);
  });

  test('AC6 · tránsito: movimientos con carga, error con «Reintentar» propio y contenido; cierres vacíos', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    await mockTransito(page);
    let falla = true;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/movimientos$/, async (r) => {
      if (!falla) return json(r, [movT('m-1')]);
      await new Promise((res) => setTimeout(res, 600));
      return json(r, { error: 'boom libro' }, 500);
    });
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByRole('status', { name: 'Cargando los movimientos' })).toBeVisible();
    await expect(d.getByText('No pudimos cargar los movimientos de la bolsa. Intenta de nuevo.')).toBeVisible();
    await expect(d.getByText('boom libro')).toHaveCount(0);
    // El error es solo de su sección: los cierres siguen a la vista.
    await expect(d.getByTestId('cierres-transito-vacio')).toBeVisible();
    falla = false;
    await d.getByRole('button', { name: 'Reintentar' }).click();
    await expect(d.getByRole('region', { name: 'Movimientos de la bolsa de tránsito' }).getByText('Pago de derechos de tránsito')).toBeVisible();
  });

  test('AC6 · tránsito: cierres con error y «Reintentar» propio; movimientos vacíos con el siguiente paso', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    await mockTransito(page, { movimientos: [] });
    let falla = true;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/cierres$/, (r) =>
      (falla ? json(r, { error: 'boom cierres' }, 500) : json(r, [cierreT('2026-09')])));
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByTestId('movimientos-transito-vacio'))
      .toHaveText('Esta bolsa todavía no tiene movimientos. Empieza con «Cargar saldo».');
    await expect(d.getByText('No pudimos cargar los cierres. Intenta de nuevo.')).toBeVisible();
    await expect(d.getByText('boom cierres')).toHaveCount(0);
    falla = false;
    await d.getByRole('button', { name: 'Reintentar' }).click();
    await expect(d.getByRole('region', { name: 'Cierres de la bolsa de tránsito' }).getByText('Septiembre de 2026')).toBeVisible();
  });

  test('AC7 · tránsito: listado, detalle, edición y carga sin una sola llamada a /api/flito/bolsas/transito/', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    await mockTransito(page);
    const viejas: string[] = [];
    page.on('request', (rq) => { if (/\/api\/flito\/bolsas\/transito(\/|$|\?)/.test(rq.url())) viejas.push(rq.url()); });
    let carga: string | null = null;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1\/recargas$/, (r) => {
      carga = r.request().headers()['content-type'] ?? '';
      return json(r, { saldo: 12500000 }, 201);
    });
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await d.getByRole('button', { name: 'Cargar saldo' }).click();
    const m = page.getByRole('dialog', { name: 'Cargar saldo a Bolsa Centro' });
    await m.getByLabel('Valor de la carga *').fill('100000');
    await m.getByRole('button', { name: 'Registrar carga' }).click();
    await expect(m).toHaveCount(0);
    expect(carga).toContain('multipart/form-data');
    await d.getByRole('button', { name: 'Editar cobertura' }).click();
    await expect(page.getByRole('dialog', { name: 'Editar la bolsa Bolsa Centro' })).toBeVisible();
    expect(viejas).toEqual([]);
  });

  for (const vista of [{ w: 1366, h: 768 }, { w: 375, h: 812 }]) {
    test(`AC8 · tránsito: el detalle llega al último movimiento y a los cierres, sin scroll horizontal (${vista.w}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vista.w, height: vista.h });
      await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
      await mockTransito(page, {
        movimientos: Array.from({ length: 60 }, (_, i) => movT(`m-${i}`, { fecha: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` })),
        cierres: [cierreT('2026-09'), cierreT('2026-08')],
      });
      await page.goto('/flito/bolsas');
      const d = await abrirDetalle(page, 'Bolsa Centro');
      const region = d.getByTestId('region-detalle');
      const cierres = d.getByRole('region', { name: 'Cierres de la bolsa de tránsito' });
      await expect(cierres).toBeAttached();

      const medidas = await region.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
      expect(medidas.sh).toBeGreaterThan(medidas.ch);
      expect(medidas.sw).toBeLessThanOrEqual(medidas.cw);

      // Rueda.
      await region.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      // Teclado.
      await region.focus();
      await page.keyboard.press('End');
      await expect.poll(() => region.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 2)).toBe(true);
      await expect(cierres.getByText('Agosto de 2026')).toBeInViewport();
      await expect(d.getByRole('heading', { name: 'Bolsa Centro' }).first()).toBeInViewport();
      await expect(d.getByRole('button', { name: 'Cerrar' }).first()).toBeInViewport();
    });
  }

  test('AC9 · tránsito: secretaría autogestionada con impuesto → aviso en detalle y edición; se puede guardar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_TRANSITO });
    const centro = detalleT(CENTRO, { paresAutogestionados: [{ organismoCodigo: '11001', concepto: 'impuesto' }] });
    await mockTransito(page, { detalles: { 't-1': centro } });
    let cuerpo: unknown = null;
    await page.route(/\/api\/flito\/bolsas\/bolsa\/t-1$/, (r) => {
      if (r.request().method() === 'PATCH') { cuerpo = r.request().postDataJSON(); return json(r, centro); }
      return json(r, centro);
    });
    const AVISO = /este organismo es autogestionado para impuestos: no llegarán movimientos de impuesto a la bolsa salvo excepciones/i;
    await page.goto('/flito/bolsas');
    const d = await abrirDetalle(page, 'Bolsa Centro');
    await expect(d.getByTestId('aviso-autogestion-transito')).toContainText(AVISO);

    await d.getByRole('button', { name: 'Editar cobertura' }).click();
    const f = page.getByRole('dialog', { name: 'Editar la bolsa Bolsa Centro' });
    await expect(f.getByText('Alcance')).toBeVisible();
    await expect(f.getByTestId('aviso-autogestion-transito')).toContainText(AVISO);
    const guardar = f.getByRole('button', { name: 'Guardar cambios' });
    await expect(guardar).toBeDisabled();
    await f.getByRole('checkbox', { name: 'Secretaría de Tránsito de Cali' }).check();
    await expect(guardar).toBeEnabled();
    await guardar.click();
    expect(cuerpo).toEqual({ alcance: 'transito', nombre: 'Bolsa Centro', organismos: ['11001', '76001'], conceptos: ['derecho', 'impuesto'] });
    await expect(page.getByRole('status').filter({ hasText: 'Cobertura de la bolsa actualizada.' })).toBeVisible();
    // Sin impuesto marcado, el aviso desaparece del formulario.
    await d.getByRole('button', { name: 'Editar cobertura' }).click();
    await f.getByRole('checkbox', { name: 'Impuestos' }).uncheck();
    await expect(f.getByTestId('aviso-autogestion-transito')).toHaveCount(0);
  });
});
