// HU #12087 — Permisos por usuario: picker de 5 estados, `funciones` en el body, modal de cambio de rol.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

const F = (codigo: string, nombreNegocio: string) =>
  ({ codigo, nombreNegocio, descripcion: null, tipo: 'pagina' as const });

const GRUPOS = [
  { modulo: 'usuarios', funciones: [
    F('pagina.users', 'Entrar a Usuarios'),
    F('pagina.rndc', 'RNDC y manifiestos'),
    F('usuarios.usuario.exportar', 'Exportar usuarios a Excel'),
  ] },
  { modulo: 'general', funciones: [F('pagina.dashboard', 'Entrar al tablero')] },
];

const CUADRO_COMPLIANCE = ['pagina.users', 'pagina.dashboard'];
const CUADRO_AUDITOR = ['pagina.dashboard'];

function mockPermisos(page: Page, cuadros: Record<string, string[]> = {
  compliance: CUADRO_COMPLIANCE,
  auditor: CUADRO_AUDITOR,
  admin: [...CUADRO_COMPLIANCE, 'pagina.rndc', 'usuarios.usuario.exportar'],
}) {
  page.route(/\/api\/permisos\/funciones$/, (route) => route.fulfill(json({ grupos: GRUPOS })));
  page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (route) => {
    const codigo = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
    return route.fulfill(json({
      codigo,
      tipoPrincipal: 'interno',
      funciones: cuadros[codigo] ?? [],
    }));
  });
}

test.describe('Usuarios — permisos por excepción (HU #12087)', () => {
  test('tres etiquetas visibles; desmarcar del rol manda revocar; marcar fuera manda conceder', async ({ page }) => {
    const compliance = {
      id: 2, username: 'cumplimiento', name: 'Cumplimiento', email: null, role: 'compliance', active: true,
      allowedPages: [], funciones: [] as { codigo: string; efecto: string }[],
      flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: new Date().toISOString(),
    };

    await page.route('**/api/users', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill(json([compliance]));
      return route.fulfill(json({}, 405));
    });

    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/users/2', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        return route.fulfill(json({ ...compliance, funciones: patchBody?.funciones ?? [] }));
      }
      return route.fulfill(json({}, 405));
    });

    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await page.getByRole('button', { name: /^editar$/i }).first().click();
    // Abrir acordeón Usuarios (etiquetas de módulo).
    await page.getByRole('button', { name: /Usuarios/i }).first().click();

    await expect(page.getByText('Lo trae el rol').first()).toBeVisible();

    // Desmarcar «Entrar a Usuarios» (viene del rol) → quitado + revocar.
    const casillaUsers = page.locator('input[data-codigo="pagina.users"]');
    await expect(casillaUsers).toBeChecked();
    await casillaUsers.click();
    await expect(page.getByText('Quitado').first()).toBeVisible();

    // Marcar RNDC (no está en el cuadro de compliance) → Añadido + conceder.
    await casillaUsers.locator('xpath=ancestor::div[contains(@class,"space-y")]').locator('input[data-codigo="pagina.rndc"]').click().catch(async () => {
      await page.locator('input[data-codigo="pagina.rndc"]').click();
    });
    await expect(page.getByText('Añadido').first()).toBeVisible();

    await page.getByRole('button', { name: /guardar cambios/i }).click();
    await expect.poll(() => patchBody, { timeout: 5000 }).not.toBeNull();
    const funcs = (patchBody as { funciones: { codigo: string; efecto: string }[] }).funciones;
    expect(funcs).toEqual(expect.arrayContaining([
      { codigo: 'pagina.users', efecto: 'revocar' },
      { codigo: 'pagina.rndc', efecto: 'conceder' },
    ]));
    expect(patchBody).not.toHaveProperty('allowedPages');
  });

  test('admin sin cartel Acceso total; casillas del cuadro marcadas', async ({ page }) => {
    const admin = {
      id: 1, username: 'admin', name: 'Admin', email: null, role: 'admin', active: true,
      allowedPages: [], funciones: [], flitoProveedorSoatId: null, organismosCodigos: [],
      createdAt: new Date().toISOString(),
    };
    await page.route('**/api/users', (route) => route.fulfill(json([admin])));
    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByRole('button', { name: /^editar$/i }).first().click();
    await expect(page.getByText('Acceso total')).toHaveCount(0);
    await page.getByRole('button', { name: /Usuarios/i }).first().click();
    await expect(page.locator('input[data-codigo="pagina.users"]')).toBeChecked();
    await expect(page.getByText('Lo trae el rol').first()).toBeVisible();
  });

  test('cambio de rol con excepciones abre modal y PATCH lleva las conservadas', async ({ page }) => {
    const compliance = {
      id: 2, username: 'cumplimiento', name: 'Cumplimiento', email: null, role: 'compliance', active: true,
      allowedPages: [],
      funciones: [
        { codigo: 'pagina.users', efecto: 'revocar' },
        { codigo: 'pagina.rndc', efecto: 'conceder' },
      ],
      flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: new Date().toISOString(),
    };

    await page.route('**/api/users', (route) => route.fulfill(json([compliance])));
    let patchBody: Record<string, unknown> | null = null;
    await page.route('**/api/users/2', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        return route.fulfill(json({ ...compliance, ...patchBody }));
      }
      return route.fulfill(json({}, 405));
    });
    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByRole('button', { name: /^editar$/i }).first().click();

    await page.getByLabel('Rol base').selectOption('auditor');
    await page.getByRole('button', { name: /guardar cambios/i }).click();

    await expect(page.getByRole('heading', { name: /Conservar excepciones/i })).toBeVisible();
    // revocar users + auditor NO da users → sin sentido → desmarcada
    // conceder rndc + auditor NO da rndc → conservar → premarcada
    const conservarRndc = page.locator('#conservar-pagina\\.rndc');
    const conservarUsers = page.locator('#conservar-pagina\\.users');
    await expect(conservarRndc).toBeChecked();
    await expect(conservarUsers).not.toBeChecked();

    await page.getByRole('button', { name: /^Confirmar$/i }).click();
    await expect.poll(() => patchBody, { timeout: 5000 }).not.toBeNull();
    expect(patchBody).toMatchObject({ role: 'auditor' });
    expect((patchBody as { funciones: unknown[] }).funciones).toEqual([
      { codigo: 'pagina.rndc', efecto: 'conceder' },
    ]);
  });

  test('toast de re-login al quitar acceso (revocar)', async ({ page }) => {
    const compliance = {
      id: 2, username: 'cumplimiento', name: 'Cumplimiento', email: null, role: 'compliance', active: true,
      allowedPages: [], funciones: [] as { codigo: string; efecto: string }[],
      flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: new Date().toISOString(),
    };
    await page.route('**/api/users', (route) => route.fulfill(json([compliance])));
    await page.route('**/api/users/2', (route) => {
      if (route.request().method() === 'PATCH') return route.fulfill(json({ ...compliance, funciones: route.request().postDataJSON().funciones }));
      return route.fulfill(json({}, 405));
    });
    mockPermisos(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByRole('button', { name: /^editar$/i }).first().click();
    await page.getByRole('button', { name: /Usuarios/i }).first().click();
    await page.locator('input[data-codigo="pagina.users"]').click();
    await page.getByRole('button', { name: /guardar cambios/i }).click();
    await expect(page.getByText(/volver a iniciar sesión para aplicar los nuevos permisos/i)).toBeVisible();
  });
});
