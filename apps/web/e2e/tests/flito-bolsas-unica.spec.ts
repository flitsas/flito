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
  transito?: unknown[];
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
  await page.route(/\/api\/flito\/bolsas\/transito$/, (r) => json(r, o.transito ?? []));
  await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => {
    buscar.push({ url: r.request().url(), body: r.request().postDataJSON() });
    return json(r, o.filas ?? FILAS);
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

  test('AC2: la rama Tránsito es provisional y «Continuar» abre el formulario de tránsito actual', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: TODAS });
    await mock(page);
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const modal = page.getByRole('dialog', { name: 'Crear bolsa' });
    await modal.getByRole('radio', { name: /Tránsito/ }).check();
    await expect(modal.getByText(/se crean, por ahora, con su formulario propio/)).toBeVisible();
    await modal.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('dialog', { name: 'Crear bolsa', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Crear bolsa de tránsito' })).toBeVisible();
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
