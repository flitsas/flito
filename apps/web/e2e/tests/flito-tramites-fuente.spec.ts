import { test, expect, type Page } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Gestión Trámites: columna y filtro «Fuente» (HU #13071, Feature #13058). El API está
// mockeado: el mock responde según `?fuente=` y registra cada query para comprobar el cableado.

const fila = (n: number, fuente: string) => ({
  tramiteId: `bbbbbbbb-0000-0000-0000-00000000000${n}`, idFlit: `FLIT-200${n}`, estado: 'Asignado', asignado: true,
  fuente, tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', vehiculo: { vin: `VIN00000000000${n}`, placa: `PLC00${n}`, marca: 'Mazda', linea: '2', tipoVehiculo: null },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], listoParaEntregar: false,
});
const TODAS = [fila(1, 'flit'), fila(2, 'flit'), fila(3, 'flit2')];

async function montar(page: Page, opts: { sinFlit2?: boolean } = {}) {
  const queries: URLSearchParams[] = [];
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado'], tramites: ['Matricula'], ciudades: ['Manizales'], transitos: ['STT Manizales'] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    const fuente = q.get('fuente');
    // Con la búsqueda puesta, solo coincide la fila 1 (FLIT): así FLIT 2 + búsqueda da vacío.
    let items = TODAS.filter((f) => !fuente || f.fuente === fuente);
    if (opts.sinFlit2 && fuente === 'flit2') items = [];
    if (q.get('buscar')) items = items.filter((f) => f.vehiculo.placa === 'PLC001');
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }) });
  });
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('FLIT-2001')).toBeVisible();
  return { ultima: () => queries[queries.length - 1] };
}

const grupoFuente = (page: Page) => page.getByRole('group', { name: 'Filtrar por fuente' });

test.describe('FLITO — Gestión Trámites: fuente del trámite (HU #13071)', () => {
  test('AC1: la columna Fuente sigue a Trámite y muestra FLIT o FLIT 2', async ({ page }) => {
    await montar(page);
    const cabeceras = await page.getByRole('columnheader').allInnerTexts();
    const iTramite = cabeceras.findIndex((t) => /^TRÁMITE/i.test(t.trim()));
    expect(cabeceras[iTramite + 1].trim().toUpperCase()).toBe('FUENTE');
    expect(cabeceras[iTramite + 2].trim().toUpperCase()).toBe('CREADO');
    const filaFlit = page.getByRole('row').filter({ hasText: 'FLIT-2001' });
    const filaFlit2 = page.getByRole('row').filter({ hasText: 'FLIT-2003' });
    await expect(filaFlit.getByRole('cell').nth(2)).toHaveText('FLIT');
    await expect(filaFlit2.getByRole('cell').nth(2)).toHaveText('FLIT 2');
  });

  test('AC2/AC3: el filtro manda ?fuente=, cuenta lo filtrado y «Limpiar filtros» vuelve a Todas', async ({ page }) => {
    const { ultima } = await montar(page);
    const grupo = grupoFuente(page);
    await expect(grupo.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    expect(ultima().has('fuente')).toBe(false);
    await expect(page.getByText('3 trámite(s)')).toBeVisible();

    await grupo.getByRole('button', { name: 'FLIT 2' }).click();
    await expect(grupo.getByRole('button', { name: 'FLIT 2' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => ultima().get('fuente')).toBe('flit2');
    await expect(page.getByText('1 trámite(s)')).toBeVisible();
    await expect(page.getByText('FLIT-2001')).toHaveCount(0);
    await expect(page.getByText('FLIT-2003')).toBeVisible();

    // Se combina con la autogestión: la query lleva los dos.
    await page.getByRole('group', { name: 'Filtrar por autogestión' }).getByRole('button', { name: 'Autogestionadas', exact: true }).click();
    await expect.poll(() => `${ultima().get('fuente')}|${ultima().get('autogestion')}`).toBe('flit2|si');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(grupo.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => ultima().has('fuente')).toBe(false);
    await expect(page.getByText('3 trámite(s)')).toBeVisible();
  });

  test('AC3: con solo la fuente puesta aparece «Limpiar filtros»', async ({ page }) => {
    await montar(page);
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
    await grupoFuente(page).getByRole('button', { name: 'FLIT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();
  });

  test('AC4: una fuente sin resultados muestra el vacío y «Ver todas las fuentes» vuelve a Todas', async ({ page }) => {
    const { ultima } = await montar(page, { sinFlit2: true });
    await grupoFuente(page).getByRole('button', { name: 'FLIT 2' }).click();
    await expect(page.getByText('Todavía no hay trámites de FLIT 2. Cuando lleguen, aparecen aquí.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde FLIT/)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver todas las fuentes' }).click();
    await expect(grupoFuente(page).getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => ultima().has('fuente')).toBe(false);
    await expect(page.getByText('FLIT-2001')).toBeVisible();
  });

  test('AC4: con otros filtros el vacío dice que ninguno coincide', async ({ page }) => {
    await montar(page);
    await page.getByPlaceholder('Buscar placa, VIN, id o comprador…').fill('PLC001');
    await expect(page.getByText('1 trámite(s)')).toBeVisible();
    await grupoFuente(page).getByRole('button', { name: 'FLIT 2' }).click();
    await expect(page.getByText('Ningún trámite de FLIT 2 coincide con los filtros.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver todas las fuentes' })).toBeVisible();
  });
});
