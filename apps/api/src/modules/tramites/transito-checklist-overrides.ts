import {
  getTipologia,
  isKnownOrganismoCodigo,
  isValidTipologia,
  type ChecklistOverride,
} from '@operaciones/shared-types';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { organismoChecklistOverrides } from '../../db/schema.js';

const checklistItemSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  obligatorio: z.boolean(),
  ayuda: z.string().max(500).optional(),
  docTipo: z.string().max(40).optional(),
});

export const checklistOverrideSchema = z.object({
  hide: z.array(z.string().min(1).max(80)).max(50).optional(),
  require: z.array(z.string().min(1).max(80)).max(50).optional(),
  add: z.array(checklistItemSchema).max(30).optional(),
}).strict();

export interface ChecklistOverrideDto {
  organismoCodigo: string;
  tipologiaCodigo: string;
  override: ChecklistOverride;
  version: number;
  updatedAt: string | null;
}

const EMPTY_OVERRIDE: ChecklistOverride = { hide: [], require: [], add: [] };

function normalizeOverride(raw: unknown): ChecklistOverride {
  const parsed = checklistOverrideSchema.safeParse(raw);
  if (!parsed.success) return { ...EMPTY_OVERRIDE };
  return {
    hide: parsed.data.hide ?? [],
    require: parsed.data.require ?? [],
    add: parsed.data.add ?? [],
  };
}

export function validateOverrideForTipologia(tipologiaCodigo: string, override: ChecklistOverride): string | null {
  const tip = getTipologia(tipologiaCodigo);
  if (!tip) return 'Tipología inválida';
  const baseIds = new Set(tip.checklist.map((i) => i.id));

  for (const id of override.hide ?? []) {
    if (!baseIds.has(id)) return `Ítem oculto desconocido: ${id}`;
  }
  for (const id of override.require ?? []) {
    if (!baseIds.has(id)) return `Ítem require desconocido: ${id}`;
  }
  for (const item of override.add ?? []) {
    if (baseIds.has(item.id)) return `Ítem add duplica catálogo base: ${item.id}`;
  }
  return null;
}

export async function getChecklistOverride(
  organismoCodigo: string,
  tipologiaCodigo: string,
): Promise<ChecklistOverrideDto | null> {
  if (!isKnownOrganismoCodigo(organismoCodigo) || !isValidTipologia(tipologiaCodigo)) return null;

  const [row] = await db.select()
    .from(organismoChecklistOverrides)
    .where(and(
      eq(organismoChecklistOverrides.organismoCodigo, organismoCodigo),
      eq(organismoChecklistOverrides.tipologiaCodigo, tipologiaCodigo),
    ))
    .limit(1);

  return {
    organismoCodigo,
    tipologiaCodigo,
    override: row ? normalizeOverride(row.itemsJson) : { ...EMPTY_OVERRIDE },
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function upsertChecklistOverride(
  organismoCodigo: string,
  tipologiaCodigo: string,
  override: ChecklistOverride,
): Promise<ChecklistOverrideDto | null> {
  if (!isKnownOrganismoCodigo(organismoCodigo) || !isValidTipologia(tipologiaCodigo)) return null;

  const err = validateOverrideForTipologia(tipologiaCodigo, override);
  if (err) throw new Error(err);

  const normalized = {
    hide: override.hide ?? [],
    require: override.require ?? [],
    add: override.add ?? [],
  };

  const [existing] = await db.select({ version: organismoChecklistOverrides.version })
    .from(organismoChecklistOverrides)
    .where(and(
      eq(organismoChecklistOverrides.organismoCodigo, organismoCodigo),
      eq(organismoChecklistOverrides.tipologiaCodigo, tipologiaCodigo),
    ))
    .limit(1);

  const nextVersion = (existing?.version ?? 0) + 1;
  const now = new Date();

  await db.insert(organismoChecklistOverrides)
    .values({
      organismoCodigo,
      tipologiaCodigo,
      itemsJson: normalized,
      version: nextVersion,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [organismoChecklistOverrides.organismoCodigo, organismoChecklistOverrides.tipologiaCodigo],
      set: {
        itemsJson: normalized,
        version: nextVersion,
        updatedAt: now,
      },
    });

  return getChecklistOverride(organismoCodigo, tipologiaCodigo);
}

/** Resuelve override desde BD (null si no hay fila o parámetros inválidos). */
export async function resolveChecklistOverride(
  organismoCodigo: string | null | undefined,
  tipologiaCodigo: string | null | undefined,
): Promise<ChecklistOverride | null> {
  if (!organismoCodigo || !tipologiaCodigo || !isValidTipologia(tipologiaCodigo)) return null;
  const dto = await getChecklistOverride(organismoCodigo, tipologiaCodigo);
  if (!dto) return null;
  const o = dto.override;
  const hasData = (o.hide?.length ?? 0) > 0 || (o.require?.length ?? 0) > 0 || (o.add?.length ?? 0) > 0;
  return hasData ? o : null;
}
