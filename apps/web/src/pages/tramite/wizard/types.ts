// TRAM-ARCH-01 — tipos compartidos del wizard (extracción incremental desde TramiteDigital).

import type { TramiteEmbudoCardData } from '../TramiteEmbudoCard';

// TRAM-ARCH-01d — datos del vehículo (RUNT) y respuestas asociadas (pasos 1 y 5).
export interface VehiculoData {
  placa?: string;
  noPlaca?: string;
  marca?: string;
  linea?: string;
  modelo?: string;
  color?: string;
  clase?: string;
  claseVehiculo?: string;
  tipoServicio?: string;
  cilindraje?: string;
  tipoCombustible?: string;
  combustible?: string;
  tipoCarroceria?: string;
  tipoCarrocería?: string;
  capacidadCarga?: string;
  numeroEjes?: string;
  pesoBruto?: string;
  vin?: string;
  numChasis?: string;
  numMotor?: string;
  numSerie?: string;
  numLicencia?: string;
  fechaRegistro?: string;
  diasMatriculado?: string;
  estadoAutomotor?: string;
  organismoTransito?: string;
  gravamenes?: string;
  prendas?: string;
  repotenciado?: string;
  vehiculoEnsenanza?: string;
  esRegrabadoMotor?: string;
  esRegrabadoChasis?: string;
  esRegrabadoSerie?: string;
  esRegrabadoVin?: string;
  numRegraMotor?: string;
  numRegraChasis?: string;
  numRegraSerie?: string;
  numRegraVin?: string;
  clasificacion?: string;
  puertas?: string;
  pasajerosSentados?: string;
  _orgTransito?: { nombre: string; ciudad: string; codigo: string };
  // TRAM-TIPO-01: vendedor (parte saliente) persistido en el JSONB del vehículo
  // (mismo patrón que `_orgTransito`; sin migración de esquema).
  _vendedor?: VendedorData;
  [k: string]: unknown;
}

// TRAM-TIPO-01 — vendedor (titular saliente). Solo obligatorio en `traspaso_standard`
// (ver `vendedorRequerido` en shared-types). Captura mínima: tipo doc + documento + nombre.
export interface VendedorData {
  nombre: string;
  tipoDoc: string;
  documento: string;
}

export interface RuntSoat {
  numSoat?: string;
  razonSocialAsegur?: string;
  fechaInicioPoliza?: string;
  fechaVencimSoat?: string;
  estado?: string;
  estadoSoat?: string;
  [k: string]: unknown;
}

export interface RuntSolicitud {
  estado?: string;
  tramitesRealizados?: string;
  entidad?: string;
  fechaSolicitud?: string;
  [k: string]: unknown;
}

export interface RuntDatosTecnicos {
  pesoBrutoVehicular?: string | number;
  noEjes?: string | number;
  capacidadCarga?: string | number;
  pasajerosSentados?: string | number;
  [k: string]: unknown;
}

export interface RuntData {
  vehiculo?: VehiculoData;
  soat?: RuntSoat | RuntSoat[] | null;
  solicitudes?: RuntSolicitud[];
  tipoDocPropietario?: string;
  datosTecnicos?: RuntDatosTecnicos;
  [k: string]: unknown;
}

export interface RuntConsultaVehiculoResponse {
  ok?: boolean;
  message?: string;
  data?: RuntData;
}

export interface ValidacionIniciarResponse {
  ok?: boolean;
  email?: string;
  error?: string;
  emailEnviado?: boolean;
  fallback?: boolean;
  motivo?: string;
  link?: string;
}

export interface OrgTransito { nombre: string; ciudad: string; codigo: string }

export interface VehiculoWizardData {
  placa?: string;
  marca?: string;
  linea?: string;
  modelo?: string;
  color?: string;
  vin?: string;
  organismoTransito?: string;
  [k: string]: unknown;
}

export interface CompradorWizardData {
  documento?: string;
  nombre?: string;
  tipoDoc?: string;
  direccion?: string;
  ciudad?: string;
  telefono?: string;
  [k: string]: unknown;
}

export interface TramiteWizardContext {
  tramiteId: number | null;
  step: number;
  estado: string;
  vin: string;
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
}

export const WIZARD_STEPS = 5;

