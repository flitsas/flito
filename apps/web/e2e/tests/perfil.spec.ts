// Mi perfil (HU #13256) — menú de sesión del Topbar y página /perfil con cambio de contraseña.
//
// Spec UX: docs/ux/perfil.md. Todo el API se mockea: `/auth/me` lo siembra `loginAs` y aquí se
// sobrescribe cuando el AC lo pide; `PATCH /users/:id/password` se espía para afirmar cuándo NO sale.
//
// El permiso es de PÁGINA (`pagina.perfil`, 0218: solo `admin` por defecto), no de función: el
// fixture de admin la trae por `ADMIN_ALLOWED_PAGES`, y el conductor sirve de control negativo
// porque ningún rol, salvo admin, la recibe por defecto.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, sobreDeMe, ADMIN_USER, CONDUCTOR_USER } from '../helpers/auth';

const YO = { ...ADMIN_USER, email: 'admin.e2e@flito.test', rolNombre: 'Administrador del sistema' };
const RUTA_PASSWORD = /\/api\/users\/1\/password$/;
const VALIDA = 'Nueva#2026x';

/** Espía las peticiones al endpoint de contraseña y responde con lo que el test diga. */
function espiarPassword(page: Page, responder: (route: Route) => Promise<void> | void): { cuerpos: unknown[] } {
  const espia = { cuerpos: [] as unknown[] };
  void page.route(RUTA_PASSWORD, async (route) => {
    espia.cuerpos.push(route.request().postDataJSON());
    await responder(route);
  });
  return espia;
}

async function abrirPerfilDesdeMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Menú de usuario/ }).click();
  await page.getByRole('menuitem', { name: 'Perfil' }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mi perfil' })).toBeVisible();
}

async function llenar(page: Page, actual: string, nueva: string, confirma: string): Promise<void> {
  await page.getByLabel('Contraseña actual').fill(actual);
  await page.getByLabel('Contraseña nueva', { exact: true }).fill(nueva);
  await page.getByLabel('Confirme la contraseña nueva').fill(confirma);
}

