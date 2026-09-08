import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, PROVEEDOR_USER } from '../helpers/auth';

// USR-8: E2E del módulo Usuarios. Verifica el cierre del Sprint USR:
// auditor asignable (USR-2/3), permisos no se recortan al editar (USR-4) y un
// usuario restringido no accede a páginas fuera de su permiso (modelo unificado).
// La API se mockea con page.route (no requiere backend real).
//
// Las filas llevan `flitoProveedorSoatId` y `organismosCodigos` desde la HU #12053: el contrato dice
// que el segundo es SIEMPRE un array —`[]` para los once roles que no son gestor—, y un fixture que
// se los saltara estaría probando una respuesta que la API no devuelve.

const json = (body: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

test.describe('Usuarios — gestión y permisos', () => {
  test('admin crea usuario con rol auditor → aparece en el listado', async ({ page }) => {
    const users: any[] = [
      { id: 1, username: 'admin', name: 'Admin', email: null, role: 'admin', active: true, allowedPages: [], flitoProveedorSoatId: null, organismosCodigos: [], createdAt: new Date().toISOString() },
    ];

    await page.route('**/api/users', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        const b = req.postDataJSON();
        const created = { id: 99, username: b.username, name: b.name, email: b.email ?? null, role: b.role, active: true, allowedPages: b.allowedPages ?? [], flitoProveedorSoatId: null, organismosCodigos: [], createdAt: new Date().toISOString() };
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
    //
    // El aserto del ROL va acotado a la tabla desde la HU #12172: el filtro por rol pone las doce
    // etiquetas en un `<option>`, así que `getByText('Auditor (revisor fiscal)')` a secas pasó a
    // resolver DOS elementos —la opción y la celda— y el caso caía por violación de modo estricto.
    // Ese, y solo ese, es el motivo de `getByRole('table')`: desambigua el locator sin aflojar la
    // aserción, que sigue siendo «la fila está en el listado».
    //
    // Lo que NO es motivo, para que nadie lo vuelva a escribir: la opción del desplegable no podía
    // dar el aserto por bueno. Playwright considera `hidden` un `<option>` dentro de un `<select>`
    // cerrado, así que el locator sin acotar fallaba con «Expected: visible / Received: hidden»
    // —comprobado con sonda— y jamás se habría satisfecho sin que el usuario se creara.
    await expect(page.getByRole('table').getByText('auditor_e2e')).toBeVisible();
    await expect(page.getByRole('table').getByText('Auditor (revisor fiscal)')).toBeVisible();
  });

  test('editar usuario conserva/añade allowedPages (USR-4: no se recortan)', async ({ page }) => {
    const compliance = { id: 2, username: 'cumplimiento', name: 'Cumplimiento', email: null, role: 'compliance', active: true, allowedPages: [] as string[], flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: new Date().toISOString() };

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
