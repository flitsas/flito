// HU #13310 (Feature #13309, ADR-0021 §3) — puerto del envío del comprobante de pago a FLIT 1 en tres
// pasos: (1) `POST {archivos}/api/v1/files` registra el archivo y devuelve `id` + `presignedUrl`;
// (2) `POST` multipart a `presignedUrl.url` con sus `fields` y `file` al final; (3) `PUT
// {tramites}/api/v1/vehicle-registration/{idReal}` enlaza el `id` como recibo de pago.
//
// El puerto DEVUELVE el desenlace clasificado (calco de `Flit2SyncPort.enviarAdjunto`): nunca lanza por
// HTTP ni por red. La `presignedUrl` (url y fields) NUNCA sale del adaptador (D-5, AC9).
import type { MimeAdjunto } from './flit2-adjuntos.js';

export interface ArchivoComprobanteFlit1 {
  bytes: Buffer;
  /** MIME real detectado por bytes (no el declarado). */
  contentType: MimeAdjunto;
  /** `impuesto-<uuid>.<ext>`: sin PII. */
  filename: string;
}

export type PasoEnvioFlit1 = 1 | 2 | 3;

export type ResultadoEnvioFlit1 =
  | { tipo: 'enviado'; archivoId: string; status: number }
  /** 5xx, 429, red, timeout, 3xx, 2xx malformado del paso 1. `archivoId` solo si el paso 2 ya pasó. */
  | { tipo: 'reintentable'; paso: PasoEnvioFlit1; codigo: string; status: number | null; archivoId: string | null }
  /** 4xx ≠ 429 (salvo la pausa de A-2). `archivoId` solo si el fallo fue en el paso 3. */
  | { tipo: 'definitivo'; paso: PasoEnvioFlit1; codigo: string; status: number; archivoId: string | null }
  /**
   * Configuración, no consume intento (ADR-0021 A-1/A-2): la URL de subida no pasa la validación fija
   * (`url_subida_no_permitida`), o un host FLIT1_* respondió 403/404 sin cuerpo o con el de API Gateway
   * (`no_disponible`).
   */
  | { tipo: 'pausa'; paso: PasoEnvioFlit1; codigo: 'url_subida_no_permitida' | 'no_disponible'; status: number | null };

export interface Flit1AdjuntosPort {
  /** Nunca lanza por HTTP ni red: todo sale clasificado. `archivoIdSubido` ≠ null → solo el paso 3. */
  enviarComprobante(idReal: string, archivo: ArchivoComprobanteFlit1, archivoIdSubido: string | null): Promise<ResultadoEnvioFlit1>;
}
