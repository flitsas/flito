import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: [/\.mobile\.spec\.ts/, /\.capturas\.spec\.ts/] },
    // Viewport móvil opt-in: solo corre los specs `*.mobile.spec.ts` (verificación responsive de
    // la HU que lo pida). Sin specs móviles no añade tiempo de CI; el desktop los ignora y este
    // proyecto ignora los demás.
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /\.mobile\.spec\.ts/ },
    // HU #13769 — capturas de la Ayuda FLITO sobre datos demo (`*.capturas.spec.ts`, etiqueta
    // `@capturas`). No es regresión: escribe PNG en `public/ayuda/<clave>/`. Solo corre a mano con
    // `npm run capturas:ayuda -w apps/web -- --grep <clave>` (pone AYUDA_CAPTURAS=1). Sin esa variable el
    // proyecto no existe y `chromium` ignora el spec: no entra en el smoke ni en `playwright test` a
    // secas. 1280 px, tema claro, sin service worker (que no se salte el `page.route`).
    ...(process.env.AYUDA_CAPTURAS ? [{
      name: 'capturas',
      testMatch: /\.capturas\.spec\.ts/,
      timeout: 90_000,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, colorScheme: 'light' as const, serviceWorkers: 'block' as const },
    }] : []),
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
