import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

// FLITO — Logística: viajes adicionales de un trámite desde el detalle de la consola (HU #12620,
// Feature #12617, Épica #12244). Diseño: `docs/ux/flito-logistica-viajes.md`.
//
// El backend está mockeado con estado: el GET de viajes devuelve lo que el POST y el DELETE dejaron,
// y los totales los calcula el MOCK (como el servidor real): la UI nunca suma. Se verifica el
// cableado de la UI, el gating por función y que ningún precio se escape al acta.

type Page = import('@playwright/test').Page;

const TRAMITE = {
  tramiteId: 'tr-2', idFlit: 'FLIT-2002', placa: 'XYZ789', vin: 'VIN0000000000002', propietario: 'Ana Ruiz',
  companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
  docId: 'doc-2', estado: 'recogido', estadoLabel: 'Recogido', estadoSimple: 'registrada', estadoSimpleLabel: 'Registrada',
  numeroLicencia: '100381', numeroLt: 'LT-77', actaId: 'acta-1', motivo: null, actualizadoEn: '2026-07-20T11:00:00Z',
};

const DETALLE = {
  ...TRAMITE, propietarioDocumento: null, combustible: null, tieneFoto: false,
  eventos: [{ id: 'ev-1', estadoAnterior: null, estadoNuevo: 'recogido', actorNombre: 'Mensajero E2E', lat: null, lng: null, motivo: null, origen: 'pwa', creadoEn: '2026-07-20T11:00:00Z' }],
};

const ACTAS = [
  { id: 'acta-1', companiaId: 5, companiaNombre: 'Concesionario Norte', estado: 'generada', estadoLabel: 'Generada', mensajeroId: null, mensajeroNombre: null, documentos: 1, receptorNombre: null, entregadoEn: null, creadoEn: '2026-07-21T08:00:00Z' },
];

const ACTA_DETALLE = {
  acta: ACTAS[0], tienePdf: true, firmaEntrega: false, firmaRecibe: false, entregaNombre: null,
  documentos: [{ id: 'doc-2', placa: 'XYZ789', secretaria: 'STT Medellín', propietario: 'Ana Ruiz', numeroLicencia: '100381', numeroLt: 'LT-77', estado: 'en_acta', estadoLabel: 'En acta', idFlit: 'FLIT-2002' }],
  bitacora: [{ id: 'ev-9', documentoId: 'doc-2', placa: 'XYZ789', estadoAnterior: 'recogido', estadoNuevo: 'en_acta', actorNombre: 'Operaciones E2E', motivo: null, origen: 'web', creadoEn: '2026-07-21T08:00:00Z' }],
};

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }],
  companiasCerrables: [], mensajeros: [{ id: 9, nombre: 'Mensajero E2E' }],
};

interface Viaje {
  id: string; numero: number; modo: 'inicial' | 'manual'; valor: number; tarifaVigente: number | null;
  motivo: string; motivoDetalle: string | null; registradoPorId: number | null; registradoPorNombre: string | null; registradoEn: string;
}

const VIAJE_2: Viaje = {
  id: 'vj-2', numero: 2, modo: 'inicial', valor: 45000, tarifaVigente: 45000, motivo: 'devolucion', motivoDetalle: null,
  registradoPorId: 7, registradoPorNombre: 'Ana Ríos', registradoEn: '2026-09-15T15:12:00Z',
};

const RUTA_VIAJES = /\/api\/flito\/logistica\/tramites\/tr-2\/viajes(\/[^/?]+)?$/;

async function mockConsola(page: Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTAS) }));
  await page.route(/\/api\/flito\/logistica\/actas\/acta-1$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTA_DETALLE) }));
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [TRAMITE], total: 1, page: 1, pageSize: 50 }) }));
  await page.route(/\/api\/flito\/logistica\/tr-2$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE) }));
}

interface EstadoMock { gestionaLogistica?: boolean; liquidado?: boolean; tarifaVigente?: number | null; items?: Viaje[] }

