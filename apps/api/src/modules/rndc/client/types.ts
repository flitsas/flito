// ============================================================================
// Contrato del cliente RNDC. Implementaciones: RndcMockClient (Fase 4.2),
// RndcRealClient SOAP (Fase 4.3 — sandbox plc.mintransporte.gov.co:8080/ws).
// ============================================================================

export interface RndcCredentials {
  numNit: string;
  claveQR: string;
  habilitadorNit: string;
  empresaNit: string;
  ambiente: 'sandbox' | 'produccion';
}

// Códigos oficiales RNDC + extensiones para errores de transporte.
// Ver tabla de códigos Mintransporte. ER01..ER0X = errores negocio,
// ER99 = error transitorio (server interno), TIMEOUT/NETWORK = transporte.
export type RndcResultCode =
  | '00'      // OK
  | 'ER01'    // Credenciales inválidas
  | 'ER02'    // XML mal formado
  | 'ER03'    // Vehículo no registrado
  | 'ER04'    // Conductor no registrado
  | 'ER05'    // Producto/empaque inválido
  | 'ER06'    // Código DANE inválido
  | 'ER07'    // Remesa/Manifiesto duplicado (mismo consecutivo local)
  | 'ER08'    // Manifiesto no encontrado para anulación
  | 'ER99'    // Error interno RNDC (transitorio)
  | 'TIMEOUT' // No respondió a tiempo
  | 'NETWORK';// No se pudo conectar

export interface RndcResponse {
  ok: boolean;
  codigo: RndcResultCode;
  consecutivoRndc?: string;
  mensaje: string;
  rawXml: string;
  durationMs: number;
}

export interface IngresarRemesaInput {
  consecutivoLocal: string; // REM-YYYYMM-####
  remesaId: number;
  payload: Record<string, unknown>;
}

export interface IngresarManifiestoInput {
  consecutivoLocal: string; // MAN-YYYYMM-####
  manifiestoId: number;
  payload: Record<string, unknown>;
}

export interface AnularInput {
  consecutivoRndc: string;
  motivo: string;
}

export interface ConsultarEstadoInput {
  consecutivoLocal: string;
}

export interface IRndcClient {
  ingresarRemesa(input: IngresarRemesaInput, creds: RndcCredentials): Promise<RndcResponse>;
  ingresarManifiesto(input: IngresarManifiestoInput, creds: RndcCredentials): Promise<RndcResponse>;
  anularRemesa(input: AnularInput, creds: RndcCredentials): Promise<RndcResponse>;
  anularManifiesto(input: AnularInput, creds: RndcCredentials): Promise<RndcResponse>;
  consultarEstadoIngreso(input: ConsultarEstadoInput, creds: RndcCredentials): Promise<RndcResponse>;
  modo(): 'mock' | 'real';
}

// Clasificación de errores para decidir si reintentar.
export function isTransientError(codigo: RndcResultCode): boolean {
  return codigo === 'ER99' || codigo === 'TIMEOUT' || codigo === 'NETWORK';
}

export function isBusinessError(codigo: RndcResultCode): boolean {
  return ['ER01', 'ER02', 'ER03', 'ER04', 'ER05', 'ER06', 'ER08'].includes(codigo);
}

export function isDuplicate(codigo: RndcResultCode): boolean {
  return codigo === 'ER07';
}
