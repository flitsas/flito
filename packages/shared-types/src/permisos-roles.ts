// HU #12084 (Feature #12072) — Mantenimiento de roles y guardado del cuadro rol × función.
//
// Lo que aquí se declara lo leen dos sitios: las rutas de `apps/api/src/modules/permisos/
// permisos.routes.ts` (los `z.enum` se construyen desde estas constantes, patrón `USER_ROLES`) y la
// pantalla de la HU #12085. Los literales de `tipo_enlace` son los del CHECK
// `permisos_roles_tipo_enlace_chk` (0178, renombrado `proveedor_soat` → `proveedor` en la 0231).
//
// HU #12875 (ADR-0024): el tipo interno/externo del rol se RETIRA del contrato. El
// enlace es la única frontera: `ninguno` → decide el permiso; cualquier otro → solo los módulos que
// `FRONTERA_POR_ENLACE` le abre más las rutas transversales de sesión.

/** El ROL dice si se enlaza y a QUÉ tipo de ámbito (RN-A3); el usuario dice a cuál. */
export const TIPOS_ENLACE = ['ninguno', 'compania', 'proveedor', 'organismos_transito'] as const;
export type TipoEnlace = (typeof TIPOS_ENLACE)[number];

/** Cómo se nombra cada enlace en pantalla (el panel de #12876 lo explica con `FRONTERA_POR_ENLACE`). */
export const ETIQUETA_ENLACE: Readonly<Record<TipoEnlace, string>> = Object.freeze({
  ninguno: 'Ninguno',
  compania: 'Compañía',
  proveedor: 'Proveedor',
  organismos_transito: 'Organismos de tránsito',
});

/** Los módulos que la frontera conoce (= códigos de módulo del catálogo de funciones). */
export const MODULOS_FRONTERA = [
  'soat', 'impuestos', 'derechos', 'tramites', 'bolsas', 'comprobantes', 'logistica', 'tablero',
] as const;
export type ModuloFrontera = (typeof MODULOS_FRONTERA)[number];

export type EnlaceRestringido = Exclude<TipoEnlace, 'ninguno'>;

/**
 * HU #12875 (ADR-0024) — Qué enlaces alcanzan cada módulo HOY. Es CÓDIGO, congelado: no se lee de
 * ninguna tabla y ninguna ruta lo modifica. Abrir un módulo a un enlace se hace en el MISMO PR que
 * hace que su servicio filtre las filas por ese enlace (`alcanceDe(req)`); abrirlo antes es una fuga.
 *
 *   · soat — filtra por enlace desde el Bug #12869 (`alcanceSoatDe`, `condicionesCola`).
 *   · impuestos → #13426 (compania, organismos_transito) · derechos → #13426 (organismos_transito).
 *   · tramites / bolsas / comprobantes / logistica / tablero → #13426 (compania).
 */
export const FRONTERA_POR_ENLACE: Readonly<Record<ModuloFrontera, readonly EnlaceRestringido[]>> = Object.freeze({
  soat: Object.freeze(['compania', 'proveedor'] as const),
  impuestos: Object.freeze([] as const),
  derechos: Object.freeze([] as const),
  tramites: Object.freeze([] as const),
  bolsas: Object.freeze([] as const),
  comprobantes: Object.freeze([] as const),
  logistica: Object.freeze([] as const),
  tablero: Object.freeze([] as const),
});

/** Una fila de `GET /api/permisos/roles`. Sin PII: `usuarios` es un conteo, nunca una lista. */
export interface RolCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  tipoEnlace: TipoEnlace;
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
  funciones?: string[];
}

/** `codigo`, `esSistema` y el tipo interno/externo retirado no están: la ruta los rechaza con `.strict()`. */
export interface EditarRolInput {
  nombre?: string;
  descripcion?: string | null;
  tipoEnlace?: TipoEnlace;
  activo?: boolean;
}

/** `GET /api/permisos/roles/:codigo/funciones`. */
export interface CuadroRol {
  codigo: string;
  tipoEnlace: TipoEnlace;
  /** Ordenadas por código. */
  funciones: string[];
}

/**
 * Aviso de RN-A1 (HU #12875: por enlace): el rol tiene enlace y hay funciones de módulos que la
 * frontera no le abre a ese enlace; marcarlas no tiene efecto por HTTP.
 */
export interface AvisoFueraDelEnlace {
  tipo: 'fuera_del_enlace';
  tipoEnlace: EnlaceRestringido;
  mensaje: string;
  funciones: string[];
}

/** `PUT /api/permisos/roles/:codigo/funciones`. */
export interface RespuestaGuardarCuadro {
  codigo: string;
  funciones: string[];
  concedidas: string[];
  revocadas: string[];
  aviso: AvisoFueraDelEnlace | null;
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
