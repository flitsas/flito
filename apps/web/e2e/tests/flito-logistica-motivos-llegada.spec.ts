import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, funcionesDe } from '../helpers/auth';

// HU #14120 — Motivos de llegada: pestaña gated, GET al entrar, CRUD sin DELETE, 4 estados, 409 en línea.

const FUNCION = 'logistica.motivos.gestionar';
const SIN_FUNCION = funcionesDe(OPERACIONES_USER).filter((f) => f !== FUNCION);

const SEED = [
  { id: '11111111-1111-4111-8111-111111111111', nombre: 'Sin dirección de entrega al recoger', activo: true, orden: 10 },
  { id: '22222222-2222-4222-8222-222222222222', nombre: 'Destino lejano (transportadora externa)', activo: true, orden: 20 },
  { id: '33333333-3333-4333-8333-333333333333', nombre: 'Otro', activo: true, orden: 30 },
];

const FACETAS = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: [],
  organismos: [],
  companiasCerrables: [],
  mensajeros: [],
};

async function mockConsola(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/logistica\/actas$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/logistica\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json' as const, body: JSON.stringify(body) };
}

async function mockMotivos(
  page: import('@playwright/test').Page,
  inicial: typeof SEED = SEED,
  opts: { getStatus?: number; holdGet?: Promise<void> } = {},
) {
  const st = {
    lista: inicial.map((m) => ({ ...m })),
    gets: 0,
    posts: [] as Record<string, unknown>[],
    patches: [] as Array<{ url: string; body: Record<string, unknown> }>,
    getUrls: [] as string[],
  };
  await page.route(/\/api\/flito\/logistica\/motivos-llegada(?:\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (method === 'GET') {
      st.gets += 1;
      st.getUrls.push(url);
      if (opts.holdGet) await opts.holdGet;
      if (opts.getStatus === 403) return route.fulfill(json({ error: 'forbidden' }, 403));
      if (opts.getStatus && opts.getStatus >= 500) return route.fulfill(json({ error: 'boom' }, opts.getStatus));
      return route.fulfill(json(st.lista));
    }
    if (method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      st.posts.push(body);
      const nombre = String(body.nombre ?? '');
      if (st.lista.some((m) => m.nombre.toLowerCase() === nombre.toLowerCase())) {
        return route.fulfill(json({ error: `Ya existe un motivo de llegada llamado "${nombre}".` }, 409));
      }
      const creado = {
        id: '44444444-4444-4444-8444-444444444444',
        nombre,
        activo: true,
        orden: Number(body.orden ?? 0),
      };
      st.lista.push(creado);
      return route.fulfill(json(creado, 201));
    }
    if (method === 'PATCH') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      st.patches.push({ url, body });
      const idMatch = /motivos-llegada\/([^/?]+)/.exec(url);
      const id = idMatch?.[1] ?? '';
      const fila = st.lista.find((m) => m.id === id);
      if (!fila) return route.fulfill(json({ error: 'Motivo de llegada no encontrado' }, 404));
      if (url.endsWith('/estado')) {
        fila.activo = Boolean(body.activo);
        return route.fulfill(json(fila));
      }
      if (typeof body.nombre === 'string') {
        const nombre = body.nombre;
        if (st.lista.some((m) => m.id !== id && m.nombre.toLowerCase() === nombre.toLowerCase())) {
          return route.fulfill(json({ error: `Ya existe un motivo de llegada llamado "${nombre}".` }, 409));
        }
        fila.nombre = nombre;
      }
      if (typeof body.orden === 'number') fila.orden = body.orden;
      return route.fulfill(json(fila));
    }
    return route.fallback();
  });
  return st;
}

async function entrarAMotivos(page: import('@playwright/test').Page) {
  await page.goto('/flito/logistica');
  await page.getByRole('button', { name: 'Motivos de llegada' }).click();
}

