// FLITO — mapeo de los roles del dominio FLITO a los roles del sistema Operaciones,
// y las ataduras de visibilidad del gestor. Ver docs/MIGRACION_FLITO_A_OPERACIONES.md §9.
//
// Decisión de migración (D-1/D-2):
//   OPERACIONES       → ES el admin (despliegue FLITO-only; el rol `operaciones` se fusionó en `admin`)
//   GESTOR_SOAT       → rol existente `proveedor`  (ya filtrado en SOAT)
//   GESTOR_IMPUESTOS  → rol nuevo `gestor_impuestos`
//   AUDITORIA         → rol existente `auditor`    (+ páginas FLITO de solo lectura)

import type { UserRole } from './permissions.js';

/** Gestor SOAT = proveedor. Atado a un proveedor SOAT (users.proveedor_soat_id). */
export const FLITO_GESTOR_SOAT_ROLE = 'proveedor' as const satisfies UserRole;
/** Gestor de Impuestos. Atado a un organismo de tránsito (users.organismo_id). */
export const FLITO_GESTOR_IMPUESTOS_ROLE = 'gestor_impuestos' as const satisfies UserRole;
/** Auditoría FLITO = auditor (revisor fiscal), solo lectura. */
export const FLITO_AUDITORIA_ROLE = 'auditor' as const satisfies UserRole;

/**
 * Un gestor solo ve lo suyo: el gestor SOAT (`proveedor`) está atado a un proveedor
 * y el gestor de impuestos a un organismo. Esa atadura hace cumplir CA-09/CA-10 en
 * la consulta del servidor (leída de la columna del usuario, no del token), no en la UI.
 */
export function gestorRequiereProveedor(role: UserRole): boolean {
  return role === FLITO_GESTOR_SOAT_ROLE;
}

export function gestorRequiereOrganismo(role: UserRole): boolean {
  return role === FLITO_GESTOR_IMPUESTOS_ROLE;
}
