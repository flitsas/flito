import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, MENSAJERO_USER } from '../helpers/auth';

// HU #14116 — Viajes a cliente: registrar (consola), 4 estados, precio antes de confirmar,
// entrega con casillas y firma. Destino FLIT y POST /cerrar-lote no existen en la UI.

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Transportes Andes' }],
  organismos: [],
  companiasCerrables: [
    {
      companiaId: 5, nombre: 'Transportes Andes', disponibles: 2, precioEntregaCliente: 12000,
      lts: [
        { documentoId: 'doc-a', placa: 'QOX858', numeroLt: '10038156339', idFlit: 'FLIT-1' },
        { documentoId: 'doc-b', placa: 'ABC123', numeroLt: '10038156340', idFlit: 'FLIT-2' },
      ],
    },
    {
      companiaId: 6, nombre: 'Rápido del Valle', disponibles: 1, precioEntregaCliente: null,
      lts: [
        { documentoId: 'doc-c', placa: 'DEF456', numeroLt: '10038156341', idFlit: 'FLIT-3' },
      ],
    },
    {
      companiaId: 7, nombre: 'Cero Pesos', disponibles: 1, precioEntregaCliente: 0,
      lts: [
        { documentoId: 'doc-d', placa: 'GHI789', numeroLt: '10038156342', idFlit: 'FLIT-4' },
      ],
    },
  ],
  mensajeros: [{ id: 9, nombre: 'Ana Ríos' }],
};

const VACIAS = { ...FACETAS, companiasCerrables: [] };

const DIEZ_LT = Array.from({ length: 10 }, (_, i) => ({
  id: `doc-${i + 1}`, placa: `ZZA${100 + i}`, idFlit: `FLIT-${i + 1}`, numeroLt: `LT-${i + 1}`,
}));

async function mockConsola(page: import('@playwright/test').Page, facetas = FACETAS) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facetas) }));
  await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));
}

function firmar(canvas: import('@playwright/test').Locator) {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const r = el.getBoundingClientRect();
    const pe = (type: string, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
    pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
  });
}

test.describe('FLITO — Viajes a cliente (HU #14116)', () => {
  test('AC1: un POST /traslados por compañía con las documentoId de ESE grupo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const posts: Array<{ body: Record<string, unknown>; key: string | undefined }> = [];
    let cerroLote = false;
    await page.route(/\/api\/flito\/logistica\/cerrar-lote/, async (route) => {
      cerroLote = true;
      return route.fulfill({ status: 500, body: '{}' });
    });
    await page.route(/\/api\/flito\/logistica\/traslados$/, async (route) => {
      posts.push({
        body: route.request().postDataJSON() as Record<string, unknown>,
        key: route.request().headers()['idempotency-key'],
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 't1', actaId: 'a1' }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /Viajes a cliente, 4/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).first().click();
    await page.getByRole('button', { name: 'Confirmar viaje' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toMatchObject({
      companiaId: 5, destino: 'cliente',
      lts: [{ documentoId: 'doc-a' }, { documentoId: 'doc-b' }],
    });
    expect(posts[0].body.destino).not.toBe('flit');
    expect(posts[0].key).toBeTruthy();
    expect(cerroLote).toBe(false);
  });

  test('AC2: precio unitario y total visibles ANTES de confirmar; $0 configurado no apaga la primaria', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /Viajes a cliente/ }).click();
    await expect(page.getByText('Se cobrará $12.000 por LT · Total $24.000')).toBeVisible();
    await expect(page.getByText('Se cobrará $0 por LT · Total $0')).toBeVisible();
    const tarjetasConRegistrar = page.getByRole('button', { name: 'Registrar viaje' });
    await expect(tarjetasConRegistrar).toHaveCount(2);
    await tarjetasConRegistrar.first().click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText(/Se cobrará \$12\.000 por cada LT\. Total \$24\.000/)).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Confirmar viaje' })).toBeVisible();
  });

  test('AC3: sin precio, copy exacto, sin Registrar, Ir a Tarifas si hay página', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /Viajes a cliente/ }).click();
    await expect(page.getByText('La compañía Rápido del Valle no tiene precio de entrega a cliente')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a Tarifas' })).toHaveAttribute('href', '/flito/tarifas/6');
    const valle = page.getByRole('article').filter({ hasText: 'Rápido del Valle' });
    await expect(valle.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
  });

  test('AC3: sin flito_tarifas, frase a Finanzas y sin enlace', async ({ page }) => {
    await loginAs(page, { ...OPERACIONES_USER, allowedPages: ['flito_logistica'] });
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /Viajes a cliente/ }).click();
    await expect(page.getByText('Pídele a Finanzas que fije el precio de Entrega a cliente.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a Tarifas' })).toHaveCount(0);
  });

  test('4 estados: vacío, error con Reintentar, 403 sin Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page, VACIAS);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Viajes a cliente' }).click();
    await expect(page.getByText(/No hay LT clasificadas listas para un viaje/)).toBeVisible();

    await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.reload();
    await page.getByRole('button', { name: 'Viajes a cliente' }).click();
    await expect(page.getByRole('alert').getByText('No se pudieron cargar las LT listas para viaje.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();

    await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'no' }) }));
    await page.reload();
    await page.getByRole('button', { name: 'Viajes a cliente' }).click();
    await expect(page.getByText('No tienes permiso para registrar viajes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('AC7: sin logistica.traslado.registrar la pestaña no existe', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Viajes a cliente/ })).toHaveCount(0);
  });

  test('Actas vacío apunta a Viajes a cliente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByText(/Ve a «Viajes a cliente» y registra el viaje/)).toBeVisible();
  });
});

