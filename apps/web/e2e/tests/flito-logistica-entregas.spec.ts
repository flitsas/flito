import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, funcionesDe } from '../helpers/auth';

// HU #14125 — Pestaña Entregas: POST /traslados/buscar con el filtro en el body, nunca en la URL.

const FUNCION = 'logistica.consola.ver';
const CON_CONSOLA = [...new Set([...funcionesDe(OPERACIONES_USER), FUNCION])];
const SIN_CONSOLA = funcionesDe(OPERACIONES_USER).filter((f) => f !== FUNCION);

const COMPANIAS = [
  { companiaId: 10, nombre: 'Transportes Andinos' },
  { companiaId: 20, nombre: 'Logística Norte' },
  { companiaId: 30, nombre: null },
];

const FILAS = [
  { id: '11111111-1111-4111-8111-111111111111', companiaId: 10, companiaNombre: 'Transportes Andinos', destino: 'cliente', estado: 'registrado', cantidadLt: 2, registradoEn: '2026-10-28T15:04:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', companiaId: 20, companiaNombre: 'Logística Norte', destino: 'flit', estado: 'en_ruta', cantidadLt: 1, registradoEn: '2026-10-27T11:00:00.000Z' },
  { id: '33333333-3333-4333-8333-333333333333', companiaId: 10, companiaNombre: 'Transportes Andinos', destino: 'cliente', estado: 'entregado', cantidadLt: 4, registradoEn: '2026-10-26T09:30:00.000Z' },
  { id: '44444444-4444-4444-8444-444444444444', companiaId: 20, companiaNombre: 'Logística Norte', destino: 'flit', estado: 'devuelto', cantidadLt: 1, registradoEn: '2026-10-25T18:15:00.000Z' },
  { id: '55555555-5555-4555-8555-555555555555', companiaId: 30, companiaNombre: null, destino: 'cliente', estado: 'anulado', cantidadLt: 3, registradoEn: '2026-10-24T08:00:00.000Z' },
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

async function mockEntregas(
  page: import('@playwright/test').Page,
  opts: { status?: number; vacio?: boolean; hold?: Promise<void> } = {},
) {
  const st = {
    posts: 0,
    bodies: [] as Array<Record<string, unknown>>,
    urls: [] as string[],
  };
  let soltado = false;
  await page.route(/\/api\/flito\/logistica\/traslados\/buscar(?:\?|$)/, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    st.posts += 1;
    st.urls.push(req.url());
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    st.bodies.push(body);
    if (opts.hold && !soltado) await opts.hold;
    soltado = true;
    if (opts.status === 403) return route.fulfill(json({ error: 'Sin permisos' }, 403));
    if (opts.status && opts.status >= 400) return route.fulfill(json({ error: 'boom', placa: 'NO-DEBE-VERSE' }, opts.status));
    const vacio = opts.vacio === true;
    return route.fulfill(json({ viajes: vacio ? [] : FILAS, companias: COMPANIAS, truncado: true }));
  });
  return st;
}

async function entrar(page: import('@playwright/test').Page) {
  await loginAs(page, OPERACIONES_USER, { funciones: CON_CONSOLA });
  await mockConsola(page);
}

