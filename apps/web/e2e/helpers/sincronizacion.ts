import { expect, type Page } from '@playwright/test';

// FLITO — Gestión Trámites · la sección «Sincronización» es un acordeón contraído en cada visita
// (HU #13238, 2.º PR). Los specs que miran sus controles (interruptores, «Sincronizar FLIT», Acceso a
// FLIT 2, estado de FLIT 2) lo despliegan primero con este helper.

export const cabeceraSincronizacion = (page: Page) => page.getByTestId('cabecera-sincronizacion');

/** Despliega la sección (idempotente). Exige que la sección exista. */
export async function expandirSincronizacion(page: Page) {
  const cabecera = cabeceraSincronizacion(page);
  await expect(cabecera).toBeVisible();
  if ((await cabecera.getAttribute('aria-expanded')) !== 'true') await cabecera.click();
  await expect(cabecera).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Igual, pero tolera que la sección no exista (usuario sin ningún permiso de sincronización). Llamar
 * tras ver el título de la página: la sección se pinta en el mismo render.
 */
export async function expandirSincronizacionSiHay(page: Page) {
  if (await cabeceraSincronizacion(page).count()) await expandirSincronizacion(page);
}
