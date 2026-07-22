import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// USR-8: E2E del módulo Usuarios. Verifica el cierre del Sprint USR:
// auditor asignable (USR-2/3), permisos no se recortan al editar (USR-4) y un
// usuario restringido no accede a páginas fuera de su permiso (modelo unificado).
// La API se mockea con page.route (no requiere backend real).

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

test.describe('Usuarios — gestión y permisos', () => {
  test('admin crea usuario con rol auditor → aparece en el listado', async ({ page }) => {
    const users: any[] = [
      { id: 1, username: 'admin', name: 'Admin', email: null, role: 'admin', active: true, allowedPages: [], createdAt: new Date().toISOString() },
    ];

    await page.route('**/api/users', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        const b = req.postDataJSON();
        const created = { id: 99, username: b.username, name: b.name, email: b.email ?? null, role: b.role, active: true, allowedPages: b.allowedPages ?? [], createdAt: new Date().toISOString() };
        users.push(created);
        return route.fulfill(json(created, 201));
      }
      return route.fulfill(json(users)); // GET listado (incluye los creados)
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await page.getByRole('button', { name: /nuevo usuario/i }).click();
    await page.getByLabel('Username (login)').fill('auditor_e2e');
    await page.getByLabel('Nombre completo').fill('Auditor E2E');
    await page.getByLabel('Contraseña').fill('Aa1!aaaa');
    await page.getByLabel('Rol base').selectOption('auditor');
    await page.getByRole('button', { name: /crear usuario/i }).click();

    // Tras crear, la página recarga el listado → debe aparecer la fila del auditor.
    await expect(page.getByText('auditor_e2e')).toBeVisible();
    await expect(page.getByText('Auditor (revisor fiscal)')).toBeVisible();
  });

  test('editar usuario conserva/añade allowedPages (USR-4: no se recortan)', async ({ page }) => {
    const compliance = { id: 2, username: 'cumplimiento', name: 'Cumplimiento', email: null, role: 'compliance', active: true, allowedPages: [] as string[], createdAt: new Date().toISOString() };

    await page.route('**/api/users', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill(json([compliance]));
      return route.fulfill(json({}, 405));
    });

    let patchBody: any = null;
    await page.route('**/api/users/2', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        return route.fulfill(json({ ...compliance, allowedPages: patchBody.allowedPages ?? [] }));
      }
      return route.fulfill(json({}, 405));
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await page.getByRole('button', { name: /^editar$/i }).first().click();
    // 'RNDC y manifiestos' NO está en los defaults de compliance → checkbox habilitable.
    await page.getByRole('checkbox', { name: /RNDC y manifiestos/i }).check();
    await page.getByRole('button', { name: /guardar cambios/i }).click();

    await expect.poll(() => patchBody, { timeout: 5000 }).not.toBeNull();
    expect(patchBody.allowedPages).toContain('rndc');
  });

  test('usuario restringido no accede a /users (NoAccess) pero sí a páginas permitidas', async ({ page }) => {
    // Catch-all para que las páginas permitidas no fallen por API real ausente.
    await page.route('**/api/**', async (route) => {
      if (route.request().url().includes('/auth/me')) return route.continue();
      return route.fulfill(json([]));
    });

    await loginAs(page, PROVEEDOR_USER); // role proveedor, allowedPages vehicles+soat

    await page.goto('/users');
    await expect(page.getByRole('heading', { name: /no tienes acceso a usuarios/i })).toBeVisible();

    await page.goto('/soat'); // permitido (default del rol proveedor)
    await expect(page.getByRole('heading', { name: /no tienes acceso/i })).toHaveCount(0);
  });
});
