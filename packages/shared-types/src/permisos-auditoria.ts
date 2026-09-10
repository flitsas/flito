// HU #12171 (Feature #12072, ADR-0014) — Historial consultable de cambios de usuarios, roles y permisos.
//
// Lo que aquí se declara lo leen tres sitios: el escritor (`apps/api/src/shared/historial/
// permisos-auditoria.ts`), el CHECK del modelo Drizzle (`db/schema/permisos.ts`) y la pantalla. Es la
// ÚNICA fuente de la lista blanca de campos: el tipo impide pasar la fila entera del usuario y el
// CHECK de la base impide el INSERT crudo. Los dos tienen que ceder para que entre un dato personal.

export const ENTIDADES_AUDITABLES = ['usuario', 'rol', 'rol_funcion', 'usuario_funcion'] as const;
export const ACCIONES_AUDITABLES = ['crear', 'editar', 'borrar', 'baja', 'reactivar', 'activar', 'desactivar'] as const;

/**
 * Lista blanca de campos auditables. RN-A10 vive AQUÍ.
 *
 * Añadir 'email', 'name', 'username', 'password_hash' o cualquier dato personal del titular es un
 * defecto bloqueante, no una ampliación. Hay un test que fija este contenido exacto y un CHECK en
 * base que lo duplica: los dos tienen que ceder para que entre PII.
 *
 * Semántica (decidida el 10/09/2026): `active` es la SUSPENSIÓN temporal (`PATCH /:id/toggle`);
 * `deleted_at` es la BAJA definitiva (HU #12089). `password` es un HECHO sin valor: el CHECK de la
 * 0182 obliga a que sus dos valores sean null.
 */
export const CAMPOS_AUDITABLES = {
  usuario: ['role', 'active', 'deleted_at', 'password', 'funciones', 'allowed_pages',
    'organismos_codigos', 'compania_id', 'flito_proveedor_soat_id', 'transito_codigo'],
  rol: ['nombre', 'descripcion', 'tipo_enlace', 'tipo_principal', 'activo'],
  rol_funcion: ['conjunto'],
  usuario_funcion: ['conjunto'],
} as const;

/**
 * Forma admitida del par antes/después.
 *
 * NO incluye `Record<string, unknown>` ni `object` A PROPÓSITO: es lo que impide, en tiempo de
 * compilación, pasar la fila entera del usuario —con su correo y su hash— como «estado anterior».
 * Si alguna vez hace falta una forma nueva, se añade a esta unión con nombre y con motivo; nunca
 * se abre el tipo.
 */
export type ValorAuditable =
  | string | number | boolean | null
  | { conjunto: string[]; concedidas?: string[]; revocadas?: string[] };

export type EntidadAuditable = (typeof ENTIDADES_AUDITABLES)[number];
export type AccionAuditable = (typeof ACCIONES_AUDITABLES)[number];
export type CampoAuditable = (typeof CAMPOS_AUDITABLES)[EntidadAuditable][number];

/** Los tres orígenes. `auditoria` queda reservado para un backfill futuro y hoy no lo escribe nadie. */
export const ORIGENES_AUDITORIA = ['usuario', 'sistema', 'auditoria'] as const;
export type OrigenAuditoria = (typeof ORIGENES_AUDITORIA)[number];

/** Etiquetas de negocio para la pantalla. Capa de presentación, fuente única. */
export const CAMPO_LABELS: Record<CampoAuditable, string> = {
  role: 'Rol',
  active: 'Estado (activo)',
  deleted_at: 'Baja',
  password: 'Contraseña',
  funciones: 'Funciones',
  allowed_pages: 'Páginas permitidas',
  organismos_codigos: 'Organismos de tránsito',
  compania_id: 'Compañía',
  flito_proveedor_soat_id: 'Proveedor SOAT',
  transito_codigo: 'Organismo de tránsito',
  nombre: 'Nombre',
  descripcion: 'Descripción',
  tipo_enlace: 'Tipo de enlace',
  tipo_principal: 'Tipo principal',
  activo: 'Activo',
  conjunto: 'Conjunto de funciones',
};

/** Una fila del historial tal como la sirve `GET /api/users/auditoria`. */
export interface ItemAuditoriaPermisos {
  id: number;
  loteId: string;
  entidad: EntidadAuditable;
  accion: AccionAuditable;
  campo: CampoAuditable | null;
  valorAntes: ValorAuditable | null;
  valorDespues: ValorAuditable | null;
  /** null cuando el afectado es un rol. `username` viene del JOIN; NO está guardado. */
  titular: { userId: number; username: string | null; rol: string } | null;
  /** null cuando el afectado es un usuario. */
  rolAfectado: string | null;
  /** `userId` null ⇒ sistema. `email` es del ACTOR: RN-A10 lo autoriza. */
  actor: { userId: number | null; email: string | null; rol: string | null };
  origen: OrigenAuditoria;
  motivo: string | null;
  creadoEn: string;
}

export interface RespuestaAuditoriaPermisos {
  items: ItemAuditoriaPermisos[];
  total: number;
  limite: number;
  offset: number;
  /** Fecha de la primera fila posible. La pantalla la usa para decir dónde empieza el historial. */
  desdeCuando: string | null;
}

/** Usuarios con al menos una fila en permisos_auditoria como TITULAR. Sin nombre, sin correo. */
export interface TitularAuditoria { userId: number; username: string | null }
