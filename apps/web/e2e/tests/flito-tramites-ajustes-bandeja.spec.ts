import { test, expect, type Page } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Gestión Trámites, ajustes de la bandeja (Épica #14707, pedido de David tras el PR B #856):
//  (a) «Columnas» y «Orden» viven en la cabecera del acordeón de Filtros, con la altura del kit (40 px);
//  (b) sin selección no hay nada fijo sobre la tabla y el conteo va junto a la paginación;
//  (c) con selección la barra de lote aparece, es sticky, y desaparece al limpiar;
//  (d) la celda Vehículo vuelve a mostrar placa, «Marca Línea · tipo», VIN y servicio en texto;
//  (e) sin placa: la placa vacía del kit («Sin placa») + VIN, y la casilla nombra el trámite.
// API mockeada.

const base = {
  asignado: true, tipoTramite: 'Traspaso', ciudad: 'Pereira', fechaCreacion: null, fechaAprobacion: null, derechoTramiteValor: null,
  empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true, transitoNombre: 'STT Pereira', facturaVentaFlitId: null,
  companiaNombre: 'Concesionario Norte', organismoNombre: 'STT Pereira', fuente: 'flit', compradorPrincipal: null, compradores: [],
  soatAutogestionado: false, impuestosAutogestionado: false, excepcionesAutogestion: [], listoParaEntregar: false,
  nombreGestor: null, correoGestor: null, logistica: null, estado: 'Asignado', vigenciaTramite: 'vigente', soat: null, impuesto: null,
};
const id = (n: number) => `eeeeeeee-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ESPECIALES = [
  { ...base, tramiteId: id(1), idFlit: '2026-001001',
    vehiculo: { vin: '9FBHSR5A8KM100001', placa: 'KLM482', marca: 'Mazda', linea: '3', tipoVehiculo: 'Automóvil', tipoServicio: 'Particular' } },
  { ...base, tramiteId: id(2), idFlit: '2026-001002',
    vehiculo: { vin: '9FBHSR5A8KM100002', placa: 'ABC12D', marca: 'Yamaha', linea: 'NMAX', tipoVehiculo: 'Motocicleta', tipoServicio: 'Particular' } },
  { ...base, tramiteId: id(3), idFlit: '2026-001003',
    vehiculo: { vin: '9FBHSR5A8KM100003', placa: 'JHU773', marca: 'Kia', linea: 'Picanto', tipoVehiculo: 'Automóvil', tipoServicio: 'Publico' } },
  { ...base, tramiteId: id(4), idFlit: '2026-001004',
    vehiculo: { vin: '9FBHSR5A8KM100004', placa: null, marca: 'Renault', linea: 'Duster', tipoVehiculo: 'Camioneta', tipoServicio: 'Particular' } },
];
// Página llena (50 filas) para que la tabla se desplace y el sticky se vea de verdad.
const RELLENO = Array.from({ length: 46 }, (_, i) => ({ ...base, tramiteId: id(10 + i), idFlit: `2026-0020${String(i).padStart(2, '0')}`,
  vehiculo: { vin: `9FBHSR5A8KM2000${String(i).padStart(2, '0')}`, placa: `RTX${String(100 + i)}`, marca: 'Chevrolet', linea: 'Onix', tipoVehiculo: 'Automóvil', tipoServicio: 'Particular' } }));
const ITEMS = [...ESPECIALES, ...RELLENO];

async function montar(page: Page, total = 1284) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado'], tramites: ['Traspaso'], ciudades: ['Pereira'], transitos: ['STT Pereira'] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: ITEMS.slice(0, Math.min(ITEMS.length, total)), total, page: 1, pageSize: 50, marca: 'm1' }) }));
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('2026-001001')).toBeVisible();
}

const fila = (page: Page, idFlit: string) => page.getByRole('row').filter({ hasText: idFlit });
const cabecera = (page: Page) => page.getByRole('region', { name: 'Búsqueda y filtros' });

test.describe('Épica #14707 — ajustes de la bandeja de Gestión Trámites', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('(a) Columnas y Orden están en la cabecera de Filtros, en la misma línea y a 40 px', async ({ page }) => {
    await montar(page);
    const columnas = cabecera(page).getByRole('button', { name: /^Columnas/ });
    const orden = cabecera(page).getByLabel('Orden');
    const buscar = cabecera(page).getByRole('searchbox', { name: 'Buscar placa, VIN, id o propietario…' });
    await expect(columnas).toBeVisible();
    await expect(orden).toBeVisible();
    const [bC, bO, bB] = [await columnas.boundingBox(), await orden.boundingBox(), await buscar.boundingBox()];
    for (const b of [bC!, bO!, bB!]) expect(Math.round(b.height)).toBe(40);
    // A 1366 px, una sola línea con el buscador (no una fila aparte encima de la tabla).
    expect(Math.abs(bC!.y - bB!.y)).toBeLessThan(2);
    expect(Math.abs(bO!.y - bB!.y)).toBeLessThan(2);
    // Orden sigue funcionando desde ahí.
    await orden.selectOption('antiguos');
    await expect(orden).toHaveValue('antiguos');
  });

  test('(b) sin selección no hay barra fija sobre la tabla y el conteo va junto a la paginación', async ({ page }) => {
    await montar(page);
    await expect(page.getByTestId('barra-tabla')).toHaveCount(0);
    await expect(page.locator('.barra-tabla')).toHaveCount(0);
    const pie = page.getByRole('navigation', { name: 'Paginación de trámites' });
    await expect(pie.getByRole('status')).toHaveText('1.284 trámites');
    await expect(pie).toContainText('Página 1 de 26');
    await expect(pie.getByRole('button', { name: '‹ Anterior' })).toBeDisabled();
    await expect(pie.getByRole('button', { name: 'Siguiente ›' })).toBeEnabled();
    // El pie va DEBAJO de la tabla.
    const tabla = await page.getByRole('table').boundingBox();
    const bPie = await pie.boundingBox();
    expect(bPie!.y).toBeGreaterThan(tabla!.y + tabla!.height - 1);
  });

  test('(b) con una sola página el conteo se muestra igual, sin botones', async ({ page }) => {
    await montar(page, 3);
    const pie = page.getByTestId('pie-tramites');
    await expect(pie.getByRole('status')).toHaveText('3 trámites');
    await expect(pie.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Paginación de trámites' })).toHaveCount(0);
  });

  test('(c) con selección la barra de lote aparece, es sticky y se va al limpiar', async ({ page }) => {
    await montar(page);
    await fila(page, '2026-001001').getByRole('checkbox').check();
    const barra = page.getByTestId('barra-tabla');
    await expect(barra).toBeVisible();
    await expect(barra.getByText('1 seleccionado', { exact: true })).toBeVisible();
    expect(await barra.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
    // Opaca: el fondo no es transparente.
    expect(await barra.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // Al bajar por la tabla sigue a la vista, arriba.
    await fila(page, RELLENO[40].idFlit).scrollIntoViewIfNeeded();
    const b = await barra.boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(0);
    expect(b!.y).toBeLessThan(200);
    await barra.getByRole('button', { name: 'Limpiar selección' }).click();
    await expect(page.getByTestId('barra-tabla')).toHaveCount(0);
  });

  test('(d) celda Vehículo con placa: placa, «Marca Línea · tipo», VIN y servicio en texto', async ({ page }) => {
    await montar(page);
    const auto = fila(page, '2026-001001');
    await expect(auto.locator('[data-kit="placa"]')).toHaveText('KLM482');
    await expect(auto.getByText('Mazda 3 · Automóvil', { exact: true })).toBeVisible();
    await expect(auto.getByText('9FBHSR5A8KM100001', { exact: true })).toBeVisible();
    await expect(auto.getByText('Particular', { exact: true })).toBeVisible();

    const moto = fila(page, '2026-001002');
    await expect(moto.locator('[data-kit="placa"]')).toHaveAttribute('data-variante', 'moto');
    await expect(moto.getByText('Yamaha NMAX · Motocicleta', { exact: true })).toBeVisible();

    const publico = fila(page, '2026-001003');
    await expect(publico.locator('[data-kit="placa"]')).toHaveAttribute('data-variante', 'publico');
    await expect(publico.getByText('Servicio público', { exact: true })).toBeVisible();
  });

  test('(e) sin placa: placa vacía «Sin placa» + VIN, y la casilla nombra el trámite', async ({ page }) => {
    await montar(page);
    const sinPlaca = fila(page, '2026-001004');
    const vacia = sinPlaca.getByRole('img', { name: 'Sin placa' });
    await expect(vacia).toBeVisible();
    await expect(vacia).toHaveAttribute('data-variante', 'vacia');
    await expect(vacia).toHaveText('');
    // Misma forma que una placa real (ancho y proporción del kit).
    const [bv, bp] = [await vacia.boundingBox(), await fila(page, '2026-001001').locator('[data-kit="placa"]').boundingBox()];
    expect(Math.round(bv!.width)).toBe(Math.round(bp!.width));
    expect(Math.round(bv!.height)).toBe(Math.round(bp!.height));
    await expect(sinPlaca.getByText('9FBHSR5A8KM100004', { exact: true })).toBeVisible();
    await expect(sinPlaca.getByText(/^VIN /)).toHaveCount(0);
    await expect(sinPlaca.getByRole('checkbox')).toHaveAccessibleName('Seleccionar el trámite 2026-001004');
    await expect(sinPlaca.getByRole('button', { name: /null/ })).toHaveCount(0);
  });

  test('a 375 px la cabecera de Filtros envuelve sin desbordar y el pie se lee', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await montar(page);
    await expect(cabecera(page).getByRole('button', { name: /^Columnas/ })).toBeVisible();
    await expect(cabecera(page).getByLabel('Orden')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByTestId('pie-tramites').getByRole('status')).toHaveText('1.284 trámites');
  });
});