/** GET/POST/DELETE con estado, totales calculados como el servidor. Devuelve los cuerpos capturados. */
async function mockViajes(page: Page, estado: EstadoMock = {}) {
  const items: Viaje[] = [...(estado.items ?? [VIAJE_2])];
  const tarifaVigente = estado.tarifaVigente === undefined ? 45000 : estado.tarifaVigente;
  const posts: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  const cuerpo = () => ({
    tramiteId: 'tr-2', idFlit: 'FLIT-2002', gestionaLogistica: estado.gestionaLogistica ?? true, liquidado: estado.liquidado ?? false,
    tarifaVigente, items, totalViajes: 1 + items.length, totalAdicionales: items.reduce((s, v) => s + v.valor, 0),
  });
  await page.route(RUTA_VIAJES, async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo()) });
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      posts.push(body);
      // Como el servidor: el siguiente ordinal, sin renumerar lo quitado.
      const numero = (items.length ? items[items.length - 1].numero : 1) + 1;
      const nuevo: Viaje = {
        id: `vj-${numero}`, numero, modo: body.modo as Viaje['modo'],
        valor: body.modo === 'inicial' ? (tarifaVigente as number) : (body.valor as number), tarifaVigente,
        motivo: body.motivo as string, motivoDetalle: (body.motivoDetalle as string | undefined) ?? null,
        registradoPorId: 7, registradoPorNombre: 'Operaciones E2E', registradoEn: '2026-09-16T10:00:00Z',
      };
      items.push(nuevo);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(nuevo) });
    }
    if (req.method() === 'DELETE') {
      const id = req.url().split('/').pop()!;
      deletes.push(id);
      const i = items.findIndex((v) => v.id === id);
      if (i >= 0) items.splice(i, 1);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  return { posts, deletes };
}

async function abrirDetalle(page: Page) {
  await page.goto('/flito/logistica');
  await page.getByRole('row', { name: /XYZ789/ }).getByRole('button', { name: 'Detalle' }).click();
  await expect(page.getByRole('dialog')).toContainText('Trámite FLIT');
}

const seccion = (page: Page) => page.getByRole('region', { name: 'Viajes adicionales' });

