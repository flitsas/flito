// HU #13968 — Clientes / SOAT sin trámite: elegir solo el proveedor y avisar el permiso sin efecto.
// Feature #13966. Diseño: `docs/ux/clientes-soat-sin-tramite-proveedor-13968-slim.md`.
//
// Sustituye a la S1 de `soat-envio-directo-gestor.spec.ts` (HU #12079): el interruptor «Canal
// abierto» y el «Gestor por defecto» ya no existen. El proveedor elegido ES el canal.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, OPERACIONES_USER } from '../helpers/auth';

const SURA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AXA = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const MUNDIAL = 'cccccccc-dddd-4eee-8fff-000000000000';

const RE_CLIENTES = /\/api\/clients(\?|$)/;
const RE_PROVEEDORES = /\/api\/flito\/parametrizacion\/proveedores-soat$/;
const RE_PATCH_COMPANIA = /\/api\/flito\/parametrizacion\/companias\/\d+$/;

const AVISO = 'Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo.';
const ETIQUETA = 'Proveedor de SOAT sin trámite';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Prov = { id: string; nombre: string; activo: boolean } | null;

function cliente(id: number, name: string, gestorSoatSinTramite: Prov, permisoSinTramiteSinEfecto = false) {
  return {
    id, name, document: `9001${id}`, documentType: 'NIT', phone: null, email: null,
    address: null, city: 'Medellín',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaPermiteParcial: false, gestorSoatSinTramite, permisoSinTramiteSinEfecto,
  };
}

const SIN = cliente(1, 'Concesionario Norte', null, true);
const CON = cliente(2, 'Transportes Sur', { id: SURA, nombre: 'SURA', activo: true });
const INACTIVO = cliente(3, 'Flota Occidente', { id: MUNDIAL, nombre: 'MUNDIAL', activo: false });
const SIN_SIN_AVISO = cliente(4, 'Rentadora Caribe', null, false);

const CATALOGO = [
  { id: SURA, nombre: 'SURA', activo: true },
  { id: AXA, nombre: 'AXA', activo: true },
  { id: MUNDIAL, nombre: 'MUNDIAL', activo: false },
];

async function montar(page: Page, opciones: {
  catalogo?: 'ok' | 'error' | 'vacio' | 'pendiente';
  patch?: { status: number; cuerpo: unknown };
} = {}) {
  const patches: Record<string, unknown>[] = [];
  const catalogos: string[] = [];
  let modo = opciones.catalogo ?? 'ok';
  await page.route(RE_CLIENTES, (route) => json(route, 200, [SIN, CON, INACTIVO, SIN_SIN_AVISO]));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(RE_PROVEEDORES, async (route) => {
    catalogos.push(route.request().url());
    if (modo === 'pendiente') return; // se queda en vuelo
    if (modo === 'error') return json(route, 500, { error: 'Catálogo caído' });
    return json(route, 200, modo === 'vacio' ? [] : CATALOGO);
  });
  await page.route(RE_PATCH_COMPANIA, (route) => {
    patches.push(route.request().postDataJSON() as Record<string, unknown>);
    return opciones.patch ? json(route, opciones.patch.status, opciones.patch.cuerpo) : json(route, 200, { id: 1 });
  });
  await page.goto('/clients');
  return { patches, catalogos, arreglar: () => { modo = 'ok'; } };
}

const celda = (page: Page, nombre: string, texto: string) =>
  page.getByRole('button', { name: `SOAT sin trámite de ${nombre}: ${texto}` });
const modalDe = (page: Page, nombre: string) =>
  page.getByRole('dialog', { name: `SOAT sin trámite · ${nombre}` });

test.describe('HU #13968 · AC3 — la columna es neutra', () => {
  test('nombre, «(inactivo)» o «Sin proveedor», sin «Abierto/Cerrado» ni color de aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page);
    await expect(celda(page, 'Transportes Sur', 'SURA')).toHaveText('SURA');
    await expect(celda(page, 'Flota Occidente', 'MUNDIAL (inactivo)')).toHaveText('MUNDIAL (inactivo)');
    await expect(celda(page, 'Concesionario Norte', 'Sin proveedor')).toHaveText('Sin proveedor');
    await expect(page.getByText(/Abierto ·|^Cerrado$/)).toHaveCount(0);
    // El indicador de permiso sin efecto NO se pinta en la fila.
    await expect(page.getByText(AVISO)).toHaveCount(0);
    // Misma tinta en la fila inactiva que en la activa: sin color de aviso.
    const tinta = await celda(page, 'Transportes Sur', 'SURA').evaluate((el) => getComputedStyle(el).color);
    await expect(celda(page, 'Flota Occidente', 'MUNDIAL (inactivo)')).toHaveCSS('color', tinta);
  });
});

