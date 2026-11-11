// FLITO — tarifas de proveedor: el COSTO que cada proveedor le cobra a FLIT por concepto (ADR-0041, Épica #13763).
// No es la tarifa al cliente (`flito-tarifas.service.ts`): ninguna función de aquí lee `flito_tarifas_vigencias`, y
// nada de aquí se exporta hacia otros módulos (R8: ningún proceso lee estos costos todavía).
//
// STUB del bloque CONTRATO: firmas y errores fijados; los cuerpos los implementa el bloque BACKEND, junto con la
// cabecera de reglas RN-TP-01..RN-TP-06 (vigencias, par concepto↔servicio, $0, concurrencia, R5, frontera).
import {
  CODIGO_TARIFA_PROVEEDOR_CAMBIADA, MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO,
  type ConceptoCostoProveedor, type ResultadoCambioCostoProveedor, type ResumenProveedorCostos, type VigenciaCostoProveedor,
  type VistaCostosProveedor,
} from '@operaciones/shared-types';

/** Error de negocio de las tarifas de proveedor. Las subclases deciden el código HTTP en la ruta. */
export class TarifaProveedorError extends Error {}

/** 404 `PROVEEDOR_NO_ENCONTRADO`: proveedor inexistente, o eliminado cuando se intenta escribir. */
export class TarifaProveedorProveedorNoEncontradoError extends TarifaProveedorError {
  readonly code = 'PROVEEDOR_NO_ENCONTRADO';
  constructor() { super('Proveedor no encontrado'); }
}

/** 404 `VIGENCIA_NO_ENCONTRADA`. */
export class VigenciaCostoNoEncontradaError extends TarifaProveedorError {
  readonly code = 'VIGENCIA_NO_ENCONTRADA';
  constructor() { super('Vigencia no encontrada'); }
}

/** 409 R6: la vigencia del path ya no está abierta, ya hay una abierta al fijar, o 23505/23P01 de esta tabla. */
export class TarifaProveedorCambiadaError extends TarifaProveedorError {
  readonly code = CODIGO_TARIFA_PROVEEDOR_CAMBIADA;
  constructor() { super(MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO); }
}

/** 409 `PROVEEDOR_NO_ACTIVO`: escritura sobre un proveedor inactivo (D6). */
export class ProveedorNoActivoError extends TarifaProveedorError {
  readonly code = 'PROVEEDOR_NO_ACTIVO';
  constructor() { super('El proveedor está inactivo'); }
}

/** 422 `SERVICIO_NO_PRESTADO`: el concepto es de un servicio sin perfil vivo para ese proveedor (R2). */
export class ServicioCostoNoPrestadoError extends TarifaProveedorError {
  readonly code = 'SERVICIO_NO_PRESTADO';
  constructor() { super('El proveedor no presta ese servicio'); }
}

export interface DatosFijarCosto { proveedorId: string; concepto: ConceptoCostoProveedor; valor: number }

/** Exactamente uno de los dos (lo garantiza el Zod de la ruta). */
export type CambiosCosto = { valor: number } | { cerrar: true };

/** La vista sin `capacidades`: esas las calcula la ruta con el motor de permisos. */
export type VistaCostosSinCapacidades = Omit<VistaCostosProveedor, 'capacidades'>;

const NO_IMPLEMENTADO = 'no implementado';

/** Proveedores activos y vivos, por nombre, con cuántos conceptos les faltan (R5). */
export async function listarProveedoresConCostos(): Promise<ResumenProveedorCostos[]> {
  throw new Error(NO_IMPLEMENTADO);
}

/** Filas por concepto de los servicios vigentes (R2). Se consulta aunque el proveedor esté inactivo o eliminado (D6). */
export async function vistaCostosProveedor(_proveedorId: string): Promise<VistaCostosSinCapacidades> {
  throw new Error(NO_IMPLEMENTADO);
}

/** Todas las vigencias, incluidas las de servicios retirados (R5), por `concepto, vigente_desde DESC`. */
export async function historialCostosProveedor(
  _proveedorId: string, _concepto?: ConceptoCostoProveedor,
): Promise<VigenciaCostoProveedor[]> {
  throw new Error(NO_IMPLEMENTADO);
}

/** Primera fijación, o volver a cobrar tras cerrar. */
export async function fijarCosto(_d: DatosFijarCosto, _usuarioId: number | null): Promise<VigenciaCostoProveedor> {
  throw new Error(NO_IMPLEMENTADO);
}

/** Cambiar (cerrar y abrir con el mismo `now()`) o cerrar sin abrir la vigencia abierta `vigenciaId` (R4, R6). */
export async function cambiarOCerrarCosto(
  _vigenciaId: string, _cambios: CambiosCosto, _usuarioId: number | null,
): Promise<ResultadoCambioCostoProveedor> {
  throw new Error(NO_IMPLEMENTADO);
}
