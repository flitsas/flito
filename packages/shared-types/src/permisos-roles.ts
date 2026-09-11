// HU #12084 (Feature #12072) — Mantenimiento de roles y guardado del cuadro rol × función.
//
// Lo que aquí se declara lo leen dos sitios: las rutas de `apps/api/src/modules/permisos/
// permisos.routes.ts` (los `z.enum` se construyen desde estas constantes, patrón `USER_ROLES`) y la
// pantalla de la HU #12085. Los literales de `tipo_enlace` y `tipo_principal` son los del CHECK de la
// 0178 (`permisos_roles_tipo_enlace_chk`, `permisos_roles_tipo_principal_chk`).

/** El ROL dice si se enlaza y a QUÉ tipo de ámbito (RN-A3); el usuario dice a cuál. */
export const TIPOS_ENLACE = ['ninguno', 'compania', 'proveedor_soat', 'organismos_transito'] as const;
export type TipoEnlace = (typeof TIPOS_ENLACE)[number];

/** `externo` dispara la frontera del canal (`guardiaCanalCliente`); `interno` es la plantilla de FLIT. */
export const TIPOS_PRINCIPALES = ['interno', 'externo'] as const;
export type TipoPrincipalRol = (typeof TIPOS_PRINCIPALES)[number];

/** Una fila de `GET /api/permisos/roles`. Sin PII: `usuarios` es un conteo, nunca una lista. */
export interface RolCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  tipoEnlace: TipoEnlace;
  tipoPrincipal: TipoPrincipalRol;
  /** Candado de borrado (ADR-0015 §Decisión 5). Solo `admin`. No se edita por API. */
  esSistema: boolean;
  /** Gobierna la ASIGNACIÓN, no la autenticación. */
  activo: boolean;
  /** `count(*)` de `users` con ese rol, activos o no (la FK `ON DELETE RESTRICT` cuenta todos). */
  usuarios: number;
  /** `!esSistema && usuarios === 0`. */
  borrable: boolean;
  /** El MISMO texto que responde el 409 de `DELETE`; `null` si es borrable. */
  motivoNoBorrable: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrearRolInput {
  codigo: string;
  nombre: string;
  descripcion?: string | null;
  tipoEnlace: TipoEnlace;
  /** Obligatorio, sin valor por defecto (AC1): equivocarse por omisión abre la superficie interna. */
  tipoPrincipal: TipoPrincipalRol;
  funciones?: string[];
}

/** `codigo` y `esSistema` no están a propósito: la ruta los rechaza con `.strict()`. */
export interface EditarRolInput {
  nombre?: string;
  descripcion?: string | null;
  tipoEnlace?: TipoEnlace;
  tipoPrincipal?: TipoPrincipalRol;
  activo?: boolean;
}

/** `GET /api/permisos/roles/:codigo/funciones`. */
export interface CuadroRol {
  codigo: string;
  tipoPrincipal: TipoPrincipalRol;
  /** Ordenadas por código. */
  funciones: string[];
}

/** Aviso de RN-A1: el rol es externo y hay funciones que la guarda de canal no dejará pasar. */
export interface AvisoFueraDelCanal {
  tipo: 'fuera_del_canal';
  mensaje: string;
  funciones: string[];
}

/** `PUT /api/permisos/roles/:codigo/funciones`. */
export interface RespuestaGuardarCuadro {
  codigo: string;
  funciones: string[];
  concedidas: string[];
  revocadas: string[];
  aviso: AvisoFueraDelCanal | null;
}

// ── HU #12087 — Excepciones por usuario sobre lo que da su rol ──────────────────────────────────
// Los literales son los del CHECK `permisos_usuario_funcion_efecto_chk` (0179). Los leen las rutas de
// `users.routes.ts` (el `z.enum` se construye desde aquí) y el picker de `pages/users`.

export const EFECTOS_PERMISO_USUARIO = ['conceder', 'revocar'] as const;
export type EfectoPermisoUsuario = (typeof EFECTOS_PERMISO_USUARIO)[number];

/**
 * Una excepción por usuario sobre lo que da su rol. PK real: `(user_id, funcion_codigo)`, así que un
 * mismo código nunca lleva los dos efectos. `revocar` manda sobre el rol (AC2): la función sale del
 * conjunto efectivo aunque el rol la incluya.
 */
export interface FuncionDeUsuario {
  codigo: string;
  efecto: EfectoPermisoUsuario;
}
