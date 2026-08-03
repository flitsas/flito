import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';

// HU #11162 — Bolsa prepago del Organismo de Tránsito. Backend mockeado.
//
// Sustituye a la cobertura del estado de cuenta de la HU #11130. Lo que se comprueba, además de las
// cifras, es que la pantalla se lea en el sentido CORRECTO: un saldo que FLIT precarga y la
// secretaría consume, no una deuda que crece. Y que un organismo sin bolsa no ofrezca nada que
// mover, porque a esos FLIT nunca les transfiere dinero.

const MEDELLIN_BOLSA = {
  id: 'ob-1', organismoCodigo: '05001', saldo: 2_500_000,
  ultimaCargaValor: 10_000_000, ultimaCargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 25, deuda: 0,
  totalCargado: 10_000_000, totalConsumido: 7_500_000,
};

/** Mismo organismo, ya en préstamo: el caso que distingue esta bolsa de la del cliente. */
const MEDELLIN_PRESTAMO = {
  ...MEDELLIN_BOLSA, saldo: -4_000_000, nivel: 'en_prestamo', porcentaje: -40, deuda: 4_000_000,
  totalCargado: 10_000_000, totalConsumido: 14_000_000,
};

const MOVIMIENTOS = [
  {
    id: 'm2', organismoCodigo: '05001', tipo: 'salida', origen: 'automatico',
    tramiteId: 'aaaa1111-0000-0000-0000-000000000001', idFlit: 'FLIT-3001',
    valor: 7_500_000, saldoResultante: 2_500_000, periodo: '2026-07', fecha: '2026-07-10',
    observacion: null, soporteId: null, registradoPorNombre: 'sistema',
    createdAt: '2026-07-10T10:00:00.000Z',
  },
  {
    id: 'm1', organismoCodigo: '05001', tipo: 'entrada', origen: 'carga',
    tramiteId: null, idFlit: null,
    valor: 10_000_000, saldoResultante: 10_000_000, periodo: '2026-07', fecha: '2026-07-01',
    observacion: 'Transferencia del 01/07', soporteId: 'sop-10', registradoPorNombre: 'Financiera E2E',
    createdAt: '2026-07-01T10:00:00.000Z',
  },
];

async function mock(page: import('@playwright/test').Page, bolsa = MEDELLIN_BOLSA) {
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: 1, saldoTotal: 1300000 }) }));
  await page.route(/\/api\/flito\/bolsas\/riesgo/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } }) }));

  // Medellín lleva bolsa; Cali (76001) no: su GET responde 404, que es como el backend dice
  // «este organismo no maneja bolsa prepago».
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/bolsa$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bolsa) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/movimientos$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOVIMIENTOS) }));
  await page.route(/\/api\/flito\/bolsas\/organismos\/76001\/bolsa$/, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Este Organismo de Tránsito no maneja bolsa prepago' }) }));
}

async function elegirOrganismo(page: import('@playwright/test').Page, ciudad: string) {
  await page.getByRole('button', { name: 'Organismo de tránsito de la bolsa' }).click();
  await page.getByRole('option', { name: new RegExp(ciudad) }).locator('button').click();
}

async function abrirOrganismos(page: import('@playwright/test').Page) {
  await page.goto('/flito/bolsas');
  await page.getByRole('button', { name: 'Organismos', exact: true }).click();
}