test.describe('HU #13968 · AC2 — el permiso propio gobierna la celda, el cuadro y la nota', () => {
  test('sin la acción: solo lectura, sin cuadro y sin nota, aunque tenga desbloquear', async ({ page }) => {
    await loginAs(page, {
      ...OPERACIONES_USER,
      funciones: ['tramites.autogestion.desbloquear'],
    } as typeof OPERACIONES_USER);
    await montar(page);
    await expect(page.getByText('SURA', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /SOAT sin trámite de/ })).toHaveCount(0);
    await expect(page.getByText(/dice a qué proveedor salen las solicitudes/)).toHaveCount(0);
  });

  test('financiera lee la columna sin botón', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await montar(page);
    await expect(page.getByText('Sin proveedor').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /SOAT sin trámite de/ })).toHaveCount(0);
  });

  test('con la acción y SIN desbloquear: abre el cuadro y ve la nota', async ({ page }) => {
    await loginAs(page, {
      ...OPERACIONES_USER,
      funciones: ['parametrizacion.companias.soat_sin_tramite'],
    } as typeof OPERACIONES_USER);
    await montar(page);
    await expect(page.getByText(/«Sin proveedor» deja esa opción cerrada/)).toBeVisible();
    await celda(page, 'Transportes Sur', 'SURA').click();
    await expect(modalDe(page, 'Transportes Sur')).toBeVisible();
  });
});

test.describe('HU #13968 · AC1 / AC4 — el cuadro: un solo control y el aviso', () => {
  test('sin interruptor; «Sin proveedor» primero, activos, y se envía SOLO el proveedor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { patches } = await montar(page);
    await celda(page, 'Rentadora Caribe', 'Sin proveedor').click();
    const modal = modalDe(page, 'Rentadora Caribe');
    await expect(modal.getByLabel('Canal abierto')).toHaveCount(0);
    const selector = modal.getByLabel(ETIQUETA);
    await expect(selector).toHaveValue('');
    await expect(selector.locator('option')).toHaveText(['Sin proveedor', 'SURA', 'AXA']);
    // AC4: sin el indicador, no hay aviso.
    await expect(modal.getByText(AVISO)).toHaveCount(0);

    await selector.selectOption(AXA);
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Proveedor de SOAT sin trámite actualizado. Las solicitudes ya radicadas conservan el suyo.')).toBeVisible();
    expect(patches).toEqual([{ proveedorSoatSinTramiteId: AXA }]);
  });

  test('«Sin proveedor» se envía como null y el toast lo dice', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { patches } = await montar(page);
    await celda(page, 'Transportes Sur', 'SURA').click();
    const modal = modalDe(page, 'Transportes Sur');
    await modal.getByLabel(ETIQUETA).selectOption('');
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Transportes Sur queda sin proveedor: sus usuarios no pueden solicitar SOAT sin trámite.')).toBeVisible();
    expect(patches).toEqual([{ proveedorSoatSinTramiteId: null }]);
  });

  test('el asignado inactivo se reinyecta marcado y guardar sin tocar no hace petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { patches } = await montar(page);
    await celda(page, 'Flota Occidente', 'MUNDIAL (inactivo)').click();
    const modal = modalDe(page, 'Flota Occidente');
    const selector = modal.getByLabel(ETIQUETA);
    await expect(selector).toHaveValue(MUNDIAL);
    await expect(selector.locator(`option[value="${MUNDIAL}"]`)).toContainText('inactivo');
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(modal).toHaveCount(0);
    expect(patches).toEqual([]);
  });

  test('AC4: con el indicador, el aviso literal va arriba y el selector lo referencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page);
    await celda(page, 'Concesionario Norte', 'Sin proveedor').click();
    const modal = modalDe(page, 'Concesionario Norte');
    await expect(modal.getByText(AVISO)).toBeVisible();
    await expect(modal.getByLabel(ETIQUETA)).toHaveAccessibleDescription(new RegExp(AVISO.slice(0, 40)));
    // Se queda aunque se elija proveedor en el borrador: el dato es del servidor.
    await modal.getByLabel(ETIQUETA).selectOption(SURA);
    await expect(modal.getByText(AVISO)).toBeVisible();
  });
});