test.describe('FLITO — Mi ruta · Entregas (HU #14116)', () => {
  test('AC4 y AC5: casillas → ltsDevueltas; cédula no va a la URL; 10/10 apaga Confirmar', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entregas: [{
            actaId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            companiaNombre: 'Transportes Andes',
            direccionEntrega: 'Cra 15 # 88-64, Bogotá',
            contactoNombre: null,
            documentos: DIEZ_LT,
          }],
        }),
      }));
    let body: Record<string, unknown> | null = null;
    let path = '';
    await page.route(/\/api\/flito\/logistica\/actas\/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\/entregar$/, async (route) => {
      path = new URL(route.request().url()).pathname;
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentos: 8 }) });
    });

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Transportes Andes' })).toBeVisible();
    await page.getByRole('checkbox', { name: /ZZA100/ }).check();
    await page.getByRole('checkbox', { name: /ZZA101/ }).check();
    await expect(page.getByRole('status').filter({ hasText: /Se entregarán 8 de 10/ })).toBeVisible();

    await page.getByLabel('Nombre de quien recibe').fill('Receptor de Prueba');
    await page.getByLabel('Cédula de quien recibe').fill('9900000101');
    await firmar(page.getByLabel(/Firma de quien recibe/));
    await page.getByRole('button', { name: 'Confirmar entrega' }).click();

    await expect.poll(() => body).not.toBeNull();
    expect(path).toBe('/api/flito/logistica/actas/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/entregar');
    expect(path).not.toMatch(/9900000101/);
    expect(page.url()).not.toMatch(/9900000101/);
    expect(body).toMatchObject({
      receptorNombre: 'Receptor de Prueba',
      receptorDocumento: '9900000101',
      ltsDevueltas: ['doc-1', 'doc-2'],
    });
    expect(typeof body!.firma).toBe('string');
    await expect(page.getByRole('status').filter({ hasText: 'Entrega registrada: 8 LT entregadas, 2 devueltas.' })).toBeVisible();
  });

  test('AC5: marcar 10/10 deshabilita Confirmar y empuja a Devolver el viaje', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entregas: [{
            actaId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            companiaNombre: 'Transportes Andes',
            direccionEntrega: null, contactoNombre: null, documentos: DIEZ_LT,
          }],
        }),
      }));
    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    for (const d of DIEZ_LT) {
      await page.getByRole('checkbox', { name: new RegExp(d.placa) }).check();
    }
    await expect(page.getByRole('button', { name: 'Confirmar entrega' })).toBeDisabled();
    await expect(page.getByText(/Para devolver las 10 LT usa Devolver el viaje/)).toBeVisible();
    await page.getByRole('button', { name: 'Devolver el viaje' }).click();
    const modal = page.getByRole('dialog', { name: /Devolver el viaje/ });
    await expect(modal.getByLabel('Motivo (obligatorio)')).toBeVisible();
  });

  test('Devolver el viaje usa FlitModal, no prompt nativo', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entregas: [{
            actaId: 'acta-uuid-1', companiaNombre: 'Transportes Andes',
            direccionEntrega: null, contactoNombre: null,
            documentos: [{ id: 'doc-1', placa: 'QOX858', idFlit: 'FLIT-1', numeroLt: '1' }],
          }],
        }),
      }));
    let body: unknown = null;
    await page.route(/\/api\/flito\/logistica\/actas\/acta-uuid-1\/devolucion$/, async (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    page.on('dialog', () => { throw new Error('prompt nativo no permitido'); });

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Devolver el viaje' }).click();
    const modal = page.getByRole('dialog', { name: /Devolver el viaje · Transportes Andes/ });
    await modal.getByLabel('Motivo (obligatorio)').fill('Receptor ausente');
    await modal.getByRole('button', { name: 'Devolver el viaje' }).click();
    await expect.poll(() => body).toEqual({ motivo: 'Receptor ausente' });
  });
});
