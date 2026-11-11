// Tarifas de proveedor: el COSTO que cada proveedor le cobra a FLIT por concepto (ADR-0041, Épica #13763).
// No es la tarifa al cliente (`flito-tarifas.ts`): los conceptos son tipos distintos a propósito, para que el
// `'logistica'` del cliente y el del proveedor no sean intercambiables en el sistema de tipos (R1).
// `CONCEPTOS_TARIFA` no se toca.
import type { ServicioProveedor } from './flito-proveedores.js';

/** Conceptos de costo de proveedor. El CHECK `flito_tarifas_prov_concepto_chk` (0300) es su espejo en BD. */
export const CONCEPTOS_COSTO_PROVEEDOR = ['logistica', 'soat_con_tramite', 'soat_sin_tramite'] as const;
export type ConceptoCostoProveedor = (typeof CONCEPTOS_COSTO_PROVEEDOR)[number];

/** Servicio al que pertenece cada concepto (R2). */
export const SERVICIO_DE_CONCEPTO_COSTO: Readonly<Record<ConceptoCostoProveedor, ServicioProveedor>> = {
  logistica: 'logistica',
  soat_con_tramite: 'soat',
  soat_sin_tramite: 'soat',
};

/** Conceptos que aparecen por cada servicio vigente del proveedor (R2): fuente única de las filas de la vista. */
export const CONCEPTOS_DE_SERVICIO: Readonly<Record<ServicioProveedor, readonly ConceptoCostoProveedor[]>> = {
  soat: ['soat_con_tramite', 'soat_sin_tramite'],
  logistica: ['logistica'],
};

export const ETIQUETA_CONCEPTO_COSTO: Readonly<Record<ConceptoCostoProveedor, string>> = {
  logistica: 'Logística',
  soat_con_tramite: 'SOAT con trámite',
  soat_sin_tramite: 'SOAT sin trámite',
};

/** R3: vacío, nulo, no numérico o negativo. Literal: la web y el 400 de la API lo muestran igual. */
export const MENSAJE_VALOR_COSTO_INVALIDO = 'El valor debe ser mayor o igual a cero';

/** R6: otro usuario cambió o cerró la vigencia (o ya fijó la primera) antes de guardar. */
export const CODIGO_TARIFA_PROVEEDOR_CAMBIADA = 'TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO';
export const MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO = 'Otro usuario cambió este valor. Recarga para ver el vigente';

export function esConceptoCostoProveedor(v: unknown): v is ConceptoCostoProveedor {
  return typeof v === 'string' && (CONCEPTOS_COSTO_PROVEEDOR as readonly string[]).includes(v);
}

export interface UsuarioCostoRef { id: number; nombre: string | null }

/** Una vigencia de costo. «Vigente» = `vigenteHasta === null`. Fechas ISO-8601. */
export interface VigenciaCostoProveedor {
  id: string;
  proveedorId: string;
  servicio: ServicioProveedor;
  concepto: ConceptoCostoProveedor;
  valor: number;
  vigenteDesde: string;
  vigenteHasta: string | null;
  fijadoPor: UsuarioCostoRef | null;
  fijadoEn: string;
  cerradoPor: UsuarioCostoRef | null;
  cerradoEn: string | null;
}

/** Una fila de la vista: `vigencia === null` es «Sin configurar»; `valor === 0` es un costo válido (R4). */
export interface FilaCostoProveedor {
  servicio: ServicioProveedor;
  concepto: ConceptoCostoProveedor;
  vigencia: VigenciaCostoProveedor | null;
}

export interface CapacidadesCostosProveedor { editar: boolean; verHistorial: boolean }

/** `GET /api/flito/parametrizacion/tarifas-proveedores/:proveedorId`. Sin NIT ni datos de contacto. */
export interface VistaCostosProveedor {
  proveedor: { id: string; nombre: string; activo: boolean; eliminado: boolean };
  filas: FilaCostoProveedor[];
  capacidades: CapacidadesCostosProveedor;
}

/** `GET /api/flito/parametrizacion/tarifas-proveedores`: proveedores activos y vivos (R5). */
export interface ResumenProveedorCostos {
  id: string;
  nombre: string;
  servicios: ServicioProveedor[];
  /** Conceptos que le corresponden por sus servicios vigentes. */
  conceptos: number;
  /** Conceptos sin vigencia abierta («Sin configurar»). */
  faltan: number;
}

/** `POST /:proveedorId/vigencias`. */
export interface FijarCostoProveedorBody { concepto: ConceptoCostoProveedor; valor: number }

/** `PATCH /vigencias/:vigenciaId`: exactamente uno de los dos. */
export type CambiarCostoProveedorBody = { valor: number } | { cerrar: true };

export type AccionCambioCostoProveedor = 'cambiada' | 'cerrada' | 'sin_cambio';

/** Respuesta del `PATCH`. En `cerrada`, `vigencia` es la cerrada y la fila vuelve a «Sin configurar». */
export interface ResultadoCambioCostoProveedor {
  vigencia: VigenciaCostoProveedor;
  accion: AccionCambioCostoProveedor;
  valorAnterior: number;
  valorNuevo: number | null;
}
