import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

const VALID_USER = { username: 'e2e_admin', password: 'Test2026!' };
const FAKE_USER = {
  id: 1,
  username: VALID_USER.username,
  name: 'Admin E2E',
  role: 'admin' as const,
  allowedPages: ['*'],
};

test.describe('Auth flow', () => {
  test('login válido redirige a / y persiste sesión', async ({ page }) => {
    await page.route('**/api/auth/login', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.username).toBe(VALID_USER.username);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'fake.jwt.e2e', user: FAKE_USER }),
      });
    });
    await page.route('**/api/auth/me', async (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_USER) })
    );

    const login = new LoginPage(page);
    await login.goto();
    await login.login(VALID_USER.username, VALID_USER.password);

    await expect(page).toHaveURL(/\/$|\/dashboard/);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBe('fake.jwt.e2e');
  });

  test('credencial inválida muestra toast y permanece en /login', async ({ page }) => {
    // El backend SÍ devuelve 401 para credencial inválida. Antes api.ts redirigía
    // ante cualquier 401 ocultando el error real al usuario; el bug fix lo exceptúa
    // para /auth/login y deja que el toast muestre el mensaje del backend.
    await page.route('**/api/auth/login', async (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Credenciales inválidas' }),
      })
    );

    const login = new LoginPage(page);
    await login.goto();
    await login.login('hacker', 'wrong');

    await login.expectErrorToast(/credenciales/i);
    await expect(page).toHaveURL(/\/login/);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });

  test('token expirado en boot limpia storage y deja al usuario en /login', async ({ page }) => {
    await page.route('**/api/auth/me', async (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'expired' }) })
    );

    // Cargamos la app para tener un origin válido, luego seteamos el token stale puntualmente.
    await page.goto('/login');
    await page.evaluate(() => localStorage.setItem('token', 'stale.jwt'));
    // El api.ts hace window.location.href='/login' al recibir 401. Disparamos la nav vía
    // evaluate() para evitar race entre goto() y el redirect interno del cliente.
    await Promise.all([
      page.waitForURL(/\/login/, { timeout: 15_000 }),
      page.evaluate(() => { window.location.href = '/'; }),
    ]);
    // Esperar a que el DOM de /login termine de hidratarse antes de leer localStorage.
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#login-username').waitFor({ timeout: 10_000 });

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });
});
