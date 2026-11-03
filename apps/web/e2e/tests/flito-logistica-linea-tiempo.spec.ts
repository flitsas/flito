import { mkdirSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, funcionesDe } from '../helpers/auth';

// HU #14126 — Línea de tiempo en el detalle de Logística. Reemplaza la bitácora del modal.
// La placa va en el título del modal (como antes) y nunca en la URL del GET.

type Page = import('@playwright/test').Page;

const FUNCION = 'logistica.documento.ver';

const TRAMITE = {
  tramiteId: 'tr-2', idFlit: 'FLIT-2002', placa: 'XYZ789', vin: 'VIN0000000000002', propietario: 'Ana Ruiz',
  companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
  docId: 'doc-2', estado: 'recogido', estadoLabel: 'Recogido', estadoSimple: 'registrada', estadoSimpleLabel: 'Registrada',
  numeroLicencia: '100381', numeroLt: 'LT-77', actaId: null, motivo: null, actualizadoEn: '2026-07-20T11:00:00Z',
};

const DETALLE = {
  ...TRAMITE, propietarioDocumento: null, combustible: null, tieneFoto: false,
  eventos: [{ id: 'ev-1', estadoAnterior: null, estadoNuevo: 'recogido', actorNombre: 'Mensajero E2E', lat: null, lng: null, motivo: null, origen: 'pwa', creadoEn: '2026-07-20T11:00:00Z' }],
};

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }],
  companiasCerrables: [], mensajeros: [],
};

const ISO_LLEGADA = '2026-10-29T18:30:00.000Z';
const ISO_RECOGIDA = '2026-10-28T14:00:00.000Z';
const ISO_ACTA = '2026-10-27T11:15:00.000Z';

const LINEA_LLENA = {
  documentoId: 'doc-2',
  tramiteId: 'tr-2',
  hitos: [
    {
      id: 'h-llegada', tipo: 'llegada', fecha: ISO_LLEGADA,
      actorNombre: 'No Debe Verse', destino: 'sede-oculta', motivo: 'Recibida en ventanilla', estadoNuevo: 'en_flit',
    },
    {
      id: 'h-recogida', tipo: 'recogida', fecha: ISO_RECOGIDA,
      actorNombre: 'Mensajero Secreto', destino: null, motivo: null, estadoNuevo: 'recogido',
    },
    {
      id: 'h-acta', tipo: null, fecha: ISO_ACTA,
      actorNombre: null, destino: null, motivo: null, estadoNuevo: 'en_acta',
    },
  ],
};

const RUTA_LINEA = /\/api\/flito\/logistica\/tramites\/tr-2\/linea-tiempo$/;
const RUTA_VIAJES = /\/api\/flito\/logistica\/tramites\/tr-2\/viajes$/;

const CAPTURAS = '/tmp/hu14126-linea-tiempo';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json' as const, body: JSON.stringify(body) };
}

async function mockConsola(page: Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) => route.fulfill(json(FACETAS)));
  await page.route(/\/api\/flito\/logistica\/actas$/, (route) => route.fulfill(json([])));
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill(json({ items: [TRAMITE], total: 1, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/logistica\/tr-2$/, (route) => route.fulfill(json(DETALLE)));
  await page.route(RUTA_VIAJES, (route) => route.fulfill(json({
    tramiteId: 'tr-2', idFlit: 'FLIT-2002', gestionaLogistica: true, liquidado: false,
    tarifaVigente: 45000, items: [], totalViajes: 1, totalAdicionales: 0,
  })));
}

async function abrirDetalle(page: Page) {
  await page.goto('/flito/logistica');
  await page.getByRole('row', { name: /XYZ789/ }).getByRole('button', { name: 'Detalle' }).click();
  await expect(page.getByRole('dialog')).toContainText('Trámite FLIT');
}

const seccion = (page: Page) => page.getByRole('region', { name: 'Línea de tiempo' });

async function fechaEnPagina(page: Page, iso: string) {
  return page.evaluate(
    (valor) => new Date(valor).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }),
    iso,
  );
}