test.describe('FLITO — Logística · Motivos de llegada (HU #14120)', () => {
  test('AC4: sin la función no hay pestaña ni GET', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: SIN_FUNCION });
    await mockConsola(page);
    const st = await mockMotivos(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Trámites/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Motivos de llegada' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo motivo' })).toHaveCount(0);
    expect(st.gets).toBe(0);
  });

  test('AC4/AC1: pestaña al final, GET al entrar y no antes, sin soloActivos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const st = await mockMotivos(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Trámites/ })).toBeVisible();
    expect(st.gets).toBe(0);
    const tabs = page.locator('div.flex.flex-wrap.gap-1.border-b button');
    await expect(tabs.last()).toHaveText('Motivos de llegada');
    await page.getByRole('button', { name: 'Motivos de llegada' }).click();
    await expect.poll(() => st.gets).toBeGreaterThanOrEqual(1);
    expect(st.getUrls.every((u) => !u.includes('soloActivos'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Motivos de llegada' })).toBeVisible();
    await expect(page.getByText('Sin dirección de entrega al recoger')).toBeVisible();
    await expect(page.getByText(SEED[0].id)).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Orden' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Eliminar/ })).toHaveCount(0);
    await expect(page.getByPlaceholder(/buscar/i)).toHaveCount(0);
  });

  test('AC3: esqueleto, error con Reintentar, 403 sin Reintentar, vacío y lleno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);

    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    const stHold = await mockMotivos(page, SEED, { holdGet: hold });
    await entrarAMotivos(page);
    await expect(page.getByRole('status', { name: 'Cargando motivos de llegada…' })).toBeVisible();
    release();
    await expect(page.getByText('Sin dirección de entrega al recoger')).toBeVisible();
    expect(stHold.gets).toBeGreaterThan(0);

    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const stErr = await mockMotivos(page, SEED, { getStatus: 500 });
    let siguiente = 500;
    await page.unroute(/\/api\/flito\/logistica\/motivos-llegada(?:\/|\?|$)/);
    await page.route(/\/api\/flito\/logistica\/motivos-llegada(?:\/|\?|$)/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      stErr.gets += 1;
      if (siguiente >= 500) return route.fulfill(json({ error: 'boom' }, 500));
      return route.fulfill(json(SEED));
    });
    await entrarAMotivos(page);
    const alerta = page.getByRole('alert').filter({ hasText: 'No pudimos cargar los motivos de llegada.' });
    await expect(alerta).toBeVisible();
    await expect(alerta.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    siguiente = 200;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Otro')).toBeVisible();

    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page, SEED, { getStatus: 403 });
    await entrarAMotivos(page);
    await expect(page.getByRole('alert').filter({ hasText: 'No tiene permiso para gestionar los motivos de llegada.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);

    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page, []);
    await entrarAMotivos(page);
    await expect(page.getByText('No hay motivos de llegada. Cree el primero con «Nuevo motivo».')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo motivo' })).toBeVisible();
  });

  test('AC2: 409 en línea con copy exacto, modal abierto, sin error crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    await entrarAMotivos(page);
    await page.getByRole('button', { name: 'Nuevo motivo' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel(/Nombre/).fill('otro');
    await modal.getByRole('button', { name: 'Crear motivo' }).click();
    await expect(modal.getByText('Ya existe un motivo de llegada con ese nombre. Cambie el nombre o edite el que ya está en la lista.')).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel(/Nombre/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/Ya existe un motivo de llegada llamado/)).toHaveCount(0);
  });

  test('AC1: crear al final, Subir/Bajar, desactivar y activar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const st = await mockMotivos(page);
    await entrarAMotivos(page);

    await page.getByRole('button', { name: 'Nuevo motivo' }).click();
    const crear = page.getByRole('dialog');
    await crear.getByLabel(/Nombre/).fill('Documentos incompletos en el organismo');
    await crear.getByRole('button', { name: 'Crear motivo' }).click();
    await expect.poll(() => st.posts.length).toBe(1);
    expect(st.posts[0]).toMatchObject({ nombre: 'Documentos incompletos en el organismo', orden: 40 });
    await expect(page.getByText('Motivo creado.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toBeVisible();
    const filas = page.getByRole('row');
    await expect(filas.last()).toContainText('Documentos incompletos en el organismo');

    await expect(page.getByRole('button', { name: 'Subir Sin dirección de entrega al recoger' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Bajar Documentos incompletos en el organismo' })).toBeDisabled();
    await page.getByRole('button', { name: 'Bajar Sin dirección de entrega al recoger' }).click();
    await expect.poll(() => st.patches.length).toBe(2);
    expect(st.patches[0].body).toEqual({ orden: 20 });
    expect(st.patches[1].body).toEqual({ orden: 10 });
    await expect(page.getByText('Orden actualizado.')).toBeVisible();

    await page.getByRole('button', { name: 'Editar Destino lejano (transportadora externa)' }).click();
    const editar = page.getByRole('dialog');
    await editar.getByLabel(/Nombre/).fill('Destino lejano');
    await editar.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Cambios guardados.')).toBeVisible();

    await page.getByRole('button', { name: 'Acciones de Otro' }).click();
    await page.getByRole('menuitem', { name: 'Desactivar' }).click();
    const desact = page.getByRole('dialog');
    await expect(desact.getByText(/Si desactiva «Otro», no aparecerá al registrar un viaje a FLIT/)).toBeVisible();
    await desact.getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Motivo desactivado. No aparecerá al registrar un viaje a FLIT.')).toBeVisible();

    await page.getByRole('button', { name: 'Activos', exact: true }).click();
    await expect(page.getByText('Otro', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Inactivos', exact: true }).click();
    await expect(page.getByText('Otro', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Acciones de Otro' }).click();
    await page.getByRole('menuitem', { name: 'Activar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Activar' }).click();
    await expect(page.getByText('Motivo activado.')).toBeVisible();
  });

  test('AC3: filtro sin filas muestra Ver todos; AC5 toast cerrable y 404 recarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    await entrarAMotivos(page);

    await page.getByRole('button', { name: 'Inactivos', exact: true }).click();
    await expect(page.getByText('Ningún motivo inactivo.')).toBeVisible();
    await page.getByRole('button', { name: 'Ver todos' }).click();
    await expect(page.getByText('Sin dirección de entrega al recoger')).toBeVisible();

    await page.unroute(/\/api\/flito\/logistica\/motivos-llegada(?:\/|\?|$)/);
    await mockMotivos(page, SEED);
    await page.route(/\/api\/flito\/logistica\/motivos-llegada\/11111111-1111-4111-8111-111111111111$/, (route) => {
      if (route.request().method() === 'PATCH') return route.fulfill(json({ error: 'gone' }, 404));
      return route.fallback();
    });
    await page.getByRole('button', { name: 'Editar Sin dirección de entrega al recoger' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel(/Nombre/).fill('Sin dirección');
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Ese motivo ya no está. Recargamos la lista.')).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText('Ese motivo ya no está. Recargamos la lista.')).toHaveCount(0);
  });

  test('AC1: Subir/Bajar con filtro Activos usa el vecino de la lista completa', async ({ page }) => {
    const ID_Z = '55555555-5555-4555-8555-555555555555';
    const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ID_Y = 'yyyyyyyy-yyyy-4yyy-8yyy-yyyyyyyyyyyy';
    const SEMILLA = [
      { id: ID_Z, nombre: 'Zeta lejano', activo: false, orden: 5 },
      { id: ID_A, nombre: 'Alfa recoger', activo: true, orden: 10 },
      { id: ID_B, nombre: 'Beta intermedio', activo: false, orden: 20 },
      { id: ID_C, nombre: 'Charlie entrega', activo: true, orden: 30 },
      { id: ID_Y, nombre: 'Yankee extra', activo: false, orden: 40 },
    ];
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    const st = await mockMotivos(page, SEMILLA);
    await entrarAMotivos(page);
    await page.getByRole('button', { name: 'Activos', exact: true }).click();
    await expect(page.getByText('Alfa recoger')).toBeVisible();
    await expect(page.getByText('Charlie entrega')).toBeVisible();
    await expect(page.getByText('Beta intermedio')).toHaveCount(0);

    await expect(page.getByRole('button', { name: 'Subir Alfa recoger' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Bajar Charlie entrega' })).toBeEnabled();

    await page.getByRole('button', { name: 'Bajar Alfa recoger' }).click();
    await expect.poll(() => st.patches.length).toBe(2);
    expect(st.patches[0].url).toContain(ID_A);
    expect(st.patches[0].body).toEqual({ orden: 20 });
    expect(st.patches[1].url).toContain(ID_B);
    expect(st.patches[1].body).toEqual({ orden: 10 });
    expect(st.patches.some((p) => p.url.includes(ID_C))).toBe(false);
  });

  test('AC5: Nombre vacío en línea; label asociado y foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mockMotivos(page);
    await entrarAMotivos(page);
    await page.getByRole('button', { name: 'Nuevo motivo' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel(/Nombre/)).toHaveAttribute('aria-required', 'true');
    await modal.getByRole('button', { name: 'Crear motivo' }).click();
    await expect(modal.getByText('Escriba el nombre del motivo.')).toBeVisible();
    await expect(modal.getByLabel(/Nombre/)).toBeFocused();
  });
});
