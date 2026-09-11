// FLITO — el usuario tal y como lo ve la pantalla de gestión de usuarios, y su presentación por rol.
// Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
// HU #12087: `funciones` (excepciones) es la fuente; `allowedPages` queda @deprecated.
// HU #12088: el `<select>` de rol se alimenta de `permisosApi.roles()`; `ROLES` queda como
// fallback de etiqueta/tono mientras carga el catálogo.

import type { FuncionDeUsuario, TipoEnlace } from '@operaciones/shared-types';
import type { ChipTone } from '../../components/flit/StatusChip';
import { ROLE_LABELS, USER_ROLES, type UserRole } from '../../lib/permissions';

export interface User {
  id: number;
  username: string;
  name: string;
  email: string | null;
  /** Código del rol en `permisos_roles` (sistema o personalizado). */
  role: string;
  active: boolean;
  /**
   * Excepciones sobre el cuadro del rol (`conceder` / `revocar`). **Siempre array**, como
   * `organismosCodigos`: `[]` si no hay ninguna.
   */
  funciones: FuncionDeUsuario[];
  /** @deprecated HU #12087: congelada; la SPA no la lee ni la escribe. Fuente: `funciones`. */
  allowedPages?: string[];
  /**
   * @deprecated HU #12088: la SPA ya no escribe ni muestra esta columna. Fuente de organismos =
   * `organismosCodigos` (puente). Puede llegar en JWT/login por compat; el listado usa la puente.
   */
  transitoCodigo?: string | null;
  /** Compañía cuando `tipoEnlace = 'compania'`. */
  companiaId?: number | null;
  /** Proveedor SOAT cuando `tipoEnlace = 'proveedor_soat'`. */
  flitoProveedorSoatId: string | null;
  /**
   * Organismos cuando `tipoEnlace = 'organismos_transito'` (gestor, tránsito, roles nuevos).
   * **Siempre un array**, nunca `null` ni ausente: `[]` si no aplica o aún no hay filas.
   */
  organismosCodigos: string[];
  createdAt: string;
}

/** Opción del `<select>` de rol: `codigo` + `nombre` del catálogo API. */
export interface RolOpcion {
  value: string;
  label: string;
  tipoEnlace: TipoEnlace;
  activo: boolean;
}

/**
 * `GET /users/resumen` (HU #12172): el conteo por rol de TODOS los usuarios, no de la página.
 *
 * `porRol` se tipa con claves string: el catálogo de roles ya no es solo el union compilado.
 */
export interface ResumenUsuarios {
  porRol: Partial<Record<string, number>>;
  activos: number;
  inactivos: number;
}

/** Fallback estático (toolbar/celda mientras llega el API, o rol desconocido). */
export const ROLES: { value: UserRole; label: string }[] = USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

export function etiquetaRol(codigo: string, catalogo: RolOpcion[] | null): string {
  const delApi = catalogo?.find((r) => r.value === codigo)?.label;
  if (delApi) return delApi;
  return ROLES.find((r) => r.value === codigo)?.label ?? codigo;
}

export function tipoEnlaceDe(codigo: string, catalogo: RolOpcion[] | null): TipoEnlace {
  return catalogo?.find((r) => r.value === codigo)?.tipoEnlace ?? 'ninguno';
}

// Tono semántico FLIT por rol conocido; roles nuevos → `neutral`.
export const ROLE_TONE: Record<string, ChipTone> = {
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
