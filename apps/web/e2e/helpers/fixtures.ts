// Fixture base de los E2E: instala un catch-all para `**/api/**`.
//
// Motivo: los specs mockean sus endpoints con page.route, pero un endpoint OLVIDADO se iba a la API
// real (cuando el stack de demo está levantado) y respondía 401 → SESSION_ENDED → logout → login,
// rompiendo el test en un punto lejano y confuso (pasó 3 veces: shell-navbar, dashboard, transito).
//
// Con este catch-all, cualquier /api/** no mockeado devuelve 200 [] (NUNCA 401 → nunca desloguea) y
// deja un warning con la ruta faltante. Precedencia: Playwright evalúa las rutas en orden inverso de
// registro; el catch-all se registra en el setup del fixture (antes del cuerpo del test), así que los
// page.route explícitos de cada test —y el de /auth/me de loginAs— se registran después y GANAN.
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/**', (route) => {
      const { pathname } = new URL(route.request().url());
      // Visible en la consola del runner: delata el mock faltante sin tumbar la sesión.
      console.warn(`[e2e catch-all] endpoint /api no mockeado: ${route.request().method()} ${pathname} → 200 []`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await use(page);
  },
});

export { expect };