test.describe('FLITO — Logística · viajes adicionales', () => {
  test('registrar con precio inicial: POST sin valor, la lista y los totales vienen del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const { posts } = await mockViajes(page);
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByRole('heading', { name: 'Viajes adicionales' })).toBeVisible();
    await expect(s.getByText('Viajes: 2 (incluye el viaje 1)')).toBeVisible();
    await expect(s.getByText('Adicionales: $ 45.000')).toBeVisible();
    // La fila: número, precio, fijación, motivo, autor y fecha.
    const fila = s.getByRole('listitem').filter({ hasText: 'Viaje 2' });
    await expect(fila).toContainText('$ 45.000');
    await expect(fila).toContainText('Tarifa vigente');
    await expect(fila).toContainText('Devolución · Ana Ríos ·');
    await expect(s.getByRole('button', { name: /Editar/ })).toHaveCount(0);

    await s.getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Registrar viaje · FLIT-2002' });
    await expect(modal).toBeVisible();
    const registrar = modal.getByRole('button', { name: 'Registrar' });
    await expect(registrar).toBeDisabled();
    // Precio inicial preseleccionado, con la tarifa que se copiará y el campo de precio cerrado.
    await expect(modal.getByRole('radio', { name: /Precio inicial/ })).toBeChecked();
    await expect(modal.getByText('Se copiará la tarifa vigente: $ 45.000')).toBeVisible();
    const precio = modal.getByRole('spinbutton', { name: 'Nuevo precio' });
    await expect(precio).toBeDisabled();
    await expect(precio).toHaveValue('');

    await modal.getByLabel('Motivo (obligatorio)').selectOption('segunda_entrega');
    await expect(registrar).toBeEnabled();
    await registrar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ modo: 'inicial', motivo: 'segunda_entrega' });
    expect(posts[0]).not.toHaveProperty('valor');
    await expect(modal).toHaveCount(0);
    const nueva = s.getByRole('listitem').filter({ hasText: 'Viaje 3' });
    await expect(nueva).toContainText('$ 45.000');
    await expect(nueva).toContainText('Tarifa vigente');
    await expect(nueva).toContainText('Segunda entrega · Operaciones E2E ·');
    await expect(s.getByText('Viajes: 3 (incluye el viaje 1)')).toBeVisible();
    await expect(s.getByText('Adicionales: $ 90.000')).toBeVisible();
  });

  test('registrar con precio manual y motivo «Otro»: detalle obligatorio, POST con valor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const { posts } = await mockViajes(page);
    await abrirDetalle(page);

    await seccion(page).getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Registrar viaje · FLIT-2002' });
    const registrar = modal.getByRole('button', { name: 'Registrar' });

    await modal.getByLabel('Motivo (obligatorio)').selectOption('otro');
    const detalle = modal.getByLabel('Detalle (obligatorio, máx. 300)');
    await expect(detalle).toBeVisible();
    await expect(detalle).toHaveAttribute('maxlength', '300');
    await expect(modal.getByText('No escribas datos personales.')).toBeVisible();
    await expect(registrar).toBeDisabled();
    await detalle.fill('Cliente pidió entrega en sede norte');

    await modal.getByRole('radio', { name: /Nuevo precio/ }).check();
    const precio = modal.getByRole('spinbutton', { name: 'Nuevo precio' });
    await expect(precio).toBeEnabled();
    await expect(registrar).toBeDisabled();
    await precio.fill('62000');
    await expect(registrar).toBeEnabled();
    await registrar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ modo: 'manual', valor: 62000, motivo: 'otro', motivoDetalle: 'Cliente pidió entrega en sede norte' });
    await expect(modal).toHaveCount(0);
    const nueva = seccion(page).getByRole('listitem').filter({ hasText: 'Viaje 3' });
    await expect(nueva).toContainText('$ 62.000');
    await expect(nueva).toContainText('Precio manual (tarifa $ 45.000)');
    await expect(nueva).toContainText('Otro: Cliente pidió entrega en sede norte');
    await expect(seccion(page).getByText('Adicionales: $ 107.000')).toBeVisible();
  });

  test('quitar un viaje pide confirmación en la fila y el total baja con el GET', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const manual: Viaje = { ...VIAJE_2, id: 'vj-3', numero: 3, modo: 'manual', valor: 62000, motivo: 'otro', motivoDetalle: 'Sede norte', registradoPorNombre: 'L. Mora' };
    const { deletes } = await mockViajes(page, { items: [VIAJE_2, manual] });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByText('Adicionales: $ 107.000')).toBeVisible();
    await s.getByRole('button', { name: 'Quitar viaje 3' }).click();
    await expect(s.getByText('Se quitará el viaje N.º 3 de $ 62.000. Para corregirlo tendrás que registrarlo de nuevo.')).toBeVisible();
    // Sin DELETE todavía; el foco entra en «Cancelar» y Cancelar devuelve la fila.
    expect(deletes).toHaveLength(0);
    await expect(s.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await s.getByRole('button', { name: 'Cancelar' }).click();
    await expect(s.getByRole('button', { name: 'Quitar viaje 3' })).toBeVisible();

    await s.getByRole('button', { name: 'Quitar viaje 3' }).click();
    await s.getByRole('button', { name: 'Quitar viaje', exact: true }).click();
    await expect.poll(() => deletes).toEqual(['vj-3']);
    await expect(s.getByRole('listitem').filter({ hasText: 'Viaje 3' })).toHaveCount(0);
    await expect(s.getByText('Viajes: 2 (incluye el viaje 1)')).toBeVisible();
    await expect(s.getByText('Adicionales: $ 45.000')).toBeVisible();
    // Sigue abierto el detalle: quitar no cierra nada.
    await expect(page.getByRole('dialog')).toContainText('Bitácora');
  });

  test('sin logistica.viajes.ver la sección no existe ni se pide al API', async ({ page }) => {
    const sinVer = FUNCIONES_POR_ROL.admin.filter((f) => !f.startsWith('logistica.viajes.'));
    await loginAs(page, OPERACIONES_USER, { funciones: sinVer });
    await mockConsola(page);
    let peticiones = 0;
    await page.route(RUTA_VIAJES, (route) => { peticiones += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    await abrirDetalle(page);

    await expect(page.getByRole('dialog')).toContainText('Bitácora');
    await expect(page.getByRole('region', { name: 'Viajes adicionales' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    expect(peticiones).toBe(0);
  });

  test('con .ver pero sin .registrar ni .quitar: lista y totales, ningún botón', async ({ page }) => {
    const soloVer = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'logistica.viajes.registrar' && f !== 'logistica.viajes.quitar');
    await loginAs(page, OPERACIONES_USER, { funciones: soloVer });
    await mockConsola(page);
    await mockViajes(page);
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByText('Viajes: 2 (incluye el viaje 1)')).toBeVisible();
    await expect(s.getByRole('listitem').filter({ hasText: 'Viaje 2' })).toBeVisible();
    await expect(s.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('trámite liquidado: solo lectura con su aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockViajes(page, { liquidado: true });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByText('Trámite liquidado: reversa la liquidación para registrar o quitar viajes.')).toBeVisible();
    await expect(s.getByRole('listitem').filter({ hasText: 'Viaje 2' })).toBeVisible();
    await expect(s.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('la compañía autogestiona la logística: aviso, sin registrar ni quitar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockViajes(page, { gestionaLogistica: false, items: [] });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByText('La logística de esta compañía la gestiona el cliente.')).toBeVisible();
    await expect(s.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('sin tarifa vigente: «Precio inicial» cerrado, «Nuevo precio» preseleccionado; el 422 no cierra el modal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockViajes(page, { tarifaVigente: null, items: [] });
    // El 422 gana sobre el mock con estado: Playwright atiende primero la ruta registrada al final.
    await page.route(RUTA_VIAJES, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'La compañía no tiene tarifa de logística vigente.', codigo: 'TARIFA_LOGISTICA_NO_CONFIGURADA' }) });
    });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByText('Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente.')).toBeVisible();
    await expect(s.getByText('Viajes: 1 (incluye el viaje 1)')).toBeVisible();
    await s.getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Registrar viaje · FLIT-2002' });
    await expect(modal.getByRole('radio', { name: /Precio inicial/ })).toBeDisabled();
    await expect(modal.getByText('La compañía no tiene tarifa de logística vigente')).toBeVisible();
    await expect(modal.getByRole('radio', { name: /Nuevo precio/ })).toBeChecked();
    const precio = modal.getByRole('spinbutton', { name: 'Nuevo precio' });
    await expect(precio).toBeEnabled();
    await expect(precio).toBeFocused();
    // Nunca «$0» como tarifa a copiar.
    await expect(modal).not.toContainText('$ 0');

    await modal.getByLabel('Motivo (obligatorio)').selectOption('documento_faltante');
    await precio.fill('30000');
    await modal.getByRole('button', { name: 'Registrar' }).click();
    await expect(modal.getByRole('alert')).toContainText('La compañía no tiene tarifa de logística vigente.');
    await expect(modal).toBeVisible();
  });

  test('el GET falla: solo la sección cae y «Reintentar» la recarga; un 403 no rompe el detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    // Por FASE y no por contador: en dev React.StrictMode monta dos veces y dispara dos GET.
    let fase: 'caido' | 'ok' | 'prohibido' = 'caido';
    await page.route(RUTA_VIAJES, (route) => {
      if (fase === 'caido') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Se cayó' }) });
      if (fase === 'ok') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tramiteId: 'tr-2', idFlit: 'FLIT-2002', gestionaLogistica: true, liquidado: false, tarifaVigente: 45000, items: [VIAJE_2], totalViajes: 4, totalAdicionales: 99000 }) });
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Sin permiso' }) });
    });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByRole('alert')).toContainText('No se pudieron cargar los viajes de este trámite.');
    await expect(page.getByRole('dialog')).toContainText('Bitácora');
    fase = 'ok';
    await s.getByRole('button', { name: 'Reintentar' }).click();
    // Totales NO derivables del único item (1 viaje de 45.000): si la sección los pintara sumando
    // en el cliente diría «Viajes: 2» y «$ 45.000». Es el mutante nombrado del AC3.
    await expect(s.getByText('Viajes: 4 (incluye el viaje 1)')).toBeVisible();
    await expect(s.getByText(/Adicionales:\s*\$\s*99\.000/)).toBeVisible();

    // Reabrir: ahora el GET responde 403.
    fase = 'prohibido';
    await page.keyboard.press('Escape');
    await page.getByRole('row', { name: /XYZ789/ }).getByRole('button', { name: 'Detalle' }).click();
    await expect(seccion(page).getByText('No tienes permiso para ver los viajes.')).toBeVisible();
    await expect(seccion(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('Trámite FLIT');
    await expect(page.getByRole('dialog')).toContainText('Bitácora');
  });

  test('un 409 TRAMITE_LIQUIDADO al registrar: mensaje del servidor, la sección pasa a solo lectura', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockViajes(page);
    await page.route(RUTA_VIAJES, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'El trámite ya está liquidado.', codigo: 'TRAMITE_LIQUIDADO' }) });
    });
    await abrirDetalle(page);

    const s = seccion(page);
    await s.getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Registrar viaje · FLIT-2002' });
    await modal.getByLabel('Motivo (obligatorio)').selectOption('devolucion');
    await modal.getByRole('button', { name: 'Registrar' }).click();
    await expect(modal.getByRole('alert')).toContainText('El trámite ya está liquidado.');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(s.getByText('Trámite liquidado: reversa la liquidación para registrar o quitar viajes.')).toBeVisible();
    await expect(s.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('el acta no enseña precios ni viajes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockViajes(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('row', { name: /Concesionario Norte/ }).getByRole('button', { name: 'Ver' }).click();
    const acta = page.getByRole('dialog');
    await expect(acta).toContainText('Licencias');
    await expect(acta).toContainText('XYZ789');
    const texto = (await acta.innerText()).toLowerCase();
    expect(texto).not.toContain('$');
    expect(texto).not.toContain('viaje');
    expect(texto).not.toContain('tarifa');
    expect(texto).not.toContain('total');
  });
});
