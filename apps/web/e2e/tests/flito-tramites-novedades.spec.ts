import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// HU #13684 — Aviso de trámites nuevos o actualizados sin recargar (Gestión Trámites).
// El backend está mockeado y el reloj es de Playwright (`page.clock`): el sondeo de ~50 s se adelanta
// con `runFor` en vez de esperarlo. Contrato: `GET /flito/tramites` trae `marca` (línea base) y
// `POST /flito/tramites/novedades/buscar` responde `{ nuevos, actualizados }`.

const SONDEO = 50_000;
const MARCA = '2026-10-19T15:00:00.123456Z';
const MARCA_2 = '2026-10-19T15:01:00.654321Z';

const fila = (n: number, placa: string) => ({
  tramiteId: `aaaaaaaa-0000-0000-0000-00000000000${n}`, idFlit: `FLIT-200${n}`, estado: 'Asignado', asignado: true,
  fuente: 'flit1', tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', vehiculo: { vin: `VIN000000000000${n}`, placa, marca: 'Chevrolet', linea: 'Onix', tipoVehiculo: null },
  compradorPrincipal: { nombreCompleto: 'Comprador E2E', numeroDocumento: '10101010', tipoDocumento: 'CC', correo: null },
  compradores: [], soat: null, soatAutogestionado: false, impuesto: null, impuestosAutogestionado: false,
  soatResuelto: false, impuestosResueltos: false, listoParaEntregar: false, valorSoat: null, valorImpuesto: null,
  sincronizadoEn: MARCA, logistica: null, excepcionesAutogestion: [],
});
const A = fila(1, 'ABC123');
const B = fila(2, 'XYZ789');

type Respuesta = { status: number; body?: unknown };

interface Escenario {
  /** Qué devuelve el GET del listado; se puede cambiar a mitad del test. */
  lista: { items: unknown[]; total: number; marca: string };
  /** Cola de respuestas de `/novedades/buscar`; la última se repite. */
  novedades: Respuesta[];
  urlsLista: URL[];
  cuerpos: Array<{ filtros: Record<string, string>; marca: string; visibles: string[] }>;
  urlsNovedades: string[];
}

async function montar(page: Page, lista: Escenario['lista'], novedades: Respuesta[]): Promise<Escenario> {
  const esc: Escenario = { lista, novedades, urlsLista: [], cuerpos: [], urlsNovedades: [] };
  await loginAs(page, OPERACIONES_USER);
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado'], tramites: [], ciudades: [], transitos: [] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => {
    const url = new URL(r.request().url());
    esc.urlsLista.push(url);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...esc.lista, page: Number(url.searchParams.get('page') ?? 1), pageSize: 50,
    }) });
  });
  await page.route(/\/api\/flito\/tramites\/novedades\/buscar(?:\?|$)/, (r) => {
    esc.urlsNovedades.push(r.request().url());
    esc.cuerpos.push(r.request().postDataJSON());
    const res = esc.novedades.length > 1 ? esc.novedades.shift()! : esc.novedades[0];
    return r.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body ?? { error: 'x' }) });
  });
  await page.clock.install({ time: new Date('2026-10-19T10:00:00-05:00') });
  await page.goto('/flito/tramites');
  await expect(page.getByText('FLIT-2001')).toBeVisible();
  return esc;
}

const aviso = (page: Page) => page.getByTestId('aviso-novedades-tramites');