test.describe('FLITO — Logística · Entregas (HU #14125)', () => {
  test('sin la función no hay pestaña ni POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: SIN_CONSOLA });
    await mockConsola(page);
    const st = await mockEntregas(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Trámites/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entregas', exact: true })).toHaveCount(0);
    expect(st.posts).toBe(0);
  });

  test('al abrir pide {} y los filtros van solo en el body', async ({ page }) => {
    await entrar(page);
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => { release = r; });
    const st = await mockEntregas(page, { hold });
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Trámites/ })).toBeVisible();
    expect(st.posts).toBe(0);

    const tabs = page.locator('div.flex.flex-wrap.gap-1.border-b button');
    const textos = (await tabs.allTextContents()).map((t) => t.trim());
    const iViajes = textos.indexOf('Viajes');
    const iEntregas = textos.indexOf('Entregas');
    const iActas = textos.indexOf('Actas');
    expect(iViajes).toBeGreaterThanOrEqual(0);
    expect(iEntregas).toBe(iViajes + 1);
    expect(iActas).toBe(iEntregas + 1);

    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Cargando viajes…' })).toBeVisible();
    await expect(page.getByLabel('Placa')).toBeDisabled();
    await expect.poll(() => st.posts).toBeGreaterThanOrEqual(1);
    expect(st.bodies.every((b) => Object.keys(b).length === 0)).toBe(true);
    expect(st.urls.every((u) => u.includes('/flito/logistica/traslados/buscar') && new URL(u).search === '')).toBe(true);
    await expect(page).toHaveURL(/\/flito\/logistica$/);

    release();
    const tabla = page.getByRole('region', { name: 'Viajes' });
    await expect(tabla).toBeVisible();
    for (const texto of ['Registrado', 'En ruta', 'Entregado', 'Devuelto', 'Anulado', 'Cliente', 'FLIT']) {
      await expect(tabla.getByText(texto, { exact: true }).first()).toBeVisible();
    }
    await expect(tabla.getByText('compañía #30')).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: 'Acciones' })).toHaveCount(0);
    await expect(tabla.locator('a')).toHaveCount(0);
    await expect(tabla.getByRole('link')).toHaveCount(0);
    await expect(tabla.getByRole('button')).toHaveCount(0);
    await expect(page.getByText(/truncado/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Registrar viaje/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirmar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Entregar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Firmar/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Devolver/ })).toHaveCount(0);

    const fila = tabla.getByRole('row', { name: /Transportes Andinos/ }).first();
    await expect(fila.locator('a')).toHaveCount(0);
    await fila.click();
    await expect(page).toHaveURL(/\/flito\/logistica$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(page.getByLabel('Estado')).toBeEnabled();
    await page.getByLabel('Estado').selectOption('en_ruta');
    await expect.poll(() => st.bodies.at(-1)).toEqual({ estado: 'en_ruta' });

    await expect(page.getByLabel('Destino')).toBeEnabled();
    await page.getByLabel('Destino').selectOption('flit');
    await expect.poll(() => st.bodies.at(-1)).toEqual({ estado: 'en_ruta', destino: 'flit' });

    await expect(page.getByLabel('Compañía')).toBeEnabled();
    await page.getByLabel('Compañía').selectOption({ label: 'Transportes Andinos' });
    await expect.poll(() => st.bodies.at(-1)).toEqual({ estado: 'en_ruta', destino: 'flit', companiaId: 10 });

    await page.getByLabel('Placa').fill('ABC12');
    await expect.poll(() => st.bodies.at(-1)).toEqual({
      placa: 'ABC12', estado: 'en_ruta', destino: 'flit', companiaId: 10,
    });

    const url = page.url();
    expect(new URL(url).pathname).toBe('/flito/logistica');
    expect(new URL(url).search).toBe('');
    expect(url.toLowerCase()).not.toContain('placa');
    expect(url).not.toContain('ABC12');
    expect(st.urls.every((u) => new URL(u).search === '' && !u.toLowerCase().includes('placa='))).toBe(true);
  });

  test('403 sin Reintentar y otro fallo con Reintentar', async ({ page }) => {
    await entrar(page);
    await mockEntregas(page, { status: 403 });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    await expect(page.getByText('No tiene permiso para ver los viajes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByText('Sin permisos')).toHaveCount(0);

    await entrar(page);
    let fallo = true;
    const st = await mockEntregas(page, { status: 500 });
    await page.unroute(/\/api\/flito\/logistica\/traslados\/buscar(?:\?|$)/);
    await page.route(/\/api\/flito\/logistica\/traslados\/buscar(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      st.posts += 1;
      st.bodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
      if (fallo) return route.fulfill(json({ error: 'boom', detalle: 'stack interno' }, 500));
      return route.fulfill(json({ viajes: FILAS, companias: COMPANIAS, truncado: false }));
    });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    const alerta = page.getByRole('alert').filter({ hasText: 'No se pudieron cargar los viajes. Inténtelo de nuevo.' });
    await expect(alerta).toBeVisible();
    await expect(alerta.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText('boom')).toHaveCount(0);
    await expect(page.getByText('stack interno')).toHaveCount(0);
    fallo = false;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('tbody').getByText('Registrado', { exact: true }).first()).toBeVisible();
  });

  test('vacío real y vacío por filtro con Limpiar filtros', async ({ page }) => {
    await entrar(page);
    const st = await mockEntregas(page, { vacio: true });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    await expect(page.getByText('Aún no hay viajes. Regístrelos en Viajes: cuando queden registrados, aparecen aquí.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Viajes' })).toHaveCount(0);

    await expect(page.getByLabel('Estado')).toBeEnabled();
    await page.getByLabel('Estado').selectOption('devuelto');
    await expect.poll(() => st.bodies.at(-1)).toEqual({ estado: 'devuelto' });
    await expect(page.getByText('Ningún viaje coincide con estos filtros. Pruebe otra placa o quite un filtro.')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => st.bodies.at(-1)).toEqual({});
    await expect(page.getByText('Aún no hay viajes. Regístrelos en Viajes: cuando queden registrados, aparecen aquí.')).toBeVisible();
    await expect(page).toHaveURL(/\/flito\/logistica$/);
    expect(page.url()).not.toContain('placa');
    expect(new URL(page.url()).search).toBe('');
  });
});
