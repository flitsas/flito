import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Gestión Trámites a ancho de móvil (HU #13071, AC5): la columna Fuente cabe en el primer
// ancho visible, el filtro se puede usar y la página no se desborda en horizontal.

const FILAS = ['flit', 'flit2'].map((fuente, i) => ({
  tramiteId: `cccccccc-0000-0000-0000-00000000000${i}`, idFlit: `FLIT-300${i}`, estado: 'Asignado', asignado: true, fuente,
  tipoTramite: 'Matricula', ciudad: null, fechaCreacion: null, fechaAprobacion: null, derechoTramiteValor: null,
  empresaExiste: true, empresaNit: null, secretariaEmparejada: true, transitoNombre: null, facturaVentaFlitId: null,
  companiaNombre: null, organismoNombre: null, vehiculo: { vin: null, placa: `MOV00${i}`, marca: null, linea: null, tipoVehiculo: null },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], listoParaEntregar: false,
}));

test('AC5: en móvil la fuente se ve sin desplazarse y el filtro se usa', async ({ page }) => {
  let fuentePedida: string | null = null;
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => {
    fuentePedida = new URL(r.request().url()).searchParams.get('fuente');
    const items = FILAS.filter((f) => !fuentePedida || f.fuente === fuentePedida);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }) });
  });
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('FLIT-3000')).toBeVisible();

  const ancho = page.viewportSize()!.width;
  const cab = await page.getByRole('columnheader', { name: 'Fuente' }).boundingBox();
  expect(cab!.x + cab!.width).toBeLessThanOrEqual(ancho);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('group', { name: 'Filtrar por fuente' }).getByRole('button', { name: 'FLIT 2' }).click();
  await expect.poll(() => fuentePedida).toBe('flit2');
  await expect(page.getByText('FLIT-3000')).toHaveCount(0);
  await expect(page.getByText('FLIT-3001')).toBeVisible();
});