test.describe('HU #13684 — aviso de trámites nuevos o actualizados', () => {
  test('AC1: un trámite nuevo que cumple el filtro enciende el aviso en ≤60 s sin recargar la tabla, con los filtros en el BODY', async ({ page }) => {
    const esc = await montar(page, { items: [A, B], total: 2, marca: MARCA }, [{ status: 200, body: { nuevos: 1, actualizados: 0 } }]);
    // Búsqueda con placa: en la línea base y, por tanto, en el body del sondeo.
    await page.getByPlaceholder('Buscar placa, VIN, id o comprador…').fill('ABC');
    await page.clock.runFor(400);
    await expect.poll(() => esc.urlsLista.at(-1)?.searchParams.get('buscar')).toBe('ABC');
    const cargas = esc.urlsLista.length;

    await expect(aviso(page)).not.toContainText('Hay');
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 1 trámite nuevo');
    // La tabla no se tocó: ni otra carga ni filas nuevas hasta «Ver».
    expect(esc.urlsLista.length).toBe(cargas);
    await expect(page.getByText('FLIT-2001')).toBeVisible();

    expect(esc.cuerpos).toHaveLength(1);
    expect(esc.cuerpos[0]).toEqual({ filtros: { buscar: 'ABC' }, marca: MARCA, visibles: [A.tramiteId, B.tramiteId] });
    // §14: la URL del sondeo no lleva filtros.
    expect(new URL(esc.urlsNovedades[0]).search).toBe('');
  });

  test('AC1: el copy sigue la spec (1, N, más de 99, nuevos y actualizados) y se actualiza en el sitio', async ({ page }) => {
    await montar(page, { items: [A], total: 1, marca: MARCA }, [
      { status: 200, body: { nuevos: 3, actualizados: 0 } },
      { status: 200, body: { nuevos: 150, actualizados: 0 } },
      { status: 200, body: { nuevos: 4, actualizados: 2 } },
      { status: 200, body: { nuevos: 1, actualizados: 1 } },
    ]);
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toHaveText(/^Hay 3 trámites nuevosVer$/);
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay más de 99 trámites nuevos');
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 4 trámites nuevos y otros actualizados');
    await expect(page.getByRole('button', { name: 'Ver los trámites nuevos y actualizados' })).toBeVisible();
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 1 trámite nuevo y otros actualizados');
  });

  test('AC2: un trámite visible que cambia enciende «Hay trámites actualizados»', async ({ page }) => {
    await montar(page, { items: [A, B], total: 2, marca: MARCA }, [{ status: 200, body: { nuevos: 0, actualizados: 1 } }]);
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay trámites actualizados');
    await expect(page.getByRole('button', { name: 'Ver los trámites actualizados' })).toBeVisible();
  });

  test('AC3: «Ver» recarga la misma query, conserva la selección que sigue existiendo, quita el aviso y enfoca la tabla', async ({ page }) => {
    const esc = await montar(page, { items: [A, B], total: 120, marca: MARCA }, [{ status: 200, body: { nuevos: 2, actualizados: 0 } }]);
    await page.getByLabel('Orden').selectOption('antiguos');
    await expect.poll(() => esc.urlsLista.at(-1)?.searchParams.get('orden')).toBe('antiguos');
    await page.getByRole('button', { name: 'Siguiente ›' }).click();
    await expect.poll(() => esc.urlsLista.at(-1)?.searchParams.get('page')).toBe('2');
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByLabel('Seleccionar XYZ789').check();
    await expect(page.getByText('2 seleccionado(s)')).toBeVisible();
    const query = esc.urlsLista.at(-1)!.search;

    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 2 trámites nuevos');
    // XYZ789 ya no está en la página tras recargar: sale de la selección; ABC123 se queda.
    esc.lista = { items: [A], total: 121, marca: MARCA_2 };
    await page.getByRole('button', { name: 'Ver los trámites nuevos' }).click();

    await expect(page.getByText('XYZ789')).toBeHidden();
    expect(esc.urlsLista.at(-1)!.search).toBe(query);
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
    await expect(page.getByLabel('Seleccionar ABC123')).toBeChecked();
    await expect(page.getByText('Página 2 de 3')).toBeVisible();
    await expect(aviso(page)).not.toContainText('Hay');
    await expect(page.getByLabel('Trámites', { exact: true })).toBeFocused();
    // La marca de la recarga es la nueva línea base del siguiente sondeo.
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.at(-1)?.marca).toBe(MARCA_2);
  });

  test('AC3: si la página actual dejó de existir, «Ver» va a la última', async ({ page }) => {
    const esc = await montar(page, { items: [A, B], total: 120, marca: MARCA }, [{ status: 200, body: { nuevos: 0, actualizados: 2 } }]);
    await page.getByRole('button', { name: 'Siguiente ›' }).click();
    await page.getByRole('button', { name: 'Siguiente ›' }).click();
    await expect.poll(() => esc.urlsLista.at(-1)?.searchParams.get('page')).toBe('3');
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay trámites actualizados');
    esc.lista = { items: [A, B], total: 60, marca: MARCA_2 };
    await aviso(page).getByRole('button').click();
    await expect.poll(() => esc.urlsLista.at(-1)?.searchParams.get('page')).toBe('2');
    await expect(page.getByText('Página 2 de 2')).toBeVisible();
    await expect(aviso(page)).not.toContainText('Hay');
  });

  test('AC4: sin cambios no hay aviso', async ({ page }) => {
    const esc = await montar(page, { items: [A], total: 1, marca: MARCA }, [{ status: 200, body: { nuevos: 0, actualizados: 0 } }]);
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.length).toBe(1);
    await expect(aviso(page)).toBeEmpty();
  });

  test('AC4: 429 y 500 del sondeo se tragan en silencio, sin toast ni cambio de la tabla', async ({ page }) => {
    const esc = await montar(page, { items: [A, B], total: 2, marca: MARCA }, [
      { status: 429, body: { error: 'Demasiadas solicitudes' } },
      { status: 500, body: { error: 'boom' } },
      { status: 200, body: { nuevos: 5, actualizados: 0 } },
    ]);
    const cargas = esc.urlsLista.length;
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.length).toBe(1);
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.length).toBe(2);
    await expect(aviso(page)).toBeEmpty();
    await expect(page.getByText(/Demasiadas solicitudes|Error del servidor/)).toHaveCount(0);
    await expect(page.getByText('FLIT-2002')).toBeVisible();
    expect(esc.urlsLista.length).toBe(cargas);
    // El sondeo no quedó trabado tras los errores.
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 5 trámites nuevos');
  });

  test('AC4: con la pestaña oculta no consulta; al volver, una consulta enseguida', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as unknown as { __vis?: string }).__vis ?? 'visible' });
    });
    const esc = await montar(page, { items: [A], total: 1, marca: MARCA }, [{ status: 200, body: { nuevos: 2, actualizados: 0 } }]);
    await page.evaluate(() => { (window as unknown as { __vis: string }).__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(SONDEO * 3);
    expect(esc.cuerpos).toHaveLength(0);
    await page.evaluate(() => { (window as unknown as { __vis: string }).__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => esc.cuerpos.length).toBe(1);
    await expect(aviso(page)).toContainText('Hay 2 trámites nuevos');
  });

  test('AC4: con un diálogo abierto no consulta', async ({ page }) => {
    const esc = await montar(page, { items: [A], total: 1, marca: MARCA }, [{ status: 200, body: { nuevos: 1, actualizados: 0 } }]);
    await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByRole('button', { name: 'Solicitar SOAT (1)', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.clock.runFor(SONDEO * 2);
    expect(esc.cuerpos).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.length).toBe(1);
  });

  test('AC4: con una acción en curso no consulta', async ({ page }) => {
    const esc = await montar(page, { items: [A], total: 1, marca: MARCA }, [{ status: 200, body: { nuevos: 1, actualizados: 0 } }]);
    // Lote de impuestos SIN diálogo previo: la ruta se retiene para que `enProceso` siga en true.
    let liberar!: () => void;
    const retenida = new Promise<void>((ok) => { liberar = ok; });
    await page.route(/\/api\/flito\/tramites\/solicitar-impuestos$/, async (r) => {
      await retenida;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: 1, yaEnviados: 0, noEnviables: 0 }) });
    });
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByRole('button', { name: 'Solicitar Impuestos (1)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Solicitar Impuestos (1)', exact: true })).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // 80 s y no SONDEO*2: el timeout de 90 s de `api.ts` corre con el reloj falso y abortaría el lote
    // (enProceso → false) antes del segundo tick. 80 s cubren un tick completo del sondeo con la acción viva.
    await page.clock.runFor(SONDEO + 30_000);
    // Margen real para que un POST disparado en el tick llegue al mock antes de contar.
    await page.waitForTimeout(500);
    expect(esc.cuerpos).toHaveLength(0);

    liberar();
    // Terminado el lote se abre el resultado (diálogo, también pausa); al cerrarlo el sondeo vuelve.
    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await dialogo.getByRole('button', { name: /cerrar/i }).first().click();
    await expect(dialogo).toHaveCount(0);
    await page.clock.runFor(SONDEO);
    await expect.poll(() => esc.cuerpos.length).toBe(1);
  });

  test('AC5: región polite siempre montada; el aviso no roba el foco y «Ver» es un botón con nombre', async ({ page }) => {
    await montar(page, { items: [A], total: 1, marca: MARCA }, [{ status: 200, body: { nuevos: 2, actualizados: 0 } }]);
    await expect(aviso(page)).toHaveAttribute('role', 'status');
    await expect(aviso(page)).toHaveAttribute('aria-live', 'polite');
    const buscar = page.getByPlaceholder('Buscar placa, VIN, id o comprador…');
    await buscar.focus();
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 2 trámites nuevos');
    await expect(buscar).toBeFocused();
    const ver = page.getByRole('button', { name: 'Ver los trámites nuevos' });
    await expect(ver).toHaveText('Ver');
    await ver.focus();
    await expect(ver).toBeFocused();
  });

  test('el aviso también aparece encima del vacío cuando no hay trámites', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ estados: [], tramites: [], ciudades: [], transitos: [] }) }));
    await page.route(/\/api\/flito\/tramites\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50, marca: MARCA }) }));
    await page.route(/\/api\/flito\/tramites\/novedades\/buscar(?:\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ nuevos: 1, actualizados: 0 }) }));
    await page.clock.install({ time: new Date('2026-10-19T10:00:00-05:00') });
    await page.goto('/flito/tramites');
    await expect(page.getByText(/No hay trámites/)).toBeVisible();
    await page.clock.runFor(SONDEO);
    await expect(aviso(page)).toContainText('Hay 1 trámite nuevo');
  });
});
