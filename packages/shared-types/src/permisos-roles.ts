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

import type { PageSlug } from './permissions.js';

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
  'transito',
] as const;
export type ModuloFrontera = (typeof MODULOS_FRONTERA)[number];

export type EnlaceRestringido = Exclude<TipoEnlace, 'ninguno'>;

/**
 * HU #12875 (ADR-0024) — Qué enlaces alcanzan cada módulo HOY. Es CÓDIGO, congelado: no se lee de
 * ninguna tabla y ninguna ruta lo modifica. Abrir un módulo a un enlace se hace en el MISMO PR que
 * hace que su servicio filtre las filas por ese enlace (`alcanceDe(req)`); abrirlo antes es una fuga.
 *
 *   · soat — filtra por enlace desde el Bug #12869 (`alcanceSoatDe`, `condicionesCola`).
 *   · impuestos (compania, organismos_transito) · derechos (organismos_transito) — #13426.
 *   · tramites / bolsas / comprobantes / logistica / tablero (compania) — #13426 (`alcance-filas.ts`).
 *   · transito (organismos_transito) — página Tránsito antigua `/api/transito`, #13426 (AC6).
 */
export const FRONTERA_POR_ENLACE: Readonly<Record<ModuloFrontera, readonly EnlaceRestringido[]>> = Object.freeze({
  soat: Object.freeze(['compania', 'proveedor'] as const),
  impuestos: Object.freeze(['compania', 'organismos_transito'] as const),
  derechos: Object.freeze(['organismos_transito'] as const),
  tramites: Object.freeze(['compania'] as const),
  bolsas: Object.freeze(['compania'] as const),
  comprobantes: Object.freeze(['compania'] as const),
  logistica: Object.freeze(['compania'] as const),
  tablero: Object.freeze(['compania'] as const),
  transito: Object.freeze(['organismos_transito'] as const),
});

/**
 * HU #13452 (corrección de la sesión de evidencias) — A qué módulo de la frontera pertenece cada
 * PANTALLA. Lo lee la web para no ofrecer (menú, ⌘K, guarda de ruta, panel de roles) una pantalla que
 * el enlace del usuario cierra: el API la cierra igual con 403, pero ofrecerla es un callejón.
 *
 * Calca las tuplas `pagina.* → módulo` del catálogo (`catalogo-agrupacion.ts` del API, migración 0205)
 * SOLO para los módulos que la frontera conoce. Una pantalla que no está aquí no es de ningún módulo
 * abierto → cerrada para todo enlace, como el montaje sin `conAlcance` en el API (ADR-0024).
 *
 * Fuera a propósito, aunque el catálogo las agrupe en un módulo de la frontera: «Google Drive»
 * (`pagina.drive` → derechos; su API `/api/drive` no se monta con `conAlcance`) y «Organismos STT»
 * (`pagina.transito_organismos` → transito; es configuración y pide `/flito/parametrizacion/organismos`,
 * cerrado a todo enlace). Ofrecerlas sería volver al callejón que esta lista evita.
 */
export const MODULO_FRONTERA_DE_PAGINA: Readonly<Partial<Record<PageSlug, ModuloFrontera>>> = Object.freeze({
  flito_soat: 'soat',
  flito_impuestos: 'impuestos',
  flito_derechos: 'derechos',
  flito_tramites: 'tramites',
  flito_bolsas: 'bolsas',
  flito_comprobantes: 'comprobantes',
  flito_logistica: 'logistica',
  flito_logistica_ruta: 'logistica',
  flito_tablero: 'tablero',
  // El Tablero de General (`/` → `InicioGate` → `pagina.dashboard` → `Dashboard.tsx`) ES el módulo
  // `tablero`: P-11 unió el Tablero FLITO a General y renderiza `FlitoTablero` contra el API acotado
  // por `conAlcance('tablero')`. Sin esta línea la compañía perdía su Tablero (HU #13452).
  dashboard: 'tablero',
  // «Bandeja de trámites» (`/api/transito`, abierto con `conAlcance('transito')`).
  transito: 'transito',
});

/**
 * Pantallas de la SESIÓN que ningún enlace cierra: Perfil (sus rutas son `RUTAS_TRANSVERSALES` del
 * API) y Ayuda FLITO (markdown del bundle, no llama al API; su visibilidad es derivada).
 */
export const PAGINAS_DE_SESION: readonly PageSlug[] = Object.freeze(['perfil', 'flito_ayuda'] as PageSlug[]);

/** ¿Abre la frontera este módulo a este enlace? (La misma regla que `moduloAbiertoA` del API.) */
export function moduloAbiertoAlEnlace(modulo: ModuloFrontera, enlace: EnlaceRestringido): boolean {
  return (FRONTERA_POR_ENLACE[modulo] as readonly EnlaceRestringido[]).includes(enlace);
}

/**
 * ¿Deja el enlace entrar a esta pantalla? `ninguno` y `null`/`undefined` (aún no llegó `/permisos/mios`)
 * no restringen: el usuario sin enlace sigue exactamente como antes y el API es la frontera real.
 */
export function paginaAbiertaAlEnlace(page: PageSlug, enlace: TipoEnlace | null | undefined): boolean {
  if (!enlace || enlace === 'ninguno') return true;
  if (PAGINAS_DE_SESION.includes(page)) return true;
  const modulo = MODULO_FRONTERA_DE_PAGINA[page];
  return modulo !== undefined && moduloAbiertoAlEnlace(modulo, enlace);
}

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
