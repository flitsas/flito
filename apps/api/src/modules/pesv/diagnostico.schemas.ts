// PESV Auto-diagnóstico PHVA · Contratos zod (Sprint UX rediseño).
//
// Contratos publicados día 1 del sprint (BICHO A4) para que AURA + MIMI
// mockeen el frontend contra los esquemas sin esperar la implementación
// real de los endpoints. Estos esquemas son la única fuente de verdad
// entre frontend y backend para el módulo de diagnóstico.
//
// Referencia normativa: Res. 40595/2022 anexo metodológico + Ley 1581/2012
// (trazabilidad PII en evidencia) + Ley 594/2000 art. 23 (retención 5 años).
//
// Convenciones del repo:
//   - Las columnas numeric de Postgres llegan como string a la app (driver
//     postgres-js). Por eso scorePct y peso se serializan como string en
//     los DTOs de salida. El cliente parsea con Number() cuando lo necesita.
//   - Los timestamp llegan como ISO 8601 (z.string().datetime()).
//   - Los enums replican exactamente los valores del SQL (mig 0068).

import { z } from 'zod';

// ============================================================================
// Enums (alineados con pesv_nivel_empresa y pesv_nivel_rubrica de mig 0068)
// ============================================================================
export const nivelEmpresaSchema = z.enum(['basico', 'estandar', 'avanzado']);
export type NivelEmpresa = z.infer<typeof nivelEmpresaSchema>;

export const nivelRubricaSchema = z.enum([
  'no_implementado',
  'en_desarrollo',
  'implementado',
  'sostenido',
]);
export type NivelRubrica = z.infer<typeof nivelRubricaSchema>;

export const fasePhvaSchema = z.enum(['planear', 'hacer', 'verificar', 'actuar']);
export type FasePhva = z.infer<typeof fasePhvaSchema>;

// Subset rúbrica del score numérico. Validado también por trigger SQL.
export const scoreRubricaSchema = z.number().refine(
  (v) => [0, 50, 75, 100].includes(v),
  { message: 'scorePct debe ser 0, 50, 75 o 100' },
);

// Mapeo canónico nivelRubrica ↔ scorePct (server-side cuando frontend no envía nivel).
export const NIVEL_RUBRICA_TO_SCORE: Record<NivelRubrica, 0 | 50 | 75 | 100> = {
  no_implementado: 0,
  en_desarrollo: 50,
  implementado: 75,
  sostenido: 100,
};

export function scoreToNivelRubrica(score: number): NivelRubrica {
  if (score >= 100) return 'sostenido';
  if (score >= 75) return 'implementado';
  if (score >= 50) return 'en_desarrollo';
  return 'no_implementado';
}

// ============================================================================
// C1 — Evidencia adjunta (representación pública)
// ============================================================================
// keyHash = sha256(storageKey).slice(0, 16) — ADR-PESV-001. El frontend nunca
// ve la key real del bucket (mitiga path traversal + enumeración).
export const evidenciaSchema = z.object({
  keyHash: z.string().length(16),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mime: z.string().min(1),
  uploadedAt: z.string().datetime(),
  uploadedBy: z.number().int().positive(),
});
export type Evidencia = z.infer<typeof evidenciaSchema>;

// ============================================================================
// C2 — Detalle de item del diagnóstico (con evidencias pobladas)
// ============================================================================
export const diagnosticoItemDetailSchema = z.object({
  diagnosticoId: z.number(),
  estandarId: z.number(),
  codigo: z.string(),
  paso: z.number(),
  fase: fasePhvaSchema,
  nombre: z.string(),
  descripcion: z.string().nullable(),
  peso: z.string(),  // numeric → string (driver postgres-js)
  orden: z.number(),
  scorePct: z.string(),  // numeric → string
  nivelRubrica: nivelRubricaSchema,
  comentarios: z.string().nullable(),
  evidencias: z.array(evidenciaSchema),
  updatedAt: z.string().datetime(),
});
export type DiagnosticoItemDetail = z.infer<typeof diagnosticoItemDetailSchema>;

// ============================================================================
// C3 — Preflight del cierre (defensa en profundidad + UX de cierre)
// ============================================================================
// BICHO A5: el endpoint POST /:id/cerrar invoca este preflight server-side
// para evitar que un cliente malicioso pase un cierre con bloqueos. El
// frontend usa esta misma respuesta para pintar el modal de cierre.
export const preflightBloqueoSchema = z.object({
  estandarId: z.number(),
  codigo: z.string(),
  motivo: z.enum([
    'sin_evaluar',
    'nivel_implementado_sin_evidencia',
    'nivel_sostenido_sin_evidencia',
  ]),
});
export type PreflightBloqueo = z.infer<typeof preflightBloqueoSchema>;

export const preflightAdvertenciaSchema = z.object({
  estandarId: z.number(),
  codigo: z.string(),
  motivo: z.enum(['en_desarrollo_sin_comentario']),
});
export type PreflightAdvertencia = z.infer<typeof preflightAdvertenciaSchema>;

export const preflightResponseSchema = z.object({
  scoreProyectado: z.number(),
  totalEstandares: z.number(),
  evaluados: z.number(),
  conEvidencia: z.number(),
  bloqueos: z.array(preflightBloqueoSchema),
  advertencias: z.array(preflightAdvertenciaSchema),
  puedeCerrar: z.boolean(),
});
export type PreflightResponse = z.infer<typeof preflightResponseSchema>;

// ============================================================================
// Respuestas auxiliares (uploads y derivadas)
// ============================================================================
export const evidenciaUploadResponseSchema = z.object({
  keyHash: z.string().length(16),
  filename: z.string(),
  sizeBytes: z.number(),
  mime: z.string(),
  uploadedAt: z.string().datetime(),
  // El item se devuelve actualizado para que el frontend evite un re-fetch.
  item: diagnosticoItemDetailSchema,
});
export type EvidenciaUploadResponse = z.infer<typeof evidenciaUploadResponseSchema>;

// ============================================================================
// Requests (frontend → backend)
// ============================================================================
export const diagnosticoCreateSchema = z.object({
  anio: z.number().int().min(2020).max(2100),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado YYYY-MM-DD'),
  nivelEmpresa: nivelEmpresaSchema.default('avanzado'),
  nivelCriterioJustificacion: z.string().max(2000).optional().nullable(),
  responsableId: z.number().int().positive().optional(),
  observaciones: z.string().max(2000).optional().nullable(),
});
export type DiagnosticoCreateInput = z.infer<typeof diagnosticoCreateSchema>;

// BICHO A6: el PATCH NUNCA recibe evidenciaKeys directamente; ese set se
// maneja exclusivamente por los endpoints POST/DELETE /evidencias.
//
// Estrategia A (split de rollout) — DEPLOY PARTE 2 endurecido:
// scorePct ahora valida estrictamente subset rúbrica {0, 50, 75, 100}.
// El trigger SQL `trg_pesv_diag_items_worm` (mig 0070) hace cumplir la
// regla a nivel BD como defensa en profundidad. El frontend nuevo
// (rúbrica radio group) envía solo valores canónicos.

export const itemPatchSchema = z.object({
  scorePct: scoreRubricaSchema.optional(),
  nivelRubrica: nivelRubricaSchema.optional(),
  comentarios: z.string().max(2000).optional().nullable(),
}).refine(
  (v) => v.scorePct !== undefined || v.nivelRubrica !== undefined || v.comentarios !== undefined,
  { message: 'al menos uno de scorePct, nivelRubrica o comentarios debe estar presente' },
);
export type ItemPatchInput = z.infer<typeof itemPatchSchema>;
