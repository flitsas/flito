import { test, expect, type Page } from '@playwright/test';
import { loginAs, OPERACIONES_USER, funcionesDe } from '../helpers/auth';

// Épica #13758 — pestañas de Logística según función, «Enviar a cliente» (LT en FLIT) y «Anular viaje».
// Diseño: docs/ux/logistica-enviar-a-cliente-y-anular-viaje-slim.md

const BASE = funcionesDe(OPERACIONES_USER).filter((f) => !f.startsWith('logistica.'));
const conFunciones = (...f: string[]) => [...new Set([...BASE, ...f])];

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json' as const, body: JSON.stringify(body) });

const FACETAS = {
  estados: [], empresas: [], organismos: [], mensajeros: [],
  companiasCerrables: [{
    companiaId: 10, nombre: 'Transportes Andinos', disponibles: 3, precioEntregaCliente: 50000, precioEntregaFlit: 30000,
    lts: [
      { documentoId: 'doc-org', origen: 'organismo', placa: 'ORG111', numeroLt: '1001', idFlit: 'F1' },
      { documentoId: 'doc-fl-1', origen: 'flit', placa: 'FLI222', numeroLt: '1002', idFlit: 'F2' },
      { documentoId: 'doc-fl-2', origen: 'flit', placa: 'FLI333', numeroLt: '1003', idFlit: 'F3' },
    ],
  }],
};

const VIAJES = [
  { id: '11111111-1111-4111-8111-111111111111', companiaId: 10, companiaNombre: 'Transportes Andinos', destino: 'cliente', estado: 'registrado', cantidadLt: 2, registradoEn: '2026-10-28T15:04:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', companiaId: 20, companiaNombre: 'Logística Norte', destino: 'flit', estado: 'en_ruta', cantidadLt: 1, registradoEn: '2026-10-27T11:00:00.000Z' },
];

async function mockBase(page: Page) {
  const pedidos: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/flito/logistica')) pedidos.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route(/\/api\/flito\/logistica\/facetas/, (r) => r.fulfill(json(FACETAS)));
  await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/logistica\/buscar$/, (r) => r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/logistica\/traslados\/buscar/, (r) => r.fulfill(json({ viajes: VIAJES, companias: [] })));
  return pedidos;
}

test.describe('Logística — pestañas por función', () => {
  test('solo actas.listar: una pestaña, sin pedir trámites ni facetas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones('logistica.actas.listar') });
    const pedidos = await mockBase(page);
    await page.goto('/flito/logistica');
    // Con una sola pestaña visible no se pinta la barra (HU #14353).
    await expect(page.locator('div.flex.flex-wrap.gap-1.border-b button')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Actas' })).toBeVisible();
    expect(pedidos.some((p) => p === 'POST /api/flito/logistica/buscar')).toBe(false);
    expect(pedidos.some((p) => p.endsWith('/facetas'))).toBe(false);
    expect(pedidos.some((p) => p.endsWith('/logistica/actas'))).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('sin ninguna función: pantalla de acceso denegado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones() });
    await mockBase(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('heading', { name: /No tienes acceso a FLITO — Logística/ })).toBeVisible();
  });

  test('403 con la página abierta: quita la pestaña y avisa', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones('logistica.actas.listar', 'logistica.consola.ver') });
    await mockBase(page);
    await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json({ error: 'Sin permisos' }, 403)));
    await page.goto('/flito/logistica');
    await expect(page.getByText('Ya no tiene acceso a esta sección. Vuelva a iniciar sesión si cree que es un error.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Actas/ })).toHaveCount(0);
  });
});

