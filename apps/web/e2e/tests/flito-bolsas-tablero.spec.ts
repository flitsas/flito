import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, PROVEEDOR_USER } from '../helpers/auth';
import { FUNCIONES_BOLSAS, mockCatalogoBolsas } from '../helpers/bolsas';

// HU #11127 — Tablero de saldos por cliente. Quién necesita recarga, sin revisar trámite por
// trámite. Backend mockeado.
//
// HU #13901: el acordeón de compañías pasa de rejilla de tarjetas a tabla alimentada por
// `POST /buscar`, y «Abrir bolsa» (la bolsa nacía con la primera recarga) se retira: el alta es
// explícita con «Crear bolsa» (cubierto en `flito-bolsas-unica.spec.ts`). Se retiran a propósito los
// tests de la tarjeta (entradas/salidas del periodo por fila, que la spec UX saca del listado) y los
// del botón «+» de `BolsaAbrirCliente`.

const CRITICO = {
  id: 'b1', companiaId: 1, companiaNombre: 'ACME SAS', saldo: 300000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-07-01T10:00:00.000Z',
  nivel: 'critico', porcentaje: 6,
};
const BAJO = {
  id: 'b2', companiaId: 2, companiaNombre: 'TRANSPORTES DEL SUR', saldo: 1200000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-06-20T10:00:00.000Z',
  nivel: 'bajo', porcentaje: 24,
};
const NORMAL = {
  id: 'b3', companiaId: 3, companiaNombre: 'LOGISTICA ANDINA', saldo: 4500000,
  ultimaRecargaValor: 5000000, ultimaRecargaEn: '2026-07-15T10:00:00.000Z',
  nivel: 'normal', porcentaje: 90,
};

// `/buscar` llega YA ordenado: el orden lo pone el servidor.
const RIESGO = [CRITICO, BAJO, NORMAL];

const ALERTAS = {
  saldo: [
    {
      tipo: 'saldo', nivel: 'critico', companiaId: 1, companiaNombre: 'ACME SAS',
      saldo: 300000, porcentaje: 6, mensaje: 'ACME SAS tiene saldo crítico: 6 % de su última recarga.',
    },
  ],
  conciliacion: { soportesSinTramite: 4, movimientosSinSoporte: 2 },
};

async function mock(page: import('@playwright/test').Page, opts: { bolsas?: typeof RIESGO } = {}) {
  const bolsas = opts.bolsas ?? RIESGO;
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientes: bolsas.length, saldoTotal: 6000000 }) }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.bolsas ? { saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0 } } : ALERTAS) }));
  await page.route(/\/api\/flito\/bolsas\/(\d+)\/extracto/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      companiaId: 1, saldoActual: 300000, totalEntradas: 5000000, totalSalidas: 4700000,
      porOrganismo: [], porConcepto: [],
    }) }));
  await page.route(/\/api\/flito\/bolsas\/\d+\/(movimientos|cierres)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/clients/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'ACME SAS' }]) }));
  await mockCatalogoBolsas(page, bolsas);
}

test.describe('FLITO — Bolsas · tablero', () => {
  test('cada compañía tiene su fila con estado, saldo y nivel', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: FUNCIONES_BOLSAS });
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: 'Bolsas' })).toBeVisible();
    const tabla = page.getByRole('region', { name: 'Bolsas de compañías' });
    await expect(tabla.getByText('ACME SAS')).toBeVisible();
    await expect(tabla.getByText('Saldo crítico')).toBeVisible();
    await expect(tabla.getByText('Saldo bajo')).toBeVisible();
    await expect(tabla.getByText('Normal')).toBeVisible();
    await expect(tabla.getByText('Activa', { exact: true })).toHaveCount(3);
    await expect(tabla.getByText(/4\.500\.000/)).toBeVisible();
  });

  test('las bolsas en riesgo salen primero, en el orden que manda el servidor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: FUNCIONES_BOLSAS });
    await mock(page);
    await page.goto('/flito/bolsas');

    // Reordenar en la pantalla abriría la puerta a que dos vistas del mismo dato prioricen distinto.
    const filas = page.getByRole('region', { name: 'Bolsas de compañías' }).locator('tbody tr td:first-child');
    await expect(filas).toHaveText(['ACME SAS', 'TRANSPORTES DEL SUR', 'LOGISTICA ANDINA']);
  });

  test('el panel de alertas dice el motivo y lleva al detalle de la compañía', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: FUNCIONES_BOLSAS });
    await mock(page);

    await page.goto('/flito/bolsas');
    // El motivo lo redacta el servidor: es el mismo texto que verá quien reciba la alerta por otro canal.
    await expect(page.getByText('ACME SAS tiene saldo crítico: 6 % de su última recarga.')).toBeVisible();
    await expect(page.getByText(/4 soporte\(s\) sin trámite/)).toBeVisible();

    // El detalle es un modal SOBRE el tablero (HU #11210): al cerrarlo se sigue donde se estaba.
    // La alerta va antes que la tabla: el primer «Ver detalle» de ACME es el de la alerta.
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa de ACME SAS (compañía)' }).first().click();
    const modal = page.getByRole('dialog', { name: 'ACME SAS' });
    await expect(modal.getByText('Consumo por organismo de tránsito')).toBeVisible();
    await modal.getByRole('button', { name: /Cerrar/ }).first().click();
    await expect(page.getByRole('region', { name: 'Bolsas de compañías' })).toBeVisible();
  });

  test('sin ninguna bolsa se explica cómo crear la primera, sin error ni tabla vacía', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: FUNCIONES_BOLSAS });
    await mock(page, { bolsas: [] });
    await page.goto('/flito/bolsas');

    await expect(page.getByTestId('bolsas-vacio-total')).toContainText('Todavía no hay bolsas');
    await expect(page.getByTestId('bolsas-vacio-total').getByRole('button', { name: 'Crear bolsa' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('todo vive en una sola vista: ya no hay pestañas que saltar', async ({ page }) => {
    // HU #13908: el acordeón Tránsitos sale con `bolsas.transito.listar`.
    await loginAs(page, FINANCIERA_USER, { funciones: [...FUNCIONES_BOLSAS, 'bolsas.transito.listar'] });
    await mock(page);
    await page.goto('/flito/bolsas');

    // La HU #11210 retira «Cliente» y «Organismos»: compañías y tránsitos conviven en acordeones.
    await expect(page.getByRole('button', { name: 'Cliente', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Organismos', exact: true })).toHaveCount(0);
    // `\(`: el acordeón lleva el contador; el segmentado Alcance también tiene un botón «Compañías».
    await expect(page.getByRole('button', { name: /^Compañías\s*\(/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /^Tránsitos/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('el acordeón se pliega y su contenido sale del DOM, no solo de la vista', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: FUNCIONES_BOLSAS });
    await mock(page);
    await page.goto('/flito/bolsas');

    await page.getByRole('button', { name: /^Compañías/ }).click();
    await expect(page.getByRole('button', { name: /^Compañías/ })).toHaveAttribute('aria-expanded', 'false');
    // Desmontado y no oculto: si solo se escondiera, sus botones seguirían en el orden de tabulación.
    await expect(page.getByRole('region', { name: 'Bolsas de compañías' })).toHaveCount(0);
  });

  test('un rol distinto de admin o financiera no entra ni por URL directa', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/bolsas');

    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Bolsas/ })).toBeVisible();
    // Ni un solo importe: la pantalla no llega a pedir nada.
    await expect(page.getByText('ACME SAS')).toHaveCount(0);
  });
});
