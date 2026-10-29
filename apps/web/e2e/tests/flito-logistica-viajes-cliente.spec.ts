import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, OPERACIONES_USER, AUDITOR_USER, MENSAJERO_USER } from '../helpers/auth';

// HU #14116 + #14123 — pestaña Viajes: registrar a cliente o a FLIT (dos POST si se reparte),
// 4 estados, precio antes de confirmar, llegada a FLIT sin cédula. POST /cerrar-lote no existe en la UI.

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [{ nit: '900111', nombre: 'Transportes Andes' }],
  organismos: [],
  companiasCerrables: [
    {
      companiaId: 5, nombre: 'Transportes Andes', disponibles: 2, precioEntregaCliente: 12000, precioEntregaFlit: 8000,
      lts: [
        { documentoId: 'doc-a', placa: 'QOX858', numeroLt: '10038156339', idFlit: 'FLIT-1' },
        { documentoId: 'doc-b', placa: 'ABC123', numeroLt: '10038156340', idFlit: 'FLIT-2' },
      ],
    },
    {
      companiaId: 6, nombre: 'Rápido del Valle', disponibles: 1, precioEntregaCliente: null, precioEntregaFlit: null,
      lts: [
        { documentoId: 'doc-c', placa: 'DEF456', numeroLt: '10038156341', idFlit: 'FLIT-3' },
      ],
    },
    {
      companiaId: 7, nombre: 'Cero Pesos', disponibles: 1, precioEntregaCliente: 0, precioEntregaFlit: 0,
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

test.describe('FLITO — Viajes (HU #14116)', () => {
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
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).first().click();
    await page.getByRole('button', { name: 'Confirmar viaje' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toMatchObject({
      companiaId: 5, destino: 'cliente',
      lts: [{ documentoId: 'doc-a' }, { documentoId: 'doc-b' }],
    });
    expect(posts[0].body.destino).not.toBe('flit');
    expect(posts[0].body).not.toHaveProperty('origen');
    expect(posts[0].body).not.toHaveProperty('mensajeroId');
    expect(posts[0].key).toBeTruthy();
    expect(cerroLote).toBe(false);
  });

  test('AC2: precio unitario y total visibles ANTES de confirmar; $0 configurado no apaga la primaria', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByText('Cliente $12.000 por LT')).toBeVisible();
    await expect(page.getByText('FLIT $8.000 por LT')).toBeVisible();
    await expect(page.getByText('Cliente $0 por LT')).toBeVisible();
    await expect(page.getByText('FLIT $0 por LT')).toBeVisible();
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
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByText('Cliente: falta el precio')).toBeVisible();
    await expect(page.getByText('FLIT: falta el precio')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a Tarifas' })).toHaveAttribute('href', '/flito/tarifas/6');
    const valle = page.getByRole('article').filter({ hasText: 'Rápido del Valle' });
    await expect(valle.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
  });

  test('AC3: sin flito_tarifas, frase a Finanzas y sin enlace', async ({ page }) => {
    await loginAs(page, { ...OPERACIONES_USER, allowedPages: ['flito_logistica'] });
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByText('Pídale a Finanzas que fije el precio.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a Tarifas' })).toHaveCount(0);
  });

  test('4 estados: vacío, error con Reintentar, 403 sin Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page, VACIAS);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes$/ }).click();
    await expect(page.getByText(/No hay LT clasificadas listas para un viaje/)).toBeVisible();

    await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.reload();
    await page.getByRole('button', { name: /^Viajes$/ }).click();
    await expect(page.getByRole('alert').getByText('No se pudieron cargar las LT listas para viaje.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();

    await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'no' }) }));
    await page.reload();
    await page.getByRole('button', { name: /^Viajes$/ }).click();
    await expect(page.getByText('No tiene permiso para registrar viajes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('AC7: sin logistica.traslado.registrar la pestaña no existe', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /^Viajes(?! adicionales)/ })).toHaveCount(0);
  });

  test('Actas vacío apunta a Viajes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByText(/Ve a «Viajes» y registra el viaje/)).toBeVisible();
  });
});