test.describe('Logística — Enviar a cliente', () => {
  const FUN = conFunciones('logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.traslado.registrar');

  test('LT en FLIT: bloques, modal sin costo y POST solo con origen flit', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: FUN });
    await mockBase(page);
    const posts: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/flito\/logistica\/traslados$/, async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      posts.push(r.request().postDataJSON());
      return r.fulfill(json({ id: 'v1' }, 201));
    });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).first().click();
    await expect(page.getByText('Clasificadas (1)')).toBeVisible();
    await expect(page.getByText('En FLIT (2)')).toBeVisible();
    await page.getByRole('button', { name: 'Enviar a cliente' }).click();
    const dlg = page.getByRole('dialog', { name: /Enviar a cliente/ });
    await expect(dlg.getByText('Este tramo no tiene costo.')).toBeVisible();
    await expect(dlg.getByLabel(/FLI222/)).toBeChecked();
    await expect(dlg.getByLabel(/ORG111/)).toHaveCount(0);
    await dlg.getByLabel(/FLI333/).uncheck();
    await dlg.getByRole('button', { name: 'Enviar a cliente' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ companiaId: 10, destino: 'cliente', origen: 'flit', lts: [{ documentoId: 'doc-fl-1' }] });
  });

  test('409: copy fijo, nunca el texto del API', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: FUN });
    await mockBase(page);
    await page.route(/\/api\/flito\/logistica\/traslados$/, (r) =>
      r.request().method() === 'POST' ? r.fulfill(json({ error: 'TrasladoOrigenMixtoError interno' }, 409)) : r.fallback());
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).first().click();
    await page.getByRole('button', { name: 'Enviar a cliente' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enviar a cliente' }).click();
    await expect(page.getByRole('alert')).toContainText('Alguna LT ya no está en FLIT.');
    await expect(page.getByText('TrasladoOrigenMixtoError')).toHaveCount(0);
  });

  test('409 LT_DE_OTRO_PROVEEDOR (HU #14350): copy propio, nunca el texto del API', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: FUN });
    await mockBase(page);
    const crudo = 'Una o más LT no son del proveedor actual de la compañía';
    await page.route(/\/api\/flito\/logistica\/traslados$/, (r) =>
      r.request().method() === 'POST' ? r.fulfill(json({ error: crudo, codigo: 'LT_DE_OTRO_PROVEEDOR', detalle: { documentoIds: ['doc-fl-1'] } }, 409)) : r.fallback());
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).first().click();
    await page.getByRole('button', { name: 'Enviar a cliente' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enviar a cliente' }).click();
    await expect(page.getByRole('alert')).toContainText('Alguna LT ya no es del proveedor actual de la compañía.');
    await expect(page.getByText(crudo)).toHaveCount(0);
  });
});

test.describe('Logística — Anular viaje', () => {
  const BASE_FUN = ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar'];

  test('sin traslado.anular no hay columna Acciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones(...BASE_FUN) });
    await mockBase(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    const tabla = page.getByRole('region', { name: 'Viajes' });
    await expect(tabla.getByText('Transportes Andinos')).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: 'Acciones' })).toHaveCount(0);
  });

  test('solo filas registrado, motivo obligatorio y POST con { motivo }', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones(...BASE_FUN, 'logistica.traslado.anular') });
    await mockBase(page);
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    await page.route(/\/api\/flito\/logistica\/traslados\/[^/]+\/anular$/, (r) => {
      posts.push({ url: r.request().url(), body: r.request().postDataJSON() });
      return r.fulfill(json({ ok: true }));
    });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    const tabla = page.getByRole('region', { name: 'Viajes' });
    await expect(tabla.getByRole('columnheader', { name: 'Acciones' })).toBeVisible();
    await expect(tabla.getByRole('button', { name: /Anular viaje/ })).toHaveCount(1);
    await tabla.getByRole('button', { name: /Anular viaje de Transportes Andinos, 2 LT/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Anular viaje' });
    const confirmar = dlg.getByRole('button', { name: 'Anular viaje' });
    await expect(confirmar).toBeDisabled();
    await dlg.getByLabel('Motivo de la anulación (obligatorio)').fill('   ');
    await expect(confirmar).toBeDisabled();
    await dlg.getByLabel('Motivo de la anulación (obligatorio)').fill('Viaje registrado por error');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toEqual({ motivo: 'Viaje registrado por error' });
    expect(posts[0].url).toContain('/traslados/11111111-1111-4111-8111-111111111111/anular');
  });

  test('409: copy fijo y la lista se recarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: conFunciones(...BASE_FUN, 'logistica.traslado.anular') });
    await mockBase(page);
    await page.route(/\/api\/flito\/logistica\/traslados\/[^/]+\/anular$/, (r) => r.fulfill(json({ error: 'ESTADO crudo' }, 409)));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    await page.getByRole('button', { name: /Anular viaje de Transportes Andinos/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Anular viaje' });
    await dlg.getByLabel('Motivo de la anulación (obligatorio)').fill('Error');
    await dlg.getByRole('button', { name: 'Anular viaje' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Este viaje ya no se puede anular porque cambió de estado.');
    await expect(page.getByText('ESTADO crudo')).toHaveCount(0);
  });
});