test.describe('FLITO — Logística · línea de tiempo (HU #14126)', () => {
  test('la llegada con motivo va arriba y su fecha a la derecha; la placa no va en la URL', async ({ page }) => {
    mkdirSync(CAPTURAS, { recursive: true });
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const urls: string[] = [];
    await page.route(RUTA_LINEA, (route) => {
      urls.push(route.request().url());
      return route.fulfill(json(LINEA_LLENA));
    });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByRole('heading', { name: 'Línea de tiempo' })).toBeVisible();
    const reciente = s.getByRole('listitem').first();
    await expect(reciente.getByText('Llegada a FLIT')).toBeVisible();
    await expect(reciente.getByText('Recibida en ventanilla')).toBeVisible();
    await expect(reciente).not.toContainText('En FLIT');
    await expect(reciente).not.toContainText('No Debe Verse');
    await expect(reciente).not.toContainText('sede-oculta');
    const motivo = reciente.getByText('Recibida en ventanilla');
    await expect(motivo).toHaveAttribute('style', /--flit-text-muted/);

    const fechaLlegada = await fechaEnPagina(page, ISO_LLEGADA);
    const cajaRotulo = await reciente.getByText('Llegada a FLIT').boundingBox();
    const cajaFecha = await reciente.locator('time').boundingBox();
    expect(cajaRotulo).not.toBeNull();
    expect(cajaFecha).not.toBeNull();
    expect(cajaFecha!.x).toBeGreaterThan(cajaRotulo!.x + cajaRotulo!.width / 2);
    expect(Math.abs(cajaFecha!.y - cajaRotulo!.y)).toBeLessThan(14);
    await expect(reciente.locator('time')).toHaveText(fechaLlegada);

    const anterior = s.getByRole('listitem').nth(1);
    await expect(anterior.getByText('Recogido', { exact: true })).toBeVisible();
    await expect(anterior).not.toContainText('recogida');
    await expect(anterior).not.toContainText('Mensajero Secreto');
    const cajaEtiqueta = await anterior.getByText('Recogido', { exact: true }).boundingBox();
    const cajaFechaAnt = await anterior.locator('time').boundingBox();
    expect(cajaFechaAnt!.y).toBeGreaterThan(cajaEtiqueta!.y + 4);

    const acta = s.getByRole('listitem').nth(2);
    await expect(acta.getByText('En acta', { exact: true })).toBeVisible();
    await expect(acta).not.toContainText('en_acta');

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const u = new URL(url);
      expect(u.pathname).toBe('/api/flito/logistica/tramites/tr-2/linea-tiempo');
      expect(u.search).toBe('');
      expect(url).not.toContain('XYZ789');
      expect(url.toLowerCase()).not.toContain('placa');
    }

    await page.getByRole('dialog').screenshot({ path: `${CAPTURAS}/desktop-claro.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('dialog').screenshot({ path: `${CAPTURAS}/mobile-claro.png` });

    await page.evaluate(() => { localStorage.setItem('aura-theme', 'dark'); });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.reload();
    await page.getByRole('row', { name: /XYZ789/ }).getByRole('button', { name: 'Detalle' }).click();
    await expect(seccion(page).getByText('Llegada a FLIT')).toBeVisible();
    await page.getByRole('dialog').screenshot({ path: `${CAPTURAS}/desktop-oscuro.png` });
  });

  test('con el GET pendiente se ve el esqueleto de carga y, al responder, la llegada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    let soltar: () => void = () => {};
    const retenido = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    await page.route(RUTA_LINEA, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await retenido;
      await route.fulfill(json(LINEA_LLENA));
    });
    await abrirDetalle(page);

    const s = seccion(page);
    const cargando = s.getByRole('status', { name: 'Cargando la línea de tiempo.' });
    await expect(cargando).toBeVisible();
    await expect(s.getByRole('heading', { name: 'Línea de tiempo' })).toBeVisible();
    await expect(s.getByText('Llegada a FLIT')).toHaveCount(0);

    soltar();
    await expect(s.getByText('Llegada a FLIT')).toBeVisible();
    await expect(cargando).toHaveCount(0);
  });

  test('vacío con documentoId null: aún no hay recorrido, y desaparece el texto viejo de la bitácora', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.route(RUTA_LINEA, (route) => route.fulfill(json({
      documentoId: null, tramiteId: 'tr-2', hitos: [],
    })));
    await abrirDetalle(page);

    await expect(seccion(page).getByText(
      'Aún no hay recorrido de esta licencia. Lo verá usted aquí cuando el mensajero la recoja en el organismo.',
    )).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/aún no se ha recogido/i)).toHaveCount(0);
    await expect(seccion(page).getByRole('listitem')).toHaveCount(0);
  });

  test('vacío con documento: no hay hitos registrados', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.route(RUTA_LINEA, (route) => route.fulfill(json({
      documentoId: 'doc-2', tramiteId: 'tr-2', hitos: [],
    })));
    await abrirDetalle(page);

    await expect(seccion(page).getByText(
      'Esta licencia no tiene hitos registrados. Lo verá usted aquí cuando se registre un movimiento.',
    )).toBeVisible();
  });

  test('el GET falla: el aviso no trae el error crudo y Reintentar vuelve a pedirlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    let gets = 0;
    let fase: 'error' | 'ok' = 'error';
    await page.route(RUTA_LINEA, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      gets += 1;
      if (fase === 'error') {
        return route.fulfill(json({ error: 'boom secreto XYZ789', placa: 'XYZ789' }, 500));
      }
      return route.fulfill(json(LINEA_LLENA));
    });
    await abrirDetalle(page);

    const s = seccion(page);
    await expect(s.getByRole('alert')).toHaveText('No se pudo cargar el recorrido. Inténtelo de nuevo.');
    await expect(s).not.toContainText('boom secreto');
    await expect(page.getByRole('heading', { name: 'Viajes adicionales' })).toBeVisible();
    const antes = gets;
    expect(antes).toBeGreaterThan(0);
    fase = 'ok';
    await s.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => gets).toBeGreaterThan(antes);
    await expect(s.getByText('Llegada a FLIT')).toBeVisible();
    await expect(s.getByRole('alert')).toHaveCount(0);
  });

  test('sin logistica.documento.ver no hay sección ni petición a linea-tiempo', async ({ page }) => {
    const sinVer = funcionesDe(OPERACIONES_USER).filter((f) => f !== FUNCION);
    await loginAs(page, OPERACIONES_USER, { funciones: sinVer });
    await mockConsola(page);
    let peticiones = 0;
    await page.route(RUTA_LINEA, (route) => {
      peticiones += 1;
      return route.fulfill(json(LINEA_LLENA));
    });
    await abrirDetalle(page);

    await expect(page.getByRole('heading', { name: 'Línea de tiempo' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('Trámite FLIT');
    await expect(page.getByRole('heading', { name: 'Viajes adicionales' })).toBeVisible();
    expect(peticiones).toBe(0);
  });

  test('un 403 no pinta la sección ni dice Sin permisos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.route(RUTA_LINEA, (route) => route.fulfill(json({ error: 'Sin permisos' }, 403)));
    await abrirDetalle(page);

    await expect(page.getByRole('heading', { name: 'Línea de tiempo' })).toHaveCount(0);
    await expect(page.getByText('Sin permisos')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('Trámite FLIT');
    await expect(page.getByRole('heading', { name: 'Viajes adicionales' })).toBeVisible();
  });
});