test.describe('HU #13968 · AC8 — cuatro estados y error de guardado pulido', () => {
  test('cargando: el selector lo dice y Guardar está deshabilitado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, { catalogo: 'pendiente' });
    await celda(page, 'Transportes Sur', 'SURA').click();
    const modal = modalDe(page, 'Transportes Sur');
    await expect(modal.getByText('Cargando proveedores…')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  test('error: mensaje y «Volver a cargar» pide el catálogo otra vez', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { catalogos, arreglar } = await montar(page, { catalogo: 'error' });
    await celda(page, 'Transportes Sur', 'SURA').click();
    const modal = modalDe(page, 'Transportes Sur');
    await expect(modal.getByText('No se pudieron cargar los proveedores.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    const antes = catalogos.length;
    arreglar();
    await modal.getByRole('button', { name: 'Volver a cargar' }).click();
    await expect.poll(() => catalogos.length).toBeGreaterThan(antes);
    await expect(modal.getByLabel(ETIQUETA)).toBeEnabled();
    await expect(modal.getByRole('button', { name: 'Guardar' })).toBeEnabled();
  });

  test('vacío: nombra la pestaña Proveedores, sin reintento y sin Guardar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page, { catalogo: 'vacio' });
    await celda(page, 'Rentadora Caribe', 'Sin proveedor').click();
    const modal = modalDe(page, 'Rentadora Caribe');
    await expect(modal.getByText('No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Volver a cargar' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  for (const [status, copy] of [
    [400, 'Ese proveedor ya no está activo. Elija otro o «Sin proveedor».'],
    [403, 'No tiene permiso para elegir el proveedor de esta compañía.'],
    [500, 'No se pudo guardar el proveedor. Intente de nuevo en un momento.'],
  ] as const) {
    test(`guardado ${status}: copy pulido, el cuadro sigue abierto y conserva la elección`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await montar(page, {
        patch: { status, cuerpo: { error: 'x', details: { fieldErrors: { proveedorSoatSinTramiteId: ['inactivo'] } } } },
      });
      await celda(page, 'Transportes Sur', 'SURA').click();
      const modal = modalDe(page, 'Transportes Sur');
      await modal.getByLabel(ETIQUETA).selectOption(AXA);
      await modal.getByRole('button', { name: 'Guardar' }).click();
      await expect(modal.getByRole('alert')).toHaveText(copy);
      await expect(modal.getByText(/proveedorSoatSinTramiteId/)).toHaveCount(0);
      await expect(modal.getByLabel(ETIQUETA)).toHaveValue(AXA);
    });
  }
});

// La ficha de ayuda in-app: los literales se LEEN del DOM y se le exigen a la ficha publicada, para
// que el día que cambie la redacción la ficha se ponga roja sola.
test.describe('HU #13968 · la ficha de ayuda de Clientes y proveedores', () => {
  test('la ficha nombra los textos de la columna, la etiqueta del cuadro y el aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page);
    const textos = [
      (await celda(page, 'Concesionario Norte', 'Sin proveedor').innerText()).trim(),
      (await celda(page, 'Flota Occidente', 'MUNDIAL (inactivo)').innerText()).trim().replace('MUNDIAL', '').trim(),
    ];
    await celda(page, 'Concesionario Norte', 'Sin proveedor').click();
    const modal = modalDe(page, 'Concesionario Norte');
    await expect(modal.getByText(AVISO)).toBeVisible();

    await page.goto('/flito/ayuda/clients');
    const ficha = page.getByRole('article', { name: 'Clientes y proveedores' });
    await expect(ficha).toBeVisible();
    for (const literal of [...textos, ETIQUETA, AVISO, 'Cargando proveedores…', 'No se pudieron cargar los proveedores.']) {
      await expect(ficha, literal).toContainText(literal);
    }
    for (const viejo of ['Canal abierto', 'Gestor por defecto', 'Abierto ·']) {
      await expect(ficha, viejo).not.toContainText(viejo);
    }
  });
});
