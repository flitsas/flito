// FLITO OCR — fecha de expedición de los documentos de la compañía en bolsas (HU #13890, ADR-0028 §8).
//
// Archivo aparte para no engordar `flito-ocr.service.ts`: reusa su `pasada` (cliente Anthropic resiliente,
// sin PII en logs) con un prompt por tipo y devuelve SOLO la fecha. No se persiste ni se devuelve nada
// más del documento. La cédula del representante NUNCA llega aquí (D8): el tipo no lo admite.
//
// Doble pasada como los demás extractores: Haiku y, si la fecha no salió con confianza «alta», Sonnet;
// gana la de mayor confianza. Solo «alta» es confiable (equivale al umbral por defecto 0.85).
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { normalizarFecha, pasada, type DocumentoAAnalizar } from './flito-ocr.service.js';
import {
  PROMPT_EXPEDICION_CAMARA_COMERCIO, PROMPT_EXPEDICION_CERTIFICADO_BANCARIO, PROMPT_EXPEDICION_RUT,
  type CampoCrudo,
} from './flito-ocr.prompts.js';

const log = loggerFor('flito-ocr.expedicion');

/** Los únicos tipos que se envían al motor. La cédula y el adicional quedan fuera por diseño (D8). */
export type TipoConFechaExpedicion = 'camara_comercio' | 'rut' | 'certificado_bancario';

const PROMPTS: Record<TipoConFechaExpedicion, string> = {
  camara_comercio: PROMPT_EXPEDICION_CAMARA_COMERCIO,
  rut: PROMPT_EXPEDICION_RUT,
  certificado_bancario: PROMPT_EXPEDICION_CERTIFICADO_BANCARIO,
};

const CAMPO = 'fecha_expedicion';
const RANGO: Record<string, number> = { alta: 3, media: 2, baja: 1 };

export interface FechaExpedicionLeida {
  /** `yyyy-mm-dd` de calendario válido, o null si no se pudo leer. */
  fecha: string | null;
  /** true solo con confianza «alta». Una fecha no confiable se trata como «sin fecha» (§8). */
  confiable: boolean;
}

/** `normalizarFecha` acepta 31/02/2026; aquí solo vale una fecha que exista en el calendario. */
function fechaDeCalendario(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

function rango(c: CampoCrudo | undefined): number {
  return c?.confianza ? RANGO[c.confianza] ?? 0 : 0;
}

/**
 * Lee la fecha de expedición. Lanza `OcrNoDisponibleError` si el motor no responde (sin API key, 429,
 * timeout): quien llama decide si reintenta. Una respuesta no parseable es «sin fecha», no un error.
 */
export async function extraerFechaExpedicion(
  doc: Omit<DocumentoAAnalizar, 'umbral'> & { umbral?: number },
  tipo: TipoConFechaExpedicion,
): Promise<FechaExpedicionLeida> {
  const prompt = PROMPTS[tipo];
  if (!prompt) throw new Error(`Tipo sin OCR de expedición: ${String(tipo)}`);
  const documento: DocumentoAAnalizar = { ...doc, umbral: doc.umbral ?? 0.85 };

  const p1 = await pasada(documento, env.ANTHROPIC_MODEL_HAIKU, prompt, '');
  let campo = p1?.[CAMPO];
  if (campo?.confianza !== 'alta') {
    const extra = 'La lectura previa con un modelo rápido dejó la fecha dudosa. Verifícala con máximo rigor. Si aun así no puedes leerla, valor=null y confianza=null.';
    try {
      const p2 = await pasada(documento, env.ANTHROPIC_MODEL_SONNET, prompt, extra);
      const c2 = p2?.[CAMPO];
      if (rango(c2) >= rango(campo)) campo = c2;
    } catch (e) {
      // Sonnet caído no invalida la primera pasada. Solo el nombre del error: nada del documento.
      log.warn({ tipo, err: (e as Error)?.name }, 'OCR expedición: segunda pasada falló; se usa la primera');
    }
  }

  const fecha = fechaDeCalendario(campo?.valor ? normalizarFecha(campo.valor) : null);
  return { fecha, confiable: fecha !== null && campo?.confianza === 'alta' };
}