// TRAM-ARCH-01c — datos del comprador (paso 3) y validación de identidad (paso 4).
export interface CompradorData {
  nombre: string;
  tipoDoc: string;
  documento: string;
  email: string;
  telefono: string;
  direccion: string;
  ciudad: string;
}

export interface RuntPersona {
  nombres?: string;
  apellidos?: string;
  documento?: string;
  estadoPersona?: string;
  tieneLicencias?: boolean;
  estadoConductor?: string;
}

export interface RuntMultaItem {
  numero?: string;
  comparendo?: string;
  infraccion?: string;
  descripcion?: string;
  estado?: string;
  valor?: number | string;
}

export interface RuntMultasObject {
  tieneMultas?: string;
  totalMultas?: number | string;
  valorTotal?: number | string;
  nroPazYSalvo?: string;
}

export interface RuntPersonaResponse {
  ok?: boolean;
  message?: string;
  persona?: RuntPersona;
  multas?: RuntMultaItem[] | RuntMultasObject;
}

export interface ValidationStatus {
  id?: number;
  estado?: string;
  score?: number;
  nombre?: string;
  documento?: string;
  intentos?: number;
}

// TRAM-ARCH-01b — documento subido al trámite (paso 2).
export interface ArchivoData {
  id: number;
  tipo: string;
  originalName?: string;
  size?: number;
  mimetype?: string;
  [k: string]: unknown;
}

// TRAM-ARCH-01b — resultado del análisis OCR de un documento (paso 2).
export interface OcrResult {
  es_factura_valida?: boolean;
  es_valido?: boolean;
  tipo_documento?: string;
  // VIN / vehículo
  vehiculo_vin?: string;
  vehiculo_vin_datos?: string;
  vehiculo_chasis?: string;
  vehiculo_chasis_datos?: string;
  vehiculo_motor?: string;
  vehiculo_motor_datos?: string;
  vehiculo_serie?: string;
  vehiculo_marca?: string;
  vehiculo_linea?: string;
  vehiculo_modelo?: string;
  vehiculo_color?: string;
  estado_vin?: string;
  estado_motor?: string;
  estado_chasis?: string;
  // factura
  numero_factura?: string;
  fecha?: string;
  emisor_nombre?: string;
  emisor_nit?: string;
  comprador_nombre?: string;
  comprador_documento?: string;
  total?: number;
  iva?: number;
  forma_pago?: string;
  // aduana
  numero_documento?: string;
  aduana?: string;
  importador_nombre?: string;
  importador_nit?: string;
  pais_origen?: string;
  puerto_entrada?: string;
  subpartida_arancelaria?: string;
  valor_fob_usd?: number;
  valor_cif_usd?: number;
  valor_cif_cop?: number;
  arancel_valor?: number;
  arancel_porcentaje?: number | string;
  iva_valor?: number;
  iva_porcentaje?: number | string;
  total_tributos?: number;
  regimen?: string;
  // impronta
  numero_certificado?: string;
  entidad_emisora?: string;
  inspector_nombre?: string;
  tiene_qr?: boolean;
  tiene_hash?: boolean;
  hash_valor?: string;
  resolucion_referencia?: string;
  // soat
  numero_poliza?: string;
  aseguradora?: string;
  fecha_vencimiento?: string;
  // meta
  paginas_documento?: unknown[];
  _rechazado?: boolean;
  _motivo?: string;
  _extracted_filename?: string;
  _paginas_extraidas?: boolean;
  _paginas_originales?: number;
  alertas?: string[];
  observaciones?: string;
}

// TRAM-ARCH-01d — respuesta de estado de validación de identidad (paso 4).
export interface ValidacionEstadoResponse {
  ok?: boolean;
  validaciones?: ValidationStatus[];
}

// TRAM-ARCH-01d — fila de listado y trámite completo (hidratación del wizard).
export interface TramiteListItem extends TramiteEmbudoCardData {
  comprador?: CompradorData | null;
  [k: string]: unknown;
}

export interface TramiteFull extends TramiteListItem {
  vehiculo?: VehiculoData | null;
  comprador?: CompradorData | null;
  tipologiaCodigo?: string | null;
  checklistEstado?: Record<string, boolean> | null;
}

export interface TramiteCreatedResponse {
  id: number;
}
