import { Page } from '@playwright/test';

export const ADMIN_USER = {
  id: 1,
  username: 'e2e_admin',
  name: 'Admin E2E',
  role: 'admin' as const,
  allowedPages: ['*'],
};

export const PROVEEDOR_USER = {
  id: 6,
  username: 'e2e_proveedor',
  name: 'Proveedor E2E',
  role: 'proveedor' as const,
  allowedPages: ['vehicles', 'soat'],
};

// FLITO — Operaciones: superusuario funcional del dominio (mutaciones). Sus páginas
// derivan de ROLE_DEFAULT_PAGES.operaciones; no hace falta allowedPages.
export const OPERACIONES_USER = {
  id: 7,
  username: 'e2e_operaciones',
  name: 'Operaciones E2E',
  role: 'operaciones' as const,
  allowedPages: [] as string[],
};

// FLITO — Auditoría: mismas vistas FLITO pero solo lectura.
export const AUDITOR_USER = {
  id: 8,
  username: 'e2e_auditor',
  name: 'Auditoría E2E',
  role: 'auditor' as const,
  allowedPages: [] as string[],
};

export async function loginAs(page: Page, user = ADMIN_USER) {
  // /me responde 200 con el user — necesario para que useAuth() considere la sesión válida.
  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
  );
  // Pasamos por /login para tener un origin válido y poder escribir en localStorage.
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('token', 'fake.jwt.e2e'));
}