test.describe('Perfil — menú de sesión (AC1-AC3)', () => {
  test('AC1: con pagina.perfil, «Perfil» va encima de «Cerrar sesión» en el mismo bloque y navega a /perfil', async ({ page }) => {
    await loginAs(page, YO);
    await page.goto('/');
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    const items = page.getByRole('menu', { name: 'Opciones de usuario' }).getByRole('menuitem');
    await expect(items).toHaveText(['Perfil', 'Cerrar sesión']);
    // Mismo bloque: comparten el contenedor padre.
    const mismoPadre = await items.evaluateAll((els) => els[0].parentElement === els[1].parentElement);
    expect(mismoPadre).toBe(true);
    await expect(items.first()).toHaveClass(/flit-focus/);
    await expect(items.first()).toHaveClass(/hover:bg-\[var\(--flit-bg-hover\)\]/);
    await items.first().click();
    await expect(page).toHaveURL(/\/perfil$/);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Mi perfil' })).toBeVisible();
  });

  test('AC2: sin pagina.perfil el ítem no se pinta y /perfil directo muestra la pantalla de sin acceso', async ({ page }) => {
    expect(sobreDeMe(CONDUCTOR_USER).allowedPages).not.toContain('perfil');
    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/');
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    const menu = page.getByRole('menu', { name: 'Opciones de usuario' });
    await expect(menu.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Perfil' })).toHaveCount(0);

    await page.goto('/perfil');
    // Copy real de `components/NoAccess.tsx` con la etiqueta de PAGES.perfil.
    await expect(page.getByRole('heading', { level: 1, name: 'No tienes acceso a Perfil' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mi perfil' })).toHaveCount(0);
    await expect(page.getByLabel('Contraseña actual')).toHaveCount(0);
  });

  test('AC3: «Perfil» no está en el sidebar', async ({ page }) => {
    await loginAs(page, YO);
    await page.goto('/');
    await expect(page.getByRole('navigation').getByRole('link', { name: /^Perfil$/ })).toHaveCount(0);
  });
});

test.describe('Perfil — página (AC4, AC8)', () => {
  test('AC4 lleno: usuario, nombre, correo y etiqueta de rol; nada de compañía, tránsito ni proveedor', async ({ page }) => {
    await loginAs(page, { ...YO, transitoCodigo: '11001', companiaId: 77 });
    await page.goto('/perfil');
    const cuenta = page.getByRole('region', { name: 'Su cuenta' });
    await expect(cuenta.getByText('e2e_admin')).toBeVisible();
    await expect(cuenta.getByText('Admin E2E')).toBeVisible();
    await expect(cuenta.getByText('admin.e2e@flito.test')).toBeVisible();
    await expect(cuenta.getByText('Administrador del sistema')).toBeVisible();
    await expect(cuenta.locator('dt')).toHaveText(['Usuario', 'Nombre', 'Correo', 'Rol']);
    // Solo las dos tarjetas de la página: el sidebar sí nombra «Tránsito» como módulo.
    for (const tarjeta of [cuenta, page.locator('form')]) {
      await expect(tarjeta.getByText(/compañía|tránsito|proveedor|11001|77/i)).toHaveCount(0);
    }
    // Sin PII en la URL del SPA.
    expect(page.url()).not.toMatch(/e2e_admin|admin\.e2e|\/perfil\/\d/);
  });

  test('AC4: sin rolNombre cae a ROLE_LABELS; sin correo dice «Sin correo registrado»', async ({ page }) => {
    await loginAs(page, { ...ADMIN_USER, email: null, rolNombre: null });
    await page.goto('/perfil');
    const cuenta = page.getByRole('region', { name: 'Su cuenta' });
    await expect(cuenta.getByText('Sin correo registrado')).toBeVisible();
    await expect(cuenta.locator('dd').nth(3)).not.toHaveText('admin');
    await expect(cuenta.locator('dd').nth(3)).not.toHaveText('');
  });

  test('AC8 vacío: sesión sin datos de identidad → aviso en la tarjeta y el formulario sigue disponible', async ({ page }) => {
    await loginAs(page, YO);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Menú de usuario/ })).toBeVisible();
    await page.route('**/api/auth/me', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...sobreDeMe(YO), username: '', name: null, email: null }),
    }));
    await abrirPerfilDesdeMenu(page);
    await expect(page.getByText('Su cuenta no tiene datos de identidad registrados. Pida a su administrador de FLITO que los complete.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guardar contraseña' })).toBeVisible();
  });

  test('AC8 cargando y error con reintento: la carga fallida no muestra formulario y «Reintentar» lo recupera', async ({ page }) => {
    await loginAs(page, YO);
    await page.goto('/');
    // La sesión cuaja ANTES de cambiar el mock: si el `/me` del AuthProvider siguiera en vuelo, el
    // 500 de abajo lo tumbaría a él y no a la página.
    await expect(page.getByRole('button', { name: /Menú de usuario/ })).toBeVisible();
    let fallar = true;
    let soltar: () => void = () => {};
    const retenida = new Promise<void>((r) => { soltar = r; });
    await page.route('**/api/auth/me', async (route) => {
      if (fallar) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom interno' }) });
      await retenida;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMe(YO)) });
    });
    await abrirPerfilDesdeMenu(page);
    await expect(page.getByText('No pudimos cargar sus datos.')).toBeVisible();
    await expect(page.getByText('Revise su conexión e intente de nuevo.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    await expect(page.getByLabel('Contraseña actual')).toHaveCount(0);

    fallar = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    const cargando = page.locator('[aria-busy="true"]', { hasText: 'Cargando sus datos…' });
    await expect(cargando).toBeAttached();
    soltar();
    await expect(cargando).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Su cuenta' }).getByText('admin.e2e@flito.test')).toBeVisible();
    await expect(page.getByLabel('Contraseña actual')).toBeVisible();
  });
});

