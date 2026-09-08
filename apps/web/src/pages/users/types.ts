// FLITO — el usuario tal y como lo ve la pantalla de gestión de usuarios, y su presentación por rol.
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// Aquí no hay lógica: es el contrato de `GET /users` recortado a lo que la pantalla usa, más las
// dos tablas de presentación que la tabla y los formularios comparten. Vive aparte para que
// añadir un rol o una columna no obligue a abrir la página.

import type { ChipTone } from '../../components/flit/StatusChip';
import { ROLE_LABELS, USER_ROLES, type UserRole } from '../../lib/permissions';

export interface User {
  id: number;
  username: string;
  name: string;
  email: string | null;
  role: UserRole;
  active: boolean;
  allowedPages: string[];
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
