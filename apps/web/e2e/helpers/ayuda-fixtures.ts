// Usuarios y atajos para los E2E de Ayuda FLITO (HU #11893).
// No muta helpers/auth.ts: los roles que ya viven ahí se reexportan; los que faltan se definen aquí.

import { expect, type Page } from '@playwright/test';
import {
  loginAs,
  ADMIN_USER,
  OPERACIONES_USER,
  PROVEEDOR_USER,
  AUDITOR_USER,
  FINANCIERA_USER,
  GESTOR_IMPUESTOS_USER,
  MENSAJERO_USER,
  CONDUCTOR_USER,
} from './auth';

export {
  loginAs,
  ADMIN_USER,
  OPERACIONES_USER,
  PROVEEDOR_USER,
  AUDITOR_USER,
  FINANCIERA_USER,
  GESTOR_IMPUESTOS_USER,
  MENSAJERO_USER,
  CONDUCTOR_USER,
};

export const COMPLIANCE_USER = {
  id: 21,
  username: 'e2e_ayuda_compliance',
  name: 'Compliance Ayuda E2E',
  role: 'compliance' as const,
  allowedPages: [] as string[],
};

export const TRANSITO_USER = {
  id: 22,
  username: 'e2e_ayuda_transito',
  name: 'Tránsito Ayuda E2E',
  role: 'transito' as const,
  allowedPages: [] as string[],
};

export const LIDER_PESV_USER = {
  id: 23,
  username: 'e2e_ayuda_lider_pesv',
  name: 'Líder PESV Ayuda E2E',
  role: 'lider_pesv' as const,
  allowedPages: [] as string[],
};

export const SUPERVISOR_FLOTA_USER = {
  id: 24,
  username: 'e2e_ayuda_supervisor',
  name: 'Supervisor flota Ayuda E2E',
  role: 'supervisor_flota' as const,
  allowedPages: [] as string[],
};

/** Roles cuyos defaults no cruzan el catálogo de 18: no ven el menú (AC2). */
export const SIN_CATALOGO = [
  CONDUCTOR_USER,
  COMPLIANCE_USER,
  TRANSITO_USER,
  LIDER_PESV_USER,
  SUPERVISOR_FLOTA_USER,
];

export async function abrirAyuda(page: Page, user: Parameters<typeof loginAs>[1]) {
  await loginAs(page, user);
  await page.goto('/flito/ayuda');
}

/** Campo de búsqueda del índice (HU #11901). No vive en la ficha ni en la URL. */
export async function buscarCapitulos(page: Page, consulta: string) {
  const campo = page.getByRole('searchbox', { name: 'Buscar capítulos' });
  await expect(campo).toBeVisible();
  await campo.fill(consulta);
}