test.describe('Perfil — cambio de contraseña (AC5-AC7)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, YO);
    await page.goto('/perfil');
    await expect(page.getByLabel('Contraseña actual')).toBeVisible();
  });

  test('AC5: tres campos con autocomplete, form noValidate y ayuda de política enlazada', async ({ page }) => {
    await expect(page.locator('form')).toHaveAttribute('novalidate', '');
    await expect(page.getByLabel('Contraseña actual')).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.getByLabel('Confirme la contraseña nueva')).toHaveAttribute('autocomplete', 'new-password');
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toHaveAccessibleDescription(
      'Mínimo 8 caracteres, con mayúscula, minúscula, número y un carácter especial (! @ # $ % ^ & *).',
    );
  });

  test('AC6: confirmación distinta → error bajo el campo, foco ahí, campos intactos y NO sale el PATCH', async ({ page }) => {
    const espia = espiarPassword(page, (r) => r.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' }));
    await llenar(page, 'Actual#2026', VALIDA, 'Otra#2026xx');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    const confirma = page.getByLabel('Confirme la contraseña nueva');
    await expect(page.getByRole('alert').filter({ hasText: 'No coincide con la contraseña nueva.' })).toBeVisible();
    await expect(confirma).toHaveAttribute('aria-invalid', 'true');
    await expect(confirma).toBeFocused();
    await expect(confirma).toHaveValue('Otra#2026xx');
    await expect(page.getByLabel('Contraseña actual')).toHaveValue('Actual#2026');
    await page.waitForTimeout(300);
    expect(espia.cuerpos).toHaveLength(0);
  });

  test('AC6: política no cumplida → error bajo «Contraseña nueva» y NO sale el PATCH', async ({ page }) => {
    const espia = espiarPassword(page, (r) => r.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' }));
    await llenar(page, 'Actual#2026', 'debil', 'debil');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'La contraseña nueva no cumple los requisitos de abajo.' })).toBeVisible();
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await page.waitForTimeout(300);
    expect(espia.cuerpos).toHaveLength(0);
  });

  test('AC6: campo vacío → «Escriba su contraseña actual.» sin llamada', async ({ page }) => {
    const espia = espiarPassword(page, (r) => r.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' }));
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Escriba su contraseña actual.' })).toBeVisible();
    await expect(page.getByLabel('Contraseña actual')).toBeFocused();
    await page.waitForTimeout(300);
    expect(espia.cuerpos).toHaveLength(0);
  });

  test('401 «Contraseña actual incorrecta» → copy pulido bajo «Contraseña actual», sesión abierta, campos intactos', async ({ page }) => {
    espiarPassword(page, (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Contraseña actual incorrecta' }) }));
    await llenar(page, 'Mala#2026x', VALIDA, VALIDA);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'La contraseña actual no es correcta.' })).toBeVisible();
    await expect(page.getByText('Contraseña actual incorrecta')).toHaveCount(0);
    await expect(page.getByLabel('Contraseña actual')).toBeFocused();
    await expect(page.getByLabel('Contraseña actual')).toHaveValue('Mala#2026x');
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toHaveValue(VALIDA);
    await expect(page).toHaveURL(/\/perfil$/);
  });

  test('401 de token vencido en el mismo PATCH SÍ cierra la sesión: va a /login y borra el token', async ({ page }) => {
    // Gemelo del anterior: la excepción de `api.ts` exige ruta Y mensaje. Si solo mirara la ruta,
    // una sesión vencida se quedaría en /perfil con «La contraseña actual no es correcta.».
    espiarPassword(page, (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Token inválido o expirado' }) }));
    await llenar(page, 'Actual#2026', VALIDA, VALIDA);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#login-username')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
    await expect(page.getByText('La contraseña actual no es correcta.')).toHaveCount(0);
  });

  test('429 → aviso de formulario con el freno; 500 → aviso genérico; nunca el texto del API', async ({ page }) => {
    let status = 429;
    espiarPassword(page, (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests xyz' }) }));
    await llenar(page, 'Actual#2026', VALIDA, VALIDA);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Demasiados intentos. Espere unos minutos y vuelva a intentarlo.' })).toBeVisible();
    status = 500;
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos guardar la contraseña. Intente de nuevo en un momento.' })).toBeVisible();
    await expect(page.getByText(/Too many requests xyz/)).toHaveCount(0);
    await expect(page.getByLabel('Contraseña actual')).toHaveValue('Actual#2026');
  });

  test('AC7: éxito → PATCH con el id propio y el cuerpo exacto, toast cerrable, campos vaciados, sigue en /perfil', async ({ page }) => {
    const espia = espiarPassword(page, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await llenar(page, 'Actual#2026', VALIDA, VALIDA);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByText('Su contraseña se actualizó.')).toBeVisible();
    expect(espia.cuerpos).toEqual([{ currentPassword: 'Actual#2026', newPassword: VALIDA }]);
    await expect(page.getByLabel('Contraseña actual')).toHaveValue('');
    await expect(page.getByLabel('Contraseña nueva', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Confirme la contraseña nueva')).toHaveValue('');
    await expect(page).toHaveURL(/\/perfil$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Mi perfil' })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText('Su contraseña se actualizó.')).toHaveCount(0);
  });
});
