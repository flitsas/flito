// Proveedores con varios servicios (Feature #14323, ADR-0039): una identidad y un perfil por servicio.
//
// `SERVICIOS_PROVEEDOR` es la única lista de servicios: no existe tabla ni pantalla que la edite (R1).
// Agregar un servicio es desarrollo: este literal, su perfil y su rama en `flito_proveedor_servicios_v`.

export const SERVICIOS_PROVEEDOR = ['soat', 'logistica'] as const;

export type ServicioProveedor = (typeof SERVICIOS_PROVEEDOR)[number];

/**
 * Qué servicio debe prestar un proveedor para entrar a cada módulo de la frontera (ADR-0039 §6.1).
 * Un módulo sin entrada no se abre a ningún proveedor. El lector llega en F3; en F1 no cambia nada.
 */
export const SERVICIO_DE_MODULO: Readonly<Partial<Record<string, ServicioProveedor>>> = {
  soat: 'soat',
  logistica: 'logistica',
};

/** Fila del listado de gestión (ADR-0039 §7.1). Sin teléfono, correo, dirección ni contacto. */
export interface ProveedorListaItemDto {
  id: string;
  nombre: string;
  nit: string | null;
  servicios: ServicioProveedor[];
  activo: boolean;
  companiasPorServicio: Partial<Record<ServicioProveedor, number>>;
  datosCompletos: boolean;
  version: number;
}

/** Opción de los selectores: solo proveedores activos, vigentes y con el servicio pedido (R11). */
export interface ProveedorSelectorItemDto {
  id: string;
  nombre: string;
}
