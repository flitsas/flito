// ADR-0046 — Detalle de trámite en modal (Gestión Trámites, módulo `flito-tramites`).
//
// Contrato de `GET /api/flito/tramites/:id/detalle`. Historial y soportes NO van aquí: se piden por
// sus endpoints (`GET /:id/historial`, `GET /:id/soportes`), cada uno con su función de permiso.
//
// Lleva datos personales del titular (`propietarios`): la lectura deja fila en `pii_access_log`
// (AGENTS.md §16) y la respuesta sale con `Cache-Control: no-store`. Nada de esto va en una URL.
//
// Solo campos que ya existen en el modelo (decisión del humano 2026-11-18): el vehículo NO trae
// motor ni año-modelo porque FLITO no los guarda; `linea` es la línea comercial (`vehicles.model`)
// y `clase` es el tipo de vehículo (`vehicles.tipo_vehiculo`).

import type { FuenteTramite } from './flito-tramite-fuente.js';
import type { VigenciaTramite } from './flito-tramite-vigencia.js';

/** Resumen del trámite (cabecera de la modal). Fechas en ISO 8601. */
export interface TramiteDetalleResumen {
  /** Estado crudo de FLIT (con el de FLITO de respaldo). */
  estado: string;
  /** true solo con estado FLIT «Asignado»: habilita las solicitudes de SOAT e impuestos. */
  asignado: boolean;
  tipoTramite: string | null;
  fuente: FuenteTramite;
  /** Nacimiento en FLIT, con `created_at` de FLITO de respaldo. */
  creado: string | null;
  aprobado: string | null;
  ciudad: string | null;
  /** Lo que falta para poder entregar, en el orden de la compuerta. Vacío = listo para entregar. */
  pendientes: TramiteDetallePendiente[];
  listoParaEntregar: boolean;
  semaforo: 'autogestionada' | 'rojo' | 'amarillo' | 'verde';
  /** Estado logístico de la licencia de tránsito; null si no aplica. */
  logisticaEstado: string | null;
  sincronizadoEn: string;
}

export type TramiteDetallePendiente = 'soat' | 'impuestos';

export interface TramiteDetalleVehiculo {
  placa: string | null;
  vin: string | null;
  marca: string | null;
  /** Línea comercial (`vehicles.model`). */
  linea: string | null;
  /** Clase / tipo de vehículo (`vehicles.tipo_vehiculo`). */
  clase: string | null;
  /** Tipo de servicio (`vehicles.tipo_servicio`, p. ej. «Público»; Épica #14707, rediseño). */
  tipoServicio: string | null;
}

/** Un comprador / propietario del trámite. Datos personales: solo en pantalla, nunca en URL ni log. */
export interface TramiteDetallePropietario {
  nombreCompleto: string;
  /** Código resuelto (`CC`, `NIT`, `PP`, `CE`) o null si FLIT no lo informó. */
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  orden: number;
  porcentajeParticipacion: number | null;
}

/** La compañía (empresa cliente) que gestiona el trámite. */
export interface TramiteDetalleGestora {
  nombre: string | null;
  nit: string | null;
  /** false = el NIT de FLIT no emparejó con ninguna compañía de FLITO. */
  existe: boolean;
  /** Persona que gestiona el trámite (PII; null = la fuente no lo trajo). No es el nombre de la compañía. */
  nombrePersona: string | null;
  correoPersona: string | null;
}

export type TramiteDetalleConceptoId = 'soat' | 'impuesto' | 'derecho_transito';

/** Un concepto de costo del trámite. Valores en pesos (número), null si aún no hay valor. */
export interface TramiteDetalleConcepto {
  concepto: TramiteDetalleConceptoId;
  /** A quién se le paga: proveedor SOAT u organismo de tránsito; null si no está emparejado. */
  quienCobra: string | null;
  /** true = la compañía lo autogestiona (FLITO no lo cobra ni lo gestiona). */
  autogestionado: boolean;
  /** Estado del registro de gestión (`solicitado`, `pagado`, …); null si no hay registro. */
  estado: string | null;
  /** Valor pagado (SOAT, impuesto) o valor del recibo (derecho de tránsito). */
  valor: number | null;
  /** Solo impuesto: valor liquidado por el organismo. */
  valorLiquidado: number | null;
}

export interface TramiteDetalleCostos {
  conceptos: TramiteDetalleConcepto[];
  /** true si el trámite ya tiene factura de venta de FLIT. */
  tieneFacturaVenta: boolean;
  /** Suma de los `valor` no nulos; null si ninguno tiene valor. */
  total: number | null;
}

/** Respuesta de `GET /api/flito/tramites/:id/detalle`. */
export interface TramiteDetalle {
  /** uuid opaco del trámite. */
  id: string;
  /** ID visible del trámite (p. ej. `FLIT-0132456`); es el que nombra el ZIP por trámite. */
  idFlit: string;
  /**
   * Épica #14707 (ADR-0049, D7): un trámite que FLIT anuló, abortó o revocó NO EXISTE en FLITO; el detalle se sigue
   * viendo, sin acciones. Su SOAT/impuesto puede venir `descartado` en `costos.conceptos[].estado`.
   */
  vigenciaTramite: VigenciaTramite;
  resumen: TramiteDetalleResumen;
  vehiculo: TramiteDetalleVehiculo;
  /** Ordenados por `orden`; el primero es el principal. Vacío si FLIT no trajo compradores. */
  propietarios: TramiteDetallePropietario[];
  gestora: TramiteDetalleGestora;
  costos: TramiteDetalleCostos;
}
