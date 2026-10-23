// HU #13889 (Feature #13888, Épica #13407) — expediente documental de la COMPAÑÍA (bolsas). ADR-0028 §10.
//
// Contrato entre `apps/api/src/modules/flito-bolsas-documentos` y la sección de la web (#13892/#13893).
// Los DTO no llevan PII: ni nombre de archivo, ni contenido OCR, ni clave de almacenamiento, ni hash.

export const TIPOS_DOCUMENTO_BOLSA = [
  'camara_comercio', 'rut', 'cedula_representante', 'certificado_bancario', 'adicional',
] as const;
export type TipoDocumentoBolsa = (typeof TIPOS_DOCUMENTO_BOLSA)[number];

/** Los 4 que cuentan para el expediente «completo». El `adicional` es opcional (AC4 de #13889). */
export const TIPOS_DOCUMENTO_BOLSA_PRINCIPALES = [
  'camara_comercio', 'rut', 'cedula_representante', 'certificado_bancario',
] as const;
export type TipoDocumentoBolsaPrincipal = (typeof TIPOS_DOCUMENTO_BOLSA_PRINCIPALES)[number];

/** Los que vencen a los 30 días de expedidos y pasan por OCR (#13890). La cédula nunca va al OCR. */
export const TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA = ['camara_comercio', 'rut', 'certificado_bancario'] as const;

export const MIMES_DOCUMENTO_BOLSA = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type MimeDocumentoBolsa = (typeof MIMES_DOCUMENTO_BOLSA)[number];

export const TAMANO_MAX_DOCUMENTO_BOLSA = 15 * 1024 * 1024;
export const DIAS_VIGENCIA_DOCUMENTO_BOLSA = 30;
export const TOPE_ESTADO_LOTE_BOLSAS = 200;

/** `validando` es transitorio de presentación (ADR-0028 D4), no un quinto estado de producto. */
export type EstadoDocumentoBolsa = 'pendiente' | 'valido' | 'vencido' | 'no_validado' | 'validando';
export type OrigenFechaExpedicion = 'ocr' | 'manual';

export interface DocumentoBolsaDto {
  id: string;
  tipo: TipoDocumentoBolsa;
  version: number;
  estado: EstadoDocumentoBolsa;
  /** yyyy-mm-dd */
  fechaExpedicion: string | null;
  fechaOrigen: OrigenFechaExpedicion | null;
  /** fechaExpedicion + 30 días (solo tipos con vigencia). */
  venceEl: string | null;
  /** `por` = nombre del usuario FLIT que fijó la fecha. */
  fechaManual: { por: string | null; en: string } | null;
  mime: MimeDocumentoBolsa;
  tamanoBytes: number;
  /** Nombre del usuario FLIT que cargó la versión. */
  cargadoPor: string | null;
  cargadoEn: string;
}

export interface DocumentoExpedienteDto {
  tipo: TipoDocumentoBolsa;
  estado: EstadoDocumentoBolsa;
  /** `true` solo para el `adicional`: su ausencia no es un faltante (AC4). */
  opcional: boolean;
  vigente: DocumentoBolsaDto | null;
}

export interface ExpedienteCompaniaDto {
  companiaId: number;
  completo: boolean;
  documentos: DocumentoExpedienteDto[];
}

export interface DocumentoBolsaVersionDto extends DocumentoBolsaDto {
  vigente: boolean;
  reemplazadoEn: string | null;
  archivoDisponible: boolean;
}

export interface HistorialDocumentoBolsaDto {
  versiones: DocumentoBolsaVersionDto[];
}

export interface EstadoExpedienteLoteDto {
  companiaId: number;
  completo: boolean;
  estados: Record<TipoDocumentoBolsaPrincipal, EstadoDocumentoBolsa>;
}