const MOTIVO_ID = '11111111-1111-4111-8111-111111111111';
const TRASLADO_FLIT = '11111111-2222-4333-8444-555555555555';

function mockMotivos(page: import('@playwright/test').Page, motivos = [
  { id: MOTIVO_ID, nombre: 'Sin dirección de entrega al recoger', activo: true, orden: 1 },
]) {
  return page.route(/\/api\/flito\/logistica\/motivos-llegada/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(motivos) }));
}

test.describe('FLITO — destino del viaje y llegada a FLIT (HU #14123)', () => {
  test('AC1 y AC2: al pasar el grupo a FLIT cambia el total; sin motivo no confirma y la nota vacía no viaja', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    const posts: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/flito\/logistica\/traslados$/, async (route) => {
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 't-flit' }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('group', { name: 'Destino del viaje' }).getByRole('button', { name: 'FLIT' }).click();
    await expect(modal.getByText('Se cobrará $8.000 por cada LT. Total $16.000.')).toBeVisible();
    await expect(modal.getByText('Elija el motivo de llegada.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Confirmar viaje' })).toBeDisabled();

    await modal.getByLabel(/Motivo de llegada/).selectOption({ label: 'Sin dirección de entrega al recoger' });
    await expect(modal.getByRole('button', { name: 'Confirmar viaje' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Confirmar viaje' }).click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      companiaId: 5,
      destino: 'flit',
      motivoLlegadaId: MOTIVO_ID,
      lts: [{ documentoId: 'doc-a' }, { documentoId: 'doc-b' }],
    });
    expect(posts[0]).not.toHaveProperty('origen');
    expect(posts[0]).not.toHaveProperty('mensajeroId');
    expect(posts[0].lts).toEqual([{ documentoId: 'doc-a' }, { documentoId: 'doc-b' }]);
  });

  test('AC3: un grupo repartido hace dos POST; si el de cliente falla, el de FLIT no se repite', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    const posts: Array<{ body: Record<string, unknown>; key: string | undefined }> = [];
    let clienteIntentos = 0;
    await page.route(/\/api\/flito\/logistica\/traslados$/, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const key = route.request().headers()['idempotency-key'];
      posts.push({ body, key });
      if (body.destino === 'cliente') {
        clienteIntentos += 1;
        if (clienteIntentos === 1) {
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        }
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.destino === 'flit' ? 't-flit' : 't-cli' }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('group', { name: 'Destino de QOX858' }).getByRole('button', { name: 'FLIT' }).click();
    await expect(modal.getByText('Se registrarán dos viajes de Transportes Andes.')).toBeVisible();
    await expect(modal.getByText('A FLIT: 1 LT · $8.000 por LT · Total $8.000.')).toBeVisible();
    await expect(modal.getByText('A cliente: 1 LT · $12.000 por LT · Total $12.000.')).toBeVisible();
    await expect(modal.getByRole('group', { name: 'Destino del viaje' }).getByRole('button', { name: 'FLIT' })).toHaveAttribute('aria-pressed', 'false');
    await modal.getByLabel(/Motivo de llegada/).selectOption(MOTIVO_ID);
    await modal.getByRole('button', { name: 'Confirmar viaje' }).click();

    await expect.poll(() => posts.length).toBe(2);
    expect(posts[0].body.destino).toBe('flit');
    expect(posts[1].body.destino).toBe('cliente');
    expect(posts[0].body).not.toHaveProperty('origen');
    expect(posts[1].body).not.toHaveProperty('origen');
    expect(posts[0].key).toBeTruthy();
    expect(posts[1].key).toBeTruthy();
    expect(posts[0].key).not.toBe(posts[1].key);
    await expect(modal.getByRole('alert')).toHaveText(/El viaje a FLIT quedó registrado\. El viaje a cliente no\./);

    await modal.getByRole('button', { name: 'Confirmar viaje' }).click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts.filter((p) => p.body.destino === 'flit')).toHaveLength(1);
    expect(posts[2].body.destino).toBe('cliente');
    expect(posts[2].key).toBe(posts[1].key);
  });

  test('AC3: si el POST a FLIT falla, no sale ningún POST a cliente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    const posts: Array<{ body: Record<string, unknown> }> = [];
    await page.route(/\/api\/flito\/logistica\/traslados$/, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posts.push({ body });
      if (body.destino === 'flit') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 't-cli' }) });
    });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('group', { name: 'Destino de QOX858' }).getByRole('button', { name: 'FLIT' }).click();
    await modal.getByLabel(/Motivo de llegada/).selectOption(MOTIVO_ID);
    await modal.getByRole('button', { name: 'Confirmar viaje' }).click();

    await expect(modal.getByRole('alert')).toHaveText('No se pudo registrar el viaje. Las LT siguen aquí; vuelva a intentarlo.');
    await expect(modal).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.destino).toBe('flit');
    expect(posts.filter((p) => p.body.destino === 'cliente')).toHaveLength(0);
  });

  test('AC5: la lista en carga anuncia Cargando viajes y a 375 no desborda', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let soltarFacetas: () => void = () => {};
    const facetasListas = new Promise<void>((resolve) => { soltarFacetas = resolve; });
    await page.route(/\/api\/flito\/logistica\/facetas/, async (route) => {
      await facetasListas;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) });
    });
    await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route(/\/api\/flito\/logistica\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByRole('status', { name: 'Cargando viajes…' })).toBeVisible();

    soltarFacetas();
    const registrar = page.getByRole('button', { name: 'Registrar viaje' }).first();
    await expect(registrar).toBeVisible();
    const caja = await registrar.boundingBox();
    expect(caja).not.toBeNull();
    expect(caja!.x).toBeGreaterThanOrEqual(0);
    expect(caja!.x + caja!.width).toBeLessThanOrEqual(375);
    const desborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(desborda).toBe(false);
  });

  test('AC4: sin firmar_flit el viaje a FLIT no se lista en Mi ruta', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entregas: [
            {
              actaId: 'acta-flit', companiaNombre: 'Transportes Andes', direccionEntrega: null, contactoNombre: null,
              destino: 'flit', trasladoId: TRASLADO_FLIT,
              documentos: [{ id: 'doc-a', placa: 'QOX858', idFlit: 'FLIT-1', numeroLt: '10038156339' }],
            },
            {
              actaId: 'acta-cli', companiaNombre: 'Rápido del Valle', direccionEntrega: null, contactoNombre: null,
              destino: 'cliente', trasladoId: '33333333-3333-4333-8333-333333333333',
              documentos: [{ id: 'doc-c', placa: 'DEF456', idFlit: 'FLIT-3', numeroLt: '10038156341' }],
            },
          ],
        }),
      }));
    await page.goto('/flito/ruta');
    await expect(page.getByRole('button', { name: 'Entregar', exact: true })).toBeVisible();
    await expect(page.getByText('Rápido del Valle')).toBeVisible();
    await expect(page.getByText('Transportes Andes')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Firmar llegada' })).toHaveCount(0);
  });

  test('AC4: la llegada a FLIT firma el viaje sin cédula ni nombre', async ({ page }) => {
    await loginAs(page, { ...MENSAJERO_USER, funciones: [...funcionesDe(MENSAJERO_USER), 'logistica.actas.firmar_flit'] });
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entregas: [{
            actaId: 'acta-flit', companiaNombre: 'Transportes Andes', direccionEntrega: null, contactoNombre: null,
            destino: 'flit', trasladoId: TRASLADO_FLIT,
            documentos: [{ id: 'doc-a', placa: 'QOX858', idFlit: 'FLIT-1', numeroLt: '10038156339' }],
          }],
        }),
      }));
    let body: Record<string, unknown> | null = null;
    let path = '';
    await page.route(new RegExp(`/api/flito/logistica/traslados/${TRASLADO_FLIT}/entregar$`), async (route) => {
      path = new URL(route.request().url()).pathname;
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: TRASLADO_FLIT }) });
    });

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Firmar llegada' }).click();
    await expect(page.getByText('Llegada a FLIT · 1 LT')).toBeVisible();
    await expect(page.getByText('Su nombre queda el de esta sesión.')).toBeVisible();
    await expect(page.getByLabel('Cédula de quien recibe')).toHaveCount(0);
    await expect(page.getByLabel('Nombre de quien recibe')).toHaveCount(0);
    await page.getByRole('button', { name: 'Confirmar llegada' }).click();
    await expect(page.getByText('Falta la firma de quien recibe en FLIT.')).toBeVisible();
    expect(body).toBeNull();

    await firmar(page.getByLabel(/Firma de quien recibe en FLIT/));
    await page.getByRole('button', { name: 'Confirmar llegada' }).click();
    await expect.poll(() => body).not.toBeNull();
    expect(path).toBe(`/api/flito/logistica/traslados/${TRASLADO_FLIT}/entregar`);
    expect(typeof body!.firma).toBe('string');
    expect(body).not.toHaveProperty('receptorNombre');
    expect(body).not.toHaveProperty('receptorDocumento');
    expect(body).not.toHaveProperty('firmante');
    expect(body).not.toHaveProperty('foto');
    await expect(page.getByRole('status').filter({ hasText: 'Llegada a FLIT registrada.' })).toBeVisible();
  });

  test('AC4: Firmar llegada solo en el acta despachada a FLIT y solo con la función', async ({ page }) => {
    const actas = [
      { id: 'acta-gen', companiaId: 5, companiaNombre: 'Generada SA', estado: 'generada', estadoLabel: 'Generada', mensajeroId: null, mensajeroNombre: null, documentos: 1, receptorNombre: null, entregadoEn: null, creadoEn: '2026-10-01T00:00:00Z', punto: 'flit', trasladoId: '22222222-2222-4222-8222-222222222222' },
      { id: 'acta-flit', companiaId: 5, companiaNombre: 'Transportes Andes', estado: 'despachada', estadoLabel: 'Despachada', mensajeroId: 9, mensajeroNombre: 'Ana Ríos', documentos: 1, receptorNombre: null, entregadoEn: null, creadoEn: '2026-10-02T00:00:00Z', punto: 'flit', trasladoId: TRASLADO_FLIT },
      { id: 'acta-cli', companiaId: 6, companiaNombre: 'Rápido del Valle', estado: 'despachada', estadoLabel: 'Despachada', mensajeroId: 9, mensajeroNombre: 'Ana Ríos', documentos: 1, receptorNombre: null, entregadoEn: null, creadoEn: '2026-10-03T00:00:00Z', punto: 'cliente', trasladoId: '33333333-3333-4333-8333-333333333333' },
    ];
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actas) }));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-flit$/, (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          acta: actas[1], tienePdf: false, firmaEntrega: false, firmaRecibe: false, entregaNombre: null,
          documentos: [{ id: 'doc-a', placa: 'QOX858', numeroLt: '10038156339', secretaria: null, propietario: null, numeroLicencia: null, estado: 'despachado', estadoLabel: 'Despachada', idFlit: 'FLIT-1' }],
          bitacora: [],
        }),
      }));

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: 'Firmar y despachar' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Firmar llegada' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Firmar llegada' }).click();
    const modal = page.getByRole('dialog', { name: 'Transportes Andes' });
    await expect(modal.getByText('QOX858 · LT 10038156339')).toBeVisible();
    await expect(modal.getByLabel('Cédula de quien recibe')).toHaveCount(0);
    await expect(modal.getByText('Su nombre queda el de esta sesión.')).toBeVisible();

    await loginAs(page, OPERACIONES_USER, {
      funciones: funcionesDe(OPERACIONES_USER).filter((f) => f !== 'logistica.actas.firmar_flit'),
    });
    await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actas) }));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: 'Firmar y despachar' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Firmar llegada' })).toHaveCount(0);
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