test.describe('FLITO — Bolsas · bolsa prepago del organismo', () => {
  // ── AC2 ───────────────────────────────────────────────────────────────────
  test('muestra el saldo disponible con lo cargado y lo consumido', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    await expect(page.getByText('Saldo disponible')).toBeVisible();
    await expect(page.getByText(/2\.500\.000/).first()).toBeVisible();
    await expect(page.getByText('Total cargado')).toBeVisible();
    await expect(page.getByText('Total consumido')).toBeVisible();
    await expect(page.getByText(/7\.500\.000/).first()).toBeVisible();
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  test('avisa del saldo bajo con texto, no solo con color', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const alerta = page.getByTestId('alerta-nivel-organismo');
    await expect(alerta).toBeVisible();
    // El nivel va escrito: quien no distinga el color se quedaría sin la información entera.
    await expect(alerta).toContainText('Saldo bajo');
    await expect(alerta).toContainText('25 %');
    // Urgente ⇒ el lector de pantalla lo anuncia sin que el usuario tenga que ir a buscarlo.
    await expect(alerta).toHaveAttribute('role', 'alert');
  });

  test('el préstamo se anuncia como deuda, no como saldo', async ({ page }) => {
    // Es la diferencia de fondo con la bolsa del cliente: en negativo lo que importa no es cuánto
    // queda, sino cuánto se le debe al organismo.
    await loginAs(page, FINANCIERA_USER);
    await mock(page, MEDELLIN_PRESTAMO);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const alerta = page.getByTestId('alerta-nivel-organismo');
    await expect(alerta).toContainText('En préstamo');
    await expect(alerta).toContainText(/4\.000\.000/);
    await expect(page.getByText('En préstamo').first()).toBeVisible();
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  test('el libro muestra cada movimiento con su saldo resultante', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const libro = page.getByRole('region', { name: 'Movimientos de la bolsa del organismo' });
    await expect(libro).toBeVisible();

    const carga = libro.getByRole('row').filter({ hasText: 'Carga' });
    await expect(carga).toContainText(/10\.000\.000/);

    const consumo = libro.getByRole('row').filter({ hasText: 'Consumo de derecho' });
    await expect(consumo).toContainText('FLIT-3001');
    // El saldo resultante por fila es lo que permite auditar el libro sin recalcular.
    await expect(consumo).toContainText(/2\.500\.000/);
  });

  test('el consumo enlaza al trámite que lo originó y la carga no', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    const libro = page.getByRole('region', { name: 'Movimientos de la bolsa del organismo' });
    await expect(libro.getByRole('link', { name: 'FLIT-3001' })).toBeVisible();
    // Una carga no cuelga de ningún trámite: no puede ofrecer un enlace a ninguna parte.
    await expect(libro.getByRole('row').filter({ hasText: 'Carga' }).getByRole('link')).toHaveCount(0);
  });

  // ── AC7 ───────────────────────────────────────────────────────────────────
  test('un organismo sin bolsa lo dice y no ofrece cargar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Cali');

    await expect(page.getByTestId('organismo-sin-bolsa')).toBeVisible();
    await expect(page.getByTestId('organismo-sin-bolsa')).toContainText('no maneja bolsa prepago');
    // Ni saldo ni acción: no hay dinero que mover, así que no se insinúa que lo haya.
    await expect(page.getByText('Saldo disponible')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cargar saldo' })).toHaveCount(0);
  });

  // ── AC4 y AC8 ─────────────────────────────────────────────────────────────
  test('registrar una carga actualiza el saldo sin recargar la página', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);

    let cargado = false;
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/cargas$/, (route) => {
      cargado = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ saldo: 12_500_000 }) });
    });
    // Tras la carga, la pantalla vuelve a pedir la bolsa: debe traer el saldo nuevo.
    await page.route(/\/api\/flito\/bolsas\/organismos\/05001\/bolsa$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(cargado
          ? { ...MEDELLIN_BOLSA, saldo: 12_500_000, nivel: 'normal', porcentaje: 125, totalCargado: 20_000_000 }
          : MEDELLIN_BOLSA),
      }));

    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    await page.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByRole('spinbutton').first().fill('10000000');
    await page.getByRole('button', { name: 'Registrar carga' }).click();

    await expect(page.getByText(/12\.500\.000/).first()).toBeVisible();
  });

  test('una carga en cero no se puede enviar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mock(page);
    await abrirOrganismos(page);
    await elegirOrganismo(page, 'Medellín');

    await page.getByRole('button', { name: 'Cargar saldo' }).click();
    await page.getByRole('spinbutton').first().fill('0');

    await expect(page.getByText('El valor de la carga debe ser mayor que cero.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar carga' })).toBeDisabled();
  });

  // ── Permisos ──────────────────────────────────────────────────────────────
  test('un rol sin acceso a Bolsas no ve el módulo', async ({ page }) => {
    // La bolsa es dinero: el Feature la reserva a Administración y Financiera.
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('button', { name: 'Organismos', exact: true })).toHaveCount(0);
  });
});
