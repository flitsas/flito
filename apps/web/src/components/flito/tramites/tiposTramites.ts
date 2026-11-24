// FLITO — Trámites: tipos y utilidades de presentación compartidos por la página `FlitoTramites` y
// sus subcomponentes (filas, celdas y modales). Se movieron tal cual desde la página al partirla
// (rediseño UI Kit 2026, Épica #14560): no cambia ningún contrato.

import type { EstadoImpuesto, EstadoSoat } from '@operaciones/shared-types';

export interface FilaSoat {
  id: string; estado: EstadoSoat; proveedorSoatNombre: string | null; valorPagado: number | null;
  enviadoEn: string | null; pagadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
export interface FilaImpuesto {
  id: string; estado: EstadoImpuesto; tieneFacturaVenta: boolean; coincidenciaFacturaVenta: number | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  enviadoEn: string | null; pagadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
export interface TramiteFila {
  tramiteId: string; idFlit: string; estado: string; asignado: boolean; fuente: string;
  tipoTramite: string | null; ciudad: string | null; fechaAprobacion: string | null;
  fechaCreacion: string | null;
  /** Valor real del derecho de tránsito; null = aún sin recibo cargado. */
  derechoTramiteValor: number | null;
  companiaNombre: string | null; empresaExiste: boolean; empresaNit: string | null;
  organismoNombre: string | null; secretariaEmparejada: boolean; transitoNombre: string | null;
  facturaVentaFlitId: string | null;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  /**
   * `tipoDocumento` es el CÓDIGO ya resuelto por el API (`'CC' | 'NIT' | 'PP' | 'CE'`) o null, no el
   * `tipo` crudo de FLIT: la traducción vive en el backend y aquí no hay copia (HU #11947, AC6/AC7).
   */
  compradorPrincipal: { nombreCompleto: string; numeroDocumento: string; tipoDocumento: string | null; correo: string | null } | null;
  compradores: unknown[]; soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null; impuestosAutogestionado: boolean;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
  logistica: { estado: string } | null;
  /** Conceptos desbloqueados excepcionalmente pese a que la compañía los autogestiona (HU #10980). */
  excepcionesAutogestion: string[];
}
// Un trámite habilita SOAT/impuestos solo si está Asignado y con empresa + secretaría emparejadas.
export const esAccionable = (f: TramiteFila) => f.asignado && f.empresaExiste && f.secretariaEmparejada;

export interface HistorialItem { id: string; campo: string; valorAnterior: string | null; valorNuevo: string | null; origen: string; usuarioNombre: string | null; creadoEn: string }

export interface ResSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
export interface ResImpuestos { enviados: number; yaEnviados: number; noEnviables: number }
export interface ResEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }
export type Resultado =
  | { tipo: 'soat'; soat: ResSoat }
  | { tipo: 'impuestos'; impuestos: ResImpuestos }
  | { tipo: 'ambos'; soat: ResSoat; impuestos: ResImpuestos }
  | { tipo: 'entrega'; entrega: ResEntrega };

export const pesos = (v: number | null) => v === null ? null
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
export const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
