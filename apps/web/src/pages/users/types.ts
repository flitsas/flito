// FLITO — el usuario tal y como lo ve la pantalla de gestión de usuarios, y su presentación por rol.
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
// HU #12087: `funciones` (excepciones) es la fuente; `allowedPages` queda @deprecated.

import type { FuncionDeUsuario } from '@operaciones/shared-types';
import type { ChipTone } from '../../components/flit/StatusChip';
import { ROLE_LABELS, USER_ROLES, type UserRole } from '../../lib/permissions';

export interface User {
  id: number;
  username: string;
  name: string;
  email: string | null;
  role: UserRole;
  active: boolean;
  /**
   * Excepciones sobre el cuadro del rol (`conceder` / `revocar`). **Siempre array**, como
   * `organismosCodigos`: `[]` si no hay ninguna.
   */
  funciones: FuncionDeUsuario[];
  /** @deprecated HU #12087: congelada; la SPA no la lee ni la escribe. Fuente: `funciones`. */
  allowedPages?: string[];
  transitoCodigo?: string | null;
  /** Compañía del rol `cliente` (Feature #11912). Obligatoria para ese rol y prohibida en el resto. */
  companiaId?: number | null;
  /** Proveedor SOAT del rol `proveedor` (HU #12053). Obligatorio para ese rol, prohibido en el resto. */
  flitoProveedorSoatId: string | null;
  /**
   * Organismos del rol `gestor_impuestos` (HU #12053). **Siempre un array**, nunca `null` ni
   * ausente: `[]` para los once roles que no son gestor. Es invariante del contrato —§3 del diseño—
   * y por eso aquí no se escribe `?? []`: si algún día llegara vacío de otra forma, el fallo tiene
   * que verse, no taparse.
   */
  organismosCodigos: string[];
  createdAt: string;
}

/**
 * `GET /users/resumen` (HU #12172): el conteo por rol de TODOS los usuarios, no de la página.
 *
 * `porRol` llega con los DOCE roles y los vacíos en `0`. Se tipa `Partial` de todos modos, y no por
 * desconfianza del backend: este `Record` está indexado por `UserRole`, que crece cada vez que se
 * añade un rol al sistema. Con el tipo total, el día que exista un rol trece la pantalla leería
 * `undefined` con cara de `number` y pintaría «undefined» sin que el compilador dijera nada. Con
 * `Partial`, quien lo lea tiene que decidir qué hace con el hueco —hoy, no pintar el chip—.
 *
 * `activos` + `inactivos` es el total, y por eso el resumen NO sustituye a `X-Total-Count`: aquel
 * cuenta las coincidencias del filtro puesto y estos cuentan el censo entero.
 */
export interface ResumenUsuarios {
  porRol: Partial<Record<UserRole, number>>;
  activos: number;
  inactivos: number;
}

// Lista de roles asignables: derivada de la fuente única (los 8 roles del sistema).
export const ROLES: { value: UserRole; label: string }[] = USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

// Tono semántico FLIT por rol (sin cambiar la lógica de roles).
export const ROLE_TONE: Record<UserRole, ChipTone> = {
  admin: 'active',
  compliance: 'warning',
  transito: 'active',
  proveedor: 'neutral',
  lider_pesv: 'success',
  supervisor_flota: 'success',
  conductor: 'neutral',
  auditor: 'warning',
  gestor_impuestos: 'neutral',
  mensajero: 'active',
  financiera: 'success',
  // Gris, como `proveedor` y `conductor`: es el tono del perfil acotado y sin mando. `active` y
  // `success` están reservados a perfiles internos, y el Cliente es el primer rol EXTERNO a FLIT.
  cliente: 'neutral',
};
