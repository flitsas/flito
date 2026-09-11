// HU #12089 — Baja lógica de usuarios: listado sin bajas, filtro «Dados de baja», reactivar.
//
// Mock API con `page.route` (mismo patrón que users-reporte). Certifica la PANTALLA:
// qué query pide, qué chip pinta y que Reactivar llama POST /reactivar.

import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

type Fila = Record<string, unknown>;

function usuario(over: Fila): Fila {
  return {
    id: 2, username: 'u', name: 'Usuario', email: null, role: 'compliance', active: true,
    allowedPages: [], funciones: [], flitoProveedorSoatId: null, organismosCodigos: [],
    createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...over,
  };
}

const VIVO = usuario({ id: 2, username: 'cumple', name: 'Carlos Cumplimiento' });
const BAJA = usuario({
  id: 3, username: 'baja_u', name: 'Baja Uno', role: 'auditor',
  deletedAt: '2026-09-01T12:00:00.000Z',
});

const RESUMEN = {
  porRol: {
    admin: 1, compliance: 1, auditor: 1, transito: 0, proveedor: 0, lider_pesv: 0,
    supervisor_flota: 0, conductor: 0, gestor_impuestos: 0, mensajero: 0, financiera: 0, cliente: 0,
  },
  activos: 2,
  inactivos: 0,
};

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

test.describe('Usuarios — baja lógica (HU #12089)', () => {
  test('lista en alta no pide bajas y no muestra chip «Dado de baja»', async ({ page }) => {
    const pedidos = mockListado(page, ({ soloBajas, incluirBajas }) => {
      if (soloBajas) return [BAJA];
      if (incluirBajas) return [VIVO, BAJA];
      return [VIVO];
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await expect(page.getByRole('table').getByText('cumple')).toBeVisible();
    await expect(page.getByRole('table').getByText('Dado de baja')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Dar de baja$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Desactivar$/i })).toBeVisible();

    const ultimo = pedidos.at(-1) ?? '';
    expect(ultimo).not.toMatch(/soloBajas=/);
    expect(ultimo).not.toMatch(/incluirBajas=/);
  });

  test('filtro «Dados de baja» pide soloBajas y muestra chip + Reactivar', async ({ page }) => {
    const pedidos = mockListado(page, ({ soloBajas }) => (soloBajas ? [BAJA] : [VIVO]));

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await expect(page.getByRole('table').getByText('cumple')).toBeVisible();

    await page.getByLabel('Vista').selectOption('dados_de_baja');

    await expect(page.getByRole('table').getByText('baja_u')).toBeVisible();
    await expect(page.getByRole('table').getByText('Dado de baja')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reactivar$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Dar de baja$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Desactivar$/i })).toHaveCount(0);

    expect(pedidos.some((u) => u.includes('soloBajas=true'))).toBe(true);
  });

  test('Reactivar llama POST /users/:id/reactivar y recarga en alta', async ({ page }) => {
    let reactivarUrl: string | null = null;
    let dadoDeBaja = true;

    mockListado(page, () => (dadoDeBaja ? [BAJA] : [VIVO]));

    await page.route(/\/api\/users\/\d+\/reactivar$/, async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill(json({}, 405));
      reactivarUrl = route.request().url();
      dadoDeBaja = false;
      return route.fulfill(json({ ...BAJA, deletedAt: null }));
    });

    page.on('dialog', (d) => { void d.accept(); });

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByLabel('Vista').selectOption('dados_de_baja');
    await expect(page.getByRole('button', { name: /^Reactivar$/i })).toBeVisible();

    await page.getByRole('button', { name: /^Reactivar$/i }).click();

    await expect.poll(() => reactivarUrl).toMatch(/\/api\/users\/3\/reactivar/);
    await page.getByLabel('Vista').selectOption('en_alta');
    await expect(page.getByRole('table').getByText('cumple')).toBeVisible();
  });

  test('vacío con filtro bajas muestra mensaje específico', async ({ page }) => {
    mockListado(page, ({ soloBajas }) => (soloBajas ? [] : [VIVO]));

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByLabel('Vista').selectOption('dados_de_baja');

    await expect(page.getByText('Nadie dado de baja')).toBeVisible();
  });
});

/**
 * Mock del listado + resumen. `pedidos` guarda URLs del GET listado para afirmar la query.
 * Rutas más específicas (`/resumen`, `/reactivar`) se registran después del catch-all.
 */
function mockListado(
  page: Page,
  filas: (q: { soloBajas: boolean; incluirBajas: boolean }) => Fila[],
): string[] {
  const pedidos: string[] = [];
  page.route(/\/api\/users(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fulfill(json({}, 405));
    const url = route.request().url();
    pedidos.push(url);
    const sp = new URL(url).searchParams;
    const body = filas({
      soloBajas: sp.get('soloBajas') === 'true',
      incluirBajas: sp.get('incluirBajas') === 'true',
    });
    return route.fulfill({
      ...json(body),
      headers: { 'content-type': 'application/json', 'X-Total-Count': String(body.length) },
    });
  });
  page.route(/\/api\/users\/resumen$/, (route) => route.fulfill(json(RESUMEN)));
  return pedidos;
}
