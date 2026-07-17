// EPIC TRAM-INNOV · B2 (Sprint D) — copiloto IA del checklist (HITL).
//
// Sugerencias para que el GESTOR priorice ítems pendientes del checklist. NUNCA
// auto-marca, NUNCA auto-envía a tránsito, NUNCA da asesoría legal (epic §3 +
// OWASP LLM). Sin PII en el prompt (solo ids/labels/flags del checklist y tipos
// de documento). Salida estructurada validada; ítems alucinados se descartan.

import { z } from 'zod';
import type { ChecklistResultado } from '@operaciones/shared-types';
import { anthropicMessages } from './anthropic.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('tramite.copiloto');

export const DISCLAIMER = 'Revisión humana obligatoria. No constituye asesoría legal.';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_SUGERENCIAS = 6;

export interface Sugerencia { itemId: string; mensaje: string; confianza: number }
export type CopilotoResult =
  | { ok: true; sugerencias: Sugerencia[]; disclaimer: string }
  | { ok: false; status: number; message: string };

const SYSTEM_PROMPT =
  'Eres un asistente que ayuda a un GESTOR de trámites vehiculares en Colombia a ' +
  'priorizar el checklist documental de un trámite. NO das asesoría legal. NO apruebas ' +
  'ni rechazas trámites. NO afirmas que un trámite quedará aprobado. Solo sugieres qué ' +
  'ítems PENDIENTES priorizar y qué documento concreto solicitar. Responde EXCLUSIVAMENTE ' +
  'con un objeto JSON válido, sin texto adicional ni markdown.';

function buildUserPrompt(checklist: ChecklistResultado): string {
  const items = checklist.items
    .map((i) => `- id="${i.id}" | ${i.obligatorio ? 'OBLIGATORIO' : 'opcional'} | ${i.satisfecho ? 'satisfecho' : 'PENDIENTE'} | ${i.label}`)
    .join('\n');
  return [
    `Tipología del trámite: ${checklist.nombre}.`,
    `Ítems del checklist:\n${items}`,
    '',
    'Devuelve JSON con esta forma exacta:',
    '{"sugerencias":[{"itemId":"<id existente y PENDIENTE>","mensaje":"<acción concreta para el gestor, máx 140 caracteres, sin asesoría legal>","confianza":<número 0..1>}]}',
    `Reglas: solo incluye itemId que existan y estén PENDIENTES. Prioriza obligatorios. Máximo ${MAX_SUGERENCIAS} sugerencias. No inventes ids.`,
  ].join('\n');
}

const responseSchema = z.object({
  sugerencias: z.array(z.object({
    itemId: z.string().max(60),
    mensaje: z.string().max(200),
    confianza: z.coerce.number().min(0).max(1).optional().default(0.5),
  })).default([]),
});

/** Extrae el texto del primer bloque de la respuesta Anthropic Messages. */
function extractText(data: any): string {
  const blocks = data?.content;
  if (Array.isArray(blocks)) {
    const t = blocks.find((b: any) => b?.type === 'text')?.text ?? blocks[0]?.text;
    if (typeof t === 'string') return t;
  }
  return '';
}

/** Quita fences markdown si el modelo los añade. */
function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Genera sugerencias del copiloto sobre un checklist computado. Gate de
 * configuración (sin ANTHROPIC_API_KEY → 503) lo aporta `anthropicMessages`.
 * Los itemIds inexistentes o ya satisfechos se descartan (anti-alucinación) y el
 * disclaimer se fuerza a la constante (no se confía en la salida del modelo).
 */
export async function sugerirChecklist(checklist: ChecklistResultado): Promise<CopilotoResult> {
  const payload = {
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(checklist) }],
  };

  const ai = await anthropicMessages(payload, 'checklist');
  if (!ai.ok) return { ok: false, status: ai.status, message: ai.message };

  const raw = stripFences(extractText(ai.data));
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(JSON.parse(raw));
  } catch (e: any) {
    log.warn({ err: e?.message }, 'copiloto: salida IA no parseable');
    return { ok: false, status: 502, message: 'La sugerencia automática no tuvo un formato válido. Continúa con revisión manual del checklist.' };
  }

  // Anti-alucinación: solo ids que existan en el checklist y estén PENDIENTES.
  const pendientes = new Set(checklist.items.filter((i) => !i.satisfecho).map((i) => i.id));
  const sugerencias = parsed.sugerencias
    .filter((s) => pendientes.has(s.itemId))
    .slice(0, MAX_SUGERENCIAS)
    .map((s) => ({ itemId: s.itemId, mensaje: s.mensaje.slice(0, 200), confianza: Math.round(s.confianza * 100) / 100 }));

  return { ok: true, sugerencias, disclaimer: DISCLAIMER };
}
