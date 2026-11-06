// Proveedores con varios servicios (Feature #14323, ADR-0039): una identidad y un perfil por servicio.
//
// `SERVICIOS_PROVEEDOR` es la única lista de servicios: no existe tabla ni pantalla que la edite (R1).
// Agregar un servicio es desarrollo: este literal, su perfil y su rama en `flito_proveedor_servicios_v`.

export const SERVICIOS_PROVEEDOR = ['soat', 'logistica'] as const;

export type ServicioProveedor = (typeof SERVICIOS_PROVEEDOR)[number];

/** Nombre visible de cada servicio: lo usan las etiquetas de la lista y el mensaje de quitar un servicio. */
export const SERVICIO_PROVEEDOR_LABEL: Readonly<Record<ServicioProveedor, string>> = {
  soat: 'SOAT',
  logistica: 'Logística',
};

/**
 * Qué servicio debe prestar un proveedor para entrar a cada módulo de la frontera (ADR-0039 §6.1).
 * Un módulo sin entrada no se abre a ningún proveedor. El lector llega en F3; en F1 no cambia nada.
 */
export const SERVICIO_DE_MODULO: Readonly<Partial<Record<string, ServicioProveedor>>> = {
  soat: 'soat',
  logistica: 'logistica',
};

// ── Mensajes y códigos del contrato (Feature #14324, ADR-0039 §7.1) ──────────────────────────────────────

export const MENSAJE_SIN_SERVICIO = 'Marque al menos un servicio';
export const CODIGO_PROVEEDOR_EDITADO_POR_OTRO = 'PROVEEDOR_EDITADO_POR_OTRO';
export const MENSAJE_PROVEEDOR_EDITADO_POR_OTRO = 'Otro usuario cambió este proveedor. Recarga para ver sus datos';

// ── Lecturas ─────────────────────────────────────────────────────────────────────────────────────────────

/** Fila del listado de gestión (ADR-0039 §7.1). Sin teléfono, correo, dirección ni contacto. */
export interface ProveedorListaItemDto {
  id: string;
  nombre: string;
  nit: string | null;
  servicios: ServicioProveedor[];
  activo: boolean;
  companiasPorServicio: Partial<Record<ServicioProveedor, number>>;
  datosCompletos: boolean;
  /** Solo con perfil de SOAT vigente; `null` en los demás. `estrategia` no viaja en la lista. */
  umbralOcr: number | null;
  slaHoras: number | null;
  version: number;
}

/** Opción de los selectores: solo proveedores activos, vigentes y con el servicio pedido (R11). */
export interface ProveedorSelectorItemDto {
  id: string;
  nombre: string;
}

/** Configuración del perfil de SOAT (R7). `umbralOcr` va de 0 a 1 y `slaHoras` es el ANS pactado. */
export interface ProveedorSoatConfigDto {
  estrategia: string;
  umbralOcr: number | null;
  slaHoras: number | null;
}

/** `GET /:id`, con datos personales. Un proveedor migrado puede tener los datos generales vacíos (R9). */
export interface ProveedorDetalleDto extends ProveedorListaItemDto {
  telefono: string | null;
  correo: string | null;
  direccion: string | null;
  ciudad: string | null;
  contacto: string | null;
  soat: ProveedorSoatConfigDto | null;
}

export type MotivoBloqueoProveedor = 'companias' | 'soat_en_curso' | 'reglas' | 'actas' | 'licencias';

export interface BloqueoProveedorDto {
  motivo: MotivoBloqueoProveedor;
  cantidad: number;
  /** Texto listo para mostrar, con la cantidad: «2 compañías asignadas». */
  texto: string;
}

/** `GET /:id/impacto`: lo que un administrador necesita ver antes de inactivar o eliminar. */
export interface ImpactoProveedorDto {
  activo: boolean;
  version: number;
  /** Solo los servicios que presta. Una lista vacía significa que ese servicio se puede quitar. */
  bloqueosPorServicio: Partial<Record<ServicioProveedor, BloqueoProveedorDto[]>>;
  /** Usuarios activos del proveedor: inactivarlo o eliminarlo les invalida la sesión. */
  sesionesAfectadas: number;
  puedeInactivar: boolean;
  motivoNoInactivable: string | null;
  puedeEliminar: boolean;
  motivoNoEliminable: string | null;
}

export type AccionAuditoriaProveedor =
  | 'crear' | 'editar' | 'activar' | 'desactivar' | 'eliminar' | 'servicio_agregado' | 'servicio_quitado';

/** `GET /:id/historial`. Los valores de NIT, teléfono, correo, dirección y contacto ya vienen enmascarados. */
export interface ProveedorHistorialItemDto {
  id: string;
  accion: AccionAuditoriaProveedor;
  campo: string | null;
  valorAntes: string | null;
  valorDespues: string | null;
  actorId: number | null;
  actorNombre: string | null;
  /** ISO 8601. */
  fecha: string;
}

// ── Escrituras ───────────────────────────────────────────────────────────────────────────────────────────

/** Los siete datos generales (R6). Crear los exige todos, y editar el bloque también (R9). */
export interface ProveedorGeneralesBody {
  nombre: string;
  nit: string;
  telefono: string;
  correo: string;
  direccion: string;
  ciudad: string;
  contacto: string;
}

/**
 * Datos de SOAT, todos opcionales: al crear o agregar, lo que no viene toma el valor por defecto; al editar, se conserva.
 * `estrategia` admite cadena vacía para limpiarla, y `null` limpia el umbral o el ANS.
 */
export interface ProveedorSoatBody {
  estrategia?: string;
  umbralOcr?: number | null;
  slaHoras?: number | null;
}

/** `POST /`. `soat` es opcional y se rechaza si `servicios` no incluye SOAT (R7). */
export interface CrearProveedorBody {
  generales: ProveedorGeneralesBody;
  servicios: ServicioProveedor[];
  soat?: ProveedorSoatBody;
}

/**
 * `PATCH /:id`: datos y servicios en una sola transacción. `servicios` es la lista FINAL que debe quedar.
 * Editar solo `soat` no exige los datos generales de un proveedor migrado (R9). Agregar un servicio cuenta como editar y
 * los exige: el 422 trae `campos`. Agregar SOAT no exige sus datos: `soat` es opcional también ahí.
 */
export interface EditarProveedorBody {
  versionEsperada: number;
  generales?: ProveedorGeneralesBody;
  servicios?: ServicioProveedor[];
  soat?: ProveedorSoatBody;
}

/** Cuerpo del 409 al quitar un servicio: `error` es «No puede quitar [servicio]: [motivo y cantidad]». */
export interface ServicioNoQuitableBody {
  error: string;
  servicio: ServicioProveedor;
  bloqueos: BloqueoProveedorDto[];
}

/** `PATCH /:id/estado`. */
export interface CambiarEstadoProveedorBody {
  activo: boolean;
  versionEsperada: number;
}
